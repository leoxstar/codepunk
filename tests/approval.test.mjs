import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import { withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();

function answerFor(request, overrides = {}) {
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
    ...overrides,
  };
}

test("no interactive channel denies", async () => {
  const broker = new core.ApprovalBroker();
  const result = await broker.request({
    sessionId: "session-1",
    workerId: "worker-1",
    toolCallId: "call-1",
  });
  assert.equal(result.approved, false);
  assert.equal(result.answer, null);
  assert.match(result.reason, /no interactive approval channel/u);
});

test("a non-TTY channel denies", async () => {
  const broker = new core.ApprovalBroker();
  broker.registerChannel({
    id: "print",
    kind: "cli",
    isTTY: false,
    async ask() {
      throw new Error("must not be called");
    },
  });
  const result = await broker.request({
    sessionId: "session-1",
    workerId: "worker-1",
    toolCallId: "call-1",
  });
  assert.equal(result.approved, false);
  assert.equal(result.evidence, null);
});

test("a matching allow answer is accepted with binding fields", async () => {
  const broker = new core.ApprovalBroker({ ttlMs: 60_000 });
  let seen;
  broker.registerChannel({
    id: "tui-main",
    kind: "tui",
    isTTY: true,
    async ask(request) {
      seen = request;
      return answerFor(request);
    },
  });
  const result = await broker.request({
    sessionId: "session-1",
    workerId: "worker-1",
    toolCallId: "call-1",
  });
  assert.equal(result.approved, true);
  assert.ok(result.evidence);
  assert.equal(result.evidence.request_id, seen.request_id);
  assert.equal(result.evidence.worker_id, "worker-1");
  assert.equal(result.evidence.session_id, "session-1");
  assert.equal(result.evidence.tool_call_id, "call-1");
  assert.equal(result.evidence.ttl_ms, 60_000);
  assert.match(seen.nonce_sha256, /^sha256:[0-9a-f]{64}$/u);
});

test("mismatched worker, session, tool call, nonce, or channel denies", async () => {
  const cases = [
    { worker_id: "worker-2" },
    { session_id: "session-2" },
    { tool_call_id: "call-2" },
    { nonce_sha256: `sha256:${"c".repeat(64)}` },
    { channel_id: "tui-other" },
    { request_id: "other-request" },
  ];
  for (const overrides of cases) {
    const broker = new core.ApprovalBroker();
    broker.registerChannel({
      id: "tui-main",
      kind: "tui",
      isTTY: true,
      async ask(request) {
        return answerFor(request, overrides);
      },
    });
    const result = await broker.request({
      sessionId: "session-1",
      workerId: "worker-1",
      toolCallId: "call-1",
    });
    assert.equal(result.approved, false, JSON.stringify(overrides));
    assert.match(result.reason, /did not match/u);
  }
});

test("a matching deny answer is a user denial, not an answer mismatch", async () => {
  const broker = new core.ApprovalBroker();
  broker.registerChannel({
    id: "tui-main",
    kind: "tui",
    isTTY: true,
    async ask(request) {
      return answerFor(request, { answer: "deny" });
    },
  });
  const result = await broker.request({
    sessionId: "session-1",
    workerId: "worker-1",
    toolCallId: "call-1",
  });
  assert.equal(result.approved, false);
  assert.equal(result.failure, null);
  assert.equal(result.answer?.answer, "deny");
  assert.match(result.reason, /approval denied/u);
});

test("an expired answer is rejected", async () => {
  let now = new Date("2026-11-12T00:00:00.000Z");
  const broker = new core.ApprovalBroker({
    ttlMs: 100,
    now: () => now,
  });
  broker.registerChannel({
    id: "tui-main",
    kind: "tui",
    isTTY: true,
    async ask(request) {
      const answer = answerFor(request);
      now = new Date(now.getTime() + 101);
      return answer;
    },
  });
  const result = await broker.request({
    sessionId: "session-1",
    workerId: "worker-1",
    toolCallId: "call-1",
  });
  assert.equal(result.approved, false);
  assert.match(result.reason, /expired/u);
});

test("a replayed answer is rejected by the next request", async () => {
  const broker = new core.ApprovalBroker();
  let first;
  broker.registerChannel({
    id: "tui-main",
    kind: "tui",
    isTTY: true,
    async ask(request) {
      first ??= answerFor(request);
      return first;
    },
  });
  const accepted = await broker.request({
    sessionId: "session-1",
    workerId: "worker-1",
    toolCallId: "call-1",
  });
  assert.equal(accepted.approved, true);
  const replayed = await broker.request({
    sessionId: "session-1",
    workerId: "worker-1",
    toolCallId: "call-2",
  });
  assert.equal(replayed.approved, false);
  assert.match(replayed.reason, /did not match/u);
});

test("a channel exception denies and a second channel is refused", async () => {
  const broker = new core.ApprovalBroker();
  broker.registerChannel({
    id: "tui-main",
    kind: "tui",
    isTTY: true,
    async ask() {
      throw new Error("surface failed");
    },
  });
  assert.throws(
    () =>
      broker.registerChannel({
        id: "second",
        kind: "tui",
        isTTY: true,
        async ask() {
          return null;
        },
      }),
    /already registered/u,
  );
  const result = await broker.request({
    sessionId: "session-1",
    workerId: "worker-1",
    toolCallId: "call-1",
  });
  assert.equal(result.approved, false);
  assert.equal(result.answer, null);
  assert.equal(result.failure, "channel_error");
  assert.match(result.reason, /approval channel failed/u);
  assert.match(result.reason, /surface failed/u);
});

test("a channel can be replaced and the request carries action details", async () => {
  const broker = new core.ApprovalBroker();
  let firstCalled = false;
  broker.registerChannel({
    id: "first",
    kind: "tui",
    isTTY: true,
    async ask() {
      firstCalled = true;
      return null;
    },
  });
  let seen;
  broker.replaceChannel({
    id: "second",
    kind: "tui",
    isTTY: true,
    async ask(request) {
      seen = request;
      return answerFor(request);
    },
  });
  const result = await broker.request({
    sessionId: "session-1",
    workerId: "worker-1",
    toolCallId: "call-1",
    tool: "bash",
    command: "touch approved.txt",
    path: "/workspace/approved.txt",
    reason: "shell command is not in a known safe class",
  });
  assert.equal(result.approved, true);
  assert.equal(firstCalled, false);
  assert.equal(seen.tool, "bash");
  assert.equal(seen.command, "touch approved.txt");
  assert.equal(seen.path, "/workspace/approved.txt");
  assert.match(seen.reason, /known safe class/u);

  broker.replaceChannel(null);
  const denied = await broker.request({
    sessionId: "session-1",
    workerId: "worker-1",
    toolCallId: "call-2",
  });
  assert.equal(denied.approved, false);
  assert.match(denied.reason, /no interactive approval channel/u);
});

test("session scope reuses only the exact tool, argv, and cwd", async () => {
  const broker = new core.ApprovalBroker({ workspaceTrusted: true });
  let calls = 0;
  broker.registerChannel({
    id: "tui-main",
    kind: "tui",
    isTTY: true,
    async ask(request) {
      calls += 1;
      return answerFor(request, { scope: "session" });
    },
  });
  const input = {
    sessionId: "session-1",
    workerId: "worker-1",
    tool: "bash",
    argv: ["mkdir", "made"],
    cwd: "/workspace",
  };
  const first = await broker.request({
    ...input,
    toolCallId: "call-1",
  });
  assert.equal(first.approved, true);
  assert.equal(calls, 1);
  assert.equal(first.evidence.scope, "session");

  const reused = await broker.request({
    ...input,
    toolCallId: "call-2",
    workerId: "worker-2",
  });
  assert.equal(reused.approved, true);
  assert.equal(calls, 1);
  assert.match(reused.reason, /reused for this session/u);
  assert.equal(reused.evidence.scope, "session");
  assert.equal(first.evidence.reused_from_request_id, undefined);
  assert.equal(
    reused.evidence.reused_from_request_id,
    first.evidence.request_id,
  );

  await broker.request({
    ...input,
    toolCallId: "call-3",
    argv: ["mkdir", "other"],
  });
  assert.equal(calls, 2);
  await broker.request({
    ...input,
    toolCallId: "call-4",
    cwd: "/other",
  });
  assert.equal(calls, 3);

  broker.clearSessionGrants();
  await broker.request({
    ...input,
    toolCallId: "call-5",
  });
  assert.equal(calls, 4);
});

test("reused approvals require an exact action and reject unknown scopes", async () => {
  const broker = new core.ApprovalBroker({ workspaceTrusted: true });
  broker.registerChannel({
    id: "tui-main",
    kind: "tui",
    isTTY: true,
    async ask(request) {
      return answerFor(request, { scope: "session" });
    },
  });
  const withoutAction = await broker.request({
    sessionId: "session-1",
    workerId: "worker-1",
    toolCallId: "call-1",
  });
  assert.equal(withoutAction.approved, false);
  assert.match(withoutAction.reason, /did not match/u);

  broker.replaceChannel({
    id: "tui-main",
    kind: "tui",
    isTTY: true,
    async ask(request) {
      return answerFor(request, { scope: "wildcard" });
    },
  });
  const unknownScope = await broker.request({
    sessionId: "session-1",
    workerId: "worker-1",
    toolCallId: "call-2",
    tool: "bash",
    argv: ["mkdir", "made"],
    cwd: "/workspace",
  });
  assert.equal(unknownScope.approved, false);
  assert.match(unknownScope.reason, /did not match/u);
});

test("session approvals reuse per file path and per tool in untrusted workspaces", async () => {
  const broker = new core.ApprovalBroker({ workspaceTrusted: false });
  let calls = 0;
  broker.registerChannel({
    id: "tui-main",
    kind: "tui",
    isTTY: true,
    async ask(request) {
      calls += 1;
      return answerFor(request, { scope: "session" });
    },
  });
  const input = {
    sessionId: "session-1",
    workerId: "worker-1",
    cwd: "/workspace",
    tool: "write",
  };
  const first = await broker.request({
    ...input,
    toolCallId: "write-1",
    path: "/workspace/notes.md",
    argsSha256: `sha256:${"1".repeat(64)}`,
  });
  assert.equal(first.approved, true);
  assert.equal(calls, 1);

  const samePath = await broker.request({
    ...input,
    toolCallId: "write-2",
    path: "/workspace/notes.md",
    argsSha256: `sha256:${"2".repeat(64)}`,
  });
  assert.equal(samePath.approved, true);
  assert.equal(
    samePath.evidence.reused_from_request_id,
    first.evidence.request_id,
  );
  assert.equal(calls, 1);

  const otherPath = await broker.request({
    ...input,
    toolCallId: "write-3",
    path: "/workspace/other.md",
  });
  assert.equal(otherPath.approved, true);
  assert.equal(calls, 2);

  const fetch = {
    ...input,
    tool: "web_fetch",
  };
  await broker.request({
    ...fetch,
    toolCallId: "fetch-1",
    argsSha256: `sha256:${"3".repeat(64)}`,
  });
  const fetchReused = await broker.request({
    ...fetch,
    toolCallId: "fetch-2",
    argsSha256: `sha256:${"4".repeat(64)}`,
  });
  assert.equal(fetchReused.approved, true);
  assert.equal(calls, 3);

  await broker.request({
    ...input,
    tool: "edit",
    toolCallId: "edit-1",
    path: "/workspace/notes.md",
  });
  assert.equal(calls, 4);
});

test("untrusted workspace allows session reuse but rejects persistent rules", async () => {
  await withTempDirectory("codepunk-approval-untrusted-", async (root) => {
    const scopedRules = path.join(root, "scoped-rules.toml");
    let answerScope = "once";
    const broker = new core.ApprovalBroker({ workspaceTrusted: false });
    broker.registerChannel({
      id: "tui-main",
      kind: "tui",
      isTTY: true,
      async ask(request) {
        return answerFor(request, { scope: answerScope });
      },
    });
    const input = {
      sessionId: "session-untrusted",
      workerId: "worker-1",
      tool: "bash",
      argv: ["/bin/mkdir", "made"],
      cwd: root,
    };

    const once = await broker.request({ ...input, toolCallId: "call-once" });
    assert.equal(once.approved, true);
    assert.equal(once.evidence.scope, "once");

    answerScope = "session";
    const session = await broker.request({
      ...input,
      toolCallId: "call-session",
    });
    assert.equal(session.approved, true);
    assert.equal(session.evidence.scope, "session");
    const reused = await broker.request({
      ...input,
      workerId: "worker-2",
      toolCallId: "call-session-reused",
    });
    assert.equal(reused.approved, true);
    assert.equal(
      reused.evidence.reused_from_request_id,
      session.evidence.request_id,
    );

    answerScope = "persistent";
    const rejected = await broker.request({
      ...input,
      argv: ["/bin/mkdir", "other"],
      toolCallId: "call-persistent",
    });
    assert.equal(rejected.approved, false);
    assert.equal(rejected.failure, "scope_untrusted");
    assert.match(rejected.reason, /approval\.scope_untrusted/u);
    assert.equal(rejected.evidence.scope, "persistent");
    await assert.rejects(fs.stat(scopedRules), { code: "ENOENT" });

    broker.replaceChannel({
      id: "tui-main",
      kind: "tui",
      isTTY: true,
      async ask(request) {
        return answerFor(request, {
          scope: "once",
          unsandboxed_once: true,
        });
      },
    });
    const unsandboxedRejected = await broker.request({
      ...input,
      argv: ["/bin/mkdir", "host-escape"],
      toolCallId: "call-unsandboxed-untrusted",
    });
    assert.equal(unsandboxedRejected.approved, false);
    assert.equal(unsandboxedRejected.unsandboxedOnce, undefined);
    assert.equal(unsandboxedRejected.failure, "scope_untrusted");
    assert.match(unsandboxedRejected.reason, /approval\.scope_untrusted/u);
    assert.match(unsandboxedRejected.reason, /unsandboxed shell escape/u);

    const trustedBroker = new core.ApprovalBroker({ workspaceTrusted: true });
    trustedBroker.registerChannel({
      id: "tui-main",
      kind: "tui",
      isTTY: true,
      async ask(request) {
        return answerFor(request, {
          scope: "once",
          unsandboxed_once: true,
        });
      },
    });
    const unsandboxedTrusted = await trustedBroker.request({
      ...input,
      argv: ["/bin/mkdir", "host-escape"],
      toolCallId: "call-unsandboxed-trusted",
    });
    assert.equal(unsandboxedTrusted.approved, true);
    assert.equal(unsandboxedTrusted.unsandboxedOnce, true);
    assert.equal(unsandboxedTrusted.failure, null);
  });
});

test("a control surface can answer only the matching pending request", async () => {
  const broker = new core.ApprovalBroker();
  let pendingRequest;
  broker.registerChannel({
    id: "tui-main",
    kind: "tui",
    isTTY: true,
    async ask(request) {
      pendingRequest = request;
      return new Promise(() => {});
    },
  });
  const original = broker.request({
    sessionId: "session-1",
    workerId: "worker-1",
    toolCallId: "call-1",
  });
  for (
    let attempt = 0;
    attempt < 100 && pendingRequest === undefined;
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(pendingRequest);
  const wrong = broker.answer(
    pendingRequest.request_id,
    `sha256:${"0".repeat(64)}`,
    true,
  );
  assert.equal(wrong.approved, false);
  assert.equal(wrong.failure, "mismatch");
  const accepted = broker.answer(
    pendingRequest.request_id,
    pendingRequest.nonce_sha256,
    true,
  );
  assert.equal(accepted.approved, true);
  assert.equal(accepted.evidence.answer, "allow");
  const delivered = await original;
  assert.equal(delivered.approved, true);
  assert.equal(delivered.answer.answer, "allow");
  assert.equal(delivered.answer.channel, "cli");
});

test("a control denial settles the original request without a mismatch", async () => {
  const broker = new core.ApprovalBroker();
  let pendingRequest;
  broker.registerChannel({
    id: "tui-main",
    kind: "tui",
    isTTY: true,
    async ask(request) {
      pendingRequest = request;
      return new Promise(() => {});
    },
  });
  const original = broker.request({
    sessionId: "session-1",
    workerId: "worker-1",
    toolCallId: "call-1",
  });
  for (
    let attempt = 0;
    attempt < 100 && pendingRequest === undefined;
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const denied = broker.answer(
    pendingRequest.request_id,
    pendingRequest.nonce_sha256,
    false,
  );
  assert.equal(denied.approved, false);
  assert.equal(denied.failure, null);
  assert.equal(denied.reason, "approval denied");
  const delivered = await original;
  assert.equal(delivered.approved, false);
  assert.equal(delivered.failure, null);
  assert.equal(delivered.answer.answer, "deny");
});

test("session scope reuses exact pipeline command in cwd without blanket-approving bash or persisting", async () => {
  const broker = new core.ApprovalBroker({ workspaceTrusted: true });
  let calls = 0;
  let answerScope = "session";
  broker.registerChannel({
    id: "tui-main",
    kind: "tui",
    isTTY: true,
    async ask(request) {
      calls += 1;
      return answerFor(request, { scope: answerScope });
    },
  });

  const pipeline = "pnpm test 2>&1 | tail -n 20";
  const first = await broker.request({
    sessionId: "session-pipe",
    workerId: "worker-1",
    toolCallId: "pipe-1",
    tool: "bash",
    command: pipeline,
    cwd: "/workspace",
  });
  assert.equal(first.approved, true);
  assert.equal(calls, 1);

  const reused = await broker.request({
    sessionId: "session-pipe",
    workerId: "worker-1",
    toolCallId: "pipe-2",
    tool: "bash",
    command: pipeline,
    cwd: "/workspace",
  });
  assert.equal(reused.approved, true);
  assert.equal(calls, 1);
  assert.equal(
    reused.evidence.reused_from_request_id,
    first.evidence.request_id,
  );

  const differentCommand = await broker.request({
    sessionId: "session-pipe",
    workerId: "worker-1",
    toolCallId: "pipe-3",
    tool: "bash",
    command: "pnpm test 2>&1 | rm -rf dist",
    cwd: "/workspace",
  });
  assert.equal(differentCommand.approved, true);
  assert.equal(calls, 2);

  const differentCwd = await broker.request({
    sessionId: "session-pipe",
    workerId: "worker-1",
    toolCallId: "pipe-4",
    tool: "bash",
    command: pipeline,
    cwd: "/other",
  });
  assert.equal(differentCwd.approved, true);
  assert.equal(calls, 3);

  const missingCommand = await broker.request({
    sessionId: "session-pipe",
    workerId: "worker-1",
    toolCallId: "pipe-5",
    tool: "bash",
    cwd: "/workspace",
  });
  assert.equal(missingCommand.approved, false);
  assert.equal(missingCommand.failure, "mismatch");

  answerScope = "persistent";
  const persistentPipeline = await broker.request({
    sessionId: "session-pipe",
    workerId: "worker-1",
    toolCallId: "pipe-6",
    tool: "bash",
    command: "npm test && echo ok",
    cwd: "/workspace",
  });
  assert.equal(persistentPipeline.approved, false);
  assert.equal(persistentPipeline.failure, "mismatch");
});
