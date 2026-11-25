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
} from "./common.ts";

export const subagentRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    const record = asRecord(args);
    const role = oneLine(stringValue(record?.["role"]), 24);
    const task = oneLine(stringValue(record?.["task"]), 90);
    const parts = [
      heading(theme, "subagent"),
      ...(role.length > 0 ? ["·", theme.fg("accent", role)] : []),
      "·",
      theme.fg("text", task || "…"),
    ];
    if (!context.argsComplete) {
      parts.push("·", muted(theme, "…"));
    }
    return setComponentText(context, parts.join(" "));
  },
  renderResult(result: AgentToolResult<unknown>, _options, theme, context) {
    if (result.isError === true || context.isError) {
      return setComponentText(context, failureText(theme, "subagent", result));
    }
    const record = structuredResult(result);
    const details = asRecord(result.details);
    const sessionId =
      stringValue(record?.["session_id"]) ||
      stringValue(details?.["sessionId"]);
    const status =
      stringValue(record?.["status"]) ||
      stringValue(details?.["status"]) ||
      "completed";
    const parts = [
      heading(theme, "subagent"),
      "·",
      theme.fg("accent", status),
      ...(sessionId.length > 0
        ? ["·", muted(theme, sessionId.slice(0, 10))]
        : []),
    ];
    return setComponentText(context, parts.join(" "));
  },
};
