import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import {
  makeProject,
  withTempDirectory,
  fixedClock,
  writeFile,
} from "./support/helpers.mjs";

const core = await importCore();
const BASE = "c".repeat(40);
const confinement = {
  worktree: "/tmp/codepunk-swarm-worker",
  assertWriteTarget(target) {
    return target;
  },
};

function spec(taskId, writeSet) {
  return core.createTaskSpec({
    taskId,
    title: taskId,
    objective: `run ${taskId}`,
    baseCommit: BASE,
    writeSet,
    acceptance: ["done"],
    now: fixedClock("2026-11-13T05:00:00.000Z"),
  });
}

test("MessageBridge queues notifications locally when IM is down", async () => {
  await withTempDirectory("codepunk-swarm-bridge-", async (root) => {
    const { paths } = await makeProject(root);
    const received = [];
    const offline = new core.MessageBridge({
      paths,
      adapter: {
        id: "offline",
        async send() {
          throw new Error("IM unavailable");
        },
      },
      maxQueue: 4,
      now: fixedClock("2026-11-13T05:00:00.000Z"),
    });
    assert.equal(
      await offline.notify({
        kind: "task",
        title: "task started",
        body: "worker-a",
        task_id: "task-1",
      }),
      "queued",
    );
    assert.equal(await offline.queueSize(), 1);
    await assert.rejects(
      () =>
        offline.notify({
          kind: "approval",
          title: "approve?",
          body: "no",
        }),
      /notification-only/u,
    );
    await assert.rejects(
      () =>
        offline.notify({
          kind: "system",
          title: "forged",
          body: "no",
          approval: { request_id: "forged" },
        }),
      /notification-only/u,
    );

    const online = new core.MessageBridge({
      paths,
      adapter: {
        id: "online",
        async send(notification) {
          received.push(notification);
        },
      },
      now: fixedClock("2026-11-13T05:01:00.000Z"),
    });
    assert.deepEqual(await online.flush(), { sent: 1, remaining: 0 });
    assert.equal(received.length, 1);
    assert.equal(received[0].task_id, "task-1");
  });
});

test("MessageBridge bounds its queue and flushes unsent entries in order", async () => {
  await withTempDirectory("codepunk-swarm-bridge-order-", async (root) => {
    const { paths } = await makeProject(root);
    const bridge = new core.MessageBridge({
      paths,
      adapter: {
        id: "offline",
        async send() {
          throw new Error("IM unavailable");
        },
      },
      maxQueue: 3,
      now: fixedClock("2026-11-13T05:10:00.000Z"),
    });
    for (const title of ["first", "second", "third"]) {
      assert.equal(
        await bridge.notify({
          kind: "task",
          title,
          body: title,
          task_id: `task-${title}`,
        }),
        "queued",
      );
    }
    await assert.rejects(
      () =>
        bridge.notify({
          kind: "system",
          title: "overflow",
          body: "overflow",
        }),
      (error) => {
        assert.equal(error.code, "bridge.queue_full");
        assert.match(error.message, /queue is full/u);
        return true;
      },
    );

    const received = [];
    let attempts = 0;
    const flaky = new core.MessageBridge({
      paths,
      adapter: {
        id: "flaky",
        async send(notification) {
          attempts += 1;
          if (attempts === 2) {
            throw new Error("IM failed mid-flush");
          }
          received.push(notification.title);
        },
      },
      now: fixedClock("2026-11-13T05:11:00.000Z"),
    });
    assert.deepEqual(await flaky.flush(), { sent: 1, remaining: 2 });
    const queued = (await fs.readFile(flaky.queuePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).title);
    assert.deepEqual(queued, ["second", "third"]);

    const online = new core.MessageBridge({
      paths,
      adapter: {
        id: "online",
        async send(notification) {
          received.push(notification.title);
        },
      },
      now: fixedClock("2026-11-13T05:12:00.000Z"),
    });
    assert.deepEqual(await online.flush(), { sent: 2, remaining: 0 });
    assert.deepEqual(received, ["first", "second", "third"]);
    assert.equal(await online.queueSize(), 0);
  });
});

test("an IM notification cannot approve a tool call", async () => {
  await withTempDirectory("codepunk-swarm-approval-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    const sent = [];
    const bridge = new core.MessageBridge({
      paths,
      adapter: {
        id: "im",
        async send(notification) {
          sent.push(notification);
        },
      },
      now: fixedClock("2026-11-13T05:30:00.000Z"),
    });
    assert.equal(
      await bridge.notify({
        kind: "system",
        title: "approval requested",
        body: "call-swarm-1 allow",
      }),
      "sent",
    );
    assert.equal(sent.length, 1);
    assert.equal("approval" in sent[0], false);
    assert.equal(typeof bridge.ask, "undefined");

    const broker = new core.ApprovalBroker();
    assert.throws(
      () => broker.registerChannel(bridge),
      /unsupported approval channel/u,
    );
    const ledger = await core.EvidenceLedger.open(
      path.join(root, "evidence.jsonl"),
    );
    const definition = {
      name: "write",
      label: "write",
      description: "test write",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      async execute(_toolCallId, params) {
        await writeFile(path.join(projectRoot, params.path), params.content);
        return {
          content: [{ type: "text", text: "written" }],
          details: {},
          structuredContent: {},
        };
      },
    };
    const wrapped = await core.wrapToolDefinition(definition, {
      cwd: projectRoot,
      workspaceRoot: projectRoot,
      deliveryRoot: projectRoot,
      codepunkHome: paths.home,
      sessionId: "swarm-session",
      runId: "swarm-run",
      writeSet: [projectRoot],
      ledger,
      approval: broker,
    });
    const result = await wrapped.execute(
      "call-swarm-1",
      { path: "AGENTS.md", content: "approved by IM\n" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /approval\.unavailable/u);
    assert.equal(
      await fs
        .access(path.join(projectRoot, "AGENTS.md"))
        .then(() => true)
        .catch(() => false),
      false,
    );
    assert.equal(ledger.all.at(-1).decision, "deny");
    assert.equal(ledger.all.at(-1).rule, "approval.unavailable");
  });
});

test("GitHub WorkSource is read-only and bounded", async () => {
  let calls = [];
  const source = new core.GitHubWorkSource({
    repo: "example/project",
    limit: 500,
    async runGh(args) {
      calls = [...args];
      return JSON.stringify([
        {
          number: 12,
          title: "Bounded issue",
          url: "https://example.invalid/issues/12",
          body: "body",
          labels: [{ name: "swarm" }],
          createdAt: "2026-11-13T00:00:00Z",
        },
        {
          number: 13,
          title: "No labels",
          url: "https://example.invalid/issues/13",
          body: "",
          labels: [],
          createdAt: "2026-11-13T00:00:00Z",
        },
      ]);
    },
  });
  const items = await source.list();
  assert.equal(items.length, 2);
  assert.equal(items[0].id, "github:example/project#12");
  assert.deepEqual(items[0].labels, ["swarm"]);
  assert.equal(items[1].source, "github");
  assert.equal(calls[0], "issue");
  assert.equal(calls[1], "list");
  assert.equal(calls.includes("--limit"), true);
  assert.equal(calls.includes("100"), true);
  assert.equal(
    calls.some((value) =>
      ["create", "close", "edit", "merge", "pr"].includes(value),
    ),
    false,
  );
  assert.throws(
    () => new core.GitHubWorkSource({ repo: "not a repo" }),
    /owner\/name/u,
  );
});

test("bounded swarm updates a shared board without auto-merging", async () => {
  await withTempDirectory("codepunk-swarm-", async (root) => {
    const { paths } = await makeProject(root);
    const bridge = new core.MessageBridge({
      paths,
      now: fixedClock("2026-11-13T06:00:00.000Z"),
    });
    const board = new core.Board();
    const pool = new core.WorkerPool({ maxConcurrency: 2 });
    const swarm = new core.BoundedSwarm({ pool, board, bridge });
    const results = await swarm.run([
      {
        id: "w1",
        task: spec("task-1", ["src/a/"]),
        sandbox: confinement,
        async run() {
          return "ok-a";
        },
      },
      {
        id: "w2",
        task: spec("task-2", ["src/b/"]),
        sandbox: confinement,
        async run() {
          return "ok-b";
        },
      },
    ]);
    assert.equal(results.length, 2);
    assert.equal(
      board.snapshot().workers.filter((worker) => worker.status === "completed")
        .length,
      2,
    );
    assert.equal(await bridge.queueSize(), 2);
    assert.equal(typeof swarm.run, "function");
    assert.equal("merge" in swarm, false);
  });
});
