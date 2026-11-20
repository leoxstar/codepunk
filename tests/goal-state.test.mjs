import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importCore, importSource } from "./support/core.mjs";
import { installScriptedStream, TEST_MODEL } from "./support/pi-model.mjs";

const core = await importCore();
const goalModule = await importSource("packages/core/src/session/goal.ts");

async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codepunk-goal-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function advancingClock() {
  let current = new Date("2026-11-20T00:00:00.000Z");
  return () => {
    const value = new Date(current);
    current = new Date(current.getTime() + 1000);
    return value;
  };
}

async function openSession(rootDir, options = {}) {
  const store = await core.SessionStore.create({
    rootDir,
    cwd: "/workspace",
    now: advancingClock(),
    heartbeatMs: 60_000,
    ...options,
  });
  const writer = await store.acquireWriter();
  return { store, writer };
}

test("goal state survives turns, unrelated events, reopen, pause, and clear", async () => {
  await withTempDirectory(async (rootDir) => {
    const { store: first, writer: firstWriter } = await openSession(rootDir);
    const controller = new goalModule.GoalController(first, {
      now: advancingClock(),
    });
    const set = await controller.set("Ship the migration safely");
    assert.equal(set.kind, "goal/update");
    assert.equal(set.data.action, "set");
    assert.equal(set.data.previous_sha256, null);
    assert.equal(set.data.goal.revision, 1);
    assert.equal(set.data.goal.status, "active");
    assert.equal(
      set.data.event_sha256,
      core.sha256Text(
        core.canonicalJson({
          action: "set",
          previous_sha256: null,
          goal: set.data.goal,
        }),
      ),
    );

    const firstState = goalModule.readGoalState(first.allEvents);
    assert.equal(firstState.objective, "Ship the migration safely");
    assert.match(
      goalModule.goalModelContext(first.allEvents),
      /^Goal \(untrusted data\):/u,
    );
    await first.append("user/input", {
      run_id: "run-1",
      text: "start the next turn",
    });
    await firstWriter.release();
    const reopenedFirst = await core.SessionStore.open({
      rootDir,
      cwd: "/workspace",
      sessionId: first.sessionId,
      now: advancingClock(),
      heartbeatMs: 60_000,
    });
    const reopenedFirstWriter = await reopenedFirst.acquireWriter();
    assert.deepEqual(
      goalModule.readGoalState(reopenedFirst.allEvents),
      firstState,
    );
    const compaction = await reopenedFirst.append("compaction/decision", {
      run_id: "run-1",
      reason: "manual",
      cancelled: false,
      entries: 2,
      keep_recent_tokens: 5,
      evidence_head: null,
    });
    assert.equal(compaction.kind, "compaction/decision");
    assert.equal(
      goalModule.readGoalState(reopenedFirst.allEvents)?.status,
      "active",
    );
    await reopenedFirstWriter.release();

    const second = await core.SessionStore.open({
      rootDir,
      cwd: "/workspace",
      sessionId: first.sessionId,
      now: advancingClock(),
      heartbeatMs: 60_000,
    });
    const secondWriter = await second.acquireWriter();
    const secondController = new goalModule.GoalController(second, {
      now: advancingClock(),
    });
    const paused = await secondController.pause();
    assert.equal(paused.data.action, "pause");
    assert.equal(paused.data.goal.revision, 2);
    assert.equal(paused.data.previous_sha256, set.data.event_sha256);
    assert.equal(goalModule.readGoalState(second.allEvents)?.status, "paused");
    assert.equal(goalModule.goalModelContext(second.allEvents), null);

    const resumed = await secondController.resume();
    assert.equal(resumed.data.action, "resume");
    assert.equal(resumed.data.goal.revision, 3);
    assert.equal(resumed.data.goal.status, "active");
    assert.equal(resumed.data.previous_sha256, paused.data.event_sha256);

    const cleared = await secondController.clear();
    assert.equal(cleared.data.action, "clear");
    assert.equal(cleared.data.goal.status, "cleared");
    assert.equal(cleared.data.goal.revision, 3);
    assert.equal(cleared.data.goal.goal_id, set.data.goal.goal_id);
    assert.equal(cleared.data.goal.created_at, set.data.goal.created_at);
    assert.equal(goalModule.readGoalState(second.allEvents), null);
    assert.equal(goalModule.goalModelContext(second.allEvents), null);

    const reopened = await secondController.set("Ship a fresh goal");
    assert.equal(reopened.data.action, "set");
    assert.equal(reopened.data.previous_sha256, cleared.data.event_sha256);
    assert.notEqual(reopened.data.goal.goal_id, set.data.goal.goal_id);
    assert.notEqual(reopened.data.goal.created_at, set.data.goal.created_at);
    assert.equal(goalModule.readGoalState(second.allEvents)?.revision, 1);
    await secondWriter.release();
  });
});

test("a rejected append leaves the previous goal state intact", async () => {
  await withTempDirectory(async (rootDir) => {
    const { store, writer } = await openSession(rootDir);
    const controller = new goalModule.GoalController(store, {
      now: advancingClock(),
    });
    const set = await controller.set("Stay focused");
    await assert.rejects(() => controller.set("Replace without clearing"), {
      name: "GoalTransitionError",
    });
    await assert.rejects(
      () =>
        goalModule.appendGoalEvent(store, {
          action: "pause",
          previous_sha256: set.data.event_sha256,
          goal: {
            ...set.data.goal,
            status: "paused",
            revision: 5,
          },
        }),
      {
        name: "GoalCorruptError",
        message: /non-contiguous revision/u,
      },
    );
    assert.equal(
      goalModule.readGoalState(store.allEvents)?.objective,
      "Stay focused",
    );
    await writer.release();
  });
});

test("concurrent goal mutations are serialized and reject the losing set", async () => {
  await withTempDirectory(async (rootDir) => {
    const { store, writer } = await openSession(rootDir);
    const controller = new goalModule.GoalController(store, {
      now: advancingClock(),
    });

    const results = await Promise.allSettled([
      controller.set("first concurrent goal"),
      controller.set("second concurrent goal"),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "rejected"],
    );
    assert.equal(results[1].reason.name, "GoalTransitionError");

    const goalEvents = store.allEvents.filter(
      (event) => event.kind === "goal/update",
    );
    assert.equal(goalEvents.length, 1);
    assert.equal(goalEvents[0].seq, 1);
    assert.equal(
      goalModule.readGoalState(store.allEvents).objective,
      "first concurrent goal",
    );
    await writer.release();
  });
});

test("a failed metadata write rolls back the goal event", async () => {
  await withTempDirectory(async (rootDir) => {
    const { store, writer } = await openSession(rootDir);
    const controller = new goalModule.GoalController(store, {
      now: advancingClock(),
    });
    await controller.set("keep the committed goal");

    await rm(store.paths.metaPath, { force: true });
    await mkdir(store.paths.metaPath);

    await assert.rejects(() => controller.pause(), /EISDIR|ENOTDIR|directory/u);
    assert.equal(goalModule.readGoalState(store.allEvents)?.status, "active");
    const lines = (await readFile(store.paths.logPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(
      lines.some(
        (event) =>
          event.kind === "goal/update" && event.data.action === "pause",
      ),
      false,
    );
    await writer.release();
  });
});

test("action, status, objective, and revision spoofing fail closed", async () => {
  await withTempDirectory(async (rootDir) => {
    const { store, writer } = await openSession(rootDir);
    const controller = new goalModule.GoalController(store, {
      now: advancingClock(),
    });
    const set = await controller.set("immutable objective");
    const active = set.data.goal;
    const firstSet = store.allEvents.find(
      (event) => event.kind === "goal/update",
    );
    assert.ok(firstSet);
    const pausedFirstSet = {
      ...firstSet,
      data: {
        ...firstSet.data,
        goal: { ...firstSet.data.goal, status: "paused" },
      },
    };
    pausedFirstSet.data.event_sha256 = core.sha256Text(
      core.canonicalJson({
        action: pausedFirstSet.data.action,
        previous_sha256: pausedFirstSet.data.previous_sha256,
        goal: pausedFirstSet.data.goal,
      }),
    );
    assert.throws(
      () => goalModule.readGoalState([pausedFirstSet]),
      /goal set must produce an active goal/u,
    );

    await assert.rejects(
      () =>
        controller.update("pause", {
          ...active,
          status: "active",
          revision: 2,
        }),
      /must produce status paused/u,
    );
    await assert.rejects(
      () =>
        controller.update("pause", {
          ...active,
          status: "paused",
          objective: "changed objective",
          revision: 2,
        }),
      /inconsistent goal identity or objective/u,
    );
    await assert.rejects(
      () =>
        controller.update("clear", {
          ...active,
          status: "paused",
          revision: 2,
        }),
      /must produce status cleared/u,
    );
    await assert.rejects(
      () =>
        controller.update("pause", {
          ...active,
          status: "paused",
          revision: 7,
        }),
      /non-contiguous revision/u,
    );
    assert.deepEqual(goalModule.readGoalState(store.allEvents), active);
    await writer.release();
  });
});

test("tampered event hashes and broken chains fail closed", async () => {
  await withTempDirectory(async (rootDir) => {
    const { store, writer } = await openSession(rootDir);
    const controller = new goalModule.GoalController(store, {
      now: advancingClock(),
    });
    await controller.set("Original goal");
    await controller.pause();
    await controller.resume();
    const events = store.allEvents.map((event) => ({
      ...event,
      data: event.kind === "goal/update" ? { ...event.data } : event.data,
    }));
    events.at(-1).data.event_sha256 = "sha256:" + "0".repeat(64);
    assert.throws(() => goalModule.readGoalState(events), {
      name: "GoalCorruptError",
      message: /invalid event_sha256/u,
    });

    const broken = events.map((event) => ({
      ...event,
      data: event.kind === "goal/update" ? { ...event.data } : event.data,
    }));
    broken.at(-1).data.previous_sha256 = "sha256:" + "1".repeat(64);
    broken.at(-1).data.event_sha256 = core.sha256Text(
      core.canonicalJson({
        action: broken.at(-1).data.action,
        previous_sha256: broken.at(-1).data.previous_sha256,
        goal: broken.at(-1).data.goal,
      }),
    );
    assert.throws(() => goalModule.readGoalState(broken), {
      name: "GoalCorruptError",
      message: /broken previous_sha256 chain/u,
    });
    await writer.release();
  });
});

test("an on-disk goal event is rejected when opened after tampering", async () => {
  await withTempDirectory(async (rootDir) => {
    const { store, writer } = await openSession(rootDir);
    const controller = new goalModule.GoalController(store, {
      now: advancingClock(),
    });
    await controller.set("Persisted goal");
    const lines = (await readFile(store.paths.logPath, "utf8"))
      .trim()
      .split("\n");
    const event = JSON.parse(lines.at(-1));
    event.data.event_sha256 = "sha256:" + "2".repeat(64);
    lines[lines.length - 1] = JSON.stringify(event);
    await writeFile(store.paths.logPath, `${lines.join("\n")}\n`, "utf8");

    const opened = await core.SessionStore.open({
      rootDir,
      cwd: "/workspace",
      sessionId: store.sessionId,
      now: advancingClock(),
    });
    assert.throws(() => goalModule.readGoalState(opened.allEvents), {
      name: "GoalCorruptError",
      message: /invalid event_sha256/u,
    });
    await writer.release();
  });
});

test("the effective Pi system prompt follows active, paused, and clear states", async () => {
  await withTempDirectory(async (rootDir) => {
    const project = path.join(rootDir, "project");
    const home = path.join(rootDir, "home");
    await mkdir(project, { recursive: true });
    await mkdir(home, { recursive: true });
    const store = await core.SessionStore.create({
      rootDir: home,
      cwd: project,
      heartbeatMs: 60_000,
    });
    const ledger = await core.EvidenceLedger.open(
      path.join(rootDir, "evidence.jsonl"),
    );
    const host = await core.createPiHost({
      cwd: project,
      workspaceRoot: project,
      deliveryRoot: project,
      codepunkHome: home,
      sessionId: store.sessionId,
      runId: "run-goal-context",
      writeSet: [project],
      mode: "interactive",
      approval: null,
      ledger,
      sandbox: null,
      sessionStore: store,
      model: TEST_MODEL,
    });
    try {
      await host.services.modelRuntime.setRuntimeApiKey("openai", "test-key");
      const systemPrompts = [];
      installScriptedStream(host.session, () => {
        systemPrompts.push(host.session.systemPrompt);
        return { type: "text", text: "ok" };
      });
      const controller = new goalModule.GoalController(store, {
        now: advancingClock(),
      });

      await controller.set("goal-context-canary");
      await host.session.prompt("active turn");
      assert.match(systemPrompts[0], /Goal \(untrusted data\):/u);
      assert.match(systemPrompts[0], /goal-context-canary/u);

      await controller.pause();
      await host.session.prompt("paused turn");
      assert.doesNotMatch(systemPrompts[1], /goal-context-canary/u);

      await controller.resume();
      await host.session.prompt("resumed turn");
      assert.match(systemPrompts[2], /goal-context-canary/u);

      await controller.clear();
      await host.session.prompt("cleared turn");
      assert.doesNotMatch(systemPrompts[3], /goal-context-canary/u);
    } finally {
      await host.dispose();
    }
  });
});

test("corrupt Goal state blocks the model request and writes goal/error", async () => {
  await withTempDirectory(async (rootDir) => {
    const project = path.join(rootDir, "project");
    const home = path.join(rootDir, "home");
    await mkdir(project, { recursive: true });
    await mkdir(home, { recursive: true });
    const store = await core.SessionStore.create({
      rootDir: home,
      cwd: project,
      heartbeatMs: 60_000,
    });
    const ledger = await core.EvidenceLedger.open(
      path.join(rootDir, "evidence.jsonl"),
    );
    const host = await core.createPiHost({
      cwd: project,
      workspaceRoot: project,
      deliveryRoot: project,
      codepunkHome: home,
      sessionId: store.sessionId,
      runId: "run-goal-corrupt",
      writeSet: [project],
      mode: "interactive",
      approval: null,
      ledger,
      sandbox: null,
      sessionStore: store,
      model: TEST_MODEL,
    });
    try {
      await host.services.modelRuntime.setRuntimeApiKey("openai", "test-key");
      const controller = new goalModule.GoalController(store, {
        now: advancingClock(),
      });
      await controller.set("corrupt-goal-canary");
      const goalEvent = store.allEvents.findLast(
        (event) => event.kind === "goal/update",
      );
      assert.ok(goalEvent);
      goalEvent.data.event_sha256 = `sha256:${"0".repeat(64)}`;
      const modelCalls = installScriptedStream(host.session, () => ({
        type: "text",
        text: "must not run",
      }));
      const messagesBeforePrompt = host.session.messages.slice();

      await host.session.prompt("blocked turn");
      assert.equal(modelCalls.length, 0);
      const goalError = store.allEvents.findLast(
        (event) => event.kind === "goal/error",
      );
      assert.ok(goalError);
      assert.equal(goalError.data.code, "goal.corrupt");
      assert.match(goalError.data.reason, /invalid event_sha256/u);
      assert.deepEqual(host.session.messages, messagesBeforePrompt);
      assert.equal(
        store.allEvents.some((event) => event.kind === "user/input"),
        false,
      );
    } finally {
      await host.dispose();
    }
  });
});
