import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  EvidenceRecord,
  SignOffRequest,
  Verdict,
} from "codepunk-protocol";
import { evidenceRecordHash, readEvidenceFile } from "../evidence/index.ts";
import {
  appendFileSynced,
  atomicWriteFile,
  ensurePrivateDir,
} from "../platform/fs.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import { SessionStore } from "../session/index.ts";
import {
  deriveVerdict,
  prepareSignOff,
  type VerdictDerivation,
} from "./index.ts";

export interface RunOwner {
  sessionId: string;
  evidencePath: string;
}

export interface EvidenceIndexEntry {
  version: 1;
  session_id: string;
  run_id: string;
  seq: number;
  head: string;
  evidence_path: string;
  updated_at: string;
}

export function evidenceRunPath(
  paths: ProjectPaths,
  sessionId: string,
  runId: string,
): string {
  return path.join(paths.evidenceDir, sessionId, `${runId}.jsonl`);
}

export function evidenceIndexPath(
  paths: ProjectPaths,
  sessionId: string,
): string {
  return path.join(paths.evidenceDir, sessionId, "index.jsonl");
}

export async function appendEvidenceIndex(
  paths: ProjectPaths,
  sessionId: string,
  runId: string,
  records: readonly EvidenceRecord[],
): Promise<void> {
  if (records.length === 0) {
    return;
  }
  const entry: EvidenceIndexEntry = {
    version: 1,
    session_id: sessionId,
    run_id: runId,
    seq: records.length,
    head: evidenceRecordHash(records[records.length - 1]!),
    evidence_path: path.relative(
      path.join(paths.evidenceDir, sessionId),
      evidenceRunPath(paths, sessionId, runId),
    ),
    updated_at: new Date().toISOString(),
  };
  const indexPath = evidenceIndexPath(paths, sessionId);
  await ensurePrivateDir(path.dirname(indexPath));
  await appendFileSynced(indexPath, `${JSON.stringify(entry)}\n`);
}

export async function findRunOwner(
  paths: ProjectPaths,
  runId: string,
): Promise<RunOwner[]> {
  const owners: RunOwner[] = [];
  let sessions: string[];
  try {
    sessions = await fs.readdir(paths.evidenceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return owners;
    }
    throw error;
  }
  for (const sessionId of sessions) {
    const sessionDir = path.join(paths.evidenceDir, sessionId);
    let files: string[];
    try {
      files = await fs.readdir(sessionDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl") || file === "index.jsonl") {
        continue;
      }
      const evidencePath = path.join(sessionDir, file);
      try {
        const loaded = await readEvidenceFile(evidencePath);
        if (loaded.records.some((record) => record.run_id === runId)) {
          owners.push({ sessionId, evidencePath });
        }
      } catch {
        // Corrupt evidence is reported when the owning session is selected.
      }
    }
  }
  return owners;
}

export async function writeVerdictArtifact(
  paths: ProjectPaths,
  derivation: VerdictDerivation,
): Promise<string> {
  const target = path.join(
    paths.verdictsDir,
    `${derivation.verdict.run_id}.json`,
  );
  await atomicWriteFile(
    target,
    `${JSON.stringify(derivation.verdict, null, 2)}\n`,
  );
  return target;
}

export interface SignRunResult {
  verdict: Verdict;
  artifactPath: string;
  issues: string[];
}

export async function signRun(options: {
  paths: ProjectPaths;
  cwd: string;
  projectRoot: string;
  runId: string;
  request: Omit<SignOffRequest, "run_id">;
  heartbeatMs?: number;
  leaseMs?: number;
  now?: () => Date;
}): Promise<SignRunResult> {
  const owners = await findRunOwner(options.paths, options.runId);
  if (owners.length !== 1) {
    throw new Error(
      owners.length === 0
        ? "run id does not resolve to an evidence owner"
        : "run id resolves to more than one session",
    );
  }
  const owner = owners[0]!;
  const store = await SessionStore.open({
    rootDir: options.paths.home,
    cwd: options.cwd,
    projectRoot: options.projectRoot,
    projectId: options.paths.projectId,
    sessionId: owner.sessionId,
    ...(options.heartbeatMs !== undefined
      ? { heartbeatMs: options.heartbeatMs }
      : {}),
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const writer = await store.acquireWriter();
  try {
    const loaded = await readEvidenceFile(owner.evidencePath);
    const evidenceHead =
      loaded.records.length === 0
        ? null
        : evidenceRecordHash(loaded.records[loaded.records.length - 1]!);
    const request = {
      ...options.request,
      evidence_head:
        options.request.evidence_head === "" && evidenceHead !== null
          ? evidenceHead
          : options.request.evidence_head,
    };
    const prepared = prepareSignOff({
      runId: options.runId,
      records: loaded.records,
      events: store.allEvents,
      request: {
        ...request,
        run_id: options.runId,
      },
      ...(options.now !== undefined ? { now: options.now() } : {}),
    });
    if (!prepared.ok) {
      throw new Error(`${prepared.code}: ${prepared.message}`);
    }
    await store.append("verdict/sign_off", prepared.prepared.data);
    const derivation = deriveVerdict({
      runId: options.runId,
      sessionId: store.sessionId,
      records: loaded.records,
      events: store.allEvents,
      truncatedTail: loaded.truncatedTail,
      ...(options.now !== undefined ? { now: options.now() } : {}),
    });
    const artifactPath = await writeVerdictArtifact(options.paths, derivation);
    return {
      verdict: derivation.verdict,
      artifactPath,
      issues: derivation.issues,
    };
  } finally {
    await writer.release();
  }
}

export async function deriveAndWriteVerdict(options: {
  paths: ProjectPaths;
  sessionId: string;
  runId: string;
  evidencePath: string;
  events: Parameters<typeof deriveVerdict>[0]["events"];
  now?: Date;
}): Promise<{ path: string; derivation: VerdictDerivation }> {
  const loaded = await readEvidenceFile(options.evidencePath);
  const derivation = deriveVerdict({
    runId: options.runId,
    sessionId: options.sessionId,
    records: loaded.records,
    events: options.events,
    truncatedTail: loaded.truncatedTail,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const artifactPath = await writeVerdictArtifact(options.paths, derivation);
  return { path: artifactPath, derivation };
}
