import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, promises as fs, type WriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { finished } from "node:stream/promises";
import { evidenceRecordHash, readEvidenceFile } from "../evidence/index.ts";
import { createTaskSpec } from "../delivery/spec.ts";
import { gitText, statusOutsideCodepunk } from "../delivery/git.ts";
import { createDetachedWorktree } from "../delivery/worktree.ts";
import { ensurePrivateDir } from "../platform/fs.ts";
import { createUlid } from "../platform/hash.ts";
import {
  findDeliveryRoot,
  projectPaths,
  resolveCodepunkHome,
} from "../platform/paths.ts";
import { spawnGuardedHost } from "./sandbox.ts";
import {
  Subagent,
  SubagentError,
  type SubagentPermissionMode,
  type SubagentToolMask,
} from "./subagent.ts";

const READ_ONLY_MASK: SubagentToolMask = {
  read: true,
  write: false,
  edit: false,
  shell: false,
  search: true,
  memory_search: false,
};

const CHILD_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/u;
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export class ChildHostError extends Error {
  readonly code: string;
  readonly worktree: string | null;
  readonly transcript: string | null;

  constructor(
    code: string,
    message: string,
    worktree: string | null = null,
    transcript: string | null = null,
  ) {
    super(message);
    this.name = "ChildHostError";
    this.code = code;
    this.worktree = worktree;
    this.transcript = transcript;
  }
}

export interface ReadOnlySubagentOptions {
  hostArgv: readonly string[];
  cwd: string;
  /**
   * Extra file roots granted to the parent with `--add-dir`. They are only
   * read roots: the child still runs with `--filesystem workspace` and
   * `--autonomy read-only`.
   */
  additionalDirs?: readonly string[];
  parentSessionId: string;
  childSessionId?: string;
  prompt: string;
  model?: string;
  thinking?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Inherit the parent session's explicit trust decision. Both directions
   * matter: `no-trust` must prevent the child from re-reading a saved
   * decision, while `trust` must cover a one-run prompt. Leave this unset
   * when the parent is using a saved decision so the child resolves the same
   * store itself.
   */
  workspaceTrustOverride?: "trust" | "no-trust";
  bare?: boolean;
  noSkills?: boolean;
  budget?: {
    max_tool_calls?: number;
    max_wall_ms?: number;
    max_disk_bytes?: number;
  };
  /**
   * Observe bounded child progress without exposing the child's full event
   * stream. Callback failures are ignored so a UI consumer cannot abort a
   * running child.
   */
  onEvent?: (event: SubagentStreamEvent) => void;
  signal?: AbortSignal;
}

export interface SubagentHostOptions extends ReadOnlySubagentOptions {
  fallbackModels?: readonly string[];
  fallbackAllowCrossProvider?: boolean;
  /**
   * Agent profile declaration. The profile supplies a bounded tool mask, an
   * optional model pool, and system-prompt text. It does not bypass policy.
   */
  profile?: {
    name: string;
    sha256: string;
    tools: SubagentToolMask;
    systemPrompt: string;
    model: string | null;
    fallback: readonly string[];
    thinking: string | null;
  };
  isolation?: "shared" | "worktree";
}

export interface SubagentHostResult {
  parent_session_id: string;
  child_session_id: string;
  depth: number;
  isolation: "worktree" | "shared";
  summary: string;
  evidence_head: string | null;
  model: string | null;
  child_run_id: string | null;
  exit_code: number;
  child_evidence_path: string | null;
  profile: string | null;
  profile_sha256: string | null;
  worktree: string | null;
  base_commit: string | null;
  transcript_path: string | null;
  changed_files: number | null;
}

export type SubagentStreamEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "tool_start"; tool: string }
  | {
      type: "tool_end";
      tool: string;
      is_error: boolean;
      output: string;
    };

/** @deprecated Use SubagentHostResult; the host also supports mutable profiles. */
export type ReadOnlySubagentResult = SubagentHostResult;

interface ChildAssistantMessage {
  role?: unknown;
  content?: unknown;
}

interface ChildJsonEvent {
  type?: unknown;
  message?: ChildAssistantMessage;
  assistantMessageEvent?: {
    type?: unknown;
    delta?: unknown;
  };
  toolName?: unknown;
  isError?: unknown;
  result?: {
    content?: unknown;
  };
}

function emitStreamEvent(
  options: ReadOnlySubagentOptions,
  event: SubagentStreamEvent,
): void {
  try {
    options.onEvent?.(event);
  } catch {
    // Progress rendering is observational. A broken UI callback must not
    // change the child's execution or its evidence.
  }
}

function assistantText(event: ChildJsonEvent): string | null {
  if (event.type !== "message_end" || event.message?.role !== "assistant") {
    return null;
  }
  const content = event.message.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) =>
      part !== null &&
      typeof part === "object" &&
      "text" in part &&
      typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
  return text.length > 0 ? text : null;
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => {
      if (
        part !== null &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .join("");
}

function toolResultText(event: ChildJsonEvent): string {
  const text = contentText(event.result?.content).trim();
  if (text.length > 0) {
    return text;
  }
  if (event.result === undefined) {
    return "";
  }
  try {
    return JSON.stringify(event.result);
  } catch {
    return "";
  }
}

async function createChildTranscript(
  paths: ReturnType<typeof projectPaths>,
  childSessionIdValue: string,
): Promise<{ path: string; stream: WriteStream }> {
  const directory = path.join(
    paths.artifactsDir,
    "subagents",
    childSessionIdValue,
  );
  await ensurePrivateDir(directory);
  const transcriptPath = path.join(directory, "transcript.jsonl");
  const stream = createWriteStream(transcriptPath, {
    flags: "wx",
    mode: 0o600,
  });
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      stream.off("open", onOpen);
      reject(error);
    };
    stream.once("open", onOpen);
    stream.once("error", onError);
  });
  return { path: transcriptPath, stream };
}

function childSessionId(value: string | undefined): string {
  if (value === undefined) {
    return createUlid();
  }
  if (!CHILD_SESSION_ID_RE.test(value)) {
    throw new ChildHostError(
      "subagent.child_session_id",
      "child session id must contain only letters, digits, underscores, or hyphens",
    );
  }
  return value;
}

function enabledTools(mask: SubagentToolMask): string[] {
  const tools: string[] = [];
  if (mask.read) {
    tools.push("read");
  }
  if (mask.search) {
    tools.push("search");
  }
  if (mask.write) {
    tools.push("write");
  }
  if (mask.edit) {
    tools.push("edit");
  }
  if (mask.shell) {
    throw new ChildHostError(
      "subagent.shell_unsupported",
      "subagent profiles cannot enable shell without an exact command allowlist",
    );
  }
  if (tools.length === 0) {
    throw new ChildHostError(
      "subagent.empty_tools",
      "subagent profile enables no tools",
    );
  }
  return tools;
}

async function writeChildPolicy(
  directory: string,
  mask: SubagentToolMask,
): Promise<string> {
  const filePath = path.join(directory, "headless.toml");
  const tools = enabledTools(mask);
  const lines = [
    "version = 1",
    "[allow]",
    `tools = [${tools.map((tool) => JSON.stringify(tool)).join(", ")}]`,
  ];
  if (mask.write || mask.edit) {
    // A write tool without a write set is denied by the policy. Keep the
    // grant relative so the child can only write in its own checkout.
    lines.push('write = ["."]');
  }
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return filePath;
}

function waitForClose(
  child: ChildProcessWithoutNullStreams,
  stderrChunks: Buffer[],
  signal: AbortSignal | undefined,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const onStderr = (chunk: Buffer): void => {
      stderrChunks.push(Buffer.from(chunk));
    };
    const finish = (error: Error | null, code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      signal?.removeEventListener("abort", abort);
      child.stderr.off("data", onStderr);
      if (error !== null) {
        reject(error);
      } else {
        resolve(code ?? 1);
      }
    };
    const abort = () => {
      if (aborted) {
        return;
      }
      aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    };
    child.stderr.on("data", onStderr);
    child.on("error", (error) => finish(error, null));
    child.on("close", (code) => {
      if (aborted) {
        finish(
          new ChildHostError("subagent.stopped", "subagent child was stopped"),
          null,
        );
        return;
      }
      finish(null, code);
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) {
      abort();
    }
  });
}

async function readChildEvidence(
  paths: ReturnType<typeof projectPaths>,
  childSessionIdValue: string,
  sawToolExecution: boolean,
): Promise<{
  evidenceHead: string | null;
  runId: string | null;
  evidencePath: string | null;
}> {
  const sessionDir = path.join(paths.evidenceDir, childSessionIdValue);
  let files: string[];
  try {
    files = await fs.readdir(sessionDir);
  } catch (error) {
    if (
      !sawToolExecution &&
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { evidenceHead: null, runId: null, evidencePath: null };
    }
    throw new ChildHostError(
      "subagent.evidence_missing",
      `child evidence directory is missing: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const evidenceFiles = files.filter(
    (file) => file.endsWith(".jsonl") && file !== "index.jsonl",
  );
  if (evidenceFiles.length === 0) {
    if (!sawToolExecution) {
      return { evidenceHead: null, runId: null, evidencePath: null };
    }
    throw new ChildHostError(
      "subagent.evidence_missing",
      "child session produced no evidence run",
    );
  }
  const evidencePath = path.join(sessionDir, evidenceFiles.sort().at(-1)!);
  const evidence = await readEvidenceFile(evidencePath);
  if (evidence.records.length === 0) {
    if (!sawToolExecution) {
      return { evidenceHead: null, runId: null, evidencePath: null };
    }
    throw new ChildHostError(
      "subagent.evidence_missing",
      "child evidence run is empty",
    );
  }
  const last = evidence.records.at(-1)!;
  return {
    evidenceHead: evidenceRecordHash(last),
    runId: last.run_id,
    evidencePath,
  };
}

async function assertChildSessionUnused(
  paths: ReturnType<typeof projectPaths>,
  childSessionIdValue: string,
): Promise<void> {
  const sessionLog = path.join(
    paths.sessionsDir,
    childSessionIdValue,
    "session.jsonl",
  );
  try {
    await fs.access(sessionLog);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  throw new ChildHostError(
    "subagent.child_session_exists",
    `child session ${childSessionIdValue} already exists`,
  );
}

function hasMutatingTools(mask: SubagentToolMask): boolean {
  return mask.write || mask.edit || mask.shell;
}

function childWorktreeId(childSessionIdValue: string): string {
  return `subagent-${createHash("sha256")
    .update(childSessionIdValue)
    .digest("hex")
    .slice(0, 24)}`;
}

async function runChild(
  options: SubagentHostOptions,
  childSessionIdValue: string,
  signal: AbortSignal | undefined,
): Promise<{
  summary: string;
  evidence_head: string | null;
  child_run_id: string | null;
  exit_code: number;
  child_evidence_path: string | null;
  worktree: string | null;
  base_commit: string | null;
  transcript_path: string | null;
  changed_files: number | null;
}> {
  if (options.hostArgv.length === 0) {
    throw new ChildHostError(
      "subagent.host",
      "subagent requires the child host argv",
    );
  }
  const environment = options.env ?? process.env;
  const codepunkHome = resolveCodepunkHome(environment);
  const parentProject = await findDeliveryRoot(options.cwd);
  if (!parentProject.isGitRepository) {
    throw new ChildHostError(
      "subagent.not_git",
      "subagents require a git repository",
    );
  }
  let baseCommit: string;
  try {
    baseCommit = (
      await gitText(options.cwd, ["rev-parse", "--verify", "HEAD^{commit}"])
    ).trim();
  } catch (error) {
    throw new ChildHostError(
      "subagent.not_git",
      `subagents require a git repository with a commit: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const toolMask = options.profile?.tools ?? READ_ONLY_MASK;
  const permissionMode: SubagentPermissionMode = hasMutatingTools(toolMask)
    ? "ask"
    : "read-only";
  const isolation =
    options.isolation ??
    (options.profile !== undefined && hasMutatingTools(toolMask)
      ? "worktree"
      : "shared");
  if (isolation === "shared" && hasMutatingTools(toolMask)) {
    throw new ChildHostError(
      "subagent.shared_mutation",
      "a mutating subagent profile requires a detached worktree",
    );
  }
  let worktree = options.cwd;
  let worktreePath: string | null = null;
  if (isolation === "worktree") {
    const created = await createDetachedWorktree({
      deliveryRoot: parentProject.deliveryRoot,
      projectId: parentProject.projectId,
      workerId: childWorktreeId(childSessionIdValue),
      baseCommit,
    });
    worktree = created.path;
    worktreePath = created.path;
  }
  const childProject = await findDeliveryRoot(worktree);
  const paths = projectPaths(
    childProject,
    codepunkHome,
    options.additionalDirs ?? [],
  );
  await assertChildSessionUnused(paths, childSessionIdValue);
  const taskBudget =
    options.budget === undefined
      ? undefined
      : {
          maxWallMs: options.budget.max_wall_ms ?? 30 * 60 * 1_000,
          maxToolCalls: options.budget.max_tool_calls ?? 200,
          maxDiskBytes: options.budget.max_disk_bytes ?? 256 * 1024 * 1024,
        };
  const task = createTaskSpec({
    taskId: `subagent-${childSessionIdValue}`,
    title: options.profile?.name ?? "Subagent",
    objective: options.prompt,
    baseCommit,
    writeSet: ["."],
    acceptance: ["summary and evidence head"],
    isolation,
    ...(taskBudget !== undefined ? { budget: taskBudget } : {}),
  });
  const model = options.model ?? options.profile?.model ?? undefined;
  const fallback =
    options.fallbackModels ?? options.profile?.fallback ?? undefined;
  const thinking = options.thinking ?? options.profile?.thinking ?? undefined;
  const captured: {
    value: {
      child_run_id: string | null;
      exit_code: number;
      child_evidence_path: string | null;
      evidence_head: string | null;
      transcript_path: string | null;
      changed_files: number | null;
    } | null;
  } = { value: null };
  let transcriptPathForError: string | null = null;
  const subagent = new Subagent({
    parent_session_id: options.parentSessionId,
    child_session_id: childSessionIdValue,
    task,
    isolation,
    tool_mask: toolMask,
    permission_mode: permissionMode,
    depth: 0,
    worktree,
    parent_worktree: options.cwd,
    ...(isolation === "worktree"
      ? { parent_root: parentProject.deliveryRoot }
      : {}),
    write_set: ["."],
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
    async run(context) {
      const temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "codepunk-subagent-"),
      );
      try {
        const policyPath = await writeChildPolicy(temporaryRoot, toolMask);
        const token = randomBytes(16).toString("hex");
        const argv = [
          ...options.hostArgv,
          "--guarded-host-launch",
          "--mode",
          "json",
          "--new-session-id",
          childSessionIdValue,
          "--parent-session-id",
          options.parentSessionId,
          "--headless-policy",
          policyPath,
          "--approval",
          permissionMode === "read-only" ? "deny" : "allow",
          "--sandbox",
          "required",
          "--filesystem",
          "workspace",
          "--autonomy",
          permissionMode === "read-only" ? "read-only" : "ask",
          "--tools",
          enabledTools(toolMask).join(","),
          "--memory",
          "false",
          "--no-mcp",
          "--no-plugins",
          ...(options.additionalDirs ?? []).flatMap((directory) => [
            "--add-dir",
            directory,
          ]),
          ...(options.bare === true ? ["--bare"] : []),
          ...(options.noSkills === true ? ["--no-skills"] : []),
          ...(options.workspaceTrustOverride === "trust" ? ["--trust"] : []),
          ...(options.workspaceTrustOverride === "no-trust"
            ? ["--no-trust"]
            : []),
          ...(model !== undefined ? ["--model", model] : []),
          ...(thinking !== undefined ? ["--thinking", thinking] : []),
          ...(fallback !== undefined && fallback.length > 0
            ? ["--model-fallback", fallback.join(",")]
            : []),
          ...(options.fallbackAllowCrossProvider === true ||
          (fallback !== undefined && fallback.length > 0)
            ? ["--fallback-allow-cross-provider"]
            : []),
          ...(options.profile?.systemPrompt !== undefined
            ? ["--append-system-prompt", options.profile.systemPrompt]
            : []),
          "-p",
        ];
        const transcript = await createChildTranscript(
          paths,
          childSessionIdValue,
        );
        transcriptPathForError = transcript.path;
        let transcriptError: Error | null = null;
        transcript.stream.on("error", (error: Error) => {
          transcriptError = error;
        });
        let child: ChildProcessWithoutNullStreams;
        try {
          child = spawnGuardedHost({
            argv,
            cwd: worktree,
            token,
            stdin: options.prompt,
            env: {
              ...environment,
              CODEPUNK_HOME: paths.home,
              CODEPUNK_DEPTH: "1",
              NO_COLOR: "1",
            },
          });
        } catch (error) {
          transcript.stream.destroy();
          throw error;
        }
        child.stdout.pipe(transcript.stream);
        const closeTranscript = async (): Promise<void> => {
          if (
            !transcript.stream.destroyed &&
            !transcript.stream.writableEnded
          ) {
            child.stdout.unpipe(transcript.stream);
            transcript.stream.end();
          }
          await finished(transcript.stream).catch(() => undefined);
        };
        // The wall-clock and tool-call budgets abort the Subagent controller,
        // not the caller's signal. Kill the child process for either.
        const stop = context.signal;
        const childSignal =
          signal === undefined ? stop : AbortSignal.any([signal, stop]);
        const stderrChunks: Buffer[] = [];
        let summary: string | null = null;
        let sawToolExecution = false;
        let budgetFailure: Error | null = null;
        const lineReader = readline.createInterface({
          input: child.stdout,
          crlfDelay: Number.POSITIVE_INFINITY,
        });
        const linesDone = new Promise<void>((resolve) => {
          lineReader.once("close", resolve);
        });
        lineReader.on("line", (line) => {
          if (line.trim().length === 0) {
            return;
          }
          let event: ChildJsonEvent;
          try {
            event = JSON.parse(line) as ChildJsonEvent;
          } catch {
            stderrChunks.push(
              Buffer.from(`child emitted non-JSON output: ${line}\n`),
            );
            return;
          }
          const text = assistantText(event);
          if (text !== null) {
            summary = text;
          }
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent?.type === "text_delta" &&
            typeof event.assistantMessageEvent.delta === "string" &&
            event.assistantMessageEvent.delta.length > 0
          ) {
            emitStreamEvent(options, {
              type: "assistant_delta",
              text: event.assistantMessageEvent.delta,
            });
          }
          if (event.type === "tool_execution_start") {
            sawToolExecution = true;
            emitStreamEvent(options, {
              type: "tool_start",
              tool:
                typeof event.toolName === "string" ? event.toolName : "tool",
            });
            try {
              context.consumeToolCall();
            } catch (error) {
              budgetFailure =
                error instanceof Error ? error : new Error(String(error));
              child.kill("SIGTERM");
            }
          }
          if (event.type === "tool_execution_end") {
            emitStreamEvent(options, {
              type: "tool_end",
              tool:
                typeof event.toolName === "string" ? event.toolName : "tool",
              is_error: event.isError === true,
              output: toolResultText(event).slice(0, 2_000),
            });
          }
        });
        let exitCode: number;
        try {
          exitCode = await waitForClose(child, stderrChunks, childSignal);
        } catch (error) {
          lineReader.close();
          await linesDone;
          await closeTranscript();
          throw error;
        }
        lineReader.close();
        await linesDone;
        await closeTranscript();
        if (budgetFailure !== null) {
          throw budgetFailure;
        }
        if (exitCode !== 0) {
          throw new ChildHostError(
            "subagent.child_failed",
            `child host exited ${exitCode}: ${Buffer.concat(stderrChunks)
              .toString("utf8")
              .trim()}`,
          );
        }
        if (summary === null) {
          throw new ChildHostError(
            "subagent.child_output",
            "child host completed without a final assistant message",
          );
        }
        const evidence = await readChildEvidence(
          paths,
          childSessionIdValue,
          sawToolExecution,
        );
        let changedFiles: number | null = isolation === "shared" ? 0 : null;
        if (worktreePath !== null) {
          try {
            const status = await gitText(worktreePath, [
              "status",
              "--porcelain=v1",
              "--untracked-files=all",
            ]);
            changedFiles = statusOutsideCodepunk(status)
              .split("\n")
              .filter((line) => line.trim().length > 0).length;
          } catch {
            changedFiles = null;
          }
        }
        captured.value = {
          child_run_id: evidence.runId,
          exit_code: exitCode,
          child_evidence_path: evidence.evidencePath,
          evidence_head: evidence.evidenceHead,
          transcript_path: transcriptError === null ? transcript.path : null,
          changed_files: changedFiles,
        };
        return {
          summary,
          evidence_head: evidence.evidenceHead ?? "",
          child_run_id: evidence.runId,
          exit_code: exitCode,
          child_evidence_path: evidence.evidencePath,
          worktree: worktreePath,
          base_commit: worktreePath === null ? null : baseCommit,
          transcript_path: transcriptError === null ? transcript.path : null,
          changed_files: changedFiles,
        };
      } finally {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  });
  let result;
  try {
    result = await subagent.run();
  } catch (error) {
    if (worktreePath !== null || transcriptPathForError !== null) {
      const code =
        error instanceof ChildHostError || error instanceof SubagentError
          ? error.code
          : "subagent.failed";
      const location = [
        ...(worktreePath === null ? [] : [`worktree: ${worktreePath}`]),
        ...(transcriptPathForError === null
          ? []
          : [`transcript: ${transcriptPathForError}`]),
      ].join("; ");
      throw new ChildHostError(
        code,
        `${error instanceof Error ? error.message : String(error)}; ${location}`,
        worktreePath,
        transcriptPathForError,
      );
    }
    throw error;
  }
  if (captured.value === null) {
    throw new ChildHostError(
      "subagent.child_output",
      "child host did not report execution metadata",
    );
  }
  return {
    summary: result.summary,
    evidence_head: captured.value.evidence_head,
    child_run_id: captured.value.child_run_id,
    exit_code: captured.value.exit_code,
    child_evidence_path: captured.value.child_evidence_path,
    worktree: worktreePath,
    base_commit: worktreePath === null ? null : baseCommit,
    transcript_path: captured.value.transcript_path,
    changed_files: captured.value.changed_files,
  };
}

export async function runSubagentHost(
  options: SubagentHostOptions,
): Promise<SubagentHostResult> {
  const childSessionIdValue = childSessionId(options.childSessionId);
  enabledTools(options.profile?.tools ?? READ_ONLY_MASK);
  if (
    options.profile !== undefined &&
    (!PROFILE_NAME_RE.test(options.profile.name) ||
      !/^sha256:[0-9a-f]{64}$/u.test(options.profile.sha256))
  ) {
    throw new ChildHostError(
      "subagent.profile",
      "subagent profile needs a lowercase name and sha256 digest",
    );
  }
  const isolation =
    options.isolation ??
    (options.profile !== undefined && hasMutatingTools(options.profile.tools)
      ? "worktree"
      : "shared");
  const result = await runChild(options, childSessionIdValue, options.signal);
  return {
    parent_session_id: options.parentSessionId,
    child_session_id: childSessionIdValue,
    depth: 1,
    isolation,
    summary: result.summary,
    evidence_head: result.evidence_head,
    model: options.model ?? options.profile?.model ?? null,
    child_run_id: result.child_run_id,
    exit_code: result.exit_code,
    child_evidence_path: result.child_evidence_path,
    profile: options.profile?.name ?? null,
    profile_sha256: options.profile?.sha256 ?? null,
    worktree: result.worktree,
    base_commit: result.base_commit,
    transcript_path: result.transcript_path,
    changed_files: result.changed_files,
  };
}

export async function runReadOnlySubagent(
  options: ReadOnlySubagentOptions,
): Promise<SubagentHostResult> {
  return runSubagentHost({ ...options, isolation: "shared" });
}
