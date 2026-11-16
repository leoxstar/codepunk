import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import { ensureBuilt, withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();
const PERMISSIVE_PARENT = {
  approval: "ask",
  autonomy: "ask",
  tools: [
    "read",
    "write",
    "edit",
    "shell",
    "search",
    "memory_search",
    "plan",
    "todo",
  ],
};

async function startChildModelServer({
  emitToolCall = true,
  toolCallRounds = 1,
  delayMs = 0,
  readPath = "subagent-input.txt",
  toolName = "read",
  toolArguments = null,
  finalText = "child says hello",
} = {}) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      let timer;
      request.socket.once("close", () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
      response.on("close", () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
      const respond = () => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        const send = (value) => {
          response.write(`data: ${JSON.stringify(value)}\n\n`);
        };
        const toolResults = body.messages.filter(
          (message) => message.role === "tool",
        ).length;
        if (emitToolCall && toolResults < toolCallRounds) {
          send({
            id: "child-response",
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
                      id: `call-${toolName}-${toolResults}`,
                      type: "function",
                      function: {
                        name: toolName,
                        arguments: JSON.stringify(
                          toolArguments ?? {
                            path: readPath,
                          },
                        ),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          send({
            id: "child-response",
            object: "chat.completion.chunk",
            created: 1,
            model: "local-test",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          });
        } else {
          send({
            id: "child-response",
            object: "chat.completion.chunk",
            created: 1,
            model: "local-test",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: finalText },
                finish_reason: null,
              },
            ],
          });
          send({
            id: "child-response",
            object: "chat.completion.chunk",
            created: 1,
            model: "local-test",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 4,
              completion_tokens: 3,
              total_tokens: 7,
            },
          });
        }
        response.write("data: [DONE]\n\n");
        response.end();
      };
      if (delayMs > 0) {
        timer = setTimeout(respond, delayMs);
      } else {
        respond();
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address);
  return {
    server,
    requests,
    openConnections: () => sockets.size,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
}

function initGitRepository(project) {
  execFileSync("git", ["init", "-q"], { cwd: project });
  execFileSync("git", ["config", "user.email", "child@example.test"], {
    cwd: project,
  });
  execFileSync("git", ["config", "user.name", "Child Test"], { cwd: project });
  execFileSync("git", ["add", "."], { cwd: project });
  execFileSync("git", ["commit", "-qm", "test fixture"], { cwd: project });
}

async function writeModelHome(home, baseUrl) {
  await fs.mkdir(home, { recursive: true });
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
          baseUrl,
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
}

async function runChild(options) {
  const cli = await ensureBuilt();
  return core.runReadOnlySubagent({
    hostArgv: [process.execPath, cli],
    model: "local/local-test",
    parentPolicy: PERMISSIVE_PARENT,
    ...options,
  });
}

test("read-only child runs as an independent session with evidence", async () => {
  await withTempDirectory("codepunk-child-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(project, "subagent-input.txt"),
      "subagent input\n",
    );
    initGitRepository(project);
    const modelServer = await startChildModelServer();
    await writeModelHome(home, modelServer.baseUrl);
    try {
      const streamed = [];
      const result = await runChild({
        cwd: project,
        parentSessionId: "parent-session",
        childSessionId: "child-session",
        prompt: "read the input file and summarize it",
        onEvent: (event) => streamed.push(event),
        env: {
          ...process.env,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          NO_COLOR: "1",
        },
      });

      assert.equal(result.child_session_id, "child-session");
      assert.equal(result.parent_session_id, "parent-session");
      assert.equal(result.depth, 1);
      assert.equal(result.isolation, "shared");
      assert.equal(result.summary, "child says hello");
      assert.equal(result.exit_code, 0);
      assert.match(result.evidence_head, /^sha256:[a-f0-9]{64}$/u);
      assert.ok(result.child_run_id);
      assert.ok(result.transcript_path);

      const evidenceText = await fs.readFile(
        result.child_evidence_path,
        "utf8",
      );
      const records = evidenceText
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      assert.equal(records.length, 1);
      assert.equal(records[0].tool, "read");
      assert.equal(core.evidenceRecordHash(records[0]), result.evidence_head);
      const transcriptStat = await fs.stat(result.transcript_path);
      assert.equal(transcriptStat.mode & 0o777, 0o600);
      const transcriptText = await fs.readFile(result.transcript_path, "utf8");
      const transcriptEvents = transcriptText
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      assert.ok(
        transcriptEvents.some(
          (event) =>
            event.type === "tool_execution_end" &&
            event.toolName === "read" &&
            event.isError === false,
        ),
      );
      assert.match(transcriptText, /child says hello/u);
      assert.match(transcriptText, /subagent input/u);
      assert.ok(
        streamed.some(
          (event) =>
            event.type === "assistant_delta" &&
            event.text.includes("child says hello"),
        ),
      );
      assert.ok(
        streamed.some(
          (event) => event.type === "tool_start" && event.tool === "read",
        ),
      );
      assert.ok(
        streamed.some(
          (event) =>
            event.type === "tool_end" &&
            event.tool === "read" &&
            event.is_error === false &&
            event.output.includes("subagent input"),
        ),
      );

      const sessionLogs = (await fs.readdir(home, { recursive: true })).filter(
        (entry) => entry.endsWith(path.join("child-session", "session.jsonl")),
      );
      assert.equal(sessionLogs.length, 1);
      const childHeader = JSON.parse(
        (await fs.readFile(path.join(home, sessionLogs[0]), "utf8")).split(
          "\n",
        )[0],
      );
      assert.equal(childHeader.id, "child-session");
      assert.equal(childHeader.parent_session_id, "parent-session");

      const toolRequests = modelServer.requests.filter((request) =>
        Array.isArray(request.tools),
      );
      assert.ok(toolRequests.length >= 2);
      for (const request of toolRequests) {
        const names = request.tools.map(
          (tool) => tool.function?.name ?? tool.name,
        );
        assert.deepEqual([...names].sort(), ["read", "search"]);
      }
    } finally {
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("read-only child inherits a one-run workspace trust decision", async () => {
  await withTempDirectory("codepunk-child-trust-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(project, "subagent-input.txt"),
      "subagent input\n",
    );
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "Use the test fixture conventions.\n",
    );
    initGitRepository(project);
    const modelServer = await startChildModelServer();
    await writeModelHome(home, modelServer.baseUrl);
    try {
      const result = await runChild({
        cwd: project,
        parentSessionId: "parent-session-trust",
        childSessionId: "child-session-trust",
        prompt: "read the input file and summarize it",
        workspaceTrustOverride: "trust",
        env: {
          ...process.env,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          NO_COLOR: "1",
        },
      });
      assert.equal(result.exit_code, 0);
      assert.equal(result.summary, "child says hello");
    } finally {
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("read-only child cannot recover saved trust after a parent no-trust decision", async () => {
  await withTempDirectory("codepunk-child-no-trust-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    const marker = "CHILD-MUST-NOT-SEE-PROJECT-INSTRUCTIONS";
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(project, "subagent-input.txt"),
      "subagent input\n",
    );
    await fs.writeFile(path.join(project, "AGENTS.md"), `${marker}\n`);
    initGitRepository(project);
    const modelServer = await startChildModelServer({ emitToolCall: false });
    await writeModelHome(home, modelServer.baseUrl);
    await core.saveWorkspaceTrust(home, project, true);
    const env = {
      ...process.env,
      CODEPUNK_HOME: home,
      PI_OFFLINE: "1",
      NO_COLOR: "1",
    };
    try {
      const saved = await runChild({
        cwd: project,
        parentSessionId: "parent-saved-trust",
        childSessionId: "child-saved-trust",
        prompt: "answer without reading files",
        env,
      });
      assert.equal(saved.exit_code, 0);
      assert.ok(
        JSON.stringify(modelServer.requests).includes(marker),
        "positive control: a saved trust decision must expose project instructions",
      );

      const requestsBeforeNoTrust = modelServer.requests.length;
      const denied = await runChild({
        cwd: project,
        parentSessionId: "parent-no-trust",
        childSessionId: "child-no-trust",
        prompt: "answer without reading files",
        workspaceTrustOverride: "no-trust",
        env,
      });
      assert.equal(denied.exit_code, 0);
      assert.ok(
        !JSON.stringify(
          modelServer.requests.slice(requestsBeforeNoTrust),
        ).includes(marker),
        "a parent no-trust decision must not fall back to the saved decision",
      );
    } finally {
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("read-only child inherits a per-resource parent decision", async () => {
  await withTempDirectory("codepunk-child-partial-trust-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    const marker = "CHILD-PARTIAL-TRUST-INSTRUCTION";
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(project, "subagent-input.txt"),
      "subagent input\n",
    );
    await fs.writeFile(path.join(project, "AGENTS.md"), `${marker}\n`);
    initGitRepository(project);
    const modelServer = await startChildModelServer({ emitToolCall: false });
    await writeModelHome(home, modelServer.baseUrl);
    await core.saveWorkspaceTrust(home, project, true);
    const env = {
      ...process.env,
      CODEPUNK_HOME: home,
      PI_OFFLINE: "1",
      NO_COLOR: "1",
    };
    try {
      const denied = await runChild({
        cwd: project,
        parentSessionId: "parent-partial-none",
        childSessionId: "child-partial-none",
        prompt: "answer without reading files",
        workspaceTrustOverride: {
          config: false,
          policy: false,
          skills: false,
          instructions: false,
        },
        env,
      });
      assert.equal(denied.exit_code, 0);
      assert.ok(
        !JSON.stringify(modelServer.requests).includes(marker),
        "a partial parent decision must not fall back to the saved full trust",
      );

      const requestsBeforeInstructions = modelServer.requests.length;
      const instructionsOnly = await runChild({
        cwd: project,
        parentSessionId: "parent-partial-instructions",
        childSessionId: "child-partial-instructions",
        prompt: "answer without reading files",
        workspaceTrustOverride: {
          config: false,
          policy: false,
          skills: false,
          instructions: true,
        },
        env,
      });
      assert.equal(instructionsOnly.exit_code, 0);
      assert.ok(
        JSON.stringify(
          modelServer.requests.slice(requestsBeforeInstructions),
        ).includes(marker),
        "the instructions grant must load the project instruction in the child",
      );
    } finally {
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("read-only child inherits bare isolation from the parent session", async () => {
  await withTempDirectory("codepunk-child-bare-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    const instructionMarker = "CHILD-MUST-NOT-INHERIT-INSTRUCTIONS";
    const skillMarker = "CHILD-MUST-NOT-INHERIT-SKILLS";
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(project, "subagent-input.txt"),
      "subagent input\n",
    );
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      `${instructionMarker}\n`,
    );
    initGitRepository(project);
    const modelServer = await startChildModelServer({ emitToolCall: false });
    await writeModelHome(home, modelServer.baseUrl);
    await fs.mkdir(path.join(home, "skills", "child-probe"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(home, "skills", "child-probe", "SKILL.md"),
      [
        "---",
        "name: child-probe",
        `description: ${skillMarker}`,
        "---",
        "",
        "Child probe skill.",
        "",
      ].join("\n"),
    );
    await core.saveWorkspaceTrust(home, project, true);
    const env = {
      ...process.env,
      CODEPUNK_HOME: home,
      PI_OFFLINE: "1",
      NO_COLOR: "1",
    };
    try {
      const ordinary = await runChild({
        cwd: project,
        parentSessionId: "parent-ordinary",
        childSessionId: "child-ordinary",
        prompt: "answer without reading files",
        env,
      });
      assert.equal(ordinary.exit_code, 0);
      const ordinaryRequests = JSON.stringify(modelServer.requests);
      assert.ok(
        ordinaryRequests.includes(instructionMarker),
        "positive control: an ordinary child must load trusted instructions",
      );
      assert.ok(
        ordinaryRequests.includes(skillMarker),
        "positive control: an ordinary child must expose skill metadata",
      );

      const requestsBeforeBare = modelServer.requests.length;
      const bare = await runChild({
        cwd: project,
        parentSessionId: "parent-bare",
        childSessionId: "child-bare",
        prompt: "answer without reading files",
        bare: true,
        env,
      });
      assert.equal(bare.exit_code, 0);
      const bareRequests = JSON.stringify(
        modelServer.requests.slice(requestsBeforeBare),
      );
      assert.ok(
        !bareRequests.includes(instructionMarker),
        "a bare parent must not expose project instructions to its child",
      );
      assert.ok(
        !bareRequests.includes(skillMarker),
        "a bare parent must not expose skill metadata to its child",
      );
    } finally {
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("a read-only child is confined to the workspace even under a broad parent config", async () => {
  await withTempDirectory("codepunk-child-confined-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(project, "subagent-input.txt"),
      "subagent input\n",
    );
    await fs.writeFile(
      path.join(root, "outside-secret.txt"),
      "TOP-SECRET-OUTSIDE-WORKSPACE\n",
    );
    initGitRepository(project);
    const modelServer = await startChildModelServer({
      readPath: "../outside-secret.txt",
    });
    await writeModelHome(home, modelServer.baseUrl);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n[filesystem]\nmode = "full"\n[approval]\nmode = "allow"\n',
    );
    try {
      const result = await runChild({
        cwd: project,
        parentSessionId: "parent-session",
        childSessionId: "child-confined",
        prompt: "read the file above the workspace",
        env: {
          ...process.env,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          NO_COLOR: "1",
        },
      });
      assert.equal(result.exit_code, 0);
      const records = (await fs.readFile(result.child_evidence_path, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      assert.equal(records.length, 1);
      assert.equal(records[0].tool, "read");
      assert.equal(records[0].decision, "deny");
      assert.equal(records[0].outcome, "denied");
      assert.match(records[0].path_check.target, /outside-secret\.txt$/u);
      assert.ok(
        !JSON.stringify(modelServer.requests).includes(
          "TOP-SECRET-OUTSIDE-WORKSPACE",
        ),
        "the denied file body must never reach the model",
      );
    } finally {
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("a child that only reasons completes without an evidence run", async () => {
  await withTempDirectory("codepunk-child-reason-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(project, "subagent-input.txt"),
      "subagent input\n",
    );
    initGitRepository(project);
    const modelServer = await startChildModelServer({ emitToolCall: false });
    await writeModelHome(home, modelServer.baseUrl);
    try {
      const result = await runChild({
        cwd: project,
        parentSessionId: "parent-session",
        childSessionId: "child-reason-only",
        prompt: "answer without reading files",
        env: {
          ...process.env,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          NO_COLOR: "1",
        },
      });
      assert.equal(result.summary, "child says hello");
      assert.equal(result.exit_code, 0);
      assert.equal(result.evidence_head, null);
      assert.equal(result.child_evidence_path, null);
      assert.equal(result.child_run_id, null);
    } finally {
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("read-only child enforces its tool-call budget", async () => {
  await withTempDirectory("codepunk-child-budget-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(project, "subagent-input.txt"),
      "subagent input\n",
    );
    initGitRepository(project);
    const modelServer = await startChildModelServer({ toolCallRounds: 3 });
    await writeModelHome(home, modelServer.baseUrl);
    try {
      await assert.rejects(
        () =>
          runChild({
            cwd: project,
            parentSessionId: "parent-session",
            childSessionId: "child-budget",
            prompt: "keep reading the input file",
            budget: { max_tool_calls: 1 },
            env: {
              ...process.env,
              CODEPUNK_HOME: home,
              PI_OFFLINE: "1",
              NO_COLOR: "1",
            },
          }),
        (error) =>
          error instanceof core.ChildHostError &&
          error.code === "subagent.budget_exceeded" &&
          typeof error.transcript === "string",
      );
    } finally {
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("read-only child wall-clock timeout kills the child process", async () => {
  await withTempDirectory("codepunk-child-wall-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(project, "subagent-input.txt"),
      "subagent input\n",
    );
    initGitRepository(project);
    const modelServer = await startChildModelServer({ delayMs: 30_000 });
    await writeModelHome(home, modelServer.baseUrl);
    try {
      await assert.rejects(
        () =>
          runChild({
            cwd: project,
            parentSessionId: "parent-session",
            childSessionId: "child-wall-clock",
            prompt: "wait for a slow provider",
            budget: { max_wall_ms: 100 },
            env: {
              ...process.env,
              CODEPUNK_HOME: home,
              PI_OFFLINE: "1",
              NO_COLOR: "1",
            },
          }),
        (error) =>
          error instanceof core.ChildHostError &&
          error.code === "subagent.budget_exceeded" &&
          /wall-clock/u.test(error.message) &&
          typeof error.transcript === "string",
      );
      const deadline = Date.now() + 2_500;
      while (modelServer.openConnections() > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(modelServer.openConnections(), 0);
      const requests = modelServer.requests.length;
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(modelServer.requests.length, requests);
    } finally {
      modelServer.server.closeAllConnections();
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("invalid and duplicate child session ids fail before spawning", async () => {
  await withTempDirectory("codepunk-child-ids-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(project, "subagent-input.txt"),
      "subagent input\n",
    );
    initGitRepository(project);
    await fs.mkdir(home);

    await assert.rejects(
      () =>
        core.runReadOnlySubagent({
          hostArgv: ["/nonexistent-child-host"],
          cwd: project,
          parentPolicy: PERMISSIVE_PARENT,
          parentSessionId: "parent-session",
          childSessionId: "../escape",
          prompt: "inspect",
        }),
      (error) =>
        error instanceof core.ChildHostError &&
        error.code === "subagent.child_session_id",
    );

    const modelServer = await startChildModelServer();
    await writeModelHome(home, modelServer.baseUrl);
    try {
      const env = {
        ...process.env,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        NO_COLOR: "1",
      };
      await runChild({
        cwd: project,
        parentSessionId: "parent-session",
        childSessionId: "child-once",
        prompt: "read the input file",
        env,
      });
      await assert.rejects(
        () =>
          runChild({
            cwd: project,
            parentSessionId: "parent-session",
            childSessionId: "child-once",
            prompt: "read the input file again",
            env,
          }),
        (error) =>
          error instanceof core.ChildHostError &&
          error.code === "subagent.child_session_exists",
      );
    } finally {
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("child host rejects a working directory outside git", async () => {
  await withTempDirectory("codepunk-child-nongit-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await assert.rejects(
      () =>
        core.runReadOnlySubagent({
          hostArgv: ["/nonexistent-child-host"],
          cwd: project,
          parentPolicy: PERMISSIVE_PARENT,
          parentSessionId: "parent-session",
          childSessionId: "child-nongit",
          prompt: "inspect",
          env: { ...process.env, CODEPUNK_HOME: home },
        }),
      (error) =>
        error instanceof core.ChildHostError &&
        error.code === "subagent.not_git",
    );
  });
});

test("a mutating profile runs in a detached worktree and keeps the parent clean", async () => {
  await withTempDirectory("codepunk-child-worktree-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(project, "subagent-input.txt"),
      "subagent input\n",
    );
    initGitRepository(project);
    const modelServer = await startChildModelServer({
      toolName: "write",
      toolArguments: {
        path: "child-output.txt",
        content: "written by child\n",
      },
      finalText: "WROTE_CHILD_FILE",
    });
    await writeModelHome(home, modelServer.baseUrl);
    let worktree = null;
    try {
      const cli = await ensureBuilt();
      const result = await core.runSubagentHost({
        hostArgv: [process.execPath, cli],
        cwd: project,
        parentPolicy: PERMISSIVE_PARENT,
        parentSessionId: "parent-session",
        childSessionId: "child-mutable",
        prompt: "create the child output file",
        isolation: "worktree",
        model: "local/local-test",
        profile: {
          name: "worker",
          sha256: `sha256:${"a".repeat(64)}`,
          tools: {
            read: true,
            write: true,
            edit: false,
            shell: false,
            search: true,
            memory_search: false,
          },
          systemPrompt: "You are a bounded worker.",
          model: "local/local-test",
          fallback: [],
          thinking: "low",
        },
        env: {
          ...process.env,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          NO_COLOR: "1",
        },
      });
      worktree = result.worktree;
      assert.equal(result.isolation, "worktree");
      assert.equal(result.profile, "worker");
      assert.equal(result.summary, "WROTE_CHILD_FILE");
      assert.equal(result.exit_code, 0);
      assert.ok(worktree);
      assert.ok((result.changed_files ?? 0) >= 1);
      assert.match(result.evidence_head, /^sha256:[a-f0-9]{64}$/u);

      await assert.rejects(
        () => fs.readFile(path.join(project, "child-output.txt"), "utf8"),
        /ENOENT/u,
      );
      assert.equal(
        await fs.readFile(path.join(worktree, "child-output.txt"), "utf8"),
        "written by child\n",
      );
      const records = (await fs.readFile(result.child_evidence_path, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      assert.equal(records.at(-1)?.tool, "write");
    } finally {
      if (worktree !== null) {
        execFileSync("git", ["worktree", "remove", "--force", worktree], {
          cwd: project,
        });
        await fs.rm(path.dirname(worktree), { recursive: true, force: true });
      }
      modelServer.server.closeAllConnections?.();
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("an edit-only profile can mutate its worktree", async () => {
  await withTempDirectory("codepunk-child-edit-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(project, "subagent-input.txt"),
      "subagent input\n",
    );
    await fs.writeFile(path.join(project, "edit-target.txt"), "before\n");
    initGitRepository(project);
    const modelServer = await startChildModelServer({
      toolName: "edit",
      toolArguments: {
        path: "edit-target.txt",
        edits: [{ oldText: "before", newText: "after" }],
      },
      finalText: "EDITED_CHILD_FILE",
    });
    await writeModelHome(home, modelServer.baseUrl);
    let worktree = null;
    try {
      const cli = await ensureBuilt();
      const result = await core.runSubagentHost({
        hostArgv: [process.execPath, cli],
        cwd: project,
        parentPolicy: PERMISSIVE_PARENT,
        parentSessionId: "parent-session",
        childSessionId: "child-edit",
        prompt: "edit the child output file",
        isolation: "worktree",
        model: "local/local-test",
        profile: {
          name: "editor",
          sha256: `sha256:${"b".repeat(64)}`,
          tools: {
            read: true,
            write: false,
            edit: true,
            shell: false,
            search: true,
            memory_search: false,
          },
          systemPrompt: "You are a bounded editor.",
          model: "local/local-test",
          fallback: [],
          thinking: "low",
        },
        env: {
          ...process.env,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          NO_COLOR: "1",
        },
      });
      worktree = result.worktree;
      assert.equal(result.exit_code, 0);
      assert.equal(result.summary, "EDITED_CHILD_FILE");
      assert.ok((result.changed_files ?? 0) >= 1);
      assert.equal(
        await fs.readFile(path.join(project, "edit-target.txt"), "utf8"),
        "before\n",
      );
      assert.equal(
        await fs.readFile(path.join(worktree, "edit-target.txt"), "utf8"),
        "after\n",
      );
    } finally {
      if (worktree !== null) {
        execFileSync("git", ["worktree", "remove", "--force", worktree], {
          cwd: project,
        });
        await fs.rm(path.dirname(worktree), { recursive: true, force: true });
      }
      modelServer.server.closeAllConnections?.();
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("a mutating profile cannot run in the shared checkout", async () => {
  await withTempDirectory("codepunk-child-shared-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(project, "subagent-input.txt"),
      "subagent input\n",
    );
    initGitRepository(project);
    const cli = await ensureBuilt();
    await assert.rejects(
      () =>
        core.runSubagentHost({
          hostArgv: [process.execPath, cli],
          cwd: project,
          parentPolicy: PERMISSIVE_PARENT,
          parentSessionId: "parent-session",
          childSessionId: "child-shared-mutation",
          prompt: "try to mutate the parent checkout",
          isolation: "shared",
          model: "local/local-test",
          profile: {
            name: "worker",
            sha256: `sha256:${"c".repeat(64)}`,
            tools: {
              read: true,
              write: true,
              edit: false,
              shell: false,
              search: true,
              memory_search: false,
            },
            systemPrompt: "You are a bounded worker.",
            model: "local/local-test",
            fallback: [],
            thinking: "low",
          },
        }),
      /requires a detached worktree/u,
    );
  });
});

test("a read-only parent cannot spawn a mutating profile", async () => {
  await withTempDirectory("codepunk-child-parent-ceiling-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(project, "subagent-input.txt"),
      "subagent input\n",
    );
    initGitRepository(project);
    const cli = await ensureBuilt();
    await assert.rejects(
      () =>
        core.runSubagentHost({
          hostArgv: [process.execPath, cli],
          cwd: project,
          parentPolicy: {
            approval: "ask",
            autonomy: "read-only",
            tools: PERMISSIVE_PARENT.tools,
          },
          parentSessionId: "parent-session",
          childSessionId: "child-parent-read-only",
          prompt: "try to mutate from a locked parent",
          model: "local/local-test",
          profile: {
            name: "worker",
            sha256: `sha256:${"d".repeat(64)}`,
            tools: {
              read: true,
              write: true,
              edit: false,
              shell: false,
              search: true,
              memory_search: false,
            },
            systemPrompt: "You are a bounded worker.",
            model: "local/local-test",
            fallback: [],
            thinking: "low",
          },
        }),
      (error) =>
        error instanceof core.ChildHostError &&
        error.code === "subagent.parent_read_only",
    );
  });
});
