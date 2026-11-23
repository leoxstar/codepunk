import { promises as fs } from "node:fs";
import path from "node:path";
import { FormatVersionError, checkStoreVersion } from "../compat/index.ts";
import { ensurePrivateDir, atomicWriteFile } from "../platform/fs.ts";
import type { ProjectPaths } from "../platform/paths.ts";

export interface ClaimRecord {
  claim_id: string;
  task_id: string;
  owner: string;
  fence: number;
  acquired_at: string;
  renewed_at: string;
  expires_at: string;
}

interface ClaimFile {
  version: 1;
  next_fence: number;
  claims: Record<string, ClaimRecord>;
}

export class ClaimConflictError extends Error {
  readonly taskId: string;

  constructor(taskId: string, message = `task ${taskId} is already claimed`) {
    super(message);
    this.name = "ClaimConflictError";
    this.taskId = taskId;
  }
}

export class ClaimStaleError extends Error {
  constructor(message = "claim is stale or no longer matches the live claim") {
    super(message);
    this.name = "ClaimStaleError";
  }
}

function emptyFile(): ClaimFile {
  return { version: 1, next_fence: 0, claims: {} };
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ClaimStore {
  readonly filePath: string;
  readonly lockPath: string;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly lockTimeoutMs: number;

  constructor(options: {
    paths: ProjectPaths;
    leaseMs?: number;
    lockTimeoutMs?: number;
    now?: () => Date;
  }) {
    this.filePath = path.join(options.paths.projectDir, "claims.json");
    this.lockPath = path.join(options.paths.projectDir, "claims.lock");
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 60_000;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await ensurePrivateDir(path.dirname(this.filePath));
    const deadline = Date.now() + this.lockTimeoutMs;
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    while (handle === null) {
      try {
        handle = await fs.open(this.lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        try {
          const stat = await fs.stat(this.lockPath);
          if (Date.now() - stat.mtimeMs > this.lockTimeoutMs) {
            await fs.unlink(this.lockPath);
            continue;
          }
        } catch {
          // The lock disappeared between open and stat.
        }
        if (Date.now() >= deadline) {
          throw new Error("timed out waiting for the claim store lock");
        }
        await sleep(10);
      }
    }
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, at: this.now().toISOString() }),
      );
      return await operation();
    } finally {
      await handle.close();
      await fs.unlink(this.lockPath).catch(() => undefined);
    }
  }

  private async read(): Promise<ClaimFile> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.filePath, "utf8"),
      ) as unknown;
      if (parsed === null || typeof parsed !== "object") {
        throw new Error("claim store is corrupt");
      }
      // Spec 0016 C3: refuse (do not rewrite) a version that is missing, not
      // a positive integer, or newer than this build; older versions read.
      try {
        checkStoreVersion("claim store", (parsed as ClaimFile).version, 1);
      } catch (error) {
        if (error instanceof FormatVersionError) {
          throw new Error(error.message);
        }
        throw error;
      }
      if (
        !Number.isSafeInteger((parsed as ClaimFile).next_fence) ||
        (parsed as ClaimFile).next_fence < 0 ||
        (parsed as ClaimFile).claims === null ||
        typeof (parsed as ClaimFile).claims !== "object"
      ) {
        throw new Error("claim store is corrupt");
      }
      return parsed as ClaimFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyFile();
      }
      throw error;
    }
  }

  private async write(file: ClaimFile): Promise<void> {
    await atomicWriteFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }

  private isLive(claim: ClaimRecord): boolean {
    return Date.parse(claim.expires_at) > this.now().getTime();
  }

  async acquire(taskId: string, owner: string): Promise<ClaimRecord> {
    if (taskId.length === 0 || owner.length === 0) {
      throw new Error("claim task and owner are required");
    }
    return this.withLock(async () => {
      const file = await this.read();
      const existing = file.claims[taskId];
      if (existing !== undefined && this.isLive(existing)) {
        throw new ClaimConflictError(taskId);
      }
      file.next_fence += 1;
      const now = this.now();
      const claim: ClaimRecord = {
        claim_id: `${taskId}-${file.next_fence}`,
        task_id: taskId,
        owner,
        fence: file.next_fence,
        acquired_at: now.toISOString(),
        renewed_at: now.toISOString(),
        expires_at: new Date(now.getTime() + this.leaseMs).toISOString(),
      };
      file.claims[taskId] = claim;
      await this.write(file);
      return claim;
    });
  }

  async renew(claim: ClaimRecord): Promise<ClaimRecord> {
    return this.withLock(async () => {
      const file = await this.read();
      const current = file.claims[claim.task_id];
      if (
        current === undefined ||
        current.claim_id !== claim.claim_id ||
        current.fence !== claim.fence ||
        current.owner !== claim.owner
      ) {
        throw new ClaimStaleError();
      }
      if (!this.isLive(current)) {
        throw new ClaimStaleError();
      }
      const now = this.now();
      const renewed = {
        ...current,
        renewed_at: now.toISOString(),
        expires_at: new Date(now.getTime() + this.leaseMs).toISOString(),
      };
      file.claims[claim.task_id] = renewed;
      await this.write(file);
      return renewed;
    });
  }

  async release(claim: ClaimRecord): Promise<void> {
    await this.withLock(async () => {
      const file = await this.read();
      const current = file.claims[claim.task_id];
      if (
        current !== undefined &&
        current.claim_id === claim.claim_id &&
        current.fence === claim.fence &&
        current.owner === claim.owner
      ) {
        delete file.claims[claim.task_id];
        await this.write(file);
      }
    });
  }

  async inspect(taskId: string): Promise<ClaimRecord | null> {
    return this.withLock(async () => {
      const file = await this.read();
      const claim = file.claims[taskId];
      if (claim === undefined) {
        return null;
      }
      return this.isLive(claim) ? claim : null;
    });
  }

  async assertLive(claim: ClaimRecord): Promise<void> {
    const current = await this.inspect(claim.task_id);
    if (
      current === null ||
      current.claim_id !== claim.claim_id ||
      current.fence !== claim.fence ||
      current.owner !== claim.owner
    ) {
      throw new ClaimStaleError();
    }
  }

  async nextFence(): Promise<number> {
    return this.withLock(async () => (await this.read()).next_fence);
  }
}
