import path from "node:path";
import {
  DEFAULT_PROTECTED_PATHS,
  createHandoff,
  createTaskSpec,
  freezeWorktree,
  mergeHandoff,
  readWorkspaceCommitPreview,
  removeMergedWorktree,
  writeHandoff,
  type CodepunkRuntime,
  type SubagentHostResult,
} from "codepunk-core";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BackgroundSubagent } from "../state.ts";
import { reviewSubagent } from "./subagent-review.ts";

async function mergeSignedSubagentWorktree(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  record: BackgroundSubagent,
  result: SubagentHostResult,
  delivery: NonNullable<BackgroundSubagent["delivery"]>,
  worktree: string,
  baseCommit: string,
  childRunId: string,
  childEvidencePath: string,
  evidenceHead: string,
): Promise<void> {
  try {
    const summaryLine =
      (result.summary.split(/\r?\n/u)[0] ?? "")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 160) || `subagent ${record.childSessionId}`;
    const spec = createTaskSpec({
      taskId: `subagent-${record.childSessionId}`,
      title: `Subagent ${record.profile ?? "built-in"}`,
      objective: record.prompt,
      baseCommit,
      writeSet: ["."],
      acceptance: ["human review and signed child run"],
      isolation: "worktree",
    });
    const frozen = await freezeWorktree({
      repoRoot: runtime.paths.deliveryRoot,
      worktree,
      baseCommit,
      protectedPaths: DEFAULT_PROTECTED_PATHS,
      message: `subagent: ${summaryLine}`,
    });
    const handoff = await createHandoff({
      spec,
      worktree,
      workerId: record.childSessionId,
      runId: childRunId,
      evidencePath: childEvidencePath,
      verdict: {
        verdict: "complete",
        sign_off_id: delivery.verdict.sign_off_id,
        evidence_head: evidenceHead,
      },
    });
    const handoffPath = await writeHandoff(runtime.paths, handoff);
    const merge = await mergeHandoff({
      paths: runtime.paths,
      repoRoot: runtime.paths.deliveryRoot,
      sourceWorktree: worktree,
      spec,
      handoff,
      evidencePath: childEvidencePath,
      actor: "local-user",
      human: true,
      taskState: "review_passed",
    });
    const mergeRecordPath = path.join(
      runtime.paths.projectDir,
      "merges",
      spec.task_id,
      `${merge.merge_id}.json`,
    );
    let cleanupError: string | null = null;
    try {
      await removeMergedWorktree({
        repoRoot: runtime.paths.deliveryRoot,
        worktree,
        mergeCommit: merge.merge_commit,
      });
      record.worktree = null;
      result.worktree = null;
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }
    record.delivery = {
      state: "merged",
      verdict: delivery.verdict,
      handoff,
      handoffPath,
      merge,
      mergeRecordPath,
    };
    context.ui.notify(
      [
        `subagent ${record.childSessionId} merged`,
        `child commit: ${frozen.headCommit}`,
        `merge commit: ${merge.merge_commit}`,
        `handoff: ${handoffPath}`,
        `merge record: ${mergeRecordPath}`,
        ...(cleanupError === null
          ? ["worktree removed"]
          : [`worktree cleanup failed: ${cleanupError}`]),
      ].join("\n"),
      cleanupError === null ? "info" : "warning",
    );
  } catch (error) {
    context.ui.notify(
      `subagent merge failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
}

export async function mergeSubagent(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  record: BackgroundSubagent,
): Promise<void> {
  const result = record.result;
  if (
    record.status !== "completed" ||
    result === null ||
    record.worktree === null ||
    result.base_commit === null
  ) {
    context.ui.notify(
      `subagent ${record.childSessionId} has no completed worktree to merge`,
      "warning",
    );
    return;
  }
  if (
    record.delivery?.state === "merged" ||
    record.delivery?.state === "discarded"
  ) {
    context.ui.notify(
      `subagent ${record.childSessionId} is already ${record.delivery.state}`,
      "warning",
    );
    return;
  }
  if (
    record.delivery?.verdict.verdict !== "complete" ||
    record.delivery.verdict.sign_off_id === null
  ) {
    context.ui.notify(
      `subagent ${record.childSessionId} is not signed complete; use /agents sign ${record.childSessionId}`,
      "warning",
    );
    return;
  }
  if (
    result.child_run_id === null ||
    result.child_evidence_path === null ||
    result.evidence_head === null
  ) {
    context.ui.notify(
      `subagent ${record.childSessionId} has no child evidence to merge`,
      "warning",
    );
    return;
  }
  const target = await readWorkspaceCommitPreview({
    root: runtime.paths.deliveryRoot,
  });
  if (target.head !== result.base_commit) {
    context.ui.notify(
      `cannot merge: parent HEAD ${target.head ?? "none"} is not the child base ${result.base_commit}`,
      "error",
    );
    return;
  }
  const targetChanges = [
    ...target.staged,
    ...target.unstaged,
    ...target.untracked,
  ].filter((entry) => entry !== ".codepunk" && !entry.startsWith(".codepunk/"));
  if (targetChanges.length > 0) {
    context.ui.notify(
      `cannot merge: the parent working tree is dirty (${targetChanges.join(
        ", ",
      )}); commit or stash its changes first`,
      "error",
    );
    return;
  }
  await reviewSubagent(context, record);
  const confirmed = await context.ui.select(
    `Merge subagent ${record.childSessionId}?`,
    ["Merge the signed child commit", "Cancel"],
  );
  if (confirmed !== "Merge the signed child commit") {
    return;
  }
  await mergeSignedSubagentWorktree(
    runtime,
    context,
    record,
    result,
    record.delivery,
    record.worktree,
    result.base_commit,
    result.child_run_id,
    result.child_evidence_path,
    result.evidence_head,
  );
}
