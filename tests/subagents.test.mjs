import assert from "node:assert/strict";
import test from "node:test";
import { importCore, importProtocol } from "./support/core.mjs";

const core = await importCore();
const protocol = await importProtocol();
const BASE = "b".repeat(40);
const task = core.createTaskSpec({
  taskId: "subtask-1",
  title: "Subtask",
  objective: "Do a bounded subtask",
  baseCommit: BASE,
  writeSet: ["src/"],
  acceptance: ["summary"],
});

const fullMask = {
  read: true,
  write: true,
  edit: true,
  shell: true,
  search: true,
  memory_search: false,
};

const PERMISSIVE_PARENT = {
  approval: "ask",
  autonomy: "ask",
  tools: [
    "read",
    "write",
    "edit",
    "shell",
    "search",
    "memory_search",
    "plan",
    "todo",
  ],
};

test("child session is isolated, evidence-backed, and depth one", async () => {
  const subagent = new core.Subagent({
    parent_session_id: "parent",
    child_session_id: "child",
    task,
    isolation: "worktree",
    tool_mask: fullMask,
    permission_mode: "ask",
    parent_policy: PERMISSIVE_PARENT,
    depth: 0,
    worktree: "/tmp/worker-child",
    async run(context) {
      assert.equal(context.tool_mask.memory_search, false);
      assert.equal(context.write_set[0], "src/");
      return { summary: "done", evidence_head: `sha256:${"a".repeat(64)}` };
    },
  });
  const result = await subagent.run();
  assert.equal(result.parent_session_id, "parent");
  assert.equal(result.child_session_id, "child");
  assert.equal(result.depth, 1);
  assert.equal(result.summary, "done");
  assert.throws(() => subagent.spawnChild(), /depth is limited/u);
  await assert.rejects(() => subagent.run(), /already started/u);
});

test("memory_search, read-only mutation, shared escape, and depth one are denied", async () => {
  const base = {
    parent_session_id: "parent",
    child_session_id: "child",
    task,
    isolation: "worktree",
    tool_mask: { ...fullMask },
    permission_mode: "ask",
    parent_policy: PERMISSIVE_PARENT,
    depth: 0,
    worktree: "/tmp/worker-child",
    async run() {
      return { summary: "done", evidence_head: `sha256:${"a".repeat(64)}` };
    },
  };
  await assert.rejects(
    () =>
      new core.Subagent({
        ...base,
        tool_mask: { ...fullMask, memory_search: true },
      }).run(),
    /memory_search/u,
  );
  await assert.rejects(
    () =>
      new core.Subagent({
        ...base,
        permission_mode: "read-only",
      }).run(),
    /read-only/u,
  );
  await assert.rejects(
    () =>
      new core.Subagent({
        ...base,
        isolation: "shared",
        write_set: ["../parent/"],
      }).run(),
    /escapes/u,
  );
  await assert.rejects(
    () => new core.Subagent({ ...base, depth: 1 }).run(),
    /depth is limited/u,
  );
  await assert.rejects(
    () =>
      new core.Subagent({
        ...base,
        parent_session_id: "same",
        child_session_id: "same",
      }).run(),
    /distinct parent/u,
  );
});

test("action-level masks reject tools outside the child mask", () => {
  const mask = {
    read: true,
    write: false,
    edit: false,
    shell: false,
    search: true,
    memory_search: false,
  };
  assert.doesNotThrow(() => core.assertSubagentAction(mask, "read"));
  assert.doesNotThrow(() => core.assertSubagentAction(mask, "search"));
  assert.throws(
    () => core.assertSubagentAction(mask, "write"),
    /outside its mask/u,
  );
  assert.throws(
    () => core.assertSubagentAction(mask, "unknown"),
    /outside its mask/u,
  );
});

test("a child cannot exceed the parent's permission or tool ceiling", () => {
  const readOnlyMask = {
    read: true,
    write: false,
    edit: false,
    shell: false,
    search: true,
    memory_search: false,
  };
  assert.throws(
    () =>
      core.assertSubagentWithinParentPolicy(readOnlyMask, "read-only", {
        approval: "ask",
        autonomy: "ask",
        tools: ["search"],
      }),
    /parent's enabled tools/u,
  );
  assert.throws(
    () =>
      core.assertSubagentWithinParentPolicy(fullMask, "ask", {
        approval: "ask",
        autonomy: "read-only",
        tools: ["read", "write", "edit", "shell", "search"],
      }),
    /read-only parent/u,
  );
  assert.throws(
    () =>
      core.assertSubagentWithinParentPolicy(fullMask, "ask", {
        approval: "deny",
        autonomy: "ask",
        tools: ["read", "write", "edit", "shell", "search"],
      }),
    /deny-approval parent/u,
  );
  assert.doesNotThrow(() =>
    core.assertSubagentWithinParentPolicy(readOnlyMask, "read-only", {
      approval: "ask",
      autonomy: "read-only",
      tools: ["read", "search"],
    }),
  );
});

test("a subagent request without a parent policy fails closed", async () => {
  await assert.rejects(
    () =>
      new core.Subagent({
        parent_session_id: "parent",
        child_session_id: "child-no-parent-policy",
        task,
        isolation: "worktree",
        tool_mask: fullMask,
        permission_mode: "ask",
        depth: 0,
        worktree: "/tmp/worker-child",
        async run() {
          return { summary: "unreachable", evidence_head: "" };
        },
      }).run(),
    /explicit parent policy/u,
  );
});

test("subagent/result schema accepts complete results and rejects bad depth", () => {
  const event = {
    type: "codepunk/event",
    version: 1,
    seq: 1,
    at: "2026-11-12T00:00:00.000Z",
    kind: "subagent/result",
    data: {
      run_id: "run-1",
      parent_session_id: "parent",
      child_session_id: "child",
      depth: 1,
      isolation: "shared",
      model: "local/local-test",
      status: "completed",
      summary: "done",
      evidence_head: `sha256:${"a".repeat(64)}`,
      child_run_id: "child-run-1",
      exit_code: 0,
      error: null,
    },
  };
  assert.equal(
    protocol.validateSchema(protocol.SessionEventSchema, event).ok,
    true,
  );
  const invalid = structuredClone(event);
  invalid.data.depth = 0;
  assert.equal(
    protocol.validateSchema(protocol.SessionEventSchema, invalid).ok,
    false,
  );
});

test("nested host launches are denied by the worker boundary", () => {
  for (const command of [
    "codepunk doctor",
    "env -u CODEPUNK_DEPTH codepunk doctor",
    "pi --version",
    "node /opt/pi-coding-agent/index.js",
  ]) {
    assert.throws(() => core.assertWorkerCommand(command), /host/u, command);
  }
  assert.throws(
    () =>
      core.assertWorkerArgv([
        process.execPath,
        "/opt/pi-coding-agent/index.js",
      ]),
    /host/u,
  );
  assert.throws(() => core.assertWorkerArgv(["/tmp/codepunk"]), /host/u);
  assert.doesNotThrow(() =>
    core.assertWorkerCommand("git commit -m 'pi and codepunk notes'"),
  );
});

test("async dispatch supports status, send, stop, and a typed second spawn", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const dispatcher = new core.SubagentDispatcher();
  const handle = await dispatcher.dispatch({
    parent_session_id: "parent",
    child_session_id: "child-async",
    task,
    isolation: "worktree",
    tool_mask: fullMask,
    permission_mode: "ask",
    parent_policy: PERMISSIVE_PARENT,
    depth: 0,
    worktree: "/tmp/worker-child",
    async run(context) {
      await gate;
      return {
        summary: `messages=${context.messages.join(",")}`,
        evidence_head: `sha256:${"b".repeat(64)}`,
      };
    },
  });
  assert.equal(handle.status, "running");
  assert.equal(dispatcher.status("child-async").status, "running");
  dispatcher.send("child-async", "continue");
  await assert.rejects(
    () =>
      dispatcher.dispatch({
        parent_session_id: "parent",
        child_session_id: "child-async",
        task,
        isolation: "worktree",
        tool_mask: fullMask,
        permission_mode: "ask",
        parent_policy: PERMISSIVE_PARENT,
        depth: 0,
        worktree: "/tmp/worker-child",
        async run() {
          return { summary: "duplicate", evidence_head: "" };
        },
      }),
    /already started/u,
  );
  release();
  const completed = await dispatcher.wait("child-async");
  assert.equal(completed.status, "completed");
  assert.match(completed.result.summary, /continue/u);

  let stopChild;
  const stopped = await dispatcher.dispatch({
    parent_session_id: "parent",
    child_session_id: "child-stop",
    task,
    isolation: "worktree",
    tool_mask: fullMask,
    permission_mode: "ask",
    parent_policy: PERMISSIVE_PARENT,
    depth: 0,
    worktree: "/tmp/worker-child",
    async run(context) {
      stopChild = context;
      await new Promise((_, reject) => {
        context.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
      return { summary: "unreachable", evidence_head: "" };
    },
  });
  assert.equal(stopped.status, "running");
  dispatcher.stop("child-stop");
  const stoppedResult = await dispatcher.wait("child-stop");
  assert.equal(stoppedResult.status, "stopped");
  assert.ok(stopChild);
});

test("a spawn approval does not become a child approval", async () => {
  const parent = new core.ApprovalBroker();
  let parentAnswer = null;
  parent.registerChannel({
    id: "parent-tui",
    kind: "tui",
    isTTY: true,
    async ask(request) {
      parentAnswer = {
        request_id: request.request_id,
        answer: "allow",
        channel: "tui",
        channel_id: request.channel_id,
        nonce_sha256: request.nonce_sha256,
        worker_id: request.worker_id,
        session_id: request.session_id,
        tool_call_id: request.tool_call_id,
        answered_at: new Date().toISOString(),
      };
      return parentAnswer;
    },
  });
  const approved = await parent.request({
    sessionId: "parent",
    workerId: "parent",
    toolCallId: "spawn",
  });
  assert.equal(approved.approved, true);

  let childDenied = false;
  const subagent = new core.Subagent({
    parent_session_id: "parent",
    child_session_id: "child-approval",
    task,
    isolation: "worktree",
    tool_mask: fullMask,
    permission_mode: "ask",
    parent_policy: PERMISSIVE_PARENT,
    depth: 0,
    worktree: "/tmp/worker-child",
    spawn_approved: true,
    approval_channel: {
      id: "child-tui",
      kind: "tui",
      isTTY: true,
      async ask() {
        return parentAnswer;
      },
    },
    async run(context) {
      const replay = await context.approval.request({
        sessionId: "child-approval",
        workerId: "child-approval",
        toolCallId: "child-call",
      });
      childDenied = !replay.approved;
      return { summary: "checked", evidence_head: `sha256:${"c".repeat(64)}` };
    },
  });
  await subagent.run();
  assert.equal(childDenied, true);
});

test("a child does not inherit the parent's scoped autonomy", async () => {
  const cwd = process.cwd();
  const digest = await core.executableDigest("/bin/echo");
  const baseRule = {
    id: "parent-echo",
    argv: ["/bin/echo", "ok"],
    cwd,
    executable_sha256: digest,
  };
  const rule = {
    ...baseRule,
    rule_sha256: core.autonomyRuleHash(baseRule),
  };
  const parent = new core.AutonomyController({
    profile: "scoped",
    source: "cli",
    rules: [rule],
    rulesSha256: core.autonomyRulesHash([rule]),
  });
  assert.equal(
    (
      await parent.authorize({
        tool: "exec",
        argv: baseRule.argv,
        cwd,
      })
    )?.id,
    "parent-echo",
  );

  const child = new core.AutonomyController(core.childAutonomy());
  assert.equal(child.profile, "ask");
  assert.equal(
    await child.authorize({
      tool: "exec",
      argv: baseRule.argv,
      cwd,
    }),
    null,
  );
});

test("worktree and shared isolation require explicit run boundaries", async () => {
  const base = {
    parent_session_id: "parent",
    child_session_id: "child-boundary",
    task,
    tool_mask: fullMask,
    permission_mode: "ask",
    parent_policy: PERMISSIVE_PARENT,
    depth: 0,
    async run() {
      return { summary: "done", evidence_head: `sha256:${"d".repeat(64)}` };
    },
  };
  await assert.rejects(
    () =>
      new core.Subagent({
        ...base,
        isolation: "worktree",
      }).run(),
    /explicit worktree/u,
  );
  await assert.rejects(
    () =>
      new core.Subagent({
        ...base,
        isolation: "worktree",
        worktree: BASE,
      }).run(),
    /base commit is not a worktree/u,
  );
  await assert.rejects(
    () =>
      new core.Subagent({
        ...base,
        isolation: "shared",
        worktree: "/tmp/child-shared",
        parent_worktree: "/tmp/parent-shared",
        write_set: ["src/"],
      }).run(),
    /parent worktree/u,
  );

  assert.equal(
    core.assertSubagentWriteTarget(
      "/tmp/child-shared",
      ["src/"],
      "/tmp/child-shared/src/a.ts",
    ),
    "/tmp/child-shared/src/a.ts",
  );
  assert.throws(
    () =>
      core.assertSubagentWriteTarget(
        "/tmp/child-shared",
        ["src/"],
        "/tmp/child-shared/tests/a.ts",
      ),
    /write set/u,
  );
  assert.throws(
    () =>
      core.assertSubagentWriteTarget(
        "/tmp/child-shared",
        ["src/"],
        "/tmp/parent-shared/src/a.ts",
      ),
    /outside its run worktree/u,
  );
});

test("tool-call and disk budgets stop only that child", async () => {
  const boundedTask = core.createTaskSpec({
    taskId: "bounded-subtask",
    title: "Bounded subtask",
    objective: "Consume the child budget",
    baseCommit: BASE,
    writeSet: ["src/"],
    acceptance: ["summary"],
    budget: {
      maxWallMs: 10_000,
      maxToolCalls: 2,
      maxDiskBytes: 2048,
    },
  });
  await assert.rejects(
    () =>
      new core.Subagent({
        parent_session_id: "parent",
        child_session_id: "child-budget",
        task: boundedTask,
        isolation: "worktree",
        worktree: "/tmp/worker-child",
        tool_mask: fullMask,
        permission_mode: "ask",
        parent_policy: PERMISSIVE_PARENT,
        depth: 0,
        async run(context) {
          assert.equal(context.budget.max_tool_calls, 2);
          context.consumeToolCall();
          context.consumeToolCall();
          context.consumeToolCall();
          return { summary: "unreachable", evidence_head: "" };
        },
      }).run(),
    /tool-call budget/u,
  );
  await assert.rejects(
    () =>
      new core.Subagent({
        parent_session_id: "parent",
        child_session_id: "child-disk",
        task: boundedTask,
        isolation: "worktree",
        worktree: "/tmp/worker-child",
        tool_mask: fullMask,
        permission_mode: "ask",
        parent_policy: PERMISSIVE_PARENT,
        depth: 0,
        async run(context) {
          context.consumeDiskBytes(2048);
          context.consumeDiskBytes(1);
          return { summary: "unreachable", evidence_head: "" };
        },
      }).run(),
    /disk budget/u,
  );
});
