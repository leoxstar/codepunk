import path from "node:path";
import { atomicWriteFile } from "../platform/fs.ts";
import { createUlid } from "../platform/hash.ts";
import { normalizeAbsolute } from "../platform/path.ts";
import { outputSha } from "../evidence/index.ts";

export const OUTPUT_PREVIEW_CHARS = 4_096;
export const APPROX_CHARS_PER_TOKEN = 4;

export interface ToolOutputArtifact {
  ref: string;
  absolutePath: string;
  sha256: string;
  bytes: number;
  tokens: number;
}

/**
 * Estimate tokens for raw tool output. This is intentionally not Pi's
 * `estimateTokens`, which accounts for AgentMessage roles, images, and tool
 * calls. Keeping the names distinct prevents artifact accounting from being
 * mistaken for context-window accounting.
 */
export function estimateTextTokens(value: string): number {
  return Math.ceil(value.length / APPROX_CHARS_PER_TOKEN);
}

export function redactOutputPreview(value: string, home?: string): string {
  let redacted = value;
  if (home !== undefined && home.length > 1) {
    redacted = redacted.replaceAll(normalizeAbsolute(home), "~");
  }
  redacted = redacted
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gu, "$1[REDACTED_TOKEN]")
    .replace(
      /\b(api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|secret)\b\s*[:=]\s*["']?[^"'\s]{8,}/giu,
      "$1=[REDACTED_SECRET]",
    )
    .replace(
      /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gu,
      "[REDACTED_TOKEN]",
    );
  return redacted;
}

export function boundedToolOutput(
  value: string,
  options: {
    maxTokens: number;
    artifact?: ToolOutputArtifact | null;
    home?: string;
  },
): string {
  const maxChars = Math.max(1, options.maxTokens * APPROX_CHARS_PER_TOKEN);
  const artifact = options.artifact ?? null;
  const text = redactOutputPreview(value, options.home);
  if (artifact === null && text.length <= maxChars) {
    return text;
  }
  const summary = text.slice(0, Math.min(maxChars, OUTPUT_PREVIEW_CHARS));
  const marker =
    artifact === null ? "tool output truncated" : "tool output artifact";
  const reference =
    artifact === null
      ? `showing ${summary.length} of ${text.length} characters`
      : `path=${artifact.absolutePath} sha256=${artifact.sha256} bytes=${artifact.bytes}`;
  return `${summary}\n\n[${marker}: ${reference}]`;
}

export async function writeToolOutputArtifact(options: {
  artifactsDir: string;
  sessionId: string;
  output: string;
  now?: () => Date;
}): Promise<ToolOutputArtifact> {
  const artifactsDir = normalizeAbsolute(options.artifactsDir);
  if (!/^[A-Za-z0-9._-]+$/u.test(options.sessionId)) {
    throw new Error("artifact session id is not path-safe");
  }
  const id = createUlid((options.now ?? (() => new Date()))());
  const directory = path.join(artifactsDir, options.sessionId);
  const target = path.join(directory, `${id}.txt`);
  await atomicWriteFile(target, options.output);
  return {
    ref: ["artifacts", options.sessionId, `${id}.txt`].join("/"),
    absolutePath: target,
    sha256: outputSha(options.output),
    bytes: Buffer.byteLength(options.output),
    tokens: estimateTextTokens(options.output),
  };
}
