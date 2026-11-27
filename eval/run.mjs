import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { importCore, importSource } from "../tests/support/core.mjs";
import { readRecord } from "../tests/support/fixtures.mjs";
import {
  installScriptedStream,
  TEST_MODEL,
} from "../tests/support/pi-model.mjs";

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EVAL_ROOT, "..");
const core = await importCore();
const protocol = await importSource("packages/protocol/src/index.ts");
const { NetworkGuard } = await importSource(
  "packages/core/src/network/index.ts",
);

function fail(message) {
  throw new Error(message);
}

async function loadCases() {
  const content = await fs.readFile(
    path.join(EVAL_ROOT, "cases.jsonl"),
    "utf8",
  );
  const cases = [];
  const ids = new Set();
  for (const [index, line] of content.split("\n").entries()) {
    if (line.length === 0) {
      continue;
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      fail(`cases.jsonl:${index + 1} is not valid JSON: ${error.message}`);
    }
    if (
      value === null ||
      typeof value !== "object" ||
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      typeof value.kind !== "string" ||
      value.expected !== "pass"
    ) {
      fail(`cases.jsonl:${index + 1} has an invalid deterministic case`);
    }
    if (ids.has(value.id)) {
      fail(`cases.jsonl contains duplicate case ${value.id}`);
    }
    ids.add(value.id);
    cases.push(value);
  }
  if (cases.length === 0) {
    fail("eval/cases.jsonl contains no cases");
  }
  return cases;
}

async function loadBaseline() {
  const content = await fs.readFile(
    path.join(EVAL_ROOT, "baseline.json"),
    "utf8",
  );
  const baseline = JSON.parse(content);
  if (
    baseline === null ||
    typeof baseline !== "object" ||
    baseline.version !== 1 ||
    baseline.cases === null ||
    typeof baseline.cases !== "object" ||
    !Number.isInteger(baseline.min_passed) ||
    baseline.min_passed < 1 ||
    !Number.isInteger(baseline.max_failed) ||
    baseline.max_failed < 0
  ) {
    fail("eval/baseline.json has an invalid shape");
  }
  return {
    value: baseline,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "codepunk-eval-")),
  );
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  const evidencePath = path.join(root, "evidence.jsonl");
  const ledger = await core.EvidenceLedger.open(evidencePath);
  return { root, workspace, home, evidencePath, ledger, caseId: "pending" };
}

function wrapOptions(paths, ledger, overrides = {}) {
  return {
    cwd: paths.workspace,
    workspaceRoot: paths.workspace,
    deliveryRoot: paths.workspace,
    codepunkHome: paths.home,
    sessionId: `session-${paths.caseId}`,
    runId: `run-${paths.caseId}`,
    taskId: null,
    writeSet: [paths.workspace],
    mode: "interactive",
    approvalMode: "allow",
    approval: null,
    ledger,
    sandbox: null,
    ...overrides,
  };
}

function fakeSandbox(onExec) {
  const descriptor = {
    backend: "srt",
    version: "eval",
    profile_sha256: null,
  };
  return {
    descriptor,
    sandboxed: true,
    async execCommand(command, cwd, options = {}) {
      return await onExec(command, cwd, options);
    },
    async execArgv(argv, cwd, options = {}) {
      return await onExec(argv.join(" "), cwd, options);
    },
  };
}

async function wallClockSandbox(paths) {
  const input = {
    cwd: paths.workspace,
    workspaceRoot: paths.workspace,
    deliveryRoot: paths.workspace,
    codepunkHome: paths.home,
    writeSet: [paths.workspace],
    networkAllow: [],
  };
  if (process.platform === "win32") {
    // Hosted Windows cannot provision the privileged srt sandbox. Keep the
    // wall-budget contract under test with a deterministic provider; Unix
    // still exercises the real srt path below.
    const issue = await core.probeSrtSandbox(input);
    if (issue !== null) {
      return fakeWallClockSandbox();
    }
  }
  try {
    return await core.SrtSandbox.create(input);
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      error.name === "SandboxUnavailableError"
    ) {
      return fakeWallClockSandbox();
    }
    throw error;
  }
}

function fakeWallClockSandbox() {
  let sandbox;
  sandbox = fakeSandbox((_command, _cwd, options = {}) => {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve(successfulShellResult(sandbox.descriptor)),
        10_000,
      );
      const abort = () => {
        clearTimeout(timer);
        resolve({
          output: "",
          exitCode: null,
          cancelled: true,
          timedOut: false,
          executor: "srt",
          descriptor: sandbox.descriptor,
        });
      };
      if (options.signal?.aborted === true) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
    });
  });
  return sandbox;
}

function successfulShellResult(descriptor, output = "ok\n") {
  return {
    output,
    exitCode: 0,
    cancelled: false,
    timedOut: false,
    executor: "srt",
    descriptor,
  };
}

async function wrappedTool(paths, ledger, name, overrides = {}) {
  const definitions = await core.createCodepunkToolDefinitions(
    paths.workspace,
    overrides.sandbox ?? null,
  );
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) {
    fail(`tool ${name} is not available in the committed definitions`);
  }
  return await core.wrapToolDefinition(
    definition,
    wrapOptions(paths, ledger, overrides),
  );
}

async function execute(tool, id, params, signal) {
  return await tool.execute(id, params, signal, undefined, {});
}

async function recordsFor(paths, id) {
  return (await core.readEvidenceFile(paths.evidencePath)).records.filter(
    (record) => record.tool_call_id === id,
  );
}

async function runWrite(paths, ledger) {
  const target = path.join(paths.workspace, "note.txt");
  await fs.writeFile(target, "before\n");
  const write = await wrappedTool(paths, ledger, "write");
  const first = await execute(write, "eval-write-1", {
    path: "note.txt",
    content: "after\n",
  });
  assert.notEqual(first.isError, true);
  const firstStat = await fs.stat(target);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = await execute(write, "eval-write-2", {
    path: "note.txt",
    content: "after\n",
  });
  assert.notEqual(second.isError, true);
  assert.equal(second.structuredContent?.already_applied, true);
  assert.equal((await fs.stat(target)).mtimeMs, firstStat.mtimeMs);
  const records = [
    ...(await recordsFor(paths, "eval-write-1")),
    ...(await recordsFor(paths, "eval-write-2")),
  ];
  assert.equal(records.length, 2);
  assert.equal(records[0].idempotency_key, records[1].idempotency_key);
  assert.equal(records[1].reused, true);
}

async function runLoopGuard(paths, ledger) {
  let executions = 0;
  const events = [];
  const sandbox = fakeSandbox((_command, _cwd, _options) => {
    executions += 1;
    return successfulShellResult(sandbox.descriptor);
  });
  const bash = await wrappedTool(paths, ledger, "bash", {
    sandbox,
    onExecutionEvent: (kind, data) => events.push({ kind, data }),
  });
  for (let index = 1; index <= 4; index += 1) {
    await execute(bash, `eval-loop-${index}`, { command: "printf ok" });
  }
  assert.equal(executions, 3);
  const event = events.find((entry) => entry.kind === "loop_guard");
  assert.ok(event);
  assert.equal(event.data.repeat_count, 4);
  assert.equal(event.data.threshold, 3);
  const denied = await recordsFor(paths, "eval-loop-4");
  assert.equal(denied.length, 1);
  assert.equal(denied[0].rule, "loop_guard");
  assert.equal(denied[0].decision, "deny");
}

async function runToolCallBudget(paths, ledger) {
  let executions = 0;
  const events = [];
  const definition = {
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
      return { content: [{ type: "text", text: "ok\n" }], details: {} };
    },
  };
  const read = await core.wrapToolDefinition(
    definition,
    wrapOptions(paths, ledger, {
      budget: { maxToolCalls: 2 },
      onExecutionEvent: (kind, data) => events.push({ kind, data }),
    }),
  );
  for (let index = 1; index <= 3; index += 1) {
    await execute(read, `eval-budget-${index}`, { path: "note.txt" });
  }
  assert.equal(executions, 2);
  const event = events.find((entry) => entry.kind === "budget/exceeded");
  assert.ok(event);
  assert.deepEqual(event.data, {
    run_id: `run-${paths.caseId}`,
    limit_kind: "tool_calls",
    limit: 2,
    used: 2,
    action: "reject_call",
  });
  const denied = await recordsFor(paths, "eval-budget-3");
  assert.equal(denied.length, 1);
  assert.equal(denied[0].decision, "deny");
  assert.deepEqual(denied[0].budget_exceeded, event.data);
}

async function runWallClockBudget(paths, ledger) {
  const sandbox = await wallClockSandbox(paths);
  try {
    const store = await core.SessionStore.create({
      rootDir: paths.home,
      cwd: paths.workspace,
      sessionId: `session-${paths.caseId}`,
      heartbeatMs: 60_000,
    });
    const host = await core.createPiHost({
      cwd: paths.workspace,
      workspaceRoot: paths.workspace,
      deliveryRoot: paths.workspace,
      codepunkHome: paths.home,
      sessionId: store.sessionId,
      runId: `run-${paths.caseId}`,
      writeSet: [paths.workspace],
      mode: "interactive",
      approvalMode: "allow",
      approval: null,
      ledger,
      sandbox,
      sessionStore: store,
      model: TEST_MODEL,
      budget: { maxWallMs: 500 },
    });
    try {
      await host.services.modelRuntime.setRuntimeApiKey("openai", "eval-key");
      installScriptedStream(host.session, (index) => {
        if (index === 0) {
          return {
            type: "toolCall",
            id: "eval-wall-host-1",
            name: "bash",
            args: { command: "sleep 10" },
          };
        }
        return { type: "text", text: "done" };
      });
      const startedAt = performance.now();
      await host.session.prompt("sleep for ten seconds");
      const elapsed = performance.now() - startedAt;
      assert.ok(
        elapsed < 8_000,
        `wall budget did not interrupt the sleep (${elapsed} ms)`,
      );
      const event = store.allEvents.find(
        (entry) => entry.kind === "budget/exceeded",
      );
      assert.ok(event);
      assert.equal(event.data.limit_kind, "wall_ms");
      assert.equal(event.data.limit, 500);
      assert.equal(event.data.action, "abort_run");
      const toolResult = host.session.messages.find(
        (message) => message.role === "toolResult",
      );
      assert.ok(toolResult);
      assert.match(
        JSON.stringify(toolResult.content),
        /Command aborted|Operation aborted/u,
      );
    } finally {
      await host.dispose();
    }
  } finally {
    await sandbox.close?.();
  }
}

async function runVerify(paths, ledger, mode) {
  const target = path.join(paths.workspace, "verify.txt");
  await fs.writeFile(target, "before\n");
  let verifyCalls = 0;
  let executions = 0;
  const definition = {
    name: "write",
    label: "write",
    description: "write a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      executions += 1;
      await fs.writeFile(
        path.join(paths.workspace, params.path),
        params.content,
      );
      return {
        content: [{ type: "text", text: "written\n" }],
        details: {},
      };
    },
  };
  const write = await core.wrapToolDefinition(
    definition,
    wrapOptions(paths, ledger, {
      verifyToolResult: async () => {
        verifyCalls += 1;
        return mode === "recover" && verifyCalls === 2
          ? { result: "pass", reason: null }
          : { result: "fail", reason: `injected failure ${verifyCalls}` };
      },
    }),
  );
  const result = await execute(write, "eval-verify-1", {
    path: "verify.txt",
    content: "after\n",
  });
  const records = await recordsFor(paths, "eval-verify-1");
  assert.equal(executions, 2);
  assert.equal(verifyCalls, 2);
  assert.equal(records.length, 2);
  assert.equal(records[0].verify.result, "fail");
  assert.equal(records[1].verify.result, mode === "recover" ? "pass" : "fail");
  assert.equal(records[1].retry.attempt, 1);
  assert.equal(records[1].retry.max_attempts, 1);
  if (mode === "recover") {
    assert.notEqual(result.isError, true);
  } else {
    assert.equal(result.isError, true);
    assert.equal(records[1].outcome, "failed");
  }
}

function networkRequest(url, contentLength) {
  return new Request(url, {
    method: contentLength === 0 ? "GET" : "POST",
    headers: { "content-length": String(contentLength) },
  });
}

async function networkResponse(decision, status, headers = {}) {
  assert.equal(decision.action, "allow");
  assert.equal(typeof decision.onResponse, "function");
  decision.onResponse(status, headers);
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function runNetwork(mode) {
  const events = [];
  const guard = new NetworkGuard({
    runId: "run-eval",
    allow: ["allowed.example"],
    deny: [],
    maxRequests: mode === "request_budget" ? 1 : 10,
    maxBytes: 1_024,
    onEvent: (kind, data) => events.push({ kind, data }),
  });

  if (mode === "allowlist") {
    const decision = await guard.filterRequest(
      networkRequest("http://allowed.example/data", 4),
      undefined,
    );
    await networkResponse(decision, 200, { "content-length": "12" });
    const request = events.find((entry) => entry.kind === "network/request");
    assert.ok(request);
    assert.deepEqual(request.data, {
      run_id: "run-eval",
      domain: "allowed.example",
      requests: 1,
      bytes: 4,
      limit: { max_requests: 10, max_bytes: 1_024 },
      decision: "allow",
    });
    assert.equal(guard.usageFor("allowed.example").bytes, 16);
    return;
  }

  if (mode === "denied_domain") {
    const decision = await guard.filterRequest(
      networkRequest("http://denied.example/data", 0),
      undefined,
    );
    assert.equal(decision.action, "deny");
    const rejected = events.find((entry) => entry.kind === "network/rejected");
    assert.ok(rejected);
    assert.equal(rejected.data.domain, "denied.example");
    assert.equal(rejected.data.reason, "domain_not_allowed");
    assert.equal(guard.usageFor("denied.example").requests, 0);
    return;
  }

  if (mode === "redirect_denied") {
    const decision = await guard.filterRequest(
      networkRequest("http://allowed.example/start", 0),
      undefined,
    );
    await networkResponse(decision, 302, {
      location: "http://denied.example/next",
    });
    const redirect = events.find((entry) => entry.kind === "network/redirect");
    assert.ok(redirect);
    assert.deepEqual(redirect.data, {
      run_id: "run-eval",
      from: "allowed.example",
      to: "denied.example",
      status: 302,
      decision: "deny",
    });
    const rejected = events.find((entry) => entry.kind === "network/rejected");
    assert.ok(rejected);
    assert.equal(rejected.data.domain, "denied.example");
    return;
  }

  if (mode === "request_budget") {
    const first = await guard.filterRequest(
      networkRequest("http://allowed.example/one", 0),
      undefined,
    );
    assert.equal(first.action, "allow");
    const second = await guard.filterRequest(
      networkRequest("http://allowed.example/two", 0),
      undefined,
    );
    assert.equal(second.action, "deny");
    const rejected = events.find((entry) => entry.kind === "network/rejected");
    assert.ok(rejected);
    assert.equal(rejected.data.reason, "max_requests");
    assert.equal(guard.usageFor("allowed.example").requests, 1);
    return;
  }

  fail(`unknown network mode ${mode}`);
}

async function runSchemaCompatibility(paths) {
  const legacyRecord = readRecord();
  assert.equal(
    protocol.validateSchema(protocol.EvidenceRecordSchema, legacyRecord).ok,
    true,
  );
  const withBudget = {
    ...legacyRecord,
    budget_exceeded: {
      run_id: legacyRecord.run_id,
      limit_kind: "tool_calls",
      limit: 2,
      used: 2,
      action: "reject_call",
    },
  };
  assert.equal(
    protocol.validateSchema(protocol.EvidenceRecordSchema, withBudget).ok,
    true,
  );
  const undeclared = { ...legacyRecord, limit_kind: "tool_calls" };
  assert.equal(
    protocol.validateSchema(protocol.EvidenceRecordSchema, undeclared).ok,
    false,
  );

  const events = [
    {
      kind: "loop_guard",
      data: {
        run_id: "run-eval",
        tool: "bash",
        canonical_argv: ["printf", "ok"],
        cwd: paths.workspace,
        repeat_count: 4,
        threshold: 3,
        decision: "deny",
      },
    },
    {
      kind: "budget/exceeded",
      data: {
        run_id: "run-eval",
        limit_kind: "tool_calls",
        limit: 2,
        used: 2,
        action: "reject_call",
      },
    },
    {
      kind: "network/request",
      data: {
        run_id: "run-eval",
        domain: "allowed.example",
        requests: 1,
        bytes: 4,
        limit: { max_requests: 10, max_bytes: 1_024 },
        decision: "allow",
      },
    },
    {
      kind: "network/redirect",
      data: {
        run_id: "run-eval",
        from: "allowed.example",
        to: "denied.example",
        status: 302,
        decision: "deny",
      },
    },
    {
      kind: "network/rejected",
      data: {
        run_id: "run-eval",
        domain: "denied.example",
        reason: "domain_not_allowed",
        limit: { max_requests: 10, max_bytes: 1_024 },
      },
    },
  ];
  const lines = [
    JSON.stringify({
      type: "codepunk/session",
      version: 1,
      id: "session-eval",
      project_id: "project-eval",
      cwd: paths.workspace,
      created_at: "2026-11-18T00:00:00.000Z",
      pi_version: "1.5.2",
      model: null,
    }),
    ...events.map((event, index) =>
      JSON.stringify({
        type: "codepunk/event",
        version: 1,
        seq: index + 1,
        at: "2026-11-18T00:00:00.000Z",
        kind: event.kind,
        data: event.data,
      }),
    ),
    "",
  ];
  const sessionDir = path.join(
    paths.home,
    "projects",
    "project-eval",
    "sessions",
    "session-eval",
  );
  await fs.mkdir(sessionDir, { recursive: true });
  const logPath = path.join(sessionDir, "session.jsonl");
  await fs.writeFile(logPath, lines.join("\n"));
  const snapshot = await core.readSessionSnapshot({
    rootDir: paths.home,
    projectId: "project-eval",
    sessionId: "session-eval",
  });
  assert.deepEqual(
    snapshot.events.map((event) => event.kind),
    events.map((event) => event.kind),
  );
}

async function runCodingEditMultiHunk(paths, ledger) {
  const target = path.join(paths.workspace, "multi.ts");
  const original = [
    "export function alpha(): number {",
    "  return 1;",
    "}",
    "",
    "export function beta(): number {",
    "  return 2;",
    "}",
    "",
  ].join("\n");
  await fs.writeFile(target, original, "utf8");
  const checkpoints = new core.CheckpointStore({
    sessionDir: path.join(paths.home, "session"),
    workspaceRoot: paths.workspace,
  });
  const edit = await wrappedTool(paths, ledger, "edit", { checkpoints });
  const result = await execute(edit, "eval-edit-multi-1", {
    path: "multi.ts",
    edits: [
      { oldText: "return 1;", newText: "return 10;" },
      { oldText: "return 2;", newText: "return 20;" },
    ],
  });
  assert.notEqual(result.isError, true);
  const updated = await fs.readFile(target, "utf8");
  assert.match(updated, /return 10;/u);
  assert.match(updated, /return 20;/u);
  const entries = await checkpoints.list();
  assert.equal(entries.length, 1);
  await checkpoints.undo(1);
  assert.equal(await fs.readFile(target, "utf8"), original);
}

async function runCodingEditIndentFallback(paths, ledger) {
  const target = path.join(paths.workspace, "indent.ts");
  const original = [
    "export function calc(x: number): number {",
    "    const doubled = x * 2;",
    "    if (doubled > 10) {",
    "        return doubled;",
    "    }",
    "    return x;",
    "}",
    "",
  ].join("\n");
  await fs.writeFile(target, original, "utf8");
  const edit = await wrappedTool(paths, ledger, "edit");
  const result = await execute(edit, "eval-edit-indent-1", {
    path: "indent.ts",
    edits: [
      {
        oldText:
          "  const doubled = x * 2;\n  if (doubled > 10) {\n      return doubled;\n  }",
        newText:
          "  const doubled = x * 3;\n  if (doubled > 10) {\n      return doubled + 1;\n  }",
      },
    ],
  });
  assert.notEqual(result.isError, true);
  const updated = await fs.readFile(target, "utf8");
  assert.match(updated, /^    const doubled = x \* 3;$/mu);
  assert.match(updated, /^        return doubled \+ 1;$/mu);
  const text = result.content.map((b) => b.text ?? "").join("\n");
  assert.match(text, /indentation-normalized/u);

  const dupTarget = path.join(paths.workspace, "dup.ts");
  await fs.writeFile(dupTarget, "    const v = 1;\n    const v = 1;\n", "utf8");
  const dupResult = await execute(edit, "eval-edit-indent-dup", {
    path: "dup.ts",
    edits: [{ oldText: "  const v = 1;", newText: "  const v = 2;" }],
  });
  assert.equal(dupResult.isError, true);
  assert.equal(
    await fs.readFile(dupTarget, "utf8"),
    "    const v = 1;\n    const v = 1;\n",
  );
}

async function runCodingEditAnchorHints(paths, ledger) {
  const target = path.join(paths.workspace, "anchor.ts");
  await fs.writeFile(
    target,
    [
      "export function greet(name: string): string {",
      "  const greeting = `hello ${name}`;",
      "  return greeting.toUpperCase();",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const edit = await wrappedTool(paths, ledger, "edit");
  const result = await execute(edit, "eval-edit-anchor-1", {
    path: "anchor.ts",
    edits: [
      {
        oldText: "const greeting = `hi ${name}`;",
        newText: "const greeting = `hey ${name}`;",
      },
    ],
  });
  assert.equal(result.isError, true);
  const text = result.content.map((b) => b.text ?? "").join("\n");
  assert.match(text, /\[edit anchor hint/u);
  assert.match(text, /L2:[0-9a-f]{4} \|/u);
}

async function runCodingReadLargeOutline(paths, ledger) {
  const target = path.join(paths.workspace, "large.ts");
  const lines = [];
  for (let i = 0; i < 15; i += 1) {
    lines.push(`export function handler${i}(value: number): number {`);
    for (let j = 0; j < 28; j += 1) {
      lines.push(`  const step_${i}_${j} = value + ${j};`);
    }
    lines.push(`  return value + ${i};`);
    lines.push("}");
    lines.push("");
  }
  await fs.writeFile(target, lines.join("\n"), "utf8");
  const read = await wrappedTool(paths, ledger, "read");
  const full = await execute(read, "eval-read-outline-1", { path: "large.ts" });
  assert.notEqual(full.isError, true);
  const fullText = full.content.map((b) => b.text ?? "").join("\n");
  assert.match(
    fullText,
    /\[file outline — \d+ lines, jump with offset\/limit\]/u,
  );
  assert.match(fullText, /L1: function handler0/u);
  assert.match(fullText, /function handler14/u);

  const ranged = await execute(read, "eval-read-outline-2", {
    path: "large.ts",
    offset: 1,
    limit: 5,
  });
  assert.notEqual(ranged.isError, true);
  const rangedText = ranged.content.map((b) => b.text ?? "").join("\n");
  assert.doesNotMatch(rangedText, /\[file outline/u);
}

async function runCodingPostWriteDiagnostics(paths, ledger) {
  const write = await wrappedTool(paths, ledger, "write");
  const brokenTs = await execute(write, "eval-diag-ts-1", {
    path: "broken.ts",
    content: "export function oops(): number {\n  return (1 + 2;\n}\n",
  });
  assert.notEqual(brokenTs.isError, true);
  const tsText = brokenTs.content.map((b) => b.text ?? "").join("\n");
  assert.match(tsText, /\[post-write diagnostics\]/u);
  assert.match(tsText, /broken\.ts:\d+:\d+/u);

  const brokenToml = await execute(write, "eval-diag-toml-1", {
    path: "broken.toml",
    content: "[section\nkey = 'value'\n",
  });
  assert.notEqual(brokenToml.isError, true);
  const tomlText = brokenToml.content.map((b) => b.text ?? "").join("\n");
  assert.match(tomlText, /\[post-write diagnostics\]/u);

  const cleanTs = await execute(write, "eval-diag-ts-clean", {
    path: "clean.ts",
    content: "export function ok(): number {\n  return 42;\n}\n",
  });
  assert.notEqual(cleanTs.isError, true);
  const cleanText = cleanTs.content.map((b) => b.text ?? "").join("\n");
  assert.doesNotMatch(cleanText, /\[post-write diagnostics\]/u);
}

async function runCodingLspSymbolNavigation(paths, ledger) {
  const srcDir = path.join(paths.workspace, "src");
  await fs.mkdir(srcDir, { recursive: true });
  await fs.writeFile(
    path.join(srcDir, "math.ts"),
    [
      "export interface ChecksumResult {",
      "  readonly digest: number;",
      "}",
      "",
      "export function computeChecksum(values: readonly number[]): ChecksumResult {",
      "  return { digest: values.reduce((a, b) => a + b, 0) };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(srcDir, "app.ts"),
    [
      'import { computeChecksum } from "./math.ts";',
      "export const total = computeChecksum([1, 2, 3]);",
      "",
    ].join("\n"),
    "utf8",
  );
  const lsp = await wrappedTool(paths, ledger, "lsp_query");
  const defs = await execute(lsp, "eval-lsp-def-1", {
    action: "definition",
    symbol: "computeChecksum",
  });
  assert.notEqual(defs.isError, true);
  assert.match(
    defs.content.map((b) => b.text ?? "").join("\n"),
    /src\/math\.ts:5/u,
  );
  const refs = await execute(lsp, "eval-lsp-ref-1", {
    action: "references",
    symbol: "computeChecksum",
  });
  assert.notEqual(refs.isError, true);
  assert.match(
    refs.content.map((b) => b.text ?? "").join("\n"),
    /src\/app\.ts:2/u,
  );
  const syms = await execute(lsp, "eval-lsp-sym-1", {
    action: "symbols",
    path: "src/math.ts",
  });
  assert.notEqual(syms.isError, true);
  assert.match(
    syms.content.map((b) => b.text ?? "").join("\n"),
    /ChecksumResult/u,
  );
}

async function runCodingShadowGitBashRewind(paths, ledger) {
  const tracked = path.join(paths.workspace, "tracked.txt");
  const generated = path.join(paths.workspace, "generated.log");
  await fs.writeFile(tracked, "v0\n", "utf8");
  const shadowGit = new core.ShadowGitStore({
    sessionDir: path.join(paths.home, "shadow-session"),
    workspaceRoot: paths.workspace,
  });
  const write = await wrappedTool(paths, ledger, "write", { shadowGit });
  await execute(write, "eval-shadow-write-1", {
    path: "tracked.txt",
    content: "v1\n",
  });
  const directShell = new core.UnsandboxedShell();
  const bash = await wrappedTool(paths, ledger, "bash", {
    sandbox: directShell,
    shadowGit,
  });
  const bashRes = await execute(bash, "eval-shadow-bash-1", {
    command: `${JSON.stringify(process.execPath)} -e 'const fs=require("node:fs"); fs.writeFileSync("tracked.txt","v2\\n"); fs.writeFileSync("generated.log","artifact\\n");'`,
  });
  assert.notEqual(bashRes.isError, true);
  assert.equal(await fs.readFile(tracked, "utf8"), "v2\n");
  assert.equal(await fs.readFile(generated, "utf8"), "artifact\n");

  const step1 = await shadowGit.rewindSteps(1);
  assert.equal(step1.snapshot.tool, "bash");
  assert.ok(step1.restoredFiles.includes("tracked.txt"));
  assert.ok(step1.removedAddedFiles.includes("generated.log"));
  assert.equal(await fs.readFile(tracked, "utf8"), "v1\n");
  await assert.rejects(() => fs.access(generated));

  const step2 = await shadowGit.rewindSteps(1);
  assert.equal(step2.snapshot.tool, "write");
  assert.ok(step2.restoredFiles.includes("tracked.txt"));
  assert.equal(await fs.readFile(tracked, "utf8"), "v0\n");
}

async function runCodingLazyMcpToolSearch(paths, ledger) {
  let active = ["tool_search"];
  const catalog = [
    {
      name: "mcp__github__search_issues",
      description: "Search GitHub issues and pull requests by query",
      exposure: "deferred",
      namespace: { name: "github" },
    },
    {
      name: "mcp__postgres__query",
      description: "Execute a read-only SQL query",
      exposure: "deferred",
      namespace: { name: "postgres" },
    },
  ];
  const rawSearch = core.createToolSearchTool(() => ({
    getActiveToolNames: () => [...active],
    getAllTools: () => catalog,
    setActiveToolsByName: (names) => {
      active = [...names];
    },
  }));
  const search = await core.wrapToolDefinition(
    rawSearch,
    wrapOptions(paths, ledger),
  );
  const hit = await execute(search, "eval-tool-search-1", {
    query: "github issues",
  });
  assert.notEqual(hit.isError, true);
  const hitText = hit.content.map((b) => b.text ?? "").join("\n");
  assert.match(hitText, /mcp__github__search_issues/u);
  assert.equal(active.includes("mcp__github__search_issues"), true);
  assert.equal(active.includes("mcp__postgres__query"), false);

  const miss = await execute(search, "eval-tool-search-2", {
    query: "kubernetes_nonexistent_xyz",
  });
  assert.notEqual(miss.isError, true);
  assert.match(
    miss.content.map((b) => b.text ?? "").join("\n"),
    /No matching tools found\./u,
  );
}

async function runCase(testCase) {
  const paths = await fixture();
  paths.caseId = testCase.id;
  try {
    switch (testCase.kind) {
      case "write":
        await runWrite(paths, paths.ledger);
        return;
      case "loop_guard":
        await runLoopGuard(paths, paths.ledger);
        return;
      case "tool_call_budget":
        await runToolCallBudget(paths, paths.ledger);
        return;
      case "wall_clock_budget":
        await runWallClockBudget(paths, paths.ledger);
        return;
      case "verify":
        await runVerify(paths, paths.ledger, testCase.mode);
        return;
      case "network":
        await runNetwork(testCase.mode);
        return;
      case "schema_compatibility":
        await runSchemaCompatibility(paths);
        return;
      case "coding_edit_multi_hunk":
        await runCodingEditMultiHunk(paths, paths.ledger);
        return;
      case "coding_edit_indent_fallback":
        await runCodingEditIndentFallback(paths, paths.ledger);
        return;
      case "coding_edit_anchor_hints":
        await runCodingEditAnchorHints(paths, paths.ledger);
        return;
      case "coding_read_large_outline":
        await runCodingReadLargeOutline(paths, paths.ledger);
        return;
      case "coding_post_write_diagnostics":
        await runCodingPostWriteDiagnostics(paths, paths.ledger);
        return;
      case "coding_lsp_symbol_navigation":
        await runCodingLspSymbolNavigation(paths, paths.ledger);
        return;
      case "coding_shadow_git_bash_rewind":
        await runCodingShadowGitBashRewind(paths, paths.ledger);
        return;
      case "coding_lazy_mcp_tool_search":
        await runCodingLazyMcpToolSearch(paths, paths.ledger);
        return;
      default:
        fail(`unknown case kind ${testCase.kind}`);
    }
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
}

const cases = await loadCases();
const baseline = await loadBaseline();
const expectedIds = Object.keys(baseline.value.cases);
const actualIds = cases.map((testCase) => testCase.id);
assert.deepEqual(
  [...actualIds].sort(),
  [...expectedIds].sort(),
  "the baseline case set must exactly match eval/cases.jsonl",
);
assert.equal(
  baseline.value.min_passed,
  cases.length,
  "the baseline must require every deterministic case to pass",
);
assert.equal(
  baseline.value.max_failed,
  0,
  "the baseline must not permit a failed case",
);
for (const testCase of cases) {
  assert.equal(
    baseline.value.cases[testCase.id],
    testCase.expected,
    `baseline expectation differs for ${testCase.id}`,
  );
}

const results = [];
for (const testCase of cases) {
  const startedAt = performance.now();
  try {
    await runCase(testCase);
    results.push({
      id: testCase.id,
      expected: testCase.expected,
      actual: "pass",
      duration_ms: Math.round(performance.now() - startedAt),
    });
    process.stdout.write(`pass ${testCase.id}\n`);
  } catch (error) {
    results.push({
      id: testCase.id,
      expected: testCase.expected,
      actual: "fail",
      duration_ms: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    });
    process.stdout.write(`fail ${testCase.id}: ${error.message}\n`);
  }
}

const passed = results.filter((result) => result.actual === "pass").length;
const failed = results.length - passed;
const mismatched = results.filter(
  (result) => result.actual !== result.expected,
);
const summary = {
  cases: results.length,
  passed,
  failed,
  baseline_sha256: baseline.sha256,
  platform: `${process.platform}/${process.arch}`,
  node: process.version,
  results,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(
  `cases=${results.length} passed=${passed} failed=${failed} baseline_sha256=${baseline.sha256}\n`,
);
if (
  failed > baseline.value.max_failed ||
  passed < baseline.value.min_passed ||
  mismatched.length > 0
) {
  process.exitCode = 1;
}
