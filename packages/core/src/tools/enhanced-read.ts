import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createReadToolDefinition,
  type ReadToolDetails,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export interface OutlineEntry {
  readonly line: number;
  readonly kind: string;
  readonly name: string;
}

const OUTLINE_LINE_THRESHOLD = 400;
const OUTLINE_MAX_FILE_BYTES = 2 * 1024 * 1024;
const OUTLINE_DEFAULT_MAX_ENTRIES = 60;

const JS_TS_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const PYTHON_EXTENSIONS = new Set([".py"]);
const GO_EXTENSIONS = new Set([".go"]);
const RUST_EXTENSIONS = new Set([".rs"]);
const JVM_EXTENSIONS = new Set([".java", ".kt"]);
const RUBY_EXTENSIONS = new Set([".rb"]);
const SHELL_EXTENSIONS = new Set([".sh", ".bash", ".zsh"]);

function isOutlineExtension(ext: string): boolean {
  return (
    JS_TS_EXTENSIONS.has(ext) ||
    PYTHON_EXTENSIONS.has(ext) ||
    GO_EXTENSIONS.has(ext) ||
    RUST_EXTENSIONS.has(ext) ||
    JVM_EXTENSIONS.has(ext) ||
    RUBY_EXTENSIONS.has(ext) ||
    SHELL_EXTENSIONS.has(ext)
  );
}

function matchDeclaration(
  ext: string,
  line: string,
): { kind: string; name: string } | null {
  if (JS_TS_EXTENSIONS.has(ext)) {
    const decl =
      /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/u.exec(
        line,
      );
    if (decl !== null) {
      return { kind: decl[1]!.replace(/\*$/u, ""), name: decl[2]! };
    }
    const arrow =
      /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\b)/u.exec(
        line,
      );
    if (arrow !== null) {
      return { kind: "const", name: arrow[1]! };
    }
    return null;
  }
  if (PYTHON_EXTENSIONS.has(ext)) {
    const py = /^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/u.exec(line);
    return py === null ? null : { kind: py[1]!, name: py[2]! };
  }
  if (GO_EXTENSIONS.has(ext)) {
    const go = /^(func|type)\s+(?:\([^)]+\)\s+)?([A-Za-z_]\w*)/u.exec(line);
    return go === null ? null : { kind: go[1]!, name: go[2]! };
  }
  if (RUST_EXTENSIONS.has(ext)) {
    const rs =
      /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(fn|struct|enum|trait|impl|mod)\s+([A-Za-z_]\w*)/u.exec(
        line,
      );
    return rs === null ? null : { kind: rs[1]!, name: rs[2]! };
  }
  if (JVM_EXTENSIONS.has(ext)) {
    const jvm =
      /^\s{0,2}(?:(?:public|private|protected|internal|open|abstract|final|data|sealed|suspend|override|static)\s+)*(class|interface|object|enum|record|fun)\s+([A-Za-z_]\w*)/u.exec(
        line,
      );
    return jvm === null ? null : { kind: jvm[1]!, name: jvm[2]! };
  }
  if (RUBY_EXTENSIONS.has(ext)) {
    const rb = /^\s{0,2}(def|class|module)\s+([A-Za-z_]\w*[!?=]?)/u.exec(line);
    return rb === null ? null : { kind: rb[1]!, name: rb[2]! };
  }
  if (SHELL_EXTENSIONS.has(ext)) {
    const sh = /^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{/u.exec(line);
    return sh === null ? null : { kind: "function", name: sh[1]! };
  }
  return null;
}

/**
 * Extract top-level symbol declarations and their 1-based line numbers from a
 * source file without external parser dependencies.
 */
export function extractCodeOutline(
  filePath: string,
  content: string,
): OutlineEntry[] {
  const ext = path.extname(filePath).toLowerCase();
  if (!isOutlineExtension(ext)) {
    return [];
  }
  const lines = content.split(/\r?\n/u);
  const entries: OutlineEntry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.length === 0) {
      continue;
    }
    const matched = matchDeclaration(ext, line);
    if (matched !== null) {
      entries.push({
        line: i + 1,
        kind: matched.kind,
        name: matched.name,
      });
    }
  }
  return entries;
}

export function formatCodeOutline(
  filePath: string,
  content: string,
  maxEntries = OUTLINE_DEFAULT_MAX_ENTRIES,
): string | null {
  const entries = extractCodeOutline(filePath, content);
  if (entries.length < 2) {
    return null;
  }
  const totalLines = content.split(/\r?\n/u).length;
  const shown = entries.slice(0, maxEntries);
  const lines = [
    `[file outline — ${totalLines} lines, jump with offset/limit]`,
    ...shown.map((entry) => `  L${entry.line}: ${entry.kind} ${entry.name}`),
  ];
  if (entries.length > shown.length) {
    lines.push(`  ... (+${entries.length - shown.length} more symbols)`);
  }
  return lines.join("\n");
}

export function createEnhancedReadToolDefinition(
  cwd: string,
): ToolDefinition<any, ReadToolDetails | undefined, any> {
  const base = createReadToolDefinition(cwd) as ToolDefinition<
    any,
    ReadToolDetails | undefined,
    any
  >;
  return {
    ...base,
    description: `${base.description} For large code files read without offset/limit, a compact top-level symbol outline with line numbers is appended so you can jump directly with offset/limit.`,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await base.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
      const record =
        params !== null && typeof params === "object"
          ? (params as Record<string, unknown>)
          : null;
      if (
        record === null ||
        typeof record["path"] !== "string" ||
        record["offset"] !== undefined ||
        record["limit"] !== undefined
      ) {
        return result;
      }
      const hasImage =
        Array.isArray(result.content) &&
        result.content.some((block) => block.type === "image");
      if (hasImage) {
        return result;
      }
      const ext = path.extname(record["path"]).toLowerCase();
      if (!isOutlineExtension(ext)) {
        return result;
      }
      const baseDir =
        ctx !== undefined &&
        ctx !== null &&
        typeof (ctx as { cwd?: unknown }).cwd === "string"
          ? (ctx as { cwd: string }).cwd
          : cwd;
      const targetPath = path.resolve(baseDir, record["path"]);
      let stats;
      try {
        stats = await fs.stat(targetPath);
      } catch {
        return result;
      }
      if (!stats.isFile() || stats.size > OUTLINE_MAX_FILE_BYTES) {
        return result;
      }
      const truncated = result.details?.truncation?.truncated === true;
      let rawContent: string;
      try {
        rawContent = await fs.readFile(targetPath, "utf8");
      } catch {
        return result;
      }
      const lineCount = rawContent.split(/\r?\n/u).length;
      if (!truncated && lineCount <= OUTLINE_LINE_THRESHOLD) {
        return result;
      }
      const outline = formatCodeOutline(targetPath, rawContent);
      if (outline === null || !Array.isArray(result.content)) {
        return result;
      }
      const firstTextIndex = result.content.findIndex(
        (block) => block.type === "text",
      );
      if (firstTextIndex < 0) {
        return result;
      }
      const content = result.content.map((block, index) =>
        index === firstTextIndex && block.type === "text"
          ? { ...block, text: `${block.text}\n\n${outline}` }
          : block,
      );
      return { ...result, content };
    },
  };
}
