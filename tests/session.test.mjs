import assert from "node:assert/strict";
import { promises as fsPromises } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importCore, importProtocol } from "./support/core.mjs";
import { fixedClock, makeProject } from "./support/helpers.mjs";

const core = await importCore();
const protocol = await importProtocol();

async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codepunk-session-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function advancingClock() {
  let current = new Date("2026-11-12T00:00:00.000Z");
  return () => {
    const value = new Date(current);
    current = new Date(current.getTime() + 1000);
    return value;
  };
}

async function createStore(rootDir, options = {}) {
  return core.SessionStore.create({
    rootDir,
    cwd: "/workspace",
    now: advancingClock(),
    heartbeatMs: 60_000,
    ...options,
  });
}

test("a second writer is refused and appends require the lock", async () => {
  await withTempDirectory(async (rootDir) => {
    const first = await createStore(rootDir);
    const writer = await first.acquireWriter();
    const second = await core.SessionStore.open({
      rootDir,
      cwd: "/workspace",
      sessionId: first.sessionId,
    });
    await assert.rejects(
      () => second.acquireWriter(),
      /live writer|lease|still alive/u,
    );
    await assert.rejects(
      () => second.append("user/input", { run_id: "run-1", text: "x" }),
      /writer lock/u,
    );
    const event = await first.append("user/input", {
      run_id: "run-1",
      text: "hello",
    });
    assert.equal(event.seq, 1);
    await writer.release();
    const third = await core.SessionStore.open({
      rootDir,
      cwd: "/workspace",
      sessionId: first.sessionId,
    });
    const thirdWriter = await third.acquireWriter();
    await thirdWriter.release();
  });
});

test("session titles are bounded, single-line, and redacted", () => {
  assert.equal(
    core.normalizeSessionTitle("  fix   the\nsession\tlist  "),
    "fix the session list",
  );
  assert.equal(core.normalizeSessionTitle("   "), null);
  const redacted = core.normalizeSessionTitle(
    `inspect token=${"sk-" + "a".repeat(24)} before saving`,
  );
  assert.match(redacted, /REDACTED/u);
  assert.equal(redacted.includes("sk-"), false);
  assert.equal(
    Array.from(core.normalizeSessionTitle("x".repeat(200))).length,
    80,
  );
});

test("a live writer can fork its settled branch without reacquiring the parent lock", async () => {
  await withTempDirectory(async (rootDir) => {
    const parent = await core.SessionStore.create({
      rootDir,
      cwd: "/workspace",
      projectRoot: "/workspace",
      projectId: "project-live-fork",
      now: advancingClock(),
      heartbeatMs: 60_000,
    });
    const writer = await parent.acquireWriter();
    const branch = [
      {
        id: "entry-1",
        parentId: null,
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ];
    await parent.saveAgentState(
      {
        type: "session",
        id: "pi-parent",
        cwd: "/workspace",
        timestamp: "2026-11-12T00:00:00.000Z",
      },
      branch,
    );
    const parentState = await parent.readAgentState();
    assert.ok(parentState);
    const forked = await core.forkLiveSession({
      parent,
      parentState,
      rootDir,
      cwd: "/workspace",
      projectRoot: "/workspace",
      projectId: parent.header.project_id,
    });
    assert.equal(forked.parentSessionId, parent.sessionId);
    assert.equal(forked.parentLastSeq, 0);
    assert.equal(forked.forkEntries, 1);
    const child = await core.SessionStore.open({
      rootDir,
      cwd: "/workspace",
      projectId: parent.header.project_id,
      sessionId: forked.sessionId,
    });
    assert.equal(child.header.parent_session_id, parent.sessionId);
    assert.equal(child.header.fork_entry_id, "entry-1");
    assert.equal(child.allEvents[0].kind, "session/forked");
    assert.equal(child.allEvents[0].data.mode, "live");
    const childState = await child.readAgentState();
    assert.deepEqual(childState.branch, branch);
    await writer.release();
  });
});

test("a live fork refuses a branch or state that does not match the log", async () => {
  await withTempDirectory(async (rootDir) => {
    const parent = await core.SessionStore.create({
      rootDir,
      cwd: "/workspace",
      projectRoot: "/workspace",
      projectId: "project-live-fork-negative",
      now: advancingClock(),
      heartbeatMs: 60_000,
    });
    const writer = await parent.acquireWriter();
    const branch = [
      {
        id: "entry-1",
        parentId: null,
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ];
    await parent.saveAgentState(
      {
        type: "session",
        id: "pi-parent-negative",
        cwd: "/workspace",
        timestamp: "2026-11-12T00:00:00.000Z",
      },
      branch,
    );
    const parentState = await parent.readAgentState();
    assert.ok(parentState);
    await parent.append("user/input", { run_id: "run-1", text: "after state" });
    await assert.rejects(
      () =>
        core.forkLiveSession({
          parent,
          parentState,
          rootDir,
          cwd: "/workspace",
          projectRoot: "/workspace",
          projectId: parent.header.project_id,
        }),
      /beyond its saved agent state/u,
    );
    const empty = await core.SessionStore.create({
      rootDir,
      cwd: "/workspace",
      projectRoot: "/workspace",
      projectId: "project-live-fork-negative",
      now: advancingClock(),
      heartbeatMs: 60_000,
    });
    const emptyWriter = await empty.acquireWriter();
    await empty.saveAgentState(
      {
        type: "session",
        id: "pi-empty",
        cwd: "/workspace",
        timestamp: "2026-11-12T00:00:00.000Z",
      },
      [],
    );
    const emptyState = await empty.readAgentState();
    assert.ok(emptyState);
    await assert.rejects(
      () =>
        core.forkLiveSession({
          parent: empty,
          parentState: emptyState,
          rootDir,
          cwd: "/workspace",
          projectRoot: "/workspace",
          projectId: empty.header.project_id,
        }),
      /no agent branch to fork/u,
    );
    await emptyWriter.release();
    await writer.release();
  });
});

test("heartbeat updates the lock without consuming an event seq", async () => {
  await withTempDirectory(async (rootDir) => {
    const store = await createStore(rootDir);
    const writer = await store.acquireWriter();
    await store.append("user/input", { run_id: "run-1", text: "hello" });
    const beforeLock = await core.readLock(store.lockPath);
    await writer.heartbeat();
    await writer.heartbeat();
    const afterLock = await core.readLock(store.lockPath);
    assert.equal(store.lastSeq, 1);
    assert.ok(afterLock);
    assert.ok(beforeLock);
    assert.ok(
      Date.parse(afterLock.heartbeat_at) > Date.parse(beforeLock.heartbeat_at),
    );
    await writer.release();
  });
});

test("the writer starts an automatic heartbeat timer", async () => {
  await withTempDirectory(async (rootDir) => {
    const store = await createStore(rootDir, {
      heartbeatMs: 20,
      leaseMs: 500,
    });
    const writer = await store.acquireWriter();
    const before = await core.readLock(store.lockPath);
    assert.ok(before);
    const beforeHeartbeat = Date.parse(before.heartbeat_at);
    let after = before;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      after = await core.readLock(store.lockPath);
      if (Date.parse(after.heartbeat_at) > beforeHeartbeat) {
        break;
      }
    }
    assert.ok(after);
    assert.ok(Date.parse(after.heartbeat_at) > beforeHeartbeat);
    await writer.release();
  });
});

test("release waits for an in-flight heartbeat", async () => {
  await withTempDirectory(async (rootDir) => {
    const store = await createStore(rootDir);
    const writer = await store.acquireWriter();
    let markRenameEntered = () => undefined;
    let unblockRename = () => undefined;
    const renameEntered = new Promise((resolve) => {
      markRenameEntered = resolve;
    });
    const renameBlocked = new Promise((resolve) => {
      unblockRename = resolve;
    });
    const originalRename = fsPromises.rename;
    fsPromises.rename = async (source, target) => {
      if (target === store.lockPath) {
        markRenameEntered();
        await renameBlocked;
      }
      return originalRename(source, target);
    };
    let completedEarly = true;
    try {
      const heartbeat = writer.heartbeat();
      await renameEntered;
      const release = writer.release();
      try {
        completedEarly = await Promise.race([
          release.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 50)),
        ]);
      } finally {
        unblockRename();
        await Promise.allSettled([heartbeat, release]);
      }
    } finally {
      fsPromises.rename = originalRename;
    }
    assert.equal(completedEarly, false);
    await assert.rejects(() => readFile(store.lockPath), /ENOENT/u);
  });
});

test("a stale local lock is recovered under an atomic sentinel", async () => {
  await withTempDirectory(async (rootDir) => {
    const store = await createStore(rootDir);
    const initial = await store.acquireWriter();
    await initial.release();
    const stale = {
      pid: 999_999_999,
      host: os.hostname(),
      started_at: "2020-01-01T00:00:00.000Z",
      heartbeat_at: "2020-01-01T00:00:00.000Z",
      nonce: "stale-nonce",
    };
    await writeFile(store.lockPath, `${JSON.stringify(stale)}\n`, "utf8");
    const recovered = await store.acquireWriter();
    const current = await core.readLock(store.lockPath);
    assert.ok(current);
    assert.notEqual(current.nonce, stale.nonce);
    assert.equal(current.nonce, recovered.nonce);
    await assert.rejects(
      () =>
        readFile(
          path.join(path.dirname(store.lockPath), "session.lock.recovery"),
        ),
      /ENOENT/u,
    );
    await recovered.release();
  });
});

test("concurrent stale-lock recovery has one winner and does not delete it", async () => {
  await withTempDirectory(async (rootDir) => {
    const store = await createStore(rootDir);
    const initial = await store.acquireWriter();
    await initial.release();
    const stale = {
      pid: 999_999_999,
      host: os.hostname(),
      started_at: "2020-01-01T00:00:00.000Z",
      heartbeat_at: "2020-01-01T00:00:00.000Z",
      nonce: "stale-nonce",
    };
    await writeFile(store.lockPath, `${JSON.stringify(stale)}\n`, "utf8");

    const second = await core.SessionStore.open({
      rootDir,
      cwd: "/workspace",
      sessionId: store.sessionId,
    });
    const results = await Promise.allSettled([
      store.acquireWriter(),
      second.acquireWriter(),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const winner = fulfilled[0].value;
    const current = await core.readLock(store.lockPath);
    assert.ok(current);
    assert.equal(current.nonce, winner.nonce);
    await winner.release();
  });
});

test("a remote or live owner is never stolen", async () => {
  await withTempDirectory(async (rootDir) => {
    const store = await createStore(rootDir);
    const writer = await store.acquireWriter();
    await writer.release();

    await writeFile(
      store.lockPath,
      `${JSON.stringify({
        pid: 999_999_999,
        host: "remote-host",
        started_at: "2020-01-01T00:00:00.000Z",
        heartbeat_at: "2020-01-01T00:00:00.000Z",
        nonce: "remote-nonce",
      })}\n`,
      "utf8",
    );
    await assert.rejects(() => store.acquireWriter(), /another host/u);

    await writeFile(
      store.lockPath,
      `${JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        started_at: "2020-01-01T00:00:00.000Z",
        heartbeat_at: "2020-01-01T00:00:00.000Z",
        nonce: "live-nonce",
      })}\n`,
      "utf8",
    );
    await assert.rejects(() => store.acquireWriter(), /still alive/u);
  });
});

test("resume separates committed and crash-window events", async () => {
  await withTempDirectory(async (rootDir) => {
    const store = await createStore(rootDir);
    const writer = await store.acquireWriter();
    await store.append("user/input", { run_id: "run-1", text: "committed" });
    await store.saveAgentState({ id: "pi-header" }, []);
    await store.append("user/input", { run_id: "run-1", text: "uncommitted" });
    await writer.release();

    const reopened = await core.SessionStore.open({
      rootDir,
      cwd: "/workspace",
      sessionId: store.sessionId,
    });
    const resumed = await reopened.resume();
    assert.equal(resumed.state.session_id, store.sessionId);
    assert.deepEqual(resumed.state.header, { id: "pi-header" });
    assert.deepEqual(
      resumed.committedEvents.map((event) => event.data.text),
      ["committed"],
    );
    assert.deepEqual(
      resumed.uncommittedEvents.map((event) => event.data.text),
      ["uncommitted"],
    );
    assert.equal(reopened.metadata.state_covers_seq, 1);
    assert.equal(reopened.metadata.log_seq, 2);
  });
});

test("runtime refuses to resume across an uncommitted crash window", async () => {
  await withTempDirectory(async (root) => {
    const { projectRoot, paths } = await makeProject(
      await fsPromises.realpath(root),
    );
    const projectId = core.projectIdFor(projectRoot);
    const store = await core.SessionStore.create({
      rootDir: paths.home,
      cwd: projectRoot,
      projectId,
      now: fixedClock(),
      heartbeatMs: 60_000,
    });
    const writer = await store.acquireWriter();
    await store.append("user/input", {
      run_id: "run-1",
      text: "committed",
    });
    await store.saveAgentState(
      { type: "session", id: store.sessionId, cwd: projectRoot },
      [],
    );
    await store.append("user/input", {
      run_id: "run-1",
      text: "uncommitted",
    });
    await writer.release();

    await assert.rejects(
      () =>
        core.createRuntime({
          cwd: projectRoot,
          environment: { ...process.env, CODEPUNK_HOME: paths.home },
          sessionId: store.sessionId,
          allowMissingModel: true,
        }),
      /refusing to resume with a stale model transcript/u,
    );
  });
});

test("runtime refuses events that never reached an agent-state snapshot", async () => {
  await withTempDirectory(async (root) => {
    const { projectRoot, paths } = await makeProject(
      await fsPromises.realpath(root),
    );
    const projectId = core.projectIdFor(projectRoot);
    const store = await core.SessionStore.create({
      rootDir: paths.home,
      cwd: projectRoot,
      projectId,
      now: fixedClock(),
      heartbeatMs: 60_000,
    });
    const writer = await store.acquireWriter();
    await store.append("user/input", {
      run_id: "run-1",
      text: "lost before the first settle",
    });
    await writer.release();

    await assert.rejects(
      () =>
        core.createRuntime({
          cwd: projectRoot,
          environment: { ...process.env, CODEPUNK_HOME: paths.home },
          sessionId: store.sessionId,
          allowMissingModel: true,
        }),
      /events but no agent-state\.json; refusing to resume empty/u,
    );
  });
});

test("corrupt or newer agent state stops resume", async () => {
  await withTempDirectory(async (rootDir) => {
    const store = await createStore(rootDir);
    const writer = await store.acquireWriter();
    await store.append("user/input", { run_id: "run-1", text: "hello" });
    await store.saveAgentState({ id: "pi-header" }, []);
    await writer.release();

    await writeFile(store.paths.statePath, "{not-json", "utf8");
    await assert.rejects(() => store.resume(), /agent-state|JSON/u);

    await writeFile(
      store.paths.statePath,
      `${JSON.stringify({
        version: 1,
        session_version: core.PI_SESSION_VERSION_CURRENT + 1,
        pi_version: "1.5.2",
        session_id: store.sessionId,
        saved_at: new Date().toISOString(),
        header: { id: "pi-header" },
        branch: [],
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => store.resume(),
      (error) => error.name === "ProtocolError",
    );
  });
});

test("the store creates no Pi session file", async () => {
  await withTempDirectory(async (rootDir) => {
    const store = await createStore(rootDir);
    const writer = await store.acquireWriter();
    await store.append("user/input", { run_id: "run-1", text: "hello" });
    await store.saveAgentState({ id: "pi-header" }, []);
    await writer.release();
    const entries = await readdir(store.paths.sessionDir);
    assert.deepEqual(entries.sort(), [
      "agent-state.json",
      "session-meta.json",
      "session.jsonl",
    ]);
    assert.equal(core.LOCK_HEARTBEAT_MS, 5_000);
    assert.equal(core.LOCK_LEASE_MS, 30_000);
  });
});

test("explicit session ids cannot escape the project session directory", async () => {
  await withTempDirectory(async (rootDir) => {
    const projectId = core.projectIdFor("/workspace");
    const outsideSession = path.join(rootDir, "projects", projectId, "escape");
    const outsideProject = path.join(rootDir, "projects", "escape");
    await assert.rejects(
      () =>
        core.SessionStore.create({
          rootDir,
          cwd: "/workspace",
          sessionId: "../escape",
        }),
      /session id is not safe/u,
    );
    await assert.rejects(
      () =>
        core.SessionStore.open({
          rootDir,
          cwd: "/workspace",
          sessionId: "../../escape",
        }),
      /session id is not safe/u,
    );
    await assert.rejects(() => fsPromises.access(outsideSession), /ENOENT/u);
    await assert.rejects(() => fsPromises.access(outsideProject), /ENOENT/u);
  });
});

test("a truncated session log is corrupt", async () => {
  await withTempDirectory(async (rootDir) => {
    const store = await createStore(rootDir);
    await writeFile(store.paths.logPath, '{"type":"codepunk/session"', "utf8");
    await assert.rejects(
      () =>
        core.SessionStore.open({
          rootDir,
          cwd: "/workspace",
          sessionId: store.sessionId,
        }),
      /truncated/u,
    );
  });
});

test("fork clones a settled session with an evidence-bound parent link", async () => {
  await withTempDirectory(async (rootDir) => {
    const projectId = core.projectIdFor("/workspace");
    const parent = await createStore(rootDir);
    const parentWriter = await parent.acquireWriter();
    await parent.append("user/input", {
      run_id: "run-parent",
      text: "parent prompt",
    });
    await parent.saveAgentState(
      {
        type: "session",
        version: 3,
        id: parent.sessionId,
        timestamp: "2026-11-12T00:00:00.000Z",
        cwd: "/workspace",
      },
      [
        {
          type: "message",
          id: "entry-1",
          parentId: null,
          timestamp: "2026-11-12T00:00:00.000Z",
          message: { role: "user", content: "parent prompt" },
        },
      ],
    );
    await parentWriter.release();

    const result = await core.forkSession({
      rootDir,
      cwd: "/workspace",
      projectRoot: "/workspace",
      projectId,
      parentSessionId: parent.sessionId,
    });
    assert.equal(result.parentSessionId, parent.sessionId);
    assert.equal(result.parentLastSeq, 1);
    assert.equal(result.parentEvents, 1);
    assert.equal(result.forkEntries, 1);

    const child = await core.SessionStore.open({
      rootDir,
      cwd: "/workspace",
      projectId,
      sessionId: result.sessionId,
    });
    assert.equal(child.header.parent_session_id, parent.sessionId);
    assert.equal(child.header.fork_entry_id, "entry-1");
    assert.equal(child.allEvents[0].kind, "session/forked");
    assert.equal(child.allEvents[0].data.parent_session_id, parent.sessionId);
    assert.equal(child.allEvents[0].data.parent_last_seq, 1);
    assert.equal(child.allEvents[0].data.fork_entry_id, "entry-1");
    assert.match(child.allEvents[0].data.parent_state_sha256, /^sha256:/u);
    const resume = await child.resume();
    assert.equal(resume.state.header.id, result.sessionId);
    assert.equal(resume.state.header.parentSession, undefined);
    assert.equal(child.header.parent_session_id, parent.sessionId);
    assert.equal(resume.state.header.cwd, "/workspace");
    assert.equal(resume.state.session_id, result.sessionId);
    assert.deepEqual(resume.state.branch, [
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp: "2026-11-12T00:00:00.000Z",
        message: { role: "user", content: "parent prompt" },
      },
    ]);
    assert.equal(parent.lastSeq, 1);
  });
});

test("fork refuses a live parent and a missing settled state", async () => {
  await withTempDirectory(async (rootDir) => {
    const projectId = core.projectIdFor("/workspace");
    const parent = await createStore(rootDir);
    const liveWriter = await parent.acquireWriter();
    await parent.append("user/input", {
      run_id: "run-parent",
      text: "parent prompt",
    });
    await parent.saveAgentState({ id: "pi-parent" }, []);
    await assert.rejects(
      () =>
        core.forkSession({
          rootDir,
          cwd: "/workspace",
          projectRoot: "/workspace",
          projectId,
          parentSessionId: parent.sessionId,
        }),
      /live writer/u,
    );
    await liveWriter.release();

    const empty = await createStore(rootDir);
    await assert.rejects(
      () =>
        core.forkSession({
          rootDir,
          cwd: "/workspace",
          projectRoot: "/workspace",
          projectId,
          parentSessionId: empty.sessionId,
        }),
      /no agent state to fork/u,
    );
    const recovered = await empty.acquireWriter();
    await recovered.release();

    const unsettled = await createStore(rootDir);
    const unsettledWriter = await unsettled.acquireWriter();
    await unsettled.append("user/input", {
      run_id: "run-unsettled",
      text: "settled event",
    });
    await unsettled.saveAgentState({ id: "pi-unsettled" }, []);
    await unsettled.append("user/input", {
      run_id: "run-unsettled",
      text: "crash-window event",
    });
    await unsettledWriter.release();
    await assert.rejects(
      () =>
        core.forkSession({
          rootDir,
          cwd: "/workspace",
          projectRoot: "/workspace",
          projectId,
          parentSessionId: unsettled.sessionId,
        }),
      /events beyond its saved agent state/u,
    );
  });
});

test("export links redacted events to raw record hashes", async () => {
  await withTempDirectory(async (rootDir) => {
    const store = await createStore(rootDir);
    const writer = await store.acquireWriter();
    await store.append("user/input", {
      run_id: "run-export",
      text: `token=${"sk-" + "4091994045dxivhoumfq"}`,
    });
    await store.append("user/input", {
      run_id: "run-export",
      text: "plain event",
    });
    await writer.release();

    const exported = await core.exportSession(store, rootDir);
    assert.match(exported.transcript, /\[REDACTED_API_KEY\]/u);
    assert.doesNotMatch(exported.transcript, /4091994045dxivhoumfq/u);
    assert.equal(exported.manifest.records.length, 2);
    assert.deepEqual(
      exported.manifest.records.map((record) => record.seq),
      [1, 2],
    );
    assert.equal(exported.manifest.records[0].redacted, true);
    assert.equal(exported.manifest.records[1].redacted, false);
    const rawLines = (await readFile(store.paths.logPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    assert.equal(exported.manifest.header_sha256, core.sha256Text(rawLines[0]));
    assert.equal(
      exported.manifest.records[0].raw_sha256,
      core.sha256Text(rawLines[1]),
    );
    assert.equal(
      exported.manifest.records[1].raw_sha256,
      core.sha256Text(rawLines[2]),
    );
  });
});

test("session tree shows sibling branches, labels, and the active leaf", async () => {
  await withTempDirectory(async (rootDir) => {
    const store = await core.SessionStore.create({
      rootDir,
      cwd: "/workspace",
      projectId: "tree-project",
      now: advancingClock(),
      heartbeatMs: 60_000,
    });
    const writer = await store.acquireWriter();
    const root = {
      id: "entry-root",
      parentId: null,
      timestamp: "2026-11-12T00:00:00.000Z",
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "root prompt" }],
      },
    };
    const active = {
      id: "entry-active",
      parentId: root.id,
      timestamp: "2026-11-12T00:00:01.000Z",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "active answer" }],
      },
    };
    const sibling = {
      id: "entry-sibling",
      parentId: root.id,
      timestamp: "2026-11-12T00:00:02.000Z",
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "sibling prompt" }],
      },
    };
    const labelEntry = {
      id: "entry-label",
      parentId: sibling.id,
      timestamp: "2026-11-12T00:00:03.000Z",
      type: "label",
      targetId: sibling.id,
      label: "experiment",
    };
    await store.saveAgentState(
      {
        type: "session",
        id: "pi-tree",
        cwd: "/workspace",
        timestamp: "2026-11-12T00:00:00.000Z",
      },
      [root, active],
      {
        entries: [root, active, sibling, labelEntry],
        leafId: active.id,
      },
    );
    await writer.release();

    const tree = await core.readSessionTree(store);
    assert.ok(tree);
    assert.equal(tree.session_id, store.sessionId);
    assert.equal(tree.leaf_id, active.id);
    assert.deepEqual(
      tree.entries.map((entry) => [entry.id, entry.depth, entry.active]),
      [
        [root.id, 0, true],
        [active.id, 1, true],
        [sibling.id, 1, false],
        [labelEntry.id, 2, false],
      ],
    );
    assert.equal(tree.entries[0].child_count, 2);
    assert.equal(tree.entries[2].label, "experiment");
    assert.equal(tree.entries[2].preview, "sibling prompt");
    const text = core.formatSessionTree(tree);
    assert.match(text, /\+ entry-root\s+message:user/u);
    assert.match(text, /\*\s+entry-active\s+message:assistant\s+\(leaf\)/u);
    assert.match(text, /-\s+entry-sibling\s+message:user \[experiment\]/u);
    assert.match(text, /leaf: entry-active/u);
  });
});

test("session graph orders children by their fork point", async () => {
  await withTempDirectory(async (rootDir) => {
    const parent = await core.SessionStore.create({
      rootDir,
      cwd: "/workspace",
      projectId: "graph-project",
      now: advancingClock(),
      heartbeatMs: 60_000,
    });
    const child = await core.SessionStore.create({
      rootDir,
      cwd: "/workspace",
      projectId: "graph-project",
      parentSessionId: parent.sessionId,
      forkEntryId: "entry-fork",
      now: advancingClock(),
      heartbeatMs: 60_000,
    });
    const graph = await core.readSessionGraph(rootDir, "graph-project");
    assert.deepEqual(
      graph.sessions.map((session) => [
        session.id,
        session.depth,
        session.parent_session_id,
        session.fork_entry_id,
      ]),
      [
        [parent.sessionId, 0, null, null],
        [child.sessionId, 1, parent.sessionId, "entry-fork"],
      ],
    );
    const text = core.formatSessionGraph(graph);
    assert.match(
      text,
      new RegExp(
        `${parent.sessionId} .*\\n\\s+${child.sessionId} .*from ${parent.sessionId} @ entry-fork`,
        "u",
      ),
    );
  });
});
