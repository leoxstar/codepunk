import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  ensurePrivateDir,
  readJsonFile,
  writeJsonAtomic,
} from "../platform/fs.ts";
import { createUlid } from "../platform/hash.ts";
import {
  isInsidePath,
  normalizeAbsolute,
  resolveRealPath,
} from "../platform/path.ts";

const execFileAsync = promisify(execFile);

const SHADOW_INDEX_VERSION = 1;
const MAX_SHADOW_SNAPSHOTS = 40;
const MAX_UNTRACKED_CANDIDATES = 2_000;
const GIT_TIMEOUT_MS = 15_000;

export interface ShadowGitSnapshot {
  readonly id: string;
  readonly run_id: string;
  readonly tool: "bash" | "write" | "edit" | "manual";
  readonly label: string;
  readonly before_tree: string;
  readonly after_tree: string;
  readonly changed_files: readonly string[];
  readonly created_at: string;
}

interface ShadowGitLedger {
  version: 1;
  snapshots: ShadowGitSnapshot[];
}

export interface ShadowGitRestoreResult {
  readonly snapshot: ShadowGitSnapshot;
  readonly restoredFiles: readonly string[];
  readonly removedAddedFiles: readonly string[];
}

export interface ShadowGitStoreOptions {
  readonly sessionDir: string;
  readonly workspaceRoot: string;
  readonly maxSnapshots?: number;
  readonly now?: () => Date;
}

const EXCLUDE_PATHSPECS = [
  ":(exclude).git",
  ":(exclude).codepunk",
  ":(exclude)node_modules",
  ":(exclude).venv",
  ":(exclude)venv",
  ":(exclude)target",
] as const;

export class ShadowGitStore {
  private readonly gitDir: string;
  private readonly ledgerPath: string;
  private readonly workspaceRoot: string;
  private readonly maxSnapshots: number;
  private readonly now: () => Date;
  private initialized = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: ShadowGitStoreOptions) {
    this.gitDir = path.join(options.sessionDir, "shadow-git");
    this.ledgerPath = path.join(options.sessionDir, "shadow-snapshots.json");
    this.workspaceRoot = normalizeAbsolute(options.workspaceRoot);
    this.maxSnapshots = Math.max(
      1,
      options.maxSnapshots ?? MAX_SHADOW_SNAPSHOTS,
    );
    this.now = options.now ?? (() => new Date());
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private gitEnv(indexPath: string): NodeJS.ProcessEnv {
    return {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: path.dirname(this.gitDir),
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.workspaceRoot,
      GIT_INDEX_FILE: indexPath,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "codepunk-shadow",
      GIT_AUTHOR_EMAIL: "shadow@codepunk.local",
      GIT_COMMITTER_NAME: "codepunk-shadow",
      GIT_COMMITTER_EMAIL: "shadow@codepunk.local",
    };
  }

  private async runGit(
    args: readonly string[],
    indexPath: string,
  ): Promise<string> {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd: this.workspaceRoot,
      env: this.gitEnv(indexPath),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout;
  }

  private async ensureRepo(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await ensurePrivateDir(this.gitDir);
    const headPath = path.join(this.gitDir, "HEAD");
    try {
      await fs.access(headPath);
    } catch {
      const cleanInitEnv: NodeJS.ProcessEnv = {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: path.dirname(this.gitDir),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      };
      await execFileAsync("git", ["init", "--bare", "-q", this.gitDir], {
        env: cleanInitEnv,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      });
      await execFileAsync(
        "git",
        ["--git-dir", this.gitDir, "config", "core.bare", "false"],
        {
          env: cleanInitEnv,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
        },
      );
    }
    this.initialized = true;
  }

  private async readLedger(): Promise<ShadowGitLedger> {
    try {
      const parsed = await readJsonFile<unknown>(this.ledgerPath);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>)["version"] ===
          SHADOW_INDEX_VERSION &&
        Array.isArray((parsed as Record<string, unknown>)["snapshots"])
      ) {
        return parsed as ShadowGitLedger;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: SHADOW_INDEX_VERSION, snapshots: [] };
      }
    }
    return { version: SHADOW_INDEX_VERSION, snapshots: [] };
  }

  private async writeLedger(ledger: ShadowGitLedger): Promise<void> {
    await ensurePrivateDir(path.dirname(this.ledgerPath));
    await writeJsonAtomic(this.ledgerPath, ledger);
  }

  /**
   * Captures the current workspace file tree into the isolated shadow Git
   * object store without touching the workspace's own `.git/index` or refs.
   * Returns `null` if the workspace has too many untracked files or git is
   * unavailable.
   */
  async captureWorktree(): Promise<string | null> {
    return this.enqueue(() => this.captureTreeUnlocked());
  }

  private async captureTreeUnlocked(): Promise<string | null> {
    await this.ensureRepo();
    const tempIndex = path.join(this.gitDir, `idx-${randomUUID()}`);
    try {
      const others = await this.runGit(
        [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
          "--",
          ".",
          ...EXCLUDE_PATHSPECS,
        ],
        tempIndex,
      );
      const untrackedCount = others.split("\0").filter(Boolean).length;
      if (untrackedCount > MAX_UNTRACKED_CANDIDATES) {
        return null;
      }
      await this.runGit(
        [
          "-c",
          "core.autocrlf=false",
          "add",
          "-A",
          "--",
          ".",
          ...EXCLUDE_PATHSPECS,
        ],
        tempIndex,
      );
      const treeSha = (await this.runGit(["write-tree"], tempIndex)).trim();
      return /^[0-9a-f]{40}$/u.test(treeSha) ? treeSha : null;
    } catch {
      return null;
    } finally {
      await fs.rm(tempIndex, { force: true }).catch(() => undefined);
    }
  }

  private async diffTreesUnlocked(
    fromTree: string,
    toTree: string,
  ): Promise<Array<{ status: string; relPath: string }>> {
    if (fromTree === toTree) {
      return [];
    }
    const tempIndex = path.join(this.gitDir, `diff-${randomUUID()}`);
    try {
      const raw = await this.runGit(
        ["diff-tree", "-r", "--name-status", "-z", fromTree, toTree],
        tempIndex,
      );
      const tokens = raw.split("\0").filter((entry) => entry.length > 0);
      const changes: Array<{ status: string; relPath: string }> = [];
      for (let i = 0; i + 1 < tokens.length; i += 2) {
        const status = tokens[i]!.slice(0, 1);
        const relPath = tokens[i + 1]!;
        changes.push({ status, relPath });
      }
      return changes;
    } finally {
      await fs.rm(tempIndex, { force: true }).catch(() => undefined);
    }
  }

  async recordStep(input: {
    runId: string;
    tool: ShadowGitSnapshot["tool"];
    label: string;
    beforeTree: string | null;
  }): Promise<ShadowGitSnapshot | null> {
    const beforeTree = input.beforeTree;
    if (beforeTree === null) {
      return null;
    }
    return this.enqueue(async () => {
      const afterTree = await this.captureTreeUnlocked();
      if (afterTree === null || afterTree === beforeTree) {
        return null;
      }
      const changes = await this.diffTreesUnlocked(beforeTree, afterTree);
      if (changes.length === 0) {
        return null;
      }
      const ledger = await this.readLedger();
      const snapshot: ShadowGitSnapshot = {
        id: createUlid(this.now()),
        run_id: input.runId,
        tool: input.tool,
        label: input.label.slice(0, 160),
        before_tree: beforeTree,
        after_tree: afterTree,
        changed_files: changes.map((c) => c.relPath).slice(0, 50),
        created_at: this.now().toISOString(),
      };
      ledger.snapshots.push(snapshot);
      if (ledger.snapshots.length > this.maxSnapshots) {
        ledger.snapshots.splice(0, ledger.snapshots.length - this.maxSnapshots);
      }
      await this.writeLedger(ledger);
      return snapshot;
    });
  }

  async list(limit = 30): Promise<readonly ShadowGitSnapshot[]> {
    return this.enqueue(async () => {
      const ledger = await this.readLedger();
      return [...ledger.snapshots].reverse().slice(0, Math.max(1, limit));
    });
  }

  /**
   * Atomically rewinds the workspace back to the `before_tree` of the Nth most
   * recent shadow snapshot (1 = latest mutation, >1 = rewinds multiple steps to
   * the target step's `before_tree`), including files modified, deleted, or
   * newly created by `bash` commands.
   */
  async rewindSteps(stepsBack = 1): Promise<ShadowGitRestoreResult> {
    if (!Number.isSafeInteger(stepsBack) || stepsBack < 1) {
      throw new Error("stepsBack must be a positive integer");
    }
    return this.enqueue(async () => {
      const ledger = await this.readLedger();
      if (ledger.snapshots.length === 0) {
        throw new Error(
          "no shadow worktree snapshots recorded in this session",
        );
      }
      if (stepsBack > ledger.snapshots.length) {
        throw new Error(
          `requested ${stepsBack} step(s) back, only ${ledger.snapshots.length} shadow snapshot(s) available`,
        );
      }
      const targetIdx = ledger.snapshots.length - stepsBack;
      const targetSnapshot = ledger.snapshots[targetIdx]!;
      const targetTree = targetSnapshot.before_tree;
      const currentTree = await this.captureTreeUnlocked();
      if (currentTree === null) {
        throw new Error(
          "cannot inspect current worktree state for shadow rewind",
        );
      }

      const changes = await this.diffTreesUnlocked(currentTree, targetTree);
      const realRoot = resolveRealPath(this.workspaceRoot);
      const toCheckout: string[] = [];
      const toRemove: string[] = [];

      for (const change of changes) {
        if (
          change.relPath.startsWith(".git/") ||
          change.relPath === ".git" ||
          change.relPath.startsWith(".codepunk/") ||
          change.relPath === ".codepunk" ||
          path.isAbsolute(change.relPath) ||
          change.relPath.split(/[\\/]/u).includes("..")
        ) {
          continue;
        }
        const absCandidate = normalizeAbsolute(
          path.join(this.workspaceRoot, change.relPath),
        );
        if (!isInsidePath(this.workspaceRoot, absCandidate)) {
          throw new Error(
            `refusing shadow rewind path outside workspace: ${change.relPath}`,
          );
        }
        const parentReal = resolveRealPath(path.dirname(absCandidate));
        if (!isInsidePath(realRoot, parentReal)) {
          throw new Error(
            `refusing shadow rewind through symlinked parent directory: ${change.relPath}`,
          );
        }
        if (change.status === "D") {
          toRemove.push(change.relPath);
        } else {
          toCheckout.push(change.relPath);
        }
      }

      if (toCheckout.length > 0) {
        const restoreIndex = path.join(this.gitDir, `restore-${randomUUID()}`);
        try {
          await this.runGit(["read-tree", targetTree], restoreIndex);
          await this.runGit(
            ["checkout-index", "-f", "--", ...toCheckout],
            restoreIndex,
          );
        } finally {
          await fs.rm(restoreIndex, { force: true }).catch(() => undefined);
        }
      }

      const removedAddedFiles: string[] = [];
      for (const rel of toRemove) {
        const full = path.join(this.workspaceRoot, rel);
        try {
          const stat = await fs.lstat(full);
          if (!stat.isDirectory()) {
            await fs.unlink(full);
            removedAddedFiles.push(rel);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }

      ledger.snapshots.splice(targetIdx);
      await this.writeLedger(ledger);

      return {
        snapshot: targetSnapshot,
        restoredFiles: toCheckout,
        removedAddedFiles,
      };
    });
  }
}
