import {
  formatAgentProfiles,
  loadAgentProfiles,
  type CodepunkRuntime,
} from "codepunk-core";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TuiState } from "../state.ts";
import { formatSubagents, updateSubagentStatus } from "./subagent-common.ts";
import {
  discardSubagent,
  reviewSubagent,
  showSubagentTranscript,
  signSubagent,
} from "./subagent-review.ts";
import { mergeSubagent } from "./subagent-merge.ts";

export async function stopRunningSubagents(
  state: TuiState,
  timeoutMs = 5_000,
): Promise<void> {
  const running = [...(state.subagents?.values() ?? [])].filter(
    (record) => record.status === "running",
  );
  if (running.length === 0) {
    return;
  }
  for (const record of running) {
    record.controller.abort();
  }
  let expire = () => {};
  const timer = setTimeout(() => expire(), timeoutMs);
  timer.unref();
  await Promise.race([
    Promise.allSettled(running.map((record) => record.promise)),
    new Promise<void>((resolve) => {
      expire = () => resolve();
    }),
  ]);
  clearTimeout(timer);
}

export async function manageSubagents(
  state: TuiState,
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const [action, childSessionId] = args.split(/\s+/u);
  if (action === undefined || action.length === 0) {
    context.ui.notify(formatSubagents(state), "info");
    return;
  }
  if (action === "profiles") {
    const bundle = await loadAgentProfiles(runtime.paths, {
      projectTrusted: runtime.workspaceTrust.grants.config,
    });
    context.ui.notify(
      [formatAgentProfiles(bundle.profiles), ...bundle.warnings].join("\n"),
      bundle.warnings.length > 0 ? "warning" : "info",
    );
    return;
  }
  if (
    action !== "result" &&
    action !== "transcript" &&
    action !== "wait" &&
    action !== "stop" &&
    action !== "review" &&
    action !== "sign" &&
    action !== "merge" &&
    action !== "discard"
  ) {
    context.ui.notify(
      "usage: /agents [profiles|result|transcript|wait|stop|review|sign|merge|discard] [child-session-id]",
      "warning",
    );
    return;
  }
  if (childSessionId === undefined) {
    context.ui.notify(
      "usage: /agents [profiles|result|transcript|wait|stop|review|sign|merge|discard] [id]",
      "warning",
    );
    return;
  }
  const record = state.subagents?.get(childSessionId);
  if (record === undefined) {
    context.ui.notify(`subagent ${childSessionId} is not registered`, "error");
    return;
  }
  if (action === "review") {
    await reviewSubagent(context, record);
    return;
  }
  if (action === "transcript") {
    await showSubagentTranscript(context, record);
    return;
  }
  if (action === "sign") {
    await signSubagent(runtime, context, record);
    return;
  }
  if (action === "merge") {
    await mergeSubagent(runtime, context, record);
    return;
  }
  if (action === "discard") {
    await discardSubagent(runtime, context, record);
    return;
  }
  if (action === "stop") {
    if (record.status !== "running") {
      context.ui.notify(
        `subagent ${childSessionId} is already ${record.status}`,
        "warning",
      );
      return;
    }
    record.controller.abort();
    updateSubagentStatus(state);
    context.ui.notify(`stopping subagent ${childSessionId}`, "warning");
    return;
  }
  if (action === "wait") {
    context.ui.notify(`waiting for subagent ${childSessionId}`, "info");
    await record.promise;
  }
  if (record.status === "completed" && record.result !== null) {
    const summary =
      record.result.summary.length > 4_000
        ? `${record.result.summary.slice(0, 4_000)}\n[summary truncated]`
        : record.result.summary;
    context.ui.notify(
      [
        `subagent ${childSessionId} completed`,
        `evidence: ${
          record.result.evidence_head ?? "none (the child made no tool calls)"
        }`,
        ...(record.worktree === null
          ? []
          : [
              `worktree: ${record.worktree}`,
              `delivery: ${record.delivery?.state ?? "unreviewed"}`,
              `next: /agents review ${childSessionId}`,
            ]),
        ...(record.transcriptPath === null
          ? []
          : [
              `transcript: ${record.transcriptPath}`,
              `show: /agents transcript ${childSessionId}`,
            ]),
        summary,
      ].join("\n"),
      "info",
    );
    return;
  }
  context.ui.notify(
    `subagent ${childSessionId} is ${record.status}${
      record.error === null ? "" : `: ${record.error}`
    }${record.worktree === null ? "" : `\nworktree: ${record.worktree}`}${
      record.transcriptPath === null
        ? ""
        : `\ntranscript: ${record.transcriptPath}`
    }`,
    record.status === "failed" ? "error" : "warning",
  );
}
