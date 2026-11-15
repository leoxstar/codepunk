import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_MESSAGE_LENGTH = 10_000;

export type GitCommitStage = "staged" | "tracked" | "all";

export interface WorkspaceCommitPreviewOptions {
  root: string;
}

export interface WorkspaceCommitPreview {
  root: string;
  head: string | null;
  branch: string | null;
  staged: readonly string[];
  unstaged: readonly string[];
  untracked: readonly string[];
  staged_stat: string;
  unstaged_stat: string;
}

export interface GitCommitOptions {
  root: string;
  message: string;
  stage: GitCommitStage;
}

export interface GitCommitResult {
  root: string;
  previous_commit: string | null;
  commit: string;
  tree: string;
  message: string;
  files: readonly string[];
  ignored: readonly string[];
  stage: GitCommitStage;
}

export class GitCommitError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GitCommitError";
    this.code = code;
  }
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(root: string, args: readonly string[]): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", ["-C", root, ...args], {
      cwd: root,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        GIT_EDITOR: "true",
        GIT_TERMINAL_PROMPT: "0",
      },
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? String(error),
    };
  }
}

function requireGit(result: GitResult, action: string): string {
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new GitCommitError(
      "git.command_failed",
      `${action} failed${detail.length === 0 ? "" : `: ${detail}`}`,
    );
  }
  return result.stdout;
}

function nullList(output: string): string[] {
  return output.split("\u0000").filter((entry) => entry.length > 0);
}

async function repositoryRoot(root: string): Promise<string> {
  const result = await git(root, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) {
    throw new GitCommitError(
      "git.not_a_repository",
      `${path.resolve(root)} is not a Git worktree`,
    );
  }
  return path.resolve(result.stdout.trim());
}

/**
 * Inspect the exact changes a commit would include. Paths come from NUL-
 * separated Git output so spaces and unusual filenames survive unchanged.
 */
export async function readWorkspaceCommitPreview(
  options: WorkspaceCommitPreviewOptions,
): Promise<WorkspaceCommitPreview> {
  const root = await repositoryRoot(options.root);
  const [staged, unstaged, untracked, stagedStat, unstagedStat, head, branch] =
    await Promise.all([
      git(root, [
        "diff",
        "--cached",
        "--name-only",
        "-z",
        "--no-renames",
        "--no-ext-diff",
      ]),
      git(root, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff"]),
      git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
      git(root, ["diff", "--cached", "--stat", "--no-ext-diff"]),
      git(root, ["diff", "--stat", "--no-ext-diff"]),
      git(root, ["rev-parse", "--verify", "HEAD"]),
      git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    ]);
  return {
    root,
    head: head.code === 0 ? head.stdout.trim() : null,
    branch:
      branch.code === 0 && branch.stdout.trim() !== "HEAD"
        ? branch.stdout.trim()
        : null,
    staged: nullList(requireGit(staged, "git diff --cached --name-only")),
    unstaged: nullList(requireGit(unstaged, "git diff --name-only")),
    untracked: nullList(requireGit(untracked, "git ls-files --others")),
    staged_stat: requireGit(stagedStat, "git diff --cached --stat").trimEnd(),
    unstaged_stat: requireGit(unstagedStat, "git diff --stat").trimEnd(),
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function assertNoOperationInProgress(gitDir: string): Promise<void> {
  for (const marker of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
  ]) {
    if (await pathExists(path.join(gitDir, marker))) {
      throw new GitCommitError(
        "git.operation_in_progress",
        `a Git operation is in progress (${marker}); finish or abort it before committing`,
      );
    }
  }
}

async function assertIdentity(root: string): Promise<void> {
  const name = (
    await git(root, ["config", "--get", "user.name"])
  ).stdout.trim();
  const email = (
    await git(root, ["config", "--get", "user.email"])
  ).stdout.trim();
  if (name.length === 0 || email.length === 0) {
    throw new GitCommitError(
      "git.identity_missing",
      "git user.name and user.email must be configured before Codepunk can commit",
    );
  }
}

function validateMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    throw new GitCommitError(
      "git.empty_message",
      "a commit message is required",
    );
  }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new GitCommitError(
      "git.message_too_long",
      `commit message must be at most ${MAX_MESSAGE_LENGTH} characters`,
    );
  }
  if (trimmed.includes("\u0000")) {
    throw new GitCommitError(
      "git.invalid_message",
      "commit message cannot contain NUL",
    );
  }
  return trimmed;
}

function stageArgs(stage: GitCommitStage): readonly string[] | null {
  if (stage === "staged") {
    return null;
  }
  return stage === "tracked"
    ? ["add", "--update", "--", "."]
    : ["add", "--all", "--", "."];
}

/**
 * Create a commit as an explicit human product action.
 *
 * This does not call a model and does not go through the agent tool sandbox:
 * `.git` is deliberately protected from model tools, so a `/commit` prompt
 * that asked the model to run `git commit` would fail closed. The caller must
 * have shown the user the staged/untracked file list and received an explicit
 * confirmation before invoking this function.
 */
export async function createGitCommit(
  options: GitCommitOptions,
): Promise<GitCommitResult> {
  const message = validateMessage(options.message);
  const preview = await readWorkspaceCommitPreview({ root: options.root });
  if (options.stage === "staged" && preview.staged.length === 0) {
    throw new GitCommitError(
      "git.nothing_staged",
      preview.unstaged.length + preview.untracked.length > 0
        ? "no staged changes to commit; stage tracked or all changes first"
        : "no staged changes to commit",
    );
  }
  if (
    options.stage !== "staged" &&
    preview.staged.length === 0 &&
    preview.unstaged.length === 0 &&
    preview.untracked.length === 0
  ) {
    throw new GitCommitError("git.nothing_to_commit", "nothing to commit");
  }

  const gitDir = requireGit(
    await git(preview.root, ["rev-parse", "--absolute-git-dir"]),
    "git rev-parse --absolute-git-dir",
  ).trim();
  await assertNoOperationInProgress(gitDir);
  await assertIdentity(preview.root);

  const add = stageArgs(options.stage);
  if (add !== null) {
    requireGit(await git(preview.root, add), "git add");
  }
  const staged = await readWorkspaceCommitPreview({ root: preview.root });
  if (staged.staged.length === 0) {
    throw new GitCommitError(
      "git.nothing_staged",
      options.stage === "tracked"
        ? "no tracked changes to commit; use stage=all to include untracked files"
        : "no changes were staged",
    );
  }

  requireGit(await git(preview.root, ["commit", "-m", message]), "git commit");
  const commit = requireGit(
    await git(preview.root, ["rev-parse", "HEAD"]),
    "git rev-parse HEAD",
  ).trim();
  const tree = requireGit(
    await git(preview.root, ["rev-parse", "HEAD^{tree}"]),
    "git rev-parse HEAD^{tree}",
  ).trim();
  const files = nullList(
    requireGit(
      await git(preview.root, [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        "--no-renames",
        "HEAD",
      ]),
      "git diff-tree HEAD",
    ),
  );
  const ignored = nullList(
    requireGit(
      await git(preview.root, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
      ]),
      "git ls-files --others --ignored",
    ),
  );
  return {
    root: preview.root,
    previous_commit: preview.head,
    commit,
    tree,
    message,
    files,
    ignored,
    stage: options.stage,
  };
}
