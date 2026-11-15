import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  projectPaths,
  resolveCodepunkHome,
} from "../../packages/core/src/platform/paths.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

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
        execFileSync("pnpm", ["run", "build"], {
          cwd: REPO_ROOT,
          stdio: "pipe",
        });
      }
    }
  } finally {
    if (acquired) {
      await fs.rm(lock, { recursive: true, force: true });
    }
  }
  return cliEntry;
}
