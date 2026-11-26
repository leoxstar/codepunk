import {
  createUlid,
  runReadOnlySubagent,
  type SubagentToolExecutor,
} from "codepunk-core";
import { physicalModel } from "../chrome/model.ts";
import {
  observeSubagentEvent,
  updateSubagentStatus,
} from "./subagent-common.ts";
import type { BackgroundSubagent, TuiState } from "../state.ts";

/**
 * Bind the LLM-callable read-only `subagent` tool to Codepunk's guarded
 * depth-1 child host so the parent model can delegate exploration safely
 * while showing live progress inside the subagent widget and `/tasks`.
 */
export function createTuiSubagentExecutor(
  state: TuiState,
): SubagentToolExecutor {
  return async (request, signal) => {
    const runtime = state.runtime;
    if (runtime === null) {
      throw new Error("codepunk runtime is not ready");
    }
    if (state.childHostArgv.length === 0) {
      throw new Error("subagent host is not available in this invocation");
    }
    const childSessionId = createUlid();
    const model = physicalModel(runtime);
    const modelRef =
      model === undefined ? undefined : `${model.provider}/${model.id}`;
    const prompt =
      request.role !== undefined
        ? `[Role: ${request.role}]\n${request.task}`
        : request.task;
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener("abort", onParentAbort, { once: true });
      }
    }
    const subagents = (state.subagents ??= new Map());
    let resolveDone!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const record: BackgroundSubagent = {
      childSessionId,
      prompt: request.task,
      profile: request.role ?? "tool:read-only",
      isolation: "shared",
      startedAt: Date.now(),
      status: "running",
      result: null,
      error: null,
      worktree: null,
      transcriptPath: null,
      streamTail: "",
      lastTool: null,
      lastStreamUpdate: 0,
      delivery: null,
      controller,
      promise: donePromise,
    };
    subagents.set(childSessionId, record);
    updateSubagentStatus(state);
    try {
      const result = await runReadOnlySubagent({
        hostArgv: state.childHostArgv,
        cwd: runtime.paths.cwd,
        additionalDirs: runtime.paths.additionalRoots,
        parentSessionId: runtime.session.sessionId,
        childSessionId,
        prompt,
        parentPolicy: {
          approval: runtime.config.approval.mode,
          autonomy: runtime.autonomy.profile,
          tools: runtime.config.tools.enabled,
          permission: "read-only",
          networkAllow: runtime.config.sandbox.network_allow,
          networkDeny: runtime.config.sandbox.network_deny,
        },
        ...(modelRef === undefined ? {} : { model: modelRef }),
        thinking: runtime.host.session.thinkingLevel,
        ...(runtime.workspaceTrust.source === "saved" ||
        runtime.workspaceTrust.source === "no-resources"
          ? {}
          : { workspaceTrustOverride: runtime.workspaceTrust.grants }),
        signal: controller.signal,
        onEvent: (event) => {
          observeSubagentEvent(state, record, event);
        },
      });
      record.result = result;
      record.status = controller.signal.aborted
        ? "stopped"
        : result.exit_code === 0
          ? "completed"
          : "failed";
      record.transcriptPath = result.transcript_path;
      return {
        sessionId: result.child_session_id,
        status: record.status,
        summary: result.summary,
        evidenceRef: result.evidence_head ?? result.child_evidence_path,
        exitCode: result.exit_code,
      };
    } catch (error) {
      record.status = controller.signal.aborted ? "stopped" : "failed";
      record.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      signal?.removeEventListener("abort", onParentAbort);
      resolveDone();
      updateSubagentStatus(state);
    }
  };
}
