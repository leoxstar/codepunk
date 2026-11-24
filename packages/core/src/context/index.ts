import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { estimateTokens as estimateMessageTokens } from "@earendil-works/pi-coding-agent";
import type { ContextSource } from "codepunk-protocol";
import { sha256Bytes, sha256Text } from "../platform/hash.ts";
import {
  isInsidePath,
  isSensitivePath,
  normalizeAbsolute,
} from "../platform/path.ts";
import {
  discoverProjectInstructionFiles,
  discoverUserInstructionFile,
} from "../platform/context-files.ts";

export const DEFAULT_CONTEXT_FILE_BYTES = 64 * 1024;
export const DEFAULT_CONTEXT_TOTAL_BYTES = 128 * 1024;

export interface ContextAppendFile {
  path: string;
  label?: string;
}

export interface ContextWarning {
  code: string;
  source: string;
  message: string;
}

export interface ContextLoadOptions {
  cwd: string;
  deliveryRoot: string;
  codepunkHome: string;
  /**
   * Skip every discovered or configured instruction source. Product-owned
   * system text may still be supplied by the host; this only removes the
   * workspace/user context that would otherwise steer the model.
   */
  disabled?: boolean;
  appendFiles?: readonly ContextAppendFile[];
  appendText?: string;
  replaceSystemPrompt?: boolean;
  systemPromptFile?: string | null;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  gitRoot?: string | null;
  /**
   * Project instruction files are agent input, not passive documentation.
   * When the workspace is untrusted they are skipped; user-level
   * instructions still load. Direct callers default to trusted so context
   * assembly stays usable outside a runtime.
   */
  projectTrusted?: boolean;
}

export interface ContextBundle {
  sources: ContextSource[];
  warnings: ContextWarning[];
  instructionBlock: string;
  totalBytes: number;
  truncated: boolean;
}

export interface TurnBoundaryTruncationOptions {
  maxTokens: number;
}

export interface TurnBoundaryTruncationResult<T> {
  messages: T[];
  truncated: boolean;
  droppedToolResults: number;
  tokensBefore: number;
  tokensAfter: number;
}

interface LoadedSource {
  source: ContextSource;
  content: string;
  includedBytes: number;
}

interface SecureReadResult {
  content: string;
  bytes: number;
  includedBytes: number;
  sha256: string;
  truncated: boolean;
}

function utf8Prefix(buffer: Buffer, limit: number): string {
  let end = Math.min(buffer.length, Math.max(0, limit));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      return decoder.decode(buffer.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function truncationNote(included: number, total: number): string {
  return `\n\n[context truncated: showing ${included} of ${total} bytes]`;
}

const TURN_BOUNDARY_MARKER = "[context truncated:";

type AgentMessage = Parameters<typeof estimateMessageTokens>[0];

const MAX_CONSERVATIVE_CHARS = 64 * 1024;

function safeJsonStringify(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : null;
  } catch {
    return null;
  }
}

function hasValidContentBlocks(content: unknown): boolean {
  if (typeof content === "string") {
    return true;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.every((block) => {
    if (typeof block !== "object" || block === null) {
      return false;
    }
    const candidate = block as Record<string, unknown>;
    if (candidate["type"] === "text") {
      return typeof candidate["text"] === "string";
    }
    return candidate["type"] === "image";
  });
}

function hasValidAssistantContent(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return content.every((block) => {
    if (typeof block !== "object" || block === null) {
      return false;
    }
    const candidate = block as Record<string, unknown>;
    if (candidate["type"] === "text") {
      return typeof candidate["text"] === "string";
    }
    if (candidate["type"] === "thinking") {
      return typeof candidate["thinking"] === "string";
    }
    return (
      candidate["type"] === "toolCall" &&
      typeof candidate["name"] === "string" &&
      typeof candidate["arguments"] === "object" &&
      candidate["arguments"] !== null &&
      safeJsonStringify(candidate["arguments"]) !== null
    );
  });
}

function hasValidSections(sections: unknown): boolean {
  if (sections === undefined) {
    return true;
  }
  if (typeof sections !== "object" || sections === null) {
    return false;
  }
  return Object.values(sections).every(
    (section) => section === null || typeof section === "string",
  );
}

function hasEstimableShape(message: Record<string, unknown>): boolean {
  switch (message["role"]) {
    case "system":
      return (
        hasValidContentBlocks(message["content"]) &&
        hasValidSections(message["sections"]) &&
        (message["toolsAdded"] === undefined ||
          safeJsonStringify(message["toolsAdded"]) !== null)
      );
    case "user":
    case "toolResult":
    case "custom":
      return hasValidContentBlocks(message["content"]);
    case "assistant":
      return hasValidAssistantContent(message["content"]);
    case "bashExecution":
      return (
        typeof message["command"] === "string" &&
        typeof message["output"] === "string"
      );
    case "branchSummary":
    case "compactionSummary":
      return typeof message["summary"] === "string";
    default:
      return false;
  }
}

function readAgentMessage(message: unknown): AgentMessage | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const candidate = message as Record<string, unknown>;
  return hasEstimableShape(candidate) ? (message as AgentMessage) : null;
}

function conservativeChars(value: unknown, visited: WeakSet<object>): number {
  if (typeof value === "string") {
    return Math.min(value.length, MAX_CONSERVATIVE_CHARS);
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value).length;
  }
  if (typeof value !== "object") {
    return String(value).length;
  }
  if (visited.has(value)) {
    return 0;
  }
  visited.add(value);
  let chars = 2;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (chars >= MAX_CONSERVATIVE_CHARS) {
        break;
      }
      chars += 1 + conservativeChars(item, visited);
    }
    return Math.min(chars, MAX_CONSERVATIVE_CHARS);
  }
  for (const [key, item] of Object.entries(value)) {
    if (chars >= MAX_CONSERVATIVE_CHARS) {
      break;
    }
    chars += key.length + 1 + conservativeChars(item, visited);
  }
  return Math.min(chars, MAX_CONSERVATIVE_CHARS);
}

function conservativeMessageTokens(message: unknown): number {
  const chars = conservativeChars(message, new WeakSet());
  return Math.max(1, Math.ceil(Math.min(chars, MAX_CONSERVATIVE_CHARS) / 4));
}

function messageTokens(message: unknown): number {
  const agentMessage = readAgentMessage(message);
  if (agentMessage === null) {
    return conservativeMessageTokens(message);
  }
  try {
    const estimated = estimateMessageTokens(agentMessage);
    return Number.isFinite(estimated)
      ? estimated
      : conservativeMessageTokens(message);
  } catch {
    return conservativeMessageTokens(message);
  }
}

function toolResultContent(message: Record<string, unknown>): string {
  return safeJsonStringify(message["content"] ?? []) ?? "";
}

function isAlreadyTruncated(message: Record<string, unknown>): boolean {
  const content = message["content"];
  const first =
    Array.isArray(content) && content.length === 1 && content[0] !== null
      ? (content[0] as Record<string, unknown>)
      : null;
  return (
    first !== null &&
    first["type"] === "text" &&
    typeof first["text"] === "string" &&
    first["text"].startsWith(TURN_BOUNDARY_MARKER)
  );
}

function turnBoundaryToolResult(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const original = toolResultContent(message);
  const marker = [
    TURN_BOUNDARY_MARKER,
    " oldest tool output removed;",
    ` tool=${safeJsonStringify(message["toolName"] ?? "") ?? '""'}`,
    ` call=${safeJsonStringify(message["toolCallId"] ?? "") ?? '""'}`,
    ` bytes=${Buffer.byteLength(original, "utf8")}`,
    ` tokens=${messageTokens(message)}`,
    ` sha256=${sha256Text(original)}`,
    " reason=turn-boundary]",
  ].join("");
  const replacement: Record<string, unknown> = {
    ...message,
    content: [{ type: "text", text: marker }],
  };
  delete replacement["details"];
  return replacement;
}

export function truncateContextAtTurnBoundary<T extends { role: string }>(
  messages: readonly T[],
  options: TurnBoundaryTruncationOptions,
): TurnBoundaryTruncationResult<T> {
  const next = [...messages];
  const tokensBefore = messages.reduce(
    (total, message) => total + messageTokens(message),
    0,
  );
  const latestUser = messages.findLastIndex(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      message.role === "user",
  );
  const candidates: number[] = [];
  if (latestUser >= 0) {
    for (let index = 0; index < latestUser; index += 1) {
      const message = messages[index] as Record<string, unknown>;
      if (
        typeof message === "object" &&
        message !== null &&
        message["role"] === "toolResult" &&
        !isAlreadyTruncated(message)
      ) {
        candidates.push(index);
      }
    }
  }
  const maxTokens = Math.max(0, Math.floor(options.maxTokens));
  let tokens = tokensBefore;
  let droppedToolResults = 0;
  for (const index of candidates) {
    if (tokens <= maxTokens) {
      break;
    }
    const replacement = turnBoundaryToolResult(
      messages[index] as Record<string, unknown>,
    ) as T;
    next[index] = replacement;
    tokens += messageTokens(replacement) - messageTokens(messages[index]);
    droppedToolResults += 1;
  }
  return {
    messages: next,
    truncated: droppedToolResults > 0,
    droppedToolResults,
    tokensBefore,
    tokensAfter: tokens,
  };
}

async function readRegularFile(
  candidate: string,
  allowedRoot: string,
  maxBytes: number,
): Promise<
  | { ok: true; value: SecureReadResult }
  | { ok: false; code: string; message: string }
> {
  const normalized = normalizeAbsolute(candidate);
  if (!isInsidePath(allowedRoot, normalized)) {
    return {
      ok: false,
      code: "context.outside_root",
      message: "context file is outside its allowed root",
    };
  }
  let linkStat;
  try {
    linkStat = await fs.lstat(normalized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: false,
        code: "context.missing",
        message: "context file does not exist",
      };
    }
    return {
      ok: false,
      code: "context.unreadable",
      message: "context file cannot be inspected",
    };
  }
  if (linkStat.isSymbolicLink()) {
    return {
      ok: false,
      code: "context.symlink",
      message: "context file has a symlink component",
    };
  }
  if (!linkStat.isFile()) {
    return {
      ok: false,
      code: "context.not_regular_file",
      message: "context file is not a regular file",
    };
  }
  let realPath: string;
  try {
    realPath = normalizeAbsolute(await fs.realpath(normalized));
  } catch {
    return {
      ok: false,
      code: "context.unreadable",
      message: "context file realpath cannot be resolved",
    };
  }
  if (!sameFileSystemPath(realPath, normalized)) {
    return {
      ok: false,
      code: "context.symlink",
      message: "context file has a symlink component",
    };
  }

  let handle;
  try {
    handle = await fs.open(realPath, "r");
  } catch {
    return {
      ok: false,
      code: "context.unreadable",
      message: "context file cannot be read",
    };
  }
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const kept: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let totalBytes = 0;
  let includedBytes = 0;
  let containsNul = false;
  let malformedUtf8 = false;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      totalBytes += bytesRead;
      hash.update(chunk);
      if (!containsNul) {
        containsNul = chunk.indexOf(0) !== -1;
      }
      try {
        decoder.decode(chunk, { stream: true });
      } catch {
        malformedUtf8 = true;
        break;
      }
      if (includedBytes < maxBytes) {
        const take = Math.min(bytesRead, maxBytes - includedBytes);
        kept.push(Buffer.from(chunk.subarray(0, take)));
        includedBytes += take;
      }
    }
    if (!malformedUtf8) {
      try {
        decoder.decode();
      } catch {
        malformedUtf8 = true;
      }
    }
  } catch {
    return {
      ok: false,
      code: "context.unreadable",
      message: "context file cannot be read",
    };
  } finally {
    await handle.close();
  }
  if (containsNul) {
    return {
      ok: false,
      code: "context.malformed",
      message: "context file contains NUL bytes",
    };
  }
  if (malformedUtf8) {
    return {
      ok: false,
      code: "context.malformed",
      message: "context file is not valid UTF-8",
    };
  }
  const bytes = Buffer.concat(kept, includedBytes);
  let content: string;
  try {
    content = utf8Prefix(bytes, bytes.length);
  } catch {
    return {
      ok: false,
      code: "context.malformed",
      message: "context file is not valid UTF-8",
    };
  }
  const truncated = totalBytes > maxBytes;
  if (truncated) {
    content = `${utf8Prefix(bytes, maxBytes)}${truncationNote(
      includedBytes,
      totalBytes,
    )}`;
  }
  return {
    ok: true,
    value: {
      content,
      bytes: totalBytes,
      includedBytes,
      sha256: `sha256:${hash.digest("hex")}`,
      truncated,
    },
  };
}

function escapeContextText(value: string): string {
  return value
    .replaceAll("<codepunk-context", "&lt;codepunk-context")
    .replaceAll("</codepunk-context", "&lt;/codepunk-context");
}

function sameFileSystemPath(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  // macOS and Windows are case-insensitive by default, and realpath may
  // return the on-disk case even when the candidate used a different case.
  // Comparing strings exactly would report a regular file as a symlink.
  return (
    (process.platform === "darwin" || process.platform === "win32") &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function renderInstructionBlock(sources: readonly LoadedSource[]): string {
  return sources
    .map(({ source, content }) => {
      const header = [
        `<codepunk-context rank="${source.rank}"`,
        ` source="${escapeContextText(source.source)}"`,
        ` sha256="${source.sha256}"`,
        ` truncated="${String(source.truncated)}">`,
      ].join("");
      return `${header}\n${escapeContextText(content)}\n</codepunk-context>`;
    })
    .join("\n\n");
}

async function loadSource(input: {
  candidate: string;
  allowedRoot: string;
  rank: number;
  kind: ContextSource["kind"];
  source: string;
  maxBytes: number;
  warnings: ContextWarning[];
  optional?: boolean;
}): Promise<LoadedSource | null> {
  const result = await readRegularFile(
    input.candidate,
    input.allowedRoot,
    input.maxBytes,
  );
  if (!result.ok) {
    if (input.optional && result.code === "context.missing") {
      return null;
    }
    input.warnings.push({
      code: result.code,
      source: input.source,
      message: result.message,
    });
    return null;
  }
  return {
    source: {
      rank: input.rank,
      kind: input.kind,
      source: input.source,
      sha256: result.value.sha256,
      bytes: result.value.bytes,
      truncated: result.value.truncated,
    },
    content: result.value.content,
    includedBytes: result.value.includedBytes,
  };
}

function sourceFromText(input: {
  text: string;
  rank: number;
  source: string;
  maxBytes: number;
}): LoadedSource | null {
  if (input.text.length === 0) {
    return null;
  }
  const bytes = Buffer.from(input.text, "utf8");
  const includedBytes = Math.min(bytes.length, input.maxBytes);
  const truncated = bytes.length > includedBytes;
  return {
    source: {
      rank: input.rank,
      kind: "append",
      source: input.source,
      sha256: sha256Bytes(bytes),
      bytes: bytes.length,
      truncated,
    },
    content: truncated
      ? `${utf8Prefix(bytes, includedBytes)}${truncationNote(
          includedBytes,
          bytes.length,
        )}`
      : input.text,
    includedBytes,
  };
}

export async function loadContext(
  options: ContextLoadOptions,
): Promise<ContextBundle> {
  if (options.disabled === true) {
    return {
      sources: [],
      warnings: [],
      instructionBlock: "",
      totalBytes: 0,
      truncated: false,
    };
  }
  const cwd = normalizeAbsolute(options.cwd);
  const deliveryRoot = normalizeAbsolute(options.deliveryRoot);
  const codepunkHome = normalizeAbsolute(options.codepunkHome);
  const maxFileBytes = Math.max(
    1,
    options.maxFileBytes ?? DEFAULT_CONTEXT_FILE_BYTES,
  );
  const maxTotalBytes = Math.max(
    1,
    options.maxTotalBytes ?? DEFAULT_CONTEXT_TOTAL_BYTES,
  );
  const warnings: ContextWarning[] = [];
  const loaded: LoadedSource[] = [];
  let remaining = maxTotalBytes;

  const candidates: Array<{
    candidate: string;
    allowedRoot: string;
    rank: number;
    kind: ContextSource["kind"];
    source: string;
    optional: boolean;
  }> = [];

  const projectTrusted = options.projectTrusted ?? true;
  const userInstruction = await discoverUserInstructionFile(codepunkHome);
  if (userInstruction !== null) {
    candidates.push({
      candidate: userInstruction,
      allowedRoot: codepunkHome,
      rank: 4,
      kind: "user-instructions",
      source: `user/${path.basename(userInstruction)}`,
      optional: true,
    });
  }
  let projectRank = 5;
  const projectInstructions = await discoverProjectInstructionFiles({
    root: deliveryRoot,
    cwd,
  });
  for (const candidate of projectInstructions) {
    if (!projectTrusted) {
      warnings.push({
        code: "context.untrusted_project_instruction",
        source: `project/${path
          .relative(deliveryRoot, candidate)
          .split(path.sep)
          .join("/")}`,
        message:
          "project instruction file is not loaded until the workspace is trusted",
      });
      continue;
    }
    candidates.push({
      candidate,
      allowedRoot: deliveryRoot,
      rank: projectRank,
      kind: "project-instructions",
      source: `project/${path
        .relative(deliveryRoot, candidate)
        .split(path.sep)
        .join("/")}`,
      optional: true,
    });
    projectRank += 1;
  }

  for (const [index, append] of (options.appendFiles ?? []).entries()) {
    const candidate = normalizeAbsolute(
      path.isAbsolute(append.path)
        ? append.path
        : path.resolve(cwd, append.path),
    );
    const allowedRoot = isInsidePath(codepunkHome, candidate)
      ? codepunkHome
      : deliveryRoot;
    const label = `append/${index + 1}/${append.label ?? path.basename(candidate)}`;
    if (
      allowedRoot === deliveryRoot &&
      isSensitivePath(candidate, undefined, deliveryRoot)
    ) {
      warnings.push({
        code: "context.sensitive_path",
        source: label,
        message: "append file is in a sensitive path class",
      });
      continue;
    }
    candidates.push({
      candidate,
      allowedRoot,
      rank: 6 + index,
      kind: "append",
      source: label,
      optional: false,
    });
  }

  for (const candidate of candidates) {
    if (remaining <= 0) {
      warnings.push({
        code: "context.total_cap",
        source: candidate.source,
        message: "context total byte cap was reached before this source",
      });
      continue;
    }
    const limit = Math.min(maxFileBytes, remaining);
    const source = await loadSource({
      candidate: candidate.candidate,
      allowedRoot: candidate.allowedRoot,
      rank: candidate.rank,
      kind: candidate.kind,
      source: candidate.source,
      maxBytes: limit,
      warnings,
      optional: candidate.optional,
    });
    if (source === null) {
      continue;
    }
    loaded.push(source);
    remaining -= source.includedBytes;
  }

  loaded.sort((left, right) => left.source.rank - right.source.rank);
  let injected = loaded;
  if (options.replaceSystemPrompt === true) {
    injected = [];
    if (
      options.systemPromptFile === null ||
      options.systemPromptFile === undefined ||
      options.systemPromptFile.length === 0
    ) {
      warnings.push({
        code: "context.system_prompt_missing",
        source: "system-prompt",
        message:
          "replace_system_prompt requires a system_prompt_file; the product instruction block is empty",
      });
    } else {
      const candidate = normalizeAbsolute(
        path.isAbsolute(options.systemPromptFile)
          ? options.systemPromptFile
          : path.resolve(cwd, options.systemPromptFile),
      );
      const replacement = await loadSource({
        candidate,
        allowedRoot: codepunkHome,
        rank: 6,
        kind: "append",
        source: "system-prompt",
        maxBytes: Math.min(maxFileBytes, maxTotalBytes),
        warnings,
      });
      if (replacement !== null) {
        injected = [replacement];
      }
    }
  } else if (
    options.appendText !== undefined &&
    options.appendText.length > 0 &&
    remaining > 0
  ) {
    const appended = sourceFromText({
      text: options.appendText,
      rank: 6 + (options.appendFiles?.length ?? 0),
      source: "config/append",
      maxBytes: Math.min(maxFileBytes, remaining, maxTotalBytes),
    });
    if (appended !== null) {
      injected = [...loaded, appended];
      remaining -= appended.includedBytes;
    }
  }
  return {
    sources: injected.map((source) => source.source),
    warnings,
    instructionBlock: renderInstructionBlock(injected),
    totalBytes: injected.reduce(
      (total, source) => total + source.includedBytes,
      0,
    ),
    truncated: injected.some((source) => source.source.truncated),
  };
}
