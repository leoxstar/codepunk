import path from "node:path";
import type {
  AgentToolResult,
  Theme,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  asRecord,
  countLabel,
  failureText,
  heading,
  muted,
  numberValue,
  oneLine,
  setComponentText,
  stringValue,
  structuredResult,
  textContent,
  type RendererResultContext,
} from "./common.ts";

function displayPath(raw: string, cwd: string): string {
  if (raw.length === 0) {
    return "(file)";
  }
  if (!path.isAbsolute(raw)) {
    return raw;
  }
  const rel = path.relative(cwd, raw).split(path.sep).join("/");
  return rel.length === 0 || rel.startsWith("..") ? raw : rel;
}

function countDiffChanges(diffText: string): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of diffText.split(/\r?\n/u)) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function formatEditCall(
  args: unknown,
  theme: Theme,
  cwd: string,
  argsComplete: boolean,
): string {
  const record = asRecord(args);
  const target = displayPath(stringValue(record?.["path"]), cwd);
  const edits = Array.isArray(record?.["edits"]) ? record["edits"].length : 0;
  const parts = [
    heading(theme, "edit"),
    "·",
    theme.fg("accent", oneLine(target, 96)),
  ];
  if (edits > 1) {
    parts.push("·", muted(theme, countLabel(edits, "change")));
  }
  if (!argsComplete) {
    parts.push("·", muted(theme, "…"));
  }
  return parts.join(" ");
}

function formatEditResult(
  result: AgentToolResult<unknown>,
  theme: Theme,
  context: RendererResultContext,
): string {
  if (result.isError === true || context.isError) {
    return failureText(theme, "edit", result);
  }
  const argsRecord = asRecord(context.args);
  const target = displayPath(stringValue(argsRecord?.["path"]), context.cwd);
  const record = structuredResult(result);
  const diff = stringValue(record?.["diff"]);
  const parts = [
    heading(theme, "edit"),
    theme.fg("success", "✓"),
    theme.fg("text", oneLine(target, 90)),
  ];
  if (diff.length > 0) {
    const { added, removed } = countDiffChanges(diff);
    if (added > 0 || removed > 0) {
      parts.push(
        "·",
        theme.fg("success", `+${added}`),
        theme.fg("error", `-${removed}`),
      );
    }
  } else {
    const firstLine = oneLine(textContent(result), 90);
    if (firstLine.length > 0) {
      parts.push("·", muted(theme, firstLine));
    }
  }
  return parts.join(" ");
}

function formatWriteCall(
  args: unknown,
  theme: Theme,
  cwd: string,
  argsComplete: boolean,
): string {
  const record = asRecord(args);
  const target = displayPath(stringValue(record?.["path"]), cwd);
  const content = stringValue(record?.["content"]);
  const lines = content.length === 0 ? 0 : content.split(/\r?\n/u).length;
  const parts = [
    heading(theme, "write"),
    "·",
    theme.fg("accent", oneLine(target, 96)),
  ];
  if (lines > 0) {
    parts.push("·", muted(theme, countLabel(lines, "line")));
  }
  if (!argsComplete) {
    parts.push("·", muted(theme, "…"));
  }
  return parts.join(" ");
}

function formatWriteResult(
  result: AgentToolResult<unknown>,
  theme: Theme,
  context: RendererResultContext,
): string {
  if (result.isError === true || context.isError) {
    return failureText(theme, "write", result);
  }
  const argsRecord = asRecord(context.args);
  const target = displayPath(stringValue(argsRecord?.["path"]), context.cwd);
  const content = stringValue(argsRecord?.["content"]);
  const lines = content.length === 0 ? 0 : content.split(/\r?\n/u).length;
  const parts = [
    heading(theme, "write"),
    theme.fg("success", "✓"),
    theme.fg("text", oneLine(target, 90)),
  ];
  if (lines > 0) {
    parts.push("·", theme.fg("success", `+${lines} lines`));
  }
  return parts.join(" ");
}

function formatBashCall(
  args: unknown,
  theme: Theme,
  argsComplete: boolean,
): string {
  const record = asRecord(args);
  const cmd = oneLine(stringValue(record?.["command"]), 110);
  const parts = [heading(theme, "bash"), "·", theme.fg("text", cmd || "…")];
  if (!argsComplete) {
    parts.push("·", muted(theme, "…"));
  }
  return parts.join(" ");
}

function formatBashResult(
  result: AgentToolResult<unknown>,
  theme: Theme,
  context: RendererResultContext,
): string {
  if (result.isError === true || context.isError) {
    return failureText(theme, "bash", result);
  }
  const record = structuredResult(result);
  const exitCode =
    numberValue(record?.["exitCode"]) ?? numberValue(record?.["exit_code"]);
  const output = textContent(result).trim();
  const outputLines = output.length === 0 ? [] : output.split(/\r?\n/u);
  const badge =
    exitCode !== null && exitCode !== 0
      ? theme.fg("error", `exit ${exitCode}`)
      : theme.fg("success", "✓");
  const parts = [heading(theme, "bash"), badge];
  if (outputLines.length === 0) {
    parts.push("·", muted(theme, "(no output)"));
  } else if (outputLines.length === 1) {
    parts.push("·", muted(theme, oneLine(outputLines[0]!, 100)));
  } else {
    parts.push(
      "·",
      muted(theme, countLabel(outputLines.length, "line")),
      "·",
      muted(theme, oneLine(outputLines[0]!, 80)),
    );
  }
  return parts.join(" ");
}

export const editRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    return setComponentText(
      context,
      formatEditCall(args, theme, context.cwd, context.argsComplete),
    );
  },
  renderResult(result, _options, theme, context) {
    return setComponentText(context, formatEditResult(result, theme, context));
  },
};

export const writeRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    return setComponentText(
      context,
      formatWriteCall(args, theme, context.cwd, context.argsComplete),
    );
  },
  renderResult(result, _options, theme, context) {
    return setComponentText(context, formatWriteResult(result, theme, context));
  },
};

export const bashRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    return setComponentText(
      context,
      formatBashCall(args, theme, context.argsComplete),
    );
  },
  renderResult(result, _options, theme, context) {
    return setComponentText(context, formatBashResult(result, theme, context));
  },
};
