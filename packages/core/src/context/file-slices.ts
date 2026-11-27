import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isInsidePath,
  isSensitivePath,
  normalizeAbsolute,
  relativeDisplayPath,
  resolveRealPath,
} from "../platform/path.ts";

export const MAX_PROMPT_FILE_SLICES = 5;
export const MAX_PROMPT_SLICE_TOTAL_BYTES = 32 * 1024;

export interface PromptFileSlice {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
}

export interface ExpandPromptFileSlicesOptions {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly deliveryRoot?: string;
  readonly additionalRoots?: readonly string[];
  readonly codepunkHome?: string;
  readonly filesystem?: "workspace" | "full";
  readonly maxSlices?: number;
  readonly maxTotalBytes?: number;
}

interface ParsedSliceToken {
  readonly raw: string;
  readonly candidatePath: string;
  readonly startLine: number;
  readonly endLine: number;
}

function maskCodeSpans(text: string): string {
  // Replace fenced code blocks and inline backticks with spaces of equal length
  // so @file#L references inside code examples are not expanded.
  return text
    .replace(/```[\s\S]*?```/gu, (match) => " ".repeat(match.length))
    .replace(/`[^`\r\n]*`/gu, (match) => " ".repeat(match.length));
}

function extractSliceTokens(prompt: string): ParsedSliceToken[] {
  const masked = maskCodeSpans(prompt);
  const pattern =
    /(?:^|(?<=\s))@([A-Za-z0-9_./-]+)#L(\d+)(?:-(?:L)?(\d+))?(?=$|\s|[,.;:)!?])/gu;
  const seen = new Set<string>();
  const tokens: ParsedSliceToken[] = [];
  for (const match of masked.matchAll(pattern)) {
    const raw = match[0] ?? "";
    const candidatePath = match[1] ?? "";
    const startLine = Number.parseInt(match[2] ?? "0", 10);
    const endLine =
      match[3] === undefined ? startLine : Number.parseInt(match[3], 10);
    if (
      candidatePath.length === 0 ||
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine
    ) {
      continue;
    }
    const key = `${candidatePath}#${startLine}-${endLine}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tokens.push({ raw, candidatePath, startLine, endLine });
  }
  return tokens;
}

export async function expandPromptFileSlices(
  prompt: string,
  options: ExpandPromptFileSlicesOptions,
): Promise<{
  text: string;
  slices: PromptFileSlice[];
  warnings: string[];
}> {
  if (!prompt.includes("@") || !prompt.includes("#L")) {
    return { text: prompt, slices: [], warnings: [] };
  }
  const tokens = extractSliceTokens(prompt);
  if (tokens.length === 0) {
    return { text: prompt, slices: [], warnings: [] };
  }
  const maxSlices = options.maxSlices ?? MAX_PROMPT_FILE_SLICES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_PROMPT_SLICE_TOTAL_BYTES;
  const workspaceRoots = [
    options.workspaceRoot,
    ...(options.additionalRoots ?? []),
  ].map((root) => normalizeAbsolute(root));
  const realWorkspaceRoots = workspaceRoots.map((root) =>
    resolveRealPath(root),
  );
  const realHome =
    options.codepunkHome === undefined
      ? null
      : resolveRealPath(options.codepunkHome);
  const realProjectRoots = [
    ...new Set([
      ...realWorkspaceRoots,
      ...(options.deliveryRoot === undefined
        ? []
        : [resolveRealPath(options.deliveryRoot)]),
    ]),
  ];
  const fullFilesystem = options.filesystem === "full";

  const slices: PromptFileSlice[] = [];
  const warnings: string[] = [];
  let usedBytes = 0;

  for (const token of tokens.slice(0, maxSlices)) {
    const target = normalizeAbsolute(
      path.isAbsolute(token.candidatePath)
        ? token.candidatePath
        : path.resolve(options.cwd, token.candidatePath),
    );
    if (
      !fullFilesystem &&
      !workspaceRoots.some((root) => isInsidePath(root, target))
    ) {
      warnings.push(`skipped ${token.raw}: path is outside the workspace`);
      continue;
    }
    let stat;
    try {
      stat = await fs.lstat(target);
    } catch {
      warnings.push(`skipped ${token.raw}: file does not exist`);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      warnings.push(`skipped ${token.raw}: target must be a regular file`);
      continue;
    }
    const realTarget = resolveRealPath(target);
    if (
      !fullFilesystem &&
      !realWorkspaceRoots.some((root) => isInsidePath(root, realTarget))
    ) {
      warnings.push(
        `skipped ${token.raw}: path resolves outside the workspace`,
      );
      continue;
    }
    if (realHome !== null && isInsidePath(realHome, realTarget)) {
      warnings.push(`skipped ${token.raw}: path resolves into codepunk home`);
      continue;
    }
    if (isSensitivePath(realTarget, realHome ?? undefined, realProjectRoots)) {
      warnings.push(`skipped ${token.raw}: sensitive path cannot be inlined`);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(realTarget);
    } catch {
      warnings.push(`skipped ${token.raw}: file could not be read`);
      continue;
    }
    if (bytes.includes(0)) {
      warnings.push(`skipped ${token.raw}: binary file cannot be sliced`);
      continue;
    }
    const allLines = bytes.toString("utf8").split(/\r?\n/u);
    if (token.startLine > allLines.length) {
      warnings.push(
        `skipped ${token.raw}: start line ${token.startLine} exceeds file length (${allLines.length})`,
      );
      continue;
    }
    const clampedEnd = Math.min(token.endLine, allLines.length);
    const formattedLines: string[] = [];
    for (let lineNo = token.startLine; lineNo <= clampedEnd; lineNo += 1) {
      formattedLines.push(`${lineNo}: ${allLines[lineNo - 1] ?? ""}`);
    }
    const content = formattedLines.join("\n");
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (usedBytes + contentBytes > maxTotalBytes) {
      warnings.push(
        `skipped ${token.raw}: context slice byte budget (${maxTotalBytes} bytes) reached`,
      );
      continue;
    }
    usedBytes += contentBytes;
    const displayPath = relativeDisplayPath(
      resolveRealPath(options.workspaceRoot),
      realTarget,
    );
    slices.push({
      path: displayPath,
      startLine: token.startLine,
      endLine: clampedEnd,
      content,
    });
  }

  if (tokens.length > maxSlices) {
    warnings.push(
      `skipped ${tokens.length - maxSlices} extra @file#L slice(s) beyond cap ${maxSlices}`,
    );
  }
  if (slices.length === 0) {
    return { text: prompt, slices: [], warnings };
  }
  const block = [
    "<context_slices>",
    ...slices.map(
      (slice) =>
        `<file_slice path=${JSON.stringify(slice.path)} lines="${slice.startLine}-${slice.endLine}">\n${slice.content}\n</file_slice>`,
    ),
    "</context_slices>",
  ].join("\n");
  return {
    text: `${prompt}\n\n${block}`,
    slices,
    warnings,
  };
}
