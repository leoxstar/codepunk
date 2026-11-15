import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  MergeRecord,
  TaskHandoff,
  TaskSpec,
  Verdict,
} from "@codepunk/protocol";
import { MergeRecordSchema, validateSchema } from "@codepunk/protocol";
import { evidenceRecordHash, readEvidenceFile } from "../evidence/index.ts";
import { atomicWriteFile } from "../platform/fs.ts";
import { createUlid, recordHash, sha256Bytes } from "../platform/hash.ts";
import { normalizeAbsolute } from "../platform/path.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import { ClaimStore, type ClaimRecord } from "../workers/claims.ts";
import {
  gitBuffer,
  gitSucceeds,
  gitText,
  nulPaths,
  resolveCommit,
  resolveTree,
  statusOutsideCodepunk,
} from "./git.ts";
import type { TaskState } from "./graph.ts";
import { treeFileHash } from "./handoff.ts";

export interface MergeOptions {
  paths: ProjectPaths;
  repoRoot: string;
  sourceWorktree: string;
  spec: TaskSpec;
  handoff: TaskHandoff;
  /**
   * Evidence produced by a child session can live under that child's project
   * store, which has a different project id than the parent checkout. The
   * handoff already binds the run and session; this path lets the merger
   * verify the exact chain instead of guessing the parent evidence directory.
   */
  evidencePath?: string;
  actor: string;
  human: boolean;
  taskState: TaskState;
  claimStore?: ClaimStore;
  claim?: ClaimRecord;
  now?: () => Date;
}

export interface PostMergeRun {
  runId: string;
  sessionId: string;
  evidencePath: string;
  verdict: Verdict;
}

export interface PostMergeVerification {
  verdict: "complete" | "incomplete" | "unverifiable";
  issues: string[];
}

function relativePath(value: string): string {
  const normalized = value.split("\\").join("/").replace(/^\.\//u, "");
  if (
    normalized.length === 0 ||
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`invalid repository-relative path: ${value}`);
  }
  return normalized;
}

function pathWithin(filePath: string, declared: string): boolean {
  const comparable = (value: string): string => {
    const normalized = relativePath(value);
    return process.platform === "darwin" || process.platform === "win32"
      ? normalized.toLowerCase()
      : normalized;
  };
  const target = comparable(filePath);
  const entry = comparable(declared);
  if (entry === ".") {
    return true;
  }
  return entry.endsWith("/")
    ? target === entry.slice(0, -1) || target.startsWith(entry)
    : target === entry;
}

export function pathCoveredBySet(
  filePath: string,
  writeSet: readonly string[],
): boolean {
  return writeSet.some((entry) => pathWithin(filePath, entry));
}

export function pathIntersectsProtected(
  filePath: string,
  protectedPaths: readonly string[],
): boolean {
  return protectedPaths.some((entry) => pathWithin(filePath, entry));
}

async function changedPaths(
  repoRoot: string,
  baseCommit: string,
  headCommit: string,
): Promise<string[]> {
  return nulPaths(
    await gitText(repoRoot, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      baseCommit,
      headCommit,
    ]),
  ).sort((left, right) => left.localeCompare(right));
}

async function checkEvidence(
  paths: ProjectPaths,
  handoff: TaskHandoff,
  evidencePath?: string,
): Promise<void> {
  const target =
    evidencePath === undefined
      ? path.join(
          paths.evidenceDir,
          handoff.evidence.session_id,
          `${handoff.run_id}.jsonl`,
        )
      : normalizeAbsolute(evidencePath);
  const loaded = await readEvidenceFile(target);
  if (loaded.truncatedTail) {
    throw new Error("handoff evidence has a truncated tail");
  }
  const records = loaded.records;
  if (records.length === 0) {
    throw new Error("handoff evidence is missing");
  }
  if (
    records.some((record) => record.run_id !== handoff.run_id) ||
    records[0]!.seq !== 1 ||
    records[0]!.session_id !== handoff.evidence.session_id ||
    records[0]!.seq !== handoff.evidence.first_seq ||
    records.at(-1)!.seq !== handoff.evidence.last_seq ||
    evidenceRecordHash(records.at(-1)!) !== handoff.evidence.head_sha256 ||
    handoff.verdict.evidence_head !== handoff.evidence.head_sha256
  ) {
    throw new Error("handoff evidence chain does not match the handoff");
  }
}

async function handoffCommitIssues(
  repoRoot: string,
  spec: TaskSpec,
  handoff: TaskHandoff,
): Promise<string[]> {
  const issues: string[] = [];
  if (
    handoff.task_id !== spec.task_id ||
    handoff.spec_sha256 !== spec.spec_sha256 ||
    handoff.base_commit !== spec.base_commit
  ) {
    issues.push("handoff does not match the immutable task spec");
  }
  try {
    const base = await resolveCommit(repoRoot, spec.base_commit);
    const head = await resolveCommit(repoRoot, handoff.head_commit);
    if ((await resolveTree(repoRoot, head)) !== handoff.tree) {
      issues.push("handoff tree does not match the exact head commit");
    }
    const paths = await changedPaths(repoRoot, base, head);
    if (
      paths.length !== handoff.changed_paths.length ||
      paths.some((entry, index) => entry !== handoff.changed_paths[index])
    ) {
      issues.push("handoff changed paths do not match the exact commit");
    }
    const files = handoff.files
      .map((file) => relativePath(file.path))
      .sort((left, right) => left.localeCompare(right));
    if (
      files.length !== paths.length ||
      files.some((entry, index) => entry !== paths[index])
    ) {
      issues.push("handoff file list does not match the exact commit");
    }
    for (const file of handoff.files) {
      const before = await treeFileHash(repoRoot, base, file.path);
      const after = await treeFileHash(repoRoot, head, file.path);
      if (before !== file.before_sha256 || after !== file.after_sha256) {
        issues.push(`handoff file hash mismatch: ${file.path}`);
      }
    }
    const diff = await gitBuffer(repoRoot, [
      "diff",
      "--binary",
      "--full-index",
      "--no-color",
      "--no-ext-diff",
      base,
      head,
    ]);
    if (sha256Bytes(diff) !== handoff.diff_sha256) {
      issues.push("handoff diff hash does not match the exact commit");
    }
    for (const entry of paths) {
      if (!pathCoveredBySet(entry, spec.write_set)) {
        issues.push(`handoff changed a path outside the write set: ${entry}`);
      }
      if (pathIntersectsProtected(entry, spec.protected_paths)) {
        issues.push(`handoff changed a protected path: ${entry}`);
      }
    }
  } catch {
    issues.push("handoff commit cannot be inspected");
  }
  return issues;
}

export async function mergeHandoff(
  options: MergeOptions,
): Promise<MergeRecord> {
  if (!options.human || options.actor.trim().length === 0) {
    throw new Error("merge is human-only and requires an explicit actor");
  }
  if (options.taskState !== "review_passed") {
    throw new Error(
      `merge requires task state review_passed (received ${options.taskState ?? "missing"})`,
    );
  }
  if (
    options.handoff.task_id !== options.spec.task_id ||
    options.handoff.spec_sha256 !== options.spec.spec_sha256 ||
    options.handoff.base_commit !== options.spec.base_commit
  ) {
    throw new Error("handoff does not match the immutable task spec");
  }
  if (
    options.handoff.verdict.value !== "complete" ||
    options.handoff.verdict.sign_off_id === null
  ) {
    throw new Error(
      "merge requires a review-passed handoff with human sign-off",
    );
  }
  if (options.handoff.open_issues.length > 0) {
    throw new Error("handoff has unresolved open issues");
  }
  if (options.handoff.claim.claim_id !== null) {
    if (options.claimStore === undefined || options.claim === undefined) {
      throw new Error("claimed handoff requires a live claim at merge");
    }
    if (
      options.handoff.claim.claim_id !== options.claim.claim_id ||
      options.handoff.claim.fence !== options.claim.fence
    ) {
      throw new Error("handoff claim does not match the merge claim");
    }
    await options.claimStore.assertLive(options.claim);
  }
  const repoRoot = normalizeAbsolute(options.repoRoot);
  const sourceWorktree = normalizeAbsolute(options.sourceWorktree);
  const base = await resolveCommit(repoRoot, options.spec.base_commit);
  const head = await resolveCommit(sourceWorktree, "HEAD");
  if (head !== options.handoff.head_commit) {
    throw new Error("worker worktree moved after handoff");
  }
  if (
    statusOutsideCodepunk(
      await gitText(sourceWorktree, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
    ).trim().length > 0
  ) {
    throw new Error("worker worktree is dirty after handoff");
  }
  const tree = await resolveTree(repoRoot, head);
  if (tree !== options.handoff.tree) {
    throw new Error("handoff tree does not match the exact head commit");
  }
  const targetHead = await resolveCommit(repoRoot, "HEAD");
  if (targetHead !== base) {
    throw new Error("merge target moved away from the task base");
  }
  if (
    statusOutsideCodepunk(
      await gitText(repoRoot, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
    ).trim().length > 0
  ) {
    throw new Error("merge target working tree is dirty");
  }
  if (
    !(await gitSucceeds(repoRoot, ["merge-base", "--is-ancestor", base, head]))
  ) {
    throw new Error("handoff head is not descended from the task base");
  }
  const beforeMergePaths = await changedPaths(repoRoot, base, head);
  if (
    beforeMergePaths.length !== options.handoff.changed_paths.length ||
    beforeMergePaths.some(
      (entry, index) => entry !== options.handoff.changed_paths[index],
    )
  ) {
    throw new Error("handoff changed paths do not match the exact commit");
  }
  const handoffFiles = options.handoff.files
    .map((file) => relativePath(file.path))
    .sort((left, right) => left.localeCompare(right));
  if (
    handoffFiles.length !== beforeMergePaths.length ||
    handoffFiles.some((entry, index) => entry !== beforeMergePaths[index])
  ) {
    throw new Error("handoff file list does not match the exact commit");
  }
  for (const entry of beforeMergePaths) {
    if (!pathCoveredBySet(entry, options.spec.write_set)) {
      throw new Error(`handoff changed a path outside the write set: ${entry}`);
    }
    if (pathIntersectsProtected(entry, options.spec.protected_paths)) {
      throw new Error(`handoff changed a protected path: ${entry}`);
    }
  }
  for (const file of options.handoff.files) {
    const before = await treeFileHash(repoRoot, base, file.path);
    const after = await treeFileHash(repoRoot, head, file.path);
    if (before !== file.before_sha256 || after !== file.after_sha256) {
      throw new Error(`handoff file hash mismatch: ${file.path}`);
    }
  }
  const diff = await gitBuffer(repoRoot, [
    "diff",
    "--binary",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    base,
    head,
  ]);
  if (sha256Bytes(diff) !== options.handoff.diff_sha256) {
    throw new Error("handoff diff hash does not match the exact commit");
  }
  await checkEvidence(options.paths, options.handoff, options.evidencePath);

  try {
    await gitText(repoRoot, ["merge", "--no-ff", "--no-edit", head]);
  } catch (error) {
    await gitText(repoRoot, ["merge", "--abort"]).catch(() => undefined);
    throw error;
  }
  const mergeCommit = await resolveCommit(repoRoot, "HEAD");
  const mergeTree = await resolveTree(repoRoot, mergeCommit);
  if (
    !(await gitSucceeds(repoRoot, [
      "merge-base",
      "--is-ancestor",
      options.handoff.head_commit,
      mergeCommit,
    ]))
  ) {
    throw new Error("merge commit does not contain the handoff head");
  }
  const mergedPaths = await changedPaths(repoRoot, base, mergeCommit);
  for (const entry of mergedPaths) {
    if (!pathCoveredBySet(entry, options.spec.write_set)) {
      throw new Error(`merge changed a path outside the write set: ${entry}`);
    }
    if (pathIntersectsProtected(entry, options.spec.protected_paths)) {
      throw new Error(`merge changed a protected path: ${entry}`);
    }
  }
  const record: MergeRecord = {
    version: 1,
    merge_id: createUlid((options.now ?? (() => new Date()))()),
    task_id: options.spec.task_id,
    handoff_head: options.handoff.head_commit,
    base_commit: base,
    merge_commit: mergeCommit,
    tree: mergeTree,
    diff_sha256: options.handoff.diff_sha256,
    actor: options.actor,
    at: (options.now ?? (() => new Date()))().toISOString(),
  };
  const validation = validateSchema(MergeRecordSchema, record);
  if (!validation.ok) {
    throw new Error("merge record is invalid");
  }
  const target = path.join(
    options.paths.projectDir,
    "merges",
    options.spec.task_id,
    `${record.merge_id}.json`,
  );
  await atomicWriteFile(target, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function verifyPostMerge(options: {
  repoRoot: string;
  spec: TaskSpec;
  handoff: TaskHandoff;
  record: MergeRecord;
  run: PostMergeRun;
  paths?: ProjectPaths;
  evidencePath?: string;
}): Promise<PostMergeVerification> {
  const issues: string[] = [];
  const repoRoot = normalizeAbsolute(options.repoRoot);
  if (
    options.record.task_id !== options.spec.task_id ||
    options.record.handoff_head !== options.handoff.head_commit ||
    options.record.base_commit !== options.spec.base_commit
  ) {
    issues.push("merge record does not match the task and handoff");
  }
  if (options.record.diff_sha256 !== options.handoff.diff_sha256) {
    issues.push("merge record diff hash does not match the handoff");
  }
  issues.push(
    ...(await handoffCommitIssues(repoRoot, options.spec, options.handoff)),
  );
  if (options.paths !== undefined) {
    const expected = path.join(
      options.paths.projectDir,
      "merges",
      options.spec.task_id,
      `${options.record.merge_id}.json`,
    );
    try {
      const raw = await fs.readFile(expected, "utf8");
      const stored = JSON.parse(raw) as MergeRecord;
      if (recordHash(stored) !== recordHash(options.record)) {
        issues.push("merge record on disk does not match the supplied record");
      }
    } catch {
      issues.push("merge record is missing or unreadable");
    }
    try {
      await checkEvidence(options.paths, options.handoff, options.evidencePath);
    } catch {
      issues.push("handoff evidence chain cannot be verified");
    }
  }
  try {
    if (
      options.record.tree !==
      (await resolveTree(repoRoot, options.record.merge_commit))
    ) {
      issues.push("merge record tree does not match the merge commit");
    }
  } catch {
    issues.push("merge record commit cannot be inspected");
  }
  if (options.run.verdict.vcs.commit !== options.record.merge_commit) {
    issues.push("post-merge run is on a different commit");
  }
  if (options.run.verdict.run_id !== options.run.runId) {
    issues.push("post-merge verdict run id does not match the run");
  }
  if (options.run.verdict.vcs.tree !== options.record.tree) {
    issues.push("post-merge run tree does not match the merge record");
  }
  if (
    !(await gitSucceeds(repoRoot, [
      "merge-base",
      "--is-ancestor",
      options.handoff.head_commit,
      options.record.merge_commit,
    ]))
  ) {
    issues.push("handoff head is not contained in the merge commit");
  }
  let mergedPaths: string[] = [];
  try {
    mergedPaths = await changedPaths(
      repoRoot,
      options.spec.base_commit,
      options.record.merge_commit,
    );
  } catch {
    issues.push("merged tree cannot be inspected");
  }
  for (const entry of mergedPaths) {
    if (!pathCoveredBySet(entry, options.spec.write_set)) {
      issues.push(`merged path is outside the write set: ${entry}`);
    }
    if (pathIntersectsProtected(entry, options.spec.protected_paths)) {
      issues.push(`merged path is protected: ${entry}`);
    }
  }
  try {
    const evidencePath = options.run.evidencePath;
    const loaded = await readEvidenceFile(evidencePath);
    if (loaded.truncatedTail) {
      issues.push("post-merge evidence is truncated");
    }
    if (
      loaded.records.length === 0 ||
      loaded.records.some((record) => record.run_id !== options.run.runId) ||
      loaded.records.some(
        (record) => record.session_id !== options.run.verdict.session_id,
      ) ||
      evidenceRecordHash(loaded.records.at(-1)!) !==
        options.run.verdict.evidence_head
    ) {
      issues.push("post-merge evidence chain does not match the verdict");
    }
  } catch {
    issues.push("post-merge evidence cannot be read");
  }
  if (issues.length > 0) {
    return { verdict: "unverifiable", issues };
  }
  if (options.run.verdict.verdict === "incomplete") {
    return { verdict: "incomplete", issues: ["post-merge run is incomplete"] };
  }
  if (
    options.run.verdict.verdict !== "complete" ||
    options.run.verdict.sign_off_id === null
  ) {
    return {
      verdict: "unverifiable",
      issues: ["post-merge run lacks a complete human sign-off"],
    };
  }
  return { verdict: "complete", issues: [] };
}
