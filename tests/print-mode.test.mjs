import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { ensureBuilt, withTempDirectory } from "./support/helpers.mjs";

async function startModelServer() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      try {
        requests.push(JSON.parse(raw));
      } catch {
        requests.push({ invalid_body: raw });
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const send = (value) => {
        response.write(`data: ${JSON.stringify(value)}\n\n`);
      };
      send({
        id: "local-response",
        object: "chat.completion.chunk",
        created: 1,
        model: "local-test",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      });
      send({
        id: "local-response",
        object: "chat.completion.chunk",
        created: 1,
        model: "local-test",
        choices: [
          {
            index: 0,
            delta: { content: "hello from local" },
            finish_reason: null,
          },
        ],
      });
      send({
        id: "local-response",
        object: "chat.completion.chunk",
        created: 1,
        model: "local-test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 4,
          total_tokens: 7,
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

async function runCli(args, { cwd, home, timeoutMs }) {
  const cli = await ensureBuilt();
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: {
      ...process.env,
      CODEPUNK_HOME: home,
      NO_COLOR: "1",
      PI_OFFLINE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    ...(timeoutMs === undefined
      ? {}
      : { timeout: timeoutMs, killSignal: "SIGKILL" }),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function readSessionLogs(home) {
  const entries = await fs.readdir(home, { recursive: true });
  const events = [];
  for (const entry of entries) {
    if (!entry.endsWith("session.jsonl")) {
      continue;
    }
    const lines = (await fs.readFile(path.join(home, entry), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    for (const line of lines.slice(1)) {
      events.push(JSON.parse(line));
    }
  }
  return events;
}

async function readSessionMetas(home) {
  const entries = await fs.readdir(home, { recursive: true });
  const metas = [];
  for (const entry of entries) {
    if (!entry.endsWith("session-meta.json")) {
      continue;
    }
    metas.push(JSON.parse(await fs.readFile(path.join(home, entry), "utf8")));
  }
  return metas;
}

test("print and JSON modes run read-only through a local provider", async () => {
  await withTempDirectory("codepunk-print-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({
        "local/team": { type: "api_key", key: "test-key" },
      }),
      { mode: 0o600 },
    );
    await fs.writeFile(path.join(project, "a.txt"), "unchanged\n");
    await fs.writeFile(path.join(project, ".gitignore"), "ignored\n");
    const modelServer = await startModelServer();
    const childProcess = spawn("git", ["init", "-q"], { cwd: project });
    await new Promise((resolve) => childProcess.on("close", resolve));
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          "local/team": {
            baseUrl: modelServer.baseUrl,
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
    try {
      const text = await runCli(
        ["-p", "hello", "--model", "local/team/local-test"],
        {
          cwd: project,
          home,
        },
      );
      assert.equal(text.code, 0, text.stderr);
      assert.match(text.stdout, /hello from local/u);

      const json = await runCli(
        ["--mode", "json", "-p", "hello", "--model", "local/team/local-test"],
        { cwd: project, home },
      );
      assert.equal(json.code, 0, json.stderr);
      const events = json.stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      assert.equal(events[0].type, "session");
      const assistant = events.find(
        (event) =>
          event.type === "message_end" && event.message?.role === "assistant",
      );
      assert.ok(assistant);
      assert.equal(assistant.message.usage.totalTokens, 7);
      assert.match(
        assistant.message.content.map((part) => part.text ?? "").join("\n"),
        /hello from local/u,
      );
      assert.ok(
        events.some(
          (event) => event.type === "agent_settled" && event.aborted === false,
        ),
      );

      const toolRequests = modelServer.requests.filter(
        (request) => Array.isArray(request.tools) && request.tools.length > 0,
      );
      assert.ok(toolRequests.length >= 2);
      assert.equal(
        JSON.stringify(
          toolRequests[0].tools.map((tool) => tool.function?.name ?? tool.name),
        ),
        JSON.stringify([
          "read",
          "search",
          "lsp_query",
          "memory_search",
          "web_fetch",
        ]),
      );
      assert.equal(
        toolRequests.every((request) =>
          request.tools.every(
            (tool) =>
              !["write", "edit", "shell", "bash", "exec"].includes(
                tool.function?.name ?? tool.name,
              ),
          ),
        ),
        true,
      );
      assert.equal(
        await fs.readFile(path.join(project, "a.txt"), "utf8"),
        "unchanged\n",
      );

      const sessionEvents = await readSessionLogs(home);
      const usage = sessionEvents.filter(
        (event) => event.kind === "model/usage",
      );
      // Each print run bills one turn plus its settled-session memory summary.
      assert.equal(usage.length, 4);
      assert.deepEqual(
        usage.map((event) => event.data.total_tokens),
        [7, 7, 7, 7],
      );
      const metas = await readSessionMetas(home);
      assert.equal(metas.length, 2);
      assert.deepEqual(
        metas.map((meta) => meta.title),
        ["hello", "hello"],
      );
    } finally {
      modelServer.server.closeAllConnections?.();
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("print mode rejects a permission profile it cannot honor", async () => {
  await withTempDirectory("codepunk-print-profile-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    for (const profile of ["standard", "auto", "auto-approve"]) {
      const result = await runCli(
        ["--permission-mode", profile, "-p", "hello"],
        { cwd: project, home },
      );
      assert.equal(result.code, 1, profile);
      assert.match(result.stderr, /would not take effect/u, profile);
      assert.match(result.stderr, /--headless-policy/u, profile);
    }
    const readOnly = await runCli(
      ["--permission-mode", "read-only", "-p", "hello"],
      { cwd: project, home },
    );
    assert.doesNotMatch(readOnly.stderr, /would not take effect/u);
  });
});

test("print mode refuses an unresolved workspace trust decision", async () => {
  await withTempDirectory("codepunk-print-trust-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "PROJECT_RULE_SENTINEL\n",
    );
    await new Promise((resolve) => {
      const child = spawn("git", ["init", "-q"], { cwd: project });
      child.on("close", resolve);
    });

    const refused = await runCli(["-p", "hello"], { cwd: project, home });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /workspace trust is unresolved/u);
    assert.match(refused.stderr, /AGENTS\.md/u);
    assert.match(refused.stderr, /--trust \/ --no-trust/u);

    for (const flag of ["--trust", "--no-trust"]) {
      const allowed = await runCli([flag, "-p", "hello"], {
        cwd: project,
        home,
      });
      assert.doesNotMatch(
        allowed.stderr,
        /workspace trust is unresolved/u,
        flag,
      );
    }
  });
});

test("--bare starts without trusting instructions it will not load", async () => {
  await withTempDirectory("codepunk-print-bare-trust-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ local: { type: "api_key", key: "test-key" } }),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "PROJECT_RULE_SENTINEL\n",
    );
    const modelServer = await startModelServer();
    const git = spawn("git", ["init", "-q"], { cwd: project });
    await new Promise((resolve) => git.on("close", resolve));
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: modelServer.baseUrl,
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
    try {
      const result = await runCli(
        ["--bare", "-p", "hello", "--model", "local/local-test"],
        { cwd: project, home },
      );
      assert.equal(result.code, 0);
      assert.match(result.stdout, /hello from local/u);
      assert.doesNotMatch(result.stderr, /workspace trust is unresolved/u);
      assert.doesNotMatch(result.stdout, /PROJECT_RULE_SENTINEL/u);
    } finally {
      modelServer.server.closeAllConnections?.();
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("a project policy cannot authorize writes", async () => {
  await withTempDirectory("codepunk-print-policy-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await fs.mkdir(path.join(project, ".codepunk"), { recursive: true });
    await fs.writeFile(
      path.join(project, ".codepunk", "policy.toml"),
      [
        "version = 1",
        "[rules.write-any]",
        'tool = "write"',
        'decision = "allow"',
        'path = "."',
        "",
      ].join("\n"),
    );
    const childProcess = spawn("git", ["init", "-q"], { cwd: project });
    await new Promise((resolve) => childProcess.on("close", resolve));
    const result = await runCli(["--trust", "-p", "write a file"], {
      cwd: project,
      home,
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /project policy rules cannot grant allow/u);
  });
});

test("--new-session-id writes the session under the explicit id", async () => {
  await withTempDirectory("codepunk-print-session-id-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ local: { type: "api_key", key: "test-key" } }),
      { mode: 0o600 },
    );
    const modelServer = await startModelServer();
    const childProcess = spawn("git", ["init", "-q"], { cwd: project });
    await new Promise((resolve) => childProcess.on("close", resolve));
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: modelServer.baseUrl,
            apiKey: "test-key",
            api: "openai-completions",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                reasoning: true,
                contextWindow: 2_000,
                maxTokens: 200,
              },
            ],
          },
        },
      }),
    );
    try {
      const result = await runCli(
        [
          "-p",
          "hello",
          "--model",
          "local/local-test",
          "--new-session-id",
          "explicit-session",
        ],
        { cwd: project, home },
      );
      assert.equal(result.code, 0, result.stderr);
      const explicitThinking = await runCli(
        [
          "--mode",
          "json",
          "-p",
          "hello",
          "--model",
          "local/local-test:high",
          "--new-session-id",
          "thinking-session",
        ],
        { cwd: project, home },
      );
      assert.equal(explicitThinking.code, 0, explicitThinking.stderr);
      const thinkingLog = (await fs.readdir(home, { recursive: true })).find(
        (entry) =>
          entry.endsWith(path.join("thinking-session", "session.jsonl")),
      );
      assert.ok(thinkingLog);
      assert.equal(
        modelServer.requests.some(
          (request) => request.reasoning_effort === "high",
        ),
        true,
      );
      const sessionLog = (await fs.readdir(home, { recursive: true })).find(
        (entry) =>
          entry.endsWith(path.join("explicit-session", "session.jsonl")),
      );
      assert.ok(sessionLog);
      const header = JSON.parse(
        (await fs.readFile(path.join(home, sessionLog), "utf8")).split("\n")[0],
      );
      assert.equal(header.id, "explicit-session");

      const conflict = await runCli(
        [
          "-p",
          "hello",
          "--model",
          "local/local-test",
          "--continue",
          "--new-session-id",
          "other-session",
        ],
        { cwd: project, home },
      );
      assert.equal(conflict.code, 1);
      assert.match(
        conflict.stderr,
        /newSessionId cannot be combined with --continue/u,
      );
      const otherSession = (await fs.readdir(home, { recursive: true })).find(
        (entry) => entry.endsWith(path.join("other-session", "session.jsonl")),
      );
      assert.equal(otherSession, undefined);
    } finally {
      modelServer.server.closeAllConnections?.();
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("an invalid configured model fails before creating a session", async () => {
  await withTempDirectory("codepunk-print-bad-model-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[model]\nprovider = "fake"\nid = "model"\n',
    );
    const childProcess = spawn("git", ["init", "-q"], { cwd: project });
    await new Promise((resolve) => childProcess.on("close", resolve));
    // This home enables the default sandbox, and on Linux the srt proxy is a
    // long-lived child process. Without an explicit close on the failure path
    // the CLI prints its error and then waits forever instead of exiting, so
    // the timeout turns that regression into a failed assertion rather than a
    // hung suite.
    const result = await runCli(["-p", "hello"], {
      cwd: project,
      home,
      timeoutMs: 30_000,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /selected model fake\/model is not available/u);
    const entries = await fs.readdir(home, { recursive: true });
    assert.equal(
      entries.some((entry) => entry.endsWith("session.jsonl")),
      false,
    );
  });
});
