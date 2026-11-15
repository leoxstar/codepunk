import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { evidenceRecordHash, readEvidenceFile } from "../evidence/index.ts";
import { createTaskSpec } from "../delivery/spec.ts";
import { gitText } from "../delivery/git.ts";
import { createUlid } from "../platform/hash.ts";
import {
  findDeliveryRoot,
  projectPaths,
  resolveCodepunkHome,
} from "../platform/paths.ts";
import { spawnGuardedHost } from "./sandbox.ts";
import { Subagent, type SubagentToolMask } from "./subagent.ts";

const READ_ONLY_MASK: SubagentToolMask = {
  read: true,
  write: false,
  edit: false,
  shell: false,
  search: true,
  memory_search: false,
};

const CHILD_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/u;

export class ChildHostError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ChildHostError";
    this.code = code;
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
  noPlugins?: boolean;
  noMcp?: boolean;
  budget?: {
    max_tool_calls?: number;
    max_wall_ms?: number;
    max_disk_bytes?: number;
  };
  signal?: AbortSignal;
}

export interface ReadOnlySubagentResult {
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
}

interface ChildAssistantMessage {
  role?: unknown;
  content?: unknown;
}

interface ChildJsonEvent {
  type?: unknown;
  message?: ChildAssistantMessage;
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

async function writeReadOnlyPolicy(directory: string): Promise<string> {
  const filePath = path.join(directory, "headless.toml");
  await fs.writeFile(
    filePath,
    ["version = 1", "[allow]", 'tools = ["read", "search"]', ""].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
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
  codepunkHome: string,
  cwd: string,
  childSessionIdValue: string,
  sawToolExecution: boolean,
): Promise<{
  evidenceHead: string | null;
  runId: string | null;
  evidencePath: string | null;
}> {
  const project = await findDeliveryRoot(cwd);
  const paths = projectPaths(project, codepunkHome);
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

async function runChild(
  options: ReadOnlySubagentOptions,
  childSessionIdValue: string,
  signal: AbortSignal | undefined,
): Promise<{
  summary: string;
  evidence_head: string | null;
  child_run_id: string | null;
  exit_code: number;
  child_evidence_path: string | null;
}> {
  if (options.hostArgv.length === 0) {
    throw new ChildHostError(
      "subagent.host",
      "read-only subagent requires the child host argv",
    );
  }
  const environment = options.env ?? process.env;
  const codepunkHome = resolveCodepunkHome(environment);
  const project = await findDeliveryRoot(options.cwd);
  const paths = projectPaths(project, codepunkHome);
  await assertChildSessionUnused(paths, childSessionIdValue);
  if (!project.isGitRepository) {
    throw new ChildHostError(
      "subagent.not_git",
      "read-only subagents require a git repository",
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
      `read-only subagents require a git repository with a commit: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
    title: "Read-only subagent",
    objective: options.prompt,
    baseCommit,
    writeSet: ["."],
    acceptance: ["summary and evidence head"],
    isolation: "shared",
    ...(taskBudget !== undefined ? { budget: taskBudget } : {}),
  });
  const captured: {
    value: {
      child_run_id: string | null;
      exit_code: number;
      child_evidence_path: string | null;
      evidence_head: string | null;
    } | null;
  } = { value: null };
  const subagent = new Subagent({
    parent_session_id: options.parentSessionId,
    child_session_id: childSessionIdValue,
    task,
    isolation: "shared",
    tool_mask: READ_ONLY_MASK,
    permission_mode: "read-only",
    depth: 0,
    worktree: options.cwd,
    parent_worktree: options.cwd,
    write_set: ["."],
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
    async run(context) {
      const temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "codepunk-subagent-"),
      );
      try {
        const policyPath = await writeReadOnlyPolicy(temporaryRoot);
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
          "deny",
          // A read-only child must not inherit a wider persisted posture.
          // Without these, a parent started with full-access or an uncovered
          // sandbox would hand the child the same filesystem reach while the
          // child record still says "read-only".
          "--sandbox",
          "required",
          "--filesystem",
          "workspace",
          "--autonomy",
          "read-only",
          ...(options.additionalDirs ?? []).flatMap((directory) => [
            "--add-dir",
            directory,
          ]),
          ...(options.bare === true ? ["--bare"] : []),
          ...(options.noSkills === true ? ["--no-skills"] : []),
          ...(options.noPlugins === true ? ["--no-plugins"] : []),
          ...(options.noMcp === true ? ["--no-mcp"] : []),
          ...(options.workspaceTrustOverride === "trust" ? ["--trust"] : []),
          ...(options.workspaceTrustOverride === "no-trust"
            ? ["--no-trust"]
            : []),
          ...(options.model !== undefined ? ["--model", options.model] : []),
          ...(options.thinking !== undefined
            ? ["--thinking", options.thinking]
            : []),
          "-p",
        ];
        const child = spawnGuardedHost({
          argv,
          cwd: options.cwd,
          token,
          stdin: options.prompt,
          env: {
            ...environment,
            CODEPUNK_HOME: paths.home,
            CODEPUNK_DEPTH: "1",
            NO_COLOR: "1",
          },
        });
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
          if (event.type === "tool_execution_start") {
            sawToolExecution = true;
            try {
              context.consumeToolCall();
            } catch (error) {
              budgetFailure =
                error instanceof Error ? error : new Error(String(error));
              child.kill("SIGTERM");
            }
          }
        });
        let exitCode: number;
        try {
          exitCode = await waitForClose(child, stderrChunks, childSignal);
        } catch (error) {
          lineReader.close();
          await linesDone;
          throw error;
        }
        lineReader.close();
        await linesDone;
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
          paths.home,
          options.cwd,
          childSessionIdValue,
          sawToolExecution,
        );
        captured.value = {
          child_run_id: evidence.runId,
          exit_code: exitCode,
          child_evidence_path: evidence.evidencePath,
          evidence_head: evidence.evidenceHead,
        };
        return {
          summary,
          evidence_head: evidence.evidenceHead ?? "",
          child_run_id: evidence.runId,
          exit_code: exitCode,
          child_evidence_path: evidence.evidencePath,
        };
      } finally {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  });
  const result = await subagent.run();
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
  };
}

export async function runReadOnlySubagent(
  options: ReadOnlySubagentOptions,
): Promise<ReadOnlySubagentResult> {
  const childSessionIdValue = childSessionId(options.childSessionId);
  const result = await runChild(options, childSessionIdValue, options.signal);
  return {
    parent_session_id: options.parentSessionId,
    child_session_id: childSessionIdValue,
    depth: 1,
    isolation: "shared",
    summary: result.summary,
    evidence_head: result.evidence_head,
    model: options.model ?? null,
    child_run_id: result.child_run_id,
    exit_code: result.exit_code,
    child_evidence_path: result.child_evidence_path,
  };
}
