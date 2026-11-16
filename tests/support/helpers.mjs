import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  projectPaths,
  resolveCodepunkHome,
} from "../../packages/core/src/platform/paths.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * The suite shells out to pnpm and npm. Both timeouts are configurable because a
 * cold runner or a slow registry mirror legitimately needs longer than a warm
 * laptop, and a hard-coded value turns "slower than my machine" into "broken".
 */
export const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;
export const DEFAULT_BUILD_TIMEOUT_MS = 600_000;

const NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ERR_SOCKET_TIMEOUT",
]);

const NETWORK_PATTERN =
  /(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ERR_SOCKET_TIMEOUT|socket hang up|fetch failed|getaddrinfo|npm ERR! code E(?:40[13]|429|5\d\d))/iu;

export function resolveTimeoutMs(envName, fallback, env = process.env) {
  const raw = env[envName];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${envName} must be a positive integer number of milliseconds, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

export function resolveInstallTimeoutMs(env = process.env) {
  return resolveTimeoutMs(
    "CODEPUNK_TEST_INSTALL_TIMEOUT_MS",
    DEFAULT_INSTALL_TIMEOUT_MS,
    env,
  );
}

export function resolveBuildTimeoutMs(env = process.env) {
  return resolveTimeoutMs(
    "CODEPUNK_TEST_BUILD_TIMEOUT_MS",
    DEFAULT_BUILD_TIMEOUT_MS,
    env,
  );
}

/**
 * A killed child means we ran out of time. A name-resolution or socket failure
 * means we never reached the other side, so the run says nothing about the code
 * under test. Anything else is a real failure of the thing being checked.
 */
export function classifyCommandFailure(error) {
  if (error === null || typeof error !== "object") {
    return "assertion";
  }
  if (error.killed === true) {
    return "timeout";
  }
  if (error.signal === "SIGTERM" || error.signal === "SIGKILL") {
    return "timeout";
  }
  if (typeof error.code === "string" && NETWORK_ERROR_CODES.has(error.code)) {
    return "network";
  }
  const message = typeof error.message === "string" ? error.message : "";
  const stderr = typeof error.stderr === "string" ? error.stderr : "";
  if (NETWORK_PATTERN.test(`${message}\n${stderr}`)) {
    return "network";
  }
  return "assertion";
}

function failureDetail(error) {
  if (error === null || typeof error !== "object") {
    return String(error);
  }
  const message = typeof error.message === "string" ? error.message : "";
  const stderr = typeof error.stderr === "string" ? error.stderr : "";
  const text = stderr.trim() === "" ? message : `${message}\n${stderr}`;
  const bounded = text.split("\n").slice(0, 12).join("\n").trim();
  return bounded === "" ? "no error detail" : bounded;
}

export function describeInstallFailure(error, timeoutMs) {
  const kind = classifyCommandFailure(error);
  const advice = {
    timeout: `npm install produced no result within ${timeoutMs}ms. Treat a repeated timeout as a distribution problem rather than a test problem; raise CODEPUNK_TEST_INSTALL_TIMEOUT_MS only when the machine or the registry is genuinely slow.`,
    network: `npm install could not reach a package host, so this run says nothing about whether the packed tarballs are correct. Re-run with network access before reporting a distribution regression.`,
    assertion: `npm install reached the registry and still failed, so the packed tarballs, their manifest, or the installed layout are wrong.`,
  }[kind];
  return `distribution install failed (${kind}): ${failureDetail(error)}\n${advice}`;
}

export function describeBuildFailure(error, timeoutMs) {
  const kind = classifyCommandFailure(error);
  const advice = {
    timeout: `pnpm run build produced no result within ${timeoutMs}ms. Raise CODEPUNK_TEST_BUILD_TIMEOUT_MS on a slow machine; a repeated timeout means the build is stuck rather than slow.`,
    network: `pnpm run build could not reach a package host, so this run says nothing about whether the sources compile.`,
    assertion: `pnpm run build ran and failed, so the compiler or the packager rejected the sources.`,
  }[kind];
  return `test setup failed (${kind}): ${failureDetail(error)}\n${advice}`;
}

export async function withTempDirectory(prefix, callback) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function makeProject(root, name = "project") {
  const projectRoot = path.join(root, name);
  await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, ".codepunk"), { recursive: true });
  const paths = projectPaths(
    {
      cwd: projectRoot,
      deliveryRoot: projectRoot,
      projectId: "0123456789abcdef",
    },
    path.join(root, "home"),
  );
  await fs.mkdir(paths.projectDir, { recursive: true });
  for (const directory of [
    paths.sessionsDir,
    paths.evidenceDir,
    paths.verdictsDir,
    paths.artifactsDir,
    paths.memoryDir,
  ]) {
    await fs.mkdir(directory, { recursive: true });
  }
  await trustWorkspace(paths.home, projectRoot);
  return { projectRoot, paths };
}

/**
 * Record a saved workspace-trust decision next to a Codepunk home so tests
 * exercise the trusted path. Real users get the same store from
 * `codepunk trust grant` or the first-run prompt.
 */
export async function trustWorkspace(home, projectRoot) {
  const realHome = resolveCodepunkHome({ CODEPUNK_HOME: home });
  const real = await fs.realpath(projectRoot);
  await fs.mkdir(realHome, { recursive: true });
  const trustPath = path.join(realHome, "trust.json");
  let data = {};
  try {
    data = JSON.parse(await fs.readFile(trustPath, "utf8"));
  } catch {
    data = {};
  }
  data[real] = true;
  await fs.writeFile(trustPath, `${JSON.stringify(data, null, 2)}\n`);
  return trustPath;
}

export async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

export function fixedClock(start = "2026-11-12T00:00:00.000Z", stepMs = 1000) {
  let current = new Date(start);
  return () => {
    const value = new Date(current);
    current = new Date(current.getTime() + stepMs);
    return value;
  };
}

async function newestSourceMtime() {
  let newest = 0;
  for (const packageName of ["protocol", "core", "cli"]) {
    const root = path.join(REPO_ROOT, "packages", packageName, "src");
    const entries = await fs.readdir(root, { recursive: true });
    for (const entry of entries) {
      const candidate = path.join(root, entry);
      const stat = await fs.stat(candidate).catch(() => null);
      if (stat?.isFile() === true) {
        newest = Math.max(newest, stat.mtimeMs);
      }
    }
  }
  return newest;
}

export async function ensureBuilt() {
  const cliEntry = path.join(REPO_ROOT, "packages", "cli", "dist", "index.js");
  const sourceTime = await newestSourceMtime();
  const builtTime = await fs
    .stat(cliEntry)
    .then((stat) => stat.mtimeMs)
    .catch(() => 0);
  if (builtTime >= sourceTime && builtTime > 0) {
    return cliEntry;
  }
  const lock = path.join(os.tmpdir(), "codepunk-build.lock");
  let acquired = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await fs.mkdir(lock);
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try {
    if (acquired) {
      const current = await fs.stat(cliEntry).catch(() => null);
      if (current === null || current.mtimeMs < sourceTime) {
        const buildTimeoutMs = resolveBuildTimeoutMs();
        try {
          execFileSync("pnpm", ["run", "build"], {
            cwd: REPO_ROOT,
            stdio: "pipe",
            timeout: buildTimeoutMs,
          });
        } catch (error) {
          throw new Error(describeBuildFailure(error, buildTimeoutMs));
        }
      }
    }
  } finally {
    if (acquired) {
      await fs.rm(lock, { recursive: true, force: true });
    }
  }
  return cliEntry;
}
