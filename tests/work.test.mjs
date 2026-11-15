import assert from "node:assert/strict";
import test from "node:test";
import { importCore, importProtocol } from "./support/core.mjs";

const core = await importCore();
const protocol = await importProtocol();

function event(kind, data, seq = 1) {
  return {
    type: "codepunk/event",
    version: 1,
    seq,
    at: "2026-11-14T00:00:00.000Z",
    kind,
    data,
  };
}

test("plan and todo updates are durable across run boundaries", async () => {
  const persisted = [];
  const plan = await core.updatePlan(
    {
      runId: "run-1",
      now: () => new Date("2026-11-14T00:00:00.000Z"),
      persist: async (value) => {
        persisted.push(event("plan/update", value, 1));
      },
    },
    {
      plan: [
        { step: "inspect the repository", status: "completed" },
        { step: "implement the fix", status: "in_progress" },
      ],
      explanation: "keep the change bounded",
    },
  );
  assert.ok("state" in plan);
  assert.match(plan.text, /\[x\] inspect the repository/u);
  assert.match(plan.text, /\[>\] implement the fix/u);

  const todos = await core.updateTodos(
    {
      runId: "run-1",
      now: () => new Date("2026-11-14T00:00:01.000Z"),
      persist: async (value) => {
        persisted.push(event("todo/update", value, 2));
      },
    },
    {
      todos: [
        { content: "add negative controls", status: "pending" },
        { content: "run the local gate", status: "completed" },
      ],
    },
  );
  assert.ok("state" in todos);
  assert.match(todos.text, /\[ \] add negative controls/u);

  persisted.push(
    event(
      "run/end",
      {
        run_id: "run-1",
        state: "settled",
        termination: null,
        evidence_head: null,
        actor: "local-user",
      },
      3,
    ),
    event("run/start", { run_id: "run-2", session_id: "session-work" }, 4),
  );

  const snapshot = core.readWorkState(persisted);
  assert.equal(snapshot.plan?.run_id, "run-1");
  assert.equal(snapshot.plan?.steps.length, 2);
  assert.equal(snapshot.plan?.sha256, plan.state.sha256);
  assert.equal(snapshot.todos?.items.length, 2);
  assert.equal(snapshot.todos?.sha256, todos.state.sha256);

  const oldRun = core.readWorkState(persisted, "run-1");
  assert.equal(oldRun.plan?.sha256, plan.state.sha256);
  const missingRun = core.readWorkState(persisted, "run-3");
  assert.equal(missingRun.plan, null);
  assert.equal(missingRun.todos, null);
});

test("invalid work state is rejected without persistence", async () => {
  let persisted = false;
  const badPlan = await core.updatePlan(
    {
      runId: "run-1",
      persist: async () => {
        persisted = true;
      },
    },
    {
      plan: [
        { step: "first", status: "in_progress" },
        { step: "second", status: "in_progress" },
      ],
    },
  );
  assert.equal(persisted, false);
  assert.match(badPlan.error, /only one plan step may be in_progress/u);

  const badTodo = await core.updateTodos(
    {
      runId: "run-1",
      persist: async () => {
        persisted = true;
      },
    },
    {
      todos: [{ content: "invalid status", status: "blocked" }],
    },
  );
  assert.equal(persisted, false);
  assert.match(badTodo.error, /status must be pending/u);

  const cleared = await core.updateTodos(
    {
      runId: "run-1",
      persist: async () => {
        persisted = true;
      },
    },
    { todos: [] },
  );
  assert.ok("state" in cleared);
  assert.equal(cleared.state.items.length, 0);
  assert.equal(persisted, true);
});

test("work event schemas reject unknown fields", () => {
  const plan = event(
    "plan/update",
    {
      run_id: "run-1",
      steps: [{ step: "one", status: "pending" }],
      explanation: null,
      updated_at: "2026-11-14T00:00:00.000Z",
      sha256: `sha256:${"a".repeat(64)}`,
      unexpected: true,
    },
    1,
  );
  assert.equal(
    protocol.validateSchema(protocol.SessionEventSchema, plan).ok,
    false,
  );
});
