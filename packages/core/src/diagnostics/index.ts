import path from "node:path";
import vm from "node:vm";
import { parseToml, TomlError } from "../config/toml.ts";
import { sha256Text } from "../platform/hash.ts";

export interface FileDiagnostic {
  readonly line: number | null;
  readonly column: number | null;
  readonly severity: "error";
  readonly message: string;
}

const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const TS_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx", ".jsx"]);

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

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "case",
  "throw",
  "else",
  "do",
  "typeof",
  "void",
  "delete",
  "in",
  "instanceof",
  "of",
  "yield",
  "await",
  "new",
]);

function canStartRegex(
  prevKind: "start" | "punct" | "word" | "close",
  prevToken: string,
  jsx: boolean,
): boolean {
  if (jsx && prevToken === "<") {
    return false;
  }
  if (prevKind === "start") {
    return true;
  }
  if (prevKind === "word") {
    return REGEX_PRECEDING_KEYWORDS.has(prevToken);
  }
  if (prevKind === "punct") {
    return prevToken !== "++" && prevToken !== "--";
  }
  return false;
}

/**
 * Zero-dependency lexical syntax check for TypeScript and ESM modules.
 * Catches unclosed strings/comments/templates and mismatched delimiters without
 * executing code or emitting Node experimental warnings.
 */
function diagnoseJsTsLexicalSyntax(
  source: string,
  jsx: boolean,
): FileDiagnostic[] {
  interface Frame {
    readonly open: "(" | "{" | "[";
    readonly line: number;
    readonly column: number;
    readonly templateExpr?: boolean;
  }
  const stack: Frame[] = [];
  const matching: Record<")" | "}" | "]", "(" | "{" | "["> = {
    ")": "(",
    "}": "{",
    "]": "[",
  };
  let line = 1;
  let col = 1;
  let i = 0;
  let prevKind: "start" | "punct" | "word" | "close" = "start";
  let prevToken = "";
  let inTemplate = false;
  let templateStartLine = 1;
  let templateStartCol = 1;

  const advance = () => {
    if (source[i] === "\n") {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
    i += 1;
  };

  while (i < source.length) {
    if (inTemplate) {
      const ch = source[i]!;
      if (ch === "\\") {
        advance();
        if (i < source.length) {
          advance();
        }
        continue;
      }
      if (ch === "`") {
        inTemplate = false;
        advance();
        prevKind = "close";
        prevToken = "`";
        continue;
      }
      if (ch === "$" && source[i + 1] === "{") {
        const startLine = line;
        const startCol = col;
        advance();
        advance();
        stack.push({
          open: "{",
          line: startLine,
          column: startCol,
          templateExpr: true,
        });
        inTemplate = false;
        prevKind = "punct";
        prevToken = "{";
        continue;
      }
      advance();
      continue;
    }

    const ch = source[i]!;
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      advance();
      continue;
    }
    if (ch === "#" && i === 0 && source[1] === "!") {
      while (i < source.length && source[i] !== "\n") {
        advance();
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      advance();
      advance();
      while (i < source.length && source[i] !== "\n") {
        advance();
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const startLine = line;
      const startCol = col;
      advance();
      advance();
      let closed = false;
      while (i < source.length) {
        if (source[i] === "*" && source[i + 1] === "/") {
          advance();
          advance();
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        return [
          {
            line: startLine,
            column: startCol,
            severity: "error",
            message: "Unterminated block comment",
          },
        ];
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const startLine = line;
      const startCol = col;
      advance();
      let closed = false;
      while (i < source.length) {
        const c = source[i]!;
        if (c === "\\") {
          advance();
          if (i < source.length) {
            advance();
          }
          continue;
        }
        if (c === "\n") {
          break;
        }
        if (c === quote) {
          advance();
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        return [
          {
            line: startLine,
            column: startCol,
            severity: "error",
            message: "Unterminated string literal",
          },
        ];
      }
      prevKind = "close";
      prevToken = quote;
      continue;
    }
    if (ch === "`") {
      templateStartLine = line;
      templateStartCol = col;
      inTemplate = true;
      advance();
      continue;
    }
    if (ch === "/" && canStartRegex(prevKind, prevToken, jsx)) {
      const startLine = line;
      const startCol = col;
      advance();
      let inClass = false;
      let closed = false;
      while (i < source.length) {
        const c = source[i]!;
        if (c === "\\") {
          advance();
          if (i < source.length) {
            advance();
          }
          continue;
        }
        if (c === "\n") {
          break;
        }
        if (c === "[") {
          inClass = true;
        } else if (c === "]") {
          inClass = false;
        } else if (c === "/" && !inClass) {
          advance();
          while (i < source.length && /[a-z]/iu.test(source[i]!)) {
            advance();
          }
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        return [
          {
            line: startLine,
            column: startCol,
            severity: "error",
            message: "Unterminated regular expression literal",
          },
        ];
      }
      prevKind = "close";
      prevToken = "/";
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      stack.push({ open: ch, line, column: col });
      prevKind = "punct";
      prevToken = ch;
      advance();
      continue;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      const expected = matching[ch];
      const top = stack.pop();
      if (top === undefined || top.open !== expected) {
        return [
          {
            line,
            column: col,
            severity: "error",
            message: `Unexpected '${ch}'${
              top !== undefined
                ? ` (expected closing delimiter for '${top.open}' from line ${top.line})`
                : ""
            }`,
          },
        ];
      }
      advance();
      if (ch === "}" && top.templateExpr === true) {
        inTemplate = true;
        continue;
      }
      prevKind = "close";
      prevToken = ch;
      continue;
    }
    if (/[A-Za-z_$]/u.test(ch)) {
      let word = "";
      while (i < source.length && /[A-Za-z0-9_$]/u.test(source[i]!)) {
        word += source[i]!;
        advance();
      }
      prevKind = "word";
      prevToken = word;
      continue;
    }
    if (/[0-9]/u.test(ch)) {
      while (i < source.length && /[0-9A-Za-z_.-]/u.test(source[i]!)) {
        if (
          source[i] === "-" &&
          source[i - 1] !== "e" &&
          source[i - 1] !== "E"
        ) {
          break;
        }
        advance();
      }
      prevKind = "close";
      prevToken = "0";
      continue;
    }
    if (
      (ch === "+" && source[i + 1] === "+") ||
      (ch === "-" && source[i + 1] === "-")
    ) {
      prevKind = "punct";
      prevToken = ch + ch;
      advance();
      advance();
      continue;
    }
    prevKind = "punct";
    prevToken = ch;
    advance();
  }

  if (inTemplate) {
    return [
      {
        line: templateStartLine,
        column: templateStartCol,
        severity: "error",
        message: "Unterminated template literal",
      },
    ];
  }
  const unclosed = stack.at(-1);
  if (unclosed !== undefined) {
    return [
      {
        line: unclosed.line,
        column: unclosed.column,
        severity: "error",
        message: `Unclosed '${unclosed.open}'`,
      },
    ];
  }
  return [];
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
  if (ext === ".toml") {
    try {
      parseToml(content);
      return [];
    } catch (error) {
      if (error instanceof TomlError) {
        return [
          {
            line: error.line,
            column: null,
            severity: "error",
            message: error.message,
          },
        ];
      }
      return [
        {
          line: null,
          column: null,
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
        },
      ];
    }
  }
  if (TS_EXTENSIONS.has(ext)) {
    return diagnoseJsTsLexicalSyntax(content, ext === ".tsx" || ext === ".jsx");
  }
  if (JS_EXTENSIONS.has(ext)) {
    const isModule =
      ext === ".mjs" || /^\s*(?:import|export)\b/mu.test(content);
    if (isModule) {
      return diagnoseJsTsLexicalSyntax(content, false);
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
  return sha256Text(line.trim())
    .replace(/^sha256:/u, "")
    .slice(0, 4);
}

/**
 * When an edit fails because `oldText` did not match verbatim, emit a short
 * block of nearby candidate lines annotated with `L<line>:<hash4>` anchors so
 * the model can correct its patch on the very next turn without re-reading the
 * entire file.
 */
export function formatEditAnchorHints(
  fileContent: string,
  oldText: string,
  maxLines = 8,
): string | null {
  const targetLines = oldText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length >= 3);
  if (targetLines.length === 0) {
    return null;
  }
  const needle = targetLines[0]!.toLowerCase();
  const sourceLines = fileContent.split(/\r?\n/u);
  let bestIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < sourceLines.length; i++) {
    const candidate = sourceLines[i]!.trim().toLowerCase();
    if (candidate.length === 0) {
      continue;
    }
    let score = 0;
    if (candidate === needle) {
      score = 100;
    } else if (candidate.includes(needle) || needle.includes(candidate)) {
      score = 60;
    } else {
      const tokens = needle.split(/[^a-z0-9_]+/u).filter((t) => t.length >= 3);
      for (const token of tokens) {
        if (candidate.includes(token)) {
          score += 10;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  if (bestIndex < 0 || bestScore < 20) {
    return null;
  }
  const start = Math.max(0, bestIndex - 2);
  const end = Math.min(sourceLines.length, start + maxLines);
  const snippet = [];
  for (let i = start; i < end; i++) {
    const line = sourceLines[i]!;
    snippet.push(`  L${i + 1}:${lineAnchorHash(line)} | ${line}`);
  }
  return ["[edit anchor hint — closest lines in file]", ...snippet].join("\n");
}
