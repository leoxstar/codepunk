import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import { createDeferredStream, TEST_MODEL } from "./support/pi-model.mjs";

const core = await importCore();

async function setup() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "codepunk-steer-")),
  );
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  return { root, project, home };
}

async function createHost(setupPaths, runId) {
  const ledger = await core.EvidenceLedger.open(
    path.join(setupPaths.root, "evidence.jsonl"),
  );
  const store = await core.SessionStore.create({
    rootDir: setupPaths.home,
    cwd: setupPaths.project,
    sessionId: "session-steer",
    heartbeatMs: 60_000,
  });
  const host = await core.createPiHost({
    cwd: setupPaths.project,
    workspaceRoot: setupPaths.project,
    deliveryRoot: setupPaths.project,
    codepunkHome: setupPaths.home,
    sessionId: store.sessionId,
    runId,
    writeSet: [setupPaths.project],
    mode: "interactive",
    approval: null,
    ledger,
    sandbox: null,
    sessionStore: store,
    model: TEST_MODEL,
  });
  return { host, store, ledger };
}

async function waitFor(predicate, message = "condition was not reached") {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function containsText(messages, marker) {
  return JSON.stringify(messages).includes(marker);
}

test("steering and follow-up are queued and delivered in order", async () => {
  const paths = await setup();
  const { host, store } = await createHost(paths, "run-steer");
  try {
    await host.services.modelRuntime.setRuntimeApiKey("openai", "test-key");
    const calls = [];
    const pending = [];
    host.session.agent.streamFunction = (model, context) => {
      calls.push(structuredClone(context.messages));
      const deferred = createDeferredStream(model);
      pending.push(deferred);
      return deferred.stream;
    };
    const events = [];
    const queueStates = [];
    host.session.subscribe((event) => {
      events.push(event.type);
      if (event.type === "queue_update") {
        queueStates.push({
          steering: [...event.steering],
          followUp: [...event.followUp],
        });
      }
    });

    const prompt = host.session.prompt("start the run");
    await waitFor(() => pending.length === 1 && host.session.isStreaming);

    assert.equal(host.session.isStreaming, true);
    assert.equal(await host.session.steer("steer-marker"), "queued");
    assert.equal(await host.session.followUp("follow-marker"), "queued");
    assert.deepEqual(host.session.getSteeringMessages(), ["steer-marker"]);
    assert.deepEqual(host.session.getFollowUpMessages(), ["follow-marker"]);
    assert.ok(
      queueStates.some(
        (state) =>
          state.steering.includes("steer-marker") &&
          state.followUp.includes("follow-marker"),
      ),
    );

    pending[0].finish("first answer");
    await waitFor(() => pending.length === 2);
    assert.equal(containsText(calls[1], "steer-marker"), true);
    assert.equal(containsText(calls[1], "follow-marker"), false);

    pending[1].finish("steered answer");
    await waitFor(() => pending.length === 3);
    assert.equal(containsText(calls[2], "steer-marker"), true);
    assert.equal(containsText(calls[2], "follow-marker"), true);
    assert.ok(
      JSON.stringify(calls[2]).indexOf("steer-marker") <
        JSON.stringify(calls[2]).indexOf("follow-marker"),
    );

    pending[2].finish("follow-up answer");
    await prompt;

    assert.equal(calls.length, 3);
    assert.equal(host.session.getSteeringMessages().length, 0);
    assert.equal(host.session.getFollowUpMessages().length, 0);
    assert.ok(events.includes("queue_update"));
    assert.ok(events.includes("agent_settled"));
    assert.equal(
      queueStates.at(-1).steering.length,
      0,
      "the steering queue must be empty after delivery",
    );
    assert.equal(
      queueStates.at(-1).followUp.length,
      0,
      "the follow-up queue must be empty after delivery",
    );
    const end = store.allEvents.find(
      (event) => event.kind === "run/end" && event.data.run_id === "run-steer",
    );
    assert.ok(end);
    assert.equal(end.data.state, "settled");
  } finally {
    await host.dispose();
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test("abort makes the run terminal and does not deliver queued input", async () => {
  const paths = await setup();
  const { host, store } = await createHost(paths, "run-steer-abort");
  try {
    await host.services.modelRuntime.setRuntimeApiKey("openai", "test-key");
    let calls = 0;
    host.session.agent.streamFunction = (model, _context, options) => {
      calls += 1;
      const deferred = createDeferredStream(model);
      options.signal.addEventListener("abort", () => deferred.abort(), {
        once: true,
      });
      return deferred.stream;
    };
    const settled = [];
    host.session.subscribe((event) => {
      if (event.type === "agent_settled") {
        settled.push(event.aborted);
      }
    });

    const prompt = host.session.prompt("start a long run");
    await waitFor(() => calls === 1 && host.session.isStreaming);
    assert.equal(await host.session.steer("must-not-run"), "queued");

    await host.session.abort();
    await prompt;

    assert.equal(calls, 1);
    assert.equal(host.session.isIdle, true);
    assert.deepEqual(settled, [true]);
    const runs = store.allEvents.filter((event) => event.kind === "run/start");
    assert.equal(runs.length, 1);
    const end = store.allEvents.find(
      (event) =>
        event.kind === "run/end" && event.data.run_id === "run-steer-abort",
    );
    assert.ok(end);
    assert.equal(end.data.state, "aborted");

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      calls,
      1,
      "an aborted run must not continue into another model turn",
    );
  } finally {
    await host.dispose();
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});
