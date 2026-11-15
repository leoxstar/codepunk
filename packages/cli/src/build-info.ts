import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DoctorCheck, DoctorReport } from "@codepunk/core";

const BUILD_PACKAGES = ["protocol", "core", "cli"] as const;
const MTIME_TOLERANCE_MS = 1_000;

export interface CliBuildInfo {
  version: string;
  entryPath: string;
  builtAt: string | null;
  sourceNewest: string | null;
  /**
   * `null` means this is an installed package without its TypeScript sources,
   * so Codepunk cannot compare the build against source files.
   */
  stale: boolean | null;
}

interface SourceBuildComparison {
  stale: boolean;
  sourceNewest: number | null;
  distNewest: number | null;
}

function isTypeScriptSource(file: string): boolean {
  return (
    (file.endsWith(".ts") || file.endsWith(".tsx")) && !file.endsWith(".d.ts")
  );
}

async function listSourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(absolute)));
    } else if (entry.isFile() && isTypeScriptSource(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

function outputPathForSource(sourcePath: string): string {
  return sourcePath.endsWith(".tsx")
    ? `${sourcePath.slice(0, -4)}.jsx`
    : `${sourcePath.slice(0, -3)}.js`;
}

async function comparePackageBuild(
  repositoryRoot: string,
): Promise<SourceBuildComparison | null> {
  let hasSources = false;
  let stale = false;
  let sourceNewest: number | null = null;
  let distNewest: number | null = null;
  for (const packageName of BUILD_PACKAGES) {
    const packageRoot = path.join(repositoryRoot, "packages", packageName);
    const sourceRoot = path.join(packageRoot, "src");
    const distRoot = path.join(packageRoot, "dist");
    let files: string[];
    try {
      files = await listSourceFiles(sourceRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    hasSources = true;
    for (const sourceFile of files) {
      const sourceStat = await fs.stat(sourceFile);
      sourceNewest = Math.max(sourceNewest ?? 0, sourceStat.mtimeMs);
      const relative = path.relative(sourceRoot, sourceFile);
      const distFile = outputPathForSource(path.join(distRoot, relative));
      let distStat;
      try {
        distStat = await fs.stat(distFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          stale = true;
          continue;
        }
        throw error;
      }
      distNewest = Math.max(distNewest ?? 0, distStat.mtimeMs);
      if (sourceStat.mtimeMs > distStat.mtimeMs + MTIME_TOLERANCE_MS) {
        stale = true;
      }
    }
  }
  return hasSources ? { stale, sourceNewest, distNewest } : null;
}

function isoTime(mtimeMs: number | null): string | null {
  return mtimeMs === null ? null : new Date(mtimeMs).toISOString();
}

/**
 * Reads the CLI package identity and compares every emitted JavaScript file
 * with its TypeScript source. The check is deliberately source-aware: an
 * installed package has no `src`, while a repository checkout must not let a
 * stale `dist` silently serve an older trust or command UI.
 */
export async function inspectCliBuild(
  entryUrl: string = import.meta.url,
): Promise<CliBuildInfo> {
  const currentModule = fileURLToPath(entryUrl);
  const extension = path.extname(currentModule);
  const entryPath = path.join(path.dirname(currentModule), `index${extension}`);
  const cliRoot = path.dirname(path.dirname(entryPath));
  const repositoryRoot = path.dirname(path.dirname(cliRoot));
  let version = "0.0.0";
  try {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(cliRoot, "package.json"), "utf8"),
    ) as { version?: unknown };
    if (typeof packageJson.version === "string") {
      version = packageJson.version;
    }
  } catch {
    // The fallback is intentionally the unpublished checkout version.
  }
  let builtAt: string | null = null;
  try {
    builtAt = isoTime((await fs.stat(entryPath)).mtimeMs);
  } catch {
    // `--version` still has a useful package identity if the entry is gone.
  }
  const comparison = await comparePackageBuild(repositoryRoot);
  return {
    version,
    entryPath,
    builtAt: isoTime(comparison?.distNewest ?? null) ?? builtAt,
    sourceNewest: isoTime(comparison?.sourceNewest ?? null),
    stale: comparison === null ? null : comparison.stale,
  };
}

export function formatBuildIdentity(build: CliBuildInfo): string {
  const details = [
    `codepunk ${build.version}`,
    `entry: ${build.entryPath}`,
    `built: ${build.builtAt ?? "unknown"}`,
    `source: ${
      build.stale === null
        ? "not installed (cannot compare)"
        : build.stale
          ? `STALE (newest source ${build.sourceNewest ?? "unknown"}; run pnpm build)`
          : "current"
    }`,
  ];
  return details.join("\n");
}

export function formatBuildLabel(build: CliBuildInfo): string {
  return `codepunk ${build.version} · dist ${build.builtAt ?? "unknown"} · source ${
    build.stale === true
      ? "STALE"
      : build.stale === false
        ? "current"
        : "unknown"
  }`;
}

export function appendBuildDoctorCheck(
  report: DoctorReport,
  build: CliBuildInfo,
): DoctorReport {
  const check: DoctorCheck = {
    id: "build",
    status: build.stale === true ? "warn" : "ok",
    message:
      build.stale === true
        ? `stale dist: source ${build.sourceNewest ?? "unknown"} is newer than build ${build.builtAt ?? "unknown"}`
        : build.stale === false
          ? `dist matches package sources (built ${build.builtAt ?? "unknown"})`
          : `installed package built ${build.builtAt ?? "unknown"}; source comparison unavailable`,
    hint:
      build.stale === true
        ? `run pnpm build in ${path.dirname(path.dirname(path.dirname(path.dirname(build.entryPath))))}`
        : null,
  };
  const checks = [...report.checks, check];
  return {
    ...report,
    checks,
    ok: checks.every((entry) => entry.status !== "error"),
  };
}
