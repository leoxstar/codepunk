import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkWindowsDependenciesAsync,
  parseWindowsBinShell,
  resolveSrtWin,
  SandboxManager,
  VENDORED_SRT_WIN_EXE,
  type SandboxDependencyCheck,
  type SandboxRuntimeConfig,
  type WindowsBinShell,
  type WrapWithSandboxOptions,
} from "@anthropic-ai/sandbox-runtime";
export { SandboxManager };
export type { WindowsBinShell } from "@anthropic-ai/sandbox-runtime";
import type { SandboxDescriptor } from "codepunk-protocol";
import { ConfigError } from "../config/index.ts";
import { NetworkGuard, type NetworkEventSink } from "../network/index.ts";
import { sha256Value } from "../platform/hash.ts";
import {
  isInsidePath,
  normalizeAbsolute,
  PI_INSTRUCTION_FILE_NAMES,
} from "../platform/path.ts";

export const SRT_VERSION = "0.0.82";
export const SANDBOX_EXECUTOR = "srt";
export const DIRECT_EXECUTOR = "direct";

/**
 * Read-only git inspection (for example `git status`) refreshes the index
 * unless optional locks are disabled. Agent shell commands always run with
 * optional locks off so an allowed inspection cannot rewrite `.git/index`.
 * Required locks for real mutations are unaffected.
 */
export function agentShellEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...environment, GIT_OPTIONAL_LOCKS: "0" };
}

export class SandboxUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxUnavailableError";
  }
}

export interface SandboxLifecycle {
  cancelPendingInitialization(): void;
}

/**
 * A required sandbox may spend minutes on its first platform setup. Shell
 * tools stay registered while that work runs, and each execution awaits the
 * resolved provider instead of blocking the TUI before its first frame.
 */
export class DeferredSandbox implements ShellProvider {
  readonly sandboxed = true;
  private provider: ShellProvider | null;
  private readonly ready: Promise<ShellProvider | null>;
  private readonly lifecycle: SandboxLifecycle | null;
  private state: "pending" | "closed" = "pending";
  private closePromise: Promise<void> | null = null;
  private lateClosePromise: Promise<void> | null = null;

  constructor(
    ready: Promise<ShellProvider | null>,
    lifecycle?: SandboxLifecycle,
  ) {
    this.ready = ready;
    this.lifecycle = lifecycle ?? null;
    this.provider = null;
    ready.then(
      (resolved) => {
        if (this.provider === null) {
          this.provider = resolved;
        }
        if (this.state === "closed") {
          this.lateClosePromise = resolved?.close?.() ?? null;
          return this.lateClosePromise?.catch(() => undefined);
        }
      },
      () => undefined,
    );
  }

  private async resolve(): Promise<ShellProvider> {
    if (this.state === "closed") {
      throw new SandboxUnavailableError("srt provider is closed");
    }
    const sandbox = this.provider ?? (await this.ready);
    if (sandbox === null) {
      throw new SandboxUnavailableError(
        "srt sandbox is not ready; shell tools are disabled",
      );
    }
    return sandbox;
  }

  async execCommand(
    command: string,
    cwd: string,
    options?: ShellExecutionOptions,
  ): Promise<ShellExecutionResult> {
    const sandbox = await this.resolve();
    return await sandbox.execCommand(command, cwd, {
      ...options,
      descriptor: sandbox.descriptor,
    });
  }

  async execArgv(
    argv: readonly string[],
    cwd: string,
    options?: ShellExecutionOptions,
  ): Promise<ShellExecutionResult> {
    const sandbox = await this.resolve();
    return await sandbox.execArgv(argv, cwd, {
      ...options,
      descriptor: sandbox.descriptor,
    });
  }

  get descriptor(): SandboxDescriptor {
    return (
      this.provider?.descriptor ?? {
        backend: "srt",
        version: SRT_VERSION,
        profile_sha256: null,
        network_allowed_domains: [],
        network_denied_domains: [],
      }
    );
  }

  async close(): Promise<void> {
    if (this.state === "closed") {
      return this.closePromise ?? this.lateClosePromise ?? Promise.resolve();
    }
    this.state = "closed";
    this.closePromise = (async () => {
      this.lifecycle?.cancelPendingInitialization();
      if (this.provider !== null) {
        await this.provider.close?.().catch(() => undefined);
        return;
      }
    })();
    return this.closePromise;
  }
}

export interface SrtProfileInput {
  cwd: string;
  workspaceRoot: string;
  deliveryRoot: string;
  additionalRoots?: readonly string[];
  codepunkHome: string;
  writeSet?: readonly string[];
  /**
   * Domains the sandboxed process may reach. Empty means no egress. This is
   * operator configuration, not something an approval can widen at runtime;
   * `srt` applies the allowlist when the sandbox is initialized.
   */
  networkAllow?: readonly string[];
  /**
   * Domains the sandbox must never reach, even when a wildcard allow entry
   * would match. Operator configuration like the allowlist; a project config
   * cannot set it.
   */
  networkDeny?: readonly string[];
  /**
   * Per-domain request budget. `null` is unlimited and keeps the previous
   * behavior. The counters live on the sandbox because they cover a session,
   * not one command.
   */
  networkMaxRequests?: number | null;
  /**
   * Per-domain byte budget. `null` is unlimited. Only bytes the proxy can
   * observe are counted: a request body's declared length and a response's
   * `content-length`. An opaque HTTPS tunnel is neither counted nor budgeted.
   */
  networkMaxBytes?: number | null;
  /**
   * Remove the workspace write grant entirely. Policy already denies
   * mutations under read-only autonomy; this makes the same claim at the
   * sandbox layer so a policy regression cannot become a filesystem write.
   */
  readOnly?: boolean;
  /**
   * An already-constructed guard. `SrtSandbox.create` builds the guard and
   * passes it here so the profile and the sandbox instance share one set of
   * counters.
   */
  networkGuard?: NetworkGuard;
  worker?: {
    worktree: string;
    runDir: string;
    parentRoot: string;
    siblingRoot: string;
    commonGitDir: string;
    worktreeGitDir: string;
    installRoots?: readonly string[];
  };
}

export interface ShellExecutionOptions {
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  onData?: (chunk: Buffer) => void;
  commandId?: string;
  descriptor?: SandboxDescriptor;
}

export interface ShellExecutionResult {
  output: string;
  exitCode: number | null;
  cancelled: boolean;
  timedOut: boolean;
  executor: typeof SANDBOX_EXECUTOR | typeof DIRECT_EXECUTOR;
  descriptor: SandboxDescriptor;
}

export interface ShellProvider {
  readonly descriptor: SandboxDescriptor;
  readonly sandboxed: boolean;
  execCommand(
    command: string,
    cwd: string,
    options?: ShellExecutionOptions,
  ): Promise<ShellExecutionResult>;
  execArgv(
    argv: readonly string[],
    cwd: string,
    options?: ShellExecutionOptions,
  ): Promise<ShellExecutionResult>;
  close?(): Promise<void>;
}

interface SrtManager {
  initialize(
    runtimeConfig: SandboxRuntimeConfig,
    sandboxAskCallback?: undefined,
    enableLogMonitor?: boolean,
  ): Promise<void>;
  isSupportedPlatform(): boolean;
  checkDependencies(): SandboxDependencyCheck;
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
    options?: WrapWithSandboxOptions,
  ): Promise<string>;
  wrapWithSandboxArgv(
    command: string,
    binShell?: string | WindowsBinShell,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
    cwd?: string,
    options?: WrapWithSandboxOptions,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  annotateStderrWithSandboxFailures(command: string, stderr: string): string;
  cleanupAfterCommand?(): void;
  reset?(): Promise<void>;
}

const WINDOWS_ARGV_MARKER = "C:\\__codepunk_argv__\\runner.exe";
const WINDOWS_ARGV_SENTINEL = "__CODEPUNK_ARGV_SENTINEL__";
const WINDOWS_SCRIPT = /\.(?:cmd|bat|ps1)$/iu;

function windowsEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const direct = environment[name];
  if (direct !== undefined) {
    return direct;
  }
  const target = name.toUpperCase();
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() === target) {
      return value;
    }
  }
  return undefined;
}

export function resolveWindowsExecutable(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const candidate = name.trim();
  if (candidate.length === 0) {
    throw new SandboxUnavailableError("argv executable is missing");
  }
  if (path.win32.isAbsolute(candidate)) {
    return candidate;
  }
  if (candidate.includes("\\") || candidate.includes("/")) {
    const resolved = path.win32.resolve(candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
    throw new SandboxUnavailableError(`executable not found at ${resolved}`);
  }
  const searchPath = windowsEnvironmentValue(environment, "PATH") ?? "";
  const extensions = (
    windowsEnvironmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD"
  )
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const names = path.win32.extname(candidate)
    ? [candidate]
    : [candidate, ...extensions.map((extension) => candidate + extension)];
  for (const entry of searchPath.split(";")) {
    const directory = entry.trim().replace(/^"(.*)"$/u, "$1");
    if (directory.length === 0) {
      continue;
    }
    for (const fileName of names) {
      const fullPath = path.win32.join(directory, fileName);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }
  throw new SandboxUnavailableError(
    `executable not found on PATH: ${candidate}`,
  );
}

export interface WindowsShellSelection {
  readonly kind: "auto" | "bash" | "pwsh";
  readonly executable: string | null;
  readonly binShell: WindowsBinShell | null;
}

function windowsSystemBashPath(environment: NodeJS.ProcessEnv): string {
  const systemRoot =
    environment["SystemRoot"] ??
    environment["windir"] ??
    process.env["SystemRoot"] ??
    process.env["windir"] ??
    "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "bash.exe");
}

/**
 * Resolve the shell selected by `tools.shell` without starting a session.
 * Windows startup uses this before creating the runtime so an explicit
 * shell that cannot be resolved fails with a ConfigError instead of
 * falling back to cmd.exe or direct execution.
 */
export async function resolveWindowsShell(
  choice: "auto" | "bash" | "pwsh",
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<WindowsShellSelection> {
  if (platform !== "win32" || choice === "auto") {
    return { kind: choice, executable: null, binShell: null };
  }
  if (choice === "pwsh") {
    for (const name of ["pwsh.exe", "powershell.exe"]) {
      try {
        const executable = resolveWindowsExecutable(name, environment);
        return {
          kind: choice,
          executable,
          binShell: parseWindowsBinShell(executable),
        };
      } catch {
        // Try powershell.exe after pwsh.exe.
      }
    }
    throw new ConfigError(
      "tools.shell=pwsh requires pwsh.exe or powershell.exe on PATH",
      "tools.shell",
    );
  }
  let executable: string;
  try {
    executable = resolveWindowsExecutable("bash.exe", environment);
  } catch {
    throw new ConfigError(
      "tools.shell=bash requires bash.exe from Git for Windows or MSYS2 on PATH",
      "tools.shell",
    );
  }
  if (
    path.win32.resolve(executable).toLowerCase() ===
    path.win32.resolve(windowsSystemBashPath(environment)).toLowerCase()
  ) {
    throw new ConfigError(
      "tools.shell=bash refuses %SystemRoot%\\System32\\bash.exe (WSL); use Git for Windows or MSYS2 bash",
      "tools.shell",
    );
  }
  let version: WindowsCommandResult;
  try {
    version = await runWindowsCommand(executable, ["--version"], environment);
  } catch (error) {
    throw new ConfigError(
      `tools.shell=bash version preflight failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "tools.shell",
    );
  }
  const firstLine = version.stdout.split(/\r?\n/u)[0]?.trim() ?? "";
  if (
    version.code !== 0 ||
    !/pc-msys/iu.test(firstLine) ||
    /pc-cygwin|pc-linux-gnu/iu.test(firstLine)
  ) {
    throw new ConfigError(
      `tools.shell=bash requires an MSYS bash (pc-msys); got ${firstLine || `exit ${version.code}`}`,
      "tools.shell",
    );
  }
  return {
    kind: choice,
    executable,
    binShell: parseWindowsBinShell(executable),
  };
}

/**
 * Run a no-op command through the selected Windows shell inside srt.
 * Resolution alone is not proof that the shell starts under the sandbox;
 * callers use this before opening a session.
 */
export async function probeWindowsShell(
  sandbox: ShellProvider,
  selection: WindowsShellSelection,
  cwd: string,
): Promise<void> {
  if (selection.kind === "auto" || selection.executable === null) {
    return;
  }
  const argv =
    selection.kind === "pwsh"
      ? [selection.executable, "-NoProfile", "-Command", "exit 0"]
      : [selection.executable, "-lc", "exit 0"];
  let result: ShellExecutionResult;
  try {
    result = await sandbox.execArgv(argv, cwd, { timeout: 30_000 });
  } catch (error) {
    throw new ConfigError(
      `tools.shell=${selection.kind} srt preflight failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "tools.shell",
    );
  }
  if (result.exitCode !== 0) {
    throw new ConfigError(
      `tools.shell=${selection.kind} srt preflight exited ${result.exitCode}: ${result.output.trim()}`,
      "tools.shell",
    );
  }
}

export interface CreateSrtSandboxOptions {
  manager?: SrtManager;
  /**
   * Test seam and embedding override. Production uses the running platform
   * and the pinned runtime's vendored Windows helper.
   */
  platform?: NodeJS.Platform;
  windowsSrtWinPath?: string;
  /**
   * Test seam for the Windows dependency probe. Production uses the
   * stateless check exported by the pinned runtime, which does not
   * initialize the sandbox or stamp filesystem ACLs.
   */
  windowsDependencyCheck?: (
    config: SandboxRuntimeConfig,
  ) => Promise<SandboxDependencyCheck>;
  /**
   * Test seam for the profile root refused as a persistent Windows
   * write root. Production uses the current user's home directory.
   */
  userHome?: string;
  /**
   * Test seam for the Windows deny ACE that keeps the codepunk home out of
   * the srt ACL walk. Production applies an inheritable deny ACE for the
   * sandbox user with `icacls`.
   */
  protectWindowsCodepunkHome?: (
    codepunkHome: string,
    srtWinPath: string | undefined,
  ) => Promise<void>;
  /**
   * Inner Windows shell resolved from `tools.shell`. `auto` leaves this
   * undefined so srt-win keeps its default cmd.exe.
   */
  windowsBinShell?: WindowsBinShell;
  /**
   * Run id stamped on the network events. The sandbox starts before the
   * first run exists, so a callback reads the current run id at the moment
   * the event is emitted. A plain string is accepted for a fixed sandbox.
   */
  runId?: string | (() => string);
  /**
   * Sink for the network events the sandbox proxy emits. When it is absent
   * the guard still enforces the budgets; the events are only dropped.
   */
  onNetworkEvent?: NetworkEventSink;
}

function writeRoots(input: SrtProfileInput): string[] {
  const roots = new Set<string>();
  const allowedRoots = [
    normalizeAbsolute(input.workspaceRoot),
    ...(input.additionalRoots ?? []).map((entry) => normalizeAbsolute(entry)),
  ];
  for (const entry of input.writeSet ?? []) {
    const candidate = normalizeAbsolute(
      path.isAbsolute(entry) ? entry : path.resolve(input.cwd, entry),
    );
    if (allowedRoots.some((root) => isInsidePath(root, candidate))) {
      roots.add(candidate);
    }
  }
  return [...roots].sort();
}

/**
 * A persistent Windows write root walks its whole subtree on first use.
 * A read-only session turns the workspace roots into deny-write stamps,
 * which walk the same tree. Granting or stamping the user profile or a
 * volume root turns a normal startup into an unbounded ACL walk that can
 * look like a hang and can leave partial access entries behind when the
 * process is interrupted. Refuse those roots before srt initializes; a
 * project beneath the profile is still allowed.
 */
function assertWindowsSandboxRootsAreScoped(
  input: SrtProfileInput,
  userHome: string,
): void {
  const roots = new Set<string>();
  if (input.readOnly === true) {
    for (const entry of [
      input.workspaceRoot,
      ...(input.additionalRoots ?? []),
    ]) {
      roots.add(path.win32.resolve(entry));
    }
  } else {
    const allowedRoots = [
      path.win32.resolve(input.workspaceRoot),
      ...(input.additionalRoots ?? []).map((entry) =>
        path.win32.resolve(entry),
      ),
    ];
    for (const entry of input.writeSet ?? []) {
      const candidate = path.win32.resolve(input.cwd, entry);
      if (
        allowedRoots.some((root) => {
          const relative = path.win32.relative(root, candidate);
          return (
            relative === "" ||
            (!relative.startsWith("..") && !path.win32.isAbsolute(relative))
          );
        })
      ) {
        roots.add(candidate);
      }
    }
  }
  const home = path.win32.resolve(userHome);
  for (const root of roots) {
    const volumeRoot = path.win32.parse(root).root;
    const relativeToRoot = path.win32.relative(root, home);
    const containsHome =
      relativeToRoot === "" ||
      (!relativeToRoot.startsWith("..") &&
        !path.win32.isAbsolute(relativeToRoot));
    if (root === volumeRoot || containsHome) {
      if (input.readOnly === true) {
        throw new SandboxUnavailableError(
          `Windows read-only sandbox refuses to stamp the user profile or a volume root (${root}); start codepunk from a project directory, or pass --sandbox uncovered to start without shell sandboxing`,
        );
      }
      throw new SandboxUnavailableError(
        `Windows sandbox refuses to grant persistent access to the user profile or a volume root (${root}); start codepunk from a project directory, or pass --sandbox uncovered to start without shell sandboxing`,
      );
    }
  }
}

interface WindowsCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runWindowsCommand(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WindowsCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `${path.win32.basename(executable)} timed out after 30 seconds`,
        ),
      );
    }, 30_000);
    timer.unref();
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: decodeShellOutput(Buffer.concat(stdout), "win32"),
        stderr: decodeShellOutput(Buffer.concat(stderr), "win32"),
      });
    });
  });
}

function windowsSystemExecutable(name: string): string {
  const systemRoot =
    process.env["SystemRoot"] ?? process.env["windir"] ?? "C:\\Windows";
  const candidate = path.win32.join(systemRoot, "System32", name);
  return existsSync(candidate) ? candidate : name;
}

function windowsPathKey(value: string): string {
  return path.win32.resolve(value).toLowerCase();
}

function hasInheritableSandboxDeny(
  aclOutput: string,
  sid: string,
  name: string | undefined,
): boolean {
  return aclOutput.split(/\r?\n/u).some((line) => {
    const namesSandboxUser =
      line.includes(sid) || (name !== undefined && line.includes(name));
    return (
      namesSandboxUser &&
      line.includes("(N)") &&
      line.includes("(OI)") &&
      line.includes("(CI)")
    );
  });
}

/**
 * srt-win's deny stamp also writes a FILE_DELETE_CHILD ACE on the target's
 * parent. For the codepunk home that parent is the user profile, and the
 * walk over it can burn CPU for minutes with no output. Protect the
 * directory directly instead: an inheritable deny ACE for the sandbox user
 * costs one `icacls` call, needs no parent walk, and stays correct for every
 * later session because no sandboxed command should ever reach this tree.
 */
export async function protectWindowsCodepunkHome(
  codepunkHome: string,
  srtWinPath?: string,
): Promise<void> {
  const srtWin = resolveSrtWin({
    path: srtWinPath ?? VENDORED_SRT_WIN_EXE,
  });
  const status = await runWindowsCommand(srtWin.exe, [
    ...srtWin.prependArgs,
    "user",
    "status",
  ]);
  if (status.code !== 0) {
    throw new SandboxUnavailableError(
      `cannot protect ${codepunkHome}: srt-win user status exited ${status.code}: ${status.stderr.trim() || status.stdout.trim()}`,
    );
  }
  let sid: string | undefined;
  let name: string | undefined;
  try {
    const parsed = JSON.parse(status.stdout) as {
      user?: { sid?: unknown; name?: unknown };
    };
    if (typeof parsed.user?.sid === "string" && parsed.user.sid.length > 0) {
      sid = parsed.user.sid;
    }
    if (typeof parsed.user?.name === "string") {
      name = parsed.user.name;
    }
  } catch (error) {
    throw new SandboxUnavailableError(
      `cannot protect ${codepunkHome}: srt-win user status did not return JSON`,
      { cause: error },
    );
  }
  if (sid === undefined) {
    throw new SandboxUnavailableError(
      `cannot protect ${codepunkHome}: srt-win user status did not return the sandbox user SID`,
    );
  }
  const icacls = windowsSystemExecutable("icacls.exe");
  const current = await runWindowsCommand(icacls, [codepunkHome]);
  if (current.code !== 0) {
    throw new SandboxUnavailableError(
      `cannot inspect the access list of ${codepunkHome}: ${current.stderr.trim() || `icacls exited ${current.code}`}`,
    );
  }
  if (hasInheritableSandboxDeny(current.stdout, sid, name)) {
    return;
  }
  const removed = await runWindowsCommand(icacls, [
    codepunkHome,
    "/remove:d",
    `*${sid}`,
  ]);
  if (removed.code !== 0) {
    throw new SandboxUnavailableError(
      `cannot replace the access list of ${codepunkHome}: ${removed.stderr.trim() || `icacls exited ${removed.code}`}`,
    );
  }
  const denied = await runWindowsCommand(icacls, [
    codepunkHome,
    "/deny",
    `*${sid}:(OI)(CI)(F)`,
  ]);
  if (denied.code !== 0) {
    throw new SandboxUnavailableError(
      `cannot deny the sandbox user access to ${codepunkHome}: ${denied.stderr.trim() || `icacls exited ${denied.code}`}`,
    );
  }
  const verified = await runWindowsCommand(icacls, [codepunkHome]);
  if (
    verified.code !== 0 ||
    !hasInheritableSandboxDeny(verified.stdout, sid, name)
  ) {
    throw new SandboxUnavailableError(
      `the sandbox user deny ACE did not appear on ${codepunkHome}`,
    );
  }
}

function windowsCodepunkHomeIsOutsideWriteRoots(
  input: SrtProfileInput,
): boolean {
  const home = windowsPathKey(input.codepunkHome);
  return !writeRoots(input).some((root) => {
    const relative = path.win32.relative(windowsPathKey(root), home);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.win32.isAbsolute(relative))
    );
  });
}

function withoutWindowsCodepunkHomeDenies(
  config: SandboxRuntimeConfig,
  codepunkHome: string,
): SandboxRuntimeConfig {
  const home = windowsPathKey(codepunkHome);
  const keep = (entry: string | { path: string; literal: true }): boolean =>
    typeof entry !== "string" || windowsPathKey(entry) !== home;
  return {
    ...config,
    filesystem: {
      ...config.filesystem,
      denyRead: config.filesystem.denyRead.filter(keep),
      denyWrite: config.filesystem.denyWrite.filter(keep),
    },
  };
}

export function srtProfile(input: SrtProfileInput): SandboxRuntimeConfig {
  const codepunkHome = normalizeAbsolute(input.codepunkHome);
  const allowedDomains = [...new Set(input.networkAllow ?? [])].sort();
  const deniedDomains = [...new Set(input.networkDeny ?? [])].sort();
  // The guard repeats the runtime's domain decision so codepunk can count
  // requests and bytes per domain, refuse a request before it is forwarded
  // when a budget would be exceeded, and record every redirect hop. It is
  // installed whenever the budgets are configured or an event sink exists;
  // otherwise the profile is byte-identical to the previous shape, so the
  // descriptor hash does not drift when the feature is off.
  const networkGuard = input.networkGuard ?? null;
  const filterRequest = networkGuard?.filterRequest;
  const projectConfig = path.join(
    normalizeAbsolute(input.deliveryRoot),
    ".codepunk",
  );
  if (input.worker !== undefined) {
    const worker = input.worker;
    const commonGitDir = normalizeAbsolute(worker.commonGitDir);
    return {
      network: {
        allowedDomains,
        deniedDomains,
        ...(filterRequest !== undefined ? { filterRequest } : {}),
      },
      filesystem: {
        denyRead: [
          normalizeAbsolute(worker.parentRoot),
          normalizeAbsolute(worker.siblingRoot),
          codepunkHome,
          projectConfig,
          ...(worker.installRoots ?? []).map((entry) =>
            normalizeAbsolute(entry),
          ),
        ],
        allowRead: [
          normalizeAbsolute(worker.worktree),
          normalizeAbsolute(worker.runDir),
          path.join(commonGitDir, "objects"),
          path.join(commonGitDir, "config"),
          path.join(commonGitDir, "HEAD"),
          path.join(commonGitDir, "refs"),
          normalizeAbsolute(worker.worktreeGitDir),
        ],
        allowWrite: [
          normalizeAbsolute(worker.worktree),
          normalizeAbsolute(worker.runDir),
          path.join(commonGitDir, "objects"),
          normalizeAbsolute(worker.worktreeGitDir),
        ],
        denyWrite: [
          ...PI_INSTRUCTION_FILE_NAMES.map((name) =>
            path.join(normalizeAbsolute(worker.worktree), name),
          ),
          path.join(normalizeAbsolute(worker.worktree), ".codepunk"),
          path.join(commonGitDir, "hooks"),
          path.join(commonGitDir, "config"),
          path.join(commonGitDir, "info"),
          path.join(commonGitDir, "packed-refs"),
          path.join(commonGitDir, "refs"),
          path.join(commonGitDir, "objects", "info"),
          path.join(commonGitDir, "objects", "pack"),
        ],
      },
    };
  }
  const workspaceRoot = normalizeAbsolute(input.workspaceRoot);
  const additionalRoots = (input.additionalRoots ?? []).map((entry) =>
    normalizeAbsolute(entry),
  );
  const allRoots = [workspaceRoot, ...additionalRoots];
  const protectedConfigDirs = [
    projectConfig,
    ...additionalRoots.map((root) => path.join(root, ".codepunk")),
  ];
  const protectedGitPaths = allRoots.flatMap((root) => {
    const rootGitDir = path.join(root, ".git");
    return [
      rootGitDir,
      path.join(rootGitDir, "config"),
      path.join(rootGitDir, "config.worktree"),
      path.join(rootGitDir, "hooks"),
      path.join(rootGitDir, "info"),
      path.join(rootGitDir, "objects", "info"),
      path.join(rootGitDir, "objects", "pack"),
    ];
  });
  const readOnly = input.readOnly === true;
  return {
    network: {
      allowedDomains,
      deniedDomains,
      ...(filterRequest !== undefined ? { filterRequest } : {}),
    },
    filesystem: {
      denyRead: [codepunkHome, ...protectedConfigDirs],
      allowWrite: readOnly ? [] : writeRoots(input),
      denyWrite: [
        ...(readOnly ? allRoots : []),
        codepunkHome,
        ...protectedConfigDirs,
        ...protectedGitPaths,
      ],
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function looksUtf16Le(buffer: Buffer): boolean {
  if (buffer.length < 4) {
    return false;
  }
  let zeroHighBytes = 0;
  const pairs = Math.floor(buffer.length / 2);
  for (let index = 1; index < buffer.length; index += 2) {
    if (buffer[index] === 0) {
      zeroHighBytes += 1;
    }
  }
  return zeroHighBytes / pairs >= 0.6;
}

/**
 * Decode a shell stream without assuming that every Windows tool writes
 * UTF-8. Node, git and most modern tools do; cmd.exe built-ins and native
 * Win32 tools use the active OEM code page, which is GBK on a Chinese
 * Windows install. Strict UTF-8 is tried first so valid UTF-8 is never
 * reinterpreted, then GB18030 (a superset of GBK) for those legacy tools.
 */
export function decodeShellOutput(
  buffer: Buffer,
  platform: NodeJS.Platform = process.platform,
): string {
  if (buffer.length === 0) {
    return "";
  }
  if (platform !== "win32") {
    return buffer.toString("utf8");
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  }
  if (looksUtf16Le(buffer)) {
    return new TextDecoder("utf-16le").decode(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder("gb18030", { fatal: true }).decode(buffer);
    } catch {
      // Fall through to the replacement-character decode below.
    }
    return buffer.toString("utf8");
  }
}

function runtimeConfigFor(
  config: SandboxRuntimeConfig,
  platform: NodeJS.Platform,
  windowsSrtWinPath?: string,
): SandboxRuntimeConfig {
  if (platform !== "win32") {
    return config;
  }
  return {
    ...config,
    windows: {
      ...config.windows,
      srtWin: {
        path: windowsSrtWinPath ?? VENDORED_SRT_WIN_EXE,
      },
    },
  };
}

async function checkWindowsDependencies(
  config: SandboxRuntimeConfig,
): Promise<SandboxDependencyCheck> {
  if (config.windows?.srtWin === undefined) {
    return {
      errors: ["no srt-win path configured for the Windows dependency probe"],
      warnings: [],
    };
  }
  return checkWindowsDependenciesAsync({
    srtWin: resolveSrtWin(config.windows.srtWin),
  });
}

async function checkDependenciesFor(
  manager: SrtManager,
  config: SandboxRuntimeConfig,
  platform: NodeJS.Platform,
  windowsDependencyCheck: CreateSrtSandboxOptions["windowsDependencyCheck"],
): Promise<SandboxDependencyCheck> {
  if (platform === "win32") {
    return (windowsDependencyCheck ?? checkWindowsDependencies)(config);
  }
  return manager.checkDependencies();
}

function isAddressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ("code" in error && error.code === "EADDRINUSE") {
    return true;
  }
  return "cause" in error && isAddressInUse(error.cause);
}

function terminateProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32" && child.pid !== undefined) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const killDirect = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    };
    killer.once("error", killDirect);
    killer.once("exit", (code) => {
      if (code !== 0) {
        killDirect();
      }
    });
    killer.unref();
    return;
  }
  child.kill("SIGKILL");
}

/**
 * Check whether srt can run without initializing a session. On Windows a
 * full initialize stamps persistent filesystem ACLs, which is far too much
 * work for `codepunk doctor` and must not happen before a dependency
 * failure has been ruled out.
 */
export async function probeSrtSandbox(
  input: SrtProfileInput,
  options: CreateSrtSandboxOptions = {},
): Promise<string | null> {
  const manager = options.manager ?? SandboxManager;
  const platform = options.platform ?? process.platform;
  if (!manager.isSupportedPlatform()) {
    return "srt does not support this platform; shell execution is disabled";
  }
  try {
    const config = runtimeConfigFor(
      srtProfile(input),
      platform,
      options.windowsSrtWinPath,
    );
    const dependencies = await checkDependenciesFor(
      manager,
      config,
      platform,
      options.windowsDependencyCheck,
    );
    return dependencies.errors.length > 0
      ? `srt dependency check failed: ${dependencies.errors.join("; ")}`
      : null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export class SrtSandbox implements ShellProvider {
  readonly descriptor: SandboxDescriptor;
  readonly sandboxed = true;
  readonly warnings: readonly string[];
  /**
   * The network guard, when one was installed. Tests inject requests and
   * redirects directly so the budget and redirect behavior can be checked
   * without a public network or a running proxy.
   */
  readonly networkGuard: NetworkGuard | null;
  private readonly manager: SrtManager;
  private readonly platform: NodeJS.Platform;
  private readonly windowsBinShell: WindowsBinShell | undefined;
  private disposed = false;

  private constructor(
    manager: SrtManager,
    config: SandboxRuntimeConfig,
    warnings: readonly string[],
    platform: NodeJS.Platform,
    windowsBinShell: WindowsBinShell | undefined,
    networkGuard: NetworkGuard | null,
  ) {
    this.manager = manager;
    this.warnings = warnings;
    this.platform = platform;
    this.windowsBinShell = windowsBinShell;
    this.networkGuard = networkGuard;
    this.descriptor = {
      backend: "srt",
      version: SRT_VERSION,
      profile_sha256: sha256Value(config),
      network_allowed_domains: [...config.network.allowedDomains],
      network_denied_domains: [...config.network.deniedDomains],
    };
  }

  static async create(
    input: SrtProfileInput,
    options: CreateSrtSandboxOptions = {},
  ): Promise<SrtSandbox> {
    const manager = options.manager ?? SandboxManager;
    const platform = options.platform ?? process.platform;
    if (!manager.isSupportedPlatform()) {
      throw new SandboxUnavailableError(
        "srt does not support this platform; shell execution is disabled",
      );
    }
    if (platform === "win32") {
      assertWindowsSandboxRootsAreScoped(
        input,
        options.userHome ?? os.homedir(),
      );
    }
    const networkGuard =
      options.onNetworkEvent !== undefined ||
      (input.networkMaxRequests !== undefined &&
        input.networkMaxRequests !== null) ||
      (input.networkMaxBytes !== undefined && input.networkMaxBytes !== null)
        ? new NetworkGuard({
            runId: options.runId ?? "sandbox",
            allow: [...new Set(input.networkAllow ?? [])].sort(),
            deny: [...new Set(input.networkDeny ?? [])].sort(),
            maxRequests: input.networkMaxRequests ?? null,
            maxBytes: input.networkMaxBytes ?? null,
            onEvent: options.onNetworkEvent,
          })
        : null;
    const profileInput: SrtProfileInput = {
      ...input,
      ...(networkGuard !== null ? { networkGuard } : {}),
    };
    let config = srtProfile(profileInput);
    let runtimeConfig = runtimeConfigFor(
      config,
      platform,
      options.windowsSrtWinPath,
    );
    const dependencies = await checkDependenciesFor(
      manager,
      runtimeConfig,
      platform,
      options.windowsDependencyCheck,
    );
    if (dependencies.errors.length > 0) {
      throw new SandboxUnavailableError(
        `srt dependency check failed: ${dependencies.errors.join("; ")}`,
      );
    }
    if (platform === "win32" && windowsCodepunkHomeIsOutsideWriteRoots(input)) {
      const codepunkHome = normalizeAbsolute(input.codepunkHome);
      await (options.protectWindowsCodepunkHome ?? protectWindowsCodepunkHome)(
        codepunkHome,
        options.windowsSrtWinPath,
      );
      config = withoutWindowsCodepunkHomeDenies(config, codepunkHome);
      runtimeConfig = runtimeConfigFor(
        config,
        platform,
        options.windowsSrtWinPath,
      );
    }
    try {
      // The Windows proxy range is shared by every process on the host. A
      // parallel process can take the last free port between srt's probe
      // and its bind; srt clears its partial state on a failed initialize,
      // so retrying the same configuration is safe.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await manager.initialize(runtimeConfig);
          break;
        } catch (error) {
          if (platform !== "win32" || !isAddressInUse(error) || attempt >= 5) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        }
      }
    } catch (error) {
      throw new SandboxUnavailableError(
        `srt initialization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    return new SrtSandbox(
      manager,
      config,
      dependencies.warnings,
      platform,
      options.windowsBinShell,
      networkGuard,
    );
  }

  private assertAvailable(): void {
    if (this.disposed) {
      throw new SandboxUnavailableError("srt provider is closed");
    }
  }

  private async runProcess(
    argv: string[],
    cwd: string,
    options: ShellExecutionOptions,
    useShell: boolean,
  ): Promise<ShellExecutionResult> {
    this.assertAvailable();
    const commandId = options.commandId ?? randomUUID();
    const outputChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let cancelled = false;
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: useShell,
      windowsHide: true,
    });
    const onAbort = () => {
      cancelled = true;
      terminateProcessTree(child, this.platform);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }
    let timer: NodeJS.Timeout | undefined;
    if (options.timeout !== undefined && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child, this.platform);
      }, options.timeout);
      timer.unref();
    }
    child.stdout.on("data", (chunk: Buffer) => {
      outputChunks.push(chunk);
      options.onData?.(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      outputChunks.push(chunk);
      options.onData?.(chunk);
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    }).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener("abort", onAbort);
    });
    const stderr = decodeShellOutput(
      Buffer.concat(stderrChunks),
      this.platform,
    );
    let output = decodeShellOutput(Buffer.concat(outputChunks), this.platform);
    const annotated = this.manager.annotateStderrWithSandboxFailures(
      commandId,
      stderr,
    );
    if (annotated !== stderr) {
      output += annotated.slice(stderr.length);
    }
    return {
      output,
      exitCode: timedOut ? 124 : cancelled ? null : exitCode,
      cancelled,
      timedOut,
      executor: SANDBOX_EXECUTOR,
      descriptor: options.descriptor ?? this.descriptor,
    };
  }

  async execCommand(
    command: string,
    cwd: string,
    options: ShellExecutionOptions = {},
  ): Promise<ShellExecutionResult> {
    this.assertAvailable();
    if (command.length === 0) {
      throw new SandboxUnavailableError("shell command is empty");
    }
    const commandId = options.commandId ?? randomUUID();
    if (this.platform === "win32") {
      const wrapped = await this.manager.wrapWithSandboxArgv(
        command,
        this.windowsBinShell,
        undefined,
        options.signal,
        cwd,
        { commandId },
      );
      return this.runProcess(
        wrapped.argv,
        cwd,
        {
          ...options,
          commandId,
          env: { ...wrapped.env, ...(options.env ?? {}) },
        },
        false,
      );
    }
    const wrapped = await this.manager.wrapWithSandbox(
      command,
      undefined,
      undefined,
      options.signal,
      { commandId },
    );
    return this.runProcess([wrapped], cwd, { ...options, commandId }, true);
  }

  async execArgv(
    commandArgv: readonly string[],
    cwd: string,
    options: ShellExecutionOptions = {},
  ): Promise<ShellExecutionResult> {
    this.assertAvailable();
    const executableName = commandArgv[0];
    if (executableName === undefined || executableName.length === 0) {
      throw new SandboxUnavailableError("argv executable is missing");
    }
    if (this.platform === "win32") {
      const executable = resolveWindowsExecutable(executableName);
      if (WINDOWS_SCRIPT.test(executable)) {
        throw new SandboxUnavailableError(
          "argv-only execution cannot start a Windows script; invoke cmd.exe or powershell.exe explicitly",
        );
      }
      const targetArgv = [executable, ...commandArgv.slice(1)];
      const commandId = options.commandId ?? randomUUID();
      const wrapped = await this.manager.wrapWithSandboxArgv(
        WINDOWS_ARGV_SENTINEL,
        { exe: WINDOWS_ARGV_MARKER, args: [] },
        undefined,
        options.signal,
        cwd,
        { commandId, commandText: targetArgv.join(" ") },
      );
      const tail = wrapped.argv.slice(-2);
      if (
        tail[0] !== WINDOWS_ARGV_MARKER ||
        tail[1] !== WINDOWS_ARGV_SENTINEL
      ) {
        throw new SandboxUnavailableError(
          "the pinned srt runtime changed its Windows argv layout; argv-only execution is disabled",
        );
      }
      return this.runProcess(
        [...wrapped.argv.slice(0, -2), ...targetArgv],
        cwd,
        {
          ...options,
          commandId,
          env: { ...wrapped.env, ...(options.env ?? {}) },
        },
        false,
      );
    }
    const commandId = options.commandId ?? randomUUID();
    const command = commandArgv.map(shellQuote).join(" ");
    const wrapped = await this.manager.wrapWithSandboxArgv(
      command,
      undefined,
      undefined,
      options.signal,
      cwd,
      { commandId },
    );
    return this.runProcess(
      wrapped.argv,
      cwd,
      {
        ...options,
        commandId,
        env: { ...wrapped.env, ...(options.env ?? {}) },
      },
      false,
    );
  }

  dispose(): void {
    this.disposed = true;
  }

  async close(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.manager.cleanupAfterCommand?.();
    await this.manager.reset?.();
  }
}

export class UnsandboxedShell implements ShellProvider {
  readonly descriptor: SandboxDescriptor = {
    backend: "none",
    version: null,
    profile_sha256: null,
  };
  readonly sandboxed = false;
  private disposed = false;

  private assertAvailable(): void {
    if (this.disposed) {
      throw new SandboxUnavailableError("unsandboxed shell provider is closed");
    }
  }

  private async runProcess(
    argv: string[],
    cwd: string,
    options: ShellExecutionOptions,
    useShell: boolean,
  ): Promise<ShellExecutionResult> {
    this.assertAvailable();
    const outputChunks: Buffer[] = [];
    let timedOut = false;
    let cancelled = false;
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: useShell,
      windowsHide: true,
    });
    const onAbort = () => {
      cancelled = true;
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }
    let timer: NodeJS.Timeout | undefined;
    if (options.timeout !== undefined && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeout);
      timer.unref();
    }
    child.stdout.on("data", (chunk: Buffer) => {
      outputChunks.push(chunk);
      options.onData?.(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputChunks.push(chunk);
      options.onData?.(chunk);
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    }).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener("abort", onAbort);
    });
    const output = decodeShellOutput(Buffer.concat(outputChunks));
    return {
      output,
      exitCode: timedOut ? 124 : cancelled ? null : exitCode,
      cancelled,
      timedOut,
      executor: DIRECT_EXECUTOR,
      descriptor: this.descriptor,
    };
  }

  async execCommand(
    command: string,
    cwd: string,
    options: ShellExecutionOptions = {},
  ): Promise<ShellExecutionResult> {
    this.assertAvailable();
    if (command.length === 0) {
      throw new SandboxUnavailableError("shell command is empty");
    }
    return this.runProcess([command], cwd, options, true);
  }

  async execArgv(
    commandArgv: readonly string[],
    cwd: string,
    options: ShellExecutionOptions = {},
  ): Promise<ShellExecutionResult> {
    this.assertAvailable();
    if (commandArgv.length === 0 || commandArgv[0]?.length === 0) {
      throw new SandboxUnavailableError("argv executable is missing");
    }
    return this.runProcess([...commandArgv], cwd, options, false);
  }

  async close(): Promise<void> {
    this.disposed = true;
  }
}
