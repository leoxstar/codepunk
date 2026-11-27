import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

function textBlock(content: string): Text {
  return new Text(content, 0, 0);
}

export const lspQueryRenderers: ToolRenderers = {
  renderCall(args, theme) {
    const rec =
      args !== null && typeof args === "object"
        ? (args as Record<string, unknown>)
        : {};
    const action = typeof rec["action"] === "string" ? rec["action"] : "query";
    const symbol = typeof rec["symbol"] === "string" ? rec["symbol"] : "";
    const targetPath = typeof rec["path"] === "string" ? rec["path"] : "";
    const detail = [symbol, targetPath]
      .filter((s) => s.length > 0)
      .join(" in ");
    return textBlock(
      `${theme.fg("toolTitle", theme.bold("lsp_query"))} ${theme.fg("accent", action)}${
        detail.length > 0 ? ` ${theme.fg("muted", detail)}` : ""
      }`,
    );
  },
  renderResult(result, _options, theme) {
    const details =
      result.details !== null && typeof result.details === "object"
        ? (result.details as Record<string, unknown>)
        : {};
    const count = typeof details["count"] === "number" ? details["count"] : 0;
    const action =
      typeof details["action"] === "string" ? details["action"] : "query";
    return textBlock(
      theme.fg(
        result.isError ? "error" : "muted",
        result.isError
          ? "  LSP query failed"
          : `  ${count} ${action} result${count === 1 ? "" : "s"}`,
      ),
    );
  },
};
