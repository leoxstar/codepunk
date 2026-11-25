import {
  createUlid,
  runReadOnlySubagent,
  type SubagentToolExecutor,
} from "codepunk-core";
import { physicalModel } from "../chrome/model.ts";
import type { TuiState } from "../state.ts";

/**
 * Bind the LLM-callable read-only `subagent` tool to Codepunk's guarded
 * depth-1 child host so the parent model can delegate exploration safely.
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
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      sessionId: result.child_session_id,
      status: result.exit_code === 0 ? "completed" : "failed",
      summary: result.summary,
      evidenceRef: result.evidence_head ?? result.child_evidence_path,
      exitCode: result.exit_code,
    };
  };
}
