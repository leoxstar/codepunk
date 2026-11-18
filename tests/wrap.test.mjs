import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";

const core = await importCore();

async function setup() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "codepunk-wrap-")),
  );
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  return {
    root,
    workspace,
    home,
    evidence: path.join(root, "evidence.jsonl"),
  };
}

function wrapOptions(paths, overrides = {}) {
  return {
    cwd: paths.workspace,
    workspaceRoot: paths.workspace,
    deliveryRoot: paths.workspace,
    codepunkHome: paths.home,
    sessionId: "session-1",
    runId: "run-1",
    taskId: null,
    writeSet: [paths.workspace],
    mode: "interactive",
    approval: null,
    ledger: null,
    sandbox: null,
    ...overrides,
  };
}

function fakeSandbox(onExec) {
  const descriptor = {
    backend: "srt",
    version: "test",
    profile_sha256: null,
  };
  return {
    descriptor,
    sandboxed: true,
    async execCommand(command) {
      onExec?.(command);
      return {
        output: "ok\n",
        exitCode: 0,
        cancelled: false,
        timedOut: false,
        executor: "srt",
        descriptor,
      };
    },
    async execArgv(argv) {
      onExec?.(argv.join(" "));
      return {
        output: "ok\n",
        exitCode: 0,
        cancelled: false,
        timedOut: false,
        executor: "srt",
        descriptor,
      };
    },
  };
}

test("write is idempotent by target and content hash", async () => {
  const paths = await setup();
  const target = path.join(paths.workspace, "note.txt");
  await fs.writeFile(target, "before\n");
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  const definitions = await core.createCodepunkToolDefinitions(
    paths.workspace,
    null,
  );
  const writeDefinition = definitions.find(
    (definition) => definition.name === "write",
  );
  assert.ok(writeDefinition);
  const write = await core.wrapToolDefinition(
    writeDefinition,
    wrapOptions(paths, { ledger }),
  );

  const first = await write.execute(
    "call-write-1",
    { path: "note.txt", content: "after\n" },
    undefined,
    undefined,
    {},
  );
  assert.notEqual(first.isError, true);
  const afterFirst = await fs.stat(target);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const second = await write.execute(
    "call-write-2",
    { path: "note.txt", content: "after\n" },
    undefined,
    undefined,
    {},
  );
  assert.notEqual(second.isError, true);
  const afterSecond = await fs.stat(target);
  assert.equal(afterSecond.mtimeMs, afterFirst.mtimeMs);
  assert.equal(second.structuredContent.already_applied, true);
  assert.equal(await fs.readFile(target, "utf8"), "after\n");

  const records = (await core.readEvidenceFile(paths.evidence)).records.filter(
    (record) =>
      record.tool_call_id === "call-write-1" ||
      record.tool_call_id === "call-write-2",
  );
  assert.equal(records.length, 2);
  assert.equal(records[0].idempotency_key, records[1].idempotency_key);
  assert.equal(records[1].reused, true);
  assert.equal(records[1].rule, "idempotency.already_applied");
});

test("shell calls never reuse write idempotency keys", async () => {
  const paths = await setup();
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  let executions = 0;
  const sandbox = fakeSandbox(() => {
    executions += 1;
  });
  const definitions = await core.createCodepunkToolDefinitions(
    paths.workspace,
    sandbox,
  );
  const bashDefinition = definitions.find(
    (definition) => definition.name === "bash",
  );
  assert.ok(bashDefinition);
  const bash = await core.wrapToolDefinition(
    bashDefinition,
    wrapOptions(paths, { ledger, sandbox }),
  );

  await bash.execute(
    "call-bash-1",
    { command: "printf ok" },
    undefined,
    undefined,
    {},
  );
  await bash.execute(
    "call-bash-2",
    { command: "printf ok" },
    undefined,
    undefined,
    {},
  );
  assert.equal(executions, 2);

  const records = (await core.readEvidenceFile(paths.evidence)).records.filter(
    (record) =>
      record.tool_call_id === "call-bash-1" ||
      record.tool_call_id === "call-bash-2",
  );
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.idempotency_key === undefined));
  assert.ok(records.every((record) => record.reused !== true));
});

test("repeated identical calls are stopped before side effects", async () => {
  const paths = await setup();
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  let executions = 0;
  const events = [];
  const sandbox = fakeSandbox(() => {
    executions += 1;
  });
  const definitions = await core.createCodepunkToolDefinitions(
    paths.workspace,
    sandbox,
  );
  const bashDefinition = definitions.find(
    (definition) => definition.name === "bash",
  );
  assert.ok(bashDefinition);
  const bash = await core.wrapToolDefinition(
    bashDefinition,
    wrapOptions(paths, {
      ledger,
      sandbox,
      onExecutionEvent: (kind, data) => {
        events.push({ kind, data });
      },
    }),
  );

  for (let index = 1; index <= 3; index += 1) {
    const result = await bash.execute(
      `call-loop-${index}`,
      { command: "printf ok" },
      undefined,
      undefined,
      {},
    );
    assert.notEqual(result.isError, true);
  }
  const denied = await bash.execute(
    "call-loop-4",
    { command: "printf ok" },
    undefined,
    undefined,
    {},
  );
  assert.equal(denied.isError, true);
  assert.equal(executions, 3);
  const event = events.find((entry) => entry.kind === "loop_guard");
  assert.ok(event);
  assert.equal(event.data.repeat_count, 4);
  assert.equal(event.data.threshold, 3);

  const changed = await bash.execute(
    "call-loop-changed",
    { command: "printf changed" },
    undefined,
    undefined,
    {},
  );
  assert.notEqual(changed.isError, true);
  assert.equal(executions, 4);

  const deniedRecord = (
    await core.readEvidenceFile(paths.evidence)
  ).records.find((record) => record.tool_call_id === "call-loop-4");
  assert.equal(deniedRecord.rule, "loop_guard");
  assert.equal(deniedRecord.decision, "deny");
});

test("verify failure retries once for a safe idempotent write", async () => {
  const paths = await setup();
  const target = path.join(paths.workspace, "retry.txt");
  await fs.writeFile(target, "before\n");
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  let verifyCalls = 0;
  const definitions = await core.createCodepunkToolDefinitions(
    paths.workspace,
    null,
  );
  const writeDefinition = definitions.find(
    (definition) => definition.name === "write",
  );
  assert.ok(writeDefinition);
  const write = await core.wrapToolDefinition(
    writeDefinition,
    wrapOptions(paths, {
      ledger,
      verifyToolResult: async () => {
        verifyCalls += 1;
        return verifyCalls === 1
          ? { result: "fail", reason: "injected first failure" }
          : { result: "pass", reason: null };
      },
    }),
  );

  const result = await write.execute(
    "call-retry-write",
    { path: "retry.txt", content: "after\n" },
    undefined,
    undefined,
    {},
  );
  assert.notEqual(result.isError, true);
  assert.equal(verifyCalls, 2);
  assert.equal(await fs.readFile(target, "utf8"), "after\n");

  const records = (await core.readEvidenceFile(paths.evidence)).records.filter(
    (record) => record.tool_call_id === "call-retry-write",
  );
  assert.equal(records.length, 2);
  assert.equal(records[0].verify.result, "fail");
  assert.equal(records[1].verify.result, "pass");
  assert.equal(records[1].retry.attempt, 1);
  assert.equal(records[1].retry.max_attempts, 1);
});

test("tool call budget blocks before execution", async () => {
  const paths = await setup();
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  const events = [];
  let executions = 0;
  const read = await core.wrapToolDefinition(
    {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      async execute() {
        executions += 1;
        return {
          content: [{ type: "text", text: "ok\n" }],
          details: {},
        };
      },
    },
    wrapOptions(paths, {
      ledger,
      budget: { maxToolCalls: 2 },
      onExecutionEvent: (kind, data) => {
        events.push({ kind, data });
      },
    }),
  );

  for (let index = 1; index <= 2; index += 1) {
    const result = await read.execute(
      `call-budget-${index}`,
      { path: "note.txt" },
      undefined,
      undefined,
      {},
    );
    assert.notEqual(result.isError, true);
  }
  const denied = await read.execute(
    "call-budget-3",
    { path: "note.txt" },
    undefined,
    undefined,
    {},
  );
  assert.equal(denied.isError, true);
  assert.equal(executions, 2);

  const event = events.find((entry) => entry.kind === "budget/exceeded");
  assert.ok(event);
  assert.deepEqual(event.data, {
    run_id: "run-1",
    limit_kind: "tool_calls",
    limit: 2,
    used: 2,
    action: "reject_call",
  });
  const record = (await core.readEvidenceFile(paths.evidence)).records.find(
    (entry) => entry.tool_call_id === "call-budget-3",
  );
  assert.equal(record.decision, "deny");
  assert.equal(record.budget_exceeded.limit_kind, "tool_calls");
  assert.equal(record.budget_exceeded.action, "reject_call");
});
