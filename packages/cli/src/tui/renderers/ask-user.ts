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
  structuredResult,
  textContent,
} from "./common.ts";

export const askUserRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    const record = asRecord(args);
    const question = oneLine(stringValue(record?.["question"]), 100);
    const parts = [
      heading(theme, "ask_user"),
      "·",
      theme.fg("text", question || "…"),
    ];
    if (!context.argsComplete) {
      parts.push("·", muted(theme, "…"));
    }
    return setComponentText(context, parts.join(" "));
  },
  renderResult(result: AgentToolResult<unknown>, _options, theme, context) {
    if (result.isError === true || context.isError) {
      return setComponentText(context, failureText(theme, "ask_user", result));
    }
    const record = structuredResult(result);
    if (record?.["cancelled"] === true) {
      return setComponentText(
        context,
        `${heading(theme, "ask_user")} · ${theme.fg("warning", "cancelled")}`,
      );
    }
    const label = oneLine(
      stringValue(record?.["freeform_text"]) ||
        stringValue(record?.["selected_label"]) ||
        textContent(result).replace(/^User selected:\s*/u, ""),
      100,
    );
    return setComponentText(
      context,
      `${heading(theme, "ask_user")} · ${theme.fg("accent", label || "answered")}`,
    );
  },
};
