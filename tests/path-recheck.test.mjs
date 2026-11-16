import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importCore } from "./support/core.mjs";

const core = await importCore();

function approvalChannel(onAsk) {
  return {
    id: "path-recheck-channel",
    kind: "tui",
    isTTY: true,
    async ask(request) {
      await onAsk();
      return {
        request_id: request.request_id,
        answer: "allow",
        scope: "once",
        channel: "tui",
        channel_id: request.channel_id,
        nonce_sha256: request.nonce_sha256,
        worker_id: request.worker_id,
        session_id: request.session_id,
        tool_call_id: request.tool_call_id,
        answered_at: new Date().toISOString(),
      };
    },
  };
}

async function makeWorkspace() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "codepunk-path-recheck-")),
  );
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  return {
    root,
    project,
    home,
    evidence: path.join(root, "evidence.jsonl"),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function writeDefinition(project) {
  return {
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
      await fs.writeFile(path.join(project, params.path), params.content);
      return {
        content: [{ type: "text", text: "written" }],
        details: {},
        structuredContent: { output: "written", exit_code: 0 },
      };
    },
  };
}

async function wrapWrite(project, home, evidence, approval) {
  const ledger = await core.EvidenceLedger.open(evidence);
  return core.wrapToolDefinition(writeDefinition(project), {
    cwd: project,
    workspaceRoot: project,
    deliveryRoot: project,
    codepunkHome: home,
    sessionId: "session-recheck",
    runId: "run-recheck",
    writeSet: [project],
    mode: "interactive",
    approvalMode: "ask",
    approval,
    autonomy: new core.AutonomyController({
      profile: "ask",
      source: "cli",
      rules: [],
      rulesSha256: null,
    }),
    ledger,
    sandbox: null,
  });
}

test("a write target swapped during approval is refused", async () => {
  const workspace = await makeWorkspace();
  try {
    const target = path.join(workspace.project, ".env");
    const outside = path.join(workspace.root, "outside.txt");
    await fs.writeFile(target, "TOKEN=original\n");
    await fs.writeFile(outside, "outside\n");

    const approval = new core.ApprovalBroker();
    let swapped = false;
    approval.registerChannel(
      approvalChannel(async () => {
        swapped = true;
        await fs.rm(target);
        await fs.symlink(outside, target);
      }),
    );

    const wrapped = await wrapWrite(
      workspace.project,
      workspace.home,
      workspace.evidence,
      approval,
    );
    const result = await wrapped.execute(
      "call-swapped",
      { path: ".env", content: "TOKEN=overwritten\n" },
      undefined,
      undefined,
      undefined,
    );

    assert.equal(swapped, true);
    assert.equal(result.isError, true);
    assert.match(
      String(result.content[0]?.text ?? ""),
      /denied: path\.recheck/u,
    );
    assert.equal(await fs.readFile(outside, "utf8"), "outside\n");
    assert.equal((await fs.lstat(target)).isSymbolicLink(), true);

    const record = (
      await core.readEvidenceFile(workspace.evidence)
    ).records.find((candidate) => candidate.tool_call_id === "call-swapped");
    assert.ok(record);
    assert.equal(record.decision, "deny");
    assert.equal(record.rule, "path.recheck");
    assert.equal(record.outcome, "denied");
  } finally {
    await workspace.cleanup();
  }
});

test("an unchanged target still executes", async () => {
  const workspace = await makeWorkspace();
  try {
    const target = path.join(workspace.project, "note.txt");
    await fs.writeFile(target, "original\n");

    const approval = new core.ApprovalBroker();
    approval.registerChannel(approvalChannel(async () => {}));

    const wrapped = await wrapWrite(
      workspace.project,
      workspace.home,
      workspace.evidence,
      approval,
    );
    const result = await wrapped.execute(
      "call-clean",
      { path: "note.txt", content: "overwritten\n" },
      undefined,
      undefined,
      undefined,
    );

    assert.equal(result.isError, undefined);
    assert.equal(await fs.readFile(target, "utf8"), "overwritten\n");
    const record = (
      await core.readEvidenceFile(workspace.evidence)
    ).records.find((candidate) => candidate.tool_call_id === "call-clean");
    assert.ok(record);
    assert.equal(record.decision, "allow");
    assert.equal(record.outcome, "completed");
  } finally {
    await workspace.cleanup();
  }
});
