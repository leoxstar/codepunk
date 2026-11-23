import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import {
  fixedClock,
  makeProject,
  withTempDirectory,
} from "./support/helpers.mjs";

const core = await importCore();

test("checkStoreVersion accepts older or equal and rejects with both numbers", () => {
  assert.equal(core.checkStoreVersion("test store", 1, 1), 1);
  assert.throws(
    () => core.checkStoreVersion("test store", 2, 1),
    (error) =>
      error.name === "FormatVersionError" &&
      /test store version 2 is newer than supported 1/u.test(error.message),
  );
  for (const saved of [0, -1, 1.5, "1", undefined, null]) {
    assert.throws(
      () => core.checkStoreVersion("test store", saved, 1),
      (error) =>
        /test store version is missing or not a positive integer/u.test(
          error.message,
        ),
      `saved=${JSON.stringify(saved)}`,
    );
  }
});

test("checkpoint index refuses a newer version without rewriting it", async () => {
  await withTempDirectory("codepunk-compat-checkpoints-", async (root) => {
    const sessionDir = path.join(root, "session");
    const store = new core.CheckpointStore({
      sessionDir,
      workspaceRoot: path.join(root, "project"),
    });
    await fs.mkdir(path.join(sessionDir, "checkpoints"), { recursive: true });
    const indexPath = path.join(sessionDir, "checkpoints", "index.json");
    const original = `${JSON.stringify({ version: 1, undo_stack: [], checkpoints: [] })}\n`;
    await fs.writeFile(indexPath, original, "utf8");
    assert.deepEqual(await store.list(), []);

    const rewritten = `${JSON.stringify({ version: 2, undo_stack: [], checkpoints: [] })}\n`;
    await fs.writeFile(indexPath, rewritten, "utf8");
    await assert.rejects(
      () => store.list(),
      /checkpoint index version 2 is newer than supported 1/u,
    );
    assert.equal(await fs.readFile(indexPath, "utf8"), rewritten);
  });
});

test("claim store refuses a newer version without rewriting it", async () => {
  await withTempDirectory("codepunk-compat-claims-", async (root) => {
    const { paths } = await makeProject(root);
    const store = new core.ClaimStore({
      paths,
      leaseMs: 1_000,
      now: fixedClock(),
    });
    await store.acquire("TASK-1", "worker-a");
    const claimPath = path.join(paths.projectDir, "claims.json");
    const rewritten = `${JSON.stringify({ version: 2, next_fence: 2, claims: {} })}\n`;
    await fs.writeFile(claimPath, rewritten, "utf8");
    await assert.rejects(
      () => store.acquire("TASK-2", "worker-a"),
      /claim store version 2 is newer than supported 1/u,
    );
    assert.equal(await fs.readFile(claimPath, "utf8"), rewritten);
  });
});

test("mcp auth store refuses a newer version without rewriting it", async () => {
  await withTempDirectory("codepunk-compat-mcp-", async (root) => {
    const store = new core.McpAuthStore(root);
    const rewritten = `${JSON.stringify({ version: 2, servers: {} })}\n`;
    await fs.writeFile(store.path, rewritten, "utf8");
    await assert.rejects(
      () => store.status("remote", "https://mcp.example.test/mcp"),
      (error) =>
        error.code === "mcp.auth_corrupt" &&
        /mcp auth store version 2 is newer than supported 1/u.test(
          error.message,
        ),
    );
    assert.equal(await fs.readFile(store.path, "utf8"), rewritten);
  });
});

test("evidence records refuse a newer version naming the line", async () => {
  await withTempDirectory("codepunk-compat-evidence-", async (root) => {
    const filePath = path.join(root, "evidence.jsonl");
    const lines = [
      `${JSON.stringify({
        version: 2,
        id: "ev-1",
        seq: 1,
        prev_sha256: null,
        created_at: "2026-11-23T00:00:00.000Z",
      })}`,
      `${JSON.stringify({
        version: 0,
        id: "ev-1",
        seq: 1,
        prev_sha256: null,
        created_at: "2026-11-23T00:00:00.000Z",
      })}`,
    ];
    for (const [index, line] of lines.entries()) {
      await fs.writeFile(filePath, `${line}\n`, "utf8");
      await assert.rejects(
        () => core.readEvidenceFile(filePath),
        index === 0
          ? /evidence record at line 1 version 2 is newer than supported 1/u
          : /evidence record at line 1 version is missing or not a positive integer/u,
      );
    }
  });
});

test("session log refuses newer header and event versions naming both numbers", async () => {
  await withTempDirectory("codepunk-compat-session-", async (rootDir) => {
    const store = await core.SessionStore.create({
      rootDir,
      cwd: "/workspace",
      now: fixedClock(),
      heartbeatMs: 60_000,
    });
    const writer = await store.acquireWriter();
    await store.append("user/input", { run_id: "run-1", text: "hello" });
    await store.saveAgentState({ id: "pi-header" }, []);
    await writer.release();

    const original = await fs.readFile(store.paths.logPath, "utf8");
    const records = original.trimEnd().split("\n");
    assert.equal(records.length, 2);

    const newerHeader =
      [
        JSON.stringify({ ...JSON.parse(records[0]), version: 2 }),
        records[1],
      ].join("\n") + "\n";
    await fs.writeFile(store.paths.logPath, newerHeader, "utf8");
    await assert.rejects(
      () =>
        core.SessionStore.open({
          rootDir,
          cwd: "/workspace",
          sessionId: store.sessionId,
        }),
      /session header version 2 is newer than supported 1/u,
    );

    const newerEvent =
      [
        records[0],
        JSON.stringify({ ...JSON.parse(records[1]), version: 2 }),
      ].join("\n") + "\n";
    await fs.writeFile(store.paths.logPath, newerEvent, "utf8");
    await assert.rejects(
      () =>
        core.SessionStore.open({
          rootDir,
          cwd: "/workspace",
          sessionId: store.sessionId,
        }),
      /session event 1 version 2 is newer than supported 1/u,
    );

    await fs.writeFile(store.paths.logPath, original, "utf8");
    const reopened = await core.SessionStore.open({
      rootDir,
      cwd: "/workspace",
      sessionId: store.sessionId,
    });
    assert.equal(reopened.sessionId, store.sessionId);
  });
});

test("background hydrate skips a newer snapshot without rewriting it", async () => {
  await withTempDirectory("codepunk-compat-background-", async (root) => {
    const { paths } = await makeProject(root);
    const taskDir = path.join(paths.projectDir, "background", "task-compat-1");
    await fs.mkdir(taskDir, { recursive: true });
    const recordPath = path.join(taskDir, "task.json");
    const rewritten = `${JSON.stringify({ version: 2, id: "task-compat-1" })}\n`;
    await fs.writeFile(recordPath, rewritten, "utf8");

    const manager = new core.BackgroundTaskManager({
      paths,
      sessionId: "session-compat",
    });
    await manager.hydrate();
    assert.equal(await fs.readFile(recordPath, "utf8"), rewritten);
  });
});

test("state-version.json refuses a non-integer version instead of migrating it", async () => {
  await withTempDirectory("codepunk-compat-state-version-", async (root) => {
    const home = path.join(root, "home");
    await fs.mkdir(home, { recursive: true });
    const statePath = path.join(home, "state-version.json");
    const original = `${JSON.stringify({ version: 1.5 }, null, 2)}\n`;
    await fs.writeFile(statePath, original, "utf8");
    await assert.rejects(
      () => core.checkMigration(home),
      /state-version\.json version is not a non-negative integer/u,
    );
    assert.equal(await fs.readFile(statePath, "utf8"), original);
  });
});
