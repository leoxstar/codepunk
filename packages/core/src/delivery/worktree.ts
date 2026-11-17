import os from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensurePrivateDir, posixMetadataIsReliable } from "../platform/fs.ts";
import { isInsidePath, normalizeAbsolute } from "../platform/path.ts";
import {
  gitSucceeds,
  gitText,
  nulPaths,
  resolveCommit,
  statusRecords,
  statusOutsideCodepunk,
} from "./git.ts";
import { pathIntersectsProtected } from "./merge.ts";

const WORKER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export interface Worktree {
  path: string;
  workerId: string;
  baseCommit: string;
  remove(): Promise<void>;
}

export interface CreateWorktreeOptions {
  deliveryRoot: string;
  projectId: string;
  workerId: string;
  baseCommit: string;
  tempRoot?: string;
}

export interface FreezeWorktreeOptions {
  repoRoot: string;
  worktree: string;
  baseCommit: string;
  protectedPaths: readonly string[];
  message: string;
}

export interface FrozenWorktree {
  headCommit: string;
  changedPaths: string[];
}

function worktreeRoot(options: CreateWorktreeOptions): string {
  return path.join(
    options.tempRoot ?? path.join(os.tmpdir(), "codepunk-worktrees"),
    options.projectId,
  );
}

async function privateDirectory(directory: string): Promise<void> {
  await ensurePrivateDir(directory);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`worktree directory is not a real directory: ${directory}`);
  }
  if (
    (await posixMetadataIsReliable(directory)) &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new Error(
      `worktree directory is owned by another user: ${directory}`,
    );
  }
}

async function realPathOrNormalized(candidate: string): Promise<string> {
  try {
    return normalizeAbsolute(await fs.realpath(candidate));
  } catch {
    return normalizeAbsolute(candidate);
  }
}

/**
 * Resolve a linked worktree and prove it belongs to the expected repository.
 * A path string by itself is not enough: the caller may have persisted a stale
 * path, and `git` commands would otherwise run in an unrelated checkout.
 */
export async function assertLinkedWorktree(
  repoRootInput: string,
  worktreeInput: string,
): Promise<{ repoRoot: string; worktree: string }> {
  const repoRoot = await realPathOrNormalized(repoRootInput);
  const worktree = await realPathOrNormalized(worktreeInput);
  if (repoRoot === worktree) {
    throw new Error("the main checkout is not a linked worker worktree");
  }
  const listing = await gitText(repoRoot, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  const listed = (
    await Promise.all(
      listing
        .split("\0")
        .filter((line) => line.startsWith("worktree "))
        .map((line) =>
          realPathOrNormalized(line.slice("worktree ".length).trim()),
        ),
    )
  ).filter((entry) => entry.length > 0);
  if (!listed.includes(worktree)) {
    throw new Error(`not a registered Git worktree: ${worktreeInput}`);
  }
  return { repoRoot, worktree };
}

async function changedPaths(
  worktree: string,
  baseCommit: string,
  headCommit: string,
): Promise<string[]> {
  return nulPaths(
    await gitText(worktree, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      baseCommit,
      headCommit,
    ]),
  ).sort((left, right) => left.localeCompare(right));
}

function assertProtectedPaths(
  paths: readonly string[],
  protectedPaths: readonly string[],
): void {
  for (const entry of paths) {
    if (pathIntersectsProtected(entry, protectedPaths)) {
      throw new Error(`worker changed a protected path: ${entry}`);
    }
  }
}

function isCodepunkPath(filePath: string): boolean {
  return filePath === ".codepunk" || filePath.startsWith(".codepunk/");
}

function assertOnlyGeneratedCodepunkStatus(status: string): void {
  for (const line of statusRecords(status)) {
    const filePath = line.slice(3).trim();
    if (
      filePath.length > 0 &&
      isCodepunkPath(filePath) &&
      line !== "?? .codepunk/.gitignore"
    ) {
      throw new Error(`worker changed a protected path: ${filePath}`);
    }
  }
}

/**
 * Turn the dirty output of a child session into an exact commit and stop.
 * The commit is intentionally created only after a human delivery command; a
 * subagent result by itself remains an unreviewed worktree. Calling this again
 * on an already-frozen, unchanged worktree is idempotent.
 */
export async function freezeWorktree(
  options: FreezeWorktreeOptions,
): Promise<FrozenWorktree> {
  const { repoRoot, worktree } = await assertLinkedWorktree(
    options.repoRoot,
    options.worktree,
  );
  const baseCommit = await resolveCommit(repoRoot, options.baseCommit);
  let headCommit = await resolveCommit(worktree, "HEAD");
  let dirty = (
    await gitText(worktree, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "-z",
    ])
  ).trim();
  assertOnlyGeneratedCodepunkStatus(dirty);
  if (headCommit !== baseCommit) {
    if (statusOutsideCodepunk(dirty).trim().length > 0) {
      throw new Error("frozen worker worktree has uncommitted changes");
    }
    const paths = await changedPaths(worktree, baseCommit, headCommit);
    if (paths.length === 0) {
      throw new Error("worker worktree has no changes to freeze");
    }
    assertProtectedPaths(paths, options.protectedPaths);
    return { headCommit, changedPaths: paths };
  }
  if (statusOutsideCodepunk(dirty).trim().length === 0) {
    throw new Error("worker worktree has no changes to freeze");
  }
  const message = options.message.trim();
  if (message.length === 0 || message.includes("\u0000")) {
    throw new Error("worker freeze requires a non-empty commit message");
  }
  await gitText(worktree, ["add", "-A", "--", "."]);
  await gitText(worktree, ["reset", "-q", "--", ".codepunk"]).catch(
    () => undefined,
  );
  const staged = nulPaths(
    await gitText(worktree, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--no-renames",
      "--no-ext-diff",
    ]),
  )
    .filter((entry) => !isCodepunkPath(entry))
    .sort((left, right) => left.localeCompare(right));
  if (staged.length === 0) {
    await gitText(worktree, ["reset", "-q"]).catch(() => undefined);
    throw new Error("worker worktree has no staged changes to freeze");
  }
  try {
    assertProtectedPaths(staged, options.protectedPaths);
  } catch (error) {
    await gitText(worktree, ["reset", "-q"]).catch(() => undefined);
    throw error;
  }
  try {
    await gitText(worktree, ["commit", "-m", message]);
  } catch (error) {
    await gitText(worktree, ["reset", "-q"]).catch(() => undefined);
    throw new Error(
      `worker worktree commit failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  headCommit = await resolveCommit(worktree, "HEAD");
  dirty = (
    await gitText(worktree, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "-z",
    ])
  ).trim();
  assertOnlyGeneratedCodepunkStatus(dirty);
  if (
    headCommit === baseCommit ||
    statusOutsideCodepunk(dirty).trim().length > 0
  ) {
    throw new Error("worker worktree was not frozen cleanly");
  }
  return {
    headCommit,
    changedPaths: await changedPaths(worktree, baseCommit, headCommit),
  };
}

/**
 * Remove a worktree after an explicit discard confirmation. The path must be
 * a registered linked worktree of this repository; the operation cannot be
 * pointed at the main checkout.
 */
export async function discardWorktree(options: {
  repoRoot: string;
  worktree: string;
}): Promise<void> {
  const { repoRoot, worktree } = await assertLinkedWorktree(
    options.repoRoot,
    options.worktree,
  );
  await gitText(repoRoot, ["worktree", "remove", "--force", worktree]);
}

/**
 * Remove a clean worktree only after proving its head is contained in the
 * merge commit. This avoids `--force` on an arbitrary directory and keeps the
 * cleanup atomic with the delivery record.
 */
export async function removeMergedWorktree(options: {
  repoRoot: string;
  worktree: string;
  mergeCommit: string;
}): Promise<void> {
  const { repoRoot, worktree } = await assertLinkedWorktree(
    options.repoRoot,
    options.worktree,
  );
  const head = await resolveCommit(worktree, "HEAD");
  const merge = await resolveCommit(repoRoot, options.mergeCommit);
  if (
    !(await gitSucceeds(repoRoot, ["merge-base", "--is-ancestor", head, merge]))
  ) {
    throw new Error("worktree head is not contained in the merge commit");
  }
  const dirty = (
    await gitText(worktree, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "-z",
    ])
  ).trim();
  if (statusOutsideCodepunk(dirty).trim().length > 0) {
    throw new Error("refusing to remove a dirty merged worktree");
  }
  // The worktree may still contain Codepunk's generated `.codepunk` state.
  // It is registered, clean outside that state, and its head is already in the
  // merge commit, so force removal is bounded to this verified worktree.
  await gitText(repoRoot, ["worktree", "remove", "--force", worktree]);
}

export async function createDetachedWorktree(
  options: CreateWorktreeOptions,
): Promise<Worktree> {
  if (!WORKER_ID.test(options.workerId)) {
    throw new Error("worker id must match [a-z0-9][a-z0-9._-]{0,63}");
  }
  const deliveryRoot = normalizeAbsolute(options.deliveryRoot);
  const root = normalizeAbsolute(worktreeRoot(options));
  const baseCommit = await resolveCommit(deliveryRoot, options.baseCommit);
  if (isInsidePath(deliveryRoot, root)) {
    throw new Error("worktrees must live outside the delivery root");
  }
  await privateDirectory(root);
  const target = path.join(root, options.workerId);
  let existing = null;
  try {
    existing = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (existing !== null) {
    throw new Error(`worktree already exists: ${target}`);
  }
  try {
    await gitText(deliveryRoot, [
      "worktree",
      "add",
      "--detach",
      target,
      baseCommit,
    ]);
    await fs.chmod(target, 0o700);
    const head = await resolveCommit(target, "HEAD");
    if (head !== baseCommit) {
      throw new Error("created worktree is not at the requested base commit");
    }
  } catch (error) {
    await gitText(deliveryRoot, [
      "worktree",
      "remove",
      "--force",
      target,
    ]).catch(() => undefined);
    throw error;
  }
  let removed = false;
  return {
    path: target,
    workerId: options.workerId,
    baseCommit,
    async remove(): Promise<void> {
      if (removed) {
        return;
      }
      const head = await resolveCommit(target, "HEAD");
      const status = (
        await gitText(target, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ])
      ).trim();
      if (status.length > 0) {
        throw new Error("refusing to remove a dirty worker worktree");
      }
      if (head !== baseCommit) {
        throw new Error("refusing to remove a worktree with worker commits");
      }
      if (
        !(await gitSucceeds(target, ["rev-parse", "--is-inside-work-tree"]))
      ) {
        throw new Error("worker worktree is no longer valid");
      }
      await gitText(deliveryRoot, ["worktree", "remove", target]);
      removed = true;
    },
  };
}
