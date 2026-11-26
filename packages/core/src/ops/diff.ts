import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { sha256Bytes, sha256Value } from "../platform/hash.ts";

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

export class NotAGitWorktreeError extends Error {
  constructor(root: string, options?: { cause?: unknown }) {
    super(`not a Git worktree: ${root}`, options);
    this.name = "NotAGitWorktreeError";
  }
}

export interface WorkspaceDiffUntrackedFile {
  path: string;
  kind: "file" | "symlink" | "directory" | "other" | "outside" | "missing";
  content: string;
  link_target: string | null;
  size: number;
  included_bytes: number;
  sha256: string | null;
  truncated: boolean;
}

export type DiffLineRange = readonly [start: number, end: number];

export interface WorkspaceDiffLineRanges {
  path: string;
  ranges: DiffLineRange[];
}

/**
 * A diff snapshot is the exact data a structured review is bound to. Unlike
 * readWorkspaceDiff it includes untracked file contents and the reviewable
 * line ranges, and it deliberately excludes status/stat text that depends on
 * user formatting preferences.
 */
export interface WorkspaceDiffSnapshot {
  version: 1;
  changed_paths: string[];
  staged: string;
  unstaged: string;
  untracked: WorkspaceDiffUntrackedFile[];
  line_ranges: WorkspaceDiffLineRanges[];
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
    ]).catch(async (error: unknown) => {
      const probe = await runGit(
        options.root,
        ["rev-parse", "--is-inside-work-tree"],
        STATUS_MAX_BYTES,
        { tolerateExit: 128 },
      ).catch(() => null);
      if (probe !== null && probe.text.trim() !== "true") {
        throw new NotAGitWorktreeError(options.root, { cause: error });
      }
      throw error;
    });
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

const SNAPSHOT_DIFF_FLAGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--no-relative",
  "--no-prefix",
  "--full-index",
  "--diff-algorithm=myers",
  "--inter-hunk-context=0",
  "--unified=3",
  "--ignore-submodules=none",
] as const;

function diffArgs(options: { cached?: boolean; revision?: string }): string[] {
  const args = ["-c", "core.quotePath=false", "diff"];
  if (options.cached === true) {
    args.push("--cached");
  }
  if (options.revision !== undefined) {
    args.push(options.revision);
  }
  args.push(...SNAPSHOT_DIFF_FLAGS);
  return args;
}

function nameListArgs(cached: boolean): string[] {
  return [
    "-c",
    "core.quotePath=false",
    "diff",
    ...(cached ? ["--cached"] : []),
    "--name-only",
    "-z",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--ignore-submodules=none",
  ];
}

function splitNulPaths(output: GitOutput): string[] {
  if (output.text.length === 0) {
    return [];
  }
  const parts = output.text.split("\u0000");
  // A complete -z stream ends with NUL, so the final split item is empty.
  // A truncated stream may end in the middle of a path; dropping that item is
  // safer than accepting a partial path as repository-relative.
  parts.pop();
  return parts.filter((part) => part.length > 0);
}

function quoteGitPath(value: string): string {
  const needsQuotes = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x22 || code === 0x5c || code === 0x7f;
  });
  if (!needsQuotes) {
    return value;
  }
  let quoted = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    switch (character) {
      case "\u0007":
        quoted += "\\a";
        continue;
      case "\b":
        quoted += "\\b";
        continue;
      case "\t":
        quoted += "\\t";
        continue;
      case "\n":
        quoted += "\\n";
        continue;
      case "\u000b":
        quoted += "\\v";
        continue;
      case "\f":
        quoted += "\\f";
        continue;
      case "\r":
        quoted += "\\r";
        continue;
      case '"':
        quoted += '\\"';
        continue;
      case "\\":
        quoted += "\\\\";
        continue;
      default:
        break;
    }
    if (code < 0x20 || code === 0x7f) {
      quoted += `\\${code.toString(8).padStart(3, "0")}`;
    } else {
      quoted += character;
    }
  }
  return `${quoted}"`;
}

function headerForms(paths: readonly string[]): Map<string, string> {
  const forms = new Map<string, string>();
  const blocked = new Set<string>();
  for (const repositoryPath of paths) {
    const quoted = quoteGitPath(repositoryPath);
    for (const form of new Set([
      `${repositoryPath} ${repositoryPath}`,
      `${quoted} ${quoted}`,
    ])) {
      if (blocked.has(form)) {
        continue;
      }
      const existing = forms.get(form);
      if (existing !== undefined && existing !== repositoryPath) {
        forms.delete(form);
        blocked.add(form);
        continue;
      }
      forms.set(form, repositoryPath);
    }
  }
  return forms;
}

interface DiffSection {
  index: number;
  key: string;
  lines: string[];
}

/**
 * Normalize file order without touching the patch body. diff.orderFile can
 * reorder git output, so sorting whole sections makes the snapshot stable for
 * the same workspace while keeping every hunk byte-for-byte intact.
 */
function sortDiffSections(
  text: string,
  forms: ReadonlyMap<string, string>,
): string {
  if (text.length === 0) {
    return text;
  }
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const header = line.slice("diff --git ".length);
      const repositoryPath = forms.get(header);
      current = {
        index: sections.length,
        key: repositoryPath ?? header,
        lines: [line],
      };
      sections.push(current);
      continue;
    }
    if (current === null) {
      current = { index: sections.length, key: "", lines: [line] };
      sections.push(current);
      continue;
    }
    current.lines.push(line);
  }
  sections.sort((left, right) => {
    if (left.key === right.key) {
      return left.index - right.index;
    }
    return left.key < right.key ? -1 : 1;
  });
  return sections.flatMap((section) => section.lines).join("\n");
}

function addLineRange(
  ranges: Map<string, DiffLineRange[]>,
  repositoryPath: string,
  start: number,
  end: number,
): void {
  const existing = ranges.get(repositoryPath);
  if (existing === undefined) {
    ranges.set(repositoryPath, [[start, end]]);
  } else {
    existing.push([start, end]);
  }
}

function parseLineRanges(
  text: string,
  forms: ReadonlyMap<string, string>,
  ranges: Map<string, DiffLineRange[]>,
): void {
  let current: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = forms.get(line.slice("diff --git ".length)) ?? null;
      continue;
    }
    if (current === null) {
      continue;
    }
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (match === null) {
      continue;
    }
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(count) &&
      count > 0
    ) {
      addLineRange(ranges, current, start, start + count - 1);
    }
  }
}

function normalizeRanges(ranges: readonly DiffLineRange[]): DiffLineRange[] {
  const sorted = [...ranges].sort((left, right) =>
    left[0] === right[0] ? left[1] - right[1] : left[0] - right[0],
  );
  const merged: DiffLineRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous !== undefined && range[0] <= previous[1] + 1) {
      merged[merged.length - 1] = [
        previous[0],
        Math.max(previous[1], range[1]),
      ];
    } else {
      merged.push([range[0], range[1]]);
    }
  }
  return merged;
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  let count = 1;
  for (const character of content) {
    if (character === "\n") {
      count += 1;
    }
  }
  if (content.endsWith("\n")) {
    count -= 1;
  }
  return count;
}

async function readUntrackedFiles(
  root: string,
  repositoryPaths: readonly string[],
  maxBytes: number,
): Promise<{ files: WorkspaceDiffUntrackedFile[]; truncated: boolean }> {
  const files: WorkspaceDiffUntrackedFile[] = [];
  let remaining = maxBytes;
  let truncated = false;
  for (const repositoryPath of repositoryPaths) {
    const absolute = path.resolve(root, repositoryPath);
    const relative = path.relative(root, absolute);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      files.push({
        path: repositoryPath,
        kind: "outside",
        content: "",
        link_target: null,
        size: 0,
        included_bytes: 0,
        sha256: null,
        truncated: true,
      });
      truncated = true;
      continue;
    }
    let size = 0;
    try {
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        let linkTargetBytes: Buffer;
        try {
          linkTargetBytes = await fs.readlink(absolute, {
            encoding: "buffer",
          });
        } catch {
          files.push({
            path: repositoryPath,
            kind: "symlink",
            content: "",
            link_target: null,
            size: stat.size,
            included_bytes: 0,
            sha256: null,
            truncated: true,
          });
          truncated = true;
          continue;
        }
        const linkTarget = linkTargetBytes.toString("utf8");
        files.push({
          path: repositoryPath,
          kind: "symlink",
          content: "",
          link_target: linkTarget,
          size: linkTargetBytes.length,
          included_bytes: 0,
          sha256: sha256Bytes(linkTargetBytes),
          truncated: false,
        });
        continue;
      }
      if (!stat.isFile()) {
        files.push({
          path: repositoryPath,
          kind: stat.isDirectory() ? "directory" : "other",
          content: "",
          link_target: null,
          size: stat.size,
          included_bytes: 0,
          sha256: null,
          truncated: false,
        });
        continue;
      }
      size = stat.size;
    } catch {
      files.push({
        path: repositoryPath,
        kind: "missing",
        content: "",
        link_target: null,
        size: 0,
        included_bytes: 0,
        sha256: null,
        truncated: true,
      });
      truncated = true;
      continue;
    }
    if (remaining <= 0) {
      files.push({
        path: repositoryPath,
        kind: "file",
        content: "",
        link_target: null,
        size,
        included_bytes: 0,
        sha256: null,
        truncated: true,
      });
      truncated = true;
      continue;
    }

    const buffer = Buffer.allocUnsafe(Math.min(size, remaining) + 1);
    let readBytes = 0;
    try {
      const handle = await fs.open(
        absolute,
        fsConstants.O_RDONLY |
          (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW),
      );
      try {
        const opened = await handle.stat();
        if (!opened.isFile()) {
          throw new Error("untracked path became a non-regular file");
        }
        while (readBytes < buffer.length) {
          const chunk = await handle.read(
            buffer,
            readBytes,
            buffer.length - readBytes,
            readBytes,
          );
          if (chunk.bytesRead === 0) {
            break;
          }
          readBytes += chunk.bytesRead;
        }
      } finally {
        await handle.close();
      }
    } catch {
      files.push({
        path: repositoryPath,
        kind: "missing",
        content: "",
        link_target: null,
        size,
        included_bytes: 0,
        sha256: null,
        truncated: true,
      });
      truncated = true;
      continue;
    }

    const included = Math.min(readBytes, remaining);
    // A file that grows or shrinks between lstat and read is no longer the
    // complete byte range described by the snapshot. Mark it truncated so a
    // review cannot bind a partially observed file.
    const fileTruncated = readBytes !== size || readBytes > included;
    files.push({
      path: repositoryPath,
      kind: "file",
      content: buffer.subarray(0, included).toString("utf8"),
      link_target: null,
      size,
      included_bytes: included,
      sha256: sha256Bytes(buffer.subarray(0, included)),
      truncated: fileTruncated,
    });
    if (fileTruncated) {
      truncated = true;
    }
    remaining -= included;
  }
  return { files, truncated };
}

/**
 * Read a deterministic, reviewable snapshot of the workspace. It is separate
 * from readWorkspaceDiff so the human-facing `/diff` output keeps its existing
 * shape while structured review gets untracked contents and line ranges.
 */
export async function readWorkspaceDiffSnapshot(
  options: WorkspaceDiffOptions,
): Promise<WorkspaceDiffSnapshot> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }

  const [
    stagedNames,
    unstagedNames,
    untrackedNames,
    stagedOutput,
    unstagedOutput,
    headOutput,
  ] = await Promise.all([
    runGit(options.root, nameListArgs(true), maxBytes),
    runGit(options.root, nameListArgs(false), maxBytes),
    runGit(
      options.root,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      maxBytes,
    ),
    runGit(options.root, diffArgs({ cached: true }), maxBytes),
    runGit(options.root, diffArgs({}), maxBytes),
    runGit(options.root, diffArgs({ revision: "HEAD" }), maxBytes, {
      tolerateExit: 128,
    }),
  ]);

  const untrackedPaths = splitNulPaths(untrackedNames).sort();
  const changed = new Set([
    ...splitNulPaths(stagedNames),
    ...splitNulPaths(unstagedNames),
    ...untrackedPaths,
  ]);
  const changedPaths = [...changed].sort();
  const forms = headerForms(changedPaths);
  const staged = sortDiffSections(stagedOutput.text, forms);
  const unstaged = sortDiffSections(unstagedOutput.text, forms);

  const rangeMap = new Map<string, DiffLineRange[]>();
  // Hunk numbers are relative to the new side. The combined worktree diff
  // keeps them in the current file when staged and unstaged edits overlap.
  if (headOutput.text.length > 0) {
    parseLineRanges(headOutput.text, forms, rangeMap);
  } else {
    // Unborn branches have no HEAD. The staged patch compares the index with
    // the empty tree, so staged plus unstaged hunks are the best available
    // reviewable ranges.
    parseLineRanges(staged, forms, rangeMap);
    parseLineRanges(unstaged, forms, rangeMap);
  }

  const untracked = await readUntrackedFiles(
    options.root,
    untrackedPaths,
    maxBytes,
  );
  for (const file of untracked.files) {
    const lines = countLines(file.content);
    if (lines > 0) {
      addLineRange(rangeMap, file.path, 1, lines);
    }
  }

  const lineRanges: WorkspaceDiffLineRanges[] = [];
  for (const repositoryPath of [...rangeMap.keys()].sort()) {
    const ranges = normalizeRanges(rangeMap.get(repositoryPath) ?? []);
    if (ranges.length > 0) {
      lineRanges.push({ path: repositoryPath, ranges });
    }
  }

  return {
    version: 1,
    changed_paths: changedPaths,
    staged,
    unstaged,
    untracked: untracked.files,
    line_ranges: lineRanges,
    truncated:
      stagedOutput.truncated ||
      unstagedOutput.truncated ||
      headOutput.truncated ||
      stagedNames.truncated ||
      unstagedNames.truncated ||
      untrackedNames.truncated ||
      untracked.truncated,
  };
}

export function workspaceDiffSnapshotSha256(
  snapshot: WorkspaceDiffSnapshot,
): string {
  return sha256Value({
    version: snapshot.version,
    changed_paths: snapshot.changed_paths,
    staged: snapshot.staged,
    unstaged: snapshot.unstaged,
    untracked: snapshot.untracked,
    line_ranges: snapshot.line_ranges,
    truncated: snapshot.truncated,
  });
}
