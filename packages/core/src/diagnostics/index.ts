import path from "node:path";
import vm from "node:vm";
import { sha256Text } from "../platform/hash.ts";

export interface FileDiagnostic {
  readonly line: number | null;
  readonly column: number | null;
  readonly severity: "error";
  readonly message: string;
}

const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

function lineColFromOffset(
  source: string,
  offset: number,
): { line: number; column: number } {
  const safe = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < safe; i++) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      lastNewline = i;
    }
  }
  return { line, column: safe - lastNewline };
}

/**
 * Fast, zero-dependency syntax diagnostics run after file writes/edits so the
 * model sees parse errors immediately without running a full build. Never
 * executes user code.
 */
export function diagnoseFileContent(
  filePath: string,
  content: string,
): FileDiagnostic[] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") {
    try {
      JSON.parse(content);
      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const posMatch = /position (\d+)/iu.exec(message);
      if (posMatch !== null) {
        const loc = lineColFromOffset(content, Number(posMatch[1]));
        return [
          {
            line: loc.line,
            column: loc.column,
            severity: "error",
            message,
          },
        ];
      }
      return [{ line: null, column: null, severity: "error", message }];
    }
  }
  if (JS_EXTENSIONS.has(ext)) {
    const isModule =
      ext === ".mjs" || /^\s*(?:import|export)\b/mu.test(content);
    if (isModule) {
      // vm.Script only parses classic scripts; avoid false positives on ESM syntax.
      return [];
    }
    try {
      new vm.Script(content, { filename: path.basename(filePath) });
      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? (error.stack ?? "") : "";
      const lineMatch = /:(\d+)\n/u.exec(stack);
      return [
        {
          line: lineMatch !== null ? Number(lineMatch[1]) : null,
          column: null,
          severity: "error",
          message,
        },
      ];
    }
  }
  return [];
}

export function formatDiagnosticsSummary(
  displayPath: string,
  diagnostics: readonly FileDiagnostic[],
): string {
  if (diagnostics.length === 0) {
    return "";
  }
  const lines = diagnostics.slice(0, 5).map((item) => {
    const loc =
      item.line !== null
        ? item.column !== null
          ? `:${item.line}:${item.column}`
          : `:${item.line}`
        : "";
    return `  ${displayPath}${loc} [${item.severity}] ${item.message}`;
  });
  return `[post-write diagnostics]\n${lines.join("\n")}`;
}

export function lineAnchorHash(line: string): string {
  return sha256Text(line).slice(7, 11);
}

/**
 * When an edit target fails to match, return the closest candidate lines with
 * compact `L<n>:<hash4>` content anchors so the model can correct its patch on
 * the next turn.
 */
export function formatEditAnchorHints(
  content: string,
  searchText: string,
  maxLines = 8,
): string | null {
  const firstSearchLine = searchText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length >= 3);
  if (firstSearchLine === undefined) {
    return null;
  }
  const tokens = firstSearchLine
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((token) => token.length >= 2);
  if (tokens.length === 0) {
    return null;
  }
  const fileLines = content.split(/\r?\n/u);
  const scored: { index: number; score: number }[] = [];
  for (let i = 0; i < fileLines.length; i++) {
    const lower = fileLines[i]!.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (lower.includes(token)) {
        score += 1;
      }
    }
    if (score > 0) {
      scored.push({ index: i, score });
    }
  }
  if (scored.length === 0) {
    return null;
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const top = scored.slice(0, maxLines).sort((a, b) => a.index - b.index);
  const formatted = top.map(({ index }) => {
    const line = fileLines[index]!;
    return `  L${index + 1}:${lineAnchorHash(line)} | ${line.slice(0, 120)}`;
  });
  return `Closest matching lines (L<line>:<hash>):\n${formatted.join("\n")}`;
}
