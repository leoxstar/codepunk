import type {
  AgentToolResult,
  Theme,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  asArray,
  asRecord,
  countLabel,
  failureText,
  heading,
  markerSummary,
  muted,
  numberValue,
  oneLine,
  type RendererResultContext,
  setComponentText,
  stringValue,
  structuredResult,
  textContent,
} from "./common.ts";

interface TodoEntry {
  readonly content: string;
  readonly status: string;
}

function todoEntries(value: unknown): TodoEntry[] {
  const entries: TodoEntry[] = [];
  for (const item of asArray(value)) {
    const record = asRecord(item);
    const content = stringValue(record?.["content"]);
    if (content.length > 0) {
      entries.push({
        content,
        status: stringValue(record?.["status"]) || "pending",
      });
    }
  }
  return entries;
}

function formatTodoCall(
  args: unknown,
  theme: Theme,
  argsComplete: boolean,
): string {
  const record = asRecord(args);
  const hasTodos =
    record !== null &&
    (Object.hasOwn(record, "todos") || Object.hasOwn(record, "items"));
  const entries = todoEntries(record?.["todos"] ?? record?.["items"]);
  if (!argsComplete) {
    return `${heading(theme, "todo")} · ${muted(theme, "…")}`;
  }
  if (!hasTodos) {
    return `${heading(theme, "todo")} · ${muted(theme, "current")}`;
  }
  if (entries.length === 0) {
    return `${heading(theme, "todo")} · ${muted(theme, "cleared")}`;
  }
  const parts = [
    heading(theme, "todo"),
    "·",
    theme.fg("accent", countLabel(entries.length, "item")),
  ];
  const active = entries.find((entry) => entry.status === "in_progress");
  if (active !== undefined) {
    parts.push(
      "·",
      muted(theme, "in progress:"),
      theme.fg("text", oneLine(active.content, 80)),
    );
  }
  return parts.join(" ");
}

function formatTodoResult(
  result: AgentToolResult<unknown>,
  theme: Theme,
  context: RendererResultContext,
): string {
  if (result.isError === true || context.isError) {
    return failureText(theme, "todo", result);
  }
  const record = structuredResult(result);
  const entries = todoEntries(record?.["todos"] ?? record?.["items"]);
  const markers = markerSummary(textContent(result));
  const total =
    entries.length > 0
      ? entries.length
      : markers.total > 0
        ? markers.total
        : (numberValue(record?.["items"]) ?? 0);
  if (total === 0) {
    return `${heading(theme, "todo")} · ${muted(theme, "cleared")}`;
  }
  const inProgress =
    entries.length > 0
      ? entries.filter((entry) => entry.status === "in_progress").length
      : markers.inProgress;
  const completed =
    entries.length > 0
      ? entries.filter((entry) => entry.status === "completed").length
      : markers.completed;
  return [
    heading(theme, "todo"),
    "·",
    theme.fg("accent", countLabel(total, "item")),
    "·",
    muted(theme, `${inProgress} in progress`),
    "·",
    muted(theme, `${completed} completed`),
  ].join(" ");
}

export const todoRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    return setComponentText(
      context,
      formatTodoCall(args, theme, context.argsComplete),
    );
  },
  renderResult(result, _options, theme, context) {
    return setComponentText(context, formatTodoResult(result, theme, context));
  },
};
