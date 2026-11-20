import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore, importProtocol } from "./support/core.mjs";
import { makeProject, withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();
const protocol = await importProtocol();

const UPDATED_AT = "2026-11-20T00:00:00.000Z";
const EMPTY_PLAN_HASH = `sha256:${"0".repeat(64)}`;
const OTHER_PLAN_HASH = `sha256:${"1".repeat(64)}`;

function event(kind, data, seq = 1) {
  return {
    type: "codepunk/event",
    version: 1,
    seq,
    at: UPDATED_AT,
    kind,
    data,
  };
}

function planModeEvent(mode, planSha256, seq = 1, extra = {}) {
  return event(
    "plan_mode/update",
    {
      mode,
      plan_sha256: planSha256,
      updated_at: UPDATED_AT,
      ...extra,
    },
    seq,
  );
}

function modeState(mode, planSha256 = null) {
  return {
    mode,
    plan_sha256: planSha256,
    updated_at: UPDATED_AT,
  };
}

function workPlan(steps) {
  return {
    run_id: "run-plan",
    steps,
    explanation: null,
    updated_at: UPDATED_AT,
    sha256: EMPTY_PLAN_HASH,
  };
}

function resultText(result) {
  return result.content
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function withWorkspace(callback) {
  return withTempDirectory("codepunk-plan-mode-", async (root) => {
    const workspace = path.join(root, "workspace");
    const home = path.join(root, "home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    const ledger = await core.EvidenceLedger.open(
      path.join(root, "evidence.jsonl"),
    );
    return callback({ root, workspace, home, ledger });
  });
}

function wrapOptions(fixture, overrides = {}) {
  return {
    cwd: fixture.workspace,
    workspaceRoot: fixture.workspace,
    deliveryRoot: fixture.workspace,
    codepunkHome: fixture.home,
    sessionId: "session-plan-mode",
    runId: "run-plan-mode",
    writeSet: [fixture.workspace],
    approvalMode: "allow",
    approval: null,
    sandbox: null,
    ledger: fixture.ledger,
    ...overrides,
  };
}

function fakeWrite(workspace, executions) {
  return {
    name: "write",
    label: "write",
    description: "write a test file",
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
      const target = path.resolve(workspace, params.path);
      await fs.writeFile(target, params.content, "utf8");
      executions.push(target);
      return {
        content: [{ type: "text", text: `wrote ${target}` }],
        details: {},
      };
    },
  };
}

function evidenceFor(ledger, toolCallId) {
  return ledger.all.find((record) => record.tool_call_id === toolCallId);
}

test("plan mode schemas accept canonical updates and reject unknown fields", () => {
  for (const mode of ["off", "planning", "executing"]) {
    assert.equal(
      protocol.validateSchema(protocol.PlanModeSchema, mode).ok,
      true,
      mode,
    );
  }

  const update = planModeEvent("executing", OTHER_PLAN_HASH);
  assert.equal(
    protocol.validateSchema(protocol.PlanModeUpdateEventSchema, update).ok,
    true,
  );
  assert.equal(
    protocol.validateSchema(protocol.SessionEventSchema, update).ok,
    true,
  );

  const nestedUnknown = planModeEvent("executing", OTHER_PLAN_HASH, 1, {
    unexpected: true,
  });
  assert.equal(
    protocol.validateSchema(protocol.PlanModeUpdateEventSchema, nestedUnknown)
      .ok,
    false,
  );
  assert.equal(
    protocol.validateSchema(protocol.SessionEventSchema, nestedUnknown).ok,
    false,
  );

  const topLevelUnknown = { ...update, unexpected: true };
  assert.equal(
    protocol.validateSchema(protocol.SessionEventSchema, topLevelUnknown).ok,
    false,
  );
});

test("plan mode state uses the last update and survives run boundaries", () => {
  assert.equal(core.readPlanModeState([]), null);

  const events = [
    planModeEvent("planning", null, 1),
    event(
      "plan/update",
      {
        run_id: "run-plan",
        steps: [{ step: "inspect", status: "pending" }],
        explanation: null,
        updated_at: UPDATED_AT,
        sha256: EMPTY_PLAN_HASH,
      },
      2,
    ),
    planModeEvent("executing", OTHER_PLAN_HASH, 3),
    event(
      "run/end",
      {
        run_id: "run-plan",
        state: "settled",
        termination: null,
        evidence_head: null,
        actor: "local-user",
      },
      4,
    ),
    event(
      "run/start",
      { run_id: "run-next", session_id: "session-plan-mode" },
      5,
    ),
  ];

  assert.deepEqual(core.readPlanModeState(events), {
    mode: "executing",
    plan_sha256: OTHER_PLAN_HASH,
    updated_at: UPDATED_AT,
  });

  events.push(planModeEvent("off", null, 6));
  assert.deepEqual(core.readPlanModeState(events), modeState("off"));
});

test("plan content hash binds ordered step text but not step status", () => {
  const base = workPlan([
    { step: "inspect the repository", status: "pending" },
    { step: "implement the fix", status: "pending" },
  ]);
  const hash = core.planContentHash(base);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/u);

  const statusOnly = workPlan([
    { step: "inspect the repository", status: "completed" },
    { step: "implement the fix", status: "in_progress" },
  ]);
  assert.equal(core.planContentHash(statusOnly), hash);

  for (const changed of [
    workPlan([
      { step: "inspect another repository", status: "pending" },
      { step: "implement the fix", status: "pending" },
    ]),
    workPlan([
      { step: "implement the fix", status: "pending" },
      { step: "inspect the repository", status: "pending" },
    ]),
    workPlan([
      { step: "inspect the repository", status: "pending" },
      { step: "implement the fix", status: "pending" },
      { step: "run the tests", status: "pending" },
    ]),
    workPlan([{ step: "inspect the repository", status: "pending" }]),
  ]) {
    assert.notEqual(core.planContentHash(changed), hash);
  }

  assert.equal(core.planContentHash(null), null);
  assert.equal(core.planContentHash(workPlan([])), null);
});

test("plan mode gate enforces read-only and approved-plan rules", () => {
  const planning = modeState("planning");
  for (const tool of ["read", "search", "plan", "todo", "memory_search"]) {
    assert.deepEqual(
      core.evaluatePlanModeGate({ state: planning, plan: null, tool }),
      { allowed: true, rule: null, reason: null },
      tool,
    );
  }

  for (const tool of [
    "write",
    "edit",
    "bash",
    "exec",
    "user_bash",
    "unknown_tool",
  ]) {
    const gate = core.evaluatePlanModeGate({
      state: planning,
      plan: null,
      tool,
    });
    assert.equal(gate.allowed, false, tool);
    assert.equal(gate.rule, "plan_mode.read_only", tool);
    assert.match(gate.reason, /only read-only tools/u, tool);
  }

  const off = modeState("off");
  for (const tool of [
    "read",
    "write",
    "edit",
    "bash",
    "exec",
    "user_bash",
    "unknown_tool",
  ]) {
    assert.deepEqual(
      core.evaluatePlanModeGate({ state: off, plan: null, tool }),
      { allowed: true, rule: null, reason: null },
      tool,
    );
  }

  const plan = workPlan([
    { step: "inspect", status: "completed" },
    { step: "write the result", status: "in_progress" },
  ]);
  const approvedHash = core.planContentHash(plan);
  assert.equal(
    core.evaluatePlanModeGate({
      state: modeState("executing", approvedHash),
      plan,
      tool: "write",
    }).allowed,
    true,
  );

  const mismatched = core.evaluatePlanModeGate({
    state: modeState("executing", approvedHash),
    plan: workPlan([
      { step: "inspect", status: "completed" },
      { step: "write something else", status: "in_progress" },
    ]),
    tool: "write",
  });
  assert.equal(mismatched.allowed, false);
  assert.equal(mismatched.rule, "plan_mode.approval_mismatch");

  const missingApproval = core.evaluatePlanModeGate({
    state: modeState("executing"),
    plan,
    tool: "write",
  });
  assert.equal(missingApproval.allowed, false);
  assert.equal(missingApproval.rule, "plan_mode.approval_missing");

  const missingPlan = core.evaluatePlanModeGate({
    state: modeState("executing", approvedHash),
    plan: null,
    tool: "write",
  });
  assert.equal(missingPlan.allowed, false);
  assert.equal(missingPlan.rule, "plan_mode.approval_missing");
});

test("wrapped write is gated by planning then released by an approved plan", async () => {
  await withWorkspace(async (fixture) => {
    let state = modeState("planning");
    let plan = workPlan([
      { step: "write the approved result", status: "pending" },
    ]);
    const executions = [];
    const wrapped = await core.wrapToolDefinition(
      fakeWrite(fixture.workspace, executions),
      wrapOptions(fixture, {
        planMode: () => state,
        currentPlan: () => plan,
      }),
    );
    const target = path.join(fixture.workspace, "result.txt");

    const deniedByPlanning = await wrapped.execute(
      "planning-write",
      { path: "result.txt", content: "approved\n" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(deniedByPlanning.isError, true);
    assert.match(resultText(deniedByPlanning), /plan_mode\.read_only/u);
    assert.equal(await pathExists(target), false);
    assert.equal(executions.length, 0);
    const planningRecord = evidenceFor(fixture.ledger, "planning-write");
    assert.ok(planningRecord);
    assert.equal(planningRecord.decision, "deny");
    assert.equal(planningRecord.rule, "plan_mode.read_only");

    state = modeState("executing", core.planContentHash(plan));
    const allowedByPlan = await wrapped.execute(
      "executing-write",
      { path: "result.txt", content: "approved\n" },
      undefined,
      undefined,
      undefined,
    );
    assert.notEqual(allowedByPlan.isError, true, resultText(allowedByPlan));
    assert.equal(await fs.readFile(target, "utf8"), "approved\n");
    assert.equal(executions.length, 1);
    const executingRecord = evidenceFor(fixture.ledger, "executing-write");
    assert.ok(executingRecord);
    assert.equal(executingRecord.decision, "allow");

    plan = workPlan([{ step: "write a different result", status: "pending" }]);
    const deniedByMismatch = await wrapped.execute(
      "mismatch-write",
      { path: "result.txt", content: "approved\n" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(deniedByMismatch.isError, true);
    assert.match(resultText(deniedByMismatch), /plan_mode\.approval_mismatch/u);
    assert.equal(await fs.readFile(target, "utf8"), "approved\n");
    assert.equal(executions.length, 1);
    const mismatchRecord = evidenceFor(fixture.ledger, "mismatch-write");
    assert.ok(mismatchRecord);
    assert.equal(mismatchRecord.decision, "deny");
    assert.equal(mismatchRecord.rule, "plan_mode.approval_mismatch");
  });
});

test("wrapped user bash is denied with a failed result during planning", async () => {
  await withWorkspace(async (fixture) => {
    const state = modeState("planning");
    const command = "printf blocked > user-bash.txt";
    const result = await core.wrapUserBashCommand(
      command,
      "planning-user-bash",
      wrapOptions(fixture, {
        planMode: () => state,
        currentPlan: () => null,
      }),
    );

    assert.equal("operations" in result, false);
    assert.equal(result.result.exitCode, 1);
    assert.match(result.result.output, /plan_mode\.read_only/u);
    assert.equal(
      await pathExists(path.join(fixture.workspace, "user-bash.txt")),
      false,
    );

    const record = evidenceFor(fixture.ledger, "planning-user-bash");
    assert.ok(record);
    assert.equal(record.decision, "deny");
    assert.equal(record.rule, "plan_mode.read_only");
  });
});

test("the same wrapped write succeeds when plan mode is off", async () => {
  await withWorkspace(async (fixture) => {
    let state = modeState("planning");
    const executions = [];
    const wrapped = await core.wrapToolDefinition(
      fakeWrite(fixture.workspace, executions),
      wrapOptions(fixture, {
        planMode: () => state,
        currentPlan: () => null,
      }),
    );
    const target = path.join(fixture.workspace, "off-control.txt");

    const denied = await wrapped.execute(
      "off-control-planning",
      { path: "off-control.txt", content: "written\n" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(denied.isError, true);
    assert.equal(await pathExists(target), false);
    assert.equal(executions.length, 0);

    state = modeState("off");
    const allowed = await wrapped.execute(
      "off-control-off",
      { path: "off-control.txt", content: "written\n" },
      undefined,
      undefined,
      undefined,
    );
    assert.notEqual(allowed.isError, true, resultText(allowed));
    assert.equal(await fs.readFile(target, "utf8"), "written\n");
    assert.equal(executions.length, 1);
    const record = evidenceFor(fixture.ledger, "off-control-off");
    assert.ok(record);
    assert.equal(record.decision, "allow");
  });
});

test("runtime plan mode narrows tools, approves a recorded plan, and exits", async () => {
  await withTempDirectory("codepunk-plan-mode-runtime-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    const runtime = await core.createRuntime({
      cwd: projectRoot,
      environment: { CODEPUNK_HOME: paths.home },
      approvalChannel: null,
      allowMissingModel: true,
    });
    try {
      assert.equal(runtime.planMode.state(), null);

      const initialTools = new Set(runtime.host.session.getActiveToolNames());
      assert.equal(initialTools.has("read"), true);
      assert.equal(initialTools.has("write"), true);
      assert.equal(initialTools.has("edit"), true);

      const planning = await runtime.planMode.enter();
      assert.equal(planning.mode, "planning");
      assert.equal(planning.plan_sha256, null);
      assert.deepEqual(runtime.planMode.state(), planning);

      const planningTools = new Set(runtime.host.session.getActiveToolNames());
      for (const tool of ["write", "edit", "bash"]) {
        assert.equal(planningTools.has(tool), false, tool);
      }
      assert.equal(planningTools.has("read"), true);

      await assert.rejects(
        () => runtime.planMode.approve(),
        /No plan to approve/u,
      );

      const steps = [
        { step: "inspect the runtime", status: "completed" },
        { step: "verify plan enforcement", status: "in_progress" },
      ];
      const plan = {
        run_id: runtime.runId,
        steps,
        explanation: null,
        updated_at: UPDATED_AT,
        sha256: core.recordHash({ steps }),
      };
      await runtime.session.append("plan/update", plan);

      const approved = await runtime.planMode.approve();
      const storedPlan = core.readWorkState(runtime.session.allEvents).plan;
      assert.ok(storedPlan);
      assert.equal(approved.mode, "executing");
      assert.equal(approved.plan_sha256, core.planContentHash(storedPlan));

      const executingTools = new Set(runtime.host.session.getActiveToolNames());
      assert.equal(executingTools.has("write"), true);
      for (const tool of ["read", "edit", "bash"]) {
        if (initialTools.has(tool)) {
          assert.equal(executingTools.has(tool), true, tool);
        }
      }

      const exited = await runtime.planMode.exit();
      assert.equal(exited.mode, "off");
      assert.equal(runtime.planMode.state()?.mode, "off");

      const transitions = runtime.session.allEvents
        .filter((event) => event.kind === "plan_mode/update")
        .map((event) => event.data.mode);
      assert.deepEqual(transitions, ["planning", "executing", "off"]);
    } finally {
      await runtime.dispose();
    }
  });
});

test("runtime plan mode keeps state and tools unchanged when append fails", async () => {
  await withTempDirectory(
    "codepunk-plan-mode-append-failure-",
    async (root) => {
      const { projectRoot, paths } = await makeProject(root);
      const runtime = await core.createRuntime({
        cwd: projectRoot,
        environment: { CODEPUNK_HOME: paths.home },
        approvalChannel: null,
        allowMissingModel: true,
      });
      const originalAppend = runtime.session.append.bind(runtime.session);
      const failedAppend = async () => {
        throw new Error("append failed");
      };
      try {
        const initialTools = new Set(runtime.host.session.getActiveToolNames());
        assert.equal(initialTools.has("write"), true);

        runtime.session.append = failedAppend;
        await assert.rejects(() => runtime.planMode.enter(), /append failed/u);
        assert.equal(runtime.planMode.state(), null);
        assert.equal(
          runtime.host.session.getActiveToolNames().includes("write"),
          true,
        );

        runtime.session.append = originalAppend;
        const planning = await runtime.planMode.enter();
        assert.equal(planning.mode, "planning");

        const steps = [
          { step: "record a plan before approve", status: "pending" },
        ];
        await runtime.session.append("plan/update", {
          run_id: runtime.runId,
          steps,
          explanation: null,
          updated_at: UPDATED_AT,
          sha256: core.recordHash({ steps }),
        });

        runtime.session.append = failedAppend;
        await assert.rejects(
          () => runtime.planMode.approve(),
          /append failed/u,
        );
        assert.equal(runtime.planMode.state()?.mode, "planning");
        assert.equal(
          runtime.host.session.getActiveToolNames().includes("write"),
          false,
        );
        assert.equal(
          runtime.host.session.getActiveToolNames().includes("read"),
          true,
        );
      } finally {
        runtime.session.append = originalAppend;
        await runtime.dispose();
      }
    },
  );
});

test("runtime resumes a planning session with the narrowed tool surface", async () => {
  await withTempDirectory("codepunk-plan-mode-resume-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    const options = {
      cwd: projectRoot,
      environment: { CODEPUNK_HOME: paths.home },
      approvalChannel: null,
      allowMissingModel: true,
    };

    const first = await core.createRuntime(options);
    let sessionId;
    try {
      await first.planMode.enter();
      sessionId = first.session.sessionId;
    } finally {
      await first.dispose();
    }

    const resumed = await core.createRuntime({
      ...options,
      sessionId,
    });
    try {
      assert.equal(resumed.session.sessionId, sessionId);
      assert.equal(resumed.planMode.state()?.mode, "planning");
      const tools = new Set(resumed.host.session.getActiveToolNames());
      for (const tool of ["write", "edit", "bash"]) {
        assert.equal(tools.has(tool), false, tool);
      }
      assert.equal(tools.has("read"), true);
    } finally {
      await resumed.dispose();
    }
  });
});
