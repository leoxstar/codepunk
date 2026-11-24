import {
  createGitCommit,
  outputSha,
  recordHash,
  readWorkspaceCommitPreview,
  redactOutputPreview,
  sha256Text,
  type CheckpointPreview,
  CheckpointConflictError,
  type CodepunkRuntime,
  type GitCommitResult,
  type GitCommitStage,
  type WorkspaceCommitPreview,
  type WorkspaceDiff,
} from "codepunk-core";
import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TuiState } from "../state.ts";
import { notify } from "./notify.ts";

async function appendCommitEvidence(
  runtime: CodepunkRuntime,
  result: GitCommitResult,
  summary: string,
  started: number,
): Promise<void> {
  const rule = "product.commit";
  const ruleSha256 = recordHash({ rule });
  await runtime.ledger.append({
    task_id: null,
    run_id: runtime.ledger.activeRunId,
    session_id: runtime.session.sessionId,
    source: "tool",
    tool: "commit",
    tool_call_id: `commit:${result.commit}`,
    decision: "allow",
    outcome: "completed",
    rule,
    rule_sha256: ruleSha256,
    policy_layers: [
      {
        layer: "user",
        source: "product:/commit",
        sha256: sha256Text("product:/commit"),
        rule_sha256: ruleSha256,
      },
    ],
    approval: null,
    command: "git commit",
    command_argv: ["git", "commit", "-m", "<redacted>"],
    cwd: runtime.paths.cwd,
    workspace_root: runtime.paths.deliveryRoot,
    path_check: { performed: false, target: null },
    sandbox: { backend: "none", version: null, profile_sha256: null },
    effects: { fs: "write", shell: false, network: false },
    coverage: "uncovered",
    coverage_basis: ["product-action", "git"],
    exit_code: 0,
    duration_ms: Date.now() - started,
    before_sha256: null,
    after_sha256: null,
    diff_sha256: null,
    output_ref: null,
    output_sha256: outputSha(summary),
    output_preview: redactOutputPreview(summary, runtime.paths.home).slice(
      0,
      4_096,
    ),
    empty_result: false,
    executor: "codepunk-commit",
    vcs: {
      commit: result.commit,
      tree: result.tree,
      base_commit: result.previous_commit,
    },
    memory: {
      ids: [],
      action: "none",
      query_sha256: null,
      cap: 0,
      truncated: false,
    },
  });
}

export const DIFF_DISPLAY_LINES = 240;

export function formatWorkspaceDiff(diff: WorkspaceDiff): string {
  const status = diff.status.trimEnd();
  const lines = [`Working tree diff · ${diff.root}`];
  if (status.length === 0) {
    return [...lines, "", "No changes."].join("\n");
  }
  lines.push("", status);
  const stat = diff.stat.trimEnd();
  if (stat.length > 0) {
    lines.push("", stat);
  }
  const untracked = diff.untracked
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (untracked.length > 0) {
    lines.push(
      "",
      `untracked files (${untracked.length}; no patch until staged):`,
      ...untracked.slice(0, COMMIT_PREVIEW_FILES).map((file) => `  ${file}`),
    );
    if (untracked.length > COMMIT_PREVIEW_FILES) {
      lines.push(`  … ${untracked.length - COMMIT_PREVIEW_FILES} more`);
    }
  }
  const patch = [diff.staged.trimEnd(), diff.unstaged.trimEnd()]
    .filter((entry) => entry.length > 0)
    .join("\n\n");
  if (patch.length > 0) {
    const patchLines = patch.split("\n");
    lines.push("", ...patchLines.slice(0, DIFF_DISPLAY_LINES));
    if (patchLines.length > DIFF_DISPLAY_LINES || diff.truncated) {
      lines.push(
        "",
        `(diff truncated at ${DIFF_DISPLAY_LINES} lines; run git diff for the full patch)`,
      );
    }
  } else if (diff.truncated) {
    lines.push("", "(diff truncated; run git diff for the full patch)");
  }
  return lines.join("\n");
}

export const COMMIT_PREVIEW_FILES = 30;

export function commitFileSection(
  label: string,
  files: readonly string[],
): string[] {
  if (files.length === 0) {
    return [];
  }
  const visible = files.slice(0, COMMIT_PREVIEW_FILES);
  const lines = [
    `${label} (${files.length})`,
    ...visible.map((file) => `  ${file}`),
  ];
  if (files.length > visible.length) {
    lines.push(`  … ${files.length - visible.length} more`);
  }
  return lines;
}

export function formatCommitPreview(preview: WorkspaceCommitPreview): string {
  const lines = [
    `Commit preview · ${preview.root}`,
    `branch: ${preview.branch ?? "(detached)"} · HEAD: ${
      preview.head === null ? "(unborn)" : preview.head.slice(0, 12)
    }`,
  ];
  lines.push(
    ...commitFileSection("staged", preview.staged),
    ...commitFileSection("unstaged tracked", preview.unstaged),
    ...commitFileSection("untracked", preview.untracked),
  );
  if (
    preview.staged.length === 0 &&
    preview.unstaged.length === 0 &&
    preview.untracked.length === 0
  ) {
    lines.push("No changes.");
  }
  if (preview.staged_stat.length > 0) {
    lines.push("", "staged stat:", preview.staged_stat);
  }
  if (preview.unstaged_stat.length > 0) {
    lines.push("", "unstaged stat:", preview.unstaged_stat);
  }
  return lines.join("\n");
}

export async function chooseCommitStage(
  context: ExtensionContext,
  preview: WorkspaceCommitPreview,
): Promise<GitCommitStage | null> {
  const hasStaged = preview.staged.length > 0;
  const hasUnstaged = preview.unstaged.length > 0;
  const hasUntracked = preview.untracked.length > 0;
  const choices: Array<{ label: string; value: GitCommitStage }> = [];
  if (hasStaged) {
    choices.push({
      label: `Commit staged changes only (${preview.staged.length})`,
      value: "staged",
    });
  }
  if (hasUnstaged) {
    choices.push({
      label: `Stage tracked changes and commit (${preview.unstaged.length})`,
      value: "tracked",
    });
  }
  if (hasUntracked) {
    choices.push({
      label: `Stage all changes including untracked (${preview.untracked.length} untracked)`,
      value: "all",
    });
  }
  if (hasStaged && (hasUnstaged || hasUntracked)) {
    const total =
      preview.staged.length +
      preview.unstaged.length +
      preview.untracked.length;
    choices.push({
      label: `Stage everything and commit (${total})`,
      value: "all",
    });
  }
  if (choices.length === 0) {
    context.ui.notify("Nothing to commit.", "warning");
    return null;
  }
  const labels = [...choices.map((choice) => choice.label), "Cancel"];
  const selected = await context.ui.select("Commit scope", labels);
  if (selected === undefined || selected === "Cancel") {
    return null;
  }
  return choices.find((choice) => choice.label === selected)?.value ?? null;
}

export function commitSummary(result: GitCommitResult): string {
  const subject = result.message.split(/\r?\n/u)[0] ?? result.message;
  const ignored =
    result.ignored.length === 0
      ? ""
      : `\nignored (not committed): ${result.ignored.length}`;
  return [
    `commit created: ${result.commit.slice(0, 12)}`,
    `subject: ${subject}`,
    `root: ${result.root}`,
    `files: ${result.files.length}`,
    `stage: ${result.stage}${ignored}`,
  ].join("\n");
}

export function checkpointPreviewText(
  action: "undo" | "redo",
  preview: CheckpointPreview,
): string {
  if (preview.entries.length === 0) {
    return action === "undo"
      ? "No applied Codepunk file checkpoint is available."
      : "No undone Codepunk file checkpoint is available.";
  }
  return preview.entries
    .map(
      (entry) =>
        `${entry.tool} ${entry.display_target} (${entry.state} → ${action === "undo" ? "before" : "after"})`,
    )
    .join("\n");
}

export async function restoreCheckpoint(
  state: TuiState,
  context: ExtensionCommandContext,
  action: "undo" | "redo",
  argument: string,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  if (runtime.host.session.isStreaming || runtime.host.session.isCompacting) {
    context.ui.notify(
      `Wait for the current ${runtime.host.session.isStreaming ? "response" : "compaction"} to finish before /${action}.`,
      "warning",
    );
    return;
  }
  const raw = argument.trim();
  const count = raw.length === 0 ? 1 : Number(raw);
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    context.ui.notify(`usage: /${action} [count]`, "warning");
    return;
  }
  let preview: CheckpointPreview;
  try {
    preview = await runtime.checkpoints.preview(action, count);
  } catch (error) {
    const message =
      error instanceof CheckpointConflictError
        ? error.message
        : `checkpoint preview failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
    context.ui.notify(message, "error");
    return;
  }
  if (preview.entries.length === 0) {
    context.ui.notify(checkpointPreviewText(action, preview), "info");
    return;
  }
  const confirmed = await context.ui.confirm(
    action === "undo" ? "Undo file changes?" : "Redo file changes?",
    `${checkpointPreviewText(action, preview)}\n\nOnly files whose current digest matches the checkpoint will be changed.`,
  );
  if (!confirmed) {
    context.ui.notify(`${action} cancelled.`, "info");
    return;
  }
  let result;
  try {
    result =
      action === "undo"
        ? await runtime.checkpoints.undo(count)
        : await runtime.checkpoints.redo(count);
  } catch (error) {
    const message =
      error instanceof CheckpointConflictError
        ? error.message
        : `${action} failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
    context.ui.notify(message, "error");
    return;
  }
  for (const entry of result.entries) {
    const from = action === "undo" ? entry.after.sha256 : entry.before.sha256;
    const to = action === "undo" ? entry.before.sha256 : entry.after.sha256;
    try {
      await runtime.host.recordEvent("checkpoint/restore", {
        action,
        checkpoint_id: entry.id,
        tool_call_id: entry.tool_call_id,
        target: entry.target,
        from_sha256: from,
        to_sha256: to,
      });
    } catch {
      context.ui.notify(
        `${action} restored files, but its session event could not be recorded.`,
        "warning",
      );
    }
  }
  context.ui.notify(
    `${action}: ${result.entries.length} file checkpoint(s) restored.`,
    "info",
  );
}

export async function configureCommit(
  state: TuiState,
  context: ExtensionCommandContext,
  argument: string,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  let message = argument.trim();
  if (message.length === 0) {
    message =
      (
        await context.ui.input(
          "Commit message",
          "Subject line; Enter to continue, Escape to cancel",
        )
      )?.trim() ?? "";
  }
  if (message.length === 0) {
    context.ui.notify("Commit cancelled: a message is required.", "warning");
    return;
  }
  let preview: WorkspaceCommitPreview;
  try {
    preview = await readWorkspaceCommitPreview({
      root: runtime.paths.deliveryRoot,
    });
  } catch (error) {
    context.ui.notify(
      `/commit failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  if (
    preview.staged.length === 0 &&
    preview.unstaged.length === 0 &&
    preview.untracked.length === 0
  ) {
    context.ui.notify("Nothing to commit.", "warning");
    return;
  }
  await notify(context, formatCommitPreview(preview));
  const stage = await chooseCommitStage(context, preview);
  if (stage === null) {
    return;
  }
  const confirmed = await context.ui.confirm(
    "Create this commit?",
    `${message.split(/\r?\n/u)[0]}\n\n${formatCommitPreview(preview)}`,
  );
  if (!confirmed) {
    context.ui.notify("Commit cancelled.", "info");
    return;
  }

  const started = Date.now();
  let result: GitCommitResult;
  try {
    result = await createGitCommit({
      root: runtime.paths.deliveryRoot,
      message,
      stage,
    });
  } catch (error) {
    context.ui.notify(
      `Commit failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  const summary = commitSummary(result);
  let evidenceHead: string | null = null;
  try {
    await appendCommitEvidence(runtime, result, summary, started);
    evidenceHead = runtime.ledger.head;
  } catch (error) {
    context.ui.notify(
      `${summary}\n\ncommit created, but evidence recording failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "warning",
    );
    return;
  }
  try {
    await runtime.host.recordEvent("commit/created", {
      run_id: runtime.ledger.activeRunId,
      commit: result.commit,
      previous_commit: result.previous_commit,
      tree: result.tree,
      message_sha256: sha256Text(result.message),
      message_bytes: Buffer.byteLength(result.message, "utf8"),
      files: result.files,
      stage: result.stage,
      root: result.root,
      evidence_head: evidenceHead,
    });
  } catch (error) {
    context.ui.notify(
      `${summary}\n\ncommit and evidence created, but the session event failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "warning",
    );
    return;
  }
  context.ui.notify(summary, "info");
}
