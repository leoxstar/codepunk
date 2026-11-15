import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensurePrivateDir, writeJsonAtomic } from "./fs.ts";
import { isInsidePath, normalizeAbsolute, resolveRealPath } from "./path.ts";

export const PROJECT_GITIGNORE = "local.toml\n*.local.toml\n";

export interface ProjectPaths {
  cwd: string;
  deliveryRoot: string;
  additionalRoots: string[];
  projectId: string;
  home: string;
  projectConfigDir: string;
  projectDir: string;
  sessionsDir: string;
  evidenceDir: string;
  verdictsDir: string;
  artifactsDir: string;
  memoryDir: string;
}

export interface ProjectContext {
  cwd: string;
  deliveryRoot: string;
  projectId: string;
  isGitRepository: boolean;
}

function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, 5_000);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0 ? output.trim() : null);
    });
  });
}

async function realDirectory(candidate: string): Promise<string | null> {
  try {
    const real = await fs.realpath(candidate);
    return (await fs.stat(real)).isDirectory() ? normalizeAbsolute(real) : null;
  } catch {
    return null;
  }
}

export async function findDeliveryRoot(cwd: string): Promise<ProjectContext> {
  const normalizedCwd = normalizeAbsolute(cwd);
  const realCwd = (await realDirectory(normalizedCwd)) ?? normalizedCwd;
  // Use the current checkout's top-level directory, not the common Git
  // directory. In a linked worktree the common directory points at the main
  // checkout, which would make the worktree itself look "outside" the
  // workspace and would scan the main checkout for trust resources.
  const topLevel = await runGit(realCwd, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
  ]);
  if (topLevel !== null) {
    const root = normalizeAbsolute(topLevel);
    const realRoot = (await realDirectory(root)) ?? root;
    return {
      cwd: realCwd,
      deliveryRoot: realRoot,
      projectId: projectIdFor(realRoot),
      isGitRepository: true,
    };
  }
  return {
    cwd: realCwd,
    deliveryRoot: realCwd,
    projectId: projectIdFor(realCwd),
    isGitRepository: false,
  };
}

export async function resolveAdditionalWorkspaceRoots(input: {
  cwd: string;
  primaryRoot: string;
  codepunkHome: string;
  directories: readonly string[];
}): Promise<string[]> {
  const primaryRoot = resolveRealPath(input.primaryRoot);
  const codepunkHome = resolveRealPath(input.codepunkHome);
  const userHome = resolveRealPath(os.homedir());
  const roots = new Set<string>();
  for (const entry of input.directories) {
    const candidate = resolveRealPath(
      path.isAbsolute(entry) ? entry : path.resolve(input.cwd, entry),
    );
    const real = await realDirectory(candidate);
    if (real === null) {
      throw new Error(`--add-dir is not a directory: ${candidate}`);
    }
    if (real === primaryRoot) {
      throw new Error(`--add-dir is already the workspace root: ${real}`);
    }
    if (isInsidePath(primaryRoot, real)) {
      throw new Error(
        `--add-dir is already inside the workspace; no extra root is needed: ${real}`,
      );
    }
    if (isInsidePath(real, primaryRoot)) {
      throw new Error(`--add-dir cannot contain the workspace root: ${real}`);
    }
    if (
      isInsidePath(codepunkHome, real) ||
      isInsidePath(real, codepunkHome) ||
      isInsidePath(real, userHome)
    ) {
      throw new Error(
        `--add-dir cannot contain the user home or Codepunk home: ${real}`,
      );
    }
    roots.add(real);
  }
  return [...roots].sort();
}

export function projectIdFor(deliveryRoot: string): string {
  return createHash("sha256")
    .update(normalizeAbsolute(deliveryRoot))
    .digest("hex")
    .slice(0, 16);
}

export function resolveCodepunkHome(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment["CODEPUNK_HOME"];
  if (configured !== undefined && configured.length > 0) {
    return normalizeAbsolute(configured);
  }
  return path.join(os.homedir(), ".codepunk");
}

export function projectPaths(
  context: Pick<ProjectContext, "cwd" | "deliveryRoot" | "projectId">,
  home = resolveCodepunkHome(),
  additionalRoots: readonly string[] = [],
): ProjectPaths {
  const normalizedHome = normalizeAbsolute(home);
  const projectDir = path.join(normalizedHome, "projects", context.projectId);
  return {
    cwd: normalizeAbsolute(context.cwd),
    deliveryRoot: normalizeAbsolute(context.deliveryRoot),
    additionalRoots: [
      ...new Set(additionalRoots.map((entry) => normalizeAbsolute(entry))),
    ],
    projectId: context.projectId,
    home: normalizedHome,
    projectConfigDir: path.join(
      normalizeAbsolute(context.deliveryRoot),
      ".codepunk",
    ),
    projectDir,
    sessionsDir: path.join(projectDir, "sessions"),
    evidenceDir: path.join(projectDir, "evidence"),
    verdictsDir: path.join(projectDir, "verdicts"),
    artifactsDir: path.join(projectDir, "artifacts"),
    memoryDir: path.join(projectDir, "memory"),
  };
}

export async function ensureCodepunkHome(home: string): Promise<void> {
  for (const directory of [
    normalizeAbsolute(home),
    path.join(home, "sessions"),
    path.join(home, "memory"),
    path.join(home, "projects"),
    path.join(home, "logs"),
    path.join(home, "cache"),
  ]) {
    await ensurePrivateDir(directory);
  }
}

export async function ensureProjectRegistration(
  context: ProjectContext,
  paths: ProjectPaths,
): Promise<void> {
  await ensurePrivateDir(paths.projectDir);
  const projectFile = path.join(paths.projectDir, "project.json");
  try {
    await fs.access(projectFile);
  } catch {
    await writeJsonAtomic(projectFile, {
      id: context.projectId,
      cwd: context.deliveryRoot,
      git_remote: null,
      created_at: new Date().toISOString(),
    });
  }
  for (const directory of [
    paths.sessionsDir,
    paths.evidenceDir,
    paths.verdictsDir,
    paths.artifactsDir,
    paths.memoryDir,
  ]) {
    await ensurePrivateDir(directory);
  }
}

export async function ensureProjectConfigDir(
  paths: ProjectPaths,
): Promise<void> {
  await fs.mkdir(paths.projectConfigDir, { recursive: true, mode: 0o755 });
  const ignorePath = path.join(paths.projectConfigDir, ".gitignore");
  try {
    await fs.access(ignorePath);
  } catch {
    await fs.writeFile(ignorePath, PROJECT_GITIGNORE, { mode: 0o644 });
  }
}

export async function assertProjectConfigSafe(
  paths: ProjectPaths,
): Promise<string | null> {
  let stat;
  try {
    stat = await fs.lstat(paths.projectConfigDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return "project .codepunk cannot be inspected";
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return "project .codepunk must be a real directory";
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    return "project .codepunk must be owned by the invoking user";
  }
  if (process.platform !== "win32" && (stat.mode & 0o002) !== 0) {
    return "project .codepunk must not be world-writable";
  }
  const real = normalizeAbsolute(await fs.realpath(paths.projectConfigDir));
  if (real !== normalizeAbsolute(paths.projectConfigDir)) {
    return "project .codepunk must not use a symlinked path";
  }
  return null;
}

export async function assertProjectConfigFileSafe(
  filePath: string,
): Promise<string | null> {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return "project config file cannot be inspected";
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return "project config file must be a real file";
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    return "project config file must be owned by the invoking user";
  }
  if (process.platform !== "win32" && (stat.mode & 0o002) !== 0) {
    return "project config file must not be world-writable";
  }
  const real = normalizeAbsolute(await fs.realpath(filePath));
  if (real !== normalizeAbsolute(filePath)) {
    return "project config file must not use a symlinked path";
  }
  return null;
}
