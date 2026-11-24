import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { importCore } from "./support/core.mjs";
import {
  ensureBuilt,
  sandboxTempBase,
  windowsSrtSkipReason,
} from "./support/helpers.mjs";

const core = await importCore();
const TESTS_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(TESTS_DIR, "..");
const CORE_URL = pathToFileURL(
  path.join(REPO_ROOT, "packages", "core", "dist", "index.js"),
).href;
const PI_URL = pathToFileURL(
  path.join(
    REPO_ROOT,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "index.js",
  ),
).href;
const PTY_RUNNER =
  process.platform === "win32"
    ? [process.execPath, path.join(TESTS_DIR, "support", "pty-run.mjs")]
    : ["python3", path.join(TESTS_DIR, "support", "pty-run.py")];
const WINDOWS_SRT_SKIP = await windowsSrtSkipReason(core);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value !== null && value !== undefined && value !== false) {
      return value;
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForExit(exited, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function stripAnsi(text) {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[@-_]/gu, "");
}

function harnessSource() {
  return `import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.argv[2];
const mode = process.env["HARNESS_MODE"];
const sessionId = process.env["HARNESS_SESSION_ID"];
const modelBaseUrl = process.env["HARNESS_MODEL_URL"];
const core = await import(process.env["HARNESS_CORE_URL"]);
const pi = await import(process.env["HARNESS_PI_URL"]);

const project = path.join(root, "project");
const home = path.join(root, "home");
const evidencePath = path.join(root, "evidence.jsonl");
const readyPath = path.join(root, "ready.json");
const resultPath = path.join(root, "harness-result.json");
await fs.mkdir(project, { recursive: true });
await fs.mkdir(home, { recursive: true });
process.env["PI_OFFLINE"] = "1";
await fs.writeFile(
  path.join(home, "auth.json"),
  JSON.stringify({ local: { type: "api_key", key: "test-key" } }),
  { mode: 0o600 },
);
await fs.writeFile(
  path.join(home, "models.json"),
  JSON.stringify({
    providers: {
      local: {
        baseUrl: modelBaseUrl,
        apiKey: "test-key",
        api: "openai-completions",
        models: [
          {
            id: "local-test",
            name: "Local Test",
            api: "openai-completions",
            contextWindow: 2_000,
            maxTokens: 200,
          },
        ],
      },
    },
  }),
);

const model = {
  provider: "local",
  id: "local-test",
  name: "pi drill local model",
  api: "openai-completions",
  baseUrl: modelBaseUrl,
  reasoning: false,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 2_000,
  maxTokens: 200,
};

const ledger = await core.EvidenceLedger.open(evidencePath);
const store = await core.SessionStore.create({
  rootDir: home,
  cwd: project,
  sessionId,
  heartbeatMs: 60_000,
});
const sandbox = await core.SrtSandbox.create({
  cwd: project,
  workspaceRoot: project,
  deliveryRoot: project,
  codepunkHome: home,
  writeSet: [project],
});
const approval = new core.ApprovalBroker({ workspaceTrusted: true });
let approvalRequests = 0;
approval.registerChannel({
  id: "pi-drill-auto-allow",
  kind: "cli",
  isTTY: true,
  async ask(request) {
    approvalRequests += 1;
    return {
      request_id: request.request_id,
      answer: "allow",
      scope: "once",
      channel: "cli",
      channel_id: request.channel_id,
      nonce_sha256: request.nonce_sha256,
      worker_id: request.worker_id,
      session_id: request.session_id,
      tool_call_id: request.tool_call_id,
      answered_at: new Date().toISOString(),
    };
  },
});

let host;
const failingExtension = {
  name: "codepunk-tui",
  hidden: true,
  factory(piApi) {
    piApi.on("message_end", async (event) => {
      if (event.message.role === "assistant") {
        throw new Error("synthetic R9 extension failure");
      }
    });
  },
};

const shutdownExtension = {
  name: "codepunk-tui",
  hidden: true,
  factory(piApi) {
    piApi.on("session_shutdown", async () => {
      await host?.dispose();
    });
  },
};

try {
  host = await core.createPiHost({
    cwd: project,
    workspaceRoot: project,
    deliveryRoot: project,
    codepunkHome: home,
    sessionId: store.sessionId,
    runId: "run-pi-drill",
    writeSet: [project],
    mode: "interactive",
    approval,
    ledger,
    sandbox,
    sessionStore: store,
    model,
    settings: {
      compaction: {
        enabled: true,
        reserveTokens: 1,
        keepRecentTokens: 1,
      },
    },
    additionalExtensionFactories: [
      ...(mode === "r9" ? [failingExtension] : []),
      shutdownExtension,
    ],
  });
  await host.services.modelRuntime.setRuntimeApiKey("local", "test-key");
  if (mode === "r4") {
    // Pi supports a sequential batch mode. Codepunk does not set it, but the
    // drill needs calls 2 and 3 to be genuinely unstarted when Esc arrives.
    host.session.agent.toolExecution = "sequential";
  }
  const runtime = await pi.createAgentSessionRuntime(
    async () => ({
      session: host.session,
      services: host.services,
      diagnostics: host.services.diagnostics,
      extensionsResult: host.services.resourceLoader.getExtensions(),
    }),
    {
      cwd: project,
      agentDir: home,
      sessionManager: host.sessionManager,
    },
  );
  const interactive = new pi.InteractiveMode(runtime, {
    verbose: false,
    startupDiagnostics: [],
  });
  await interactive.init();
  await fs.writeFile(
    readyPath + ".tmp",
    JSON.stringify({ pid: process.pid, tty: process.stdin.isTTY === true }) + "\\n",
  );
  await fs.rename(readyPath + ".tmp", readyPath);
  await interactive.run();
} finally {
  await fs
    .writeFile(
      resultPath + ".tmp",
      JSON.stringify({
        approvals: approvalRequests,
        events: store.allEvents.map((event) => ({
          kind: event.kind,
          data: event.data,
        })),
      }) + "\\n",
    )
    .catch(() => undefined);
  await fs.rename(resultPath + ".tmp", resultPath).catch(() => undefined);
  await host?.dispose();
  await sandbox.close();
}
`;
}

function startHarness(root, mode, modelBaseUrl, sessionId) {
  const scriptPath = path.join(root, `pi-drill-${mode}.mjs`);
  const pidFile = path.join(root, `pi-drill-${mode}.pid`);
  return fs.writeFile(scriptPath, harnessSource()).then(() => {
    const child = spawn(
      PTY_RUNNER[0],
      [...PTY_RUNNER.slice(1), process.execPath, scriptPath, root],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HARNESS_MODE: mode,
          HARNESS_SESSION_ID: sessionId,
          HARNESS_MODEL_URL: modelBaseUrl,
          HARNESS_CORE_URL: CORE_URL,
          HARNESS_PI_URL: PI_URL,
          PTY_RUN_PID_FILE: pidFile,
          ...(mode === "r9" ? { PTY_RUN_ROWS: "120" } : {}),
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    const exited = new Promise((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    return {
      child,
      exited,
      pidFile,
      output: () => output,
      transcript: () => stripAnsi(output),
    };
  });
}

async function stopHarness(session) {
  if (session.child.exitCode !== null || session.child.signalCode !== null) {
    return;
  }
  let pid;
  try {
    pid = Number.parseInt(await fs.readFile(session.pidFile, "utf8"), 10);
  } catch {
    pid = Number.NaN;
  }
  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
  if (session.child.exitCode === null && session.child.signalCode === null) {
    session.child.kill("SIGKILL");
  }
  await session.exited;
}

async function startR4ModelServer(root) {
  const requests = [];
  const firstMarker = path.join(root, "project", "first.started");
  const secondMarker = path.join(root, "project", "second.started");
  const thirdMarker = path.join(root, "project", "third.started");
  const commands = [
    `printf started > ${JSON.stringify(firstMarker)}; sleep 8`,
    `printf second > ${JSON.stringify(secondMarker)}`,
    `printf third > ${JSON.stringify(thirdMarker)}`,
  ];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        // Esc aborts the in-flight model request, which can close the socket
        // before the body arrives. An aborted request is not a model call.
        response.destroy();
        return;
      }
      requests.push(body);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const send = (value) => {
        response.write(`data: ${JSON.stringify(value)}\n\n`);
      };
      const hasToolResult = body.messages.some(
        (message) => message.role === "tool",
      );
      if (!hasToolResult) {
        commands.forEach((command, index) => {
          send({
            id: "drill-response",
            object: "chat.completion.chunk",
            created: 1,
            model: "local-test",
            choices: [
              {
                index: 0,
                delta: {
                  ...(index === 0 ? { role: "assistant", content: null } : {}),
                  tool_calls: [
                    {
                      index,
                      id: `drill-call-${index + 1}`,
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        });
        send({
          id: "drill-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 30,
            total_tokens: 50,
          },
        });
      } else {
        send({
          id: "drill-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "batch complete" },
              finish_reason: null,
            },
          ],
        });
        send({
          id: "drill-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 2,
            total_tokens: 22,
          },
        });
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address);
  return {
    server,
    requests,
    firstMarker,
    secondMarker,
    thirdMarker,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
}

async function startR9ModelServer() {
  const requests = [];
  let replyIndex = 0;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      try {
        requests.push(JSON.parse(raw));
      } catch {
        response.destroy();
        return;
      }
      replyIndex += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const send = (value) => {
        response.write(`data: ${JSON.stringify(value)}\n\n`);
      };
      send({
        id: "drill-response",
        object: "chat.completion.chunk",
        created: 1,
        model: "local-test",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: `r9 reply ${replyIndex}`,
            },
            finish_reason: null,
          },
        ],
      });
      send({
        id: "drill-response",
        object: "chat.completion.chunk",
        created: 1,
        model: "local-test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 3,
          total_tokens: 8,
        },
      });
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address);
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
}

async function readSessionEvents(sessionPath) {
  const lines = (await fs.readFile(sessionPath, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
  return lines.slice(1).map((line) => JSON.parse(line));
}

function messagesFromEntries(entries) {
  return entries
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

test(
  "R4: Esc during the first call leaves later batch calls unstarted and consistent",
  {
    skip: process.platform === "win32" ? WINDOWS_SRT_SKIP : false,
  },
  async () => {
    const base = sandboxTempBase();
    const sessionId = "drill-r4-session";
    await fs.mkdir(base, { recursive: true });
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(base, "codepunk-pi-r4-")),
    );
    await ensureBuilt();
    const modelServer = await startR4ModelServer(root);
    const session = await startHarness(
      root,
      "r4",
      modelServer.baseUrl,
      sessionId,
    );
    let exited = null;
    try {
      const ready = await waitFor(async () => {
        try {
          return JSON.parse(
            await fs.readFile(path.join(root, "ready.json"), "utf8"),
          );
        } catch (error) {
          if (error?.code === "ENOENT") {
            return null;
          }
          throw error;
        }
      }, "R4 harness readiness");
      assert.equal(ready.tty, true);
      await delay(300);

      session.child.stdin.write("run the three-tool batch\r");
      await waitFor(
        () =>
          fs
            .access(modelServer.firstMarker)
            .then(() => true)
            .catch(() => null),
        "first bash call to start",
        30_000,
      );

      session.child.stdin.write("\u001b");
      await waitFor(
        () => /Operation aborted/u.test(session.transcript()),
        "Operation aborted rendering",
        30_000,
      );
      await delay(1_500);
      assert.equal(
        await fs.access(modelServer.secondMarker).then(
          () => true,
          () => false,
        ),
        false,
        "the second tool call must not start",
      );
      assert.equal(
        await fs.access(modelServer.thirdMarker).then(
          () => true,
          () => false,
        ),
        false,
        "the third tool call must not start",
      );

      session.child.stdin.write("/quit\r");
      exited = await waitForExit(session.exited, 20_000);
      assert.ok(exited, "R4 harness did not exit after /quit");
      assert.equal(exited.code, 0, session.transcript());

      const evidence = await core.readEvidenceFile(
        path.join(root, "evidence.jsonl"),
      );
      assert.equal(evidence.records.length, 1);
      const record = evidence.records[0];
      assert.equal(record.tool_call_id, "drill-call-1");
      assert.equal(record.tool, "bash");
      assert.equal(record.decision, "allow");
      assert.equal(record.outcome, "cancelled");
      assert.notEqual(record.approval, null);
      assert.equal(record.exit_code, null);
      assert.equal(
        evidence.records.some((item) =>
          ["drill-call-2", "drill-call-3"].includes(item.tool_call_id),
        ),
        false,
      );

      const sessionPath = path.join(
        root,
        "home",
        "projects",
        await findProjectId(root),
        "sessions",
        sessionId,
        "session.jsonl",
      );
      const events = await readSessionEvents(sessionPath);
      const runEnds = events.filter((event) => event.kind === "run/end");
      assert.equal(runEnds.length, 1);
      assert.equal(runEnds[0].data.state, "aborted");
      const approvalAnswers = events.filter(
        (event) => event.kind === "approval/answer",
      );
      assert.equal(approvalAnswers.length, 1);
      assert.equal(approvalAnswers[0].data.tool_call_id, "drill-call-1");

      const reopened = await core.SessionStore.open({
        rootDir: path.join(root, "home"),
        cwd: path.join(root, "project"),
        sessionId,
      });
      const resumed = await reopened.resume();
      assert.equal(resumed.uncommittedEvents.length, 0);
      const stateMessages = messagesFromEntries(resumed.state.branch);
      const toolResults = stateMessages.filter(
        (message) => message.role === "toolResult",
      );
      assert.equal(
        toolResults.map((message) => message.toolCallId).join(","),
        "drill-call-1,drill-call-2,drill-call-3",
      );
      for (const aborted of toolResults.slice(1)) {
        assert.equal(aborted.isError, true);
        assert.equal(aborted.content[0].text, "Operation aborted");
      }
      assert.equal(
        stateMessages
          .filter((message) => message.role === "assistant")
          .flatMap((message) =>
            message.content.filter((part) => part.type === "toolCall"),
          ).length,
        3,
      );
      assert.ok(
        stateMessages.some(
          (message) =>
            message.role === "assistant" && message.stopReason === "aborted",
        ),
      );

      const ledger = await core.EvidenceLedger.open(
        path.join(root, "restore-evidence.jsonl"),
      );
      const restored = await core.createPiHost({
        cwd: path.join(root, "project"),
        workspaceRoot: path.join(root, "project"),
        deliveryRoot: path.join(root, "project"),
        codepunkHome: path.join(root, "home"),
        sessionId: reopened.sessionId,
        runId: "run-pi-drill-restore",
        writeSet: [path.join(root, "project")],
        mode: "interactive",
        approval: null,
        ledger,
        sandbox: null,
        sessionStore: reopened,
        restore: resumed.state,
      });
      try {
        const branchMessages = messagesFromEntries(
          restored.sessionManager.getBranch(),
        );
        const restoredResults = branchMessages.filter(
          (message) => message.role === "toolResult",
        );
        assert.equal(
          restoredResults.map((message) => message.toolCallId).join(","),
          "drill-call-1,drill-call-2,drill-call-3",
        );
        assert.equal(restoredResults[1].content[0].text, "Operation aborted");
        assert.equal(restoredResults[2].content[0].text, "Operation aborted");
      } finally {
        await restored.dispose();
      }
    } finally {
      if (exited === null) {
        await stopHarness(session);
      }
      await new Promise((resolve) => modelServer.server.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "R9: a throwing extension event handler is shown and the conversation continues",
  {
    skip: process.platform === "win32" ? WINDOWS_SRT_SKIP : false,
  },
  async () => {
    const base = sandboxTempBase();
    await fs.mkdir(base, { recursive: true });
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(base, "codepunk-pi-r9-")),
    );
    await ensureBuilt();
    const modelServer = await startR9ModelServer();
    const session = await startHarness(
      root,
      "r9",
      modelServer.baseUrl,
      "drill-r9-session",
    );
    let exited = null;
    try {
      const ready = await waitFor(async () => {
        try {
          return JSON.parse(
            await fs.readFile(path.join(root, "ready.json"), "utf8"),
          );
        } catch (error) {
          if (error?.code === "ENOENT") {
            return null;
          }
          throw error;
        }
      }, "R9 harness readiness");
      assert.equal(ready.tty, true);
      await delay(300);

      session.child.stdin.write("first r9 prompt\r");
      await waitFor(
        () =>
          session.transcript().includes("r9 reply 1") &&
          session.transcript().includes("synthetic R9 extension failure"),
        "first reply and extension error line",
        30_000,
      );
      assert.match(
        session.transcript(),
        /Extension "[^"]*" error: synthetic R9 extension failure/u,
      );

      session.child.stdin.write("second r9 prompt\r");
      await waitFor(
        () =>
          session.transcript().includes("r9 reply 2") &&
          (session.transcript().match(/synthetic R9 extension failure/gu) ?? [])
            .length >= 2,
        "second reply and second extension error line",
        30_000,
      );

      session.child.stdin.write("/quit\r");
      exited = await waitForExit(session.exited, 20_000);
      assert.ok(exited, "R9 harness did not exit after /quit");
      assert.equal(exited.code, 0, session.transcript());

      const sessionPath = path.join(
        root,
        "home",
        "projects",
        await findProjectId(root),
        "sessions",
        "drill-r9-session",
        "session.jsonl",
      );
      const events = await readSessionEvents(sessionPath);
      const runEnds = events.filter((event) => event.kind === "run/end");
      assert.equal(runEnds.length, 2);
      assert.deepEqual(
        runEnds.map((event) => event.data.state),
        ["settled", "settled"],
      );
      assert.equal(modelServer.requests.length, 2);

      const reopened = await core.SessionStore.open({
        rootDir: path.join(root, "home"),
        cwd: path.join(root, "project"),
        sessionId: "drill-r9-session",
      });
      const resumed = await reopened.resume();
      assert.equal(resumed.uncommittedEvents.length, 0);
      const messages = messagesFromEntries(resumed.state.branch);
      assert.equal(
        messages.filter((message) => message.role === "user").length,
        2,
      );
      assert.equal(
        messages.filter((message) => message.role === "assistant").length,
        2,
      );
    } finally {
      if (exited === null) {
        await stopHarness(session);
      }
      await new Promise((resolve) => modelServer.server.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

async function findProjectId(root) {
  const projects = await fs.readdir(path.join(root, "home", "projects"));
  assert.equal(projects.length, 1);
  return projects[0];
}
