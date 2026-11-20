import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore, importSource } from "./support/core.mjs";
import { fixedClock, withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();
const hash = await importSource("packages/core/src/platform/hash.ts");

async function createSession(rootDir, projectId, sessionId = "session-alpha") {
  const store = await core.SessionStore.create({
    rootDir,
    cwd: "/workspace",
    projectRoot: "/workspace",
    projectId,
    sessionId,
    now: fixedClock(),
    heartbeatMs: 60_000,
  });
  const writer = await store.acquireWriter();
  try {
    await store.append("user/input", {
      run_id: "run-1",
      text: "hello",
    });
    await store.saveAgentState(
      {
        type: "session",
        id: "pi-session",
        cwd: "/workspace",
        timestamp: "2026-11-12T00:00:00.000Z",
      },
      [
        {
          id: "entry-1",
          parentId: null,
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
        },
      ],
    );
  } finally {
    await writer.release();
  }
  return store;
}

function resolveOptions(rootDir, projectId, sessionId) {
  return {
    rootDir,
    cwd: "/workspace",
    projectRoot: "/workspace",
    projectId,
    sessionId,
  };
}

function rewriteBundleLog(bundle, mutate) {
  const lines = bundle.log.trimEnd().split("\n");
  const header = JSON.parse(lines[0]);
  mutate(header);
  const log = `${[JSON.stringify(header), ...lines.slice(1)].join("\n")}\n`;
  return { ...bundle, log, log_sha256: hash.sha256Text(log) };
}

test("session bundles round-trip through import with verified hashes", async () => {
  await withTempDirectory("codepunk-session-bundle-", async (root) => {
    const source = await createSession(root, "project-bundle");
    const bundle = await core.createSessionBundle(source);
    assert.equal(bundle.format, "codepunk/session-bundle");
    assert.equal(bundle.version, 1);
    assert.equal(bundle.log_sha256, hash.sha256Text(bundle.log));
    assert.equal(bundle.meta_sha256, hash.sha256Value(bundle.meta));
    assert.equal(bundle.meta.log_seq, 1);
    assert.equal(bundle.state_sha256, hash.sha256Value(bundle.state));

    const importHome = path.join(root, "import-home");
    const imported = await core.importSession({
      home: importHome,
      projectId: "project-bundle",
      bundle,
    });
    assert.equal(imported.session_id, source.sessionId);
    assert.equal(imported.events, 1);
    const reopened = await core.SessionStore.open({
      rootDir: importHome,
      cwd: "/workspace",
      projectId: "project-bundle",
      sessionId: source.sessionId,
    });
    assert.equal(reopened.allEvents.length, 1);
    assert.equal(reopened.allEvents[0].data.text, "hello");
    assert.equal(
      (await reopened.readAgentState())?.session_id,
      source.sessionId,
    );
    await assert.rejects(
      core.importSession({
        home: importHome,
        projectId: "project-bundle",
        bundle,
      }),
      (error) => error.code === "session.import_conflict",
    );

    const mismatchedProject = rewriteBundleLog(bundle, (header) => {
      header.project_id = "project-other";
    });
    await assert.rejects(
      core.importSession({
        home: path.join(root, "import-other"),
        projectId: "project-bundle",
        bundle: mismatchedProject,
      }),
      (error) => error.code === "session.import_project",
    );
    const unsafeId = rewriteBundleLog(bundle, (header) => {
      header.id = "../../escape";
    });
    await assert.rejects(
      core.importSession({
        home: path.join(root, "import-escape"),
        projectId: "project-bundle",
        bundle: unsafeId,
      }),
      (error) => error.code === "session.import_path",
    );
    await assert.rejects(
      core.importSession({
        home: path.join(root, "import-tampered"),
        projectId: "project-bundle",
        bundle: { ...bundle, log: `${bundle.log} ` },
      }),
      (error) => error.code === "session.import_format",
    );
    await assert.rejects(
      core.importSession({
        home: path.join(root, "import-state"),
        projectId: "project-bundle",
        bundle: { ...bundle, state_sha256: `sha256:${"0".repeat(64)}` },
      }),
      (error) => error.code === "session.import_state",
    );
  });
});

test("rename and archive projections hide archived sessions by default", async () => {
  await withTempDirectory("codepunk-session-archive-", async (root) => {
    const store = await createSession(
      root,
      "project-archive",
      "session-archive",
    );
    const options = resolveOptions(root, "project-archive", "session-archive");
    assert.equal(
      await core.renameSession(options, "  Release   review "),
      "Release review",
    );
    let sessions = await core.listProjectSessions(root, "project-archive");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].title, "Release review");
    assert.equal(sessions[0].archived, false);
    await core.archiveSession(options);
    sessions = await core.listProjectSessions(root, "project-archive");
    assert.equal(sessions.length, 0);
    sessions = await core.listProjectSessions(root, "project-archive", {
      includeArchived: true,
    });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].archived, true);
    assert.match(core.formatSessionList(sessions), /\[archived\]/u);
    assert.equal(await core.latestSession(root, "project-archive"), null);
    await core.archiveSession(options, false);
    sessions = await core.listProjectSessions(root, "project-archive");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].archived, false);
    const operations = await core.readSessionOperations(root);
    assert.deepEqual(
      operations.map((record) => record.action),
      ["rename", "archive", "unarchive"],
    );
    assert.equal(operations[0].prev_sha256, null);
    assert.equal(operations[1].prev_sha256, hash.sha256Value(operations[0]));
    assert.equal(operations[2].prev_sha256, hash.sha256Value(operations[1]));
    assert.equal(store.sessionId, "session-archive");
  });
});

test("session deletion backs up first, refuses live writers, and can restore", async () => {
  await withTempDirectory("codepunk-session-delete-", async (root) => {
    const store = await createSession(root, "project-delete", "session-delete");
    const options = resolveOptions(root, "project-delete", "session-delete");
    await assert.rejects(
      core.deleteSession({ ...options, confirmed: false }),
      (error) => error.code === "session.delete_confirmation",
    );
    const liveWriter = await store.acquireWriter();
    await assert.rejects(
      core.deleteSession({ ...options, confirmed: true }),
      (error) => error.code === "session.active_writer",
    );
    await liveWriter.release();

    const deleted = await core.deleteSession({ ...options, confirmed: true });
    assert.equal(deleted.session_id, "session-delete");
    assert.equal(deleted.deleted_files, 3);
    await assert.rejects(
      fs.stat(store.paths.sessionDir),
      (error) => error.code === "ENOENT",
    );
    assert.equal(
      (await core.listProjectSessions(root, "project-delete")).length,
      0,
    );
    const manifest = await core.loadBackup(root, deleted.backup_id);
    assert.equal(manifest.files.length, 3);
    const operations = await core.readSessionOperations(root);
    assert.equal(operations.at(-1).action, "delete");
    assert.equal(operations.at(-1).backup_id, deleted.backup_id);

    await core.restoreBackup(root, deleted.backup_id);
    const restored = await core.SessionStore.open({
      rootDir: root,
      cwd: "/workspace",
      projectId: "project-delete",
      sessionId: "session-delete",
    });
    assert.equal(restored.allEvents.length, 1);
    assert.equal(restored.allEvents[0].data.text, "hello");
  });
});

test("session operation log remains parseable under concurrent append and read", async () => {
  await withTempDirectory("codepunk-session-operations-", async (root) => {
    const appends = Array.from({ length: 20 }, (_, index) =>
      core.appendSessionOperation(root, {
        action: "archive",
        project_id: "project-ops",
        session_id: `session-${index}`,
        title: null,
        backup_id: null,
        source_sha256: null,
      }),
    );
    const reads = Array.from({ length: 20 }, async () => {
      const records = await core.readSessionOperations(root);
      for (const [index, record] of records.entries()) {
        assert.equal(record.seq, index + 1);
      }
      return records.length;
    });
    const [records, lengths] = await Promise.all([
      Promise.all(appends),
      Promise.all(reads),
    ]);
    assert.equal(new Set(records.map((record) => record.seq)).size, 20);
    assert.ok(lengths.every((length) => length >= 0 && length <= 20));
    const final = await core.readSessionOperations(root);
    assert.equal(final.length, 20);
    assert.equal((await core.archivedSessionIds(root)).size, 20);
  });
});
