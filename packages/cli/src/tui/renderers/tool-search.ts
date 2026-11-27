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
  muted,
  oneLine,
  setComponentText,
  stringValue,
  structuredResult,
  type RendererResultContext,
} from "./common.ts";

function formatToolSearchCall(
  args: unknown,
  theme: Theme,
  argsComplete: boolean,
): string {
  const record = asRecord(args);
  const query = oneLine(stringValue(record?.["query"]), 80);
  const parts = [
    heading(theme, "tool_search"),
    "·",
    theme.fg("text", `"${query || "…"}"`),
  ];
  if (!argsComplete) {
    parts.push("·", muted(theme, "…"));
  }
  return parts.join(" ");
}

function formatToolSearchResult(
  result: AgentToolResult<unknown>,
  context: RendererResultContext,
  theme: Theme,
): string {
  if (context.isError) {
    return failureText(theme, "tool_search", result);
  }
  const structured = structuredResult(result);
  const loaded = asArray(structured?.["loaded"])
    .map((entry) => stringValue(entry))
    .filter((entry) => entry.length > 0);
  if (loaded.length === 0) {
    return [
      heading(theme, "tool_search"),
      "·",
      muted(theme, "no matches"),
    ].join(" ");
  }
  const preview = loaded.slice(0, 3).join(", ");
  const extra = loaded.length > 3 ? ` +${loaded.length - 3}` : "";
  return [
    heading(theme, "tool_search"),
    "·",
    theme.fg("accent", `loaded ${countLabel(loaded.length, "tool")}`),
    muted(theme, `(${preview}${extra})`),
  ].join(" ");
}

export const toolSearchRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    return setComponentText(
      context,
      formatToolSearchCall(args, theme, context.argsComplete),
    );
  },
  renderResult(result, _options, theme, context) {
    return setComponentText(
      context,
      formatToolSearchResult(result, context, theme),
    );
  },
};
