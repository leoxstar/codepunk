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

test("gc plans before deleting and preserves protected state", async () => {
  await withTempDirectory("codepunk-gc-", async (root) => {
    const { paths } = await makeProject(root);
    const artifact = path.join(paths.artifactsDir, "old.txt");
    await writeFile(artifact, "artifact bytes");
    const artifactRelative = path
      .relative(paths.home, artifact)
      .split(path.sep)
      .join("/");
    const old = new Date("2026-01-01T00:00:00.000Z");
    await fs.utimes(artifact, old, old);
    const sessionFile = path.join(paths.sessionsDir, "session.jsonl");
    const evidenceFile = path.join(paths.evidenceDir, "run.jsonl");
    const verdictFile = path.join(paths.verdictsDir, "run.json");
    const checkpointFile = path.join(paths.sessionsDir, "checkpoints.json");
    await writeFile(sessionFile, "session\n");
    await writeFile(evidenceFile, "evidence\n");
    await writeFile(verdictFile, "verdict\n");
    await writeFile(checkpointFile, "checkpoint\n");

    const before = await fs.readFile(artifact);
    const dry = await core.applyGc(paths.home, {
      dryRun: true,
      now: new Date("2026-11-18T00:00:00.000Z"),
    });
    assert.equal(dry.dry_run, true);
    assert.deepEqual(
      dry.candidates.map((candidate) => candidate.path),
      [artifactRelative],
    );
    assert.deepEqual(await fs.readFile(artifact), before);

    const applied = await core.applyGc(paths.home, {
      dryRun: false,
      now: new Date("2026-11-18T00:00:00.000Z"),
    });
    assert.equal(applied.dry_run, false);
    await assert.rejects(fs.readFile(artifact), { code: "ENOENT" });
    for (const protectedPath of [
      sessionFile,
      evidenceFile,
      verdictFile,
      checkpointFile,
    ]) {
      assert.ok((await fs.readFile(protectedPath, "utf8")).length > 0);
    }
    assert.ok(applied.backup_id !== null);
    await core.restoreBackup(paths.home, applied.backup_id);
    assert.deepEqual(await fs.readFile(artifact), before);

    const operations = await core.readRetentionOperations(paths.home);
    assert.ok(operations.some((operation) => operation.action === "gc"));
    assert.ok(
      operations.every((operation, index) => operation.seq === index + 1),
    );

    await writeFile(artifact, "artifact bytes");
    await fs.utimes(artifact, old, old);
    await fs.rename(
      path.join(paths.home, "backups"),
      path.join(paths.home, "backups-saved"),
    );
    await writeFile(path.join(paths.home, "backups"), "not a directory");
    await assert.rejects(
      core.applyGc(paths.home, {
        dryRun: false,
        now: new Date("2026-11-18T00:00:00.000Z"),
      }),
    );
    assert.deepEqual(await fs.readFile(artifact), before);
  });
});

test("gc skips project artifacts while a session writer is live", async () => {
  await withTempDirectory("codepunk-gc-writer-", async (root) => {
    const { paths } = await makeProject(root);
    const artifact = path.join(paths.artifactsDir, "old.txt");
    await writeFile(artifact, "artifact bytes");
    const old = new Date("2026-01-01T00:00:00.000Z");
    await fs.utimes(artifact, old, old);
    const session = await createSession(paths, new Date().toISOString());
    const writer = await session.acquireWriter();
    try {
      const blocked = await core.applyGc(paths.home, {
        dryRun: false,
        now: new Date(),
      });
      assert.deepEqual(blocked.deleted, []);
      assert.equal(blocked.backup_id, null);
      assert.equal(blocked.skipped.length, 1);
      assert.match(
        blocked.skipped[0].reason,
        /^active_writer_project:0123456789abcdef$/u,
      );
      assert.equal(await fs.readFile(artifact, "utf8"), "artifact bytes");
      const operations = await core.readRetentionOperations(paths.home);
      assert.equal(operations.at(-1).exit_code, 1);
      assert.match(operations.at(-1).failure, /skipped 1 candidate/u);
    } finally {
      await writer.release();
    }

    const applied = await core.applyGc(paths.home, {
      dryRun: false,
      now: new Date(),
    });
    assert.deepEqual(applied.skipped, []);
    assert.deepEqual(applied.deleted, [
      path.relative(paths.home, artifact).split(path.sep).join("/"),
    ]);
    await assert.rejects(fs.readFile(artifact), { code: "ENOENT" });
  });
});

test("gc ignores a stale session lock", async () => {
  await withTempDirectory("codepunk-gc-stale-lock-", async (root) => {
    const { paths } = await makeProject(root);
    const artifact = path.join(paths.artifactsDir, "old.txt");
    await writeFile(artifact, "artifact bytes");
    const old = new Date("2026-01-01T00:00:00.000Z");
    await fs.utimes(artifact, old, old);
    const session = await createSession(paths, "2026-01-01T00:00:00.000Z");
    await writeFile(
      session.paths.lockPath,
      `${JSON.stringify({
        pid: 999_999,
        host: os.hostname(),
        started_at: "2026-01-01T00:00:00.000Z",
        heartbeat_at: "2026-01-01T00:00:00.000Z",
        nonce: "stale-lock",
      })}\n`,
    );

    const applied = await core.applyGc(paths.home, {
      dryRun: false,
      now: new Date("2026-11-18T00:00:00.000Z"),
    });
    assert.deepEqual(applied.skipped, []);
    assert.deepEqual(applied.deleted, [
      path.relative(paths.home, artifact).split(path.sep).join("/"),
    ]);
    await assert.rejects(fs.readFile(artifact), { code: "ENOENT" });
  });
});

test("backup and restore refuse while a session writer is live", async () => {
  await withTempDirectory("codepunk-backup-writer-", async (root) => {
    const { paths } = await makeProject(root);
    const artifact = path.join(paths.artifactsDir, "file.txt");
    await writeFile(artifact, "original");
    const relative = path
      .relative(paths.home, artifact)
      .split(path.sep)
      .join("/");
    const backup = await core.createBackup(paths.home, {
      files: [relative],
    });
    await writeFile(artifact, "changed");
    const session = await createSession(paths, new Date().toISOString());
    const writer = await session.acquireWriter();
    try {
      await assert.rejects(
        core.createBackup(paths.home, {}),
        (error) => error.code === "retention.active_writer",
      );
      await assert.rejects(
        core.restoreBackup(paths.home, backup.id),
        (error) => error.code === "retention.active_writer",
      );
      assert.equal(await fs.readFile(artifact, "utf8"), "changed");
    } finally {
      await writer.release();
    }
    await core.restoreBackup(paths.home, backup.id);
    assert.equal(await fs.readFile(artifact, "utf8"), "original");
  });
});

test("restore rejects a corrupted backup before touching targets", async () => {
  await withTempDirectory("codepunk-restore-corrupt-", async (root) => {
    const { paths } = await makeProject(root);
    const target = path.join(paths.artifactsDir, "file.txt");
    await writeFile(target, "original");
    const relative = path
      .relative(paths.home, target)
      .split(path.sep)
      .join("/");
    const backup = await core.createBackup(paths.home, {
      files: [relative],
    });
    const backupFile = path.join(
      paths.home,
      "backups",
      backup.id,
      "files",
      ...relative.split("/"),
    );
    await writeFile(backupFile, "tampered");
    await assert.rejects(
      core.restoreBackup(paths.home, backup.id),
      (error) => error.code === "retention.backup_corrupt",
    );
    assert.equal(await fs.readFile(target, "utf8"), "original");
  });
});

test("restore rolls back a mid-write failure", async () => {
  await withTempDirectory("codepunk-restore-rollback-", async (root) => {
    const { paths } = await makeProject(root);
    const first = path.join(paths.artifactsDir, "one.txt");
    const second = path.join(paths.artifactsDir, "two.txt");
    await writeFile(first, "backup one");
    await writeFile(second, "backup two");
    const relative = [first, second].map((file) =>
      path.relative(paths.home, file).split(path.sep).join("/"),
    );
    const backup = await core.createBackup(paths.home, {
      files: relative,
    });
    await writeFile(first, "current one");
    await writeFile(second, "current two");
    await assert.rejects(
      core.restoreBackup(paths.home, backup.id, { failAfterWrites: 1 }),
      (error) => error.code === "retention.restore_failed",
    );
    assert.equal(await fs.readFile(first, "utf8"), "current one");
    assert.equal(await fs.readFile(second, "utf8"), "current two");
  });
});

test("migrate backs up and restores on failure", async () => {
  await withTempDirectory("codepunk-migrate-", async (root) => {
    const { paths } = await makeProject(root);
    const artifact = path.join(paths.artifactsDir, "file.txt");
    await writeFile(artifact, "bytes");
    const check = await core.checkMigration(paths.home);
    assert.equal(check.required, true);
    await assert.rejects(
      core.applyMigration(paths.home, { failAfterWrites: 0 }),
      (error) => error.code === "retention.migration_failed",
    );
    assert.equal(await fs.readFile(artifact, "utf8"), "bytes");
    const after = await core.checkMigration(paths.home);
    assert.equal(after.required, true);
    const applied = await core.applyMigration(paths.home);
    assert.ok(applied.backup_id !== null);
    const migrated = await core.checkMigration(paths.home);
    assert.equal(migrated.required, false);
    assert.equal(migrated.current, core.STATE_VERSION);
  });
});

test("fresh homes are current and legacy homes still require migration", async () => {
  await withTempDirectory("codepunk-state-version-", async (root) => {
    const missingHome = path.join(root, "missing-home");
    const missingCheck = await core.checkMigration(missingHome);
    assert.deepEqual(missingCheck, {
      current: core.STATE_VERSION,
      target: core.STATE_VERSION,
      required: false,
    });
    await assert.rejects(fs.access(missingHome), { code: "ENOENT" });

    const emptyHome = path.join(root, "empty-home");
    await fs.mkdir(emptyHome);
    const emptyCheck = await core.checkMigration(emptyHome);
    assert.deepEqual(emptyCheck, {
      current: core.STATE_VERSION,
      target: core.STATE_VERSION,
      required: false,
    });

    const legacyHome = path.join(root, "legacy-home");
    await fs.mkdir(path.join(legacyHome, "projects"), { recursive: true });
    const legacyCheck = await core.checkMigration(legacyHome);
    assert.deepEqual(legacyCheck, {
      current: 0,
      target: core.STATE_VERSION,
      required: true,
    });
  });
});

test("newer state-version refuses maintenance but keeps sessions readable (spec 0016 C2)", async () => {
  await withTempDirectory("codepunk-state-version-", async (root) => {
    const { paths } = await makeProject(root);
    const store = await createSession(paths, "2026-11-01T00:00:00.000Z");
    const statePath = path.join(paths.home, "state-version.json");
    await core.initializeStateVersion(paths.home);

    const relative = path
      .relative(paths.home, path.join(paths.artifactsDir, "file.txt"))
      .split(path.sep)
      .join("/");
    await writeFile(path.join(paths.artifactsDir, "file.txt"), "original");
    const backup = await core.createBackup(paths.home, { files: [relative] });

    const original = `${JSON.stringify({ version: core.STATE_VERSION + 1 }, null, 2)}\n`;
    await fs.writeFile(statePath, original, "utf8");

    const info = await core.readStateVersionInfo(paths.home);
    assert.deepEqual(info, {
      current: core.STATE_VERSION + 1,
      supported: core.STATE_VERSION,
      newer: true,
    });
    await assert.rejects(
      () => core.assertSupportedStateVersion(paths.home),
      (error) =>
        error.name === "NewerStateVersionError" &&
        error.saved === core.STATE_VERSION + 1 &&
        error.supported === core.STATE_VERSION &&
        new RegExp(
          `state version ${core.STATE_VERSION + 1} is newer than supported ${core.STATE_VERSION}`,
          "u",
        ).test(error.message) &&
        /upgrade codepunk/u.test(error.message),
    );

    // gc: dry-run stays readable, --apply refuses.
    const dryRun = await core.applyGc(paths.home, {
      dryRun: true,
      now: new Date("2026-11-20T00:00:00.000Z"),
    });
    assert.equal(dryRun.dry_run, true);
    await assert.rejects(
      () =>
        core.applyGc(paths.home, {
          dryRun: false,
          now: new Date("2026-11-20T00:00:00.000Z"),
        }),
      (error) => error.name === "NewerStateVersionError",
    );

    // migrate --apply refuses.
    await assert.rejects(
      () => core.applyMigration(paths.home),
      (error) => error.name === "NewerStateVersionError",
    );

    // backup restore refuses.
    await assert.rejects(
      () => core.restoreBackup(paths.home, backup.id),
      (error) => error.name === "NewerStateVersionError",
    );

    // sessions delete refuses.
    await assert.rejects(
      () =>
        core.deleteSession({
          rootDir: paths.home,
          cwd: paths.cwd,
          projectRoot: paths.deliveryRoot,
          projectId: paths.projectId,
          sessionId: store.sessionId,
          confirmed: true,
        }),
      (error) => error.name === "NewerStateVersionError",
    );

    // Nothing was written: state-version.json is byte-identical, the artifact
    // and the session are intact and still readable.
    assert.equal(await fs.readFile(statePath, "utf8"), original);
    assert.equal(
      await fs.readFile(path.join(paths.artifactsDir, "file.txt"), "utf8"),
      "original",
    );
    const sessions = await core.listProjectSessions(
      paths.home,
      paths.projectId,
    );
    assert.equal(sessions.length, 1);
    const reopened = await core.SessionStore.open({
      rootDir: paths.home,
      cwd: paths.cwd,
      projectRoot: paths.deliveryRoot,
      projectId: paths.projectId,
      sessionId: store.sessionId,
    });
    assert.equal(reopened.sessionId, store.sessionId);
  });
});
