import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { diagnoseFileContent } from "../diagnostics/index.ts";
import {
  isInsidePath,
  isSensitivePath,
  normalizeAbsolute,
  relativeDisplayPath,
  resolveRealPath,
} from "../platform/path.ts";
import { agentShellEnvironment } from "../sandbox/index.ts";

const execFileAsync = promisify(execFile);

export const LSP_QUERY_TOOL_NAME = "lsp_query" as const;

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
]);
const IGNORED_DIRS = new Set([
  ".git",
  ".codepunk",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "target",
  ".venv",
  "venv",
]);
const MAX_SCANNED_FILES = 600;
const MAX_FILE_BYTES = 512 * 1024;
const TSC_TIMEOUT_MS = 15_000;

export type LspQueryAction =
  "symbols" | "definition" | "references" | "diagnostics";

export type LspSymbolLocation = {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly name: string;
  readonly signature: string;
  readonly exported: boolean;
};

export type LspReferenceHit = {
  readonly file: string;
  readonly line: number;
  readonly preview: string;
};

export type LspDiagnosticItem = {
  readonly file: string;
  readonly line: number | null;
  readonly column: number | null;
  readonly code: string | null;
  readonly message: string;
  readonly source: "tsc" | "syntax";
};

export interface LspQueryOptions {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly additionalRoots?: readonly string[];
  readonly codepunkHome?: string;
  readonly projectTrusted?: () => boolean;
}

interface LspQueryParams {
  action: LspQueryAction;
  symbol?: string;
  path?: string;
}

const LspQuerySchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["symbols", "definition", "references", "diagnostics"],
      description:
        "Semantic query action: 'symbols' (outline declarations), 'definition' (jump to symbol definition), 'references' (find identifier usages), or 'diagnostics' (typecheck/syntax errors).",
    },
    symbol: {
      type: "string",
      minLength: 1,
      maxLength: 160,
      description:
        "Identifier name required for 'definition' and 'references', or optional filter for 'symbols'.",
    },
    path: {
      type: "string",
      description:
        "Optional workspace-relative file or directory path to scope or prioritize results.",
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function collectWorkspaceCodeFiles(
  startPath: string,
  roots: readonly string[],
  codepunkHome: string | undefined,
): Promise<string[]> {
  const realRoots = roots.map((r) => resolveRealPath(r));
  const files: string[] = [];

  async function visit(current: string): Promise<void> {
    if (files.length >= MAX_SCANNED_FILES) {
      return;
    }
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) {
      return;
    }
    const realCurrent = resolveRealPath(current);
    if (!realRoots.some((r) => isInsidePath(r, realCurrent))) {
      return;
    }
    if (isSensitivePath(realCurrent, codepunkHome, realRoots)) {
      return;
    }
    if (stat.isFile()) {
      if (
        stat.size <= MAX_FILE_BYTES &&
        CODE_EXTENSIONS.has(path.extname(current).toLowerCase())
      ) {
        files.push(realCurrent);
      }
      return;
    }
    if (!stat.isDirectory()) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_SCANNED_FILES) {
        break;
      }
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      await visit(path.join(current, entry.name));
    }
  }

  await visit(startPath);
  return files;
}

export function extractSymbolsFromSource(
  relFile: string,
  content: string,
): LspSymbolLocation[] {
  const ext = path.extname(relFile).toLowerCase();
  const lines = content.split(/\r?\n/u);
  const out: LspSymbolLocation[] = [];

  for (let idx = 0; idx < lines.length; idx += 1) {
    const rawLine = lines[idx]!;
    const trimmed = rawLine.trim();
    if (
      trimmed.length === 0 ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("*")
    ) {
      continue;
    }

    if (ext === ".py") {
      const pyMatch =
        /^(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(trimmed);
      if (pyMatch !== null) {
        out.push({
          file: relFile,
          line: idx + 1,
          kind: pyMatch[1] === "class" ? "class" : "function",
          name: pyMatch[2]!,
          signature: trimmed.slice(0, 120),
          exported: !pyMatch[2]!.startsWith("_"),
        });
      }
      continue;
    }

    if (ext === ".rs") {
      const rsMatch =
        /^(pub(?:\([^)]+\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|type)\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(
          trimmed,
        );
      if (rsMatch !== null) {
        out.push({
          file: relFile,
          line: idx + 1,
          kind: rsMatch[2]!,
          name: rsMatch[3]!,
          signature: trimmed.slice(0, 120),
          exported: Boolean(rsMatch[1]),
        });
      }
      continue;
    }

    if (ext === ".go") {
      const goMatch =
        /^(func|type)\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/u.exec(
          trimmed,
        );
      if (goMatch !== null) {
        const name = goMatch[2]!;
        out.push({
          file: relFile,
          line: idx + 1,
          kind: goMatch[1]!,
          name,
          signature: trimmed.slice(0, 120),
          exported: /^[A-Z]/u.test(name),
        });
      }
      continue;
    }

    const tsDecl =
      /^(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)/u.exec(
        trimmed,
      );
    if (tsDecl !== null) {
      out.push({
        file: relFile,
        line: idx + 1,
        kind: tsDecl[2]!,
        name: tsDecl[3]!,
        signature: trimmed.replace(/\s*\{$/u, "").slice(0, 120),
        exported: Boolean(tsDecl[1]),
      });
    }
  }
  return out;
}

export function parseTscDiagnosticsOutput(
  output: string,
  workspaceRoot: string,
): LspDiagnosticItem[] {
  const items: LspDiagnosticItem[] = [];
  const lineRe = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/u;
  for (const raw of output.split(/\r?\n/u)) {
    const match = lineRe.exec(raw.trim());
    if (match === null) {
      continue;
    }
    const rawFile = match[1]!;
    const absFile = path.isAbsolute(rawFile)
      ? normalizeAbsolute(rawFile)
      : normalizeAbsolute(path.resolve(workspaceRoot, rawFile));
    items.push({
      file: relativeDisplayPath(workspaceRoot, absFile),
      line: Number.parseInt(match[2]!, 10),
      column: Number.parseInt(match[3]!, 10),
      code: match[4]!,
      message: match[5]!,
      source: "tsc",
    });
  }
  return items;
}

async function runTrustedTscDiagnostics(
  workspaceRoot: string,
  targetPath: string | null,
): Promise<{
  items: LspDiagnosticItem[];
  ranTsc: boolean;
  note: string | null;
}> {
  const tsconfigCandidate =
    targetPath !== null && path.basename(targetPath) === "tsconfig.json"
      ? targetPath
      : path.join(workspaceRoot, "tsconfig.json");
  try {
    const stat = await fs.lstat(tsconfigCandidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { items: [], ranTsc: false, note: null };
    }
  } catch {
    return { items: [], ranTsc: false, note: null };
  }

  const binName = process.platform === "win32" ? "tsc.cmd" : "tsc";
  const localTsc = path.join(workspaceRoot, "node_modules", ".bin", binName);
  const localTscJs = path.join(
    workspaceRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );
  let cmd: string | null = null;
  let args: string[] = [];

  try {
    const jsStat = await fs.lstat(localTscJs);
    if (jsStat.isFile() && !jsStat.isSymbolicLink()) {
      cmd = process.execPath;
      args = [
        localTscJs,
        "-p",
        tsconfigCandidate,
        "--noEmit",
        "--pretty",
        "false",
      ];
    }
  } catch {
    // Try local .bin/tsc next if non-Windows.
  }

  if (cmd === null && process.platform !== "win32") {
    try {
      const binStat = await fs.lstat(localTsc);
      if (binStat.isFile() || binStat.isSymbolicLink()) {
        const realBin = resolveRealPath(localTsc);
        if (isInsidePath(resolveRealPath(workspaceRoot), realBin)) {
          cmd = realBin;
          args = ["-p", tsconfigCandidate, "--noEmit", "--pretty", "false"];
        }
      }
    } catch {
      // Fall back to lexical syntax diagnostics when tsc is not installed locally.
    }
  }

  if (cmd === null) {
    return { items: [], ranTsc: false, note: null };
  }

  try {
    await execFileAsync(cmd, args, {
      cwd: workspaceRoot,
      env: agentShellEnvironment(process.env),
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: TSC_TIMEOUT_MS,
      windowsHide: true,
    });
    return { items: [], ranTsc: true, note: null };
  } catch (error) {
    const errObj = error as {
      stdout?: unknown;
      stderr?: unknown;
      message?: string;
    };
    const combined = `${typeof errObj.stdout === "string" ? errObj.stdout : ""}\n${
      typeof errObj.stderr === "string" ? errObj.stderr : ""
    }`;
    const parsed = parseTscDiagnosticsOutput(combined, workspaceRoot);
    if (parsed.length > 0) {
      return { items: parsed, ranTsc: true, note: null };
    }
    return {
      items: [],
      ranTsc: true,
      note: `tsc check exited non-zero without TS diagnostics: ${(errObj.message ?? "failed").slice(0, 160)}`,
    };
  }
}

export function createLspQueryTool(
  options: LspQueryOptions,
): ToolDefinition<any, Record<string, unknown>, any> {
  return {
    name: LSP_QUERY_TOOL_NAME,
    label: "LSP Query",
    description:
      "Query workspace symbols, jump to symbol definitions, find identifier references, or run workspace typecheck/syntax diagnostics.",
    promptSnippet:
      "lsp_query — find symbol definitions, references, file/workspace symbols, or typecheck diagnostics",
    parameters: LspQuerySchema as never,
    async execute(
      _toolCallId,
      rawParams,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      const params = (
        rawParams !== null && typeof rawParams === "object" ? rawParams : {}
      ) as LspQueryParams;
      const roots = [
        normalizeAbsolute(options.workspaceRoot),
        ...(options.additionalRoots ?? []).map((r) => normalizeAbsolute(r)),
      ];
      const scopedStart =
        params.path === undefined
          ? normalizeAbsolute(options.workspaceRoot)
          : normalizeAbsolute(
              path.isAbsolute(params.path)
                ? params.path
                : path.resolve(options.cwd, params.path),
            );
      if (!roots.some((r) => isInsidePath(r, scopedStart))) {
        return {
          content: [
            {
              type: "text",
              text: `denied: path is outside workspace (${params.path ?? options.cwd})`,
            },
          ],
          details: { action: params.action, error: "outside_workspace" },
          isError: true,
        };
      }

      if (
        (params.action === "definition" || params.action === "references") &&
        (params.symbol === undefined || params.symbol.trim().length === 0)
      ) {
        return {
          content: [
            {
              type: "text",
              text: `lsp_query action '${params.action}' requires a non-empty 'symbol' parameter.`,
            },
          ],
          details: { action: params.action, error: "missing_symbol" },
          isError: true,
        };
      }

      if (params.action === "diagnostics") {
        const trusted = options.projectTrusted?.() === true;
        const diagnostics: LspDiagnosticItem[] = [];
        let note: string | null = null;
        let ranTsc = false;

        if (trusted) {
          const tscRes = await runTrustedTscDiagnostics(
            options.workspaceRoot,
            params.path === undefined ? null : scopedStart,
          );
          ranTsc = tscRes.ranTsc;
          note = tscRes.note;
          if (params.path !== undefined && tscRes.items.length > 0) {
            const relFilter = relativeDisplayPath(
              options.workspaceRoot,
              scopedStart,
            );
            diagnostics.push(
              ...tscRes.items.filter(
                (item) =>
                  item.file === relFilter ||
                  item.file.startsWith(`${relFilter}/`),
              ),
            );
          } else {
            diagnostics.push(...tscRes.items);
          }
        } else {
          note =
            "workspace config is untrusted; skipped external compiler execution and ran safe lexical syntax checks only";
        }

        const files = await collectWorkspaceCodeFiles(
          scopedStart,
          roots,
          options.codepunkHome,
        );
        for (const file of files) {
          const content = await fs.readFile(file, "utf8").catch(() => null);
          if (content === null) {
            continue;
          }
          const rel = relativeDisplayPath(options.workspaceRoot, file);
          for (const syn of diagnoseFileContent(file, content)) {
            diagnostics.push({
              file: rel,
              line: syn.line,
              column: syn.column,
              code: null,
              message: syn.message,
              source: "syntax",
            });
          }
        }

        const bounded = diagnostics.slice(0, 60);
        const textLines =
          bounded.length === 0
            ? [
                `No diagnostics found (${ranTsc ? "tsc --noEmit + syntax" : "syntax scan"} across ${files.length} file(s)).`,
              ]
            : [
                `Found ${diagnostics.length} diagnostic(s)${diagnostics.length > bounded.length ? ` (showing first ${bounded.length})` : ""}:`,
                ...bounded.map(
                  (d) =>
                    `  ${d.file}${d.line === null ? "" : `:${d.line}${d.column === null ? "" : `:${d.column}`}`} [${d.code ?? d.source}] ${d.message}`,
                ),
              ];
        if (note !== null) {
          textLines.push(`Note: ${note}`);
        }
        return {
          content: [{ type: "text", text: textLines.join("\n") }],
          details: {
            action: "diagnostics",
            count: diagnostics.length,
            ranTsc,
          },
          structuredContent: {
            action: "diagnostics",
            ran_tsc: ranTsc,
            count: diagnostics.length,
            diagnostics: bounded,
          },
        };
      }

      const scanTarget =
        params.action === "symbols"
          ? scopedStart
          : normalizeAbsolute(options.workspaceRoot);
      const files = await collectWorkspaceCodeFiles(
        scanTarget,
        roots,
        options.codepunkHome,
      );

      if (params.action === "symbols") {
        const query = params.symbol?.trim().toLowerCase() ?? "";
        const symbols: LspSymbolLocation[] = [];
        for (const file of files) {
          const content = await fs.readFile(file, "utf8").catch(() => null);
          if (content === null) {
            continue;
          }
          const rel = relativeDisplayPath(options.workspaceRoot, file);
          for (const sym of extractSymbolsFromSource(rel, content)) {
            if (query.length === 0 || sym.name.toLowerCase().includes(query)) {
              symbols.push(sym);
            }
          }
        }
        const bounded = symbols.slice(0, 80);
        const text =
          bounded.length === 0
            ? "No matching symbols found."
            : bounded
                .map(
                  (s) =>
                    `${s.file}:${s.line} [${s.kind}${s.exported ? " · export" : ""}] ${s.signature}`,
                )
                .join("\n");
        return {
          content: [{ type: "text", text }],
          details: { action: "symbols", count: symbols.length },
          structuredContent: {
            action: "symbols",
            count: symbols.length,
            symbols: bounded,
          },
        };
      }

      const targetSymbol = params.symbol!.trim();
      const focalDir =
        params.path !== undefined ? path.dirname(scopedStart) : options.cwd;

      if (params.action === "definition") {
        const defs: LspSymbolLocation[] = [];
        for (const file of files) {
          const content = await fs.readFile(file, "utf8").catch(() => null);
          if (content === null) {
            continue;
          }
          const rel = relativeDisplayPath(options.workspaceRoot, file);
          for (const sym of extractSymbolsFromSource(rel, content)) {
            if (sym.name === targetSymbol) {
              defs.push(sym);
            }
          }
        }
        defs.sort((a, b) => {
          const aFocal = path
            .resolve(options.workspaceRoot, a.file)
            .startsWith(focalDir)
            ? 1
            : 0;
          const bFocal = path
            .resolve(options.workspaceRoot, b.file)
            .startsWith(focalDir)
            ? 1
            : 0;
          if (aFocal !== bFocal) {
            return bFocal - aFocal;
          }
          if (a.exported !== b.exported) {
            return a.exported ? -1 : 1;
          }
          return a.file.localeCompare(b.file) || a.line - b.line;
        });
        const bounded = defs.slice(0, 30);
        const text =
          bounded.length === 0
            ? `No definition found for '${targetSymbol}'.`
            : bounded
                .map(
                  (d) =>
                    `${d.file}:${d.line} [${d.kind}${d.exported ? " · export" : ""}] ${d.signature}`,
                )
                .join("\n");
        return {
          content: [{ type: "text", text }],
          details: {
            action: "definition",
            symbol: targetSymbol,
            count: defs.length,
          },
          structuredContent: {
            action: "definition",
            symbol: targetSymbol,
            count: defs.length,
            definitions: bounded,
          },
        };
      }

      // action === "references"
      const identRe = new RegExp(
        `(?<![A-Za-z0-9_$])${escapeRegex(targetSymbol)}(?![A-Za-z0-9_$])`,
        "u",
      );
      const refs: LspReferenceHit[] = [];
      for (const file of files) {
        if (refs.length >= 80) {
          break;
        }
        const content = await fs.readFile(file, "utf8").catch(() => null);
        if (content === null || !content.includes(targetSymbol)) {
          continue;
        }
        const rel = relativeDisplayPath(options.workspaceRoot, file);
        const lines = content.split(/\r?\n/u);
        for (let idx = 0; idx < lines.length; idx += 1) {
          const line = lines[idx]!;
          if (identRe.test(line)) {
            refs.push({
              file: rel,
              line: idx + 1,
              preview: line.trim().slice(0, 140),
            });
            if (refs.length >= 80) {
              break;
            }
          }
        }
      }
      const text =
        refs.length === 0
          ? `No references found for '${targetSymbol}'.`
          : refs.map((r) => `${r.file}:${r.line}: ${r.preview}`).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          action: "references",
          symbol: targetSymbol,
          count: refs.length,
        },
        structuredContent: {
          action: "references",
          symbol: targetSymbol,
          count: refs.length,
          references: refs,
        },
      };
    },
  };
}
