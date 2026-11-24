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
  shortHash,
  stringValue,
  structuredResult,
  textContent,
} from "./common.ts";

interface PlanEntry {
  readonly step: string;
  readonly status: string;
}

function planEntries(value: unknown): PlanEntry[] {
  const entries: PlanEntry[] = [];
  for (const item of asArray(value)) {
    const record = asRecord(item);
    const step = stringValue(record?.["step"]);
    if (step.length > 0) {
      entries.push({
        step,
        status: stringValue(record?.["status"]) || "pending",
      });
    }
  }
  return entries;
}

function formatPlanCall(
  args: unknown,
  theme: Theme,
  argsComplete: boolean,
): string {
  const record = asRecord(args);
  const entries = planEntries(record?.["plan"] ?? record?.["steps"]);
  const parts = [heading(theme, "plan")];
  if (!argsComplete) {
    parts.push(
      "·",
      muted(theme, entries.length > 0 ? `${entries.length} steps · …` : "…"),
    );
    return parts.join(" ");
  }
  if (entries.length === 0) {
    parts.push("·", muted(theme, "…"));
    return parts.join(" ");
  }
  parts.push("·", theme.fg("accent", countLabel(entries.length, "step")));
  const active = entries.find((entry) => entry.status === "in_progress");
  if (active !== undefined) {
    parts.push(
      "·",
      muted(theme, "in progress:"),
      theme.fg("text", oneLine(active.step, 80)),
    );
  } else {
    const completed = entries.filter(
      (entry) => entry.status === "completed",
    ).length;
    parts.push("·", muted(theme, `${completed} completed`));
  }
  return parts.join(" ");
}

function formatPlanResult(
  result: AgentToolResult<unknown>,
  theme: Theme,
  context: RendererResultContext,
): string {
  if (result.isError === true || context.isError) {
    return failureText(theme, "plan", result);
  }
  const record = structuredResult(result);
  const content = stringValue(textContent(result));
  const markers = markerSummary(content);
  if (record === null && markers.total === 0) {
    return `${heading(theme, "plan")} · ${muted(theme, "updated")}`;
  }
  const entries = planEntries(record?.["steps"]);
  const total =
    entries.length > 0
      ? entries.length
      : markers.total > 0
        ? markers.total
        : (numberValue(record?.["steps"]) ?? 0);
  const completed =
    entries.length > 0
      ? entries.filter((entry) => entry.status === "completed").length
      : markers.completed;
  const hash = shortHash(record?.["sha256"]);
  const parts = [
    heading(theme, "plan"),
    "·",
    theme.fg("accent", countLabel(total, "step")),
  ];
  if (completed > 0) {
    parts.push("·", muted(theme, `${completed} completed`));
  }
  if (hash !== null) {
    parts.push("·", muted(theme, `sha ${hash}`));
  }
  return parts.join(" ");
}

export const planRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    return setComponentText(
      context,
      formatPlanCall(args, theme, context.argsComplete),
    );
  },
  renderResult(result, _options, theme, context) {
    return setComponentText(context, formatPlanResult(result, theme, context));
  },
};
