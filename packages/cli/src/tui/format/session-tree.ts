import type { listProjectSessions, SessionSearchHit } from "codepunk-core";

export interface TreeEntryView {
  id: string;
  type: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  summary?: string;
  customType?: string;
}

export interface TreeNodeView {
  entry: TreeEntryView;
  children: TreeNodeView[];
  label?: string;
}

export function previewText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => {
      if (
        part !== null &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join(" ");
}

export function treeEntryPreview(entry: TreeEntryView): string {
  const raw =
    entry.type === "message"
      ? previewText(entry.message?.content)
      : entry.type === "compaction"
        ? (entry.summary ?? "")
        : entry.type === "custom_message"
          ? `[${entry.customType ?? "custom"}] ${previewText((entry as { content?: unknown }).content)}`
          : "";
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return "";
  }
  return collapsed.length <= 64 ? collapsed : `${collapsed.slice(0, 63)}…`;
}

export function formatSessionTree(
  tree: readonly TreeNodeView[],
  leafId: string | null,
): string {
  if (tree.length === 0) {
    return "Session tree is empty.";
  }
  const lines = [
    `Session tree (leaf ${leafId ?? "none"})`,
    "  * marks the current leaf; use /tree <entry-id> to move there",
  ];
  const walk = (nodes: readonly TreeNodeView[], depth: number): void => {
    for (const node of nodes) {
      const marker = node.entry.id === leafId ? " *" : "  ";
      const label = node.label === undefined ? "" : `  [${node.label}]`;
      const preview = treeEntryPreview(node.entry);
      lines.push(
        `${"  ".repeat(depth)}${marker} ${node.entry.id}  ${node.entry.type}${label}${
          preview.length === 0 ? "" : `  ${preview}`
        }`,
      );
      walk(node.children, depth + 1);
    }
  };
  walk(tree, 1);
  return lines.join("\n");
}

export function sessionChoiceLabel(
  entry: Awaited<ReturnType<typeof listProjectSessions>>[number],
  currentId: string,
): string {
  return `${entry.id === currentId ? "*" : " "} ${entry.id}  ${entry.updated_at}  ${
    entry.title ?? "(untitled)"
  }${entry.parent_session_id === null ? "" : `  from ${entry.parent_session_id}`}`;
}

export function sessionSearchChoiceLabels(
  hits: readonly SessionSearchHit[],
  entries: Awaited<ReturnType<typeof listProjectSessions>>,
  currentId: string,
): { ids: string[]; labels: string[] } {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const ids: string[] = [];
  const labels: string[] = [];
  for (const hit of hits) {
    if (seen.has(hit.session_id)) {
      continue;
    }
    const entry = byId.get(hit.session_id);
    if (entry === undefined) {
      continue;
    }
    seen.add(hit.session_id);
    ids.push(hit.session_id);
    const excerpt =
      hit.excerpt.length <= 96 ? hit.excerpt : `${hit.excerpt.slice(0, 95)}…`;
    labels.push(
      `${sessionChoiceLabel(entry, currentId)}  ${hit.kind}  ${excerpt}`,
    );
  }
  return { ids, labels };
}

/**
 * Pi tears down the current host session before it builds the replacement.
 * A target that cannot be opened or locked therefore costs the live TUI
 * runtime, not just the switch. Check the durable store first so a live
 * writer, stale state, or corrupt session is reported before teardown.
 */
