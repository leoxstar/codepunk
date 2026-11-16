import { redactOutputPreview } from "../artifacts/index.ts";
import { readSessionSnapshot } from "./index.ts";
import { listProjectSessions } from "./ops.ts";

const SEARCH_EXCERPT_MAX_CHARS = 180;
const MAX_MATCHES_PER_SESSION = 3;

export interface SessionSearchHit {
  session_id: string;
  title: string | null;
  updated_at: string;
  pinned: boolean;
  cwd: string;
  seq: number | null;
  kind: string;
  excerpt: string;
}

export interface SessionSearchResult {
  query: string;
  limit: number;
  scanned_sessions: number;
  truncated: boolean;
  warnings: string[];
  matches: SessionSearchHit[];
}

function boundedExcerpt(value: string): string {
  const collapsed = redactOutputPreview(value.replace(/\s+/gu, " ").trim());
  return collapsed.length <= SEARCH_EXCERPT_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, SEARCH_EXCERPT_MAX_CHARS - 1)}\u2026`;
}

function sourceExcerpt(source: string, query: string): string {
  const index = source.toLowerCase().indexOf(query);
  if (index < 0) {
    return boundedExcerpt(source.slice(0, SEARCH_EXCERPT_MAX_CHARS));
  }
  const start = Math.max(0, index - 56);
  const end = Math.min(
    source.length,
    index + query.length + SEARCH_EXCERPT_MAX_CHARS - 56,
  );
  return boundedExcerpt(
    `${start > 0 ? "\u2026" : ""}${source.slice(start, end)}${
      end < source.length ? "\u2026" : ""
    }`,
  );
}

/**
 * Search product session metadata and bounded event data. Shell stdout is not
 * stored in the product log, so a query cannot pull unbounded command output
 * into the result. Every excerpt is redacted before it leaves core.
 */
export async function searchProjectSessions(options: {
  rootDir: string;
  projectId: string;
  query: string;
  limit?: number;
}): Promise<SessionSearchResult> {
  const query = options.query.trim();
  if (query.length === 0) {
    throw new Error("session search requires a non-empty query");
  }
  if (query.length > 200) {
    throw new Error("session search query must be at most 200 characters");
  }
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("session search limit must be an integer from 1 to 100");
  }
  // Use the locale-independent lowercasing so a Turkish or other locale
  // default does not change which sessions match on the same machine.
  const needle = query.toLowerCase();
  const sessions = await listProjectSessions(
    options.rootDir,
    options.projectId,
  );
  const matches: SessionSearchHit[] = [];
  const warnings: string[] = [];
  let found = 0;
  let scanned = 0;
  for (const session of sessions) {
    scanned += 1;
    let sessionMatches = 0;
    const titleHit =
      session.title !== null && session.title.toLowerCase().includes(needle);
    if (titleHit) {
      found += 1;
      matches.push({
        session_id: session.id,
        title: session.title,
        updated_at: session.updated_at,
        pinned: session.pinned,
        cwd: session.cwd,
        seq: null,
        kind: "session/title",
        excerpt: boundedExcerpt(session.title ?? ""),
      });
      sessionMatches += 1;
    }
    if (found > limit) {
      break;
    }
    let snapshot;
    try {
      snapshot = await readSessionSnapshot({
        rootDir: options.rootDir,
        projectId: options.projectId,
        sessionId: session.id,
      });
    } catch (error) {
      warnings.push(
        `session ${session.id} could not be searched: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    for (const event of snapshot.events) {
      if (sessionMatches >= MAX_MATCHES_PER_SESSION) {
        break;
      }
      const source = JSON.stringify(event.data);
      if (!source.toLowerCase().includes(needle)) {
        continue;
      }
      found += 1;
      sessionMatches += 1;
      matches.push({
        session_id: session.id,
        title: session.title,
        updated_at: session.updated_at,
        pinned: session.pinned,
        cwd: session.cwd,
        seq: event.seq,
        kind: event.kind,
        excerpt: sourceExcerpt(source, needle),
      });
      if (found > limit) {
        break;
      }
    }
    if (found > limit) {
      break;
    }
  }
  return {
    query,
    limit,
    scanned_sessions: scanned,
    truncated: found > limit,
    warnings,
    matches: matches.slice(0, limit),
  };
}

export function formatSessionSearch(result: SessionSearchResult): string {
  if (result.matches.length === 0) {
    return `No matches for "${result.query}" in ${result.scanned_sessions} session(s).`;
  }
  const lines = [
    `Found ${result.matches.length}${result.truncated ? "+" : ""} match(es) for "${result.query}" in ${result.scanned_sessions} session(s).`,
  ];
  let currentSession: string | null = null;
  for (const match of result.matches) {
    if (match.session_id !== currentSession) {
      currentSession = match.session_id;
      const title =
        match.title === null || match.title.length === 0
          ? "(untitled)"
          : match.title;
      lines.push(
        `${match.pinned ? "*" : " "} ${match.session_id}  ${match.updated_at}  ${title}`,
      );
    }
    lines.push(
      `  ${match.seq === null ? "title" : `#${match.seq}`}  ${match.kind}  ${match.excerpt}`,
    );
  }
  if (result.warnings.length > 0) {
    lines.push(...result.warnings.map((warning) => `warning: ${warning}`));
  }
  return lines.join("\n");
}
