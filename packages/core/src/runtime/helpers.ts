import { promises as fs } from "node:fs";
import path from "node:path";
import type { SessionEvent } from "codepunk-protocol";
import { isShellLauncher, resolveExecutable } from "../autonomy/index.ts";
import type { CodepunkConfig } from "../config/index.ts";
import type { HeadlessPolicy } from "../config/policy.ts";
import type { MemoryManager } from "../memory/index.ts";
import { sha256Bytes } from "../platform/hash.ts";
import { normalizeAbsolute } from "../platform/path.ts";
import {
  findDeliveryRoot,
  projectPaths,
  resolveCodepunkHome,
  type ProjectPaths,
} from "../platform/paths.ts";
import type { ShellProvider } from "../sandbox/index.ts";
import { SessionStore } from "../session/index.ts";
import { listProjectSessions, resolveSession } from "../session/ops.ts";
import { signRun } from "../verdict/store.ts";
import type { RuntimeOptions, RuntimeSignResult } from "./types.ts";

function executableHash(bytes: Buffer): string {
  return sha256Bytes(bytes);
}

function commandMatches(
  rule: HeadlessPolicy["commands"][number],
  argv: readonly string[],
  cwd: string,
): boolean {
  if (rule.argv.length !== argv.length) {
    return false;
  }
  if (normalizeAbsolute(rule.cwd) !== normalizeAbsolute(cwd)) {
    return false;
  }
  return rule.argv.every((value, index) => value === argv[index]);
}

export async function verifyHeadlessExec(
  policy: HeadlessPolicy,
  argv: readonly string[],
  cwd: string,
): Promise<string | null> {
  const rule = policy.commands.find((candidate) =>
    commandMatches(candidate, argv, cwd),
  );
  if (rule === undefined) {
    return "argv is not approved by the headless policy";
  }
  const resolved = await resolveExecutable(argv[0]!, rule.cwd);
  if (resolved === null) {
    return "approved executable cannot be resolved";
  }
  const executable = normalizeAbsolute(resolved);
  let resolvedExecutable: string;
  try {
    resolvedExecutable = normalizeAbsolute(await fs.realpath(executable));
  } catch {
    return "approved executable cannot be resolved";
  }
  const launcher =
    isShellLauncher([resolvedExecutable]) || isShellLauncher([executable]);
  if (launcher) {
    // An interpreter may run exactly one approved script: the policy pins the
    // whole argv, the interpreter digest above, and the script digest below.
    // Without a pinned script, or with a flag in the script position, a
    // launcher would still interpret whatever it is handed.
    if (rule.script_sha256 === null) {
      return "shell and interpreter launchers are not allowed by headless exec";
    }
    const scriptArg = argv[1];
    if (scriptArg === undefined || scriptArg.startsWith("-")) {
      return "launcher script argument is missing or is a flag";
    }
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(executable);
  } catch {
    return "approved executable cannot be read";
  }
  if (bytes.subarray(0, 2).toString("utf8") === "#!") {
    return "headless exec accepts native executables only";
  }
  if (executableHash(bytes) !== rule.executable_sha256) {
    return "approved executable digest changed";
  }
  if (rule.script_sha256 !== null) {
    const scriptArg = argv[1];
    if (scriptArg === undefined) {
      return "approved script argument is missing";
    }
    const script = normalizeAbsolute(
      path.isAbsolute(scriptArg)
        ? scriptArg
        : path.resolve(rule.cwd, scriptArg),
    );
    let scriptBytes: Buffer;
    try {
      scriptBytes = await fs.readFile(script);
    } catch {
      return "approved script cannot be read";
    }
    if (executableHash(scriptBytes) !== rule.script_sha256) {
      return "approved script digest changed";
    }
  }
  return null;
}

export function effectiveTools(
  config: CodepunkConfig,
  sandbox: ShellProvider | null,
  memory: MemoryManager,
  headless: boolean,
  headlessPolicy: HeadlessPolicy | null = null,
): string[] {
  let requested = new Set(config.tools.enabled);
  if (headless) {
    // A one-shot print run has no interactive work-state lifecycle. Keep the
    // read-only surface small instead of exposing plan/todo writes that the
    // caller cannot observe or continue.
    requested.delete("plan");
    requested.delete("todo");
    requested.delete("ask_user");
    requested.delete("subagent");
    if (headlessPolicy === null) {
      requested.delete("shell");
      requested.delete("bash");
      requested.delete("write");
      requested.delete("edit");
      requested.delete("exec");
      requested.delete("web_search");
    } else {
      const allowed = new Set(
        headlessPolicy.tools.map((tool) => (tool === "shell" ? "exec" : tool)),
      );
      requested = new Set(
        [...requested].filter((tool) =>
          allowed.has(tool === "shell" ? "exec" : tool),
        ),
      );
      if (allowed.has("exec")) {
        requested.add("exec");
      }
      requested.delete("shell");
      requested.delete("bash");
    }
  }
  if (!memory.enabled) {
    requested.delete("memory_search");
  }
  if (sandbox === null) {
    requested.delete("shell");
    requested.delete("bash");
    if (!headless) {
      requested.delete("exec");
    }
  }
  return [...requested].map((name) => (name === "shell" ? "bash" : name));
}

export function sessionSelectorIssue(options: RuntimeOptions): string | null {
  if (options.newSessionId === undefined) {
    return null;
  }
  if (options.sessionId !== undefined || options.sessionPath !== undefined) {
    return "newSessionId cannot be combined with an existing session selector";
  }
  if (options.continueSession === true) {
    return "newSessionId cannot be combined with --continue";
  }
  return null;
}

export async function openSession(
  options: RuntimeOptions,
  paths: ProjectPaths,
  heartbeatMs: number,
  leaseMs: number,
): Promise<SessionStore> {
  const selectorIssue = sessionSelectorIssue(options);
  if (selectorIssue !== null) {
    throw new Error(selectorIssue);
  }
  if (
    options.parentSessionId !== undefined &&
    options.newSession !== true &&
    options.newSessionId === undefined
  ) {
    throw new Error(
      "parentSessionId requires --new-session or --new-session-id",
    );
  }
  if (
    options.parentSessionId !== undefined &&
    (options.sessionId !== undefined ||
      options.sessionPath !== undefined ||
      options.continueSession === true)
  ) {
    throw new Error(
      "parentSessionId cannot be combined with an existing session selector",
    );
  }
  if (options.newSession === true) {
    return SessionStore.create({
      rootDir: paths.home,
      cwd: paths.cwd,
      projectRoot: paths.deliveryRoot,
      projectId: paths.projectId,
      ...(options.newSessionId !== undefined
        ? { sessionId: options.newSessionId }
        : {}),
      ...(options.parentSessionId !== undefined
        ? { parentSessionId: options.parentSessionId }
        : {}),
      heartbeatMs,
      leaseMs,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }
  if (options.sessionId === undefined && options.sessionPath === undefined) {
    if (!options.continueSession) {
      return SessionStore.create({
        rootDir: paths.home,
        cwd: paths.cwd,
        projectRoot: paths.deliveryRoot,
        projectId: paths.projectId,
        ...(options.newSessionId !== undefined
          ? { sessionId: options.newSessionId }
          : {}),
        ...(options.parentSessionId !== undefined
          ? { parentSessionId: options.parentSessionId }
          : {}),
        heartbeatMs,
        leaseMs,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
    }
    const sessions = await listProjectSessions(paths.home, paths.projectId);
    if (sessions.length === 0) {
      return SessionStore.create({
        rootDir: paths.home,
        cwd: paths.cwd,
        projectRoot: paths.deliveryRoot,
        projectId: paths.projectId,
        ...(options.newSessionId !== undefined
          ? { sessionId: options.newSessionId }
          : {}),
        ...(options.parentSessionId !== undefined
          ? { parentSessionId: options.parentSessionId }
          : {}),
        heartbeatMs,
        leaseMs,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
    }
  }
  return resolveSession({
    rootDir: paths.home,
    cwd: paths.cwd,
    projectRoot: paths.deliveryRoot,
    projectId: paths.projectId,
    ...(options.sessionId !== undefined
      ? { sessionId: options.sessionId }
      : {}),
    ...(options.sessionPath !== undefined
      ? { sessionPath: options.sessionPath }
      : {}),
    heartbeatMs,
    leaseMs,
  });
}

export const CONFIG_SECTIONS = [
  "tui",
  "context",
  "model",
  "plugins",
  "tools",
  "approval",
  "autonomy",
  "sandbox",
  "filesystem",
  "session",
  "evidence",
  "budget",
  "memory",
  "telemetry",
] as const satisfies readonly (keyof CodepunkConfig)[];

export function configValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function closePendingSandboxForStartupFailure(startupCleanup: {
  current: (() => Promise<void>) | null;
}): Promise<void> {
  const cleanup = startupCleanup.current;
  startupCleanup.current = null;
  await cleanup?.();
}

export function pathsHome(environment: NodeJS.ProcessEnv | undefined): string {
  return normalizeAbsolute(resolveCodepunkHome(environment ?? process.env));
}

export function latestSignOffId(
  events: readonly SessionEvent[],
  runId: string,
): string | null {
  const signOffs = events.filter(
    (event): event is Extract<SessionEvent, { kind: "verdict/sign_off" }> =>
      event.kind === "verdict/sign_off" && event.data.run_id === runId,
  );
  return signOffs.at(-1)?.data.sign_off_id ?? null;
}

export async function signStandalone(options: {
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  runId: string;
  verdict: "complete" | "incomplete";
  actor?: string;
  tty?: boolean;
  now?: () => Date;
}): Promise<RuntimeSignResult> {
  const project = await findDeliveryRoot(options.cwd);
  const paths = projectPaths(project, pathsHome(options.environment));
  return signRun({
    paths,
    cwd: paths.cwd,
    projectRoot: paths.deliveryRoot,
    runId: options.runId,
    request: {
      version: 1,
      evidence_head: "",
      signed_verdict: options.verdict,
      channel: "cli",
      actor: options.actor ?? "local-user",
      is_tty: options.tty !== false,
      source: "human",
      previous_sign_off_id: null,
    },
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}
