import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import { chainRecords, readRecord } from "./support/fixtures.mjs";
import {
  makeProject,
  withTempDirectory,
  writeFile,
} from "./support/helpers.mjs";

const core = await importCore();

async function createSession(paths, createdAt, heartbeatMs = 60_000) {
  return core.SessionStore.create({
    rootDir: paths.home,
    cwd: paths.cwd,
    projectRoot: paths.deliveryRoot,
    projectId: paths.projectId,
    now: () => new Date(createdAt),
    heartbeatMs,
    leaseMs: 30_000,
  });
}

test("dry-run honors day and count boundaries and pin protection", async () => {
  await withTempDirectory("codepunk-retention-", async (root) => {
    const { paths } = await makeProject(root);
    const sessions = [];
    for (const createdAt of [
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    ]) {
      sessions.push(await createSession(paths, createdAt));
    }
    await core.pinSession({
      rootDir: paths.home,
      cwd: paths.cwd,
      projectRoot: paths.deliveryRoot,
      projectId: paths.projectId,
      sessionId: sessions[0].sessionId,
    });
    const plan = await core.planRetention(
      paths,
      {
        sessionDays: 90,
        sessionCount: 2,
        evidenceDays: 180,
        evidenceCount: 500,
        logDays: 14,
        leaseMs: 30_000,
      },
      { dryRun: true, now: new Date("2026-11-12T00:00:00.000Z") },
    );
    const removed = plan.actions
      .filter((action) => action.kind === "session")
      .map((action) => action.id);
    assert.deepEqual(removed.sort(), [
      sessions[1].sessionId,
      sessions[2].sessionId,
    ]);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.retainedCounts.sessions, 2);
  });
});

test("live locks block deletion and stale locks do not", async () => {
  await withTempDirectory("codepunk-retention-", async (root) => {
    const { paths } = await makeProject(root);
    const live = await createSession(paths, "2026-01-01T00:00:00.000Z");
    const stale = await createSession(paths, "2026-01-02T00:00:00.000Z");
    const liveWriter = await live.acquireWriter();
    await writeFile(
      stale.paths.lockPath,
      `${JSON.stringify({
        pid: 999_999,
        host: os.hostname(),
        started_at: "2026-01-02T00:00:00.000Z",
        heartbeat_at: "2026-01-02T00:00:00.000Z",
        nonce: "stale-lock",
      })}\n`,
    );
    const plan = await core.planRetention(
      paths,
      {
        sessionDays: 30,
        sessionCount: 100,
        evidenceDays: 180,
        evidenceCount: 500,
        logDays: 14,
        leaseMs: 30_000,
      },
      { dryRun: true, now: new Date("2026-11-12T00:00:00.000Z") },
    );
    const byId = new Map(
      plan.actions
        .filter((action) => action.kind === "session")
        .map((action) => [action.id, action]),
    );
    assert.match(
      byId.get(live.sessionId).blocked,
      /lease is still active|owner process is still alive/u,
    );
    assert.equal(byId.get(stale.sessionId).blocked, null);
    await liveWriter.release();
  });
});

test("signed evidence and referenced artifacts survive", async () => {
  await withTempDirectory("codepunk-retention-", async (root) => {
    const { paths } = await makeProject(root);
    const session = await createSession(paths, "2026-01-01T00:00:00.000Z");
    const artifact = path.join(
      paths.artifactsDir,
      session.sessionId,
      "referenced.txt",
    );
    await writeFile(artifact, "kept by evidence\n");
    const old = new Date("2026-01-01T00:00:00.000Z");
    await fs.utimes(artifact, old, old);
    const writer = await session.acquireWriter();
    const ledger = await core.EvidenceLedger.open(
      path.join(paths.evidenceDir, session.sessionId, "run-keep.jsonl"),
    );
    const record = await ledger.append({
      ...readRecord({
        session_id: session.sessionId,
        run_id: "run-keep",
        output_ref: `artifacts/${session.sessionId}/referenced.txt`,
      }),
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await session.append("verdict/sign_off", {
      sign_off_id: "sign-keep",
      previous_sign_off_id: null,
      run_id: "run-keep",
      evidence_head: core.evidenceRecordHash(record),
      signed_verdict: "complete",
      channel: "cli",
      actor: "local-user",
      signed_at: "2026-01-01T00:00:00.000Z",
    });
    await writer.release();
    const plan = await core.planRetention(
      paths,
      {
        sessionDays: 3650,
        sessionCount: 100,
        evidenceDays: 30,
        evidenceCount: 0,
        logDays: 14,
        leaseMs: 30_000,
      },
      { dryRun: true, now: new Date("2026-11-12T00:00:00.000Z") },
    );
    assert.equal(
      plan.actions.some(
        (action) => action.kind === "evidence" && action.id === "run-keep",
      ),
      false,
    );
    assert.equal(
      plan.actions.some(
        (action) =>
          action.kind === "artifact" &&
          path.basename(action.path) === "referenced.txt",
      ),
      false,
    );
  });
});

test("expired evidence removes its artifacts even when fresh", async () => {
  await withTempDirectory("codepunk-retention-", async (root) => {
    const { paths } = await makeProject(root);
    const session = await createSession(paths, "2026-01-01T00:00:00.000Z");
    const artifact = path.join(
      paths.artifactsDir,
      session.sessionId,
      "expired.txt",
    );
    await writeFile(artifact, "expires with evidence\n");
    const writer = await session.acquireWriter();
    const ledger = await core.EvidenceLedger.open(
      path.join(paths.evidenceDir, session.sessionId, "run-expired.jsonl"),
    );
    await ledger.append({
      ...readRecord({
        session_id: session.sessionId,
        run_id: "run-expired",
        output_ref: `artifacts/${session.sessionId}/expired.txt`,
      }),
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await writer.release();

    const plan = await core.planRetention(
      paths,
      {
        sessionDays: 3650,
        sessionCount: 100,
        evidenceDays: 30,
        evidenceCount: 0,
        logDays: 14,
        leaseMs: 30_000,
      },
      { dryRun: false, now: new Date("2026-11-12T00:00:00.000Z") },
    );
    assert.ok(
      plan.actions.some(
        (action) => action.kind === "evidence" && action.id === "run-expired",
      ),
    );
    const artifactAction = plan.actions.find(
      (action) =>
        action.kind === "artifact" &&
        path.basename(action.path) === "expired.txt",
    );
    assert.ok(artifactAction);
    assert.equal(artifactAction.reason, "evidence_expired");
    assert.equal(
      await fs
        .access(
          path.join(paths.evidenceDir, session.sessionId, "run-expired.jsonl"),
        )
        .then(() => true)
        .catch(() => false),
      false,
    );
    assert.equal(
      await fs
        .access(artifact)
        .then(() => true)
        .catch(() => false),
      false,
    );
  });
});

test("evidence count keeps 500 runs and prunes the oldest at 501", async () => {
  await withTempDirectory("codepunk-retention-count-", async (root) => {
    const { paths } = await makeProject(root);
    const sessionId = "session-count";
    const writeRun = async (index) => {
      const runId = `run-${String(index).padStart(3, "0")}`;
      const [record] = chainRecords([
        readRecord({
          id: `ev-${index}`,
          run_id: runId,
          session_id: sessionId,
          created_at: new Date(
            Date.UTC(2026, 0, 1) + index * 1_000,
          ).toISOString(),
        }),
      ]);
      await writeFile(
        path.join(paths.evidenceDir, sessionId, `${runId}.jsonl`),
        `${JSON.stringify(record)}\n`,
      );
    };
    for (let index = 0; index < 500; index += 1) {
      await writeRun(index);
    }
    const config = {
      sessionDays: 3650,
      sessionCount: 100,
      evidenceDays: 3650,
      evidenceCount: 500,
      logDays: 3650,
      leaseMs: 30_000,
    };
    const atBoundary = await core.planRetention(paths, config, {
      dryRun: true,
      now: new Date("2026-11-12T00:00:00.000Z"),
    });
    assert.equal(
      atBoundary.actions.some((action) => action.kind === "evidence"),
      false,
    );
    assert.equal(atBoundary.retainedCounts.evidenceRuns, 500);

    await writeRun(500);
    const overBoundary = await core.planRetention(paths, config, {
      dryRun: true,
      now: new Date("2026-11-12T00:00:00.000Z"),
    });
    const removed = overBoundary.actions.filter(
      (action) => action.kind === "evidence",
    );
    assert.deepEqual(
      removed.map((action) => action.id),
      ["run-000"],
    );
    assert.equal(overBoundary.retainedCounts.evidenceRuns, 500);
  });
});
