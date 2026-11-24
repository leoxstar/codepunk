import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore, importSource } from "./support/core.mjs";
import {
  ensureBuilt,
  fixedClock,
  makeProject,
  withTempDirectory,
} from "./support/helpers.mjs";

const core = await importCore();
const modelHistoryModule = await importSource(
  "packages/cli/src/model-history.ts",
);

const CORPUS_ROOT = path.resolve(
  import.meta.dirname,
  "fixtures",
  "compat",
  "0.1.0",
);
const CORPUS_MANIFEST = path.join(CORPUS_ROOT, "MANIFEST.json");
const CORPUS_PROJECT_ID = "8be5f63f7fee6b9c";

/**
 * Restore the collected `codepunk-cli@0.1.0` corpus into a temporary
 * `CODEPUNK_HOME` and workspace.
 *
 * The corpus stores the capture-time absolute paths as `{{PROJECT}}` and
 * `{{HOME}}`, so a restore replaces them with the temporary directories and
 * recomputes the project id from the restored workspace path. The project id
 * is written back into the session headers and `project.json` because the
 * reader compares it with the directory it opens.
 */
async function restoreCorpus(root, { tamper } = {}) {
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(project, { recursive: true });

  const manifest = JSON.parse(await fs.readFile(CORPUS_MANIFEST, "utf8"));
  const projectId = core.projectIdFor(project);
  const restoredNpmPrefix = path.join(root, "capture-npm", "node_modules");
  const replacements = [
    ["{{PROJECT}}", project],
    ["{{HOME}}", home],
    ["{{NPM_PREFIX}}", restoredNpmPrefix],
    [
      "{{PI_AGENT_DOCS}}",
      path.join(restoredNpmPrefix, "@earendil-works", "pi-coding-agent"),
    ],
    ["{{COMPAT_API_KEY}}", "compat-test-key"],
  ];

  for (const entry of manifest.files) {
    const source = path.join(CORPUS_ROOT, entry.path);
    const relative = entry.path.replace(
      `home/projects/${CORPUS_PROJECT_ID}/`,
      `home/projects/${projectId}/`,
    );
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const bytes = await fs.readFile(source);
    await fs.writeFile(target, bytes);
  }

  // Replace the placeholders in every restored text file and rewrite the
  // project id that the reader compares against the project directory.
  const restoredFiles = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        restoredFiles.push(absolute);
      }
    }
  }
  await walk(root);

  for (const file of restoredFiles) {
    const original = await fs.readFile(file, "utf8");
    let content = original;
    for (const [placeholder, value] of replacements) {
      const replacement = replacementValue(value, file);
      content = content.replaceAll(placeholder, () => replacement);
    }
    content = content.replaceAll(
      `"project_id":"${CORPUS_PROJECT_ID}"`,
      `"project_id":"${projectId}"`,
    );
    content = content.replaceAll(
      `"id":"${CORPUS_PROJECT_ID}"`,
      `"id":"${projectId}"`,
    );
    if (content !== original) {
      await fs.writeFile(file, content, "utf8");
    }
  }

  const projectDir = path.join(home, "projects", projectId);
  const sessionsDir = path.join(projectDir, "sessions");
  const sessionIds = (await fs.readdir(sessionsDir)).sort();

  // A forked child records the hash of its parent agent state. Restoring
  // rewrote the parent state (its workspace path and project id), so the
  // recorded hash is recomputed over the restored parent state.
  for (const sessionId of sessionIds) {
    const logPath = path.join(sessionsDir, sessionId, "session.jsonl");
    const lines = (await fs.readFile(logPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    const forked = lines
      .slice(1)
      .map((line) => JSON.parse(line))
      .find((event) => event.kind === "session/forked");
    if (forked === undefined) {
      continue;
    }
    const parentStatePath = path.join(
      sessionsDir,
      forked.data.parent_session_id,
      "agent-state.json",
    );
    const parentState = JSON.parse(await fs.readFile(parentStatePath, "utf8"));
    const expected = core.recordHash(parentState);
    const rewritten = lines.map((line, index) => {
      if (index === 0) {
        return line;
      }
      const event = JSON.parse(line);
      if (event.kind !== "session/forked") {
        return line;
      }
      event.data.parent_state_sha256 = expected;
      return JSON.stringify(event);
    });
    await fs.writeFile(logPath, `${rewritten.join("\n")}\n`, "utf8");
  }

  // Evidence record hashes cover the complete record, including the restored
  // workspace paths. Recompute each chain, then update the evidence index,
  // run/end event, sign-off event, and verdict artifact that bind that head.
  const evidenceDir = path.join(projectDir, "evidence");
  const evidenceHeads = new Map();
  for (const sessionId of await fs.readdir(evidenceDir)) {
    const dir = path.join(evidenceDir, sessionId);
    for (const file of await fs.readdir(dir)) {
      if (file === "index.jsonl") {
        continue;
      }
      const records = (await fs.readFile(path.join(dir, file), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      let previous = null;
      for (const [index, record] of records.entries()) {
        record.prev_sha256 = previous;
        previous = core.evidenceRecordHash(record);
        records[index] = record;
      }
      const head = previous;
      const runId = records[0]?.run_id;
      assert.ok(typeof runId === "string", "evidence records have no run id");
      evidenceHeads.set(recordKey(runId, sessionId), head);
      await fs.writeFile(
        path.join(dir, file),
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
        "utf8",
      );
    }
  }

  for (const sessionId of sessionIds) {
    const logPath = path.join(sessionsDir, sessionId, "session.jsonl");
    const lines = (await fs.readFile(logPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    const updated = lines.map((line, index) => {
      if (index === 0) {
        return line;
      }
      const event = JSON.parse(line);
      const head = evidenceHeads.get(recordKey(event.run_id, sessionId));
      if (event.kind === "run/end" && head !== undefined) {
        event.data.evidence_head = head;
      }
      if (event.kind === "verdict/sign_off" && head !== undefined) {
        event.data.evidence_head = head;
      }
      return JSON.stringify(event);
    });
    await fs.writeFile(logPath, `${updated.join("\n")}\n`, "utf8");
  }

  for (const sessionId of await fs.readdir(evidenceDir)) {
    const indexLines = (
      await fs.readFile(
        path.join(evidenceDir, sessionId, "index.jsonl"),
        "utf8",
      )
    )
      .split("\n")
      .filter((line) => line.length > 0);
    const updatedIndex = indexLines.map((line) => {
      const entry = JSON.parse(line);
      entry.head = evidenceHeads.get(recordKey(entry.run_id, sessionId));
      return JSON.stringify(entry);
    });
    await fs.writeFile(
      path.join(evidenceDir, sessionId, "index.jsonl"),
      `${updatedIndex.join("\n")}\n`,
      "utf8",
    );
  }

  const verdictsDir = path.join(projectDir, "verdicts");
  for (const file of await fs.readdir(verdictsDir)) {
    const verdictPath = path.join(verdictsDir, file);
    const verdict = JSON.parse(await fs.readFile(verdictPath, "utf8"));
    verdict.evidence_head = evidenceHeads.get(
      recordKey(verdict.run_id, verdict.session_id),
    );
    await fs.writeFile(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`);
  }

  if (tamper !== undefined) {
    await tamper({
      home,
      project,
      projectDir,
      projectId,
      sessionsDir,
      sessionIds,
    });
  }

  return { home, project, projectId, projectDir, sessionsDir, sessionIds };
}

function recordKey(runId, sessionId) {
  return `${sessionId}\0${runId}`;
}

function replacementValue(value, file) {
  const isJson = /\.(?:json|jsonl)$/iu.test(file);
  return isJson ? JSON.stringify(value).slice(1, -1) : value;
}

async function runCli(args, { cwd, home }) {
  const cli = await ensureBuilt();
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: {
      ...process.env,
      CODEPUNK_HOME: home,
      NO_COLOR: "1",
      PI_OFFLINE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

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

test("the 0.1.0 corpus matches its manifest digests", async () => {
  const manifest = JSON.parse(await fs.readFile(CORPUS_MANIFEST, "utf8"));
  assert.equal(manifest.source.version, "0.1.0");
  assert.deepEqual(manifest.notCovered, []);
  assert.equal(manifest.excludedStores.length, 2);
  assert.deepEqual(
    manifest.excludedStores.map((entry) => entry.split(/[ (]/u)[0]).sort(),
    ["headless.toml", "plugin.toml"],
  );
  assert.ok(Array.isArray(manifest.excludedCaptureArtifacts));
  assert.ok(
    manifest.excludedCaptureArtifacts.every(
      (entry) =>
        !entry.startsWith("plugin.toml") && !entry.startsWith("headless.toml"),
    ),
  );
  assert.ok(manifest.files.length > 0);
  for (const entry of manifest.files) {
    const bytes = await fs.readFile(path.join(CORPUS_ROOT, entry.path));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      entry.sha256,
      entry.path,
    );
  }
});

test("the restored 0.1.0 corpus reads its newly covered stores", async () => {
  await withTempDirectory("codepunk-compat-new-stores-", async (root) => {
    const restored = await restoreCorpus(root);

    const placeholders = [];
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop();
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(file);
        } else if (entry.isFile() && !file.endsWith(".bin")) {
          const content = await fs.readFile(file, "utf8");
          const matches = content.match(/\{\{[A-Z0-9_]+\}\}/gu) ?? [];
          placeholders.push(...matches.map((match) => `${file}: ${match}`));
        }
      }
    }
    assert.deepEqual(placeholders, []);

    const history = await modelHistoryModule.readModelHistory(restored.home);
    assert.deepEqual(history, {
      recent: [],
      favorites: ["compat/compat-model"],
      warning: null,
    });

    const auth = new core.McpAuthStore(restored.home);
    assert.deepEqual(
      await auth.status("compat-auth", "http://127.0.0.1:48762/mcp"),
      {
        signed_in: false,
        expires_at: null,
        scope: null,
      },
    );

    const paths = {
      home: restored.home,
      projectDir: restored.projectDir,
    };
    const claimStore = new core.ClaimStore({
      paths,
      now: fixedClock("2026-11-24T00:00:30.000Z"),
    });
    const claim = await claimStore.inspect("compat-claim");
    assert.deepEqual(claim, {
      claim_id: "compat-claim-1",
      task_id: "compat-claim",
      owner: "compat-worker",
      fence: 1,
      acquired_at: "2026-11-24T00:00:00.000Z",
      renewed_at: "2026-11-24T00:00:00.000Z",
      expires_at: "2026-11-24T00:01:00.000Z",
    });

    const bridge = new core.MessageBridge({
      paths,
      now: fixedClock("2026-11-24T00:00:30.000Z"),
    });
    assert.equal(await bridge.queueSize(), 1);

    const transcriptPath = path.join(
      restored.projectDir,
      "artifacts",
      "subagents",
      "compat-child",
      "transcript.jsonl",
    );
    const transcript = (await fs.readFile(transcriptPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    assert.equal(transcript[0].type, "session");
    assert.ok(transcript.every((entry) => typeof entry.type === "string"));
    assert.ok(
      transcript.some(
        (entry) =>
          entry.type === "message_end" && entry.message.role === "user",
      ),
    );
  });
});

test("backup create and restore verify the restored corpus manifest", async () => {
  await withTempDirectory("codepunk-compat-backup-", async (root) => {
    const restored = await restoreCorpus(root);
    const backup = await core.createBackup(restored.home, {
      roots: ["projects"],
      include: ["config.toml", "state-version.json"],
    });
    assert.equal(backup.version, 1);
    assert.ok(backup.files.length > 0);

    const claimsPath = path.join(restored.projectDir, "claims.json");
    const original = await fs.readFile(claimsPath, "utf8");
    await fs.writeFile(claimsPath, `${original}\n`, "utf8");

    const restoredManifest = await core.restoreBackup(restored.home, backup.id);
    assert.equal(restoredManifest.id, backup.id);
    assert.deepEqual(restoredManifest.files, backup.files);
    assert.equal(await fs.readFile(claimsPath, "utf8"), original);

    const create = await runCli(["backup", "create", "--json"], {
      cwd: restored.project,
      home: restored.home,
    });
    assert.equal(create.code, 0, create.stderr);
    const current = JSON.parse(create.stdout);

    const list = await runCli(["backup", "list", "--json"], {
      cwd: restored.project,
      home: restored.home,
    });
    assert.equal(list.code, 0, list.stderr);
    assert.ok(JSON.parse(list.stdout).some((entry) => entry.id === current.id));

    const restore = await runCli(["backup", "restore", current.id, "--json"], {
      cwd: restored.project,
      home: restored.home,
    });
    assert.equal(restore.code, 0, restore.stderr);
    assert.equal(JSON.parse(restore.stdout).id, current.id);

    const backupManifestPath = path.join(
      restored.home,
      "backups",
      current.id,
      "manifest.json",
    );
    const savedManifest = JSON.parse(
      await fs.readFile(backupManifestPath, "utf8"),
    );
    savedManifest.files[0].sha256 = `sha256:${"0".repeat(64)}`;
    await fs.writeFile(
      backupManifestPath,
      `${JSON.stringify(savedManifest, null, 2)}\n`,
      "utf8",
    );
    const before = await fs.readFile(
      path.join(restored.home, savedManifest.files[0].path),
      "utf8",
    );
    const tampered = await runCli(["backup", "restore", current.id, "--json"], {
      cwd: restored.project,
      home: restored.home,
    });
    assert.notEqual(tampered.code, 0, "tampered backup manifest was accepted");
    assert.match(tampered.stderr, /hash mismatch/u);
    assert.equal(
      await fs.readFile(
        path.join(restored.home, savedManifest.files[0].path),
        "utf8",
      ),
      before,
    );
  });
});

test("newer and malformed new stores are refused without rewriting", async () => {
  await withTempDirectory("codepunk-compat-new-negative-", async (root) => {
    const restored = await restoreCorpus(root);
    const claimPath = path.join(restored.projectDir, "claims.json");
    const notificationPath = path.join(
      restored.projectDir,
      "notifications.jsonl",
    );
    const paths = {
      home: restored.home,
      projectDir: restored.projectDir,
    };

    const newerClaims = `${JSON.stringify({
      version: 2,
      next_fence: 1,
      claims: {},
    })}\n`;
    await fs.writeFile(claimPath, newerClaims, "utf8");
    const claimStore = new core.ClaimStore({
      paths,
      now: fixedClock("2026-11-24T00:00:30.000Z"),
    });
    await assert.rejects(
      () => claimStore.acquire("compat-other", "compat-worker"),
      /claim store version 2 is newer than supported 1/u,
    );
    assert.equal(await fs.readFile(claimPath, "utf8"), newerClaims);

    const malformedNotifications = "{not json\n";
    await fs.writeFile(notificationPath, malformedNotifications, "utf8");
    const bridge = new core.MessageBridge({
      paths,
      now: fixedClock("2026-11-24T00:00:30.000Z"),
    });
    await assert.rejects(
      () => bridge.queueSize(),
      (error) =>
        error.code === "bridge.corrupt_queue" &&
        /notification queue is corrupt/u.test(error.message),
    );
    assert.equal(
      await fs.readFile(notificationPath, "utf8"),
      malformedNotifications,
    );
  });
});

test("the restored 0.1.0 corpus lists, searches and reads its sessions", async () => {
  await withTempDirectory("codepunk-compat-restore-", async (root) => {
    const restored = await restoreCorpus(root);
    assert.notEqual(restored.projectId, CORPUS_PROJECT_ID);

    const sessions = await core.listProjectSessions(
      restored.home,
      restored.projectId,
    );
    assert.deepEqual(
      sessions.map((session) => session.id).sort(),
      restored.sessionIds,
    );

    const search = await core.searchProjectSessions({
      rootDir: restored.home,
      projectId: restored.projectId,
      query: "compat",
    });
    assert.ok(search.matches.length > 0, "expected a session search hit");
    for (const match of search.matches) {
      assert.equal(match.cwd, restored.project);
    }

    for (const sessionId of restored.sessionIds) {
      const store = await core.SessionStore.open({
        rootDir: restored.home,
        cwd: restored.project,
        projectRoot: restored.project,
        projectId: restored.projectId,
        sessionId,
      });
      const tree = await core.readSessionTree(store);
      assert.ok(tree !== null, `${sessionId} has no readable tree`);
      assert.equal(tree.cwd, restored.project);
      assert.equal(tree.session_id, sessionId);
      const state = await store.readAgentState();
      assert.ok(state !== null, `${sessionId} has no agent state`);
      assert.equal(state.session_id, sessionId);
      const branchIds = state.branch.map((entry) => entry.id);
      assert.deepEqual(
        tree.active_entry_ids,
        branchIds,
        `${sessionId} active branch differs from the corpus`,
      );
      assert.ok(
        state.leaf_id === null || branchIds.includes(state.leaf_id),
        `${sessionId} leaf is not on the active branch`,
      );
    }
  });
});

test("the restored 0.1.0 sessions resume through the current runtime", async () => {
  await withTempDirectory("codepunk-compat-resume-", async (root) => {
    const restored = await restoreCorpus(root);
    for (const sessionId of ["compat-sign-session", "compat-parent"]) {
      const store = await core.SessionStore.open({
        rootDir: restored.home,
        cwd: restored.project,
        projectRoot: restored.project,
        projectId: restored.projectId,
        sessionId,
      });
      const beforeLog = await fs.readFile(store.paths.logPath, "utf8");
      const beforeCoverage = store.metadata.state_covers_seq;
      const resumed = await store.resume();
      assert.ok(
        resumed.uncommittedEvents.length > 0,
        `${sessionId} should carry the 0.1.0 capture tail`,
      );
      assert.ok(
        resumed.uncommittedEvents.every((event) =>
          core.isBenignTailEventKind(event.kind),
        ),
        `${sessionId} has a non-benign capture tail`,
      );

      const runtime = await core.createRuntime({
        cwd: restored.project,
        environment: { ...process.env, CODEPUNK_HOME: restored.home },
        sessionId,
        allowMissingModel: true,
      });
      await runtime.dispose();

      const reopened = await core.SessionStore.open({
        rootDir: restored.home,
        cwd: restored.project,
        projectRoot: restored.project,
        projectId: restored.projectId,
        sessionId,
      });
      assert.equal(
        reopened.metadata.state_covers_seq,
        reopened.metadata.log_seq,
      );
      assert.ok(reopened.metadata.state_covers_seq > beforeCoverage);
      assert.ok(
        (await fs.readFile(reopened.paths.logPath, "utf8")).startsWith(
          beforeLog,
        ),
        `${sessionId} log was rewritten during recovery`,
      );
    }
  });
});

test("the restored 0.1.0 corpus keeps every evidence chain and store readable", async () => {
  await withTempDirectory("codepunk-compat-evidence-chain-", async (root) => {
    const restored = await restoreCorpus(root);
    const evidenceDir = path.join(restored.projectDir, "evidence");
    const sessionIds = await fs.readdir(evidenceDir);
    let ledgers = 0;
    for (const sessionId of sessionIds) {
      const dir = path.join(evidenceDir, sessionId);
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (file === "index.jsonl") {
          continue;
        }
        const loaded = await core.readEvidenceFile(path.join(dir, file));
        const chain = core.validateEvidenceChain(loaded.records);
        assert.equal(chain.ok, true, chain.issues.join("; "));
        assert.ok(chain.head !== null);
        ledgers += 1;
      }
    }
    assert.ok(ledgers > 0, "expected at least one evidence ledger");

    const verdicts = await fs.readdir(
      path.join(restored.projectDir, "verdicts"),
    );
    assert.ok(verdicts.length > 0, "expected verdict artifacts");
    for (const file of verdicts) {
      const verdict = JSON.parse(
        await fs.readFile(
          path.join(restored.projectDir, "verdicts", file),
          "utf8",
        ),
      );
      assert.equal(verdict.version, 1);
      assert.equal(typeof verdict.verdict, "string");
    }

    const checkpointSession = "compat-parent";
    const checkpoints = new core.CheckpointStore({
      sessionDir: path.join(restored.sessionsDir, checkpointSession),
      workspaceRoot: restored.project,
    });
    const list = await checkpoints.list();
    assert.ok(list.length > 0, "expected checkpoint entries");
    for (const entry of list) {
      assert.equal(entry.id, "01M8613376NJBFQCJ2MQJY3R9D");
    }

    const state = JSON.parse(
      await fs.readFile(path.join(restored.home, "state-version.json"), "utf8"),
    );
    assert.equal(state.version, 1);
    const migration = await core.checkMigration(restored.home);
    assert.deepEqual(migration, {
      current: 1,
      target: 1,
      required: false,
    });
  });
});

test("the restored 0.1.0 corpus loads its configuration", async () => {
  await withTempDirectory("codepunk-compat-config-", async (root) => {
    const restored = await restoreCorpus(root);
    const paths = core.projectPaths(
      {
        cwd: restored.project,
        deliveryRoot: restored.project,
        projectId: restored.projectId,
      },
      restored.home,
    );
    const loaded = await core.loadConfig(
      paths,
      { ...process.env, CODEPUNK_HOME: restored.home },
      {},
      { projectTrusted: true },
    );
    assert.equal(loaded.config.model.provider, "compat");
    assert.equal(loaded.config.model.id, "compat-model");

    const shown = await runCli(["config", "--json"], {
      cwd: restored.project,
      home: restored.home,
    });
    assert.equal(shown.code, 0, shown.stderr);
    const payload = JSON.parse(shown.stdout);
    assert.equal(payload.config.model.provider, "compat");
  });
});

test("a newer agent-state version is refused without rewriting the file", async () => {
  await withTempDirectory("codepunk-compat-c1-version-", async (root) => {
    const restored = await restoreCorpus(root, {
      tamper: async ({ sessionsDir }) => {
        const statePath = path.join(
          sessionsDir,
          "compat-parent",
          "agent-state.json",
        );
        const state = JSON.parse(await fs.readFile(statePath, "utf8"));
        state.version = 2;
        await fs.writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
      },
    });
    const statePath = path.join(
      restored.sessionsDir,
      "compat-parent",
      "agent-state.json",
    );
    const before = await fs.readFile(statePath, "utf8");
    const store = await core.SessionStore.open({
      rootDir: restored.home,
      cwd: restored.project,
      projectRoot: restored.project,
      projectId: restored.projectId,
      sessionId: "compat-parent",
    });
    await assert.rejects(
      () => store.readAgentState(),
      (error) => {
        assert.match(error.message, /agent-state/u);
        assert.match(error.message, /version/u);
        assert.match(error.message, /2/u);
        assert.match(error.message, /1/u);
        return true;
      },
    );
    assert.equal(await fs.readFile(statePath, "utf8"), before);
  });
});

test("a newer Pi session version is refused without rewriting the file", async () => {
  await withTempDirectory(
    "codepunk-compat-c1-session-version-",
    async (root) => {
      const restored = await restoreCorpus(root, {
        tamper: async ({ sessionsDir }) => {
          const statePath = path.join(
            sessionsDir,
            "compat-parent",
            "agent-state.json",
          );
          const state = JSON.parse(await fs.readFile(statePath, "utf8"));
          state.session_version = 4;
          await fs.writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
        },
      });
      const statePath = path.join(
        restored.sessionsDir,
        "compat-parent",
        "agent-state.json",
      );
      const before = await fs.readFile(statePath, "utf8");
      const store = await core.SessionStore.open({
        rootDir: restored.home,
        cwd: restored.project,
        projectRoot: restored.project,
        projectId: restored.projectId,
        sessionId: "compat-parent",
      });
      await assert.rejects(
        () => store.readAgentState(),
        (error) => {
          assert.match(error.message, /agent-state/u);
          assert.match(error.message, /session_version/u);
          assert.match(error.message, /4/u);
          assert.match(error.message, /3/u);
          return true;
        },
      );
      assert.equal(await fs.readFile(statePath, "utf8"), before);
    },
  );
});

test("a tampered corpus byte breaks the restored evidence chain", async () => {
  await withTempDirectory("codepunk-compat-tamper-", async (root) => {
    const restored = await restoreCorpus(root);
    const ledger = path.join(
      restored.projectDir,
      "evidence",
      "compat-parent",
      "01M8612N73K9BRH91WH523Z8YS.jsonl",
    );
    const original = await fs.readFile(ledger, "utf8");
    assert.match(
      original,
      /"output_preview":"Successfully wrote to compat-written\.txt"/u,
    );
    await fs.writeFile(
      ledger,
      original.replace(
        '"output_preview":"Successfully wrote to compat-written.txt"',
        '"output_preview":"Successfully wrote to compat-written.txt "',
      ),
      "utf8",
    );
    await assert.rejects(() => core.readEvidenceFile(ledger), /evidence/u);
  });
});
