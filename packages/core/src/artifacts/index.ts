import path from "node:path";
import { atomicWriteFile } from "../platform/fs.ts";
import { createUlid } from "../platform/hash.ts";
import { normalizeAbsolute } from "../platform/path.ts";
import { outputSha } from "../evidence/index.ts";

export const OUTPUT_PREVIEW_CHARS = 4_096;
export const APPROX_CHARS_PER_TOKEN = 4;
export const TEST_FOLD_MIN_LINES = 80;
const MAX_VISIBLE_PASSING_LINES = 8;

const TEST_RUNNER_COMMAND_PATTERN =
  /(?:^|[;&|()\s])(?:(?:pnpm|npm|yarn|bun)\s+(?:--\S+(?:\s+\S+)?\s+)*(?:run\s+)?test\b|node\s+[^\n;|&]*--test\b|(?:npx\s+|pnpm\s+exec\s+)?(?:vitest|jest|pytest)\b|cargo\s+test\b|go\s+test\b)/u;

const SINGLE_PASSING_LINE_PATTERN =
  /^\s*(?:[✔✓]\s+\S.*|PASS\s+\S.*|---\s+PASS:\s+\S.*|test\s+\S.*\.\.\.\s+ok\s*|\S+::\S+\s+PASSED(?:\s+\[\s*\d+%\])?\s*)$/u;

const TAP_PASSING_LINE_PATTERN = /^\s*ok\s+\d+\b(?!.*#\s*(?:TODO|SKIP)\b)/iu;

function isTestRunnerInvocation(
  command?: string | null,
  argv?: readonly string[] | null,
): boolean {
  if (
    typeof command === "string" &&
    TEST_RUNNER_COMMAND_PATTERN.test(command)
  ) {
    return true;
  }
  if (argv === undefined || argv === null || argv.length === 0) {
    return false;
  }
  const joined = argv.join(" ");
  return TEST_RUNNER_COMMAND_PATTERN.test(joined);
}

/**
 * Fold repetitive passing test lines from large test-runner outputs so that
 * bottom-of-log failures, stack traces, and totals survive preview truncation
 * without extra artifact-read round-trips. Evidence hashes always bind raw
 * unfolded output before calling this helper.
 */
export function foldTestRunnerOutput(
  value: string,
  options: {
    command?: string | null;
    argv?: readonly string[] | null;
    artifact?: ToolOutputArtifact | null;
  } = {},
): { text: string; foldedPassingLines: number } {
  if (!isTestRunnerInvocation(options.command, options.argv)) {
    return { text: value, foldedPassingLines: 0 };
  }
  const lines = value.split("\n");
  if (lines.length < TEST_FOLD_MIN_LINES) {
    return { text: value, foldedPassingLines: 0 };
  }
  const kept: string[] = [];
  let visiblePassing = 0;
  let foldedPassingLines = 0;
  let markerIndex = -1;
  let skipTapYaml = false;

  for (const line of lines) {
    if (skipTapYaml) {
      if (/^\s+\.\.\.\s*$/u.test(line)) {
        skipTapYaml = false;
        foldedPassingLines += 1;
        continue;
      }
      if (/^\s{2,}\S/u.test(line)) {
        foldedPassingLines += 1;
        continue;
      }
      skipTapYaml = false;
    }
    const isTapOk = TAP_PASSING_LINE_PATTERN.test(line);
    const isPassing = isTapOk || SINGLE_PASSING_LINE_PATTERN.test(line);
    if (isPassing) {
      if (visiblePassing < MAX_VISIBLE_PASSING_LINES) {
        visiblePassing += 1;
        kept.push(line);
      } else {
        if (markerIndex === -1) {
          markerIndex = kept.length;
          kept.push("");
        }
        foldedPassingLines += 1;
        if (isTapOk) {
          skipTapYaml = true;
        }
      }
      continue;
    }
    if (
      foldedPassingLines > 0 &&
      /^\s+---\s*$/u.test(line) &&
      kept[kept.length - 1] === ""
    ) {
      skipTapYaml = true;
      foldedPassingLines += 1;
      continue;
    }
    kept.push(line);
  }

  if (foldedPassingLines === 0 || markerIndex === -1) {
    return { text: value, foldedPassingLines: 0 };
  }
  const artifactRef =
    options.artifact === undefined || options.artifact === null
      ? ""
      : `; full raw log in ${options.artifact.absolutePath}`;
  kept[markerIndex] =
    `[... ${foldedPassingLines} passing test line(s) folded${artifactRef}]`;
  return { text: kept.join("\n"), foldedPassingLines };
}

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
