/**
 * Session selection shared by `codepunk resume` and the TUI `/resume`
 * command. Pure functions only: listing, search, and prompting stay with the
 * caller so both surfaces resolve the same argument the same way.
 */

export interface ResumeCandidate {
  id: string;
  updated_at: string;
  title: string | null;
  parent_session_id: string | null;
}

export type ResumeResolution<T extends ResumeCandidate> =
  | { kind: "session"; entry: T }
  | { kind: "choose"; title: string; entries: T[] }
  | { kind: "none"; message: string };

/** How many sessions a picker shows before asking for a search term. */
export const RESUME_PICKER_LIMIT = 20;

/** Exact id first, then a unique id prefix. */
export function matchSessionChoice<T extends { id: string }>(
  entries: readonly T[],
  query: string,
): T | null {
  const exact = entries.find((entry) => entry.id === query);
  if (exact !== undefined) {
    return exact;
  }
  const matches = entries.filter((entry) => entry.id.startsWith(query));
  return matches.length === 1 ? matches[0]! : null;
}

export function resumeChoiceLabel(entry: ResumeCandidate): string {
  return `${entry.id}  ${entry.updated_at}  ${entry.title ?? "(untitled)"}${
    entry.parent_session_id === null ? "" : `  from ${entry.parent_session_id}`
  }`;
}

/**
 * Resolve `[id|latest|text]` against the project's sessions, newest first.
 * `search` returns matching session ids in relevance order and is only called
 * when the argument is neither `latest` nor an id or unique id prefix.
 */
export async function resolveResumeTarget<T extends ResumeCandidate>(
  entries: readonly T[],
  argument: string,
  search: (query: string) => Promise<readonly string[]>,
): Promise<ResumeResolution<T>> {
  if (entries.length === 0) {
    return { kind: "none", message: "No sessions in this project." };
  }
  const query = argument.trim();
  if (query.length === 0) {
    if (entries.length === 1) {
      return { kind: "session", entry: entries[0]! };
    }
    const visible = entries.slice(0, RESUME_PICKER_LIMIT);
    return {
      kind: "choose",
      title:
        entries.length > visible.length
          ? `Resume session (showing ${visible.length} of ${entries.length}; pass text to search)`
          : "Resume session",
      entries: visible,
    };
  }
  if (query === "latest") {
    return { kind: "session", entry: entries[0]! };
  }
  const matched = matchSessionChoice(entries, query);
  if (matched !== null) {
    return { kind: "session", entry: matched };
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const hits: T[] = [];
  for (const id of await search(query)) {
    const entry = byId.get(id);
    if (entry === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    hits.push(entry);
  }
  if (hits.length === 0) {
    return {
      kind: "none",
      message: `No session id, title, or event excerpt matches ${query}.`,
    };
  }
  if (hits.length === 1) {
    return { kind: "session", entry: hits[0]! };
  }
  return {
    kind: "choose",
    title: "Resume matching session",
    entries: hits.slice(0, RESUME_PICKER_LIMIT),
  };
}
