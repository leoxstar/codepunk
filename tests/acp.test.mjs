import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { importCore, importProtocol } from "./support/core.mjs";

const core = await importCore();
const protocol = await importProtocol();
const CLI_SOURCE = path.resolve("packages/cli/src/index.ts");

function lease(sessionId, runId, token = "lease-token") {
  return {
    session_id: sessionId,
    run_id: runId,
    token,
    channel_id: "codepunk-acp",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

function controlEvent(sessionId, runId, seq, kind, reason) {
  return {
    type: "codepunk/daemon-control-event",
    version: 1,
    session_id: sessionId,
    run_id: runId,
    seq,
    kind,
    ...(reason === undefined ? {} : { reason }),
  };
}

class FakeControlBackend {
  constructor() {
    this.nextSession = 1;
    this.sessions = new Map();
    this.nextEvent = 1;
  }

  async newSession(scopes) {
    const sessionId = `acp-session-${this.nextSession++}`;
    const writerLease = lease(sessionId, `run-${this.nextSession}`);
    this.sessions.set(sessionId, { scopes, writerLease });
    return { sessionId, writerLease };
  }

  assertLease(request) {
    const session = this.sessions.get(request.sessionId);
    assert.ok(session);
    assert.equal(request.writerLease.token, session.writerLease.token);
    return session;
  }

  async run(request) {
    this.assertLease(request);
    return {
      session_id: request.sessionId,
      run_id: request.writerLease.run_id,
      events: [
        controlEvent(
          request.sessionId,
          request.writerLease.run_id,
          this.nextEvent++,
          "control/accepted",
          request.reason,
        ),
        controlEvent(
          request.sessionId,
          request.writerLease.run_id,
          this.nextEvent++,
          "control/completed",
        ),
      ],
      writer_lease: request.writerLease,
    };
  }

  async stop(request) {
    this.assertLease(request);
    return {
      session_id: request.sessionId,
      run_id: request.writerLease.run_id,
      events: [
        controlEvent(
          request.sessionId,
          request.writerLease.run_id,
          this.nextEvent++,
          "control/stopped",
          request.reason,
        ),
      ],
      writer_lease: request.writerLease,
    };
  }

  async steer(request) {
    this.assertLease(request);
    return {
      session_id: request.sessionId,
      run_id: request.writerLease.run_id,
      events: [],
      writer_lease: request.writerLease,
    };
  }

  async plan(request) {
    return this.steer(request);
  }

  async goal(request) {
    return this.steer(request);
  }

  async approve(request) {
    this.assertLease(request);
    throw new core.ControlApprovalError("approval nonce mismatch");
  }
}

class ConflictBackend extends FakeControlBackend {
  async run() {
    throw new core.ControlWriteConflictError();
  }
}

class FailingBackend extends FakeControlBackend {
  async run(request) {
    this.assertLease(request);
    throw new core.ControlRunError("model failed", [
      controlEvent(
        request.sessionId,
        request.writerLease.run_id,
        this.nextEvent++,
        "control/accepted",
        request.reason,
      ),
      controlEvent(
        request.sessionId,
        request.writerLease.run_id,
        this.nextEvent++,
        "control/error",
        "model failed",
      ),
    ]);
  }
}

class BlockingBackend extends FakeControlBackend {
  constructor() {
    super();
    this.runStarted = Promise.withResolvers();
    this.pendingRun = null;
  }

  async run(request) {
    const session = this.assertLease(request);
    const pending = Promise.withResolvers();
    this.pendingRun = pending;
    this.runStarted.resolve(request);
    try {
      return await pending.promise;
    } finally {
      this.pendingRun = null;
      session.pending = null;
    }
  }

  async stop(request) {
    const session = this.assertLease(request);
    if (this.pendingRun === null) {
      throw new Error("cancel arrived before the run started");
    }
    this.pendingRun.reject(new Error("run aborted"));
    session.pending = null;
    return {
      session_id: request.sessionId,
      run_id: request.writerLease.run_id,
      events: [
        controlEvent(
          request.sessionId,
          request.writerLease.run_id,
          this.nextEvent++,
          "control/stopped",
          request.reason,
        ),
      ],
      writer_lease: request.writerLease,
    };
  }
}

async function runAcp(lines, backend = new FakeControlBackend(), options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  const reader = createInterface({ input: output });
  reader.on("line", (line) => messages.push(JSON.parse(line)));
  const server = new core.AcpServer({
    backend,
    input,
    output,
    ...options,
  });
  const completion = server.run();
  for (const line of lines) {
    input.write(`${JSON.stringify(line)}\n`);
  }
  input.end();
  await completion;
  await delay(0);
  reader.close();
  return messages;
}

function rpc(method, params, id) {
  return { jsonrpc: "2.0", id, method, params };
}

test("ACP server handles initialize, new, prompt, and cancel", async () => {
  const messages = await runAcp([
    rpc(
      "initialize",
      {
        protocolVersion: 1,
        scopes: ["daemon:read", "sessions:read", "runs:write"],
      },
      1,
    ),
    rpc("session/new", { scopes: ["runs:write"] }, 2),
    rpc(
      "session/prompt",
      {
        sessionId: "acp-session-1",
        prompt: "run this",
        reason: "acp test",
      },
      3,
    ),
    rpc(
      "session/cancel",
      { sessionId: "acp-session-1", reason: "stop the test run" },
      4,
    ),
  ]);
  const responses = messages.filter((message) => message.id !== undefined);
  const notifications = messages.filter(
    (message) => message.method === "session/event",
  );
  assert.deepEqual(
    new Set(responses.map((message) => message.id)),
    new Set([1, 2, 3, 4]),
  );
  assert.equal(responses[1].result.sessionId, "acp-session-1");
  assert.equal(responses.find((message) => message.id === 3).error.code, 49007);
  assert.equal(
    responses.find((message) => message.id === 4).result.runId,
    "run-2",
  );
  assert.deepEqual(
    notifications.map((message) => message.params.event.kind),
    ["control/accepted", "control/completed", "control/stopped"],
  );
});

test("ACP cancel interrupts a blocked prompt and reports cancellation", async () => {
  const backend = new BlockingBackend();
  const messages = await runAcp(
    [
      rpc(
        "initialize",
        {
          protocolVersion: 1,
          scopes: ["daemon:read", "sessions:read", "runs:write"],
        },
        1,
      ),
      rpc("session/new", { scopes: ["runs:write"] }, 2),
      rpc(
        "session/prompt",
        {
          sessionId: "acp-session-1",
          prompt: "stay running",
          reason: "cancel test",
        },
        3,
      ),
      rpc(
        "session/cancel",
        { sessionId: "acp-session-1", reason: "stop now" },
        4,
      ),
    ],
    backend,
  );
  const prompt = messages.find((message) => message.id === 3);
  const cancel = messages.find((message) => message.id === 4);
  assert.equal(prompt.error.code, 49007);
  assert.equal(cancel.result.runId, "run-2");
  assert.ok(
    messages.indexOf(cancel) < messages.indexOf(prompt),
    JSON.stringify(messages),
  );
  assert.equal(backend.pendingRun, null);
});

test("ACP rejects a second prompt without losing the first run", async () => {
  const backend = new BlockingBackend();
  const messages = await runAcp(
    [
      rpc(
        "initialize",
        {
          protocolVersion: 1,
          scopes: ["daemon:read", "sessions:read", "runs:write"],
        },
        1,
      ),
      rpc("session/new", { scopes: ["runs:write"] }, 2),
      rpc(
        "session/prompt",
        {
          sessionId: "acp-session-1",
          prompt: "first",
          reason: "concurrent prompt test",
        },
        3,
      ),
      rpc(
        "session/prompt",
        {
          sessionId: "acp-session-1",
          prompt: "second",
          reason: "concurrent prompt test",
        },
        4,
      ),
      rpc(
        "session/cancel",
        { sessionId: "acp-session-1", reason: "cancel first" },
        5,
      ),
    ],
    backend,
  );
  assert.equal(messages.find((message) => message.id === 4).error.code, 49002);
  assert.equal(
    messages.find((message) => message.id === 5).result !== undefined,
    true,
  );
  assert.equal(messages.find((message) => message.id === 3).error.code, 49007);
  assert.equal(backend.pendingRun, null);
});

test("ACP does not report a failed run as success", async () => {
  const messages = await runAcp(
    [
      rpc(
        "initialize",
        {
          protocolVersion: 1,
          scopes: ["daemon:read", "sessions:read", "runs:write"],
        },
        1,
      ),
      rpc("session/new", { scopes: ["runs:write"] }, 2),
      rpc(
        "session/prompt",
        {
          sessionId: "acp-session-1",
          prompt: "fail",
          reason: "failure test",
        },
        3,
      ),
    ],
    new FailingBackend(),
  );
  assert.equal(messages.find((message) => message.id === 3).error.code, 49006);
  assert.deepEqual(
    messages
      .filter((message) => message.method === "session/event")
      .map((message) => message.params.event.kind),
    ["control/accepted", "control/error"],
  );
});

test("ACP server rejects missing and over-broad scopes", async () => {
  const readOnly = await runAcp([
    rpc(
      "initialize",
      { protocolVersion: 1, scopes: ["daemon:read", "sessions:read"] },
      1,
    ),
    rpc("session/new", { scopes: [] }, 2),
  ]);
  assert.equal(readOnly.find((message) => message.id === 2).error.code, 49001);

  const overBroad = await runAcp([
    rpc(
      "initialize",
      { protocolVersion: 1, scopes: ["daemon:read", "runs:write"] },
      1,
    ),
    rpc("session/new", { scopes: ["goal:write"] }, 2),
  ]);
  assert.equal(overBroad.find((message) => message.id === 2).error.code, 49001);

  const emptySession = await runAcp([
    rpc(
      "initialize",
      {
        protocolVersion: 1,
        scopes: ["daemon:read", "sessions:read", "runs:write"],
      },
      1,
    ),
    rpc("session/new", { scopes: [] }, 2),
    rpc(
      "session/prompt",
      {
        sessionId: "acp-session-1",
        prompt: "must not run",
        reason: "session scope test",
      },
      3,
    ),
  ]);
  assert.equal(
    emptySession.find((message) => message.id === 2).result.sessionId,
    "acp-session-1",
  );
  assert.equal(
    emptySession.find((message) => message.id === 3).error.code,
    49001,
  );
});

test("ACP enforces request limits and unknown methods", async () => {
  const messages = await runAcp(
    [
      rpc("not/a/method", {}, 1),
      rpc(
        "initialize",
        {
          protocolVersion: 1,
          scopes: ["daemon:read", "sessions:read", "runs:write"],
        },
        2,
      ),
    ],
    new FakeControlBackend(),
    { maxRequestBytes: 80 },
  );
  assert.equal(messages.find((message) => message.id === 1).error.code, -32601);
  assert.equal(
    messages.find((message) => message.error?.code === -32603).error.code,
    -32603,
  );
});

test("ACP maps writer conflicts before returning a result", async () => {
  const messages = await runAcp(
    [
      rpc(
        "initialize",
        {
          protocolVersion: 1,
          scopes: ["daemon:read", "sessions:read", "runs:write"],
        },
        1,
      ),
      rpc("session/new", { scopes: ["runs:write"] }, 2),
      rpc(
        "session/prompt",
        {
          sessionId: "acp-session-1",
          prompt: "run this",
          reason: "acp test",
        },
        3,
      ),
    ],
    new ConflictBackend(),
  );
  assert.equal(messages.find((message) => message.id === 3).error.code, 49002);
});

test("runtime control backend rejects a mismatched writer token", async () => {
  const runtime = {
    session: { sessionId: "session-token" },
    runId: "run-token",
  };
  const backend = new core.RuntimeControlBackend({
    cwd: process.cwd(),
    createRuntime: async () => runtime,
  });
  const opened = await backend.newSession([]);
  await assert.rejects(
    backend.run({
      sessionId: opened.sessionId,
      prompt: "must not run",
      reason: "token test",
      writerLease: { ...opened.writerLease, token: "wrong-token" },
    }),
    core.ControlWriteConflictError,
  );
});

test("runtime control backend expires idle leases and refuses a second run", async () => {
  let now = Date.parse("2026-11-20T08:00:00.000Z");
  const runGate = Promise.withResolvers();
  let promptCalls = 0;
  const events = [];
  const runtime = {
    session: { sessionId: "session-1", allEvents: events },
    runId: "run-1",
    host: {
      session: {
        async prompt() {
          promptCalls += 1;
          await runGate.promise;
        },
        async steer() {},
        async abort() {
          runGate.reject(new Error("aborted"));
        },
      },
    },
    planMode: { async enter() {} },
    approval: { answer() {} },
  };
  const backend = new core.RuntimeControlBackend({
    cwd: process.cwd(),
    now: () => new Date(now),
    createRuntime: async () => runtime,
  });
  const opened = await backend.newSession([]);
  const active = backend.run({
    sessionId: opened.sessionId,
    prompt: "first",
    reason: "lease test",
    writerLease: opened.writerLease,
  });
  while (promptCalls === 0) {
    await delay(0);
  }
  await assert.rejects(
    backend.run({
      sessionId: opened.sessionId,
      prompt: "second",
      reason: "concurrent run test",
      writerLease: opened.writerLease,
    }),
    core.ControlWriteConflictError,
  );
  await backend.stop({
    sessionId: opened.sessionId,
    message: "",
    reason: "stop",
    writerLease: opened.writerLease,
  });
  await assert.rejects(active, core.ControlRunError);

  now += protocol.DAEMON_WRITE_LEASE_TTL_MS + 1;
  await assert.rejects(
    backend.run({
      sessionId: opened.sessionId,
      prompt: "expired",
      reason: "expired lease test",
      writerLease: opened.writerLease,
    }),
    core.ControlWriteConflictError,
  );
});

test("runtime control backend rejects a resolved prompt with failed run/end", async () => {
  const events = [];
  const runtime = {
    session: {
      sessionId: "session-failed",
      allEvents: events,
    },
    runId: "run-failed",
    host: {
      session: {
        async prompt() {
          events.push({
            kind: "run/end",
            data: {
              run_id: "run-failed",
              state: "failed",
              termination: "provider rejected the request",
              evidence_head: null,
              actor: "local-user",
            },
          });
        },
        async steer() {},
        async abort() {},
      },
    },
    planMode: { async enter() {} },
    approval: { answer() {} },
  };
  const backend = new core.RuntimeControlBackend({
    cwd: process.cwd(),
    createRuntime: async () => runtime,
  });
  const opened = await backend.newSession([]);
  await assert.rejects(
    backend.run({
      sessionId: opened.sessionId,
      prompt: "fail",
      reason: "terminal state test",
      writerLease: opened.writerLease,
    }),
    (error) =>
      error instanceof core.ControlRunError &&
      /provider rejected/u.test(error.message) &&
      error.events.at(-1).kind === "control/error",
  );
});

test("runtime control backend accepts a validated denial as an answer", async () => {
  const runtime = {
    session: { sessionId: "session-approval", allEvents: [] },
    runId: "run-approval",
    approval: {
      answer() {
        return {
          approved: false,
          answer: null,
          evidence: null,
          reason: "approval denied",
          failure: null,
        };
      },
    },
  };
  const backend = new core.RuntimeControlBackend({
    cwd: process.cwd(),
    createRuntime: async () => runtime,
  });
  const opened = await backend.newSession([]);
  const result = await backend.approve({
    sessionId: opened.sessionId,
    approvalId: "approval-1",
    nonceSha256: `sha256:${"a".repeat(64)}`,
    approved: false,
    reason: "denial test",
    writerLease: opened.writerLease,
  });
  assert.equal(result.events.at(-1).kind, "control/accepted");
});

function spawnCli() {
  return spawn(process.execPath, [CLI_SOURCE, "acp"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "inherit"],
  });
}

async function exchangeCli(messages) {
  const child = spawnCli();
  const reader = createInterface({ input: child.stdout });
  const received = [];
  reader.on("line", (line) => received.push(JSON.parse(line)));
  try {
    for (const message of messages) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    const deadline = Date.now() + 5_000;
    while (
      Date.now() < deadline &&
      !messages.every((message) =>
        received.some((candidate) => candidate.id === message.id),
      )
    ) {
      await delay(20);
    }
    return received;
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
    reader.close();
  }
}

test(
  "codepunk acp is a real stdio endpoint and rejects missing write scope",
  { skip: process.platform === "win32" },
  async () => {
    const messages = await exchangeCli([
      rpc(
        "initialize",
        { protocolVersion: 1, scopes: ["daemon:read", "sessions:read"] },
        1,
      ),
      rpc("session/new", { scopes: [] }, 2),
    ]);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].result.protocolVersion, 1);
    assert.equal(
      messages.find((message) => message.id === 2).error.code,
      49001,
      JSON.stringify(messages),
    );
  },
);
