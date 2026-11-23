import { redactOutputPreview } from "../artifacts/index.ts";
import type { SessionStore } from "./index.ts";
import { listProjectSessions, type SessionListEntry } from "./ops.ts";

const TREE_PREVIEW_MAX_CHARS = 96;

export interface SessionTreeEntry {
  id: string;
  parent_id: string | null;
  type: string;
  role: string | null;
  label: string | null;
  timestamp: string | null;
  preview: string | null;
  depth: number;
  child_count: number;
  active: boolean;
  leaf: boolean;
}

export interface SessionTree {
  session_id: string;
  cwd: string;
  title: string | null;
  saved_at: string;
  leaf_id: string | null;
  active_entry_ids: string[];
  roots: string[];
  entries: SessionTreeEntry[];
}

export interface SessionGraphEntry extends SessionListEntry {
  depth: number;
}

export interface SessionGraph {
  sessions: SessionGraphEntry[];
}

interface RawTreeEntry {
  id: string;
  parent_id: string | null;
  type: string;
  timestamp: string | null;
  value: Record<string, unknown>;
  order: number;
}

function boundedPreview(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return null;
  }
  const redacted = redactOutputPreview(collapsed);
  return redacted.length <= TREE_PREVIEW_MAX_CHARS
    ? redacted
    : `${redacted.slice(0, TREE_PREVIEW_MAX_CHARS - 1)}\u2026`;
}

function contentPreview(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    if (
      typeof content === "object" &&
      content !== null &&
      typeof (content as Record<string, unknown>)["text"] === "string"
    ) {
      return (content as Record<string, unknown>)["text"] as string;
    }
    return null;
  }
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string") {
      parts.push(record["text"]);
    } else if (record["type"] === "image") {
      parts.push("[image]");
    } else if (record["type"] === "toolCall" || record["type"] === "tool_use") {
      const name =
        typeof record["name"] === "string"
          ? record["name"]
          : typeof record["toolName"] === "string"
            ? record["toolName"]
            : "tool";
      parts.push(`[tool ${name}]`);
    }
  }
  return parts.length === 0 ? null : parts.join(" ");
}

function entryPreview(value: Record<string, unknown>): string | null {
  const type = value["type"];
  if (type === "message") {
    const message = value["message"];
    if (typeof message !== "object" || message === null) {
      return null;
    }
    return contentPreview((message as Record<string, unknown>)["content"]);
  }
  if (type === "compaction" || type === "branch_summary") {
    return typeof value["summary"] === "string" ? value["summary"] : null;
  }
  if (type === "model_change") {
    const provider = value["provider"];
    const model = value["modelId"];
    return typeof provider === "string" && typeof model === "string"
      ? `${provider}/${model}`
      : null;
  }
  if (type === "thinking_level_change") {
    return typeof value["thinkingLevel"] === "string"
      ? `thinking ${value["thinkingLevel"]}`
      : null;
  }
  if (type === "label") {
    const target = value["targetId"];
    const label = value["label"];
    return typeof target === "string" && typeof label === "string"
      ? `${target}: ${label}`
      : null;
  }
  if (type === "session_info") {
    return typeof value["name"] === "string" ? value["name"] : null;
  }
  if (type === "custom") {
    return typeof value["customType"] === "string" ? value["customType"] : null;
  }
  if (type === "custom_message") {
    const customType = value["customType"];
    const body = contentPreview(value["content"]);
    if (typeof customType !== "string") {
      return body;
    }
    return body === null ? customType : `${customType}: ${body}`;
  }
  if (type === "usage") {
    const kind = value["kind"];
    const provider = value["provider"];
    const model = value["model"];
    if (typeof kind !== "string") {
      return null;
    }
    return typeof provider === "string" && typeof model === "string"
      ? `${kind} ${provider}/${model}`
      : kind;
  }
  if (type === "context_edit") {
    return typeof value["targetId"] === "string"
      ? `edit ${value["targetId"]}`
      : null;
  }
  return null;
}

function normalizeEntry(value: unknown, order: number): RawTreeEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }
  return {
    id,
    parent_id:
      typeof record["parentId"] === "string" ? record["parentId"] : null,
    type: typeof record["type"] === "string" ? record["type"] : "unknown",
    timestamp:
      typeof record["timestamp"] === "string" ? record["timestamp"] : null,
    value: record,
    order,
  };
}

function labelMap(entries: readonly RawTreeEntry[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "label") {
      continue;
    }
    const target = entry.value["targetId"];
    if (typeof target !== "string" || target.length === 0) {
      continue;
    }
    const label = entry.value["label"];
    if (typeof label === "string" && label.trim().length > 0) {
      labels.set(target, label.trim());
    } else {
      labels.delete(target);
    }
  }
  return labels;
}

/**
 * Turn the opaque Pi entry array into a display graph without reinterpreting
 * model context. The product event log stays authoritative; this view is a
 * bounded projection of the saved host tree.
 */
export async function readSessionTree(
  store: SessionStore,
): Promise<SessionTree | null> {
  const state = await store.readAgentState();
  if (state === null) {
    return null;
  }
  const source =
    Array.isArray(state.entries) && state.entries.length > 0
      ? state.entries
      : state.branch;
  const rawEntries: RawTreeEntry[] = [];
  for (const [index, value] of source.entries()) {
    const entry = normalizeEntry(value, index);
    if (entry !== null) {
      rawEntries.push(entry);
    }
  }
  const byId = new Map(rawEntries.map((entry) => [entry.id, entry]));
  const labels = labelMap(rawEntries);
  const children = new Map<string, RawTreeEntry[]>();
  const roots: RawTreeEntry[] = [];
  for (const entry of rawEntries) {
    if (entry.parent_id !== null && byId.has(entry.parent_id)) {
      const list = children.get(entry.parent_id) ?? [];
      list.push(entry);
      children.set(entry.parent_id, list);
    } else {
      roots.push(entry);
    }
  }
  for (const list of children.values()) {
    list.sort((left, right) => left.order - right.order);
  }
  roots.sort((left, right) => left.order - right.order);

  const activeIds = new Set<string>();
  for (const value of state.branch) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const id = (value as Record<string, unknown>)["id"];
    if (typeof id === "string" && id.length > 0) {
      activeIds.add(id);
    }
  }
  const leafId = state.leaf_id ?? [...activeIds].at(-1) ?? null;
  const entries: SessionTreeEntry[] = [];
  const visited = new Set<string>();

  const visit = (entry: RawTreeEntry, depth: number): void => {
    if (visited.has(entry.id)) {
      return;
    }
    visited.add(entry.id);
    const childList = children.get(entry.id) ?? [];
    const message = entry.value["message"];
    const role =
      entry.type === "message" &&
      typeof message === "object" &&
      message !== null &&
      typeof (message as Record<string, unknown>)["role"] === "string"
        ? ((message as Record<string, unknown>)["role"] as string)
        : null;
    entries.push({
      id: entry.id,
      parent_id: entry.parent_id,
      type: entry.type,
      role,
      label: labels.get(entry.id) ?? null,
      timestamp: entry.timestamp,
      preview: boundedPreview(entryPreview(entry.value)),
      depth,
      child_count: childList.length,
      active: activeIds.has(entry.id),
      leaf: entry.id === leafId,
    });
    for (const child of childList) {
      visit(child, depth + 1);
    }
  };

  for (const root of roots) {
    visit(root, 0);
  }
  for (const entry of rawEntries) {
    visit(entry, 0);
  }

  return {
    session_id: store.sessionId,
    cwd: store.header.cwd,
    title: store.metadata.title,
    saved_at: state.saved_at,
    leaf_id: leafId,
    active_entry_ids: [...activeIds],
    roots: roots.map((entry) => entry.id),
    entries,
  };
}

function sessionGraphOrder(
  sessions: readonly SessionListEntry[],
): SessionGraphEntry[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const children = new Map<string, SessionListEntry[]>();
  const roots: SessionListEntry[] = [];
  for (const session of sessions) {
    if (
      session.parent_session_id !== null &&
      byId.has(session.parent_session_id) &&
      session.parent_session_id !== session.id
    ) {
      const list = children.get(session.parent_session_id) ?? [];
      list.push(session);
      children.set(session.parent_session_id, list);
    } else {
      roots.push(session);
    }
  }
  const ordered: SessionGraphEntry[] = [];
  const visited = new Set<string>();
  const visit = (session: SessionListEntry, depth: number): void => {
    if (visited.has(session.id)) {
      return;
    }
    visited.add(session.id);
    ordered.push({ ...session, depth });
    for (const child of children.get(session.id) ?? []) {
      visit(child, depth + 1);
    }
  };
  for (const root of roots) {
    visit(root, 0);
  }
  for (const session of sessions) {
    visit(session, 0);
  }
  return ordered;
}

/**
 * Link product sessions by their recorded parent. The fork entry remains an
 * opaque Pi id, but its presence lets a reader jump from the child back to the
 * exact branch point in the parent tree.
 */
export async function readSessionGraph(
  rootDir: string,
  projectId: string,
): Promise<SessionGraph> {
  const sessions = await listProjectSessions(rootDir, projectId);
  return { sessions: sessionGraphOrder(sessions) };
}

export function formatSessionTree(tree: SessionTree): string {
  const title =
    tree.title === null || tree.title.length === 0 ? "(untitled)" : tree.title;
  const lines = [
    `Session ${tree.session_id}  ${title}`,
    `cwd: ${tree.cwd}`,
    `leaf: ${tree.leaf_id ?? "(none)"}`,
    `entries: ${tree.entries.length}`,
  ];
  if (tree.entries.length === 0) {
    lines.push("No saved session entries.");
    return lines.join("\n");
  }
  for (const entry of tree.entries) {
    const indent = "  ".repeat(entry.depth);
    const marker = entry.leaf ? "*" : entry.active ? "+" : "-";
    const kind =
      entry.role === null ? entry.type : `${entry.type}:${entry.role}`;
    const label = entry.label === null ? "" : ` [${entry.label}]`;
    const preview = entry.preview === null ? "" : `  ${entry.preview}`;
    const leaf = entry.leaf ? "  (leaf)" : "";
    const branch =
      entry.child_count > 1 ? `  (${entry.child_count} children)` : "";
    lines.push(
      `${marker} ${indent}${entry.id}  ${kind}${label}${leaf}${branch}${preview}`,
    );
  }
  return lines.join("\n");
}

export function formatSessionGraph(graph: SessionGraph): string {
  if (graph.sessions.length === 0) {
    return "No sessions.";
  }
  return graph.sessions
    .map((session) => {
      const indent = "  ".repeat(session.depth);
      const title =
        session.title === null || session.title.length === 0
          ? "(untitled)"
          : session.title;
      const pin = session.pinned ? "*" : " ";
      const parent =
        session.parent_session_id === null
          ? ""
          : `  from ${session.parent_session_id}${
              session.fork_entry_id === null
                ? ""
                : ` @ ${session.fork_entry_id}`
            }`;
      return `${pin} ${indent}${session.id}  ${session.updated_at}  ${title}${parent}`;
    })
    .join("\n");
}
