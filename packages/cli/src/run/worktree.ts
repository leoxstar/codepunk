import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ConfigError, findDeliveryRoot, projectPaths } from "codepunk-core";

const execFileAsync = promisify(execFile);

const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface IsolatedCliWorktree {
  readonly cwd: string;
  readonly branch: string;
  readonly slug: string;
  readonly created: boolean;
}

export function validateWorktreeName(name: string): string {
  if (!WORKTREE_NAME_PATTERN.test(name)) {
    throw new ConfigError(
      "--worktree name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
    );
  }
  return name;
}

async function resolveGitRepoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd },
    );
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function gitBranchExists(
  vcsRoot: string,
  branch: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: vcsRoot },
    );
    return true;
  } catch {
    return false;
  }
}

async function isValidWorktreeDir(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, ".git"));
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: dir },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function prepareCliWorktree(
  worktreeOption: string | undefined,
  baseCwd = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
  quiet = false,
): Promise<IsolatedCliWorktree | null> {
  if (worktreeOption === undefined) {
    return null;
  }
  validateWorktreeName(worktreeOption);
  const vcsRoot = await resolveGitRepoRoot(baseCwd);
  if (vcsRoot === null) {
    throw new ConfigError("--worktree requires a git repository");
  }
  const project = await findDeliveryRoot(baseCwd);
  const paths = projectPaths(project, environment["CODEPUNK_HOME"]);
  const slug =
    worktreeOption === "auto"
      ? `wt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      : worktreeOption;
  validateWorktreeName(slug);
  const worktreeRoot = path.join(paths.projectDir, "worktrees");
  await fs.mkdir(worktreeRoot, { recursive: true });
  const worktreeDir = path.join(worktreeRoot, slug);
  const branch = `codepunk/${slug}`;
  if (await isValidWorktreeDir(worktreeDir)) {
    const realExisting = await fs.realpath(worktreeDir);
    if (!quiet) {
      process.stderr.write(
        `codepunk: reusing isolated worktree ${realExisting} (${branch})\n`,
      );
    }
    return { cwd: realExisting, branch, slug, created: false };
  }
  const branchExists = await gitBranchExists(vcsRoot, branch);
  const gitArgs = branchExists
    ? ["worktree", "add", worktreeDir, branch]
    : ["worktree", "add", "-b", branch, worktreeDir, "HEAD"];
  await execFileAsync("git", gitArgs, { cwd: vcsRoot });
  const realCwd = await fs.realpath(worktreeDir);
  if (!quiet) {
    process.stderr.write(
      `codepunk: isolated worktree ${realCwd} (${branch})\n`,
    );
  }
  return { cwd: realCwd, branch, slug, created: true };
}
