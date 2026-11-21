import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensurePrivateDir } from "./fs.ts";

/**
 * Shared timeout for cross-process read-modify-write locks.
 */
export const CLAIM_LOCK_TIMEOUT_MS = 5_000;
export const CLAIM_LOCK_STALE_MS = 60_000;

export interface ClaimFileLockOptions {
  lockDir: string;
  timeoutMs?: number;
  staleMs?: number;
  busyError: () => Error;
}

interface Claim {
  path: string;
  rank: number;
  nonce: string;
  mtimeMs: number;
}

async function readClaims(lockDir: string): Promise<Claim[]> {
  const entries = await fs.readdir(lockDir).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const claims: Claim[] = [];
  for (const entry of entries) {
    const claimPath = path.join(lockDir, entry);
    let stat;
    try {
      stat = await fs.lstat(claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      continue;
    }
    const raw = await fs.readFile(claimPath, "utf8").catch(() => "");
    let nonce = entry;
    let rankFallback = stat.ctimeMs;
    try {
      const parsed = JSON.parse(raw) as {
        nonce?: unknown;
        created_ms?: unknown;
      };
      if (typeof parsed.nonce === "string" && parsed.nonce.length > 0) {
        nonce = parsed.nonce;
      }
      if (
        Number.isSafeInteger(parsed.created_ms) &&
        (parsed.created_ms as number) >= 0
      ) {
        rankFallback = parsed.created_ms as number;
      }
    } catch {
      // A malformed or partially written claim still blocks older writers.
    }
    const rank = stat.birthtimeMs > 0 ? stat.birthtimeMs : rankFallback;
    claims.push({ path: claimPath, rank, nonce, mtimeMs: stat.mtimeMs });
  }
  return claims;
}

async function pruneStaleClaims(
  lockDir: string,
  staleMs: number,
): Promise<void> {
  const now = Date.now();
  const claims = await readClaims(lockDir).catch(() => []);
  await Promise.all(
    claims
      .filter((claim) => now - claim.mtimeMs > staleMs)
      .map((claim) => fs.unlink(claim.path).catch(() => undefined)),
  );
}

/**
 * Serialize writers with unique claim files in a private directory.
 *
 * No process deletes a shared lock path it did not create. A stale claim is
 * ignored by election and removed by its unique filename, so a contender
 * cannot delete a fresh lock that replaced the one it observed.
 */
export async function withClaimFileLock<T>(
  options: ClaimFileLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 5_000);
  const staleMs = Math.max(1, options.staleMs ?? 60_000);
  await ensurePrivateDir(options.lockDir);
  const nonce = randomUUID();
  const started = Date.now();
  const ownPath = path.join(
    options.lockDir,
    `${started}-${process.pid}-${nonce}.claim`,
  );
  const handle = await fs.open(ownPath, "wx", 0o600);
  let birthtimeMs = started;
  try {
    await handle.writeFile(
      `${JSON.stringify({
        pid: process.pid,
        nonce,
        created_ms: started,
        created_at: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await handle.sync();
    const stat = await handle.stat();
    birthtimeMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : started;
  } finally {
    await handle.close();
  }
  const heartbeat = setInterval(
    () => {
      const now = new Date();
      void fs.utimes(ownPath, now, now).catch(() => undefined);
    },
    Math.max(1_000, Math.floor(staleMs / 3)),
  );
  heartbeat.unref();
  const olderThanMine = (claim: Claim): boolean =>
    claim.nonce !== nonce &&
    Date.now() - claim.mtimeMs <= staleMs &&
    (claim.rank < birthtimeMs ||
      (claim.rank === birthtimeMs && claim.nonce < nonce));
  try {
    for (;;) {
      const older = (await readClaims(options.lockDir)).filter(olderThanMine);
      if (older.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const confirmed = (await readClaims(options.lockDir)).filter(
          olderThanMine,
        );
        if (confirmed.length === 0) {
          break;
        }
      }
      if (Date.now() - started >= timeoutMs) {
        throw options.busyError();
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return await operation();
  } finally {
    clearInterval(heartbeat);
    await fs.unlink(ownPath).catch(() => undefined);
    await pruneStaleClaims(options.lockDir, staleMs);
  }
}
