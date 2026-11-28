import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UNPUBLISHED_VERSION } from "codepunk-protocol";

declare const __CODEPUNK_VERSION__: string | undefined;
declare const __SRT_VERSION__: string | undefined;
declare const __BUILD_COMMIT__: string | undefined;

function readJsonVersion(filePath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : null;
  } catch {
    return null;
  }
}

function readPackageVersionFallback(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(currentDir, "..", "package.json"),
    path.resolve(currentDir, "..", "..", "package.json"),
  ]) {
    const version = readJsonVersion(candidate);
    if (version !== null) {
      return version;
    }
  }
  return UNPUBLISHED_VERSION;
}

function readSrtVersionFallback(): string {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(
      cursor,
      "node_modules",
      "@anthropic-ai",
      "sandbox-runtime",
      "package.json",
    );
    const version = readJsonVersion(candidate);
    if (version !== null) {
      return version;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return UNPUBLISHED_VERSION;
}

export const CODEPUNK_VERSION: string =
  typeof __CODEPUNK_VERSION__ === "string" && __CODEPUNK_VERSION__.length > 0
    ? __CODEPUNK_VERSION__
    : readPackageVersionFallback();

export const BUILD_SRT_VERSION: string =
  typeof __SRT_VERSION__ === "string" && __SRT_VERSION__.length > 0
    ? __SRT_VERSION__
    : readSrtVersionFallback();

export const BUILD_COMMIT: string =
  typeof __BUILD_COMMIT__ === "string" && __BUILD_COMMIT__.length > 0
    ? __BUILD_COMMIT__
    : "dev";
