import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProjectPaths } from "../platform/paths.ts";
import { isInsidePath, normalizeAbsolute } from "../platform/path.ts";
import {
  listSessionIndex,
  readLock,
  staleLockReason,
  type SessionLockRecord,
} from "../session/index.ts";
import { readEvidenceFile } from "../evidence/index.ts";
import type { EvidenceRecord } from "codepunk-protocol";

export interface RetentionConfig {
  sessionDays: number;
  sessionCount: number;
  evidenceDays: number;
  evidenceCount: number;
  logDays: number;
  leaseMs: number;
}

export interface RetentionAction {
  kind: "session" | "evidence" | "artifact" | "log";
  id: string;
  path: string;
  reason: string;
  blocked: string | null;
}

export interface RetentionPlan {
  dryRun: boolean;
  actions: RetentionAction[];
  retainedCounts: {
    sessions: number;
    evidenceRuns: number;
  };
  warnings: string[];
}

interface SessionCandidate {
  id: string;
  dir: string;
  createdAt: number;
  pinned: boolean;
  decisionRef: string | null;
  lock: SessionLockRecord | null;
}

interface EvidenceCandidate {
  sessionId: string;
  runId: string;
  path: string;
  createdAt: number;
  records: EvidenceRecord[];
  signed: boolean;
}

function daysAgo(now: number, days: number): number {
  return now - days * 86_400_000;
}

async function loadSessionCandidates(
  paths: ProjectPaths,
): Promise<SessionCandidate[]> {
  const index = await listSessionIndex(paths.home, paths.projectId);
  const output: SessionCandidate[] = [];
  for (const entry of index) {
    let meta: {
      pinned?: boolean;
      decision_ref?: string | null;
    } = {};
    try {
      meta = JSON.parse(
        await fs.readFile(path.join(entry.path, "session-meta.json"), "utf8"),
      ) as typeof meta;
    } catch {
      // Metadata is recoverable; header time is enough for retention.
    }
    const lock = await readLock(path.join(entry.path, "session.lock")).catch(
      () => null,
    );
    output.push({
      id: entry.sessionId,
      dir: entry.path,
      createdAt: Date.parse(entry.header.created_at),
      pinned: meta.pinned === true,
      decisionRef:
        typeof meta.decision_ref === "string" ? meta.decision_ref : null,
      lock,
    });
  }
  return output.sort((left, right) => left.createdAt - right.createdAt);
}

async function loadEvidenceCandidates(
  paths: ProjectPaths,
): Promise<{ candidates: EvidenceCandidate[]; warnings: string[] }> {
  const warnings: string[] = [];
  const signedRuns = new Set<string>();
  try {
    const sessions = await listSessionIndex(paths.home, paths.projectId);
    for (const session of sessions) {
      try {
        const lines = (
          await fs.readFile(path.join(session.path, "session.jsonl"), "utf8")
        )
          .split("\n")
          .filter((line) => line.length > 0)
          .slice(1);
        for (const line of lines) {
          const event = JSON.parse(line) as {
            kind?: unknown;
            data?: { run_id?: unknown };
          };
          if (
            event.kind === "verdict/sign_off" &&
            typeof event.data?.run_id === "string"
          ) {
            signedRuns.add(event.data.run_id);
          }
        }
      } catch {
        warnings.push(`cannot read session sign-offs for ${session.sessionId}`);
      }
    }
  } catch {
    // No sessions directory is not an error.
  }
  try {
    const verdictFiles = await fs.readdir(paths.verdictsDir);
    for (const file of verdictFiles) {
      if (!file.endsWith(".json")) {
        continue;
      }
      try {
        const parsed = JSON.parse(
          await fs.readFile(path.join(paths.verdictsDir, file), "utf8"),
        ) as Record<string, unknown>;
        if (
          typeof parsed["run_id"] === "string" &&
          (parsed["sign_off_id"] !== null || parsed["signed_verdict"] !== null)
        ) {
          signedRuns.add(parsed["run_id"]);
        }
      } catch {
        warnings.push(`cannot read verdict ${file}`);
      }
    }
  } catch {
    // No verdict directory is not an error.
  }
  const candidates: EvidenceCandidate[] = [];
  let sessions: string[];
  try {
    sessions = await fs.readdir(paths.evidenceDir);
  } catch {
    return { candidates, warnings };
  }
  for (const sessionId of sessions) {
    const sessionDir = path.join(paths.evidenceDir, sessionId);
    let files: string[];
    try {
      files = await fs.readdir(sessionDir);
    } catch {
      warnings.push(`cannot read evidence directory for ${sessionId}`);
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl") || file === "index.jsonl") {
        continue;
      }
      const evidencePath = path.join(sessionDir, file);
      try {
        const loaded = await readEvidenceFile(evidencePath);
        const runId = loaded.records[0]?.run_id ?? file.slice(0, -6);
        const createdAt =
          loaded.records.length === 0
            ? (await fs.stat(evidencePath)).mtimeMs
            : Date.parse(loaded.records[0]!.created_at);
        candidates.push({
          sessionId,
          runId,
          path: evidencePath,
          createdAt,
          records: loaded.records,
          signed: signedRuns.has(runId),
        });
      } catch (error) {
        warnings.push(
          `cannot read evidence ${sessionId}/${file}: ${(error as Error).message}`,
        );
      }
    }
  }
  return {
    candidates: candidates.sort(
      (left, right) => left.createdAt - right.createdAt,
    ),
    warnings,
  };
}

async function safeRemove(candidate: string, root: string): Promise<void> {
  const normalized = normalizeAbsolute(candidate);
  if (
    !isInsidePath(root, normalized) ||
    normalized === normalizeAbsolute(root)
  ) {
    throw new Error("refusing to remove a path outside the retention root");
  }
  await fs.rm(normalized, { recursive: true, force: false });
}

function referencedArtifacts(
  candidates: readonly EvidenceCandidate[],
  paths: ProjectPaths,
): Set<string> {
  const referenced = new Set<string>();
  for (const candidate of candidates) {
    for (const record of candidate.records) {
      if (record.output_ref === null) {
        continue;
      }
      const target = path.isAbsolute(record.output_ref)
        ? record.output_ref
        : record.output_ref.startsWith("artifacts/")
          ? path.resolve(paths.projectDir, record.output_ref)
          : path.resolve(paths.artifactsDir, record.output_ref);
      if (isInsidePath(paths.artifactsDir, target)) {
        referenced.add(normalizeAbsolute(target));
      }
    }
  }
  return referenced;
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(candidate);
      } else if (entry.isFile()) {
        output.push(candidate);
      }
    }
  }
  await walk(root);
  return output;
}

export async function planRetention(
  paths: ProjectPaths,
  config: RetentionConfig,
  options: { dryRun?: boolean; now?: Date } = {},
): Promise<RetentionPlan> {
  const dryRun = options.dryRun ?? true;
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const actions: RetentionAction[] = [];
  const warnings: string[] = [];
  const sessions = await loadSessionCandidates(paths);
  const sessionCutoff = daysAgo(nowMs, config.sessionDays);
  const protectedSessionIndexes = new Set<number>();
  sessions.forEach((session, index) => {
    if (session.pinned || session.decisionRef !== null) {
      protectedSessionIndexes.add(index);
    }
  });
  const countCandidates = sessions
    .map((session, index) => ({ session, index }))
    .filter(({ index }) => !protectedSessionIndexes.has(index))
    .slice(0, Math.max(0, sessions.length - config.sessionCount));
  const sessionCandidates = new Map<number, string>();
  for (const item of countCandidates) {
    sessionCandidates.set(item.index, "retention_count");
  }
  sessions.forEach((session, index) => {
    if (
      !protectedSessionIndexes.has(index) &&
      Number.isFinite(session.createdAt) &&
      session.createdAt < sessionCutoff
    ) {
      sessionCandidates.set(index, "retention_days");
    }
  });
  for (const [index, reason] of sessionCandidates) {
    const session = sessions[index]!;
    let blocked: string | null = null;
    if (session.lock !== null) {
      blocked = staleLockReason(session.lock, now, config.leaseMs);
    }
    actions.push({
      kind: "session",
      id: session.id,
      path: session.dir,
      reason,
      blocked,
    });
  }

  const evidenceLoaded = await loadEvidenceCandidates(paths);
  warnings.push(...evidenceLoaded.warnings);
  const evidence = evidenceLoaded.candidates;
  const evidenceCutoff = daysAgo(nowMs, config.evidenceDays);
  const protectedEvidence = new Set<number>();
  evidence.forEach((run, index) => {
    if (run.signed) {
      protectedEvidence.add(index);
    }
  });
  const evidenceCandidates = new Set<number>();
  evidence
    .map((run, index) => ({ run, index }))
    .filter(({ index }) => !protectedEvidence.has(index))
    .slice(0, Math.max(0, evidence.length - config.evidenceCount))
    .forEach(({ index }) => evidenceCandidates.add(index));
  evidence.forEach((run, index) => {
    if (
      !protectedEvidence.has(index) &&
      Number.isFinite(run.createdAt) &&
      run.createdAt < evidenceCutoff
    ) {
      evidenceCandidates.add(index);
    }
  });
  const removedEvidence = [...evidenceCandidates].map(
    (index) => evidence[index]!,
  );
  const remainingEvidence = evidence.filter(
    (_run, index) => !evidenceCandidates.has(index),
  );
  for (const run of removedEvidence) {
    actions.push({
      kind: "evidence",
      id: run.runId,
      path: run.path,
      reason: "retention",
      blocked: null,
    });
  }
  const protectedArtifacts = referencedArtifacts(remainingEvidence, paths);
  const expiredArtifacts = referencedArtifacts(removedEvidence, paths);
  const artifactFiles = await listFilesRecursive(paths.artifactsDir);
  const artifactCutoff = daysAgo(nowMs, config.evidenceDays);
  for (const artifact of artifactFiles) {
    const normalized = normalizeAbsolute(artifact);
    if (protectedArtifacts.has(normalized)) {
      continue;
    }
    const stat = await fs.stat(artifact);
    const expiredWithEvidence = expiredArtifacts.has(normalized);
    if (expiredWithEvidence || stat.mtimeMs < artifactCutoff) {
      actions.push({
        kind: "artifact",
        id: path.relative(paths.artifactsDir, artifact),
        path: artifact,
        reason: expiredWithEvidence ? "evidence_expired" : "retention",
        blocked: null,
      });
    }
  }
  const logsDir = path.join(paths.home, "logs");
  for (const log of await listFilesRecursive(logsDir)) {
    const stat = await fs.stat(log);
    if (stat.mtimeMs < daysAgo(nowMs, config.logDays)) {
      actions.push({
        kind: "log",
        id: path.relative(logsDir, log),
        path: log,
        reason: "retention",
        blocked: null,
      });
    }
  }

  if (!dryRun) {
    for (const action of actions) {
      if (action.blocked !== null) {
        continue;
      }
      const root =
        action.kind === "session"
          ? paths.sessionsDir
          : action.kind === "evidence"
            ? paths.evidenceDir
            : action.kind === "artifact"
              ? paths.artifactsDir
              : path.join(paths.home, "logs");
      if (action.kind === "session" && action.blocked === null) {
        const lockPath = path.join(action.path, "session.lock");
        const lock = await readLock(lockPath).catch(() => null);
        if (lock !== null) {
          const reason = staleLockReason(lock, now, config.leaseMs);
          if (reason !== null) {
            action.blocked = reason;
            continue;
          }
          await fs.unlink(lockPath);
        }
      }
      await safeRemove(action.path, root);
    }
  }

  return {
    dryRun,
    actions,
    retainedCounts: {
      sessions:
        sessions.length - actions.filter((a) => a.kind === "session").length,
      evidenceRuns:
        evidence.length - actions.filter((a) => a.kind === "evidence").length,
    },
    warnings,
  };
}
