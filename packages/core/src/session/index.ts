import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  CURRENT_SESSION_VERSION as PI_SESSION_VERSION,
  VERSION as PI_PACKAGE_VERSION,
} from "@earendil-works/pi-coding-agent";
import {
  AgentStateSchema,
  AGENT_STATE_SCHEMA_VERSION,
  ProtocolError,
  SESSION_EVENT_SCHEMA_VERSION,
  SessionEventSchema,
  SessionHeaderSchema,
  SessionMetaSchema,
  validateSchema,
  type AgentState,
  type SessionEvent,
  type SessionHeader,
  type SessionMeta,
} from "codepunk-protocol";
import { FormatVersionError, checkFormatVersion } from "../compat/index.ts";
import {
  appendFileSynced,
  atomicWriteFile,
  ensurePrivateDir,
  ensurePrivateFile,
  readJsonFile,
  writeJsonAtomic,
} from "../platform/fs.ts";
import { createUlid } from "../platform/hash.ts";
import { normalizeAbsolute } from "../platform/path.ts";
import { projectIdFor } from "../platform/paths.ts";

export const LOCK_HEARTBEAT_MS = 5_000;
export const LOCK_LEASE_MS = 30_000;
export const PI_VERSION = PI_PACKAGE_VERSION;
export const PI_SESSION_VERSION_CURRENT = PI_SESSION_VERSION;

export class SessionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionError";
  }
}

export class SessionLockedError extends SessionError {
  constructor(message = "session has a live writer") {
    super(message);
    this.name = "SessionLockedError";
  }
}

export class SessionCorruptError extends SessionError {
  constructor(message: string) {
    super(message);
    this.name = "SessionCorruptError";
  }
}

export class SessionUnsupportedEventError extends SessionCorruptError {
  readonly code = "session.unsupported_event";
  readonly kind: string;

  constructor(kind: string) {
    super(
      `session.unsupported_event: event kind "${kind}" is newer than this build; upgrade codepunk before reading this session`,
    );
    this.name = "SessionUnsupportedEventError";
    this.kind = kind;
  }
}

export class SessionNotFoundError extends SessionError {
  constructor(message: string) {
    super(message);
    this.name = "SessionNotFoundError";
  }
}

export interface SessionLockRecord {
  pid: number;
  host: string;
  started_at: string;
  heartbeat_at: string;
  nonce: string;
}

export interface SessionStoreOptions {
  rootDir: string;
  cwd: string;
  projectRoot?: string;
  projectId?: string;
  sessionId?: string;
  model?: string | null;
  parentSessionId?: string;
  forkEntryId?: string;
  piVersion?: string;
  now?: () => Date;
  heartbeatMs?: number;
  leaseMs?: number;
}

export interface SessionWriter {
  readonly nonce: string;
  readonly lock: SessionLockRecord;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

export interface AgentStateTree {
  entries: readonly unknown[];
  leafId: string | null;
}

export interface ResumeResult {
  header: SessionHeader;
  events: SessionEvent[];
  state: AgentState;
  committedEvents: SessionEvent[];
  uncommittedEvents: SessionEvent[];
}

export interface SessionIndexEntry {
  sessionId: string;
  path: string;
  header: SessionHeader;
  lastSeq: number;
}

export interface SessionPaths {
  projectDir: string;
  sessionDir: string;
  logPath: string;
  metaPath: string;
  statePath: string;
  lockPath: string;
  recoveryPath: string;
}

export interface SessionSnapshot {
  header: SessionHeader;
  events: SessionEvent[];
  metadata: SessionMeta;
}

function pathsFor(
  rootDir: string,
  projectId: string,
  sessionId: string,
): SessionPaths {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) {
    throw new SessionError("session id is not safe for a session path");
  }
  const projectDir = path.join(rootDir, "projects", projectId);
  const sessionDir = path.join(projectDir, "sessions", sessionId);
  return {
    projectDir,
    sessionDir,
    logPath: path.join(sessionDir, "session.jsonl"),
    metaPath: path.join(sessionDir, "session-meta.json"),
    statePath: path.join(sessionDir, "agent-state.json"),
    lockPath: path.join(sessionDir, "session.lock"),
    recoveryPath: path.join(sessionDir, "session.lock.recovery"),
  };
}

function timestamp(now: () => Date): string {
  return now().toISOString();
}

function knownSessionEventKinds(): Set<string> {
  const kinds = new Set<string>();
  const anyOf = (
    SessionEventSchema as unknown as {
      anyOf?: Array<{
        properties?: { kind?: { const?: unknown } };
      }>;
    }
  ).anyOf;
  for (const schema of anyOf ?? []) {
    const kind = schema.properties?.kind?.const;
    if (typeof kind === "string") {
      kinds.add(kind);
    }
  }
  return kinds;
}

const SESSION_EVENT_KINDS = knownSessionEventKinds();

function unsupportedEventKind(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record["type"] !== "codepunk/event") {
    return null;
  }
  const kind = record["kind"];
  return typeof kind === "string" && !SESSION_EVENT_KINDS.has(kind)
    ? kind
    : null;
}

function parseSessionLog(content: string): {
  header: SessionHeader;
  events: SessionEvent[];
} {
  const lines = content.split("\n");
  if (content.length > 0 && !content.endsWith("\n")) {
    throw new SessionCorruptError("session log has a truncated final line");
  }
  const nonEmpty = lines.filter((line) => line.length > 0);
  if (nonEmpty.length === 0) {
    throw new SessionCorruptError("session log is empty");
  }
  let header: SessionHeader;
  try {
    const parsed: unknown = JSON.parse(nonEmpty[0]!);
    const validation = validateSchema(SessionHeaderSchema, parsed);
    if (!validation.ok) {
      throw new SessionCorruptError("session header is invalid");
    }
    header = parsed as SessionHeader;
  } catch (error) {
    if (error instanceof SessionCorruptError) {
      throw error;
    }
    throw new SessionCorruptError("session header cannot be parsed");
  }
  const events: SessionEvent[] = [];
  for (let index = 1; index < nonEmpty.length; index += 1) {
    try {
      const parsed: unknown = JSON.parse(nonEmpty[index]!);
      const validation = validateSchema(SessionEventSchema, parsed);
      if (!validation.ok) {
        const unknownKind = unsupportedEventKind(parsed);
        if (unknownKind !== null) {
          throw new SessionUnsupportedEventError(unknownKind);
        }
        throw new SessionCorruptError(
          `session event ${index} is invalid: ${validation.issues
            .map((issue) => issue.message)
            .join("; ")}`,
        );
      }
      events.push(parsed as SessionEvent);
    } catch (error) {
      if (error instanceof SessionCorruptError) {
        throw error;
      }
      throw new SessionCorruptError(`session event ${index} cannot be parsed`);
    }
  }
  return { header, events };
}

async function readSessionLog(
  logPath: string,
): Promise<{ header: SessionHeader; events: SessionEvent[] }> {
  let content: string;
  try {
    content = await fs.readFile(logPath, "utf8");
  } catch (error) {
    throw new SessionCorruptError(
      `session log cannot be read: ${(error as Error).message}`,
    );
  }
  return parseSessionLog(content);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readLock(
  lockPath: string,
): Promise<SessionLockRecord | null> {
  const lock = await readJsonFile<SessionLockRecord>(lockPath);
  if (lock === null) {
    return null;
  }
  if (
    typeof lock.pid !== "number" ||
    typeof lock.host !== "string" ||
    typeof lock.started_at !== "string" ||
    typeof lock.heartbeat_at !== "string" ||
    typeof lock.nonce !== "string"
  ) {
    throw new SessionCorruptError("session lock is malformed");
  }
  return lock;
}

export async function readSessionSnapshot(options: {
  rootDir: string;
  projectId: string;
  sessionId: string;
}): Promise<SessionSnapshot> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(options.sessionId)) {
    throw new SessionError("session id is not safe for a snapshot path");
  }
  const rootDir = normalizeAbsolute(options.rootDir);
  const paths = pathsFor(rootDir, options.projectId, options.sessionId);
  let logStat;
  try {
    logStat = await fs.lstat(paths.logPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionNotFoundError(
        `session ${options.sessionId} was not found`,
      );
    }
    throw error;
  }
  if (logStat.isSymbolicLink() || !logStat.isFile()) {
    throw new SessionCorruptError("session log is not a regular file");
  }
  const loaded = await readSessionLog(paths.logPath);
  if (loaded.header.id !== options.sessionId) {
    throw new SessionCorruptError(
      "session header id does not match the session directory",
    );
  }
  if (loaded.header.project_id !== options.projectId) {
    throw new SessionCorruptError(
      "session header project_id does not match the project directory",
    );
  }
  let metaStat;
  try {
    metaStat = await fs.lstat(paths.metaPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      metaStat = null;
    } else {
      throw error;
    }
  }
  if (metaStat !== null && (metaStat.isSymbolicLink() || !metaStat.isFile())) {
    throw new SessionCorruptError("session meta is not a regular file");
  }
  const metaValue =
    metaStat === null ? null : await readJsonFile<unknown>(paths.metaPath);
  let metadata: SessionMeta;
  if (metaValue === null) {
    metadata = {
      version: 1,
      updated_at: loaded.header.created_at,
      title: null,
      pinned: false,
      decision_ref: null,
      log_seq: loaded.events.at(-1)?.seq ?? 0,
      state_covers_seq: 0,
    };
  } else {
    const validation = validateSchema(SessionMetaSchema, metaValue);
    if (!validation.ok) {
      throw new SessionCorruptError("session meta is invalid");
    }
    metadata = metaValue as SessionMeta;
  }
  return {
    header: loaded.header,
    events: loaded.events,
    metadata,
  };
}

interface LockRecoveryRecord {
  pid: number;
  host: string;
  created_at: string;
  nonce: string;
}

function isLockRecoveryRecord(value: unknown): value is LockRecoveryRecord {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["pid"] === "number" &&
    typeof record["host"] === "string" &&
    typeof record["created_at"] === "string" &&
    typeof record["nonce"] === "string"
  );
}

function staleRecoveryReason(
  record: LockRecoveryRecord,
  now: Date,
  leaseMs: number,
  host = hostname(),
): string | null {
  if (record.host !== host) {
    return "recovery owner is on another host";
  }
  const created = Date.parse(record.created_at);
  if (!Number.isFinite(created)) {
    return "recovery timestamp is invalid";
  }
  if (now.getTime() - created <= leaseMs) {
    return "recovery lease is still active";
  }
  if (processIsAlive(record.pid)) {
    return "recovery owner process is still alive";
  }
  return null;
}

async function createExclusive(
  filePath: string,
  content: string,
): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
  let committed = false;
  try {
    await ensurePrivateFile(filePath);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    committed = true;
    return true;
  } finally {
    await handle.close();
    if (!committed) {
      await fs.unlink(filePath).catch(() => undefined);
    }
  }
}

async function removeIfNonce(filePath: string, nonce: string): Promise<void> {
  const current = await readJsonFile<unknown>(filePath);
  if (
    current !== null &&
    typeof current === "object" &&
    (current as Record<string, unknown>)["nonce"] === nonce
  ) {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

export function staleLockReason(
  lock: SessionLockRecord,
  now: Date,
  leaseMs = LOCK_LEASE_MS,
  host = hostname(),
): string | null {
  if (lock.host !== host) {
    return "session lock owner is on another host";
  }
  const heartbeat = Date.parse(lock.heartbeat_at);
  if (!Number.isFinite(heartbeat)) {
    return "session lock heartbeat is invalid";
  }
  if (now.getTime() - heartbeat <= leaseMs) {
    return "session lock lease is still active";
  }
  if (processIsAlive(lock.pid)) {
    return "session lock owner process is still alive";
  }
  return null;
}

export class SessionStore {
  readonly rootDir: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly paths: SessionPaths;
  readonly header: SessionHeader;
  private events: SessionEvent[];
  private meta: SessionMeta;
  private writer: SessionWriter | null = null;
  private appendTail: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly heartbeatMs: number;
  private readonly leaseMs: number;
  private readonly piVersion: string;

  private constructor(
    options: SessionStoreOptions,
    paths: SessionPaths,
    header: SessionHeader,
    events: SessionEvent[],
    meta: SessionMeta,
  ) {
    this.rootDir = normalizeAbsolute(options.rootDir);
    this.projectId = header.project_id;
    this.sessionId = header.id;
    this.paths = paths;
    this.header = header;
    this.events = events;
    this.meta = meta;
    this.now = options.now ?? (() => new Date());
    this.heartbeatMs = options.heartbeatMs ?? LOCK_HEARTBEAT_MS;
    this.leaseMs = options.leaseMs ?? LOCK_LEASE_MS;
    this.piVersion = options.piVersion ?? PI_VERSION;
  }

  static async create(options: SessionStoreOptions): Promise<SessionStore> {
    const rootDir = normalizeAbsolute(options.rootDir);
    const cwd = normalizeAbsolute(options.cwd);
    const projectId =
      options.projectId ?? projectIdFor(options.projectRoot ?? cwd);
    const sessionId =
      options.sessionId ?? createUlid(options.now?.() ?? new Date());
    const paths = pathsFor(rootDir, projectId, sessionId);
    await ensurePrivateDir(paths.sessionDir);
    const now = options.now ?? (() => new Date());
    const header: SessionHeader = {
      type: "codepunk/session",
      version: 1,
      id: sessionId,
      project_id: projectId,
      cwd,
      created_at: timestamp(now),
      pi_version: options.piVersion ?? PI_VERSION,
      model: options.model ?? null,
      ...(options.parentSessionId === undefined
        ? {}
        : { parent_session_id: options.parentSessionId }),
      ...(options.forkEntryId === undefined
        ? {}
        : { fork_entry_id: options.forkEntryId }),
    };
    const headerValidation = validateSchema(SessionHeaderSchema, header);
    if (!headerValidation.ok) {
      throw new SessionError("cannot create an invalid session header");
    }
    const handle = await fs.open(paths.logPath, "wx", 0o600);
    let committed = false;
    try {
      await ensurePrivateFile(paths.logPath);
      await handle.writeFile(`${JSON.stringify(header)}\n`, "utf8");
      await handle.sync();
      committed = true;
    } finally {
      await handle.close();
      if (!committed) {
        await fs.unlink(paths.logPath).catch(() => undefined);
      }
    }
    const meta: SessionMeta = {
      version: 1,
      updated_at: header.created_at,
      title: null,
      pinned: false,
      decision_ref: null,
      log_seq: 0,
      state_covers_seq: 0,
    };
    await writeJsonAtomic(paths.metaPath, meta);
    return new SessionStore(options, paths, header, [], meta);
  }

  static async open(
    options: Omit<SessionStoreOptions, "sessionId"> & { sessionId: string },
  ): Promise<SessionStore> {
    const rootDir = normalizeAbsolute(options.rootDir);
    const cwd = normalizeAbsolute(options.cwd);
    const projectId =
      options.projectId ?? projectIdFor(options.projectRoot ?? cwd);
    const paths = pathsFor(rootDir, projectId, options.sessionId);
    // A missing log is "not found", not "corrupt": readSessionLog wraps every
    // read failure, so the distinction has to be made before it runs. This
    // mirrors readSessionSnapshot and keeps open() honest for write paths such
    // as session/pin, which reach the store without a prior snapshot read.
    let logStat;
    try {
      logStat = await fs.lstat(paths.logPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SessionNotFoundError(
          `session ${options.sessionId} was not found`,
        );
      }
      throw error;
    }
    if (logStat.isSymbolicLink() || !logStat.isFile()) {
      throw new SessionCorruptError("session log is not a regular file");
    }
    const loaded = await readSessionLog(paths.logPath);
    const metaValue = await readJsonFile<unknown>(paths.metaPath);
    let meta: SessionMeta;
    if (metaValue === null) {
      meta = {
        version: 1,
        updated_at: timestamp(options.now ?? (() => new Date())),
        title: null,
        pinned: false,
        decision_ref: null,
        log_seq: loaded.events.length,
        state_covers_seq: 0,
      };
      await writeJsonAtomic(paths.metaPath, meta);
    } else {
      const validation = validateSchema(SessionMetaSchema, metaValue);
      if (!validation.ok) {
        throw new SessionCorruptError("session meta is invalid");
      }
      meta = metaValue as SessionMeta;
    }
    return new SessionStore(options, paths, loaded.header, loaded.events, meta);
  }

  get lastSeq(): number {
    return this.events.at(-1)?.seq ?? 0;
  }

  get allEvents(): readonly SessionEvent[] {
    return this.events;
  }

  get metadata(): SessionMeta {
    return this.meta;
  }

  get hasWriter(): boolean {
    return this.writer !== null;
  }

  async append(
    kind: SessionEvent["kind"],
    data: unknown,
  ): Promise<SessionEvent> {
    const operation = this.appendTail.then(
      () => this.appendSerialized(kind, data),
      () => this.appendSerialized(kind, data),
    );
    this.appendTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async appendSerialized(
    kind: SessionEvent["kind"],
    data: unknown,
  ): Promise<SessionEvent> {
    if (this.writer === null) {
      throw new SessionLockedError("session append requires the writer lock");
    }
    const previousMeta = this.meta;
    const previousSize = (await fs.stat(this.paths.logPath)).size;
    const event = {
      type: "codepunk/event",
      version: SESSION_EVENT_SCHEMA_VERSION,
      seq: this.lastSeq + 1,
      at: timestamp(this.now),
      kind,
      data,
    } as unknown;
    const validation = validateSchema(SessionEventSchema, event);
    if (!validation.ok) {
      throw new SessionError(
        `cannot append invalid ${kind} event: ${validation.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ")}`,
      );
    }
    const typed = event as SessionEvent;
    await appendFileSynced(this.paths.logPath, `${JSON.stringify(typed)}\n`);
    this.events.push(typed);
    this.meta = {
      ...this.meta,
      updated_at: timestamp(this.now),
      log_seq: typed.seq,
    };
    try {
      await writeJsonAtomic(this.paths.metaPath, this.meta);
    } catch (error) {
      this.events.pop();
      this.meta = previousMeta;
      try {
        await fs.truncate(this.paths.logPath, previousSize);
      } catch (rollbackError) {
        throw new SessionError(
          "session event metadata write failed and the log rollback also failed",
          {
            cause: new AggregateError(
              [error, rollbackError],
              "session append rollback failed",
            ),
          },
        );
      }
      throw error;
    }
    return typed;
  }

  async acquireWriter(): Promise<SessionWriter> {
    if (this.writer !== null) {
      throw new SessionLockedError(
        "this session store already owns the writer",
      );
    }
    const host = hostname();
    const now = this.now();
    const lockPath = this.paths.lockPath;
    let lock = await readLock(lockPath);
    if (lock !== null) {
      const reason = staleLockReason(lock, now, this.leaseMs);
      if (reason !== null) {
        throw new SessionLockedError(reason);
      }
      await this.recoverStaleLock(lock);
      lock = null;
    }
    const nonce = randomUUID();
    const record: SessionLockRecord = {
      pid: process.pid,
      host,
      started_at: now.toISOString(),
      heartbeat_at: now.toISOString(),
      nonce,
    };
    const created = await createExclusive(
      lockPath,
      `${JSON.stringify(record)}\n`,
    );
    if (!created) {
      throw new SessionLockedError(
        "session lock was acquired by another writer",
      );
    }
    let heartbeatFailure: Error | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let heartbeatInFlight: Promise<void> | null = null;
    let released = false;
    const writer: SessionWriter = {
      nonce,
      lock: record,
      heartbeat: async () => {
        if (released) {
          throw new SessionLockedError("session writer lock was released");
        }
        if (heartbeatInFlight !== null) {
          return heartbeatInFlight;
        }
        const pending = (async () => {
          const current = await readLock(lockPath);
          if (current === null || current.nonce !== nonce) {
            throw new SessionLockedError("session writer lock was lost");
          }
          const updated: SessionLockRecord = {
            ...current,
            heartbeat_at: timestamp(this.now),
          };
          await writeJsonAtomic(lockPath, updated);
          (writer as { lock: SessionLockRecord }).lock = updated;
        })();
        heartbeatInFlight = pending;
        try {
          await pending;
        } finally {
          if (heartbeatInFlight === pending) {
            heartbeatInFlight = null;
          }
        }
      },
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        if (heartbeatTimer !== null) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        await heartbeatInFlight?.catch(() => undefined);
        const current = await readLock(lockPath);
        if (current?.nonce === nonce) {
          await fs.unlink(lockPath);
        }
        if (this.writer === writer) {
          this.writer = null;
        }
      },
    };
    this.writer = writer;
    heartbeatTimer = setInterval(() => {
      if (heartbeatFailure !== null || released) {
        return;
      }
      void writer.heartbeat().catch((error: unknown) => {
        heartbeatFailure =
          error instanceof Error ? error : new Error(String(error));
      });
    }, this.heartbeatMs);
    heartbeatTimer.unref();
    return writer;
  }

  private async recoverStaleLock(stale: SessionLockRecord): Promise<void> {
    const recoveryPath = this.paths.recoveryPath;
    const nonce = randomUUID();
    const recovery: LockRecoveryRecord = {
      pid: process.pid,
      host: hostname(),
      created_at: timestamp(this.now),
      nonce,
    };
    const created = await createExclusive(
      recoveryPath,
      `${JSON.stringify(recovery)}\n`,
    );
    if (!created) {
      const existing = await readJsonFile<unknown>(recoveryPath);
      if (existing === null) {
        throw new SessionLockedError(
          "session lock recovery is in progress; retry",
        );
      }
      if (!isLockRecoveryRecord(existing)) {
        throw new SessionCorruptError(
          "session lock recovery marker is malformed",
        );
      }
      const reason = staleRecoveryReason(existing, this.now(), this.leaseMs);
      if (reason !== null) {
        throw new SessionLockedError(
          `session lock recovery is in progress: ${reason}`,
        );
      }
      await removeIfNonce(recoveryPath, existing.nonce);
      return this.recoverStaleLock(stale);
    }
    try {
      const current = await readLock(this.paths.lockPath);
      if (current === null) {
        return;
      }
      if (current.nonce !== stale.nonce) {
        throw new SessionLockedError(
          "session lock owner changed during recovery",
        );
      }
      const reason = staleLockReason(current, this.now(), this.leaseMs);
      if (reason !== null) {
        throw new SessionLockedError(reason);
      }
      await fs.unlink(this.paths.lockPath);
    } finally {
      await removeIfNonce(recoveryPath, nonce);
    }
  }

  async saveAgentState(
    header: unknown,
    branch: unknown[],
    tree?: AgentStateTree,
  ): Promise<AgentState> {
    if (this.writer === null) {
      throw new SessionLockedError("agent-state save requires the writer lock");
    }
    if (tree !== undefined) {
      const entryIds = new Set<string>();
      for (const entry of tree.entries) {
        if (
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry)
        ) {
          const id = (entry as Record<string, unknown>)["id"];
          if (typeof id === "string" && id.length > 0) {
            entryIds.add(id);
          }
        }
      }
      if (tree.leafId !== null && !entryIds.has(tree.leafId)) {
        throw new SessionError(
          "agent-state leaf is not present in the saved entry tree",
        );
      }
      for (const entry of branch) {
        if (
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry)
        ) {
          const id = (entry as Record<string, unknown>)["id"];
          if (typeof id === "string" && id.length > 0 && !entryIds.has(id)) {
            throw new SessionError(
              "agent-state branch is not present in the saved entry tree",
            );
          }
        }
      }
    }
    const state: AgentState = {
      version: 1,
      session_version: PI_SESSION_VERSION_CURRENT,
      pi_version: this.piVersion,
      session_id: this.sessionId,
      saved_at: timestamp(this.now),
      header,
      branch,
      ...(tree === undefined
        ? {}
        : { entries: [...tree.entries], leaf_id: tree.leafId }),
    };
    const validation = validateSchema(AgentStateSchema, state);
    if (!validation.ok) {
      throw new SessionError("cannot save an invalid agent state");
    }
    await writeJsonAtomic(this.paths.statePath, state);
    this.meta = {
      ...this.meta,
      updated_at: state.saved_at,
      state_covers_seq: this.lastSeq,
    };
    await writeJsonAtomic(this.paths.metaPath, this.meta);
    return state;
  }

  async readAgentState(): Promise<AgentState | null> {
    const raw = await readJsonFile<unknown>(this.paths.statePath);
    if (raw === null) {
      return null;
    }
    // Spec 0016 C1: decide compatibility by format versions before the schema
    // check so the rejection names the offending field and both numbers
    // (the schema would otherwise reject a newer `version` as generically
    // invalid, and would admit a zero `session_version`).
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      try {
        checkFormatVersion(
          "agent-state",
          "version",
          record["version"],
          AGENT_STATE_SCHEMA_VERSION,
        );
        checkFormatVersion(
          "agent-state",
          "session_version",
          record["session_version"],
          PI_SESSION_VERSION_CURRENT,
        );
      } catch (error) {
        if (error instanceof FormatVersionError) {
          throw new ProtocolError(
            "agent-state",
            typeof error.saved === "number" ? error.saved : -1,
            error.message,
          );
        }
        throw error;
      }
    }
    const validation = validateSchema(AgentStateSchema, raw);
    if (!validation.ok) {
      throw new SessionCorruptError("agent-state.json is invalid");
    }
    const state = raw as AgentState;
    if (state.session_id !== this.sessionId) {
      throw new SessionCorruptError(
        "agent-state session_id does not match the session",
      );
    }
    return state;
  }

  async resume(): Promise<ResumeResult> {
    const state = await this.readAgentState();
    if (state === null) {
      if (this.events.length > 0) {
        throw new SessionCorruptError(
          "session has events but no agent-state.json; refusing to resume empty",
        );
      }
      throw new SessionCorruptError(
        "session has no agent-state.json to resume",
      );
    }
    const committedEvents: SessionEvent[] = [];
    const uncommittedEvents: SessionEvent[] = [];
    for (const event of this.events) {
      if (event.seq <= this.meta.state_covers_seq) {
        committedEvents.push(event);
      } else {
        uncommittedEvents.push(event);
      }
    }
    return {
      header: this.header,
      events: [...this.events],
      state,
      committedEvents,
      uncommittedEvents,
    };
  }

  async writeMeta(meta: Partial<SessionMeta>): Promise<void> {
    if (this.writer === null) {
      throw new SessionLockedError(
        "session meta write requires the writer lock",
      );
    }
    this.meta = {
      ...this.meta,
      ...meta,
      version: 1,
      updated_at: timestamp(this.now),
    };
    const validation = validateSchema(SessionMetaSchema, this.meta);
    if (!validation.ok) {
      throw new SessionError("cannot write invalid session meta");
    }
    await writeJsonAtomic(this.paths.metaPath, this.meta);
  }

  async writeRawLog(content: string): Promise<void> {
    await atomicWriteFile(this.paths.logPath, content);
  }

  get heartbeatMsValue(): number {
    return this.heartbeatMs;
  }

  get leaseMsValue(): number {
    return this.leaseMs;
  }

  get lockPath(): string {
    return this.paths.lockPath;
  }
}

export async function listSessionIndex(
  rootDir: string,
  projectId?: string,
): Promise<SessionIndexEntry[]> {
  const projectsDir = path.join(rootDir, "projects");
  const entries: SessionIndexEntry[] = [];
  let projects: string[];
  try {
    projects = await fs.readdir(projectsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return entries;
    }
    throw error;
  }
  for (const project of projects) {
    if (projectId !== undefined && project !== projectId) {
      continue;
    }
    const sessionsDir = path.join(projectsDir, project, "sessions");
    let sessions: string[];
    try {
      sessions = await fs.readdir(sessionsDir);
    } catch {
      continue;
    }
    for (const session of sessions) {
      const logPath = path.join(sessionsDir, session, "session.jsonl");
      try {
        const loaded = await readSessionLog(logPath);
        entries.push({
          sessionId: loaded.header.id,
          path: path.dirname(logPath),
          header: loaded.header,
          lastSeq: loaded.events.at(-1)?.seq ?? 0,
        });
      } catch {
        // A corrupt or partially created session is not indexed as resumable.
      }
    }
  }
  return entries;
}
