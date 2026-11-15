import path from "node:path";
import type { TaskHandoff, TaskSpec, Verdict } from "@codepunk/protocol";
import { EvidenceError, readEvidenceFile } from "../evidence/index.ts";
import { atomicWriteFile } from "../platform/fs.ts";
import { sha256Bytes } from "../platform/hash.ts";
import { normalizeAbsolute } from "../platform/path.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import {
  gitBuffer,
  gitText,
  nulPaths,
  resolveCommit,
  resolveTree,
  statusOutsideCodepunk,
} from "./git.ts";

export interface CreateHandoffOptions {
  spec: TaskSpec;
  worktree: string;
  workerId: string;
  runId: string;
  evidencePath: string;
  verdict: {
    verdict: Verdict["verdict"];
    sign_off_id: string | null;
    evidence_head: string;
  };
  claim?: TaskHandoff["claim"];
  openIssues?: readonly string[];
  now?: () => Date;
}

function requireCommit(value: string, label: string): string {
  if (!/^[0-9a-f]{40,64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase Git commit id`);
  }
  return value;
}

async function cleanWorktree(worktree: string): Promise<void> {
  const status = await gitText(worktree, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (statusOutsideCodepunk(status).trim().length > 0) {
    throw new Error("handoff requires a clean worker worktree");
  }
}

export async function treeFileHash(
  worktree: string,
  commit: string,
  filePath: string,
): Promise<string | null> {
  const output = await gitText(worktree, [
    "ls-tree",
    "-z",
    "--full-tree",
    commit,
    "--",
    filePath,
  ]);
  const entry = output.split("\0").find((candidate) => candidate.length > 0);
  if (entry === undefined) {
    return null;
  }
  const tab = entry.indexOf("\t");
  if (tab < 0) {
    throw new Error(`cannot parse Git tree entry for ${filePath}`);
  }
  const header = entry.slice(0, tab).split(" ");
  const oid = header[2];
  if (oid === undefined || !/^[0-9a-f]+$/u.test(oid)) {
    throw new Error(`invalid Git tree object for ${filePath}`);
  }
  return sha256Bytes(await gitBuffer(worktree, ["cat-file", "blob", oid]));
}

async function changedPaths(
  worktree: string,
  baseCommit: string,
  headCommit: string,
): Promise<string[]> {
  const output = await gitText(worktree, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    baseCommit,
    headCommit,
  ]);
  return nulPaths(output).sort((left, right) => left.localeCompare(right));
}

export async function createHandoff(
  options: CreateHandoffOptions,
): Promise<TaskHandoff> {
  const worktree = normalizeAbsolute(options.worktree);
  const baseCommit = requireCommit(options.spec.base_commit, "task base");
  const headCommit = requireCommit(
    await resolveCommit(worktree, "HEAD"),
    "handoff head",
  );
  if (
    !(await gitText(worktree, [
      "merge-base",
      "--is-ancestor",
      baseCommit,
      headCommit,
    ]).then(
      () => true,
      () => false,
    ))
  ) {
    throw new Error("handoff head does not descend from the task base");
  }
  await cleanWorktree(worktree);
  const tree = await resolveTree(worktree, headCommit);
  const paths = await changedPaths(worktree, baseCommit, headCommit);
  if (paths.length === 0) {
    throw new Error("handoff contains no changed files");
  }
  const files = [];
  for (const filePath of paths) {
    files.push({
      path: filePath,
      before_sha256: await treeFileHash(worktree, baseCommit, filePath),
      after_sha256: await treeFileHash(worktree, headCommit, filePath),
    });
  }
  const diff = await gitBuffer(worktree, [
    "diff",
    "--binary",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    baseCommit,
    headCommit,
  ]);
  const evidence = await readEvidenceFile(options.evidencePath).catch(
    (error: unknown) => {
      if (error instanceof EvidenceError) {
        throw new Error(`handoff evidence is invalid: ${error.message}`);
      }
      throw error;
    },
  );
  if (evidence.truncatedTail) {
    throw new Error("handoff evidence has a truncated tail");
  }
  if (evidence.records.length === 0) {
    throw new Error("handoff requires evidence");
  }
  if (evidence.records.some((record) => record.run_id !== options.runId)) {
    throw new Error("handoff evidence contains records from another run");
  }
  const first = evidence.records[0]!;
  const last = evidence.records[evidence.records.length - 1]!;
  if (last.seq !== first.seq + evidence.records.length - 1) {
    throw new Error("handoff evidence sequence is not contiguous");
  }
  if (
    options.verdict.verdict === "complete" &&
    options.verdict.sign_off_id === null
  ) {
    throw new Error("complete handoff verdict requires a human sign-off");
  }
  if (options.verdict.evidence_head !== evidence.head) {
    throw new Error("handoff verdict evidence head does not match the chain");
  }
  if (first.session_id !== last.session_id) {
    throw new Error("handoff evidence spans multiple sessions");
  }
  const evidenceHead = evidence.head;
  if (evidenceHead === null) {
    throw new Error("handoff evidence head is missing");
  }
  const now = (options.now ?? (() => new Date()))().toISOString();
  return {
    version: 1,
    task_id: options.spec.task_id,
    spec_sha256: options.spec.spec_sha256,
    run_id: options.runId,
    worker_id: options.workerId,
    base_commit: baseCommit,
    head_commit: headCommit,
    tree,
    diff_sha256: sha256Bytes(diff),
    changed_paths: paths,
    files,
    write_set: [...options.spec.write_set],
    protected_paths: [...options.spec.protected_paths],
    evidence: {
      session_id: first.session_id,
      first_seq: first.seq,
      last_seq: last.seq,
      head_sha256: evidenceHead,
    },
    claim: options.claim ?? {
      claim_id: null,
      fence: null,
      lease: null,
      acquired_at: null,
    },
    verdict: {
      value: options.verdict.verdict,
      sign_off_id: options.verdict.sign_off_id,
      evidence_head: options.verdict.evidence_head,
    },
    open_issues: [...(options.openIssues ?? [])],
    created_at: now,
  };
}

export function handoffArtifactPath(
  paths: ProjectPaths,
  handoff: Pick<TaskHandoff, "task_id" | "run_id">,
): string {
  return path.join(
    paths.projectDir,
    "handoffs",
    handoff.task_id,
    `${handoff.run_id}.json`,
  );
}

/**
 * Persist the exact handoff object that merge verification will re-check.
 * The merge record is the transaction; this artifact is the review evidence
 * that human sign-off and the worker commit existed before the merge.
 */
export async function writeHandoff(
  paths: ProjectPaths,
  handoff: TaskHandoff,
): Promise<string> {
  const target = handoffArtifactPath(paths, handoff);
  await atomicWriteFile(target, `${JSON.stringify(handoff, null, 2)}\n`);
  return target;
}
