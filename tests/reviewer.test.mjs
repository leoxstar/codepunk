import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import { assertPrivateFile } from "./support/helpers.mjs";

const core = await importCore();

const HASH = `sha256:${"a".repeat(64)}`;

function reviewInput() {
  return {
    tool: "bash",
    command: "curl https://example.com",
    argv: ["curl", "https://example.com"],
    cwd: "/workspace",
    path: null,
    approvalClass: "network",
    policyRule: "shell.network",
    policyReason: "network command",
    approvalReason: "network command; sandbox allowlist is empty",
    argsPreview: null,
    argsSha256: null,
    diffSha256: null,
  };
}

function assistant(text, overrides = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake",
    model: "reviewer",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function fakeRuntime(response) {
  return {
    async completeSimple(model, context, options) {
      if (typeof response === "function") {
        return response(model, context, options);
      }
      return response;
    },
  };
}

function fakeModel() {
  return { provider: "fake", id: "reviewer" };
}

test("reviewer eligibility is limited to unresolved network and exec asks", () => {
  assert.equal(core.canReviewerResolveApproval("network"), true);
  assert.equal(core.canReviewerResolveApproval("exec"), true);
  for (const approvalClass of [
    "routine",
    "shell",
    "destructive",
    "sensitive",
    "protected",
    "mcp",
    "policy",
    "unknown",
  ]) {
    assert.equal(core.canReviewerResolveApproval(approvalClass), false);
  }
});

test("reviewer parses allow and deny decisions into bounded evidence", async () => {
  for (const decision of ["allow", "deny"]) {
    const reviewer = new core.ModelActionReviewer({
      runtime: fakeRuntime(
        assistant(JSON.stringify({ decision, reason: `${decision} reason` })),
      ),
      model: fakeModel(),
    });
    const result = await reviewer.review(reviewInput());
    assert.equal(result.decision, decision);
    assert.equal(result.reason, `${decision} reason`);
    assert.equal(result.evidence.kind, "model");
    assert.equal(result.evidence.provider, "fake");
    assert.equal(result.evidence.model, "reviewer");
    assert.equal(result.evidence.decision, decision);
    assert.match(result.evidence.action_sha256, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(result.evidence.latency_ms >= 0, true);
  }
});

test("reviewer malformed output and upstream errors fail closed to abstain", async () => {
  const malformed = new core.ModelActionReviewer({
    runtime: fakeRuntime(assistant("not json")),
    model: fakeModel(),
  });
  const invalid = await malformed.review(reviewInput());
  assert.equal(invalid.decision, "abstain");
  assert.match(invalid.reason, /did not return a JSON object/u);

  const upstream = new core.ModelActionReviewer({
    runtime: fakeRuntime(
      assistant("", {
        content: [],
        stopReason: "error",
        errorMessage: "upstream 401",
      }),
    ),
    model: fakeModel(),
  });
  const failed = await upstream.review(reviewInput());
  assert.equal(failed.decision, "abstain");
  assert.equal(failed.evidence.error, "upstream 401");
});

test("reviewer timeout abstains with an explicit error", async () => {
  const reviewer = new core.ModelActionReviewer({
    runtime: fakeRuntime(
      (_model, _context, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => {
              const error = new Error("review timed out");
              error.name = "TimeoutError";
              reject(error);
            },
            { once: true },
          );
        }),
    ),
    model: fakeModel(),
    timeoutMs: 5,
  });
  const result = await reviewer.review(reviewInput());
  assert.equal(result.decision, "abstain");
  assert.match(result.evidence.error ?? "", /timed out/u);
});

test("reviewer resolution rejects a missing model or credential", async () => {
  await assert.rejects(
    () =>
      core.resolveActionReviewer({
        mode: "model",
        runtime: {
          getModel() {
            return undefined;
          },
          async checkAuth() {
            return undefined;
          },
          async completeSimple() {
            throw new Error("must not be called");
          },
        },
        fallbackModel: undefined,
        modelReference: "fake/missing",
        timeoutMs: 20_000,
      }),
    /not in the Pi catalog/u,
  );

  await assert.rejects(
    () =>
      core.resolveActionReviewer({
        mode: "model",
        runtime: {
          getModel() {
            return fakeModel();
          },
          async checkAuth() {
            return undefined;
          },
          async completeSimple() {
            throw new Error("must not be called");
          },
        },
        fallbackModel: fakeModel(),
        modelReference: null,
        timeoutMs: 20_000,
      }),
    /no credentials for reviewer model/u,
  );

  assert.equal(
    await core.resolveActionReviewer({
      mode: "off",
      runtime: {
        getModel() {
          throw new Error("must not be called");
        },
        async checkAuth() {
          throw new Error("must not be called");
        },
        async completeSimple() {
          throw new Error("must not be called");
        },
      },
      fallbackModel: undefined,
      modelReference: null,
      timeoutMs: 20_000,
    }),
    null,
  );
});

test("a deferred reviewer does not block startup and abstains on resolve failure", async () => {
  const reviewer = new core.DeferredActionReviewer({
    provider: "probe",
    model: "reviewer",
    async resolve() {
      throw new Error("no credentials for reviewer model probe/reviewer");
    },
  });
  const result = await reviewer.review({
    tool: "bash",
    command: "curl https://example.com",
    argv: ["curl", "https://example.com"],
    cwd: "/workspace",
    path: null,
    approvalClass: "network",
    policyRule: "shell.network",
    policyReason: "network command",
    approvalReason: "network command",
    argsPreview: null,
    argsSha256: null,
    diffSha256: null,
  });
  assert.equal(result.decision, "abstain");
  assert.match(result.reason, /no credentials/u);
  assert.equal(result.evidence.provider, "probe");
  assert.equal(result.evidence.model, "reviewer");
  assert.equal(result.evidence.decision, "abstain");
  assert.match(result.evidence.action_sha256, /^sha256:[0-9a-f]{64}$/u);
});

test("reviewer configuration does not block runtime startup before a review", async () => {
  const paths = await setup();
  await fs.writeFile(
    path.join(paths.home, "config.toml"),
    [
      "[approval]",
      'reviewer = "model"',
      'reviewer_model = "probe/missing"',
      "",
    ].join("\n"),
  );
  const runtime = await core.createRuntime({
    cwd: paths.workspace,
    environment: { CODEPUNK_HOME: paths.home },
    allowMissingModel: true,
  });
  try {
    assert.equal(runtime.config.approval.reviewer, "model");
    assert.ok(runtime.host);
  } finally {
    await runtime.dispose();
  }
});

test("an approval channel failure is recorded as unavailable evidence, not user denial", async () => {
  const paths = await setup();
  const broker = new core.ApprovalBroker();
  broker.registerChannel({
    id: "broken-tui",
    kind: "tui",
    isTTY: true,
    async ask() {
      throw new Error("surface failed");
    },
  });
  const { wrapped } = await wrappedWrite(paths, {
    approval: broker,
    approvalMode: "ask",
  });
  const result = await wrapped.execute(
    "call-approval-channel-failure",
    { path: "probe.txt", content: "must not be written" },
    undefined,
    undefined,
    {},
  );
  assert.equal(result.isError, true);
  await assert.rejects(() =>
    fs.access(path.join(paths.workspace, "probe.txt")),
  );
  const record = (await core.readEvidenceFile(paths.evidence)).records.find(
    (candidate) => candidate.tool_call_id === "call-approval-channel-failure",
  );
  assert.ok(record);
  assert.equal(record.decision, "deny");
  assert.equal(record.rule, "approval.channel_failed");
  assert.equal(record.approval, null);
  assert.match(record.output_preview, /surface failed/u);
});

async function setup() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "codepunk-reviewer-")),
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
    reviewer: null,
    ledger: null,
    sandbox: null,
    userRules: [{ id: "ask-write", tool: "write", decision: "ask" }],
    ...overrides,
  };
}

function fakeReviewer(decision, reason = `${decision} by reviewer`) {
  return {
    provider: "fake",
    model: "reviewer",
    calls: 0,
    async review() {
      this.calls += 1;
      return {
        decision,
        reason,
        evidence: {
          kind: "model",
          provider: "fake",
          model: "reviewer",
          decision,
          reason,
          action_sha256: HASH,
          latency_ms: 1,
        },
      };
    },
  };
}

function allowAnswer(request) {
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
}

function brokerWithAnswer(answerFor) {
  const broker = new core.ApprovalBroker();
  const state = { asked: 0 };
  broker.registerChannel({
    id: "tui-reviewer",
    kind: "tui",
    isTTY: true,
    async ask(request) {
      state.asked += 1;
      return answerFor(request);
    },
  });
  return { broker, state };
}

async function wrappedWrite(paths, overrides) {
  const definitions = await core.createCodepunkToolDefinitions(
    paths.workspace,
    null,
  );
  const write = definitions.find((definition) => definition.name === "write");
  assert.ok(write);
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  const wrapped = await core.wrapToolDefinition(
    write,
    wrapOptions(paths, { ledger, approvalMode: "auto", ...overrides }),
  );
  return { wrapped, ledger };
}

function fakeSandbox() {
  const descriptor = {
    backend: "srt",
    version: "test",
    profile_sha256: HASH,
  };
  return {
    descriptor,
    sandboxed: true,
    commands: [],
    argv: [],
    async execCommand(command) {
      this.commands.push(command);
      return {
        output: "sandbox ok",
        exitCode: 0,
        cancelled: false,
        timedOut: false,
        executor: "srt",
        descriptor,
      };
    },
    async execArgv(argv) {
      this.argv.push(argv);
      return {
        output: "sandbox ok",
        exitCode: 0,
        cancelled: false,
        timedOut: false,
        executor: "srt",
        descriptor,
      };
    },
  };
}

async function wrappedBash(paths, overrides = {}) {
  const sandbox = fakeSandbox();
  const definitions = await core.createCodepunkToolDefinitions(
    paths.workspace,
    sandbox,
  );
  const bash = definitions.find((definition) => definition.name === "bash");
  assert.ok(bash);
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  const wrapped = await core.wrapToolDefinition(
    bash,
    wrapOptions(paths, {
      ledger,
      sandbox,
      approvalMode: "auto",
      ...overrides,
    }),
  );
  return { wrapped, ledger, sandbox };
}

async function wrappedExec(paths, overrides = {}) {
  const sandbox = fakeSandbox();
  const definitions = await core.createCodepunkToolDefinitions(
    paths.workspace,
    sandbox,
    { mode: "headless" },
  );
  const exec = definitions.find((definition) => definition.name === "exec");
  assert.ok(exec);
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  const wrapped = await core.wrapToolDefinition(
    exec,
    wrapOptions(paths, {
      ledger,
      sandbox,
      approvalMode: "auto",
      mode: "headless",
      ...overrides,
    }),
  );
  return { wrapped, ledger, sandbox };
}

test("reviewer allow runs a network command without a human approval", async () => {
  const paths = await setup();
  const reviewer = fakeReviewer("allow");
  const { broker, state } = brokerWithAnswer(allowAnswer);
  const { wrapped, sandbox } = await wrappedBash(paths, {
    approval: broker,
    reviewer,
  });

  const result = await wrapped.execute(
    "call-reviewer-allow",
    { command: "curl https://example.com" },
    undefined,
    undefined,
    {},
  );
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(sandbox.commands, ["curl https://example.com"]);
  assert.equal(reviewer.calls, 1);
  assert.equal(state.asked, 0);

  const record = (await core.readEvidenceFile(paths.evidence)).records.find(
    (candidate) => candidate.tool_call_id === "call-reviewer-allow",
  );
  assert.ok(record);
  assert.equal(record.decision, "allow");
  assert.equal(record.rule, "reviewer.model.allow");
  assert.equal(record.approval, null);
  assert.equal(record.reviewer.decision, "allow");
  assert.equal(core.validateEvidenceForClass(record).ok, true);
});

test("reviewer deny is final and the tool never executes", async () => {
  const paths = await setup();
  const reviewer = fakeReviewer("deny", "remote write is not allowed");
  const { broker, state } = brokerWithAnswer(allowAnswer);
  const { wrapped, sandbox } = await wrappedBash(paths, {
    approval: broker,
    reviewer,
  });

  const result = await wrapped.execute(
    "call-reviewer-deny",
    { command: "curl https://example.com" },
    undefined,
    undefined,
    {},
  );
  assert.equal(result.isError, true);
  assert.deepEqual(sandbox.commands, []);
  assert.equal(reviewer.calls, 1);
  assert.equal(state.asked, 0);

  const record = (await core.readEvidenceFile(paths.evidence)).records.find(
    (candidate) => candidate.tool_call_id === "call-reviewer-deny",
  );
  assert.ok(record);
  assert.equal(record.decision, "deny");
  assert.equal(record.rule, "reviewer.model.deny");
  assert.equal(record.reviewer.decision, "deny");
});

test("reviewer abstain falls back to a human approval", async () => {
  const paths = await setup();
  const reviewer = fakeReviewer("abstain", "not enough context");
  const { broker, state } = brokerWithAnswer(allowAnswer);
  const { wrapped, sandbox } = await wrappedBash(paths, {
    approval: broker,
    reviewer,
  });

  const result = await wrapped.execute(
    "call-reviewer-abstain",
    { command: "curl https://example.com" },
    undefined,
    undefined,
    {},
  );
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(sandbox.commands, ["curl https://example.com"]);
  assert.equal(reviewer.calls, 1);
  assert.equal(state.asked, 1);

  const record = (await core.readEvidenceFile(paths.evidence)).records.find(
    (candidate) => candidate.tool_call_id === "call-reviewer-abstain",
  );
  assert.ok(record);
  assert.equal(record.decision, "allow");
  assert.equal(record.reviewer.decision, "abstain");
  assert.equal(record.approval.answer, "allow");
});

test("user bash destructive actions stay with the human approval gate", async () => {
  const paths = await setup();
  const reviewer = fakeReviewer("allow", "looks fine to the reviewer");
  const { broker, state } = brokerWithAnswer(allowAnswer);
  const ledger = await core.EvidenceLedger.open(paths.evidence);
  const result = await core.wrapUserBashCommand(
    "rm -rf build",
    "call-user-bash-destructive",
    wrapOptions(paths, {
      approval: broker,
      approvalMode: "auto",
      ledger,
      reviewer,
      sandbox: fakeSandbox(),
    }),
  );
  assert.ok("operations" in result);
  await result.operations.exec("rm -rf build", paths.workspace, {});
  assert.equal(reviewer.calls, 0);
  assert.equal(state.asked, 1);

  const record = (await core.readEvidenceFile(paths.evidence)).records.find(
    (candidate) => candidate.tool_call_id === "call-user-bash-destructive",
  );
  assert.ok(record);
  assert.equal(record.decision, "allow");
  assert.equal(record.rule, "policy.default");
  assert.equal(record.approval.answer, "allow");
  assert.equal(record.reviewer, null);
});

test("headless reviewer abstain denies when no approval channel exists", async () => {
  const paths = await setup();
  const reviewer = fakeReviewer("abstain", "not enough context");
  const { wrapped, sandbox } = await wrappedExec(paths, {
    mode: "headless",
    reviewer,
  });

  const result = await wrapped.execute(
    "call-reviewer-headless",
    { argv: ["printf", "ok"] },
    undefined,
    undefined,
    {},
  );
  assert.equal(result.isError, true);
  assert.deepEqual(sandbox.argv, []);
  const record = (await core.readEvidenceFile(paths.evidence)).records.find(
    (candidate) => candidate.tool_call_id === "call-reviewer-headless",
  );
  assert.ok(record);
  assert.equal(record.decision, "deny");
  assert.equal(record.rule, "reviewer.abstained");
});

test("headless reviewer allow executes an otherwise unresolved ask", async () => {
  const paths = await setup();
  const reviewer = fakeReviewer("allow", "bounded workspace write");
  const { wrapped, sandbox } = await wrappedExec(paths, { reviewer });

  const result = await wrapped.execute(
    "call-reviewer-headless-allow",
    { argv: ["printf", "ok"] },
    undefined,
    undefined,
    {},
  );
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(sandbox.argv, [["printf", "ok"]]);
  const record = (await core.readEvidenceFile(paths.evidence)).records.find(
    (candidate) => candidate.tool_call_id === "call-reviewer-headless-allow",
  );
  assert.ok(record);
  assert.equal(record.decision, "allow");
  assert.equal(record.rule, "reviewer.model.allow");
  assert.equal(record.reviewer.decision, "allow");
});

test("reviewer is not consulted outside auto approval mode", async () => {
  const paths = await setup();
  const target = path.join(paths.workspace, "note.txt");
  await fs.writeFile(target, "before\n");
  const reviewer = fakeReviewer("allow");
  const { broker, state } = brokerWithAnswer((request) => ({
    ...allowAnswer(request),
    answer: "deny",
  }));
  const { wrapped } = await wrappedWrite(paths, {
    approvalMode: "ask",
    approval: broker,
    reviewer,
  });

  const result = await wrapped.execute(
    "call-reviewer-ask",
    { path: "note.txt", content: "after\n" },
    undefined,
    undefined,
    {},
  );
  assert.equal(result.isError, true);
  assert.equal(await fs.readFile(target, "utf8"), "before\n");
  assert.equal(reviewer.calls, 0);
  assert.equal(state.asked, 1);
});

test("reviewer never bypasses an unmatched scoped allowlist", async () => {
  const paths = await setup();
  const target = path.join(paths.workspace, "note.txt");
  await fs.writeFile(target, "before\n");
  const reviewer = fakeReviewer("allow");
  const { broker, state } = brokerWithAnswer(allowAnswer);
  const { wrapped } = await wrappedWrite(paths, {
    approval: broker,
    reviewer,
    autonomy: {
      profile: "scoped",
      async authorize() {
        return null;
      },
      evidence() {
        return null;
      },
    },
  });

  const result = await wrapped.execute(
    "call-reviewer-scoped",
    { path: "note.txt", content: "after\n" },
    undefined,
    undefined,
    {},
  );
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(await fs.readFile(target, "utf8"), "after\n");
  assert.equal(reviewer.calls, 0);
  assert.equal(state.asked, 1);
});

test("reviewer never unlocks a sensitive path", async () => {
  const paths = await setup();
  const target = path.join(paths.workspace, ".env");
  await fs.writeFile(target, "BEFORE=1\n");
  const reviewer = fakeReviewer("allow", "looks ordinary");
  const { broker, state } = brokerWithAnswer(allowAnswer);
  const { wrapped } = await wrappedWrite(paths, { approval: broker, reviewer });

  const result = await wrapped.execute(
    "call-reviewer-sensitive",
    { path: ".env", content: "AFTER=1\n" },
    undefined,
    undefined,
    {},
  );
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(reviewer.calls, 0);
  assert.equal(state.asked, 1);
  assert.equal(await fs.readFile(target, "utf8"), "AFTER=1\n");

  const record = (await core.readEvidenceFile(paths.evidence)).records.find(
    (candidate) => candidate.tool_call_id === "call-reviewer-sensitive",
  );
  assert.ok(record);
  assert.equal(record.reviewer, null);
  assert.equal(record.approval.answer, "allow");
});

test("reviewer never unlocks a hard-denied protected path", async () => {
  const paths = await setup();
  await fs.mkdir(path.join(paths.workspace, ".codepunk"), { recursive: true });
  const reviewer = fakeReviewer("allow", "looks ordinary");
  const { broker, state } = brokerWithAnswer(allowAnswer);
  const { wrapped } = await wrappedWrite(paths, { approval: broker, reviewer });

  const result = await wrapped.execute(
    "call-reviewer-protected",
    { path: ".codepunk/config.toml", content: "x = 1\n" },
    undefined,
    undefined,
    {},
  );
  assert.equal(result.isError, true);
  assert.equal(reviewer.calls, 0);
  assert.equal(state.asked, 0);
  await assert.rejects(
    () => fs.stat(path.join(paths.workspace, ".codepunk/config.toml")),
    { code: "ENOENT" },
  );
});

test("headless reviewer cannot unlock a sensitive path", async () => {
  const paths = await setup();
  const target = path.join(paths.workspace, ".env");
  await fs.writeFile(target, "BEFORE=1\n");
  const reviewer = fakeReviewer("allow", "looks ordinary");
  const { wrapped } = await wrappedWrite(paths, {
    mode: "headless",
    reviewer,
  });

  const result = await wrapped.execute(
    "call-reviewer-headless-sensitive",
    { path: ".env", content: "AFTER=1\n" },
    undefined,
    undefined,
    {},
  );
  assert.equal(result.isError, true);
  assert.equal(reviewer.calls, 0);
  assert.equal(await fs.readFile(target, "utf8"), "BEFORE=1\n");
  const record = (await core.readEvidenceFile(paths.evidence)).records.find(
    (candidate) =>
      candidate.tool_call_id === "call-reviewer-headless-sensitive",
  );
  assert.ok(record);
  assert.equal(record.decision, "deny");
  assert.equal(record.rule, "approval.unavailable");
  assert.equal(record.reviewer, null);
});

test("reviewer config is user-only and writes preserve unrelated config", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "codepunk-reviewer-config-")),
  );
  try {
    const projectRoot = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(path.join(projectRoot, ".codepunk"), { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, ".codepunk", "config.toml"),
      '[approval]\nreviewer = "model"\n',
    );
    const paths = core.projectPaths(
      {
        cwd: projectRoot,
        deliveryRoot: projectRoot,
        projectId: core.projectIdFor(projectRoot),
      },
      home,
    );
    await assert.rejects(
      () => core.loadConfig(paths, {}, {}, { projectTrusted: true }),
      /user\/CLI-only and cannot appear in project config/u,
    );

    await fs.writeFile(
      path.join(home, "config.toml"),
      [
        "# keep me",
        "[model]",
        'provider = "gateway"',
        'id = "primary"',
        "",
        "[approval]",
        'mode = "auto"',
        "",
      ].join("\n"),
    );
    await core.writeUserPermissionSelection(paths, {
      reviewer: "model",
      reviewerModel: "gateway/reviewer",
      reviewerTimeoutMs: 15_000,
    });
    const content = await fs.readFile(path.join(home, "config.toml"), "utf8");
    assert.match(content, /# keep me/u);
    assert.match(content, /mode = "auto"/u);
    assert.match(content, /reviewer = "model"/u);
    assert.match(content, /reviewer_model = "gateway\/reviewer"/u);
    assert.match(content, /reviewer_timeout_ms = 15000/u);
    await assertPrivateFile(path.join(home, "config.toml"));
    const loaded = await core.loadConfig(
      paths,
      {},
      {},
      { projectTrusted: false },
    );
    assert.equal(loaded.config.approval.reviewer, "model");
    assert.equal(loaded.config.approval.reviewer_model, "gateway/reviewer");
    assert.equal(loaded.config.approval.reviewer_timeout_ms, 15_000);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
