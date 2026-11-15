import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  SessionEvent,
  SessionHeader,
  SessionMeta,
} from "@codepunk/protocol";
import { recordHash, sha256Text } from "../platform/hash.ts";
import { normalizeAbsolute } from "../platform/path.ts";
import { redactOutputPreview } from "../artifacts/index.ts";
import {
  listSessionIndex,
  SessionLockedError,
  SessionStore,
  type SessionIndexEntry,
} from "./index.ts";

export interface SessionListEntry {
  id: string;
  parent_session_id: string | null;
  created_at: string;
  updated_at: string;
  title: string | null;
  pinned: boolean;
  last_seq: number;
  cwd: string;
}

const SESSION_TITLE_MAX_CHARS = 80;

/**
 * Session titles are display metadata, not an authority source. Keep them
 * single-line, bounded, and redacted before writing the product metadata file.
 * Pi's `/name` value and the automatic first-prompt title share this path.
 */
export function normalizeSessionTitle(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return null;
  }
  const redacted = redactOutputPreview(collapsed);
  return redacted.length <= SESSION_TITLE_MAX_CHARS
    ? redacted
    : `${redacted.slice(0, SESSION_TITLE_MAX_CHARS - 1)}…`;
}

export interface ExportManifest {
  session_id: string;
  source_sha256: string;
  header_sha256: string;
  exported_at: string;
  complete_to_last_settled_state: boolean;
  redactions: number;
  records: Array<{
    seq: number;
    kind: string;
    raw_sha256: string;
    redacted: boolean;
  }>;
  boundaries: {
    log_seq: number;
    state_covers_seq: number;
  };
}

export interface SessionExport {
  transcript: string;
  manifest: ExportManifest;
}

function displayTime(value: string): string {
  return value.replace("T", " ").replace(/\.\d+Z$/u, "Z");
}

function forkPiHeader(
  header: unknown,
  options: {
    childSessionId: string;
    cwd: string;
    timestamp: string;
  },
): Record<string, unknown> {
  if (header === null || typeof header !== "object" || Array.isArray(header)) {
    throw new Error("parent agent state has no Pi session header to fork");
  }
  const record = header as Record<string, unknown>;
  if (
    record["type"] !== "session" ||
    typeof record["id"] !== "string" ||
    record["id"].length === 0
  ) {
    throw new Error(
      "parent agent state has no valid Pi session header to fork",
    );
  }
  return {
    ...record,
    id: options.childSessionId,
    cwd: normalizeAbsolute(options.cwd),
    timestamp: options.timestamp,
  };
}

function redact(value: string, home: string): { text: string; count: number } {
  let count = 0;
  let text = value;
  const replacements: Array<[RegExp, string]> = [
    [/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED_API_KEY]"],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "[REDACTED_GITHUB_TOKEN]"],
    [
      /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/gu,
      "[REDACTED_JWT]",
    ],
    [
      /(authorization|proxy-authorization)\s*:\s*[^\n]+/giu,
      "$1: [REDACTED_HEADER]",
    ],
    [
      /\b(api[_-]?key|client[_-]?secret|access[_-]?token|password|secret)\b\s*[:=]\s*["']?[^"'\s]{8,}/giu,
      "$1=[REDACTED]",
    ],
    [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
      "[REDACTED_PRIVATE_KEY]",
    ],
  ];
  for (const [pattern, replacement] of replacements) {
    const before = text;
    text = text.replace(pattern, replacement);
    if (text !== before) {
      count += 1;
    }
  }
  const homePattern = new RegExp(
    `${home.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:[/\\\\][^\\s"']*)?`,
    "gu",
  );
  const beforeHome = text;
  text = text.replace(homePattern, "[HOME]");
  if (text !== beforeHome) {
    count += 1;
  }
  return { text, count };
}

export async function listProjectSessions(
  rootDir: string,
  projectId: string,
): Promise<SessionListEntry[]> {
  const entries = await listSessionIndex(rootDir, projectId);
  const output: SessionListEntry[] = [];
  for (const entry of entries) {
    const metaPath = path.join(entry.path, "session-meta.json");
    let meta: SessionMeta | null = null;
    try {
      meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as SessionMeta;
    } catch {
      meta = null;
    }
    output.push({
      id: entry.sessionId,
      parent_session_id: entry.header.parent_session_id ?? null,
      created_at: entry.header.created_at,
      updated_at: meta?.updated_at ?? entry.header.created_at,
      title: meta?.title ?? null,
      pinned: meta?.pinned ?? false,
      last_seq: entry.lastSeq,
      cwd: entry.header.cwd,
    });
  }
  return output.sort(
    (left, right) =>
      Number(right.pinned) - Number(left.pinned) ||
      Date.parse(right.updated_at) - Date.parse(left.updated_at),
  );
}

export async function latestSession(
  rootDir: string,
  projectId: string,
): Promise<SessionIndexEntry | null> {
  const sessions = await listProjectSessions(rootDir, projectId);
  const latest = sessions[0];
  if (latest === undefined) {
    return null;
  }
  const index = await listSessionIndex(rootDir, projectId);
  return index.find((entry) => entry.sessionId === latest.id) ?? null;
}

export async function resolveSession(options: {
  rootDir: string;
  cwd: string;
  projectRoot: string;
  projectId: string;
  sessionId?: string;
  sessionPath?: string;
  heartbeatMs?: number;
  leaseMs?: number;
}): Promise<SessionStore> {
  if (options.sessionPath !== undefined) {
    const sessionDir = normalizeAbsolute(options.sessionPath);
    const id = path.basename(sessionDir);
    return SessionStore.open({
      rootDir: options.rootDir,
      cwd: options.cwd,
      projectRoot: options.projectRoot,
      projectId: options.projectId,
      sessionId: id,
      ...(options.heartbeatMs !== undefined
        ? { heartbeatMs: options.heartbeatMs }
        : {}),
      ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
    });
  }
  let sessionId = options.sessionId;
  if (sessionId === undefined) {
    const latest = await latestSession(options.rootDir, options.projectId);
    if (latest === null) {
      throw new Error("no session exists for this project");
    }
    sessionId = latest.sessionId;
  }
  return SessionStore.open({
    rootDir: options.rootDir,
    cwd: options.cwd,
    projectRoot: options.projectRoot,
    projectId: options.projectId,
    sessionId,
    ...(options.heartbeatMs !== undefined
      ? { heartbeatMs: options.heartbeatMs }
      : {}),
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
  });
}

export async function pinSession(
  options: Parameters<typeof resolveSession>[0],
  pinned = true,
): Promise<void> {
  const store = await resolveSession(options);
  const writer = await store.acquireWriter();
  try {
    await store.writeMeta({ pinned });
  } finally {
    await writer.release();
  }
}

export interface ForkSessionResult {
  sessionId: string;
  parentSessionId: string;
  parentLastSeq: number;
  parentStateCoversSeq: number;
  parentEvents: number;
  forkEntries: number;
}

function latestBranchEntryId(branch: readonly unknown[]): string | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const id = (entry as Record<string, unknown>)["id"];
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }
  return undefined;
}

/**
 * Clone a settled session into a new child session.
 *
 * The child records the parent's committed events and a `session/forked`
 * evidence event that binds the parent log position and agent-state hash. A
 * session with a live writer is refused: forking a session that is still
 * being appended would copy a moving target whose parent hash the child
 * cannot honor.
 */
export async function forkSession(options: {
  rootDir: string;
  cwd: string;
  projectRoot: string;
  projectId: string;
  parentSessionId?: string;
  sessionId?: string;
  heartbeatMs?: number;
  leaseMs?: number;
  now?: () => Date;
}): Promise<ForkSessionResult> {
  const parent = await resolveSession({
    rootDir: options.rootDir,
    cwd: options.cwd,
    projectRoot: options.projectRoot,
    projectId: options.projectId,
    ...(options.parentSessionId === undefined
      ? {}
      : { sessionId: options.parentSessionId }),
    ...(options.heartbeatMs !== undefined
      ? { heartbeatMs: options.heartbeatMs }
      : {}),
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
  });
  let guard;
  try {
    // Taking the writer lock makes the snapshot atomic with respect to a
    // process that is still appending. Without it, a writer could pass a
    // lock probe and append while the child is being built.
    guard = await parent.acquireWriter();
  } catch (error) {
    if (error instanceof SessionLockedError) {
      throw new Error(
        `session ${parent.sessionId} has a live writer; settle it before forking`,
      );
    }
    throw error;
  }
  let snapshot;
  try {
    // Re-open after taking the lock so the snapshot does not use the log that
    // may have been read before the guard was acquired.
    const fresh = await SessionStore.open({
      rootDir: options.rootDir,
      cwd: options.cwd,
      projectRoot: options.projectRoot,
      projectId: options.projectId,
      sessionId: parent.sessionId,
      ...(options.heartbeatMs !== undefined
        ? { heartbeatMs: options.heartbeatMs }
        : {}),
      ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    const parentState = await fresh.readAgentState();
    if (parentState === null) {
      throw new Error(
        `session ${parent.sessionId} has no agent state to fork; settle a run first`,
      );
    }
    if (fresh.metadata.state_covers_seq !== fresh.lastSeq) {
      throw new Error(
        `session ${parent.sessionId} has events beyond its saved agent state; settle or resume it before forking`,
      );
    }
    snapshot = {
      parentState,
      parentLastSeq: fresh.lastSeq,
      parentStateCoversSeq: fresh.metadata.state_covers_seq,
      parentStateSha: recordHash(parentState),
      parentEvents: fresh.allEvents.length,
      forkEntryId: latestBranchEntryId(parentState.branch),
      parentModel: fresh.header.model,
    };
  } finally {
    await guard.release();
  }
  if (snapshot === undefined) {
    throw new Error("fork snapshot was not created");
  }
  const forkedAt = (options.now?.() ?? new Date()).toISOString();
  const child = await SessionStore.create({
    rootDir: options.rootDir,
    cwd: options.cwd,
    projectRoot: options.projectRoot,
    projectId: options.projectId,
    ...(options.sessionId === undefined
      ? {}
      : { sessionId: options.sessionId }),
    model: snapshot.parentModel,
    parentSessionId: parent.sessionId,
    ...(snapshot.forkEntryId === undefined
      ? {}
      : { forkEntryId: snapshot.forkEntryId }),
    ...(options.heartbeatMs !== undefined
      ? { heartbeatMs: options.heartbeatMs }
      : {}),
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const writer = await child.acquireWriter();
  try {
    await child.append("session/forked", {
      parent_session_id: parent.sessionId,
      parent_last_seq: snapshot.parentLastSeq,
      parent_state_covers_seq: snapshot.parentStateCoversSeq,
      parent_state_sha256: snapshot.parentStateSha,
      fork_entry_id: snapshot.forkEntryId ?? null,
      mode: "clone",
    });
    await child.saveAgentState(
      forkPiHeader(snapshot.parentState.header, {
        childSessionId: child.sessionId,
        cwd: options.cwd,
        timestamp: forkedAt,
      }),
      snapshot.parentState.branch,
    );
  } finally {
    await writer.release();
  }
  return {
    sessionId: child.sessionId,
    parentSessionId: parent.sessionId,
    parentLastSeq: snapshot.parentLastSeq,
    parentStateCoversSeq: snapshot.parentStateCoversSeq,
    parentEvents: snapshot.parentEvents,
    forkEntries: snapshot.parentState.branch.length,
  };
}

function eventText(event: SessionEvent): string {
  const data = event.data as Record<string, unknown>;
  const pieces: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (key === "text" && typeof value === "string") {
      pieces.push(value);
      continue;
    }
    pieces.push(
      `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
    );
  }
  return `- ${displayTime(event.at)} #${event.seq} ${event.kind}: ${pieces.join(" | ")}`;
}

export async function exportSession(
  store: SessionStore,
  home = os.homedir(),
): Promise<SessionExport> {
  let raw = "";
  try {
    raw = await fs.readFile(store.paths.logPath, "utf8");
  } catch (error) {
    throw new Error(`cannot read session log: ${(error as Error).message}`);
  }
  const header: SessionHeader = store.header;
  const meta = store.metadata;
  const rawLines = raw.split("\n").filter((line) => line.length > 0);
  const headerLine = rawLines[0] ?? "";
  const rawHashBySeq = new Map<number, string>();
  for (const line of rawLines.slice(1)) {
    try {
      const parsed = JSON.parse(line) as { seq?: unknown };
      if (typeof parsed.seq === "number") {
        rawHashBySeq.set(parsed.seq, sha256Text(line));
      }
    } catch {
      // A truncated tail is not an exported event; the log reader owns that error.
    }
  }
  const lines = [
    "# Codepunk audit transcript",
    "",
    "> This export is an audit transcript, not a replayable model context.",
    `> Session: ${header.id}`,
    `> Project: ${header.project_id}`,
    `> Created: ${displayTime(header.created_at)}`,
    `> Last event seq: ${meta.log_seq}`,
    `> State covers seq: ${meta.state_covers_seq}`,
    `> Complete to last settled state: ${String(meta.log_seq === meta.state_covers_seq)}`,
    "",
    "## Events",
  ];
  const manifestRecords: ExportManifest["records"] = [];
  for (const event of store.allEvents) {
    const original = eventText(event);
    const redactedEvent = redact(original, normalizeAbsolute(home));
    lines.push(redactedEvent.text);
    manifestRecords.push({
      seq: event.seq,
      kind: event.kind,
      raw_sha256:
        rawHashBySeq.get(event.seq) ?? sha256Text(JSON.stringify(event)),
      redacted: redactedEvent.text !== original,
    });
  }
  const redacted = redact(lines.join("\n"), normalizeAbsolute(home));
  return {
    transcript: `${redacted.text}\n`,
    manifest: {
      session_id: header.id,
      source_sha256: sha256Text(raw),
      header_sha256: sha256Text(headerLine),
      exported_at: new Date().toISOString(),
      complete_to_last_settled_state: meta.log_seq === meta.state_covers_seq,
      redactions: redacted.count,
      records: manifestRecords,
      boundaries: {
        log_seq: meta.log_seq,
        state_covers_seq: meta.state_covers_seq,
      },
    },
  };
}

export function formatSessionList(
  entries: readonly SessionListEntry[],
): string {
  if (entries.length === 0) {
    return "No sessions.";
  }
  return entries
    .map(
      (entry) =>
        `${entry.pinned ? "*" : " "} ${entry.id}  ${entry.updated_at}  ${entry.last_seq} events  ${entry.title ?? "(untitled)"}${
          entry.parent_session_id === null
            ? ""
            : `  from ${entry.parent_session_id}`
        }`,
    )
    .join("\n");
}
