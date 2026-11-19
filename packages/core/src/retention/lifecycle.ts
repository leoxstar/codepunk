import { createHash, randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import {
  RetentionOperationSchema,
  type RetentionOperation,
  validateSchema,
} from "@codepunk/protocol";
import { ensurePrivateDir, atomicWriteFile } from "../platform/fs.ts";
import { canonicalJson, sha256Text } from "../platform/hash.ts";
import { isInsidePath, normalizeAbsolute } from "../platform/path.ts";
import { readLock, staleLockReason } from "../session/index.ts";

export const STATE_VERSION = 1;
const BACKUP_DIR = "backups";
const RETENTION_DIR = "retention";
const DEFAULT_ROOTS = ["projects", "artifacts"];
const LEGACY_STATE_ENTRIES = [
  "projects",
  "config.toml",
  "trust.json",
  "workspace-trust.json",
  "models.json",
  "auth.json",
  "mcp-auth.json",
  "backups",
  "retention",
  "run",
];

export class RetentionLifecycleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RetentionLifecycleError";
    this.code = code;
  }
}

export interface BackupFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface BackupManifest {
  version: 1;
  id: string;
  created_at: string;
  files: BackupFile[];
  absent: string[];
}

export interface BackupOptions {
  id?: string;
  roots?: string[];
  files?: string[];
  include?: string[];
  waitForWritersMs?: number;
  now?: () => Date;
  leaseMs?: number;
}

export interface RestoreOptions {
  now?: () => Date;
  failAfterWrites?: number;
}

export interface GcCandidate {
  path: string;
  bytes: number;
  reason: string;
}

export interface GcSkip {
  path: string;
  reason: string;
}

export interface LiveWriter {
  project: string;
  session: string;
  dir: string;
}

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function backupRoot(home: string): string {
  return path.join(home, BACKUP_DIR);
}

function operationsPath(home: string): string {
  return path.join(home, RETENTION_DIR, "operations.jsonl");
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(candidate);
      } else if (entry.isFile()) {
        output.push(candidate);
      }
    }
  }
  await walk(root);
  return output.sort();
}

async function liveWriters(
  home: string,
  now: Date,
  leaseMs: number,
): Promise<LiveWriter[]> {
  const projectsDir = path.join(home, "projects");
  const writers: LiveWriter[] = [];
  let projects;
  try {
    projects = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return writers;
  }
  for (const project of projects) {
    if (!project.isDirectory()) {
      continue;
    }
    const sessionsDir = path.join(projectsDir, project.name, "sessions");
    let sessions;
    try {
      sessions = await fs.readdir(sessionsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) {
        continue;
      }
      const lock = await readLock(
        path.join(sessionsDir, session.name, "session.lock"),
      ).catch(() => null);
      if (lock !== null && staleLockReason(lock, now, leaseMs) !== null) {
        writers.push({
          project: project.name,
          session: session.name,
          dir: path.join(sessionsDir, session.name),
        });
      }
    }
  }
  return writers;
}

function relativePath(home: string, candidate: string): string {
  return path.relative(home, candidate).split(path.sep).join("/");
}

function projectForCandidate(relative: string): string | null {
  const parts = relative.split("/");
  if (parts[0] !== "projects" || parts.length < 3) {
    return null;
  }
  return parts[1] ?? null;
}

function writerOverlaps(
  home: string,
  writer: LiveWriter,
  relativeFiles: readonly string[],
): boolean {
  const sessionDir = relativePath(home, writer.dir);
  return relativeFiles.some((candidate) => {
    const normalized = candidate.split(path.sep).join("/");
    return (
      normalized === sessionDir ||
      normalized.startsWith(`${sessionDir}/`) ||
      sessionDir.startsWith(`${normalized}/`)
    );
  });
}

async function waitForWriters(
  home: string,
  options: BackupOptions,
  relativeFiles: readonly string[],
): Promise<void> {
  const deadline = Date.now() + Math.max(0, options.waitForWritersMs ?? 0);
  for (;;) {
    const now = options.now?.() ?? new Date();
    const writers = (
      await liveWriters(home, now, options.leaseMs ?? 120_000)
    ).filter((writer) => writerOverlaps(home, writer, relativeFiles));
    if (writers.length === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new RetentionLifecycleError(
        "retention.active_writer",
        `active session writer(s): ${writers
          .map((writer) => writer.session)
          .join(", ")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function readRetentionOperations(
  home: string,
): Promise<RetentionOperation[]> {
  let lines: string[];
  try {
    lines = (await fs.readFile(operationsPath(home), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const operations: RetentionOperation[] = [];
  let previous: string | null = null;
  for (const [index, line] of lines.entries()) {
    let parsed: RetentionOperation;
    try {
      parsed = JSON.parse(line) as RetentionOperation;
    } catch {
      throw new RetentionLifecycleError(
        "retention.operations_corrupt",
        `retention operation ${index} is not JSON`,
      );
    }
    if (!validateSchema(RetentionOperationSchema, parsed).ok) {
      throw new RetentionLifecycleError(
        "retention.operations_corrupt",
        `retention operation ${index} failed schema validation`,
      );
    }
    if (parsed.seq !== index + 1 || parsed.prev_sha256 !== previous) {
      throw new RetentionLifecycleError(
        "retention.operations_corrupt",
        `retention operation ${index} breaks the hash chain`,
      );
    }
    previous = sha256Text(canonicalJson(parsed));
    operations.push(parsed);
  }
  return operations;
}

export async function appendRetentionOperation(
  home: string,
  operation: Omit<
    RetentionOperation,
    "type" | "version" | "seq" | "prev_sha256"
  >,
): Promise<RetentionOperation> {
  const existing = await readRetentionOperations(home);
  const previous =
    existing.length === 0 ? null : sha256Text(canonicalJson(existing.at(-1)!));
  const record: RetentionOperation = {
    type: "codepunk/retention-operation",
    version: 1,
    seq: existing.length + 1,
    prev_sha256: previous,
    ...operation,
  };
  const file = operationsPath(home);
  await ensurePrivateDir(path.dirname(file));
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

function safeId(id: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(id) || id.includes("..")) {
    throw new RetentionLifecycleError(
      "retention.invalid_backup_id",
      "backup id must use letters, digits, dot, underscore, or hyphen",
    );
  }
  return id;
}

function relativeFiles(home: string, absolute: string[]): string[] {
  const output: string[] = [];
  for (const candidate of absolute) {
    if (!isInsidePath(home, candidate)) {
      throw new RetentionLifecycleError(
        "retention.path_escape",
        `${candidate} is outside CODEPUNK_HOME`,
      );
    }
    output.push(path.relative(home, candidate));
  }
  return output;
}

export async function createBackup(
  homeInput: string,
  options: BackupOptions = {},
): Promise<BackupManifest> {
  const home = normalizeAbsolute(homeInput);
  const now = options.now?.() ?? new Date();
  let relative: string[];
  if (options.files !== undefined) {
    relative = options.files.map((candidate) => {
      const normalized = path.normalize(candidate);
      if (
        path.isAbsolute(normalized) ||
        normalized.startsWith("..") ||
        normalized.length === 0
      ) {
        throw new RetentionLifecycleError(
          "retention.path_escape",
          `${candidate} is not a relative path`,
        );
      }
      return normalized;
    });
  } else {
    const absolute: string[] = [];
    for (const root of options.roots ?? DEFAULT_ROOTS) {
      absolute.push(...(await listFiles(path.join(home, root))));
    }
    relative = relativeFiles(home, absolute);
    relative.push(...(options.include ?? []));
  }
  await waitForWriters(home, options, relative);
  const id = safeId(
    options.id ??
      `backup-${now.toISOString().replace(/[^0-9]/gu, "")}-${randomBytes(3).toString("hex")}`,
  );
  const destination = path.join(backupRoot(home), id);
  try {
    await fs.lstat(destination);
    throw new RetentionLifecycleError(
      "retention.backup_exists",
      `backup ${id} already exists`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await ensurePrivateDir(path.join(destination, "files"));
  const files: BackupFile[] = [];
  const absent: string[] = [];
  for (const relativePath of [...new Set(relative)].sort()) {
    const source = path.join(home, relativePath);
    let bytes;
    try {
      bytes = await fs.readFile(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        absent.push(relativePath.split(path.sep).join("/"));
        continue;
      }
      throw error;
    }
    const target = path.join(destination, "files", relativePath);
    await ensurePrivateDir(path.dirname(target));
    await fs.writeFile(target, bytes, { mode: 0o600 });
    files.push({
      path: relativePath.split(path.sep).join("/"),
      sha256: hashBytes(bytes),
      bytes: bytes.byteLength,
    });
  }
  const manifest: BackupManifest = {
    version: 1,
    id,
    created_at: now.toISOString(),
    files,
    absent,
  };
  await atomicWriteFile(
    path.join(destination, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o600,
  );
  return manifest;
}

export async function listBackups(
  homeInput: string,
): Promise<BackupManifest[]> {
  const home = normalizeAbsolute(homeInput);
  let entries;
  try {
    entries = await fs.readdir(backupRoot(home), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const manifests: BackupManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const parsed = JSON.parse(
        await fs.readFile(
          path.join(backupRoot(home), entry.name, "manifest.json"),
          "utf8",
        ),
      ) as BackupManifest;
      if (parsed.version === 1 && Array.isArray(parsed.files)) {
        manifests.push({ ...parsed, absent: parsed.absent ?? [] });
      }
    } catch {
      // An incomplete backup directory is not listed as restorable.
    }
  }
  return manifests.sort((left, right) =>
    left.created_at.localeCompare(right.created_at),
  );
}

export async function loadBackup(
  homeInput: string,
  idInput: string,
): Promise<BackupManifest> {
  const home = normalizeAbsolute(homeInput);
  const id = safeId(idInput);
  try {
    const parsed = JSON.parse(
      await fs.readFile(
        path.join(backupRoot(home), id, "manifest.json"),
        "utf8",
      ),
    ) as BackupManifest;
    if (
      parsed.version !== 1 ||
      parsed.id !== id ||
      !Array.isArray(parsed.files) ||
      (parsed.absent !== undefined &&
        (!Array.isArray(parsed.absent) ||
          !parsed.absent.every((entry) => typeof entry === "string")))
    ) {
      throw new Error("manifest shape is invalid");
    }
    return { ...parsed, absent: parsed.absent ?? [] };
  } catch (error) {
    throw new RetentionLifecycleError(
      "retention.backup_missing",
      `backup ${id} cannot be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function verifyBackup(
  home: string,
  manifest: BackupManifest,
): Promise<Map<string, Buffer>> {
  const contents = new Map<string, Buffer>();
  for (const file of manifest.files) {
    const source = path.join(backupRoot(home), manifest.id, "files", file.path);
    let bytes;
    try {
      bytes = await fs.readFile(source);
    } catch {
      throw new RetentionLifecycleError(
        "retention.backup_corrupt",
        `backup ${manifest.id} is missing ${file.path}`,
      );
    }
    if (bytes.byteLength !== file.bytes || hashBytes(bytes) !== file.sha256) {
      throw new RetentionLifecycleError(
        "retention.backup_corrupt",
        `backup ${manifest.id} has a hash mismatch for ${file.path}`,
      );
    }
    contents.set(file.path, bytes);
  }
  return contents;
}

export async function restoreBackup(
  homeInput: string,
  id: string,
  options: RestoreOptions = {},
): Promise<BackupManifest> {
  const home = normalizeAbsolute(homeInput);
  const manifest = await loadBackup(home, id);
  const contents = await verifyBackup(home, manifest);
  const now = options.now?.() ?? new Date();
  const writers = await liveWriters(home, now, 120_000);
  if (writers.length > 0) {
    throw new RetentionLifecycleError(
      "retention.active_writer",
      `restore refused while session writer(s) are live: ${writers
        .map((writer) => writer.session)
        .join(", ")}`,
    );
  }
  const pre = await createBackup(home, {
    id: `pre-restore-${manifest.id}-${Date.now()}`,
    files: manifest.files.map((file) => file.path),
    now: () => now,
  });
  const originals = new Map<string, Buffer | null>();
  for (const file of manifest.files) {
    try {
      originals.set(file.path, await fs.readFile(path.join(home, file.path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      originals.set(file.path, null);
    }
  }
  let written = 0;
  try {
    for (const file of manifest.files) {
      if (
        options.failAfterWrites !== undefined &&
        written >= options.failAfterWrites
      ) {
        throw new Error("injected restore write failure");
      }
      const target = path.join(home, file.path);
      await ensurePrivateDir(path.dirname(target));
      const temporary = `${target}.restore-${process.pid}`;
      await fs.writeFile(temporary, contents.get(file.path)!, { mode: 0o600 });
      await fs.rename(temporary, target);
      written += 1;
    }
    for (const relativePath of manifest.absent ?? []) {
      await fs.rm(path.join(home, relativePath), { force: true });
    }
  } catch (error) {
    for (const [relativePath, bytes] of originals) {
      const target = path.join(home, relativePath);
      if (bytes === null) {
        await fs.rm(target, { force: true });
        continue;
      }
      await ensurePrivateDir(path.dirname(target));
      await fs.writeFile(target, bytes, { mode: 0o600 });
    }
    await appendRetentionOperation(home, {
      at: now.toISOString(),
      action: "backup.restore",
      mode: "restore",
      paths: manifest.files.map((file) => ({
        path: file.path,
        before_sha256: null,
        after_sha256: file.sha256,
        bytes: file.bytes,
      })),
      backup_id: manifest.id,
      exit_code: 1,
      failure: error instanceof Error ? error.message : String(error),
    });
    throw new RetentionLifecycleError(
      "retention.restore_failed",
      `restore failed and was rolled back: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  await appendRetentionOperation(home, {
    at: now.toISOString(),
    action: "backup.restore",
    mode: "restore",
    paths: manifest.files.map((file) => ({
      path: file.path,
      before_sha256:
        pre.files.find((entry) => entry.path === file.path)?.sha256 ?? null,
      after_sha256: file.sha256,
      bytes: file.bytes,
    })),
    backup_id: manifest.id,
    exit_code: 0,
    failure: null,
  });
  return manifest;
}

export async function planGc(
  homeInput: string,
  options: { now?: Date; olderThanMs?: number } = {},
): Promise<GcCandidate[]> {
  const home = normalizeAbsolute(homeInput);
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - (options.olderThanMs ?? 7 * 86_400_000);
  const artifactRoots = [path.join(home, "artifacts")];
  try {
    for (const project of await fs.readdir(path.join(home, "projects"), {
      withFileTypes: true,
    })) {
      if (project.isDirectory()) {
        artifactRoots.push(
          path.join(home, "projects", project.name, "artifacts"),
        );
      }
    }
  } catch {
    // A fresh home has no projects directory yet.
  }
  const candidates: GcCandidate[] = [];
  for (const artifacts of artifactRoots) {
    for (const file of await listFiles(artifacts)) {
      const stat = await fs.stat(file);
      if (stat.mtimeMs < cutoff) {
        candidates.push({
          path: path.relative(home, file).split(path.sep).join("/"),
          bytes: stat.size,
          reason: "artifact_older_than_cutoff",
        });
      }
    }
  }
  return candidates.sort((left, right) => left.path.localeCompare(right.path));
}

export interface GcResult {
  dry_run: boolean;
  candidates: GcCandidate[];
  backup_id: string | null;
  deleted: string[];
  skipped: GcSkip[];
}

export async function applyGc(
  homeInput: string,
  options: { dryRun?: boolean; now?: Date; olderThanMs?: number } = {},
): Promise<GcResult> {
  const home = normalizeAbsolute(homeInput);
  const candidates = await planGc(home, options);
  if (options.dryRun !== false) {
    return {
      dry_run: true,
      candidates,
      backup_id: null,
      deleted: [],
      skipped: [],
    };
  }
  const now = options.now ?? new Date();
  const writers = await liveWriters(home, now, 120_000);
  const skipped: GcSkip[] = [];
  const deletable: GcCandidate[] = [];
  for (const candidate of candidates) {
    const writer = writers.find((entry) =>
      writerOverlaps(home, entry, [candidate.path]),
    );
    if (writer !== undefined) {
      skipped.push({
        path: candidate.path,
        reason: `active_writer:${writer.session}`,
      });
      continue;
    }
    const project = projectForCandidate(candidate.path);
    if (
      project !== null &&
      writers.some((entry) => entry.project === project)
    ) {
      skipped.push({
        path: candidate.path,
        reason: `active_writer_project:${project}`,
      });
      continue;
    }
    deletable.push(candidate);
  }
  let backup: BackupManifest | null = null;
  if (deletable.length > 0) {
    backup = await createBackup(home, {
      files: deletable.map((candidate) => candidate.path),
      now: () => now,
    });
  }
  const deleted: string[] = [];
  for (const candidate of deletable) {
    const target = path.join(home, candidate.path);
    await fs.rm(target, { force: true });
    deleted.push(candidate.path);
  }
  await appendRetentionOperation(home, {
    at: now.toISOString(),
    action: "gc",
    mode: "apply",
    paths: deletable.map((candidate) => ({
      path: candidate.path,
      before_sha256:
        backup?.files.find((file) => file.path === candidate.path)?.sha256 ??
        null,
      after_sha256: null,
      bytes: candidate.bytes,
    })),
    backup_id: backup?.id ?? null,
    exit_code: skipped.length === 0 ? 0 : 1,
    failure:
      skipped.length === 0
        ? null
        : `skipped ${skipped.length} candidate(s) with active writers`,
  });
  return {
    dry_run: false,
    candidates,
    backup_id: backup?.id ?? null,
    deleted,
    skipped,
  };
}

export interface MigrationStatus {
  current: number;
  target: number;
  required: boolean;
}

async function stateVersion(home: string): Promise<number> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(home, "state-version.json"), "utf8"),
    ) as { version?: unknown };
    return typeof parsed.version === "number" ? parsed.version : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      for (const entry of LEGACY_STATE_ENTRIES) {
        if (existsSync(path.join(home, entry))) {
          return 0;
        }
      }
      return STATE_VERSION;
    }
    return 0;
  }
}

export async function initializeStateVersion(homeInput: string) {
  const home = normalizeAbsolute(homeInput);
  const statePath = path.join(home, "state-version.json");
  try {
    await fs.access(statePath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await atomicWriteFile(
    statePath,
    `${JSON.stringify({ version: STATE_VERSION }, null, 2)}\n`,
    0o600,
  );
}

export async function checkMigration(
  homeInput: string,
): Promise<MigrationStatus> {
  const current = await stateVersion(normalizeAbsolute(homeInput));
  return {
    current,
    target: STATE_VERSION,
    required: current < STATE_VERSION,
  };
}

export async function applyMigration(
  homeInput: string,
  options: { failAfterWrites?: number; now?: Date } = {},
): Promise<{ status: MigrationStatus; backup_id: string | null }> {
  const home = normalizeAbsolute(homeInput);
  const status = await checkMigration(home);
  if (!status.required) {
    return { status, backup_id: null };
  }
  const now = options.now ?? new Date();
  const backup = await createBackup(home, {
    now: () => now,
    include: ["state-version.json"],
  });
  try {
    if (options.failAfterWrites !== undefined && options.failAfterWrites <= 0) {
      throw new Error("injected migration write failure");
    }
    await atomicWriteFile(
      path.join(home, "state-version.json"),
      `${JSON.stringify({ version: STATE_VERSION }, null, 2)}\n`,
      0o600,
    );
  } catch (error) {
    await restoreBackup(home, backup.id, { now: () => now });
    await appendRetentionOperation(home, {
      at: now.toISOString(),
      action: "migrate",
      mode: "apply",
      paths: [
        {
          path: "state-version.json",
          before_sha256: null,
          after_sha256: null,
          bytes: 0,
        },
      ],
      backup_id: backup.id,
      exit_code: 1,
      failure: error instanceof Error ? error.message : String(error),
    });
    throw new RetentionLifecycleError(
      "retention.migration_failed",
      `migration failed and was restored: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  await appendRetentionOperation(home, {
    at: now.toISOString(),
    action: "migrate",
    mode: "apply",
    paths: [
      {
        path: "state-version.json",
        before_sha256: null,
        after_sha256: hashBytes(Buffer.from(`${STATE_VERSION}`)),
        bytes: `${STATE_VERSION}`.length,
      },
    ],
    backup_id: backup.id,
    exit_code: 0,
    failure: null,
  });
  return { status, backup_id: backup.id };
}

export async function hasLiveWriter(
  home: string,
  leaseMs = 120_000,
): Promise<boolean> {
  return (
    (await liveWriters(normalizeAbsolute(home), new Date(), leaseMs)).length > 0
  );
}
