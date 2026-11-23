import { promises as fs } from "node:fs";
import path from "node:path";
import { FormatVersionError, checkStoreVersion } from "../compat/index.ts";
import {
  atomicWriteBytes,
  ensurePrivateDir,
  ensurePrivateFile,
  readJsonFile,
  writeJsonAtomic,
} from "../platform/fs.ts";
import { createUlid, sha256Bytes } from "../platform/hash.ts";
import {
  isInsidePath,
  normalizeAbsolute,
  relativeDisplayPath,
  resolveRealPath,
} from "../platform/path.ts";

const CHECKPOINT_VERSION = 1;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 100;
const EMPTY_SHA256 = sha256Bytes(Buffer.alloc(0));

export interface CheckpointSnapshot {
  exists: boolean;
  bytes: Buffer;
  sha256: string;
  mode: number | null;
}

export interface CheckpointStoredSnapshot {
  exists: boolean;
  sha256: string;
  bytes: number;
  mode: number | null;
  blob: string | null;
}

export interface CheckpointEntry {
  id: string;
  tool_call_id: string;
  tool: "write" | "edit";
  target: string;
  display_target: string;
  before: CheckpointStoredSnapshot;
  after: CheckpointStoredSnapshot;
  state: "applied" | "undone";
  created_at: string;
}

interface CheckpointIndex {
  version: 1;
  undo_stack: string[];
  checkpoints: CheckpointEntry[];
}

export interface CheckpointStoreOptions {
  sessionDir: string;
  workspaceRoot: string;
  additionalRoots?: readonly string[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
  now?: () => Date;
}

export interface CheckpointRestoreResult {
  action: "undo" | "redo";
  entries: CheckpointEntry[];
}

export interface CheckpointPreview {
  action: "undo" | "redo";
  entries: CheckpointEntry[];
}

export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointError";
  }
}

export class CheckpointConflictError extends CheckpointError {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointConflictError";
  }
}

function emptyStoredSnapshot(): CheckpointStoredSnapshot {
  return {
    exists: false,
    sha256: EMPTY_SHA256,
    bytes: 0,
    mode: null,
    blob: null,
  };
}

function emptySnapshot(): CheckpointSnapshot {
  return {
    exists: false,
    bytes: Buffer.alloc(0),
    sha256: EMPTY_SHA256,
    mode: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function validToolCallId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validBlob(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      path.basename(value) === value)
  );
}

function validStoredSnapshot(
  value: unknown,
): value is CheckpointStoredSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["exists"] === "boolean" &&
    typeof value["sha256"] === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(value["sha256"]) &&
    Number.isSafeInteger(value["bytes"]) &&
    (value["bytes"] as number) >= 0 &&
    (value["mode"] === null ||
      (Number.isSafeInteger(value["mode"]) &&
        (value["mode"] as number) >= 0 &&
        (value["mode"] as number) <= 0o7777)) &&
    validBlob(value["blob"])
  );
}

function validEntry(value: unknown): value is CheckpointEntry {
  if (!isRecord(value)) {
    return false;
  }
  return (
    validId(value["id"]) &&
    validToolCallId(value["tool_call_id"]) &&
    (value["tool"] === "write" || value["tool"] === "edit") &&
    typeof value["target"] === "string" &&
    path.isAbsolute(value["target"]) &&
    typeof value["display_target"] === "string" &&
    value["display_target"].length > 0 &&
    validStoredSnapshot(value["before"]) &&
    validStoredSnapshot(value["after"]) &&
    (value["state"] === "applied" || value["state"] === "undone") &&
    typeof value["created_at"] === "string"
  );
}

function parseIndex(value: unknown): CheckpointIndex {
  if (!isRecord(value)) {
    throw new CheckpointError("checkpoint index is invalid");
  }
  // Spec 0016 C3: name the saved and current versions instead of a generic
  // rejection; older indexes read, unacceptable ones refuse without rewrite.
  try {
    checkStoreVersion("checkpoint index", value["version"], CHECKPOINT_VERSION);
  } catch (error) {
    if (error instanceof FormatVersionError) {
      throw new CheckpointError(error.message);
    }
    throw error;
  }
  if (
    !Array.isArray(value["undo_stack"]) ||
    !Array.isArray(value["checkpoints"]) ||
    !value["checkpoints"].every(validEntry) ||
    !value["undo_stack"].every(validId)
  ) {
    throw new CheckpointError("checkpoint index is invalid");
  }
  return {
    version: CHECKPOINT_VERSION,
    undo_stack: [...value["undo_stack"]],
    checkpoints: [...value["checkpoints"]],
  };
}

function snapshotSize(snapshot: CheckpointStoredSnapshot): number {
  return snapshot.exists ? snapshot.bytes : 0;
}

function entrySize(entry: CheckpointEntry): number {
  return snapshotSize(entry.before) + snapshotSize(entry.after);
}

export class CheckpointStore {
  readonly sessionDir: string;
  readonly checkpointsDir: string;
  private readonly indexPath: string;
  private readonly workspaceRoot: string;
  private readonly additionalRoots: readonly string[];
  private readonly allowedRoots: readonly string[];
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxEntries: number;
  private readonly now: () => Date;

  constructor(options: CheckpointStoreOptions) {
    this.sessionDir = normalizeAbsolute(options.sessionDir);
    this.checkpointsDir = path.join(this.sessionDir, "checkpoints");
    this.indexPath = path.join(this.checkpointsDir, "index.json");
    this.workspaceRoot = resolveRealPath(options.workspaceRoot);
    this.additionalRoots = (options.additionalRoots ?? []).map((entry) =>
      resolveRealPath(entry),
    );
    this.allowedRoots = [this.workspaceRoot, ...this.additionalRoots];
    this.maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    this.now = options.now ?? (() => new Date());
  }

  private async loadIndex(): Promise<CheckpointIndex> {
    const raw = await readJsonFile<unknown>(this.indexPath);
    if (raw === null) {
      return {
        version: CHECKPOINT_VERSION,
        undo_stack: [],
        checkpoints: [],
      };
    }
    return parseIndex(raw);
  }

  private blobPath(blob: string): string {
    return path.join(this.checkpointsDir, blob);
  }

  private assertTarget(target: string): string {
    const normalized = normalizeAbsolute(target);
    const resolved = resolveRealPath(normalized);
    if (resolved !== normalized) {
      throw new CheckpointConflictError(
        `checkpoint target now resolves through a symlink: ${normalized}`,
      );
    }
    if (
      !this.allowedRoots.some(
        (root) =>
          isInsidePath(root, normalized) && isInsidePath(root, resolved),
      )
    ) {
      throw new CheckpointError(
        `checkpoint target is outside the writable workspace: ${normalized}`,
      );
    }
    for (const root of this.allowedRoots) {
      if (
        isInsidePath(path.join(root, ".git"), normalized) ||
        isInsidePath(path.join(root, ".codepunk"), normalized)
      ) {
        throw new CheckpointError(
          `checkpoint target is a protected path: ${normalized}`,
        );
      }
    }
    return normalized;
  }

  private async currentSnapshot(target: string): Promise<CheckpointSnapshot> {
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new CheckpointConflictError(
          `checkpoint target is not a regular file: ${target}`,
        );
      }
      const bytes = await fs.readFile(target);
      return {
        exists: true,
        bytes,
        sha256: sha256Bytes(bytes),
        mode: stat.mode & 0o7777,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptySnapshot();
      }
      throw error;
    }
  }

  private async writeBlob(
    id: string,
    suffix: "before" | "after",
    bytes: Buffer,
  ): Promise<string> {
    const name = `${id}-${suffix}.bin`;
    await ensurePrivateDir(this.checkpointsDir);
    const filePath = this.blobPath(name);
    const handle = await fs.open(filePath, "wx", 0o600);
    let committed = false;
    try {
      await ensurePrivateFile(filePath);
      await handle.writeFile(bytes);
      await handle.sync();
      committed = true;
    } finally {
      await handle.close();
      if (!committed) {
        await fs.unlink(filePath).catch(() => undefined);
      }
    }
    return name;
  }

  private storedSnapshot(
    snapshot: CheckpointSnapshot,
    blob: string | null,
  ): CheckpointStoredSnapshot {
    if (!snapshot.exists) {
      return emptyStoredSnapshot();
    }
    return {
      exists: true,
      sha256: snapshot.sha256,
      bytes: snapshot.bytes.length,
      mode: snapshot.mode,
      blob,
    };
  }

  private async prune(
    index: CheckpointIndex,
  ): Promise<{ removed: CheckpointEntry[]; removedBytes: number }> {
    const removed: CheckpointEntry[] = [];
    let total = index.checkpoints.reduce(
      (sum, entry) => sum + entrySize(entry),
      0,
    );
    while (
      index.checkpoints.length > this.maxEntries ||
      total > this.maxTotalBytes
    ) {
      const oldest = index.checkpoints.shift();
      if (oldest === undefined) {
        break;
      }
      removed.push(oldest);
      total -= entrySize(oldest);
      index.undo_stack = index.undo_stack.filter((id) => id !== oldest.id);
    }
    return {
      removed,
      removedBytes: removed.reduce((sum, entry) => sum + entrySize(entry), 0),
    };
  }

  async record(input: {
    tool: "write" | "edit";
    toolCallId: string;
    target: string;
    before: CheckpointSnapshot;
    after: CheckpointSnapshot;
  }): Promise<CheckpointEntry | null> {
    if (!validToolCallId(input.toolCallId)) {
      return null;
    }
    if (
      input.before.exists === input.after.exists &&
      input.before.sha256 === input.after.sha256
    ) {
      return null;
    }
    if (
      input.before.bytes.length > this.maxFileBytes ||
      input.after.bytes.length > this.maxFileBytes
    ) {
      return null;
    }
    const target = this.assertTarget(input.target);
    await ensurePrivateDir(this.checkpointsDir);
    const id = createUlid(this.now());
    const beforeBlob = input.before.exists
      ? await this.writeBlob(id, "before", input.before.bytes)
      : null;
    let afterBlob: string | null = null;
    try {
      afterBlob = input.after.exists
        ? await this.writeBlob(id, "after", input.after.bytes)
        : null;
      const index = await this.loadIndex();
      const entry: CheckpointEntry = {
        id,
        tool_call_id: input.toolCallId,
        tool: input.tool,
        target,
        display_target: relativeDisplayPath(this.workspaceRoot, target),
        before: this.storedSnapshot(input.before, beforeBlob),
        after: this.storedSnapshot(input.after, afterBlob),
        state: "applied",
        created_at: this.now().toISOString(),
      };
      index.checkpoints.push(entry);
      // A new mutation invalidates any redo stack. Undone entries stay in the
      // index for auditability but cannot be replayed across a newer change.
      index.undo_stack = [];
      const pruned = await this.prune(index);
      await writeJsonAtomic(this.indexPath, index);
      for (const removed of pruned.removed) {
        for (const snapshot of [removed.before, removed.after]) {
          if (snapshot.blob !== null) {
            await fs.unlink(this.blobPath(snapshot.blob)).catch(() => {});
          }
        }
      }
      return entry;
    } catch (error) {
      for (const blob of [beforeBlob, afterBlob]) {
        if (blob !== null) {
          await fs.unlink(this.blobPath(blob)).catch(() => {});
        }
      }
      throw error;
    }
  }

  async list(): Promise<readonly CheckpointEntry[]> {
    return (await this.loadIndex()).checkpoints;
  }

  private async selected(
    action: "undo" | "redo",
    count: number,
  ): Promise<{
    index: CheckpointIndex;
    entries: CheckpointEntry[];
  }> {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new CheckpointError("checkpoint count must be a positive integer");
    }
    const index = await this.loadIndex();
    const ids =
      action === "undo"
        ? index.checkpoints
            .filter((entry) => entry.state === "applied")
            .map((entry) => entry.id)
            .slice(-count)
            .reverse()
        : index.undo_stack.slice(-count).reverse();
    const entries: CheckpointEntry[] = [];
    for (const id of ids) {
      const entry = index.checkpoints.find((candidate) => candidate.id === id);
      if (entry === undefined) {
        throw new CheckpointError(`checkpoint ${id} is missing from the index`);
      }
      const expectedState = action === "undo" ? "applied" : "undone";
      if (entry.state !== expectedState) {
        throw new CheckpointError(
          `checkpoint ${id} is ${entry.state}, not ${expectedState}`,
        );
      }
      this.assertTarget(entry.target);
      entries.push(entry);
    }
    return { index, entries };
  }

  async preview(
    action: "undo" | "redo",
    count = 1,
  ): Promise<CheckpointPreview> {
    const { entries } = await this.selected(action, count);
    if (entries.length === 0) {
      return { action, entries: [] };
    }
    const virtual = new Map<string, CheckpointSnapshot>();
    const ordered = entries;
    for (const entry of ordered) {
      const current =
        virtual.get(entry.target) ?? (await this.currentSnapshot(entry.target));
      const expected = action === "undo" ? entry.after : entry.before;
      if (
        current.exists !== expected.exists ||
        current.sha256 !== expected.sha256
      ) {
        throw new CheckpointConflictError(
          `${entry.display_target} changed after this checkpoint; refusing to overwrite it (current ${current.sha256}, expected ${expected.sha256})`,
        );
      }
      virtual.set(
        entry.target,
        action === "undo"
          ? {
              exists: entry.before.exists,
              bytes: Buffer.alloc(0),
              sha256: entry.before.sha256,
              mode: entry.before.mode,
            }
          : {
              exists: entry.after.exists,
              bytes: Buffer.alloc(0),
              sha256: entry.after.sha256,
              mode: entry.after.mode,
            },
      );
    }
    return { action, entries };
  }

  private async writeSnapshot(
    target: string,
    snapshot: CheckpointSnapshot | CheckpointStoredSnapshot,
    blobBytes?: Buffer,
  ): Promise<void> {
    if (!snapshot.exists) {
      await fs.unlink(target).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      });
      return;
    }
    const bytes =
      blobBytes ??
      (snapshot instanceof Object && "bytes" in snapshot
        ? (snapshot as CheckpointSnapshot).bytes
        : undefined);
    if (bytes === undefined) {
      throw new CheckpointError(`checkpoint has no bytes for ${target}`);
    }
    await atomicWriteBytes(target, bytes, snapshot.mode ?? 0o600);
  }

  async restore(
    action: "undo" | "redo",
    count = 1,
  ): Promise<CheckpointRestoreResult> {
    const { index, entries } = await this.selected(action, count);
    await this.preview(action, count);
    const ordered = entries;
    const blobs = new Map<string, Buffer>();
    for (const entry of ordered) {
      const source = action === "undo" ? entry.before : entry.after;
      if (!source.exists) {
        continue;
      }
      if (source.blob === null) {
        throw new CheckpointError(`checkpoint ${entry.id} has no file blob`);
      }
      const bytes = await fs.readFile(this.blobPath(source.blob));
      if (sha256Bytes(bytes) !== source.sha256) {
        throw new CheckpointError(
          `checkpoint ${entry.id} blob failed its digest check`,
        );
      }
      blobs.set(entry.id, bytes);
    }
    const backups = new Map<string, CheckpointSnapshot>();
    for (const entry of ordered) {
      if (!backups.has(entry.target)) {
        backups.set(entry.target, await this.currentSnapshot(entry.target));
      }
    }
    const applied: string[] = [];
    try {
      for (const entry of ordered) {
        const expected = action === "undo" ? entry.after : entry.before;
        const current = await this.currentSnapshot(entry.target);
        if (
          current.exists !== expected.exists ||
          current.sha256 !== expected.sha256
        ) {
          throw new CheckpointConflictError(
            `${entry.display_target} changed after this checkpoint; refusing to overwrite it (current ${current.sha256}, expected ${expected.sha256})`,
          );
        }
        const source = action === "undo" ? entry.before : entry.after;
        await this.writeSnapshot(
          entry.target,
          source,
          source.exists ? blobs.get(entry.id) : undefined,
        );
        applied.push(entry.target);
        entry.state = action === "undo" ? "undone" : "applied";
      }
    } catch (error) {
      // A multi-file undo is not a filesystem transaction. If a later write
      // fails, put every target touched by this operation back to the bytes
      // observed during preflight so the index does not claim a partial undo.
      for (const target of [...new Set(applied)].reverse()) {
        const backup = backups.get(target);
        if (backup !== undefined) {
          await this.writeSnapshot(target, backup).catch(() => {});
        }
      }
      throw error;
    }
    index.undo_stack = index.undo_stack.filter(
      (id) => !entries.some((entry) => entry.id === id),
    );
    if (action === "undo") {
      index.undo_stack.push(...entries.map((entry) => entry.id));
    }
    await writeJsonAtomic(this.indexPath, index);
    return {
      action,
      entries: ordered,
    };
  }

  async undo(count = 1): Promise<CheckpointRestoreResult> {
    return this.restore("undo", count);
  }

  async redo(count = 1): Promise<CheckpointRestoreResult> {
    return this.restore("redo", count);
  }
}
