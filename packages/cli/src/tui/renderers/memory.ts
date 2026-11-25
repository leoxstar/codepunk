import type {
  AgentToolResult,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  asRecord,
  failureText,
  heading,
  muted,
  oneLine,
  setComponentText,
  stringValue,
  textContent,
} from "./common.ts";

export const memorySearchRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    const record = asRecord(args);
    const query = oneLine(stringValue(record?.["query"]), 90);
    const parts = [
      heading(theme, "memory_search"),
      "·",
      theme.fg("text", `"${query || "…"}"`),
    ];
    if (!context.argsComplete) {
      parts.push("·", muted(theme, "…"));
    }
    return setComponentText(context, parts.join(" "));
  },
  renderResult(result: AgentToolResult<unknown>, _options, theme, context) {
    if (result.isError === true || context.isError) {
      return setComponentText(
        context,
        failureText(theme, "memory_search", result),
      );
    }
    const text = textContent(result).trim();
    const summary =
      text.length === 0 || text.includes("No matching memories")
        ? muted(theme, "no matches")
        : theme.fg("accent", oneLine(text, 80));
    return setComponentText(
      context,
      `${heading(theme, "memory_search")} · ${summary}`,
    );
  },
};
