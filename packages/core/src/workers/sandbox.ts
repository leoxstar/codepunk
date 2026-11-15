import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, promises as fs, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { resolveExecutable } from "../autonomy/index.ts";
import { SrtSandbox, type SandboxUnavailableError } from "../sandbox/index.ts";
import type {
  ShellExecutionOptions,
  ShellExecutionResult,
} from "../sandbox/index.ts";
import { isInsidePath, normalizeAbsolute } from "../platform/path.ts";
import { gitText } from "../delivery/git.ts";

const HOST_NAMES = new Set(["codepunk", "pi"]);
const HOST_SCRIPT_MARKERS = [
  "@earendil-works/pi-coding-agent",
  "createAgentSessionRuntime",
];
const MAX_HOST_SCAN_BYTES = 5 * 1024 * 1024;
const COMMAND_WRAPPERS = new Set([
  "env",
  "command",
  "exec",
  "nohup",
  "time",
  "sudo",
  "doas",
  "xargs",
]);
const WRAPPER_VALUE_OPTIONS = new Set([
  "-u",
  "--unset",
  "-i",
  "-g",
  "-C",
  "-h",
  "-p",
  "-r",
  "-t",
  "-U",
  "-n",
  "-P",
  "-I",
  "-L",
  "-s",
]);
const GIT_PLUMBING = new Set([
  "update-index",
  "hash-object",
  "commit-tree",
  "mktree",
  "write-tree",
]);
const DEPTH_TOKEN_RE = /^[0-9a-f]{32}$/u;

export class WorkerSandboxError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkerSandboxError";
    this.code = code;
  }
}

export function assertDepthTokenFormat(token: string): void {
  if (!DEPTH_TOKEN_RE.test(token)) {
    throw new WorkerSandboxError(
      "worker.depth_token",
      "worker depth token must be 128 bits of lowercase hex",
    );
  }
}

export function readHostLaunchToken(fd = 3): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(64);
  let total = 0;
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) {
        break;
      }
      total += count;
      if (total > 128) {
        throw new WorkerSandboxError(
          "worker.depth_token_mismatch",
          "host launch depth token is too long",
        );
      }
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
  } catch (error) {
    if (error instanceof WorkerSandboxError) {
      throw error;
    }
    throw new WorkerSandboxError(
      "worker.depth_token_missing",
      `host launch depth token is missing from fd ${fd}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const token = Buffer.concat(chunks).toString("utf8").trim();
  if (token.length === 0) {
    throw new WorkerSandboxError(
      "worker.depth_token_missing",
      `host launch depth token is missing from fd ${fd}`,
    );
  }
  assertDepthTokenFormat(token);
  return token;
}

export interface SpawnGuardedHostOptions {
  argv: readonly string[];
  cwd: string;
  token: string;
  expectedToken?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Uint8Array;
}

export function spawnGuardedHost(
  options: SpawnGuardedHostOptions,
): ChildProcessWithoutNullStreams {
  if (options.argv.length === 0) {
    throw new WorkerSandboxError(
      "worker.host_launch_denied",
      "guarded host launch requires an executable",
    );
  }
  assertDepthTokenFormat(options.token);
  const expectedToken = options.expectedToken ?? options.token;
  assertDepthTokenFormat(expectedToken);
  const executable = options.argv[0]!;
  const child = spawn(executable, options.argv.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: [
      options.stdin === undefined ? "ignore" : "pipe",
      "pipe",
      "pipe",
      "pipe",
      "pipe",
    ],
  });
  if (options.stdin !== undefined) {
    child.stdin?.end(options.stdin);
  }
  for (const [fd, value] of [
    [3, options.token],
    [4, expectedToken],
  ] as const) {
    const tokenFd = child.stdio[fd];
    if (
      tokenFd === null ||
      tokenFd === undefined ||
      typeof tokenFd !== "object" ||
      !("write" in tokenFd)
    ) {
      child.kill("SIGKILL");
      throw new WorkerSandboxError(
        "worker.depth_token_missing",
        `guarded host did not receive fd ${fd}`,
      );
    }
    tokenFd.write(value);
    tokenFd.end();
  }
  return child as ChildProcessWithoutNullStreams;
}

/**
 * Verify that this process was started by `spawnGuardedHost` through the
 * private `--guarded-host-launch` entry. This is a launch handshake, not a
 * recursion limit: a depth-1 child is the normal case. Recursion is bounded by
 * `Subagent`'s one-level rule, not by this token.
 */
export function verifyGuardedHostLaunch(tokenFd = 3, expectedFd = 4): void {
  const token = readHostLaunchToken(tokenFd);
  const expected = readHostLaunchToken(expectedFd);
  if (token !== expected) {
    throw new WorkerSandboxError(
      "worker.depth_token_mismatch",
      "host launch depth token does not match the expected token",
    );
  }
}

export interface WorkerSandboxOptions {
  worktree: string;
  runDir: string;
  deliveryRoot: string;
  parentRoot: string;
  siblingRoot: string;
  codepunkHome: string;
  installRoots?: readonly string[];
  /** Operator egress allowlist forwarded to the worker's srt profile. */
  networkAllow?: readonly string[];
  /** Operator egress deny list forwarded to the worker's srt profile. */
  networkDeny?: readonly string[];
  depth?: number;
  depthToken?: string;
  sandbox?: SrtSandbox;
}

function findPackageRoot(start: string): string | null {
  let current = normalizeAbsolute(start);
  for (;;) {
    const manifest = path.join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
          name?: unknown;
        };
        if (typeof parsed.name === "string") {
          return current;
        }
      } catch {
        return null;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function defaultWorkerInstallRoots(): string[] {
  const roots = new Set<string>();
  const coreRoot = findPackageRoot(
    path.dirname(fileURLToPath(import.meta.url)),
  );
  if (coreRoot !== null) {
    roots.add(normalizeAbsolute(coreRoot));
  }
  try {
    const piRoot = findPackageRoot(getPackageDir());
    if (piRoot !== null) {
      roots.add(normalizeAbsolute(piRoot));
    }
  } catch {
    // A missing Pi package is already a startup failure elsewhere.
  }
  return [...roots].sort();
}

function executableName(word: string): string {
  return path
    .basename(word)
    .replace(/\.exe$/iu, "")
    .toLowerCase();
}

function commandIndex(words: readonly string[]): number {
  let index = 0;
  while (index < words.length) {
    const name = executableName(words[index]!);
    if (!COMMAND_WRAPPERS.has(name)) {
      return index;
    }
    index += 1;
    while (index < words.length) {
      const option = words[index]!;
      if (option.startsWith("-")) {
        index += 1;
        if (WRAPPER_VALUE_OPTIONS.has(option) && index < words.length) {
          index += 1;
        }
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(option)) {
        index += 1;
        continue;
      }
      break;
    }
  }
  return index;
}

function isHostLaunch(argv: readonly string[]): boolean {
  const index = commandIndex(argv);
  const executable = executableName(argv[index] ?? "");
  if (HOST_NAMES.has(executable)) {
    return true;
  }
  if (["sh", "bash", "zsh", "dash"].includes(executable)) {
    const commandFlag = argv.findIndex(
      (word, position) => position > index && (word === "-c" || word === "-lc"),
    );
    if (commandFlag >= 0) {
      return isHostLaunch(argv.slice(commandFlag + 1));
    }
  }
  if (executable !== "node" && executable !== "nodejs") {
    return false;
  }
  return argv.slice(index + 1).some((entry) => {
    const normalized = entry.replaceAll("\\", "/").toLowerCase();
    return (
      normalized.includes("/codepunk/dist/") ||
      normalized.includes("/pi-coding-agent/") ||
      normalized.endsWith("codepunk.js")
    );
  });
}

function nodeScriptIndex(argv: readonly string[], start: number): number {
  for (let index = start + 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-e" || token === "--eval" || token === "-p") {
      return -1;
    }
    if (!token.startsWith("-")) {
      return index;
    }
  }
  return -1;
}

async function fileLooksLikeHost(
  candidate: string,
  cwd: string,
): Promise<boolean> {
  const absolute = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(cwd, candidate);
  const stat = await fs.stat(absolute).catch(() => null);
  if (stat === null || !stat.isFile() || stat.size > MAX_HOST_SCAN_BYTES) {
    return false;
  }
  const bytes = await fs.readFile(absolute).catch(() => null);
  if (bytes === null) {
    return false;
  }
  return HOST_SCRIPT_MARKERS.some((marker) =>
    bytes.includes(Buffer.from(marker)),
  );
}

async function assertNoHostScript(
  argv: readonly string[],
  cwd: string,
): Promise<void> {
  const start = commandIndex(argv);
  const executable = argv[start];
  if (executable === undefined) {
    return;
  }
  const name = executableName(executable);
  const candidates: string[] = [];
  if (name === "node" || name === "nodejs") {
    const scriptIndex = nodeScriptIndex(argv, start);
    if (scriptIndex >= 0) {
      candidates.push(argv[scriptIndex]!);
    }
  } else if (!HOST_NAMES.has(name)) {
    const resolved = await resolveExecutable(executable, cwd);
    if (resolved !== null) {
      candidates.push(resolved);
    }
  }
  for (const candidate of candidates) {
    if (await fileLooksLikeHost(candidate, cwd)) {
      throw new WorkerSandboxError(
        "worker.host_launch_denied",
        "worker cannot launch a copied or renamed codepunk or Pi host",
      );
    }
  }
}

export function assertWorkerArgv(argv: readonly string[]): void {
  if (isHostLaunch(argv)) {
    throw new WorkerSandboxError(
      "worker.host_launch_denied",
      "worker argv cannot launch the codepunk or Pi host",
    );
  }
}

function shellWords(command: string): string[] {
  return command.match(/[^\s"'`;|&]+/gu) ?? [];
}

export function assertWorkerCommand(command: string): void {
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
  ]) {
    if (new RegExp(`(?:^|\\s)${key}\\s*=`, "u").test(command)) {
      throw new WorkerSandboxError(
        "worker.git_redirect",
        `${key} redirects are denied in a worker`,
      );
    }
  }
  const words = shellWords(command);
  const gitIndex = words.indexOf("git");
  if (gitIndex >= 0 && GIT_PLUMBING.has(words[gitIndex + 1] ?? "")) {
    throw new WorkerSandboxError(
      "worker.git_plumbing",
      "git plumbing commands are denied in a worker",
    );
  }
  if (gitIndex >= 0) {
    const subcommand = words[gitIndex + 1] ?? "";
    if (subcommand === "push") {
      throw new WorkerSandboxError(
        "worker.git_push_denied",
        "workers cannot push",
      );
    }
    if (subcommand === "update-ref") {
      throw new WorkerSandboxError(
        "worker.git_ref_denied",
        "workers cannot update refs",
      );
    }
    if (
      subcommand === "reset" &&
      words.slice(gitIndex + 2).includes("--hard")
    ) {
      throw new WorkerSandboxError(
        "worker.git_reset_denied",
        "workers cannot reset --hard",
      );
    }
    if (
      subcommand === "branch" &&
      words.slice(gitIndex + 2).some((word) => /^-[A-Za-z]*f/u.test(word))
    ) {
      throw new WorkerSandboxError(
        "worker.git_ref_denied",
        "workers cannot force-write a branch ref",
      );
    }
  }
  const ghIndex = words.indexOf("gh");
  if (ghIndex >= 0) {
    const subcommand = words.slice(ghIndex + 1).join(" ");
    if (
      /^pr\s+merge\b/u.test(subcommand) ||
      /^api\b.*\/pulls\/[^/]+\/merge/u.test(subcommand)
    ) {
      throw new WorkerSandboxError(
        "worker.gh_merge_denied",
        "workers cannot merge pull requests",
      );
    }
  }
  if (isHostLaunch(words)) {
    throw new WorkerSandboxError(
      "worker.host_launch_denied",
      "worker shells cannot launch the codepunk or Pi host",
    );
  }
}

export class WorkerSandbox {
  readonly worktree: string;
  readonly runDir: string;
  readonly depth: number;
  private readonly sandbox: SrtSandbox;
  private readonly depthToken: string;
  private closed = false;

  private constructor(
    options: WorkerSandboxOptions,
    sandbox: SrtSandbox,
    depthToken: string,
  ) {
    this.worktree = normalizeAbsolute(options.worktree);
    this.runDir = normalizeAbsolute(options.runDir);
    this.depth = options.depth ?? 0;
    this.sandbox = sandbox;
    this.depthToken = depthToken;
  }

  static async create(options: WorkerSandboxOptions): Promise<WorkerSandbox> {
    const worktree = normalizeAbsolute(options.worktree);
    const runDir = normalizeAbsolute(options.runDir);
    const deliveryRoot = normalizeAbsolute(options.deliveryRoot);
    const parentRoot = normalizeAbsolute(options.parentRoot);
    const siblingRoot = normalizeAbsolute(options.siblingRoot);
    if (isInsidePath(deliveryRoot, worktree)) {
      throw new WorkerSandboxError(
        "worker.worktree_inside_delivery",
        "worker worktree must stay outside the delivery root",
      );
    }
    if (isInsidePath(deliveryRoot, runDir)) {
      throw new WorkerSandboxError(
        "worker.run_inside_delivery",
        "worker run directory must stay outside the delivery root",
      );
    }
    const commonGitDir = normalizeAbsolute(
      (
        await gitText(deliveryRoot, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).trim(),
    );
    const worktreeGitDir = normalizeAbsolute(
      (
        await gitText(worktree, [
          "rev-parse",
          "--path-format=absolute",
          "--git-dir",
        ])
      ).trim(),
    );
    const depthToken = options.depthToken ?? randomBytes(16).toString("hex");
    assertDepthTokenFormat(depthToken);
    const installRoots =
      options.installRoots === undefined
        ? defaultWorkerInstallRoots()
        : [...options.installRoots];
    let sandbox = options.sandbox;
    if (sandbox === undefined) {
      try {
        sandbox = await SrtSandbox.create({
          cwd: worktree,
          workspaceRoot: worktree,
          deliveryRoot,
          codepunkHome: options.codepunkHome,
          writeSet: [worktree],
          networkAllow: options.networkAllow ?? [],
          networkDeny: options.networkDeny ?? [],
          worker: {
            worktree,
            runDir,
            parentRoot,
            siblingRoot,
            commonGitDir,
            worktreeGitDir,
            installRoots,
          },
        });
      } catch (error) {
        throw new WorkerSandboxError(
          "worker.sandbox_unavailable",
          `worker sandbox is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return new WorkerSandbox(options, sandbox, depthToken);
  }

  get descriptor(): SrtSandbox["descriptor"] {
    return this.sandbox.descriptor;
  }

  get token(): string {
    return this.depthToken;
  }

  assertHostLaunchToken(token: string): void {
    if (this.depth >= 1) {
      throw new WorkerSandboxError(
        "worker.depth_exceeded",
        "worker depth 1 cannot launch another host",
      );
    }
    if (token !== this.depthToken) {
      throw new WorkerSandboxError(
        "worker.depth_token_mismatch",
        "host launch depth token is missing or incorrect",
      );
    }
  }

  assertHostLaunchTokenFromFd(fd = 3): void {
    this.assertHostLaunchToken(readHostLaunchToken(fd));
  }

  assertWriteTarget(target: string, writeSet: readonly string[]): string {
    const absolute = normalizeAbsolute(target);
    if (!isInsidePath(this.worktree, absolute)) {
      throw new WorkerSandboxError(
        "worker.write_outside_worktree",
        "worker file write is outside its worktree",
      );
    }
    const relative = path
      .relative(this.worktree, absolute)
      .split(path.sep)
      .join("/");
    const relativeLower = relative.toLowerCase();
    if (
      relativeLower === "agents.override.md" ||
      relativeLower === "agents.md" ||
      relativeLower === "claude.md" ||
      relativeLower === ".codepunk" ||
      relativeLower.startsWith(".codepunk/")
    ) {
      throw new WorkerSandboxError(
        "worker.protected_path_denied",
        "worker file writes cannot change protected instruction or configuration paths",
      );
    }
    const allowed = writeSet.some((entry) => {
      const normalized = entry.split("\\").join("/").replace(/^\.\//u, "");
      return normalized.endsWith("/")
        ? relative === normalized.slice(0, -1) ||
            relative.startsWith(normalized)
        : relative === normalized;
    });
    if (!allowed) {
      throw new WorkerSandboxError(
        "worker.write_outside_write_set",
        "worker file write is outside the declared write set",
      );
    }
    return absolute;
  }

  private assertCwd(cwd: string): void {
    const absolute = normalizeAbsolute(cwd);
    if (
      !isInsidePath(this.worktree, absolute) &&
      !isInsidePath(this.runDir, absolute)
    ) {
      throw new WorkerSandboxError(
        "worker.cwd_outside",
        "worker shell cwd is outside its worktree and run directory",
      );
    }
  }

  async execCommand(
    command: string,
    cwd: string,
    options: ShellExecutionOptions = {},
  ): Promise<ShellExecutionResult> {
    this.assertOpen();
    this.assertCwd(cwd);
    assertWorkerCommand(command);
    await assertNoHostScript(shellWords(command), cwd);
    return this.sandbox.execCommand(command, cwd, options);
  }

  async execArgv(
    argv: readonly string[],
    cwd: string,
    options: ShellExecutionOptions = {},
  ): Promise<ShellExecutionResult> {
    this.assertOpen();
    this.assertCwd(cwd);
    const command = argv.join(" ");
    assertWorkerCommand(command);
    if (isHostLaunch(argv)) {
      throw new WorkerSandboxError(
        "worker.host_launch_denied",
        "worker argv cannot launch the codepunk or Pi host",
      );
    }
    await assertNoHostScript(argv, cwd);
    return this.sandbox.execArgv(argv, cwd, options);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.sandbox.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new WorkerSandboxError("worker.closed", "worker sandbox is closed");
    }
  }
}

export type WorkerSandboxUnavailable = SandboxUnavailableError;
