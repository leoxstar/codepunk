import assert from "node:assert/strict";
import test from "node:test";
import { importCore } from "./support/core.mjs";

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
  const broker = new core.ApprovalBroker();
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
  const broker = new core.ApprovalBroker();
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
