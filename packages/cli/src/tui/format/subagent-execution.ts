import {
  ChildHostError,
  type AgentProfile,
  type SubagentHostOptions,
  runSubagentHost,
  type CodepunkRuntime,
  type SubagentParentPolicy,
  type WorkspaceTrustGrants,
} from "codepunk-core";
import type { BackgroundSubagent, TuiState } from "../state.ts";
import {
  observeSubagentEvent,
  type SubagentInvocation,
  updateSubagentStatus,
} from "./subagent-common.ts";

export interface SubagentExecutionContext {
  invocation: SubagentInvocation;
  profile: AgentProfile | undefined;
  parentPolicy: SubagentParentPolicy;
  isolation: "shared" | "worktree";
  primaryModel: string | undefined;
  fallbackModels: string[] | undefined;
  thinking: string;
  parentSessionId: string;
  workspaceTrustOverride:
    "trust" | "no-trust" | WorkspaceTrustGrants | undefined;
}

function subagentHostOptions(
  execution: SubagentExecutionContext,
  state: TuiState,
  runtime: CodepunkRuntime,
  record: BackgroundSubagent,
): SubagentHostOptions {
  const {
    invocation,
    profile,
    parentPolicy,
    isolation,
    primaryModel,
    fallbackModels,
    thinking,
    parentSessionId,
    workspaceTrustOverride,
  } = execution;
  return {
    hostArgv: state.childHostArgv,
    cwd: runtime.paths.cwd,
    parentPolicy,
    ...(runtime.paths.additionalRoots.length === 0
      ? {}
      : { additionalDirs: runtime.paths.additionalRoots }),
    parentSessionId,
    childSessionId: record.childSessionId,
    prompt: invocation.task,
    isolation,
    ...(profile === undefined
      ? {}
      : {
          profile: {
            name: profile.name,
            sha256: profile.sha256,
            tools: profile.tools,
            permission: profile.permission,
            shellAllow: profile.shellAllow,
            networkAllow: profile.networkAllow,
            networkDeny: profile.networkDeny,
            systemPrompt: profile.systemPrompt,
            model: profile.model,
            fallback: profile.fallback,
            thinking: profile.thinking,
          },
        }),
    ...(workspaceTrustOverride === undefined ? {} : { workspaceTrustOverride }),
    ...(primaryModel !== undefined ? { model: primaryModel } : {}),
    ...(fallbackModels !== undefined
      ? {
          fallbackModels,
          fallbackAllowCrossProvider: true,
        }
      : {}),
    thinking,
    bare: runtime.isolation.bare,
    noSkills: runtime.isolation.skills,
    onEvent: (event) => observeSubagentEvent(state, record, event),
    signal: record.controller.signal,
  };
}

function subagentEventData(
  record: BackgroundSubagent,
  profile: AgentProfile | undefined,
  isolation: "shared" | "worktree",
  primaryModel: string | undefined,
  parentSessionId: string,
  parentRunId: string,
  failureWorktree: string | null,
) {
  return {
    run_id: parentRunId,
    parent_session_id: parentSessionId,
    child_session_id: record.childSessionId,
    depth: 1,
    isolation: record.result?.isolation ?? isolation,
    model: record.result?.model ?? primaryModel ?? null,
    status: record.status,
    summary: record.result?.summary ?? "",
    evidence_head: record.result?.evidence_head ?? null,
    child_run_id: record.result?.child_run_id ?? null,
    exit_code: record.result?.exit_code ?? null,
    error: record.error,
    profile: record.result?.profile ?? profile?.name ?? null,
    profile_sha256: record.result?.profile_sha256 ?? profile?.sha256 ?? null,
    worktree: record.result?.worktree ?? failureWorktree,
    base_commit: record.result?.base_commit ?? null,
    transcript_path: record.transcriptPath ?? null,
    changed_files: record.result?.changed_files ?? null,
  };
}

function subagentCompletionNotification(record: BackgroundSubagent): string {
  return [
    `subagent ${record.childSessionId} completed; use /agents result ${record.childSessionId}`,
    ...(record.result?.worktree === null ||
    record.result?.worktree === undefined
      ? []
      : [
          `worktree: ${record.result.worktree}`,
          `next: /agents review ${record.childSessionId} → /agents sign ${record.childSessionId} → /agents merge ${record.childSessionId}`,
          `discard: /agents discard ${record.childSessionId}`,
        ]),
    ...(record.result?.transcript_path === null ||
    record.result?.transcript_path === undefined
      ? []
      : [`transcript: ${record.result.transcript_path}`]),
  ].join("\n");
}

function subagentFailureNotification(
  record: BackgroundSubagent,
  failureWorktree: string | null,
): string {
  const worktreeNotice =
    failureWorktree === null || record.error?.includes(failureWorktree)
      ? ""
      : `\nworktree: ${failureWorktree}`;
  return `subagent ${record.childSessionId} ${record.status}${
    record.error === null ? "" : `: ${record.error}`
  }${worktreeNotice}${
    record.transcriptPath === null
      ? ""
      : `\ntranscript: ${record.transcriptPath}`
  }`;
}

export async function runSubagentPromise(
  state: TuiState,
  runtime: CodepunkRuntime,
  record: BackgroundSubagent,
  execution: SubagentExecutionContext,
  parentRunId: string,
): Promise<void> {
  let failureWorktree: string | null = null;
  try {
    record.result = await runSubagentHost(
      subagentHostOptions(execution, state, runtime, record),
    );
    record.status = "completed";
    record.worktree = record.result?.worktree ?? null;
    record.transcriptPath = record.result?.transcript_path ?? null;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    if (error instanceof ChildHostError && error.worktree !== null) {
      failureWorktree = error.worktree;
    }
    record.worktree = failureWorktree;
    if (error instanceof ChildHostError && error.transcript !== null) {
      record.transcriptPath = error.transcript;
    }
    const stopped =
      error instanceof ChildHostError && error.code === "subagent.stopped";
    record.status = stopped ? "stopped" : "failed";
  }
  try {
    await runtime.host.recordEvent(
      "subagent/result",
      subagentEventData(
        record,
        execution.profile,
        execution.isolation,
        execution.primaryModel,
        execution.parentSessionId,
        parentRunId,
        failureWorktree,
      ),
    );
  } catch (error) {
    state.context?.ui.notify(
      `subagent result could not be recorded: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
  updateSubagentStatus(state);
  if (record.status === "completed") {
    state.context?.ui.notify(subagentCompletionNotification(record), "info");
  } else {
    state.context?.ui.notify(
      subagentFailureNotification(record, failureWorktree),
      record.status === "stopped" ? "warning" : "error",
    );
  }
}
