import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { importCore } from "./support/core.mjs";

const core = await importCore();

function hashFile(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function setup() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "codepunk-tools-")),
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

test("write records before/after hashes and a denied write is byte-identical", async () => {
  const paths = await setup();
  const target = path.join(paths.workspace, "note.txt");
  await fs.writeFile(target, "before\n");
  await fs.writeFile(path.join(paths.workspace, "AGENTS.md"), "protected\n");
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  const definitions = await core.createCodepunkToolDefinitions(
    paths.workspace,
    null,
  );
  const options = wrapOptions(paths, { ledger });
  const byName = Object.fromEntries(
    await Promise.all(
      definitions.map(async (definition) => [
        definition.name,
        await core.wrapToolDefinition(definition, options),
      ]),
    ),
  );

  const writeResult = await byName.write.execute(
    "call-write",
    { path: "note.txt", content: "after\n" },
    undefined,
    undefined,
    {},
  );
  assert.equal(writeResult.isError, undefined);
  assert.equal(await fs.readFile(target, "utf8"), "after\n");

  const protectedPath = path.join(paths.workspace, "AGENTS.md");
  const before = await fs.readFile(protectedPath);
  const denied = await byName.write.execute(
    "call-denied-write",
    { path: "AGENTS.md", content: "changed\n" },
    undefined,
    undefined,
    {},
  );
  assert.equal(denied.isError, true);
  assert.deepEqual(await fs.readFile(protectedPath), before);

  const records = (await core.readEvidenceFile(paths.evidence)).records;
  const allowed = records.find(
    (record) => record.tool_call_id === "call-write",
  );
  assert.equal(allowed.decision, "allow");
  assert.equal(allowed.before_sha256, hashFile(Buffer.from("before\n")));
  assert.equal(allowed.after_sha256, hashFile(Buffer.from("after\n")));
  assert.match(allowed.diff_sha256, /^sha256:/u);
  assert.equal(core.validateEvidenceForClass(allowed).ok, true);

  const denial = records.find(
    (record) => record.tool_call_id === "call-denied-write",
  );
  assert.equal(denial.decision, "deny");
  assert.equal(denial.before_sha256, hashFile(before));
  assert.equal(denial.after_sha256, denial.before_sha256);
  assert.equal(core.validateEvidenceForClass(denial).ok, true);
});

test("parallel writes record a serialized evidence chain for the same file", async () => {
  const paths = await setup();
  const target = path.join(paths.workspace, "parallel.txt");
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

  await Promise.all([
    write.execute(
      "call-parallel-a",
      { path: "parallel.txt", content: "first\n" },
      undefined,
      undefined,
      {},
    ),
    write.execute(
      "call-parallel-b",
      { path: "parallel.txt", content: "second\n" },
      undefined,
      undefined,
      {},
    ),
  ]);

  const records = (await core.readEvidenceFile(paths.evidence)).records.filter(
    (record) =>
      record.tool_call_id === "call-parallel-a" ||
      record.tool_call_id === "call-parallel-b",
  );
  assert.equal(records.length, 2);
  assert.equal(records[0].tool_call_id, "call-parallel-a");
  assert.equal(records[1].tool_call_id, "call-parallel-b");
  assert.equal(records[0].before_sha256, hashFile(Buffer.from("before\n")));
  assert.equal(records[0].after_sha256, hashFile(Buffer.from("first\n")));
  assert.equal(
    records[1].before_sha256,
    records[0].after_sha256,
    "the second call must snapshot the first call's committed bytes",
  );
  assert.equal(records[1].after_sha256, hashFile(Buffer.from("second\n")));
});

test("successful writes create a bounded file checkpoint for undo", async () => {
  const paths = await setup();
  const target = path.join(paths.workspace, "checkpoint.txt");
  await fs.writeFile(target, "before\n");
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  const checkpoints = new core.CheckpointStore({
    sessionDir: path.join(paths.root, "session"),
    workspaceRoot: paths.workspace,
  });
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
    wrapOptions(paths, { ledger, checkpoints }),
  );

  const result = await write.execute(
    "call-checkpoint",
    { path: "checkpoint.txt", content: "after\n" },
    undefined,
    undefined,
    {},
  );
  assert.equal(result.isError, undefined);
  const entries = await checkpoints.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tool_call_id, "call-checkpoint");
  assert.equal(entries[0].target, target);
  assert.equal(entries[0].before.sha256, hashFile(Buffer.from("before\n")));
  assert.equal(entries[0].after.sha256, hashFile(Buffer.from("after\n")));

  await checkpoints.undo();
  assert.equal(await fs.readFile(target, "utf8"), "before\n");
});

test("approval carries a diff preview and returns denial guidance", async () => {
  const paths = await setup();
  const target = path.join(paths.workspace, "note.txt");
  await fs.writeFile(target, "before\n");
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  let request;
  const broker = new core.ApprovalBroker();
  broker.registerChannel({
    id: "tui-preview",
    kind: "tui",
    isTTY: true,
    async ask(value) {
      request = value;
      return {
        request_id: value.request_id,
        answer: "deny",
        scope: "once",
        guidance: "keep the original file and explain the change first",
        channel: "tui",
        channel_id: value.channel_id,
        nonce_sha256: value.nonce_sha256,
        worker_id: value.worker_id,
        session_id: value.session_id,
        tool_call_id: value.tool_call_id,
        answered_at: new Date().toISOString(),
      };
    },
  });
  const definitions = await core.createCodepunkToolDefinitions(
    paths.workspace,
    null,
  );
  const write = definitions.find((definition) => definition.name === "write");
  assert.ok(write);
  const wrapped = await core.wrapToolDefinition(
    write,
    wrapOptions(paths, {
      ledger,
      approval: broker,
      userRules: [{ id: "ask-write", tool: "write", decision: "ask" }],
    }),
  );
  const result = await wrapped.execute(
    "call-preview",
    { path: "note.txt", content: "after\n" },
    undefined,
    undefined,
    {},
  );
  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /User guidance: keep the original file/u,
  );
  assert.match(request.diff_preview, /-before/u);
  assert.match(request.diff_preview, /\+after/u);
  assert.match(request.diff_sha256, /^sha256:/u);
  assert.match(request.coverage_preview, /^app-layer:/u);
  assert.equal(await fs.readFile(target, "utf8"), "before\n");
  const record = (await core.readEvidenceFile(paths.evidence)).records.find(
    (entry) => entry.tool_call_id === "call-preview",
  );
  assert.equal(record.decision, "deny");
  assert.equal(record.approval.diff_sha256, request.diff_sha256);
  assert.equal(
    record.approval.guidance,
    "keep the original file and explain the change first",
  );
});

test("a network approval explains the sandbox egress allowlist", async () => {
  const paths = await setup();
  const shell = new core.UnsandboxedShell();
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  const requests = [];
  const broker = new core.ApprovalBroker();
  broker.registerChannel({
    id: "tui-network",
    kind: "tui",
    isTTY: true,
    async ask(value) {
      requests.push(value);
      return {
        request_id: value.request_id,
        answer: "deny",
        scope: "once",
        channel: "tui",
        channel_id: value.channel_id,
        nonce_sha256: value.nonce_sha256,
        worker_id: value.worker_id,
        session_id: value.session_id,
        tool_call_id: value.tool_call_id,
        answered_at: new Date().toISOString(),
      };
    },
  });
  try {
    const definitions = await core.createCodepunkToolDefinitions(
      paths.workspace,
      shell,
    );
    const bash = definitions.find((definition) => definition.name === "bash");
    assert.ok(bash);

    const withoutEgress = await core.wrapToolDefinition(
      bash,
      wrapOptions(paths, { approval: broker, sandbox: shell, ledger }),
    );
    await withoutEgress.execute(
      "call-network-empty",
      { command: "curl https://example.com" },
      undefined,
      undefined,
      {},
    );
    assert.match(requests[0].reason, /sandbox\.network_allow is empty/u);

    const withEgress = await core.wrapToolDefinition(
      bash,
      wrapOptions(paths, {
        approval: broker,
        sandbox: shell,
        ledger,
        networkAllowedDomains: ["registry.npmjs.org"],
        networkDeniedDomains: ["evil.npmjs.org"],
      }),
    );
    await withEgress.execute(
      "call-network-allowed",
      { command: "npm install" },
      undefined,
      undefined,
      {},
    );
    assert.match(
      requests[1].reason,
      /srt egress allowlist: registry\.npmjs\.org/u,
    );
    assert.match(requests[1].reason, /denied: evil\.npmjs\.org/u);
  } finally {
    await shell.close();
  }
});

test("invalid tool arguments are denied before the tool body", async () => {
  const paths = await setup();
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  let bodyCalled = false;
  const read = await core.wrapToolDefinition(
    {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute() {
        bodyCalled = true;
        return {
          content: [{ type: "text", text: "unexpected" }],
          details: {},
        };
      },
    },
    wrapOptions(paths, { ledger }),
  );

  const result = await read.execute(
    "call-invalid-arguments",
    { path: 42 },
    undefined,
    undefined,
    {},
  );

  assert.equal(result.isError, true);
  assert.equal(bodyCalled, false);
  assert.match(
    result.content.map((part) => part.text ?? "").join("\n"),
    /invalid tool arguments: \/path must be string/u,
  );
  const record = (await core.readEvidenceFile(paths.evidence)).records.find(
    (item) => item.tool_call_id === "call-invalid-arguments",
  );
  assert.ok(record);
  assert.equal(record.decision, "deny");
  assert.equal(record.rule, "tool.invalid_arguments");
  assert.equal(record.coverage, "uncovered");
  assert.deepEqual(record.coverage_basis, ["arguments"]);
  assert.equal(core.validateEvidenceForClass(record).ok, true);
});

test("evidence previews redact tokens and the local home", async () => {
  const paths = await setup();
  const previewToken = "abcdefghijklmnop";
  const previewValue = "abcdefghijklmnop";
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  const read = await core.wrapToolDefinition(
    {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute() {
        return {
          content: [
            {
              type: "text",
              text: [
                `home=${paths.home}`,
                `Authorization: Bearer ${previewToken}`,
                `api_key=${previewValue}`,
                "",
              ].join("\n"),
            },
          ],
          details: {},
        };
      },
    },
    wrapOptions(paths, { ledger, maxToolOutputTokens: 100 }),
  );

  const result = await read.execute(
    "call-redacted-output",
    { path: "note.txt" },
    undefined,
    undefined,
    {},
  );
  assert.equal(result.isError, undefined);
  const record = (await core.readEvidenceFile(paths.evidence)).records.find(
    (entry) => entry.tool_call_id === "call-redacted-output",
  );
  assert.ok(record);
  assert.doesNotMatch(record.output_preview, new RegExp(paths.home, "u"));
  assert.doesNotMatch(record.output_preview, new RegExp(previewToken, "u"));
  assert.doesNotMatch(record.output_preview, new RegExp(previewValue, "u"));
  assert.match(record.output_preview, /Bearer \[REDACTED_TOKEN\]/u);
  assert.match(record.output_preview, /api_key=\[REDACTED_SECRET\]/u);
});

test("large tool output becomes a hash-bound artifact", async () => {
  const paths = await setup();
  const artifactsDir = path.join(paths.root, "artifacts");
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  const largeOutput = `header\n${"y".repeat(2_000)}\n`;
  const read = await core.wrapToolDefinition(
    {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute() {
        return {
          content: [{ type: "text", text: largeOutput }],
          details: {},
        };
      },
    },
    wrapOptions(paths, {
      ledger,
      artifactsDir,
      artifactThresholdTokens: 16,
      maxToolOutputTokens: 32,
    }),
  );

  const result = await read.execute(
    "call-large-output",
    { path: "note.txt" },
    undefined,
    undefined,
    {},
  );
  const visible = result.content.map((part) => part.text).join("\n");
  assert.match(visible, /tool output artifact/u);
  assert.ok(visible.length < largeOutput.length);

  const record = (await core.readEvidenceFile(paths.evidence)).records.find(
    (entry) => entry.tool_call_id === "call-large-output",
  );
  assert.match(record.output_ref, /^artifacts\/session-1\/[0-9A-Z]+\.txt$/u);
  assert.equal(record.output_sha256, core.outputSha(largeOutput));
  assert.ok(record.output_preview.length <= core.OUTPUT_PREVIEW_CHARS);
  const artifactPath = path.join(paths.root, record.output_ref);
  assert.equal(await fs.readFile(artifactPath, "utf8"), largeOutput);
  assert.equal(core.validateEvidenceForClass(record).ok, true);

  const smallLedger = await core.EvidenceLedger.open(
    path.join(paths.root, "small.jsonl"),
  );
  const smallRead = await core.wrapToolDefinition(
    {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute() {
        return {
          content: [{ type: "text", text: "small\n" }],
          details: {},
        };
      },
    },
    wrapOptions(paths, {
      ledger: smallLedger,
      artifactsDir,
      artifactThresholdTokens: 16,
      maxToolOutputTokens: 32,
    }),
  );
  await smallRead.execute(
    "call-small-output",
    { path: "note.txt" },
    undefined,
    undefined,
    {},
  );
  const small = (
    await core.readEvidenceFile(path.join(paths.root, "small.jsonl"))
  ).records.find((entry) => entry.tool_call_id === "call-small-output");
  assert.equal(small.output_ref, null);
});

test("the wrapped bash tool uses srt and records the executor", async () => {
  const paths = await setup();
  const sandbox = await core.SrtSandbox.create({
    cwd: paths.workspace,
    workspaceRoot: paths.workspace,
    deliveryRoot: paths.workspace,
    codepunkHome: paths.home,
    writeSet: [paths.workspace],
  });
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  try {
    const definitions = await core.createCodepunkToolDefinitions(
      paths.workspace,
      sandbox,
    );
    const bash = definitions.find((definition) => definition.name === "bash");
    assert.ok(bash);
    const wrapped = await core.wrapToolDefinition(
      bash,
      wrapOptions(paths, { ledger, sandbox }),
    );
    const result = await wrapped.execute(
      "call-shell",
      { command: "printf ok" },
      undefined,
      undefined,
      {},
    );
    assert.notEqual(result.isError, true);
    const record = (await core.readEvidenceFile(paths.evidence)).records[0];
    assert.equal(record.tool, "bash");
    assert.equal(record.decision, "allow");
    assert.equal(record.exit_code, 0);
    assert.equal(record.executor, "srt");
    assert.equal(record.sandbox.backend, "srt");
    assert.equal(record.coverage, "enforced");
    assert.equal(core.validateEvidenceForClass(record).ok, true);

    const dateResult = await wrapped.execute(
      "call-date",
      { command: "date +%A" },
      undefined,
      undefined,
      {},
    );
    assert.notEqual(dateResult.isError, true);
    const dateRecord = (
      await core.readEvidenceFile(paths.evidence)
    ).records.find((candidate) => candidate.tool_call_id === "call-date");
    assert.ok(dateRecord);
    assert.equal(dateRecord.decision, "allow");
    assert.equal(dateRecord.rule, "shell.read.date");
  } finally {
    await sandbox.close();
  }
});

test("headless auto mode runs routine shell without an approval channel", async () => {
  const paths = await setup();
  const sandbox = await core.SrtSandbox.create({
    cwd: paths.workspace,
    workspaceRoot: paths.workspace,
    deliveryRoot: paths.workspace,
    codepunkHome: paths.home,
    writeSet: [paths.workspace],
  });
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  try {
    const definitions = await core.createCodepunkToolDefinitions(
      paths.workspace,
      sandbox,
    );
    const bash = definitions.find((definition) => definition.name === "bash");
    assert.ok(bash);
    const wrapped = await core.wrapToolDefinition(
      bash,
      wrapOptions(paths, {
        ledger,
        sandbox,
        mode: "headless",
        approvalMode: "auto",
      }),
    );

    const allowed = await wrapped.execute(
      "call-auto",
      { command: "mkdir auto-dir" },
      undefined,
      undefined,
      {},
    );
    assert.notEqual(allowed.isError, true, JSON.stringify(allowed));
    assert.equal(
      (await fs.stat(path.join(paths.workspace, "auto-dir"))).isDirectory(),
      true,
    );

    const denied = await wrapped.execute(
      "call-denied",
      { command: "rm -rf auto-dir" },
      undefined,
      undefined,
      {},
    );
    assert.equal(denied.isError, true);
    assert.equal(
      (await fs.stat(path.join(paths.workspace, "auto-dir"))).isDirectory(),
      true,
    );

    const network = await wrapped.execute(
      "call-network",
      { command: "curl https://example.com" },
      undefined,
      undefined,
      {},
    );
    assert.equal(network.isError, true);
    const records = (await core.readEvidenceFile(paths.evidence)).records;
    assert.equal(
      records.find((record) => record.tool_call_id === "call-auto")?.decision,
      "allow",
    );
    assert.equal(
      records.find((record) => record.tool_call_id === "call-denied")?.decision,
      "deny",
    );
    assert.equal(
      records.find((record) => record.tool_call_id === "call-network")
        ?.decision,
      "deny",
    );
  } finally {
    await sandbox.close();
  }
});

test("tool evidence distinguishes failures and cancellation from allow", async () => {
  const paths = await setup();
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  const descriptor = {
    backend: "srt",
    version: "test",
    profile_sha256: null,
  };
  const failedSandbox = {
    descriptor,
    sandboxed: true,
    async execCommand() {
      throw new Error("sandbox provider failed");
    },
    async execArgv() {
      throw new Error("sandbox provider failed");
    },
  };
  const failedDefinitions = await core.createCodepunkToolDefinitions(
    paths.workspace,
    failedSandbox,
  );
  const failedBash = failedDefinitions.find(
    (definition) => definition.name === "bash",
  );
  assert.ok(failedBash);
  const failed = await core.wrapToolDefinition(failedBash, {
    ...wrapOptions(paths, { ledger, sandbox: failedSandbox }),
  });
  const failedResult = await failed.execute(
    "call-failed-shell",
    { command: "printf ok" },
    undefined,
    undefined,
    {},
  );
  assert.equal(failedResult.isError, true);

  const cancelledSandbox = {
    descriptor,
    sandboxed: true,
    async execCommand() {
      return {
        output: "",
        exitCode: null,
        cancelled: true,
        timedOut: false,
        executor: "srt",
        descriptor,
      };
    },
    async execArgv() {
      throw new Error("not used");
    },
  };
  const cancelledDefinitions = await core.createCodepunkToolDefinitions(
    paths.workspace,
    cancelledSandbox,
  );
  const cancelledBash = cancelledDefinitions.find(
    (definition) => definition.name === "bash",
  );
  assert.ok(cancelledBash);
  const cancelled = await core.wrapToolDefinition(cancelledBash, {
    ...wrapOptions(paths, { ledger, sandbox: cancelledSandbox }),
  });
  const cancelledResult = await cancelled.execute(
    "call-cancelled-shell",
    { command: "printf ok" },
    undefined,
    undefined,
    {},
  );
  assert.equal(cancelledResult.isError, true);

  const records = (await core.readEvidenceFile(paths.evidence)).records;
  const failedRecord = records.find(
    (record) => record.tool_call_id === "call-failed-shell",
  );
  assert.equal(failedRecord.decision, "allow");
  assert.equal(failedRecord.outcome, "failed");
  const cancelledRecord = records.find(
    (record) => record.tool_call_id === "call-cancelled-shell",
  );
  assert.equal(cancelledRecord.decision, "allow");
  assert.equal(cancelledRecord.outcome, "cancelled");
});

test("artifact truncation preserves non-text tool content", async () => {
  const paths = await setup();
  const artifactsDir = path.join(paths.root, "artifacts");
  await fs.mkdir(artifactsDir);
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  const descriptor = {
    backend: "srt",
    version: "test",
    profile_sha256: null,
  };
  const sandbox = {
    descriptor,
    sandboxed: true,
    async execCommand() {
      throw new Error("not used");
    },
    async execArgv() {
      throw new Error("not used");
    },
  };
  const definition = {
    name: "bash",
    label: "fake bash",
    description: "fake bash",
    parameters: Type.Object({ command: Type.String() }),
    async execute() {
      return {
        content: [
          { type: "text", text: "x".repeat(20_000) },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        details: {},
      };
    },
  };
  const wrapped = await core.wrapToolDefinition(definition, {
    ...wrapOptions(paths, {
      ledger,
      sandbox,
      artifactsDir,
      artifactThresholdTokens: 1,
      maxToolOutputTokens: 10,
    }),
  });
  const result = await wrapped.execute(
    "call-image-artifact",
    { command: "printf ok" },
    undefined,
    undefined,
    {},
  );
  assert.equal(result.isError, undefined);
  assert.ok(result.content.some((part) => part.type === "image"));
  const text = result.content.find((part) => part.type === "text");
  assert.ok(text);
  assert.ok(text.text.length < 20_000);
});
