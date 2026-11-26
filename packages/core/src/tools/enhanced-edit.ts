import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createEditToolDefinition,
  type EditToolDetails,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export interface EditReplacement {
  readonly oldText: string;
  readonly newText: string;
}

export interface IndentationFallbackResolution {
  readonly edits: EditReplacement[];
  readonly fallbackCount: number;
}

function normalizeToLf(text: string): string {
  return text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function stripBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function normalizeIndentLine(line: string): string {
  return line.replace(/^[ \t]+/u, "").trimEnd();
}

function leadingWhitespace(line: string): string {
  const match = /^[ \t]*/u.exec(line);
  return match === null ? "" : match[0];
}

function reindentBlock(
  newText: string,
  oldBaseIndent: string,
  fileBaseIndent: string,
): string {
  if (oldBaseIndent === fileBaseIndent) {
    return newText;
  }
  return newText
    .split("\n")
    .map((line) => {
      if (line.trim().length === 0) {
        return line.length === 0 ? "" : "";
      }
      if (oldBaseIndent.length > 0 && line.startsWith(oldBaseIndent)) {
        return `${fileBaseIndent}${line.slice(oldBaseIndent.length)}`;
      }
      if (oldBaseIndent.length === 0) {
        return `${fileBaseIndent}${line}`;
      }
      return line;
    })
    .join("\n");
}

function computeLineOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  return offsets;
}

/**
 * Extract normalized `{ oldText, newText }` replacements from either canonical
 * Pi `edits` arrays or legacy top-level `{ oldText, newText }` parameters.
 */
export function extractEditReplacements(
  params: Record<string, unknown>,
): EditReplacement[] | null {
  const out: EditReplacement[] = [];
  let rawEdits = params["edits"];
  if (typeof rawEdits === "string") {
    try {
      rawEdits = JSON.parse(rawEdits);
    } catch {
      rawEdits = undefined;
    }
  }
  if (Array.isArray(rawEdits)) {
    for (const item of rawEdits) {
      if (
        item === null ||
        typeof item !== "object" ||
        typeof (item as Record<string, unknown>)["oldText"] !== "string" ||
        typeof (item as Record<string, unknown>)["newText"] !== "string"
      ) {
        return null;
      }
      out.push({
        oldText: (item as Record<string, string>)["oldText"]!,
        newText: (item as Record<string, string>)["newText"]!,
      });
    }
  } else if (
    rawEdits !== null &&
    typeof rawEdits === "object" &&
    typeof (rawEdits as Record<string, unknown>)["oldText"] === "string" &&
    typeof (rawEdits as Record<string, unknown>)["newText"] === "string"
  ) {
    out.push({
      oldText: (rawEdits as Record<string, string>)["oldText"]!,
      newText: (rawEdits as Record<string, string>)["newText"]!,
    });
  }
  if (
    typeof params["oldText"] === "string" &&
    typeof params["newText"] === "string"
  ) {
    out.push({
      oldText: params["oldText"],
      newText: params["newText"],
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * Attempt a strictly-unique indentation-normalized line-block fallback for any
 * edit whose `oldText` failed exact matching. Never guesses when 0 or >1
 * line blocks match, and never allows overlapping replacements.
 */
export function resolveIndentationFallbackEdits(
  rawFileContent: string,
  edits: readonly EditReplacement[],
): IndentationFallbackResolution | null {
  if (edits.length === 0) {
    return null;
  }
  const content = normalizeToLf(stripBom(rawFileContent));
  const contentLines = content.split("\n");
  const normalizedContentLines = contentLines.map(normalizeIndentLine);
  const lineOffsets = computeLineOffsets(contentLines);

  interface Span {
    readonly start: number;
    readonly end: number;
    readonly edit: EditReplacement;
  }

  const spans: Span[] = [];
  let fallbackCount = 0;

  for (const edit of edits) {
    const oldText = normalizeToLf(edit.oldText);
    const newText = normalizeToLf(edit.newText);
    if (oldText.length === 0) {
      return null;
    }
    const exactFirst = content.indexOf(oldText);
    if (exactFirst >= 0) {
      if (content.indexOf(oldText, exactFirst + 1) >= 0) {
        return null;
      }
      spans.push({
        start: exactFirst,
        end: exactFirst + oldText.length,
        edit: { oldText, newText },
      });
      continue;
    }

    const oldLines = oldText.split("\n");
    const normalizedOldLines = oldLines.map(normalizeIndentLine);
    const anchorIdx = oldLines.findIndex((line) => line.trim().length > 0);
    if (anchorIdx < 0) {
      return null;
    }

    const matches: number[] = [];
    const maxStart = contentLines.length - oldLines.length;
    for (let start = 0; start <= maxStart; start += 1) {
      let ok = true;
      for (let k = 0; k < oldLines.length; k += 1) {
        if (normalizedContentLines[start + k] !== normalizedOldLines[k]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        matches.push(start);
        if (matches.length > 1) {
          return null;
        }
      }
    }
    if (matches.length !== 1) {
      return null;
    }

    const matchStart = matches[0]!;
    const matchedLines = contentLines.slice(
      matchStart,
      matchStart + oldLines.length,
    );
    const matchedExact = matchedLines.join("\n");
    const oldBaseIndent = leadingWhitespace(oldLines[anchorIdx]!);
    const fileBaseIndent = leadingWhitespace(matchedLines[anchorIdx]!);
    const adjustedNew = reindentBlock(newText, oldBaseIndent, fileBaseIndent);
    const startOffset = lineOffsets[matchStart]!;
    spans.push({
      start: startOffset,
      end: startOffset + matchedExact.length,
      edit: { oldText: matchedExact, newText: adjustedNew },
    });
    fallbackCount += 1;
  }

  if (fallbackCount === 0) {
    return null;
  }

  const ordered = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]!.start < ordered[i - 1]!.end) {
      return null;
    }
  }

  return {
    edits: spans.map((entry) => entry.edit),
    fallbackCount,
  };
}

function isNotFoundEditError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /Could not find (?:the exact text|edits\[\d+\])/u.test(error.message);
}

export function createEnhancedEditToolDefinition(
  cwd: string,
): ToolDefinition<any, EditToolDetails | undefined, any> {
  const base = createEditToolDefinition(cwd) as ToolDefinition<
    any,
    EditToolDetails | undefined,
    any
  >;
  return {
    ...base,
    description: `${base.description} If an edit misses only because of leading indentation differences and matches a unique line block in the file, Codepunk applies an indentation-preserving fallback automatically; ambiguous matches still fail loudly.`,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        return await base.execute(toolCallId, params, signal, onUpdate, ctx);
      } catch (error) {
        if (signal?.aborted === true || !isNotFoundEditError(error)) {
          throw error;
        }
        const record =
          params !== null && typeof params === "object"
            ? (params as Record<string, unknown>)
            : null;
        if (record === null || typeof record["path"] !== "string") {
          throw error;
        }
        const extracted = extractEditReplacements(record);
        if (extracted === null) {
          throw error;
        }
        const baseDir =
          ctx !== undefined &&
          ctx !== null &&
          typeof (ctx as { cwd?: unknown }).cwd === "string"
            ? (ctx as { cwd: string }).cwd
            : cwd;
        const targetPath = path.resolve(baseDir, record["path"]);
        let rawContent: string;
        try {
          rawContent = await fs.readFile(targetPath, "utf8");
        } catch {
          throw error;
        }
        const resolved = resolveIndentationFallbackEdits(rawContent, extracted);
        if (resolved === null) {
          throw error;
        }
        const nextParams = {
          path: record["path"],
          edits: resolved.edits,
        };
        const result = await base.execute(
          toolCallId,
          nextParams,
          signal,
          onUpdate,
          ctx,
        );
        const note = ` (applied ${resolved.fallbackCount} indentation-normalized block(s))`;
        const content = Array.isArray(result.content)
          ? result.content.map((block, index) =>
              index === 0 && block.type === "text"
                ? { ...block, text: `${block.text}${note}` }
                : block,
            )
          : result.content;
        return { ...result, content };
      }
    },
  };
}
