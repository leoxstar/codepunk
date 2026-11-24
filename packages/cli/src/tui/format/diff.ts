import type { WorkspaceDiff } from "codepunk-core";

export const COMMIT_PREVIEW_FILES = 30;

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
