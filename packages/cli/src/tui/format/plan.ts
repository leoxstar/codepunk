import {
  formatHookStatus,
  planContentHash,
  redactOutputPreview,
} from "codepunk-core";
import type { PlanModeState, WorkState, CodepunkRuntime } from "codepunk-core";
import type {
  GoalState,
  SessionEvent,
  StructuredReview,
} from "codepunk-protocol";

export function formatPlanModeStatus(
  state: PlanModeState | null,
  plan: WorkState | null,
): string {
  const planHash = planContentHash(plan);
  const approvedHash = state?.plan_sha256 ?? null;
  const lines = [`Plan mode: ${state?.mode ?? "off"}`];
  lines.push(
    planHash === null
      ? "No plan is recorded."
      : `Plan is recorded: ${planHash}`,
  );
  if (state?.mode === "executing") {
    lines.push(
      approvedHash === null
        ? "No plan hash is bound."
        : planHash === approvedHash
          ? "The recorded plan matches the approved hash."
          : "The recorded plan does not match the approved hash.",
    );
  }
  return lines.join("\n");
}

export function formatGoalStatus(goal: GoalState | null): string {
  if (goal === null) {
    return "No goal is active. Use /goal <objective> to create one.";
  }
  return [
    `Goal: ${goal.status}`,
    `id: ${goal.goal_id}`,
    `revision: ${goal.revision}`,
    `created: ${goal.created_at}`,
    `updated: ${goal.updated_at}`,
    "objective:",
    goal.objective,
  ].join("\n");
}

export function hookStatus(events: readonly SessionEvent[]): string {
  const records = events
    .filter(
      (event): event is Extract<SessionEvent, { kind: "hook/result" }> =>
        event.kind === "hook/result",
    )
    .slice(-20);
  if (records.length === 0) {
    return "No lifecycle hook evidence in this session.";
  }
  return [
    `Lifecycle hooks (${records.length} recent result${records.length === 1 ? "" : "s"})`,
    ...records.map((event) => formatHookStatus(event.data)),
  ].join("\n");
}

export function formatStructuredReview(review: StructuredReview): string {
  const lines = [
    `Structured review ${review.review_id}`,
    `diff: ${review.diff_sha256}`,
    `files: ${review.changed_paths.length}`,
  ];
  if (review.findings.length === 0) {
    lines.push("findings: none");
  } else {
    lines.push(`findings (${review.findings.length}):`);
    for (const finding of review.findings) {
      lines.push(
        `  ${finding.severity.toUpperCase()} ${finding.file}:${finding.line}`,
        `    ${finding.reason}`,
      );
    }
  }
  lines.push("No changes were applied.");
  return lines.join("\n");
}

export async function recordReviewFailure(
  runtime: CodepunkRuntime,
  reason: string,
): Promise<void> {
  await runtime.host.recordEvent("review/error", {
    version: 1,
    session_id: runtime.session.sessionId,
    run_id: runtime.host.currentRunId ?? runtime.runId ?? "review-only",
    reason: redactOutputPreview(reason, runtime.paths.home).slice(0, 2_000),
    created_at: new Date().toISOString(),
  });
}
