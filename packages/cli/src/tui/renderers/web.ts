import type {
  AgentToolResult,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  asRecord,
  countLabel,
  failureText,
  heading,
  muted,
  oneLine,
  setComponentText,
  stringValue,
  structuredResult,
  textContent,
} from "./common.ts";

export const webFetchRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    const record = asRecord(args);
    const url = oneLine(stringValue(record?.["url"]), 100);
    const parts = [
      heading(theme, "web_fetch"),
      "·",
      theme.fg("accent", url || "…"),
    ];
    if (!context.argsComplete) {
      parts.push("·", muted(theme, "…"));
    }
    return setComponentText(context, parts.join(" "));
  },
  renderResult(result: AgentToolResult<unknown>, _options, theme, context) {
    if (result.isError === true || context.isError) {
      return setComponentText(context, failureText(theme, "web_fetch", result));
    }
    const record = structuredResult(result);
    const status = record?.["status"];
    const bytes = record?.["bytes"];
    const parts = [heading(theme, "web_fetch")];
    if (typeof status === "number") {
      parts.push("·", theme.fg("accent", `HTTP ${status}`));
    }
    if (typeof bytes === "number") {
      parts.push("·", muted(theme, `${bytes} B`));
    } else {
      const content = textContent(result);
      parts.push("·", muted(theme, `${Buffer.byteLength(content)} B`));
    }
    if (record?.["truncated"] === true) {
      parts.push("·", theme.fg("warning", "truncated"));
    }
    return setComponentText(context, parts.join(" "));
  },
};

export const webSearchRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    const record = asRecord(args);
    const query = oneLine(stringValue(record?.["query"]), 100);
    const parts = [
      heading(theme, "web_search"),
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
        failureText(theme, "web_search", result),
      );
    }
    const record = structuredResult(result);
    const details = asRecord(result.details);
    const count =
      typeof record?.["count"] === "number"
        ? record["count"]
        : typeof details?.["count"] === "number"
          ? details["count"]
          : 0;
    const summary =
      count === 0
        ? muted(theme, "no results")
        : theme.fg("accent", countLabel(count, "result", "results"));
    return setComponentText(
      context,
      `${heading(theme, "web_search")} · ${summary}`,
    );
  },
};
