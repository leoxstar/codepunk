import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";

const core = await importCore();

const HASH = `sha256:${"a".repeat(64)}`;
let callCounter = 0;

async function setup() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "codepunk-mode-matrix-")),
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

function fakeSandbox(sandboxed = true) {
  const descriptor = sandboxed
    ? { backend: "srt", version: "test", profile_sha256: HASH }
    : { backend: "none", version: null, profile_sha256: null };
  return {
    descriptor,
    sandboxed,
    commands: [],
    async execCommand(command, cwd) {
      this.commands.push({ command, cwd });
      return {
        output: "sandbox ok",
        exitCode: 0,
        cancelled: false,
        timedOut: false,
        executor: sandboxed ? "srt" : "direct",
        descriptor,
      };
    },
    async execArgv(argv, cwd) {
      this.commands.push({ argv, cwd });
      return {
        output: "sandbox ok",
        exitCode: 0,
        cancelled: false,
        timedOut: false,
        executor: sandboxed ? "srt" : "direct",
        descriptor,
      };
    },
  };
}

function answerFor(request, answer = "allow") {
  return {
    request_id: request.request_id,
    answer,
    scope: "once",
    channel: "tui",
    channel_id: request.channel_id,
    nonce_sha256: request.nonce_sha256,
    worker_id: request.worker_id,
    session_id: request.session_id,
    tool_call_id: request.tool_call_id,
    answered_at: new Date().toISOString(),
  };
}

function broker(answer = "allow") {
  const approval = new core.ApprovalBroker();
  const state = { asked: 0 };
  approval.registerChannel({
    id: "tui-modes",
    kind: "tui",
    isTTY: true,
    async ask(request) {
      state.asked += 1;
      return answerFor(request, answer);
    },
  });
  return { approval, state };
}

function fakeReviewer() {
  return {
    provider: "fake",
    model: "reviewer",
    calls: 0,
    async review() {
      this.calls += 1;
      return {
        decision: "allow",
        reason: "reviewer allowed",
        evidence: {
          kind: "model",
          provider: "fake",
          model: "reviewer",
          decision: "allow",
          reason: "reviewer allowed",
          action_sha256: HASH,
          latency_ms: 1,
        },
      };
    },
  };
}

async function runUserBash(
  paths,
  command,
  {
    approvalMode,
    autonomy = "ask",
    approval = null,
    sandbox = fakeSandbox(),
    reviewer = null,
  },
) {
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  const toolCallId = `mode-${++callCounter}`;
  const result = await core.wrapUserBashCommand(command, toolCallId, {
    cwd: paths.workspace,
    workspaceRoot: paths.workspace,
    deliveryRoot: paths.workspace,
    codepunkHome: paths.home,
    sessionId: "session-modes",
    runId: "run-modes",
    writeSet: [paths.workspace],
    mode: "interactive",
    approvalMode,
    autonomy: new core.AutonomyController({
      profile: autonomy,
      source: "cli",
      rules: [],
      rulesSha256: null,
    }),
    approval,
    reviewer,
    ledger,
    sandbox,
  });
  const executed = "operations" in result;
  if (executed) {
    await result.operations.exec(command, paths.workspace, {});
  }
  const record = (await core.readEvidenceFile(paths.evidence)).records.find(
    (candidate) => candidate.tool_call_id === toolCallId,
  );
  assert.ok(record);
  return { executed, record, result, sandbox, toolCallId };
}

test("read-only allows safe reads and denies shell mutations", async () => {
  const paths = await setup();
  const date = await runUserBash(paths, "date +%A", {
    approvalMode: "ask",
    autonomy: "read-only",
  });
  assert.equal(date.executed, true);
  assert.match(date.record.rule, /^shell\.read\./u);
  assert.equal(date.record.approval_mode, "ask");
  assert.deepEqual(date.sandbox.commands, [
    { command: "date +%A", cwd: paths.workspace },
  ]);

  const touch = await runUserBash(paths, "touch probe.txt", {
    approvalMode: "ask",
    autonomy: "read-only",
  });
  assert.equal(touch.executed, false);
  assert.equal(touch.record.decision, "deny");
  assert.equal(touch.record.rule, "autonomy.read_only.ask");
  assert.deepEqual(touch.sandbox.commands, []);
});

test("standard asks for a shell mutation and honors allow or deny", async () => {
  const paths = await setup();
  const allowed = broker("allow");
  const allow = await runUserBash(paths, "touch probe.txt", {
    approvalMode: "ask",
    approval: allowed.approval,
  });
  assert.equal(allow.executed, true);
  assert.equal(allow.record.approval.answer, "allow");
  assert.equal(allowed.state.asked, 1);

  const denied = broker("deny");
  const deny = await runUserBash(paths, "touch probe.txt", {
    approvalMode: "ask",
    approval: denied.approval,
  });
  assert.equal(deny.executed, false);
  assert.equal(deny.record.rule, "approval.denied");
  assert.equal(deny.record.approval.answer, "deny");
  assert.equal(denied.state.asked, 1);
});

test("auto approves ordinary shell but keeps destructive actions human", async () => {
  const paths = await setup();
  const touch = await runUserBash(paths, "touch probe.txt", {
    approvalMode: "auto",
  });
  assert.equal(touch.executed, true);
  assert.equal(touch.record.decision, "allow");
  assert.equal(touch.record.approval, null);
  assert.equal(touch.record.approval_mode, "auto");

  const reviewer = fakeReviewer();
  const destructive = await runUserBash(paths, "rm -rf build", {
    approvalMode: "auto",
    reviewer,
  });
  assert.equal(destructive.executed, false);
  assert.equal(destructive.record.rule, "approval.unavailable");
  assert.equal(reviewer.calls, 0);
});

test("auto-approve executes non-MCP asks without a human channel", async () => {
  const paths = await setup();
  const destructive = await runUserBash(paths, "rm -rf build", {
    approvalMode: "allow",
  });
  assert.equal(destructive.executed, true);
  assert.equal(destructive.record.decision, "allow");
  assert.equal(destructive.record.approval, null);
});

test("full-access executes uncovered shell actions and records the boundary", async () => {
  const paths = await setup();
  const result = await runUserBash(paths, "rm -rf build", {
    approvalMode: "allow",
    sandbox: fakeSandbox(false),
  });
  assert.equal(result.executed, true);
  assert.equal(result.record.coverage, "uncovered");
  assert.deepEqual(result.record.sandbox, {
    backend: "none",
    version: null,
    profile_sha256: null,
  });
});
