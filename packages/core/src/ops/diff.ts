import { spawn } from "node:child_process";

const DEFAULT_MAX_BYTES = 256 * 1024;
const STATUS_MAX_BYTES = 64 * 1024;

export interface WorkspaceDiffOptions {
  root: string;
  /**
   * Upper bound for each patch stream. The status and stat streams use a
   * smaller fixed bound because they are only a summary.
   */
  maxBytes?: number;
}

export interface WorkspaceDiff {
  root: string;
  status: string;
  stat: string;
  staged: string;
  unstaged: string;
  untracked: string;
  truncated: boolean;
}

interface GitOutput {
  text: string;
  truncated: boolean;
}

function runGit(
  root: string,
  args: readonly string[],
  maxBytes: number,
  options: { tolerateExit?: number } = {},
): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", root, ...args], {
      cwd: root,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;

    const finish = (result: GitOutput | Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) {
        return;
      }
      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        truncated = true;
        child.kill();
        return;
      }
      const take =
        chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(take);
      bytes += take.length;
      if (take.length < chunk.length) {
        truncated = true;
        child.kill();
      }
    });
    child.on("error", (error) => finish(error));
    // No consumer reads stderr; drain it so a large warning cannot fill the
    // pipe and stall the child.
    child.stderr?.resume();
    child.on("close", (code, signal) => {
      if (
        code === 0 ||
        truncated ||
        (code !== null && code === options.tolerateExit)
      ) {
        finish({
          text: Buffer.concat(chunks).toString("utf8"),
          truncated,
        });
        return;
      }
      finish(
        new Error(
          `git ${args[0] ?? "command"} failed (exit ${
            code === null ? "null" : String(code)
          }${signal === null ? "" : `, ${signal}`})`,
        ),
      );
    });
  });
}

function section(label: string, output: GitOutput): string {
  const text = output.text.trimEnd();
  return text.length === 0 ? "" : `### ${label}\n${text}`;
}

/**
 * Read the working tree status and the staged/unstaged patches without going
 * through the model or the policy gate. `/diff` is a human inspection command,
 * so it runs as the CLI user and never writes the index or the worktree.
 */
export async function readWorkspaceDiff(
  options: WorkspaceDiffOptions,
): Promise<WorkspaceDiff> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  const [status, stagedStat, unstagedStat, staged, unstaged, untracked] =
    await Promise.all([
      runGit(
        options.root,
        ["status", "--short", "--untracked-files=all"],
        Math.min(STATUS_MAX_BYTES, maxBytes),
      ),
      runGit(options.root, ["diff", "--cached", "--stat"], STATUS_MAX_BYTES),
      runGit(options.root, ["diff", "--stat"], STATUS_MAX_BYTES),
      runGit(
        options.root,
        ["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=3"],
        maxBytes,
      ),
      runGit(
        options.root,
        ["diff", "--no-ext-diff", "--no-color", "--unified=3"],
        maxBytes,
      ),
      runGit(
        options.root,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        maxBytes,
        { tolerateExit: 0 },
      ),
    ]);
  return {
    root: options.root,
    status: status.text,
    stat: [section("staged", stagedStat), section("unstaged", unstagedStat)]
      .filter((entry) => entry.length > 0)
      .join("\n\n"),
    staged: staged.text,
    unstaged: unstaged.text,
    untracked: untracked.text.split("\u0000").filter(Boolean).join("\n"),
    truncated:
      status.truncated ||
      stagedStat.truncated ||
      unstagedStat.truncated ||
      staged.truncated ||
      unstaged.truncated ||
      untracked.truncated,
  };
}
