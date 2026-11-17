import { constants as fsConstants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  truncateHead,
  truncateLine,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  isInsidePath,
  isSensitivePath,
  normalizeAbsolute,
  resolveRealPath,
} from "../platform/path.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_LINES = 2_000;
const DEFAULT_LIMIT = 80;
const GREP_MATCH_SEPARATOR = "\u001f";
const GREP_CONTEXT_SEPARATOR = "\u001e";

export interface SearchBinary {
  name: "rg" | "fd";
  path: string;
  sha256: string;
}

export interface SearchToolOptions {
  cwd: string;
  workspaceRoot?: string;
  /** Explicit extra file roots; they do not contribute project config. */
  additionalRoots?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  limit?: number;
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const direct = environment[name];
  if (direct !== undefined || process.platform !== "win32") {
    return direct;
  }
  const folded = name.toUpperCase();
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() === folded) {
      return value;
    }
  }
  return undefined;
}

async function executable(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, fsConstants.X_OK);
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function hashFile(candidate: string): Promise<string | null> {
  try {
    const bytes = await fs.readFile(candidate);
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  } catch {
    return null;
  }
}

export async function resolveSearchBinary(
  name: "rg" | "fd",
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SearchBinary | null> {
  const pathValue = environmentValue(environment, "PATH") ?? "";
  const extensions =
    process.platform === "win32"
      ? (environmentValue(environment, "PATHEXT") ?? ".EXE;.CMD;.BAT")
          .split(";")
          .filter(Boolean)
      : [""];
  for (const directory of pathValue.split(path.delimiter)) {
    // A relative PATH entry would resolve against the agent cwd, letting a
    // repository provide the binary that searches it. Only absolute
    // directories are trusted.
    if (directory.length === 0 || !path.isAbsolute(directory)) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (await executable(candidate)) {
        const resolved = normalizeAbsolute(candidate);
        const sha256 = await hashFile(resolved);
        if (sha256 === null) {
          continue;
        }
        return { name, path: resolved, sha256 };
      }
    }
  }
  return null;
}

function run(
  executablePath: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  captureTruncated: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let output = "";
    let timedOut = false;
    let captureTruncated = false;
    const append = (chunk: Buffer) => {
      if (captureTruncated) {
        return;
      }
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) {
        // Stop storing output but let the process finish. Killing it here
        // would turn a large but successful search into a non-zero exit and
        // an error result; the timeout still bounds a runaway command.
        captureTruncated = true;
      }
    };
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 20_000);
    timer.unref();
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        output,
        exitCode: timedOut ? 124 : code,
        timedOut,
        captureTruncated,
      });
    });
  });
}

interface GrepLine {
  file: string;
  lineNumber: string;
  text: string;
  context: boolean;
}

function parseGrepLine(line: string): GrepLine | null {
  const matchIndex = line.indexOf(GREP_MATCH_SEPARATOR);
  const contextIndex = line.indexOf(GREP_CONTEXT_SEPARATOR);
  const separator =
    matchIndex >= 0
      ? GREP_MATCH_SEPARATOR
      : contextIndex >= 0
        ? GREP_CONTEXT_SEPARATOR
        : null;
  if (separator !== null) {
    const first = line.indexOf(separator);
    const second = line.indexOf(separator, first + 1);
    if (first < 0 || second < 0) {
      return null;
    }
    return {
      file: line.slice(0, first),
      lineNumber: line.slice(first + 1, second),
      text: line.slice(second + 1),
      context: separator === GREP_CONTEXT_SEPARATOR,
    };
  }
  // Compatibility with older tests and wrappers that emit plain rg lines.
  const colon = line.indexOf(":");
  if (colon < 0) {
    return null;
  }
  const rest = line.slice(colon + 1);
  const second = rest.indexOf(":");
  if (second < 0) {
    return null;
  }
  return {
    file: line.slice(0, colon),
    lineNumber: rest.slice(0, second),
    text: rest.slice(second + 1),
    context: false,
  };
}

export function createSearchTool(
  options: SearchToolOptions,
): ToolDefinition<any, any, any> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const workspaceRoots = [
    normalizeAbsolute(options.workspaceRoot ?? options.cwd),
    ...(options.additionalRoots ?? []).map((root) => normalizeAbsolute(root)),
  ];
  const realWorkspaceRoots = workspaceRoots.map((root) =>
    resolveRealPath(root),
  );
  // Resolve each search helper once per tool instance. Re-reading PATH on
  // every call would let a mid-session PATH edit swap the executable after
  // approval.
  const binaries = new Map<"rg" | "fd", Promise<SearchBinary | null>>();
  const binaryFor = (name: "rg" | "fd"): Promise<SearchBinary | null> => {
    const cached = binaries.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const pending = resolveSearchBinary(name, options.environment);
    binaries.set(name, pending);
    return pending;
  };
  return {
    name: "search",
    label: "search",
    description:
      "Search files with locally installed rg/fd. Never downloads tools. Modes: grep, find, ls.",
    promptSnippet:
      "Search workspace files with rg/fd; no network or automatic downloads",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["grep", "find", "ls"],
          default: "grep",
        },
        query: { type: "string" },
        path: { type: "string", default: "." },
        regex: {
          type: "boolean",
          default: false,
          description:
            "Treat query as a regular expression instead of a literal",
        },
        literal: {
          type: "boolean",
          default: true,
          description: "Treat query as a literal string (the default)",
        },
        ignoreCase: {
          type: "boolean",
          default: false,
          description: "Case-insensitive search",
        },
        glob: {
          type: "string",
          description:
            "Filter searched files by glob, for example *.ts or src/**",
        },
        context: {
          type: "integer",
          minimum: 0,
          maximum: 20,
          default: 0,
          description: "Lines of context before and after each match",
        },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    } as never,
    async execute(
      _toolCallId: string,
      rawParams: unknown,
      signal?: AbortSignal,
    ) {
      const params =
        rawParams !== null &&
        typeof rawParams === "object" &&
        !Array.isArray(rawParams)
          ? (rawParams as Record<string, unknown>)
          : {};
      const mode =
        params["mode"] === "find" || params["mode"] === "ls"
          ? params["mode"]
          : "grep";
      const query = typeof params["query"] === "string" ? params["query"] : "";
      const relative =
        typeof params["path"] === "string" ? params["path"] : ".";
      const target = normalizeAbsolute(
        path.isAbsolute(relative)
          ? relative
          : path.resolve(options.cwd, relative),
      );
      const realTarget = resolveRealPath(target);
      if (
        !workspaceRoots.some((root) => isInsidePath(root, target)) ||
        !realWorkspaceRoots.some((root) => isInsidePath(root, realTarget))
      ) {
        return {
          content: [
            {
              type: "text",
              text: "search path is outside the workspace or escapes it through a symlink",
            },
          ],
          details: {},
          structuredContent: {
            output: "",
            exit_code: null,
            empty_result: true,
          },
          isError: true,
        };
      }
      if (mode !== "ls" && query.trim().length === 0) {
        return {
          content: [{ type: "text", text: "search query is required" }],
          details: {},
          structuredContent: {
            output: "",
            exit_code: null,
            empty_result: true,
          },
          isError: true,
        };
      }
      const requestedLimit =
        typeof params["limit"] === "number" ? params["limit"] : limit;
      const effectiveLimit = Math.max(
        1,
        Math.min(500, Math.trunc(requestedLimit)),
      );
      if (mode === "ls") {
        try {
          const entries = await fs.readdir(realTarget, { withFileTypes: true });
          const output = entries
            .filter((entry) => {
              if (query.length === 0) {
                return true;
              }
              return entry.name.toLowerCase().includes(query.toLowerCase());
            })
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(0, effectiveLimit)
            .map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`)
            .join("\n");
          return {
            content: [
              {
                type: "text",
                text: output.length === 0 ? "(no entries)" : output,
              },
            ],
            details: { binary: null, executor: "node:fs" },
            structuredContent: {
              output,
              exit_code: 0,
              empty_result: output.length === 0,
              truncated: entries.length > effectiveLimit,
            },
          };
        } catch (error) {
          const message = `ls failed: ${error instanceof Error ? error.message : String(error)}`;
          return {
            content: [{ type: "text", text: message }],
            details: {},
            structuredContent: {
              output: message,
              exit_code: null,
              empty_result: true,
            },
            isError: true,
          };
        }
      }
      const binaryName = mode === "grep" ? "rg" : "fd";
      const binary = await binaryFor(binaryName);
      if (binary === null) {
        const message = `${binaryName} is not installed; run codepunk doctor for search setup`;
        return {
          content: [{ type: "text", text: message }],
          details: { missing_binary: binaryName },
          structuredContent: {
            output: message,
            exit_code: null,
            empty_result: true,
          },
          isError: true,
        };
      }
      const useRegex = params["regex"] === true && params["literal"] !== true;
      const glob =
        typeof params["glob"] === "string"
          ? params["glob"].trim().replace(/^(!?)(?:\.\/)+/u, "$1")
          : "";
      const contextLines =
        typeof params["context"] === "number" && params["context"] > 0
          ? Math.min(20, Math.trunc(params["context"]))
          : 0;
      const args =
        mode === "grep"
          ? [
              "--no-config",
              "--line-number",
              "--no-heading",
              "--color",
              "never",
              "--max-count",
              String(effectiveLimit),
              "--field-match-separator",
              GREP_MATCH_SEPARATOR,
              "--field-context-separator",
              GREP_CONTEXT_SEPARATOR,
              ...(useRegex ? [] : ["--fixed-strings"]),
              ...(params["ignoreCase"] === true ? ["--ignore-case"] : []),
              ...(glob.length > 0 ? ["--glob", glob] : []),
              ...(contextLines > 0 ? ["--context", String(contextLines)] : []),
              "--",
              query,
              realTarget,
            ]
          : [
              "--color",
              "never",
              "--hidden",
              "--exclude",
              ".git",
              "--max-results",
              String(effectiveLimit),
              "--glob",
              ...(params["ignoreCase"] === true ? ["--ignore-case"] : []),
              "--",
              query,
              realTarget,
            ];
      try {
        const result = await run(binary.path, args, options.cwd, signal);
        const visible = (candidate: string): boolean =>
          !isSensitivePath(
            path.isAbsolute(candidate)
              ? candidate
              : path.resolve(options.cwd, candidate),
            undefined,
            workspaceRoots,
          );
        const kept: string[] = [];
        let matchCount = 0;
        let limitHit = false;
        let lineTruncated = false;
        for (const line of result.output.trimEnd().split("\n")) {
          if (line.length === 0) {
            continue;
          }
          if (mode === "find") {
            if (!visible(line)) {
              continue;
            }
            if (kept.length >= effectiveLimit) {
              limitHit = true;
              break;
            }
            kept.push(line);
            continue;
          }
          const parsed = parseGrepLine(line);
          if (parsed === null || !visible(parsed.file)) {
            continue;
          }
          if (!parsed.context) {
            if (matchCount >= effectiveLimit) {
              limitHit = true;
              break;
            }
            matchCount += 1;
          }
          const truncated = truncateLine(parsed.text);
          lineTruncated ||= truncated.wasTruncated;
          const separator = parsed.context ? "-" : ":";
          kept.push(
            `${parsed.file}${separator}${parsed.lineNumber}${separator}${truncated.text}`,
          );
        }
        const output = kept.join("\n");
        const head = truncateHead(output, {
          maxBytes: MAX_OUTPUT_BYTES,
          maxLines: MAX_OUTPUT_LINES,
        });
        const bounded = head.content;
        const truncated =
          result.captureTruncated ||
          limitHit ||
          lineTruncated ||
          head.truncated;
        const failed =
          result.exitCode !== null &&
          result.exitCode !== 0 &&
          result.exitCode !== 1;
        const failureText = failed
          ? result.output.trim() ||
            `${binary.name} exited with code ${result.exitCode}`
          : "";
        return {
          content: [
            {
              type: "text",
              text:
                bounded.length === 0 && failureText.length > 0
                  ? failureText
                  : bounded.length === 0
                    ? "(no matches)"
                    : `${bounded.replaceAll(`${options.cwd}${path.sep}`, "")}${
                        truncated ? "\n[output truncated]" : ""
                      }`,
            },
          ],
          details: {
            binary: binary.name,
            binary_path: binary.path,
            binary_sha256: binary.sha256,
            executor: binary.name,
          },
          structuredContent: {
            output: bounded,
            exit_code: result.exitCode,
            empty_result: bounded.length === 0,
            truncated,
            timed_out: result.timedOut,
          },
          ...(failed ? { isError: true } : {}),
        };
      } catch (error) {
        const message = `${binary.name} failed: ${error instanceof Error ? error.message : String(error)}`;
        return {
          content: [{ type: "text", text: message }],
          details: {
            binary: binary.name,
            binary_path: binary.path,
            binary_sha256: binary.sha256,
          },
          structuredContent: {
            output: message,
            exit_code: null,
            empty_result: true,
          },
          isError: true,
        };
      }
    },
  };
}
