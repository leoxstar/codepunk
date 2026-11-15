import os from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensurePrivateDir } from "../platform/fs.ts";
import { isInsidePath, normalizeAbsolute } from "../platform/path.ts";
import { gitSucceeds, gitText, resolveCommit } from "./git.ts";

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
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(
      `worktree directory is owned by another user: ${directory}`,
    );
  }
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
