import { promises as fs } from "node:fs";
import path from "node:path";
import {
  AgentStateSchema,
  SessionEventSchema,
  SessionHeaderSchema,
  SessionMetaSchema,
  validateSchema,
  type AgentState,
  type SessionEvent,
  type SessionHeader,
  type SessionMeta,
} from "codepunk-protocol";
import { ensurePrivateDir } from "../platform/fs.ts";
import { sha256Bytes, sha256Text, sha256Value } from "../platform/hash.ts";
import { isInsidePath, normalizeAbsolute } from "../platform/path.ts";
import {
  assertSupportedStateVersion,
  createBackup,
  loadBackup,
  restoreBackup,
  RetentionLifecycleError,
} from "../retention/lifecycle.ts";
import {
  SessionLockedError,
  SessionStore,
  type SessionWriter,
} from "./index.ts";
import { normalizeSessionTitle, resolveSession } from "./ops.ts";
import { appendSessionOperation } from "./operations.ts";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_IMPORT_LOG_BYTES = 32 * 1024 * 1024;

export class SessionManagementError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionManagementError";
    this.code = code;
  }
}

async function managementPaths(store: SessionStore): Promise<{
  home: string;
  sessionDir: string;
}> {
  const home = await fs.realpath(normalizeAbsolute(store.rootDir));
  const requested = normalizeAbsolute(store.paths.sessionDir);
  const stat = await fs.lstat(requested);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new SessionManagementError(
      "session.path",
      "session directory must be a regular directory",
    );
  }
  const sessionDir = await fs.realpath(requested);
  if (sessionDir === home || !isInsidePath(home, sessionDir)) {
    throw new SessionManagementError(
      "session.path",
      "session directory is outside the codepunk home",
    );
  }
  return { home, sessionDir };
}

export interface SessionBundle {
  format: "codepunk/session-bundle";
  version: 1;
  exported_at: string;
  log: string;
  log_sha256: string;
  meta: SessionMeta;
  meta_sha256: string;
  state: AgentState | null;
  state_sha256: string | null;
}

export async function createSessionBundle(
  store: SessionStore,
  now: () => Date = () => new Date(),
): Promise<SessionBundle> {
  const { sessionDir } = await managementPaths(store);
  const logPath = path.join(sessionDir, "session.jsonl");
  const metaPath = path.join(sessionDir, "session-meta.json");
  const stat = await fs.lstat(logPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new SessionManagementError(
      "session.bundle_log",
      "session log must be a regular file",
    );
  }
  const log = await fs.readFile(logPath, "utf8");
  const { header, events } = validateBundleLog(log);
  if (header.id !== store.sessionId) {
    throw new SessionManagementError(
      "session.bundle_log",
      "session log id does not match the session",
    );
  }
  let metaValue: unknown;
  try {
    metaValue = JSON.parse(await fs.readFile(metaPath, "utf8"));
  } catch {
    throw new SessionManagementError(
      "session.bundle_meta",
      "session metadata is not valid JSON",
    );
  }
  const metaValidation = validateSchema(SessionMetaSchema, metaValue);
  if (!metaValidation.ok) {
    throw new SessionManagementError(
      "session.bundle_meta",
      "session metadata is invalid",
    );
  }
  const meta = metaValue as SessionMeta;
  if (meta.log_seq !== events.length || meta.state_covers_seq > meta.log_seq) {
    throw new SessionManagementError(
      "session.bundle_meta",
      "session metadata does not match the log",
    );
  }
  const state = await store.readAgentState();
  if (state === null && meta.state_covers_seq !== 0) {
    throw new SessionManagementError(
      "session.bundle_meta",
      "session metadata covers state that is not present",
    );
  }
  return {
    format: "codepunk/session-bundle",
    version: 1,
    exported_at: now().toISOString(),
    log,
    log_sha256: sha256Text(log),
    meta,
    meta_sha256: sha256Value(meta),
    state,
    state_sha256: state === null ? null : sha256Value(state),
  };
}

function safeSegment(value: string, where: string): string {
  if (!SAFE_ID.test(value) || value.includes("..")) {
    throw new SessionManagementError(
      "session.import_path",
      `${where} is not path-safe`,
    );
  }
  return value;
}

function validateBundleLog(log: string): {
  header: SessionHeader;
  events: SessionEvent[];
} {
  const lines = log.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new SessionManagementError(
      "session.import_format",
      "session bundle has an empty log",
    );
  }
  let headerValue: unknown;
  let eventValues: unknown[];
  try {
    headerValue = JSON.parse(lines[0]!);
    eventValues = lines.slice(1).map((line) => JSON.parse(line));
  } catch {
    throw new SessionManagementError(
      "session.import_format",
      "session bundle log is not JSONL",
    );
  }
  const headerValidation = validateSchema(SessionHeaderSchema, headerValue);
  if (!headerValidation.ok) {
    throw new SessionManagementError(
      "session.import_format",
      "session bundle header is invalid",
    );
  }
  const header = headerValue as SessionHeader;
  const events: SessionEvent[] = [];
  for (const [index, value] of eventValues.entries()) {
    const validation = validateSchema(SessionEventSchema, value);
    if (!validation.ok) {
      throw new SessionManagementError(
        "session.import_format",
        `session bundle event ${index} is invalid`,
      );
    }
    const event = value as SessionEvent;
    if (event.seq !== index + 1) {
      throw new SessionManagementError(
        "session.import_format",
        `session bundle event ${index} breaks sequence order`,
      );
    }
    events.push(event);
  }
  return { header, events };
}

async function listSessionTree(
  sessionDir: string,
): Promise<{ files: string[]; directories: string[] }> {
  const files: string[] = [];
  const directories: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) {
        throw new SessionManagementError(
          "session.delete_unsafe",
          "session directory contains a symbolic link",
        );
      }
      if (stat.isDirectory()) {
        directories.push(candidate);
        await walk(candidate);
      } else if (stat.isFile()) {
        files.push(candidate);
      } else {
        throw new SessionManagementError(
          "session.delete_unsafe",
          "session directory contains a non-regular file",
        );
      }
    }
  }
  await walk(sessionDir);
  return { files, directories };
}

async function verifyBackupFiles(
  home: string,
  backupId: string,
): Promise<void> {
  const manifest = await loadBackup(home, backupId);
  for (const file of manifest.files) {
    const backupPath = path.join(home, "backups", backupId, "files", file.path);
    const bytes = await fs.readFile(backupPath);
    if (bytes.byteLength !== file.bytes || sha256Bytes(bytes) !== file.sha256) {
      throw new SessionManagementError(
        "session.backup_corrupt",
        `backup ${backupId} failed verification for ${file.path}`,
      );
    }
  }
}

export async function renameSession(
  options: Parameters<typeof resolveSession>[0],
  title: string | null,
): Promise<string | null> {
  const store = await resolveSession(options);
  const normalized = normalizeSessionTitle(title);
  const writer = await store.acquireWriter();
  const previousTitle = store.metadata.title;
  try {
    await store.writeMeta({ title: normalized });
    try {
      await appendSessionOperation(store.rootDir, {
        action: "rename",
        project_id: store.projectId,
        session_id: store.sessionId,
        title: normalized,
        backup_id: null,
        source_sha256: null,
      });
    } catch (error) {
      await store.writeMeta({ title: previousTitle }).catch(() => undefined);
      throw error;
    }
  } finally {
    await writer.release();
  }
  return normalized;
}

export async function archiveSession(
  options: Parameters<typeof resolveSession>[0],
  archived = true,
): Promise<void> {
  const store = await resolveSession(options);
  await appendSessionOperation(store.rootDir, {
    action: archived ? "archive" : "unarchive",
    project_id: store.projectId,
    session_id: store.sessionId,
    title: null,
    backup_id: null,
    source_sha256: null,
  });
}

export interface DeleteSessionResult {
  session_id: string;
  backup_id: string;
  deleted_files: number;
}

export async function deleteSession(
  options: Parameters<typeof resolveSession>[0] & { confirmed: boolean },
): Promise<DeleteSessionResult> {
  if (options.confirmed !== true) {
    throw new SessionManagementError(
      "session.delete_confirmation",
      "session delete requires explicit confirmation",
    );
  }
  await assertSupportedStateVersion(options.rootDir);
  const store = await resolveSession(options);
  const { home, sessionDir } = await managementPaths(store);
  const initial = await listSessionTree(sessionDir);
  const relative = initial.files.map((file) =>
    path.relative(home, file).split(path.sep).join("/"),
  );
  const sourceSha = sha256Bytes(
    await fs
      .readFile(path.join(sessionDir, "session.jsonl"))
      .catch(() => Buffer.alloc(0)),
  );
  let backup;
  try {
    backup = await createBackup(home, {
      files: relative,
      waitForWritersMs: 0,
    });
  } catch (error) {
    if (error instanceof RetentionLifecycleError) {
      throw new SessionManagementError(
        error.code === "retention.active_writer"
          ? "session.active_writer"
          : error.code,
        error.message,
      );
    }
    throw error;
  }
  await verifyBackupFiles(home, backup.id);

  let writer: SessionWriter | null;
  let deleting = false;
  try {
    writer = await store.acquireWriter();
  } catch (error) {
    if (error instanceof SessionLockedError) {
      throw new SessionManagementError(
        "session.active_writer",
        `session ${store.sessionId} has a live writer`,
      );
    }
    throw error;
  }
  const lockRelative = path
    .relative(home, path.join(sessionDir, "session.lock"))
    .split(path.sep)
    .join("/");
  const expected = new Map(
    backup.files
      .filter((file) => file.path !== lockRelative)
      .map((file) => [file.path, file.sha256]),
  );
  try {
    const current = await listSessionTree(sessionDir);
    const currentFiles = new Map<string, string>();
    for (const file of current.files) {
      const relativePath = path.relative(home, file).split(path.sep).join("/");
      if (relativePath === lockRelative) {
        continue;
      }
      currentFiles.set(relativePath, sha256Bytes(await fs.readFile(file)));
    }
    if (
      currentFiles.size !== expected.size ||
      [...expected].some(([file, hash]) => currentFiles.get(file) !== hash)
    ) {
      throw new SessionManagementError(
        "session.changed",
        "session changed after the backup; refusing to delete",
      );
    }
    deleting = true;
    for (const file of expected.keys()) {
      await fs.unlink(path.join(home, file));
    }
    await writer.release();
    writer = null;
    for (const directory of initial.directories.sort(
      (left, right) => right.length - left.length,
    )) {
      await fs.rmdir(directory).catch(() => undefined);
    }
    await fs.rmdir(sessionDir).catch(() => undefined);
    await appendSessionOperation(home, {
      action: "delete",
      project_id: store.projectId,
      session_id: store.sessionId,
      title: null,
      backup_id: backup.id,
      source_sha256: sourceSha,
    });
  } catch (error) {
    if (deleting) {
      await writer?.release();
      writer = null;
      try {
        await restoreBackup(home, backup.id);
      } catch (rollbackError) {
        throw new SessionManagementError(
          "session.delete_rollback",
          `session delete failed and its backup could not be restored: ${
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError)
          }`,
        );
      }
    }
    throw error;
  } finally {
    await writer?.release();
  }
  return {
    session_id: store.sessionId,
    backup_id: backup.id,
    deleted_files: expected.size,
  };
}

export interface ImportSessionResult {
  session_id: string;
  path: string;
  events: number;
}

export async function importSession(options: {
  home: string;
  projectId: string;
  bundle: SessionBundle;
}): Promise<ImportSessionResult> {
  const requestedHome = normalizeAbsolute(options.home);
  await ensurePrivateDir(requestedHome);
  const home = await fs.realpath(requestedHome);
  const projectId = safeSegment(options.projectId, "project id");
  const bundle = options.bundle;
  if (
    bundle === null ||
    typeof bundle !== "object" ||
    bundle.format !== "codepunk/session-bundle" ||
    bundle.version !== 1 ||
    typeof bundle.log !== "string" ||
    bundle.log.length === 0 ||
    Buffer.byteLength(bundle.log, "utf8") > MAX_IMPORT_LOG_BYTES ||
    bundle.log_sha256 !== sha256Text(bundle.log)
  ) {
    throw new SessionManagementError(
      "session.import_format",
      "session bundle log or format is invalid",
    );
  }
  const metaValidation = validateSchema(SessionMetaSchema, bundle.meta);
  if (!metaValidation.ok) {
    throw new SessionManagementError(
      "session.import_format",
      "session bundle metadata is invalid",
    );
  }
  if (bundle.meta_sha256 !== sha256Value(bundle.meta)) {
    throw new SessionManagementError(
      "session.import_hash",
      "session bundle metadata hash does not match",
    );
  }
  const { header, events } = validateBundleLog(bundle.log);
  const sessionId = safeSegment(header.id, "session id");
  if (header.project_id !== projectId) {
    throw new SessionManagementError(
      "session.import_project",
      "session bundle belongs to a different project",
    );
  }
  if (
    bundle.meta.log_seq !== events.length ||
    bundle.meta.state_covers_seq > bundle.meta.log_seq
  ) {
    throw new SessionManagementError(
      "session.import_format",
      "session bundle metadata does not match the log",
    );
  }
  if (bundle.state === null && bundle.meta.state_covers_seq !== 0) {
    throw new SessionManagementError(
      "session.import_state",
      "session bundle covers state without an agent state file",
    );
  }
  if (
    bundle.state !== null &&
    (!validateSchema(AgentStateSchema, bundle.state).ok ||
      bundle.state.session_id !== sessionId ||
      bundle.state_sha256 !== sha256Value(bundle.state))
  ) {
    throw new SessionManagementError(
      "session.import_state",
      "session bundle agent state is invalid",
    );
  }
  if (bundle.state === null && bundle.state_sha256 !== null) {
    throw new SessionManagementError(
      "session.import_state",
      "session bundle state hash is present without state",
    );
  }
  const projectsDir = path.join(home, "projects");
  await ensurePrivateDir(projectsDir);
  const realProjectsDir = await fs.realpath(projectsDir);
  if (!isInsidePath(home, realProjectsDir)) {
    throw new SessionManagementError(
      "session.import_path",
      "projects directory is outside the codepunk home",
    );
  }
  const sessionsDir = path.join(realProjectsDir, projectId, "sessions");
  await ensurePrivateDir(sessionsDir);
  const realSessionsDir = await fs.realpath(sessionsDir);
  if (!isInsidePath(home, realSessionsDir)) {
    throw new SessionManagementError(
      "session.import_path",
      "sessions directory is outside the codepunk home",
    );
  }
  const sessionDir = path.join(realSessionsDir, sessionId);
  if (!isInsidePath(realSessionsDir, sessionDir)) {
    throw new SessionManagementError(
      "session.import_path",
      "session import path escapes the sessions directory",
    );
  }
  try {
    await fs.mkdir(sessionDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new SessionManagementError(
        "session.import_conflict",
        `session ${sessionId} already exists`,
      );
    }
    throw error;
  }
  const logPath = path.join(sessionDir, "session.jsonl");
  const metaPath = path.join(sessionDir, "session-meta.json");
  const statePath = path.join(sessionDir, "agent-state.json");
  const created: string[] = [];
  try {
    await fs.writeFile(logPath, bundle.log, { flag: "wx", mode: 0o600 });
    created.push(logPath);
    await fs.writeFile(metaPath, `${JSON.stringify(bundle.meta)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    created.push(metaPath);
    if (bundle.state !== null) {
      await fs.writeFile(statePath, `${JSON.stringify(bundle.state)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      created.push(statePath);
    }
    if (sha256Text(await fs.readFile(logPath, "utf8")) !== bundle.log_sha256) {
      throw new SessionManagementError(
        "session.import_hash",
        "written session log failed hash verification",
      );
    }
  } catch (error) {
    for (const file of created.reverse()) {
      await fs.unlink(file).catch(() => undefined);
    }
    await fs.rmdir(sessionDir).catch(() => undefined);
    throw error;
  }
  await appendSessionOperation(home, {
    action: "import",
    project_id: projectId,
    session_id: sessionId,
    title: bundle.meta.title,
    backup_id: null,
    source_sha256: bundle.log_sha256,
  });
  return { session_id: sessionId, path: sessionDir, events: events.length };
}
