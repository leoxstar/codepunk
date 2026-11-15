import assert from "node:assert/strict";
import test from "node:test";
import { importCore } from "./support/core.mjs";

const core = await importCore();
const BASE = "a".repeat(40);

function spec(taskId, writeSet) {
  return core.createTaskSpec({
    taskId,
    title: taskId,
    objective: `run ${taskId}`,
    baseCommit: BASE,
    writeSet,
    acceptance: ["done"],
  });
}

const confinement = {
  worktree: "/tmp/codepunk-pool-worker",
  assertWriteTarget(target) {
    return target;
  },
};

test("WorkerPool runs disjoint tasks concurrently and rejects overlap", async () => {
  let active = 0;
  let maximum = 0;
  const events = [];
  const pool = new core.WorkerPool({
    maxConcurrency: 2,
    onEvent: (event) => events.push(event),
  });
  const jobs = [
    {
      id: "w1",
      task: spec("task-1", ["src/a/"]),
      sandbox: confinement,
      async run({ signal }) {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
        assert.equal(signal.aborted, false);
        return "one";
      },
    },
    {
      id: "w2",
      task: spec("task-2", ["src/b/"]),
      sandbox: confinement,
      async run() {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
        return "two";
      },
    },
  ];
  const results = await pool.run(jobs);
  assert.equal(maximum, 2);
  assert.deepEqual(
    results.map((result) => result.status),
    ["completed", "completed"],
  );
  assert.equal(
    events.filter((event) => event.type === "worker/start").length,
    2,
  );
  assert.equal(events.filter((event) => event.type === "worker/end").length, 2);

  await assert.rejects(
    () =>
      pool.run([
        {
          id: "w-unconfined",
          task: spec("task-unconfined", ["src/c/"]),
          async run() {
            return null;
          },
        },
        {
          id: "w-confined",
          task: spec("task-confined", ["src/d/"]),
          sandbox: confinement,
          async run() {
            return null;
          },
        },
      ]),
    /WorkerSandbox confinement/u,
  );

  await assert.rejects(
    () =>
      pool.run([
        {
          id: "w3",
          task: spec("task-3", ["src/a/"]),
          async run() {
            return null;
          },
        },
        {
          id: "w4",
          task: spec("task-4", ["src/a/file.ts"]),
          async run() {
            return null;
          },
        },
      ]),
    /overlapping write sets/u,
  );
});

test("tool-call and wall-clock budgets stop only the over-budget worker", async () => {
  const pool = new core.WorkerPool({
    maxConcurrency: 1,
    budget: {
      maxWallMs: 20,
      maxToolCalls: 1,
      maxDiskBytes: 8192,
    },
  });
  const results = await pool.run([
    {
      id: "slow",
      task: spec("slow-task", ["src/slow/"]),
      async run({ signal }) {
        await new Promise((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
          setTimeout(resolve, 200);
        });
        return "late";
      },
    },
    {
      id: "tool-limit",
      task: spec("tool-task", ["src/tool/"]),
      async run({ consumeToolCall }) {
        consumeToolCall();
        consumeToolCall();
        return "unreachable";
      },
    },
    {
      id: "disk-limit",
      task: spec("disk-task", ["src/disk/"]),
      async run({ consumeDiskBytes }) {
        consumeDiskBytes(1024);
        consumeDiskBytes(9000);
        return "unreachable";
      },
    },
  ]);
  assert.equal(results[0].status, "cancelled");
  assert.equal(results[1].status, "cancelled");
  assert.match(results[1].error, /tool-call budget/u);
  assert.equal(results[1].usage.tool_calls, 2);
  assert.equal(results[2].status, "cancelled");
  assert.match(results[2].error, /disk budget/u);
  assert.equal(results[2].usage.disk_bytes, 10_024);
});

test("board is a projection and swarm policy requires disjoint budgeted work", () => {
  const board = new core.Board();
  board.setTask("task-1", "running", "worker-a");
  board.setWorker({
    id: "worker-a",
    task_id: "task-1",
    status: "running",
    error: null,
  });
  assert.equal(board.snapshot().tasks[0].state, "running");
  assert.equal(board.snapshot().workers.length, 1);
  assert.equal(
    core.decideSwarm({
      taskCount: 3,
      overlappingWriteSets: true,
      budget: 10,
      uncertainty: "high",
      reviewDepth: "high",
    }).mode,
    "reject",
  );
  assert.equal(
    core.decideSwarm({
      taskCount: 3,
      overlappingWriteSets: false,
      budget: 10,
      uncertainty: "high",
      reviewDepth: "high",
    }).workers,
    3,
  );
});
