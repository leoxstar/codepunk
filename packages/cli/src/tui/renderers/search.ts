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
  oneLine,
  type RendererResultContext,
  setComponentText,
  stringValue,
  structuredResult,
  textContent,
} from "./common.ts";

type SearchMode = "grep" | "find" | "ls";

interface SearchLine {
  readonly file: string;
  readonly match: boolean;
}

function searchMode(value: unknown): SearchMode {
  return value === "find" || value === "ls" ? value : "grep";
}

function modeFromArgs(args: unknown): SearchMode {
  return searchMode(asRecord(args)?.["mode"]);
}

function formatSearchCall(
  args: unknown,
  theme: Theme,
  argsComplete: boolean,
): string {
  const record = asRecord(args);
  const mode = searchMode(record?.["mode"]);
  const query = oneLine(stringValue(record?.["query"]), 80);
  const target = oneLine(stringValue(record?.["path"]), 80);
  const glob = oneLine(stringValue(record?.["glob"]), 80);
  const parts = [heading(theme, "search"), "·", theme.fg("accent", mode)];
  if (mode === "ls") {
    parts.push(
      theme.fg(
        "text",
        query.length === 0 ? target || "." : `${target || "."} "${query}"`,
      ),
    );
  } else {
    parts.push(theme.fg("text", `"${query || "…"}"`));
    if (target.length > 0 && target !== ".") {
      parts.push(muted(theme, `in ${target}`));
    }
    if (glob.length > 0) {
      parts.push(muted(theme, `(${glob})`));
    }
  }
  if (record?.["regex"] === true) {
    parts.push(muted(theme, "regex"));
  }
  if (record?.["ignoreCase"] === true) {
    parts.push(muted(theme, "ignore-case"));
  }
  if (!argsComplete) {
    parts.push("·", muted(theme, "…"));
  }
  return parts.join(" ");
}

function parseSearchLine(line: string, mode: SearchMode): SearchLine | null {
  if (mode === "grep") {
    const matched = /^(.*):(\d+):(.*)$/u.exec(line);
    if (matched !== null) {
      return { file: matched[1] ?? "", match: true };
    }
    const context = /^(.*)-(\d+)-(.*)$/u.exec(line);
    return context === null ? null : { file: context[1] ?? "", match: false };
  }
  if (mode === "ls") {
    const entry = /^[fd]\s+(.*)$/u.exec(line);
    return entry === null ? null : { file: entry[1] ?? "", match: true };
  }
  return { file: line, match: true };
}

function relativePath(candidate: string, cwd: string): string {
  if (!path.isAbsolute(candidate)) {
    return candidate;
  }
  const relative = path.relative(cwd, candidate).split(path.sep).join("/");
  return relative.length === 0 || relative.startsWith("..")
    ? candidate
    : relative;
}

function summarizeSearch(
  output: string,
  mode: SearchMode,
  cwd: string,
): { count: number; firstPath: string | null } {
  let count = 0;
  let firstPath: string | null = null;
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    const parsed = parseSearchLine(line, mode);
    if (parsed === null) {
      continue;
    }
    if (parsed.match) {
      count += 1;
    }
    if (firstPath === null && parsed.file.length > 0) {
      firstPath = relativePath(parsed.file, cwd);
    }
  }
  return { count, firstPath };
}

function formatSearchResult(
  result: AgentToolResult<unknown>,
  theme: Theme,
  context: RendererResultContext,
): string {
  if (result.isError === true || context.isError) {
    return failureText(theme, "search", result);
  }
  const record = structuredResult(result);
  const mode = modeFromArgs(context.args);
  const content = textContent(result);
  const structuredOutput = stringValue(record?.["output"]);
  const output = (
    structuredOutput.length > 0 ? structuredOutput : content
  ).replace(/\n?\[output truncated\]\s*$/u, "");
  const trimmedContent = content.trim();
  const empty =
    record?.["empty_result"] === true ||
    output.trim().length === 0 ||
    trimmedContent === "(no matches)" ||
    trimmedContent === "(no entries)";
  if (empty) {
    return `${heading(theme, "search")} · ${muted(
      theme,
      mode === "ls" ? "no entries" : "no matches",
    )}`;
  }
  const summary = summarizeSearch(output, mode, context.cwd);
  const noun =
    mode === "ls"
      ? { singular: "entry", plural: "entries" }
      : mode === "find"
        ? { singular: "path", plural: "paths" }
        : { singular: "match", plural: "matches" };
  const parts = [
    heading(theme, "search"),
    "·",
    theme.fg("accent", countLabel(summary.count, noun.singular, noun.plural)),
  ];
  if (summary.firstPath !== null) {
    parts.push("·", muted(theme, oneLine(summary.firstPath, 100)));
  }
  if (
    record?.["truncated"] === true ||
    content.includes("[output truncated]")
  ) {
    parts.push("·", theme.fg("warning", "truncated"));
  }
  if (record?.["timed_out"] === true) {
    parts.push("·", theme.fg("warning", "timed out"));
  }
  return parts.join(" ");
}

export const searchRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    return setComponentText(
      context,
      formatSearchCall(args, theme, context.argsComplete),
    );
  },
  renderResult(result, _options, theme, context) {
    return setComponentText(
      context,
      formatSearchResult(result, theme, context),
    );
  },
};
