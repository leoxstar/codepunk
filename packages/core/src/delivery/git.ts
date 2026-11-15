import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_REDIRECTS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
] as const;

export function cleanGitEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const clean = { ...environment };
  for (const key of GIT_REDIRECTS) {
    delete clean[key];
  }
  return clean;
}

function gitArguments(args: readonly string[]): string[] {
  return [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.quotePath=false",
    ...args,
  ];
}

export async function gitText(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await execFileAsync("git", gitArguments(args), {
    cwd,
    env: cleanGitEnvironment(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return result.stdout;
}

export async function gitBuffer(
  cwd: string,
  args: readonly string[],
): Promise<Buffer> {
  const result = await execFileAsync("git", gitArguments(args), {
    cwd,
    env: cleanGitEnvironment(),
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

export async function gitSucceeds(
  cwd: string,
  args: readonly string[],
): Promise<boolean> {
  try {
    await gitText(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCommit(
  cwd: string,
  revision: string,
): Promise<string> {
  return (await gitText(cwd, ["rev-parse", "--verify", `${revision}^{commit}`]))
    .trim()
    .toLowerCase();
}

export async function resolveTree(
  cwd: string,
  revision: string,
): Promise<string> {
  return (await gitText(cwd, ["rev-parse", "--verify", `${revision}^{tree}`]))
    .trim()
    .toLowerCase();
}

export function nulPaths(output: string): string[] {
  return output
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.split("\\").join("/"));
}
