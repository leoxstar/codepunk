import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  ensureBuilt,
  REPO_ROOT,
  trustWorkspace,
  withTempDirectory,
} from "./support/helpers.mjs";
import { importSource } from "./support/core.mjs";

const execFileAsync = promisify(execFile);

async function startTextModelServer() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(raw));
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const send = (value) => {
        response.write(`data: ${JSON.stringify(value)}\n\n`);
      };
      send({
        id: "text-response",
        object: "chat.completion.chunk",
        created: 1,
        model: "local-test",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "CHILD_OK" },
            finish_reason: null,
          },
        ],
      });
      send({
        id: "text-response",
        object: "chat.completion.chunk",
        created: 1,
        model: "local-test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
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

async function startHeldModelServer() {
  const requests = [];
  let firstResponse = null;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(raw));
      if (requests.length === 1) {
        firstResponse = response;
        return;
      }
      sendTextResponse(
        response,
        requests.length === 2 ? "STEER_DONE" : "AFTER_DONE",
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address);
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    releaseFirst() {
      assert.ok(firstResponse);
      sendTextResponse(firstResponse, "FIRST_DONE");
      firstResponse = null;
    },
  };
}

function sendTextResponse(response, text) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  const send = (value) => {
    response.write(`data: ${JSON.stringify(value)}\n\n`);
  };
  send({
    id: "text-response",
    object: "chat.completion.chunk",
    created: 1,
    model: "local-test",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: text },
        finish_reason: null,
      },
    ],
  });
  send({
    id: "text-response",
    object: "chat.completion.chunk",
    created: 1,
    model: "local-test",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    },
  });
  response.write("data: [DONE]\n\n");
  response.end();
}

async function startWriteModelServer({ path: targetPath, content }) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw);
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
        send({
          id: "write-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: "call-write",
                    type: "function",
                    function: {
                      name: "write",
                      arguments: JSON.stringify({
                        path: targetPath,
                        content,
                      }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({
          id: "write-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        });
      } else {
        send({
          id: "write-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "WRITE_DONE" },
              finish_reason: null,
            },
          ],
        });
        send({
          id: "write-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 2,
            total_tokens: 6,
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
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
}

test("the TUI treats an active session model as selected", async () => {
  const { setTuiRuntime } = await importSource("packages/cli/src/tui.ts");
  const makeState = () => ({
    runtime: null,
    context: null,
    channel: {},
    lastRunId: null,
    lastEvidence: 0,
    warningsShown: false,
    modelSelected: false,
  });
  const matched = makeState();
  setTuiRuntime(matched, {
    config: { model: { provider: "local", id: "chat" } },
    host: { session: { model: { provider: "local", id: "chat" } } },
  });
  assert.equal(matched.modelSelected, true);

  const noModel = makeState();
  setTuiRuntime(noModel, {
    config: { model: { provider: null, id: null } },
    host: { session: { model: undefined } },
  });
  assert.equal(noModel.modelSelected, false);

  const unknown = makeState();
  setTuiRuntime(unknown, {
    config: { model: { provider: null, id: null } },
    host: { session: { model: { provider: "unknown", id: "unknown" } } },
  });
  assert.equal(unknown.modelSelected, false);

  const unconfigured = makeState();
  setTuiRuntime(unconfigured, {
    config: { model: { provider: null, id: null } },
    host: { session: { model: { provider: "local", id: "chat" } } },
  });
  assert.equal(unconfigured.modelSelected, true);
});

test("no-model onboarding treats the Pi unknown sentinel as absent", async () => {
  const { modelOnboardingMessage } = await importSource(
    "packages/cli/src/tui.ts",
  );
  const runtime = {
    config: { model: { provider: null, id: null } },
    host: { session: { model: { provider: "unknown", id: "unknown" } } },
  };
  const message = modelOnboardingMessage(runtime);
  assert.match(message, /No model configured\./u);
  assert.match(message, /\/model/u);
  assert.match(message, /codepunk models import/u);

  const primaryUnknown = modelOnboardingMessage({
    ...runtime,
    primaryModel: { provider: "unknown", id: "unknown" },
  });
  assert.match(primaryUnknown, /No model configured\./u);
  assert.doesNotMatch(primaryUnknown, /unknown\/unknown/u);
});

test("a failed persistent write allows only the current call", async () => {
  const { TuiApprovalChannel } = await importSource("packages/cli/src/tui.ts");
  const notifications = [];
  const selections = [
    "Always allow this exact command",
    "Save exact rule and allow",
  ];
  const channel = new TuiApprovalChannel(true);
  channel.attach({
    ui: {
      async select(_title, options) {
        const next = selections.shift();
        assert.ok(options.includes(next), `${next} is not in ${options}`);
        return next;
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  });
  channel.setPersistHandler(async () => false);
  const answer = await channel.ask({
    request_id: "request-1",
    nonce_sha256: `sha256:${"a".repeat(64)}`,
    ttl_ms: 30_000,
    worker_id: "local",
    session_id: "session-1",
    tool_call_id: "call-1",
    channel_id: "tui-main",
    command: "touch probe.txt",
    argv: ["touch", "probe.txt"],
    cwd: "/workspace",
    created_at: "2026-11-14T00:00:00.000Z",
    expires_at: "2026-11-14T00:00:30.000Z",
  });
  assert.equal(answer.answer, "allow");
  assert.equal(answer.scope, "once");
  assert.deepEqual(notifications, [
    {
      message: "the exact rule was not stored; allowing this call only",
      level: "warning",
    },
  ]);
});

test("the Codepunk help lists the real command surface", async () => {
  const { codepunkHelp } = await importSource("packages/cli/src/tui.ts");
  const help = codepunkHelp();
  assert.match(help, /\/model \[query\]/u);
  assert.match(help, /\/permissions why -- <cmd>/u);
  assert.match(help, /\/plan\s+show the current plan/u);
  assert.doesNotMatch(help, /\/cp-plan/u);
  assert.match(help, /\/todos\s+show the current todo list/u);
  assert.match(help, /\/init \[--update\]/u);
  assert.match(help, /\/status\s+show model, session, permissions/u);
  assert.match(help, /\/help\s+show this command list/u);
  assert.doesNotMatch(help, /\/share/u);
});

test("/init prompts the model with repository-evidence instructions", async () => {
  const { buildInitPrompt } = await importSource("packages/cli/src/tui.ts");
  const created = buildInitPrompt("/repo", null);
  assert.match(
    created,
    /^Create the repository guidance file at \/repo\/AGENTS\.md\./u,
  );
  assert.match(created, /Work from repository evidence only\./u);
  assert.match(created, /Do not modify\s+any file other than the target\./u);
  assert.match(created, /Keep it under 120 lines\./u);
  assert.doesNotMatch(created, /^## /mu);

  const updated = buildInitPrompt("/repo", "/repo/CLAUDE.md");
  assert.match(
    updated,
    /^Update the repository guidance file at \/repo\/CLAUDE\.md\./u,
  );
  assert.match(updated, /Preserve accurate existing content/u);
});

test("permissions why accepts exactly one leading separator", async () => {
  const { parsePermissionWhyCommand } = await importSource(
    "packages/cli/src/tui.ts",
  );
  assert.equal(parsePermissionWhyCommand("why date +%A"), "date +%A");
  assert.equal(parsePermissionWhyCommand("why -- date +%A"), "date +%A");
  assert.equal(
    parsePermissionWhyCommand("why -- touch probe.txt"),
    "touch probe.txt",
  );
  assert.equal(parsePermissionWhyCommand("why -- --flag"), "--flag");
  assert.equal(parsePermissionWhyCommand("why"), null);
  assert.equal(parsePermissionWhyCommand("why --"), null);
  assert.equal(parsePermissionWhyCommand("rules"), null);
});

test("autocomplete hides intercepted Pi builtins", async () => {
  const { filterInterceptedAutocomplete } = await importSource(
    "packages/cli/src/tui.ts",
  );
  const items = [
    { value: "model", label: "model" },
    { value: "plan", label: "plan" },
    { value: "settings", label: "settings" },
    { value: "share", label: "share" },
    { value: "resume", label: "resume" },
    { value: "new", label: "new" },
    { value: "fork", label: "fork" },
    { value: "clone", label: "clone" },
    { value: "tree", label: "tree" },
    { value: "permissions", label: "permissions" },
  ];
  assert.deepEqual(
    filterInterceptedAutocomplete(items).map((item) => item.value),
    ["model", "plan", "resume", "new", "fork", "clone", "tree", "permissions"],
  );
});

test("resume preflight rejects a session held by a live writer", async () => {
  const core = await importSource("packages/core/src/index.ts");
  const { sessionResumeIssue } = await importSource("packages/cli/src/tui.ts");
  await withTempDirectory("codepunk-resume-preflight-", async (dir) => {
    const projectId = "resume-preflight";
    const store = await core.SessionStore.create({
      rootDir: dir,
      cwd: dir,
      projectRoot: dir,
      projectId,
      sessionId: core.createUlid(),
    });
    const runtime = {
      paths: { home: dir, cwd: dir, deliveryRoot: dir, projectId },
    };
    assert.equal(await sessionResumeIssue(runtime, store.sessionId), null);
    const writer = await store.acquireWriter();
    try {
      const issue = await sessionResumeIssue(runtime, store.sessionId);
      assert.match(issue ?? "", /not resumable now/);
    } finally {
      await writer.release();
    }
  });
});

test("the Pi builtin command table is loaded from the installed host", async () => {
  const { loadPiBuiltinSlashCommands } = await importSource(
    "packages/cli/src/tui.ts",
  );
  const commands = await loadPiBuiltinSlashCommands();
  assert.ok(commands.length > 0);
  assert.ok(commands.every((command) => command.name.length > 0));
  assert.ok(commands.some((command) => command.name === "model"));
  assert.ok(commands.some((command) => command.name === "quit"));
});

test("fallback selection still resolves to the configured physical model", async () => {
  const { modelOnboardingMessage, setTuiRuntime } = await importSource(
    "packages/cli/src/tui.ts",
  );
  const runtime = {
    config: {
      model: { provider: "openai", id: "primary" },
      tui: { header: true, footer: true, status: true },
    },
    primaryModel: { provider: "openai", id: "primary" },
    host: {
      session: {
        model: { provider: "codepunk", id: "auto" },
      },
    },
  };
  assert.equal(modelOnboardingMessage(runtime), undefined);

  const state = {
    runtime: null,
    context: null,
    channel: {},
    lastRunId: null,
    lastEvidence: 0,
    warningsShown: false,
    modelSelected: false,
  };
  setTuiRuntime(state, runtime);
  assert.equal(state.modelSelected, true);
});

function runPty(command, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "python3",
      [
        path.join(REPO_ROOT, "tests", "support", "pty-run.py"),
        command,
        ...args,
      ],
      {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for the TUI"));
    }, 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(output.join(""));
    });
  });
}

function startPty(command, args, { cwd, env }) {
  const pidFile = path.join(
    env.CODEPUNK_HOME,
    `pty-child-${process.pid}-${Date.now()}.pid`,
  );
  const child = spawn(
    "python3",
    [path.join(REPO_ROOT, "tests", "support", "pty-run.py"), command, ...args],
    {
      cwd,
      env: { ...env, PTY_RUN_PID_FILE: pidFile },
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
  };
}

async function killPtyGroup(session) {
  let pid;
  try {
    pid = Number.parseInt(await fs.readFile(session.pidFile, "utf8"), 10);
  } catch {
    return;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

async function stopPty(session) {
  try {
    await killPtyGroup(session);
    if (session.child.exitCode !== null || session.child.signalCode !== null) {
      return;
    }
    session.child.kill("SIGTERM");
    let timer;
    const result = await Promise.race([
      session.exited,
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ code: "timeout", signal: null }),
          2_000,
        );
      }),
    ]);
    clearTimeout(timer);
    if (result.code === "timeout") {
      session.child.kill("SIGKILL");
      await session.exited;
    }
  } finally {
    await fs.rm(session.pidFile, { force: true });
  }
}

async function waitForOutput(session, marker, label) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (stripAnsi(session.output()).includes(marker)) {
      return;
    }
    if (session.child.exitCode !== null) {
      throw new Error(
        `${label}: TUI exited before rendering ${marker}\n${stripAnsi(
          session.output(),
        ).slice(-4000)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `${label}: timed out waiting for ${marker}\n${session.output().slice(-4000)}`,
  );
}

async function waitForOutputAfter(session, mark, marker, label) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (stripAnsi(session.output().slice(mark)).includes(marker)) {
      return;
    }
    if (session.child.exitCode !== null) {
      throw new Error(
        `${label}: TUI exited before rendering ${marker}\n${stripAnsi(
          session.output(),
        ).slice(-4000)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `${label}: timed out waiting for ${marker}\n${session.output().slice(-4000)}`,
  );
}

function stripAnsi(value) {
  return value.replace(
    // CSI, OSC, and simple two-byte escape sequences emitted by the TUI.
    /\u001b(?:\][^\u0007]*?(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/gu,
    "",
  );
}

async function waitForAnyOutputAfter(session, mark, markers, label) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const output = session.output().slice(mark);
    const matched = markers.find((marker) => output.includes(marker));
    if (matched !== undefined) {
      return matched;
    }
    if (session.child.exitCode !== null) {
      throw new Error(`${label}: TUI exited before rendering a marker`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label}: timed out waiting for ${markers.join(" or ")}`);
}

async function submitUserBashWhenIdle(session, command, label) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const mark = session.output().length;
    session.child.stdin.write(`${command}\r`);
    const matched = await waitForAnyOutputAfter(
      session,
      mark,
      ["Approval required", "is already running"],
      label,
    );
    if (matched === "Approval required") {
      return;
    }
    session.child.stdin.write("\u0015");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: the shell stayed busy`);
}

async function runCommand(session, command, marker) {
  session.child.stdin.write(`${command}\r`);
  await waitForOutput(session, marker, command);
}

async function waitForQuiet(session, quietMs = 100) {
  let lastLength = session.output().length;
  let quietSince = Date.now();
  while (Date.now() - quietSince < quietMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const length = session.output().length;
    if (length !== lastLength) {
      lastLength = length;
      quietSince = Date.now();
    }
  }
}

async function runCommandAfter(session, command, marker) {
  // A command sent while the previous full-screen repaint is still streaming
  // can have the top of its panel written before `mark`, which makes the
  // assertion fail even though the content was rendered.
  await waitForQuiet(session);
  const mark = session.output().length;
  session.child.stdin.write(`${command}\r`);
  await waitForOutputAfter(session, mark, marker, command);
  // Let the terminal finish repainting the notification before the next
  // synthetic key sequence reaches the editor. A fixed delay can race with a
  // large redraw and drop the next command; a quiet period follows the paint.
  await waitForQuiet(session, 250);
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value !== null && value !== undefined && value !== false) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function readEvidence(home) {
  const entries = await fs.readdir(home, { recursive: true });
  const records = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl") || !entry.includes("evidence")) {
      continue;
    }
    const lines = (await fs.readFile(path.join(home, entry), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    for (const line of lines) {
      records.push(JSON.parse(line));
    }
  }
  return records;
}

async function waitForBashResult(home, command) {
  return waitFor(async () => {
    const entries = await fs.readdir(home, { recursive: true });
    for (const entry of entries) {
      if (!entry.endsWith("session.jsonl")) {
        continue;
      }
      const lines = (await fs.readFile(path.join(home, entry), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0);
      for (const line of lines) {
        const record = JSON.parse(line);
        if (
          record.type === "codepunk/event" &&
          record.kind === "bash/result" &&
          record.data?.command === command
        ) {
          return record;
        }
      }
    }
    return null;
  }, `bash result for ${command}`);
}

test("a real pty renders codepunk chrome and exit hints", async () => {
  await withTempDirectory("codepunk-tui-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const cli = await ensureBuilt();
    const output = await runPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
        PTY_RUN_TIMEOUT: "4",
      },
    });
    assert.match(output, /codepunk · auto\/auto/u);
    assert.match(
      output,
      /permissions custom · trust trusted · shell disabled · next sandbox uncovered · fs workspace · evidence 0/u,
    );
    assert.match(output, /session [0-9A-Z]{10}/u);
    assert.doesNotMatch(output, /v1\.5\.2/u);
  });
});

test("a real pty undoes and redoes Codepunk file changes", async () => {
  await withTempDirectory("codepunk-tui-undo-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(path.join(project, "note.txt"), "before\n");
    const model = await startWriteModelServer({
      path: "note.txt",
      content: "after\n",
    });
    await fs.writeFile(
      path.join(home, "config.toml"),
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[approval]",
        'mode = "allow"',
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...process.env,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      session.child.stdin.write("write note.txt\r");
      await waitForOutput(session, "WRITE_DONE", "model write");
      assert.equal(
        await fs.readFile(path.join(project, "note.txt"), "utf8"),
        "after\n",
      );

      await runCommandAfter(session, "/undo", "Undo file changes?");
      session.child.stdin.write("\r");
      await waitForOutput(session, "undo: 1 file checkpoint(s) restored");
      assert.equal(
        await fs.readFile(path.join(project, "note.txt"), "utf8"),
        "before\n",
      );

      await runCommandAfter(session, "/redo", "Redo file changes?");
      session.child.stdin.write("\r");
      await waitForOutput(session, "redo: 1 file checkpoint(s) restored");
      assert.equal(
        await fs.readFile(path.join(project, "note.txt"), "utf8"),
        "after\n",
      );

      const eventFiles = (await fs.readdir(home, { recursive: true })).filter(
        (entry) => entry.endsWith("session.jsonl"),
      );
      assert.equal(eventFiles.length, 1);
      const events = (await fs.readFile(path.join(home, eventFiles[0]), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      const restores = events.filter(
        (entry) => entry.kind === "checkpoint/restore",
      );
      assert.deepEqual(
        restores.map((entry) => entry.data.action),
        ["undo", "redo"],
      );

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
      model.server.close();
    }
  });
});

test("a real pty guides first-run model setup without a Pi-only warning", async () => {
  await withTempDirectory("codepunk-tui-no-model-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const modelMark = session.output().length;
      session.child.stdin.write("/model\r");
      await waitForOutputAfter(
        session,
        modelMark,
        "No authenticated models.",
        "/model without credentials",
      );
      assert.doesNotMatch(
        session.output().slice(modelMark),
        /Pi-only command intercepted/u,
      );

      const promptMark = session.output().length;
      session.child.stdin.write("hello\r");
      await waitForOutputAfter(
        session,
        promptMark,
        "No model configured",
        "first-run prompt gate",
      );
      assert.match(
        session.output().slice(promptMark),
        /Sign in to a provider/u,
      );
      const setupMark = session.output().length;
      session.child.stdin.write("\u001b[B\u001b[B\r");
      await waitForOutputAfter(
        session,
        setupMark,
        "codepunk models import",
        "first-run setup commands",
      );

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty reports status without a configured model", async () => {
  await withTempDirectory("codepunk-tui-status-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const mark = session.output().length;
      session.child.stdin.write("/status\r");
      await waitForOutputAfter(
        session,
        mark,
        "codepunk status",
        "/status command",
      );
      await waitForOutputAfter(
        session,
        mark,
        "sessions: ",
        "/status completion",
      );
      const output = session.output().slice(mark);
      assert.match(output, /project: /u);
      assert.match(output, /model: not selected/u);
      assert.match(output, /permissions: /u);
      assert.match(output, /trust: (trusted|untrusted) \(/u);
      assert.match(output, /capabilities: /u);
      assert.match(output, /evidence: /u);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("/init refuses to overwrite an existing root instruction file", async () => {
  await withTempDirectory("codepunk-tui-init-existing-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(path.join(project, "AGENTS.md"), "EXISTING_RULE\n");
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await trustWorkspace(home, project);
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const mark = session.output().length;
      session.child.stdin.write("/init\r");
      await waitForOutputAfter(
        session,
        mark,
        "Use /init --update to let the agent revise that file in place.",
        "/init existing file guard",
      );
      assert.match(session.output().slice(mark), /\/init --update/u);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("/init sends the repository-evidence prompt to the selected model", async () => {
  await withTempDirectory("codepunk-tui-init-model-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const model = await startTextModelServer();
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...process.env,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      await runCommandAfter(session, "/init", "CHILD_OK");
      assert.match(
        session.output(),
        /Starting project instruction initialization/u,
      );
      assert.ok(model.requests.length > 0);
      const request = JSON.stringify(model.requests);
      assert.match(request, /Create the repository guidance file/u);
      assert.match(request, /AGENTS\.md/u);
      assert.match(request, /Keep it under 120 lines/u);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
      model.server.close();
    }
  });
});

test("a real pty asks before a project instruction file is trusted", async () => {
  await withTempDirectory("codepunk-tui-trust-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "PROJECT_RULE_SENTINEL\n",
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "Project trust", "trust prompt");
      assert.match(session.output(), /AGENTS\.md/u);
      assert.match(session.output(), /sha256:[a-f0-9]{64}/u);
      assert.match(
        stripAnsi(session.output()),
        /saved decision\s+none for this exact checkout/u,
      );
      assert.match(
        stripAnsi(session.output()),
        /codepunk 0\.0\.0 · dist .+ · source current/u,
      );
      assert.match(
        stripAnsi(session.output()),
        /\u2191\u2193 navigate  enter select  esc\/ctrl\+c cancel/u,
      );
      assert.match(
        session.output(),
        /\u2192 Trust this workspace and remember/u,
      );
      assert.match(session.output(), /Load resources · remember/u);
      assert.match(session.output(), /Skip now · ask again next start/u);
      assert.doesNotMatch(
        session.output(),
        /1\. Trust this workspace and remember/u,
      );
      assert.doesNotMatch(session.output(), /1-3 to jump/u);
      assert.doesNotMatch(session.output(), /\[1\/2\/3\]/u);
      session.child.stdin.write("\u001b[B\u001b[B\r");
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const saved = JSON.parse(
        await fs.readFile(path.join(home, "trust.json"), "utf8"),
      );
      assert.equal(saved[await fs.realpath(project)], false);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
    const second = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(second, "codepunk · auto/auto", "saved decision");
      assert.doesNotMatch(second.output(), /Trust this workspace\?/u);
      second.child.stdin.write("/quit\r");
    } finally {
      await stopPty(second);
    }
  });
});

test("a real pty remembers the default trust choice", async () => {
  await withTempDirectory("codepunk-tui-trust-default-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "DEFAULT_TRUST_SENTINEL\n",
    );
    const cli = await ensureBuilt();
    const env = {
      ...process.env,
      CODEPUNK_HOME: home,
      PI_OFFLINE: "1",
      TERM: "xterm-256color",
      NO_COLOR: "1",
    };
    const first = startPty(process.execPath, [cli], { cwd: project, env });
    try {
      await waitForOutput(first, "Project trust", "first trust prompt");
      first.child.stdin.write("\r");
      await waitForOutput(first, "codepunk · auto/auto", "first startup");
      const store = JSON.parse(
        await fs.readFile(path.join(home, "trust.json"), "utf8"),
      );
      const realProject = await fs.realpath(project);
      assert.equal(store[realProject], true);
      first.child.stdin.write("/quit\r");
      const result = await Promise.race([
        first.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(first);
    }

    const second = startPty(process.execPath, [cli], { cwd: project, env });
    try {
      await waitForOutput(second, "codepunk · auto/auto", "trusted restart");
      assert.doesNotMatch(second.output(), /Trust this workspace\?/u);
      second.child.stdin.write("/quit\r");
      const result = await Promise.race([
        second.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(second);
    }
  });
});

test("a real pty cancels workspace trust without hanging", async () => {
  await withTempDirectory("codepunk-tui-trust-cancel-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "CANCEL_TRUST_SENTINEL\n",
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "Project trust", "trust prompt");
      session.child.stdin.write("\u001b");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 8_000),
        ),
      ]);
      assert.deepEqual(result, { code: 1, signal: null });
      assert.match(
        stripAnsi(session.output()),
        /workspace trust was not decided/u,
      );
      await assert.rejects(
        fs.readFile(path.join(home, "trust.json"), "utf8"),
        /ENOENT/u,
      );
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty can deny workspace trust for one session without saving", async () => {
  await withTempDirectory("codepunk-tui-trust-deny-session-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "DENY_SESSION_SENTINEL\n",
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "Project trust", "trust prompt");
      assert.match(
        stripAnsi(session.output()),
        /Do not trust for this session only/u,
      );
      session.child.stdin.write("\u001b[B\u001b[B\u001b[B\r");
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      assert.match(session.output(), /trust untrusted/u);
      await assert.rejects(
        fs.readFile(path.join(home, "trust.json"), "utf8"),
        /ENOENT/u,
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("--no-skills keeps project skills out of the /trust view", async () => {
  await withTempDirectory("codepunk-tui-trust-noskills-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(path.join(project, "AGENTS.md"), "PROJECT_RULE\n");
    await fs.mkdir(path.join(project, ".codepunk", "skills", "team"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(project, ".codepunk", "skills", "team", "SKILL.md"),
      "---\nname: team\ndescription: team\n---\nbody\n",
    );
    await trustWorkspace(home, project);
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli, "--no-skills"], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const mark = session.output().length;
      session.child.stdin.write("/trust\r");
      await waitForOutputAfter(
        session,
        mark,
        "excluded from this session's trust check",
        "/trust under --no-skills",
      );
      const view = session.output().slice(mark);
      assert.match(view, /AGENTS\.md/u);
      assert.match(view, /project skills \(--no-skills or --bare\)/u);
      // A resource that was never part of this session's decision must not be
      // presented as one the user is being asked to trust.
      assert.doesNotMatch(view, /\.codepunk\/skills/u);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("header and footer can be disabled without disabling the session", async () => {
  await withTempDirectory("codepunk-tui-hidden-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[tui]",
        "header = false",
        "footer = false",
        "status = false",
        "widgets = false",
        "",
      ].join("\n"),
    );
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, project, "startup");
      await waitForOutput(session, "0.0%/0", "startup footer");
      await new Promise((resolve) => setTimeout(resolve, 500));
      await runCommandAfter(
        session,
        "/evidence",
        "No evidence in the current run.",
      );
      assert.doesNotMatch(session.output(), /codepunk · auto\/auto/u);
      assert.doesNotMatch(session.output(), /approvals ask · autonomy ask/u);
      assert.doesNotMatch(session.output(), /project [0-9a-f]{16}/u);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty approval selector allows and denies shell commands", async () => {
  await withTempDirectory("codepunk-tui-approval-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");

      const dateMark = session.output().length;
      session.child.stdin.write("!date +%A\r");
      const dateRecord = await waitFor(
        async () =>
          (await readEvidence(home)).find(
            (record) =>
              record.command === "date +%A" && record.decision === "allow",
          ) ?? null,
        "read-only date evidence",
      );
      assert.equal(dateRecord.exit_code, 0);
      assert.doesNotMatch(
        session.output().slice(dateMark),
        /Approval required/u,
      );
      await waitForBashResult(home, "date +%A");
      await new Promise((resolve) => setTimeout(resolve, 300));

      const allowMark = session.output().length;
      session.child.stdin.write("!touch approved.txt\r");
      await waitForOutputAfter(
        session,
        allowMark,
        "Approval required",
        "allow approval prompt",
      );
      await waitForOutputAfter(
        session,
        allowMark,
        "why:",
        "approval policy reason",
      );
      assert.match(
        session.output().slice(allowMark),
        /command: touch approved\.txt/u,
      );
      assert.match(session.output().slice(allowMark), /why: .+/u);
      assert.match(
        session.output().slice(allowMark),
        /coverage: (?:enforced: srt|uncovered: no srt sandbox)/u,
      );
      assert.match(
        session.output().slice(allowMark),
        /Allow this exact command for the session/u,
      );
      assert.match(
        session.output().slice(allowMark),
        /Always allow this exact command/u,
      );
      session.child.stdin.write("\r");
      await waitFor(
        () =>
          fs
            .stat(path.join(project, "approved.txt"))
            .then(() => true)
            .catch(() => null),
        "approved command execution",
      );
      const allowed = await waitFor(
        async () =>
          (await readEvidence(home)).find(
            (record) =>
              record.command === "touch approved.txt" &&
              record.decision === "allow",
          ) ?? null,
        "allowed command evidence",
      );
      assert.equal(allowed.exit_code, 0);
      assert.equal(allowed.rule, "policy.default");
      assert.equal(allowed.approval.channel, "tui");
      assert.equal(allowed.approval.scope, "once");
      assert.equal(allowed.approval.tool_call_id, allowed.tool_call_id);
      assert.equal(allowed.approval.worker_id, "local");
      assert.equal(allowed.approval.session_id, allowed.session_id);
      assert.match(allowed.approval.request_id, /^[0-9a-f-]{36}$/u);
      assert.match(allowed.approval.nonce_sha256, /^sha256:[0-9a-f]{64}$/u);
      assert.ok(allowed.approval.ttl_ms > 0);
      await waitForBashResult(home, "touch approved.txt");

      await submitUserBashWhenIdle(
        session,
        "!touch denied.txt",
        "deny approval prompt",
      );
      session.child.stdin.write("\u001b[B\u001b[B\u001b[B\r");
      const denied = await waitFor(
        async () =>
          (await readEvidence(home)).find(
            (record) =>
              record.command === "touch denied.txt" &&
              record.decision === "deny",
          ) ?? null,
        "denied command evidence",
      );
      assert.equal(denied.rule, "approval.denied");
      assert.equal(denied.approval.answer, "deny");
      assert.equal(denied.approval.scope, "once");
      assert.equal(
        await fs.stat(path.join(project, "denied.txt")).catch(() => null),
        null,
      );

      await submitUserBashWhenIdle(
        session,
        "!!touch excluded.txt",
        "excluded shell approval prompt",
      );
      session.child.stdin.write("\r");
      await waitFor(
        () =>
          fs
            .stat(path.join(project, "excluded.txt"))
            .then(() => true)
            .catch(() => null),
        "excluded command execution",
      );
      const excluded = await waitFor(
        async () =>
          (await readEvidence(home)).find(
            (record) =>
              record.command === "touch excluded.txt" &&
              record.decision === "allow",
          ) ?? null,
        "excluded command evidence",
      );
      assert.equal(excluded.exit_code, 0);
      await waitForBashResult(home, "touch excluded.txt");

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty persists an exact approval rule for later sessions", async () => {
  await withTempDirectory("codepunk-tui-persist-approval-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const cli = await ensureBuilt();
    const env = {
      ...process.env,
      CODEPUNK_HOME: home,
      TERM: "xterm-256color",
      NO_COLOR: "1",
    };
    const first = startPty(process.execPath, [cli], { cwd: project, env });
    try {
      await waitForOutput(first, "codepunk · auto/auto", "startup");
      const mark = first.output().length;
      first.child.stdin.write("!touch persisted-exact.txt\r");
      await waitForOutputAfter(
        first,
        mark,
        "Always allow this exact command",
        "persistent approval option",
      );
      first.child.stdin.write("\u001b[B\u001b[B\r");
      await waitForOutputAfter(
        first,
        mark,
        "Persistent rule preview",
        "persistent approval confirmation",
      );
      const persistentPreview = first.output().slice(mark);
      assert.match(
        persistentPreview,
        /exact argv: \["touch","persisted-exact\.txt"\]/u,
      );
      assert.match(persistentPreview, /cwd: \S+/u);
      assert.match(persistentPreview, /storage: user scoped-rule file/u);
      assert.match(
        persistentPreview,
        /next session: autonomy switches to scoped/u,
      );
      first.child.stdin.write("\r");
      const allowed = await waitFor(
        async () =>
          (await readEvidence(home)).find(
            (record) =>
              record.command === "touch persisted-exact.txt" &&
              record.decision === "allow" &&
              record.approval?.scope === "persistent",
          ) ?? null,
        "persistent approval evidence",
      );
      assert.match(allowed.rule, /^policy\.default$/u);

      await submitUserBashWhenIdle(
        first,
        "!touch cancelled-rule.txt",
        "cancelled persistent approval",
      );
      const cancelMark = first.output().length;
      first.child.stdin.write("\u001b[B\u001b[B\r");
      await waitForOutputAfter(
        first,
        cancelMark,
        "Persistent rule preview",
        "cancelled persistent approval confirmation",
      );
      first.child.stdin.write("\u001b");
      await waitFor(
        async () =>
          (await readEvidence(home)).find(
            (record) =>
              record.command === "touch cancelled-rule.txt" &&
              record.decision === "deny",
          ) ?? null,
        "cancelled persistent approval evidence",
      );
      assert.equal(
        await fs
          .stat(path.join(project, "cancelled-rule.txt"))
          .catch(() => null),
        null,
      );

      const configPath = path.join(home, "config.toml");
      const config = await waitFor(async () => {
        try {
          const text = await fs.readFile(configPath, "utf8");
          return /profile = "scoped"/u.test(text) ? text : null;
        } catch {
          return null;
        }
      }, "scoped autonomy config");
      const rulesPath = /scoped_rules = "(.*)"/u.exec(config)?.[1];
      assert.ok(rulesPath);
      const rules = await fs.readFile(rulesPath, "utf8");
      assert.match(rules, /argv = \["touch", "persisted-exact\.txt"\]/u);
      assert.doesNotMatch(rules, /cancelled-rule/u);
      assert.equal((await fs.stat(rulesPath)).mode & 0o777, 0o600);
      // Forcing "ask" must not silently drop the stored scoped rules.
      const askMark = first.output().length;
      first.child.stdin.write("/permissions autonomy ask\r");
      await waitForOutputAfter(
        first,
        askMark,
        "autonomy set to ask",
        "ask autonomy profile",
      );
      const askConfig = await fs.readFile(configPath, "utf8");
      assert.match(askConfig, /profile = "ask"/u);
      assert.match(askConfig, /scoped_rules = "/u);
      const rulesMark = first.output().length;
      first.child.stdin.write("/permissions rules\r");
      await waitForOutputAfter(
        first,
        rulesMark,
        "Scoped rules: 1 (profile ask)",
        "scoped rules command",
      );
      assert.match(
        first.output().slice(rulesMark),
        /touch persisted-exact\.txt/u,
      );
      const restoreMark = first.output().length;
      first.child.stdin.write("/permissions autonomy scoped\r");
      await waitForOutputAfter(
        first,
        restoreMark,
        "autonomy set to scoped",
        "scoped autonomy profile",
      );
      first.child.stdin.write("/quit\r");
      const exited = await Promise.race([
        first.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(exited, { code: 0, signal: null });
    } finally {
      await stopPty(first);
    }

    await fs.unlink(path.join(project, "persisted-exact.txt"));
    const second = startPty(process.execPath, [cli], { cwd: project, env });
    try {
      await waitForOutput(second, "codepunk · auto/auto", "second startup");
      const mark = second.output().length;
      second.child.stdin.write("!touch persisted-exact.txt\r");
      try {
        await waitFor(
          () =>
            fs
              .stat(path.join(project, "persisted-exact.txt"))
              .then(() => true)
              .catch(() => null),
          "persisted rule execution",
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${second.output().slice(-4000)}`,
        );
      }
      assert.doesNotMatch(second.output().slice(mark), /Approval required/u);
      const reused = await waitFor(
        async () =>
          (await readEvidence(home)).find(
            (record) =>
              record.command === "touch persisted-exact.txt" &&
              record.decision === "allow" &&
              record.approval === null &&
              record.rule.startsWith("scoped.approval-"),
          ) ?? null,
        "persisted rule evidence",
      );
      assert.equal(reused.autonomy.profile, "scoped");
      second.child.stdin.write("/quit\r");
      const exited = await Promise.race([
        second.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(exited, { code: 0, signal: null });
    } finally {
      await stopPty(second);
    }
  });
});

test("the editor disables ! before user_bash when plugins are on", async () => {
  await withTempDirectory("codepunk-tui-plugins-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli, "--allow-plugins"], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await waitForOutput(
        session,
        "Plugins are trusted in-process code",
        "plugin trust warning",
      );
      const mark = session.output().length;
      session.child.stdin.write("!touch blocked.txt\r");
      await waitForOutputAfter(
        session,
        mark,
        "! is disabled while Pi plugins are enabled",
        "plugin shell interception",
      );
      assert.doesNotMatch(session.output().slice(mark), /Approval required/u);
      assert.equal(
        await fs.stat(path.join(project, "blocked.txt")).catch(() => null),
        null,
      );
      const configBefore = await fs.readFile(
        path.join(home, "config.toml"),
        "utf8",
      );
      await runCommandAfter(
        session,
        "/permissions autonomy read-only",
        "cannot switch to read-only while user plugins",
      );
      assert.equal(
        await fs.readFile(path.join(home, "config.toml"), "utf8"),
        configBefore,
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("read-only live switch refuses an already-writable srt profile", async () => {
  await withTempDirectory("codepunk-tui-readonly-srt-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          test: {
            name: "Test",
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "fake",
                name: "Fake model",
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const environment = {
      ...process.env,
      CODEPUNK_HOME: home,
      TERM: "xterm-256color",
      NO_COLOR: "1",
    };
    await execFileAsync(process.execPath, [cli, "models", "set", "test/fake"], {
      cwd: project,
      env: environment,
    });
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: environment,
    });
    try {
      await waitForOutput(session, "shell srt", "writable srt startup");
      const configBefore = await fs.readFile(
        path.join(home, "config.toml"),
        "utf8",
      );
      await runCommandAfter(
        session,
        "/permissions autonomy read-only",
        "cannot switch to read-only while srt workspace write grants",
      );
      assert.equal(
        await fs.readFile(path.join(home, "config.toml"), "utf8"),
        configBefore,
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("read-only live switch refuses widening a read-only srt profile", async () => {
  await withTempDirectory("codepunk-tui-readonly-widen-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          test: {
            name: "Test",
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "fake",
                name: "Fake model",
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const environment = {
      ...process.env,
      CODEPUNK_HOME: home,
      TERM: "xterm-256color",
      NO_COLOR: "1",
    };
    await execFileAsync(process.execPath, [cli, "models", "set", "test/fake"], {
      cwd: project,
      env: environment,
    });
    const session = startPty(
      process.execPath,
      [cli, "--permission-mode", "read-only"],
      {
        cwd: project,
        env: environment,
      },
    );
    try {
      await waitForOutput(session, "shell srt", "read-only srt startup");
      const configBefore = await fs.readFile(
        path.join(home, "config.toml"),
        "utf8",
      );
      await runCommandAfter(
        session,
        "/permissions autonomy ask",
        "cannot switch from read-only to ask while the srt sandbox was started read-only",
      );
      assert.equal(
        await fs.readFile(path.join(home, "config.toml"), "utf8"),
        configBefore,
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty selects and persists a configured model", async () => {
  await withTempDirectory("codepunk-tui-model-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          test: {
            name: "Test",
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "fake",
                name: "Fake model",
                reasoning: true,
                contextWindow: 128000,
                maxTokens: 1024,
              },
              {
                id: "other",
                name: "Other Choice",
                reasoning: true,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "No default model configured.", "startup");
      await runCommandAfter(
        session,
        "/model test/fake",
        "model set to test/fake",
      );
      const partialMark = session.output().length;
      session.child.stdin.write("/model oth\r");
      await waitForOutputAfter(
        session,
        partialMark,
        "Other Choice",
        "Pi fuzzy model search",
      );
      assert.doesNotMatch(
        session.output().slice(partialMark),
        /usage: \/model/u,
      );
      assert.doesNotMatch(session.output().slice(partialMark), /Fake model/u);
      session.child.stdin.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 200));
      const searchMark = session.output().length;
      session.child.stdin.write("/model\r");
      await waitForOutputAfter(
        session,
        searchMark,
        "Other Choice",
        "Pi model selector",
      );
      session.child.stdin.write("other\r");
      await waitForOutputAfter(
        session,
        searchMark,
        "codepunk · test/other",
        "Pi model selection",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const sessionOnly = await fs.readFile(
        path.join(home, "config.toml"),
        "utf8",
      );
      assert.match(sessionOnly, /id = "fake"/u);
      await runCommandAfter(
        session,
        "/model test/other",
        "model set to test/other",
      );
      const config = await waitFor(async () => {
        try {
          const text = await fs.readFile(
            path.join(home, "config.toml"),
            "utf8",
          );
          return /id = "other"/u.test(text) ? text : null;
        } catch {
          return null;
        }
      }, "model config persistence");
      assert.match(config, /\[model\]/u);
      assert.match(config, /provider = "test"/u);
      assert.match(config, /id = "other"/u);
      assert.doesNotMatch(session.output(), /Pi-only command intercepted/u);

      const saveMark = session.output().length;
      session.child.stdin.write("/model\r");
      await waitForOutputAfter(
        session,
        saveMark,
        "Other Choice",
        "Pi model selector for default save",
      );
      session.child.stdin.write("fake");
      await waitForOutputAfter(
        session,
        saveMark,
        "Fake model",
        "Pi model filter for default save",
      );
      session.child.stdin.write("\u0013");
      await waitForOutputAfter(
        session,
        saveMark,
        "Default model: test/fake",
        "Pi default model save",
      );
      const savedDefault = await waitFor(async () => {
        try {
          const text = await fs.readFile(
            path.join(home, "config.toml"),
            "utf8",
          );
          return /id = "fake"/u.test(text) ? text : null;
        } catch {
          return null;
        }
      }, "saved default model");
      assert.match(savedDefault, /provider = "test"/u);

      const thinkingMark = session.output().length;
      session.child.stdin.write("/thinking high\r");
      await waitForOutputAfter(
        session,
        thinkingMark,
        "Thinking level: high",
        "Pi thinking selection",
      );
      const thinkingConfig = await waitFor(async () => {
        try {
          const text = await fs.readFile(
            path.join(home, "config.toml"),
            "utf8",
          );
          return /thinking = "high"/u.test(text) ? text : null;
        } catch {
          return null;
        }
      }, "thinking config persistence");
      assert.match(thinkingConfig, /provider = "test"/u);
      assert.match(thinkingConfig, /id = "fake"/u);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty scopes the model picker to physical fallback members", async () => {
  await withTempDirectory("codepunk-tui-fallback-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[model]",
        'provider = "test"',
        'id = "fake"',
        'fallback = ["test/other"]',
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          test: {
            name: "Test",
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "fake",
                name: "Fake model",
                reasoning: true,
                contextWindow: 128000,
                maxTokens: 1024,
              },
              {
                id: "other",
                name: "Other Choice",
                reasoning: true,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto -> test/fake", "startup");
      const mark = session.output().length;
      session.child.stdin.write("/model\r");
      await waitForOutputAfter(
        session,
        mark,
        "Other Choice",
        "physical fallback member",
      );
      const picker = session
        .output()
        .slice(mark)
        .replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, "");
      assert.match(picker, /Scope:\s*all\s*\|\s*scoped/u);
      assert.doesNotMatch(picker, /codepunk\/auto/u);
      session.child.stdin.write("\u001b[B");
      session.child.stdin.write("\u0013");
      await waitForOutputAfter(
        session,
        mark,
        "Default model: test/other",
        "fallback default persistence",
      );
      const config = await waitFor(async () => {
        const value = await fs.readFile(path.join(home, "config.toml"), "utf8");
        return value.includes('id = "other"') ? value : false;
      }, "fallback default config persistence");
      assert.match(config, /provider = "test"/u);
      assert.match(config, /id = "other"/u);
      assert.doesNotMatch(config, /id = "auto"/u);
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty persists a Pi default even when the picker keeps the current model", async () => {
  await withTempDirectory("codepunk-tui-default-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          test: {
            name: "Test",
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "fake",
                name: "Fake model",
                reasoning: true,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · test/fake", "startup");
      const mark = session.output().length;
      session.child.stdin.write("/model\r");
      await waitForOutputAfter(
        session,
        mark,
        "Fake model",
        "default model picker",
      );
      session.child.stdin.write("\u0013");
      await waitForOutputAfter(
        session,
        mark,
        "Default model: test/fake",
        "Pi default model status",
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
      const config = await fs.readFile(path.join(home, "config.toml"), "utf8");
      assert.match(config, /provider = "test"/u);
      assert.match(config, /id = "fake"/u);
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty shows and persists permission modes", async () => {
  await withTempDirectory("codepunk-tui-permissions-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--allow-unsandboxed-shell"],
      {
        cwd: project,
        env: {
          ...process.env,
          CODEPUNK_HOME: home,
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const summaryMark = session.output().length;
      await runCommandAfter(session, "/permissions", "profile: custom");
      assert.match(session.output().slice(summaryMark), /approvals: ask/u);
      assert.match(
        session.output().slice(summaryMark),
        /current shell: explicit-unsandboxed/u,
      );
      await runCommandAfter(
        session,
        "/permissions reviewer",
        "scope: network commands and headless argv exec",
      );
      await runCommandAfter(
        session,
        "/permissions reviewer model gateway/reviewer",
        "reviewer: model",
      );
      await runCommandAfter(
        session,
        "/permissions reviewer timeout 5000",
        "reviewer timeout: 5000 ms",
      );
      await runCommandAfter(
        session,
        "/permissions reviewer off",
        "reviewer: off",
      );
      const whyMark = session.output().length;
      await runCommandAfter(
        session,
        "/permissions why date +%A",
        "rule: shell.read.date",
      );
      assert.match(session.output().slice(whyMark), /requires approval: no/u);
      assert.match(session.output().slice(whyMark), /execution: available/u);
      const dashedWhyMark = session.output().length;
      await runCommandAfter(
        session,
        "/permissions why -- touch probe.txt",
        "decision: ask",
      );
      assert.match(
        session.output().slice(dashedWhyMark),
        /rule: policy\.default/u,
      );
      await runCommandAfter(
        session,
        "/permission approval deny",
        "approvals set to deny",
      );
      const deniedMark = session.output().length;
      session.child.stdin.write("!touch denied-by-permission.txt\r");
      await waitForOutputAfter(
        session,
        deniedMark,
        "denied: approval.denied",
        "live approval mode",
      );
      assert.equal(
        await fs
          .stat(path.join(project, "denied-by-permission.txt"))
          .catch(() => null),
        null,
      );
      await runCommandAfter(
        session,
        "/permissions autonomy read-only",
        "autonomy set to read-only",
      );
      await runCommandAfter(
        session,
        "/permissions sandbox required",
        "sandbox set to required for the next session",
      );
      const config = await fs.readFile(path.join(home, "config.toml"), "utf8");
      assert.match(config, /mode = "deny"/u);
      assert.match(config, /profile = "read-only"/u);
      assert.match(config, /mode = "required"/u);
      await runCommandAfter(
        session,
        "/permissions autonomy ask",
        "autonomy set to ask",
      );
      await runCommandAfter(
        session,
        "/permissions profile full-access",
        "full-access cannot be enabled from a running session",
      );
      await runCommandAfter(
        session,
        "/permissions profile read-only",
        "permission profile set to read-only",
      );
      const profiled = await fs.readFile(
        path.join(home, "config.toml"),
        "utf8",
      );
      assert.match(profiled, /mode = "ask"/u);
      assert.match(profiled, /profile = "read-only"/u);
      assert.match(profiled, /mode = "required"/u);
      await runCommandAfter(session, "/permissions", "profile: read-only");
      assert.match(
        session.output().slice(session.output().lastIndexOf("Permissions")),
        /autonomy: read-only/u,
      );
      assert.match(
        session.output().slice(session.output().lastIndexOf("Permissions")),
        /current shell: explicit-unsandboxed/u,
      );
      assert.match(
        session.output().slice(session.output().lastIndexOf("Permissions")),
        /next session sandbox: required/u,
      );
      assert.match(
        session.output(),
        /permissions read-only · trust trusted · shell explicit-unsandboxed · next sandbox required/u,
      );
      await runCommandAfter(
        session,
        "/permissions sandbox uncovered",
        "sandbox set to uncovered for the next session",
      );
      assert.match(
        session.output(),
        /no shell unless started with --allow-unsandboxed-shell/u,
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("product commands and intercepted Pi builtins render through a real pty", async () => {
  await withTempDirectory("codepunk-tui-commands-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await runCommandAfter(session, "/cp-sessions", "events  (untitled)");
      await runCommandAfter(
        session,
        "/evidence",
        "No evidence in the current run.",
      );
      await runCommandAfter(session, "/doctor", "codepunk doctor (");
      await runCommandAfter(session, "/policy", "approval: ask");
      await runCommandAfter(
        session,
        "/cp-export",
        "Exported redacted transcript:",
      );
      await runCommandAfter(session, "/mcp", "MCP servers (user scope)");
      await runCommandAfter(session, "/skills", "Skills (0)");
      await runCommandAfter(session, "/plugins", "Plugins (disabled, 0 files)");
      await runCommandAfter(
        session,
        "/sign",
        "the current run has no durable run/end",
      );
      await runCommandAfter(session, "/session", "session: ");
      assert.match(session.output(), /model: unknown\/unknown/u);
      assert.match(session.output(), /evidence: 0 record/u);
      await runCommandAfter(session, "/resume", "Already in session ");
      assert.match(session.output(), /events  \(untitled\)/u);
      await runCommandAfter(
        session,
        "/export",
        "Exported redacted transcript:",
      );
      await runCommandAfter(session, "/new", "Start a new codepunk session?");
      session.child.stdin.write("\u001b");
      await waitForQuiet(session, 250);
      await runCommandAfter(
        session,
        "/import probe.jsonl",
        "Codepunk sessions keep their own evidence chain; use /cp-sessions or `codepunk --session <id>`.",
      );
      assert.doesNotMatch(session.output(), /codepunk --resume/u);
      await runCommandAfter(session, "/compact", "Compaction");
      await runCommandAfter(session, "/remember probe fact", "remembered mem_");
      await runCommandAfter(
        session,
        "/memory search probe",
        "[project] probe fact",
      );
      await runCommandAfter(
        session,
        "/remember list marker",
        "remembered mem_",
      );
      await runCommandAfter(session, "/memory list", "list marker");
      await runCommandAfter(
        session,
        "/remember archive marker",
        "remembered mem_",
      );
      const archiveCandidates = [
        ...session.output().matchAll(/remembered (mem_[a-z0-9]+)/gu),
      ];
      const archiveId = archiveCandidates.at(-1)?.[1];
      assert.ok(archiveId);
      await runCommandAfter(
        session,
        `/memory archive ${archiveId}`,
        `archived ${archiveId}`,
      );
      await runCommandAfter(
        session,
        "/memory search archive marker",
        "No memory records matched.",
      );
      await runCommandAfter(
        session,
        "/remember user preference --scope user",
        "remembered mem_",
      );
      await runCommandAfter(
        session,
        "/memory search user preference",
        "[user] user preference",
      );
      const remembered = [
        ...session.output().matchAll(/remembered (mem_[a-z0-9]+)/gu),
      ];
      const memoryId = remembered.at(-1)?.[1];
      assert.ok(memoryId);
      await runCommandAfter(
        session,
        `/memory delete ${memoryId}`,
        `deleted ${memoryId}`,
      );
      await runCommandAfter(
        session,
        "/memory search user preference",
        "No memory records matched.",
      );
      await runCommandAfter(session, "/permissions", "approvals: ask");
      await runCommandAfter(session, "/model", "No authenticated models.");
      assert.match(session.output(), /Add a provider first:/u);
      assert.match(session.output(), /Then run \/model to choose a model\./u);
      await runCommandAfter(
        session,
        "/model test/fake",
        "No authenticated models.",
      );
      await runCommandAfter(
        session,
        "/settings",
        "codepunk settings are file-backed",
      );
      await runCommandAfter(
        session,
        "/scoped-models",
        "Model scope is file-backed in codepunk.",
      );
      await runCommandAfter(session, "/trust", "project resources: none");
      await runCommandAfter(
        session,
        "/trust grant",
        "workspace trust saved as trusted",
      );
      await runCommandAfter(
        session,
        "/trust status",
        "saved decision: trusted",
      );
      await runCommandAfter(
        session,
        "/import session.jsonl",
        "Pi session import is not supported",
      );
      await runCommandAfter(session, "/share", "Use /cp-export");
      await runCommandAfter(
        session,
        "/bug a synthetic report hint",
        "Pi's /bug flow can upload a session transcript",
      );
      await runCommandAfter(
        session,
        "/reload",
        "Reloaded Pi resources and MCP configuration.",
      );
      await runCommandAfter(
        session,
        "/skills",
        "run /reload after changing skills",
      );
      await runCommandAfter(
        session,
        "/mcp",
        "run /reload after changing MCP configuration",
      );
      await runCommandAfter(session, "/fork", "forked ");
      await runCommandAfter(session, "/tree", "Session tree");
      await runCommandAfter(
        session,
        "/definitely-not-a-command",
        "Unknown command /definitely-not-a-command.",
      );
      assert.match(
        session.output(),
        /Type \/help for the available Codepunk and Pi commands\./u,
      );
      await runCommandAfter(
        session,
        "/help",
        "Pi commands that would bypass the Codepunk session",
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
      assert.match(session.output(), /exported|Exported/u);
    } finally {
      await stopPty(session);
    }
  });
});

test("/login and /logout reach the Pi host instead of being intercepted", async () => {
  await withTempDirectory("codepunk-tui-auth-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");

      const loginMark = session.output().length;
      session.child.stdin.write("/login\r");
      await waitForOutputAfter(
        session,
        loginMark,
        "Select authentication method:",
        "/login",
      );
      assert.doesNotMatch(
        session.output().slice(loginMark),
        /Pi-only command intercepted/u,
      );
      session.child.stdin.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 250));

      const logoutMark = session.output().length;
      session.child.stdin.write("/logout\r");
      await waitForOutputAfter(
        session,
        logoutMark,
        "No stored credentials to remove.",
        "/logout",
      );
      assert.doesNotMatch(
        session.output().slice(logoutMark),
        /Pi-only command intercepted/u,
      );

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty resumes another session without restarting the CLI", async () => {
  await withTempDirectory("codepunk-tui-resume-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const model = await startTextModelServer();
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "chat",
                name: "Chat",
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    try {
      const cli = await ensureBuilt();
      const env = {
        ...process.env,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      };
      const first = startPty(process.execPath, [cli], { cwd: project, env });
      let firstId;
      try {
        await waitForOutput(first, "codepunk · local/chat", "first startup");
        first.child.stdin.write("first question\r");
        await waitForOutput(first, "CHILD_OK", "first model reply");
        await runCommandAfter(first, "/session", "session: ");
        const ids = [...first.output().matchAll(/session: ([0-9A-Z]{10,})/gu)];
        firstId = ids.at(-1)?.[1];
        assert.ok(firstId);
        first.child.stdin.write("/quit\r");
        const exited = await Promise.race([
          first.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(exited, { code: 0, signal: null });
      } finally {
        await stopPty(first);
      }

      const second = startPty(process.execPath, [cli, "--new-session"], {
        cwd: project,
        env,
      });
      try {
        await waitForOutput(second, "codepunk · local/chat", "second startup");
        second.child.stdin.write("second question\r");
        await waitForOutput(second, "CHILD_OK", "second model reply");
        await runCommandAfter(second, "/session", "session: ");
        const ids = [...second.output().matchAll(/session: ([0-9A-Z]{10,})/gu)];
        const secondId = ids.at(-1)?.[1];
        assert.ok(secondId);
        assert.notEqual(secondId, firstId);

        await runCommandAfter(
          second,
          `/resume ${firstId}`,
          `resumed session ${firstId}`,
        );
        await runCommandAfter(second, "/session", `session: ${firstId}`);
        second.child.stdin.write("after resume\r");
        await waitForOutput(second, "CHILD_OK", "model reply after resume");
        second.child.stdin.write("/quit\r");
        const exited = await Promise.race([
          second.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(exited, { code: 0, signal: null });
      } finally {
        await stopPty(second);
      }
    } finally {
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test("a real pty starts a new session in place", async () => {
  await withTempDirectory("codepunk-tui-new-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...process.env,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await runCommandAfter(session, "/session", "session: ");
      const firstMatches = [
        ...session.output().matchAll(/session: ([0-9A-Z]{10,})/gu),
      ];
      const firstId = firstMatches.at(-1)?.[1];
      assert.ok(firstId);
      await runCommandAfter(session, "/new", "Start a new codepunk session?");
      session.child.stdin.write("\r");
      await waitForOutput(session, "started session ", "new session");
      await runCommandAfter(session, "/session", "session: ");
      const secondMatches = [
        ...session.output().matchAll(/session: ([0-9A-Z]{10,})/gu),
      ];
      const secondId = secondMatches.at(-1)?.[1];
      assert.ok(secondId);
      assert.notEqual(secondId, firstId);
      session.child.stdin.write("/quit\r");
      const exited = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(exited, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty navigates the session tree and forks into a child session", async () => {
  await withTempDirectory("codepunk-tui-fork-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const model = await startTextModelServer();
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "chat",
                name: "Chat",
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    try {
      const cli = await ensureBuilt();
      const session = startPty(process.execPath, [cli], {
        cwd: project,
        env: {
          ...process.env,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      });
      try {
        await waitForOutput(session, "codepunk · local/chat", "startup");
        session.child.stdin.write("first branch prompt\r");
        await waitForOutput(session, "CHILD_OK", "first reply");
        session.child.stdin.write("second branch prompt\r");
        await waitForOutput(session, "CHILD_OK", "second reply");
        await runCommandAfter(session, "/session", "session: ");
        const idMatches = [
          ...session.output().matchAll(/session: ([0-9A-Z]{10,})/gu),
        ];
        const parentId = idMatches.at(-1)?.[1];
        assert.ok(parentId);
        const files = await fs.readdir(home, { recursive: true });
        const stateEntry = files.find((entry) =>
          entry.endsWith(path.join("sessions", parentId, "agent-state.json")),
        );
        assert.ok(stateEntry);
        const statePath = path.join(home, stateEntry);
        const parentState = JSON.parse(await fs.readFile(statePath, "utf8"));
        const firstEntry = parentState.branch.find(
          (entry) => entry.type === "message" && entry.message?.role === "user",
        );
        assert.ok(firstEntry);

        await runCommandAfter(session, "/tree", "Session tree");
        await runCommandAfter(
          session,
          `/tree ${firstEntry.id}`,
          `moved to ${firstEntry.id}`,
        );
        const sessionLog = files.find((entry) =>
          entry.endsWith(path.join("sessions", parentId, "session.jsonl")),
        );
        assert.ok(sessionLog);
        const logRecords = (
          await fs.readFile(path.join(home, sessionLog), "utf8")
        )
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line));
        assert.ok(
          logRecords.some(
            (record) =>
              record.kind === "session/tree" &&
              record.data?.to_entry_id === firstEntry.id,
          ),
        );

        session.child.stdin.write("third branch prompt\r");
        await waitForOutput(session, "CHILD_OK", "reply after tree move");
        await runCommandAfter(session, "/fork", "forked ");
        await runCommandAfter(session, "/session", "session: ");
        const childMatches = [
          ...session.output().matchAll(/session: ([0-9A-Z]{10,})/gu),
        ];
        const childId = childMatches.at(-1)?.[1];
        assert.ok(childId);
        assert.notEqual(childId, parentId);
        const childFiles = await fs.readdir(home, { recursive: true });
        const childStateEntry = childFiles.find((entry) =>
          entry.endsWith(path.join("sessions", childId, "agent-state.json")),
        );
        assert.ok(childStateEntry);
        const childState = JSON.parse(
          await fs.readFile(path.join(home, childStateEntry), "utf8"),
        );
        assert.equal(childState.header.id, childId);
        const childLogEntry = childFiles.find((entry) =>
          entry.endsWith(path.join("sessions", childId, "session.jsonl")),
        );
        assert.ok(childLogEntry);
        const childLog = (
          await fs.readFile(path.join(home, childLogEntry), "utf8")
        )
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line));
        assert.equal(childLog[0].type, "codepunk/session");
        assert.equal(childLog[0].parent_session_id, parentId);
        const forkedEvent = childLog.find(
          (record) => record.kind === "session/forked",
        );
        assert.ok(forkedEvent);
        assert.equal(forkedEvent.data.parent_session_id, parentId);
        assert.equal(forkedEvent.data.mode, "live");

        session.child.stdin.write("/quit\r");
        const exited = await Promise.race([
          session.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(exited, { code: 0, signal: null });
      } finally {
        await stopPty(session);
      }
    } finally {
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test("a real pty queues input as steering while the model is streaming", async () => {
  await withTempDirectory("codepunk-tui-steer-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const model = await startHeldModelServer();
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "chat",
                name: "Chat",
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    try {
      const cli = await ensureBuilt();
      const session = startPty(process.execPath, [cli], {
        cwd: project,
        env: {
          ...process.env,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      });
      try {
        await waitForOutput(session, "codepunk · local/chat", "startup");
        session.child.stdin.write("first question\r");
        await waitFor(
          () => (model.requests.length === 1 ? true : null),
          "first model request",
        );
        session.child.stdin.write("steer now\r");
        await waitForOutput(
          session,
          "Steering: steer now",
          "queued steering message",
        );
        assert.equal(model.requests.length, 1);
        model.releaseFirst();
        await waitForOutput(session, "FIRST_DONE", "first model reply");
        await waitForOutput(session, "STEER_DONE", "steered model reply");
        const files = await fs.readdir(home, { recursive: true });
        const logEntry = files.find((entry) => entry.endsWith("session.jsonl"));
        assert.ok(logEntry);
        const inputs = (await fs.readFile(path.join(home, logEntry), "utf8"))
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line))
          .filter((record) => record.kind === "user/input")
          .map((record) => record.data.text);
        assert.ok(inputs.includes("first question"));
        assert.ok(inputs.includes("steer now"));
        session.child.stdin.write("/quit\r");
        const exited = await Promise.race([
          session.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(exited, { code: 0, signal: null });
      } finally {
        await stopPty(session);
      }
    } finally {
      model.server.closeAllConnections?.();
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test("a real pty runs /subagent as a read-only child session", async () => {
  await withTempDirectory("codepunk-tui-subagent-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await fs.mkdir(path.join(home, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(home, "agents", "reviewer.md"),
      [
        "---",
        "name: reviewer",
        "description: Review a bounded change set",
        "tools: read, search",
        "---",
        "Review the requested change.",
        "",
      ].join("\n"),
    );
    await fs.writeFile(path.join(project, "hello.txt"), "hello\n");
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.email=child@example.test",
        "-c",
        "user.name=Child Test",
        "add",
        "hello.txt",
      ],
      { cwd: project },
    );
    await execFileAsync(
      "git",
      [
        "-c",
        "user.email=child@example.test",
        "-c",
        "user.name=Child Test",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: project },
    );
    const modelServer = await startTextModelServer();
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ local: { type: "api_key", key: "sk-child-test" } }),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: modelServer.baseUrl,
            apiKey: "sk-child-test",
            api: "openai-completions",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 4_000,
                maxTokens: 1_000,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...process.env,
          CODEPUNK_HOME: home,
          TERM: "xterm-256color",
          NO_COLOR: "1",
          PI_OFFLINE: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      await runCommandAfter(session, "/agents profiles", "reviewer (user)");
      const mark = session.output().length;
      session.child.stdin.write(
        "/subagent --profile reviewer reply with exactly CHILD_OK\r",
      );
      await waitForOutputAfter(
        session,
        mark,
        "subagent started:",
        "/subagent start",
      );
      await waitForOutputAfter(
        session,
        mark,
        "profile: reviewer (user)",
        "/subagent profile",
      );
      const childSessionId = session
        .output()
        .slice(mark)
        .match(/subagent started: ([A-Za-z0-9_-]+)/u)?.[1];
      assert.ok(childSessionId);
      await waitForOutputAfter(
        session,
        mark,
        `completed; use /agents result ${childSessionId}`,
        "/subagent completion",
      );
      assert.match(session.output().slice(mark), /CHILD_OK/u);
      await runCommandAfter(
        session,
        `/agents result ${childSessionId}`,
        "CHILD_OK",
      );
      await runCommandAfter(session, "/agents", "completed");
      await runCommandAfter(
        session,
        `/agents stop ${childSessionId}`,
        `subagent ${childSessionId} is already completed`,
      );
      assert.doesNotMatch(session.output().slice(mark), /failed:/u);
      assert.doesNotMatch(session.output().slice(mark), /parent waits/u);

      const logs = [];
      for (const entry of await fs.readdir(home, { recursive: true })) {
        if (!entry.endsWith("session.jsonl")) {
          continue;
        }
        const lines = (await fs.readFile(path.join(home, entry), "utf8"))
          .split("\n")
          .filter((line) => line.length > 0);
        for (const line of lines.slice(1)) {
          logs.push({ entry, event: JSON.parse(line) });
        }
      }
      const linked = logs.find(({ event }) => event.kind === "subagent/result");
      assert.ok(linked);
      assert.equal(linked.event.data.status, "completed");
      assert.equal(linked.event.data.depth, 1);
      assert.equal(linked.event.data.isolation, "shared");
      assert.equal(linked.event.data.model, "local/local-test");
      assert.equal(linked.event.data.profile, "reviewer");
      assert.match(linked.event.data.profile_sha256, /^sha256:[a-f0-9]{64}$/u);
      assert.equal(linked.event.data.summary, "CHILD_OK");
      assert.equal(linked.event.data.evidence_head, null);
      assert.equal(linked.event.data.worktree, null);
      assert.equal(linked.event.data.changed_files, 0);
      assert.ok(
        logs.some(({ entry }) =>
          entry.endsWith(
            path.join(linked.event.data.child_session_id, "session.jsonl"),
          ),
        ),
      );

      const capabilitiesMark = session.output().length;
      session.child.stdin.write("/capabilities\r");
      await waitForOutputAfter(
        session,
        capabilitiesMark,
        "codepunk capabilities",
        "/capabilities",
      );
      await waitForOutputAfter(
        session,
        capabilitiesMark,
        "Skills (0)",
        "/capabilities skills",
      );

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});
