import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { importSource } from "./support/core.mjs";
import {
  ensureBuilt,
  REPO_ROOT,
  withTempDirectory,
  withoutAmbientProviderEnv,
} from "./support/helpers.mjs";

const execFileAsync = promisify(execFile);
const BASE_ENV = withoutAmbientProviderEnv();
const { commandContext, waitForIdleTuiCommands } = await importSource(
  "packages/cli/src/tui/command-context.ts",
);

const PTY_RUNNER =
  process.platform === "win32"
    ? [
        process.execPath,
        path.join(REPO_ROOT, "tests", "support", "pty-run.mjs"),
      ]
    : ["python3", path.join(REPO_ROOT, "tests", "support", "pty-run.py")];

function stripAnsi(value) {
  return value.replace(
    /\u001b(?:\][^\u0007]*?(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/gu,
    "",
  );
}

test("W-04: commandContext delegates to live state.context and serializes deferred reload", async () => {
  const notices = [];
  const state = {
    runtime: { session: { sessionId: "sess-1" } },
    context: null,
    channel: { attach() {} },
  };
  let stale = false;
  const oldContext = {
    get ui() {
      if (stale) {
        throw new Error(
          "This extension ctx is stale after session replacement or reload.",
        );
      }
      return {
        notify(message) {
          notices.push(`old:${message}`);
        },
      };
    },
  };
  const newContext = {
    ui: {
      notify(message) {
        notices.push(`new:${message}`);
      },
    },
  };

  let releaseCommand;
  const commandStarted = new Promise((resolve) => {
    releaseCommand = resolve;
  });
  let finishCommand;
  const commandWait = new Promise((resolve) => {
    finishCommand = resolve;
  });

  const wrapped = commandContext(state, async (_runtime, ctx) => {
    ctx.ui.notify("before");
    releaseCommand();
    await commandWait;
    // Even if oldContext was invalidated mid-command and state.context was rebound,
    // calling ctx.ui.notify must delegate to the active context instead of throwing stale.
    ctx.ui.notify("after");
  });

  const running = wrapped("", oldContext);
  await commandStarted;

  let reloadProceeded = false;
  const reloadBarrier = waitForIdleTuiCommands(state).then(() => {
    reloadProceeded = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    reloadProceeded,
    false,
    "deferred MCP reload must wait while a slash command is active",
  );

  // Simulate context rebind mid-command.
  stale = true;
  state.context = newContext;
  finishCommand();
  await running;
  await reloadBarrier;
  assert.equal(reloadProceeded, true);
  assert.deepEqual(notices, ["old:before", "new:after"]);
});

test("W-04: /new, /fork, /clone, and /resume immediately support /status, /context, and /diff without stale ctx errors", async () => {
  const cli = await ensureBuilt();
  await withTempDirectory("codepunk-w04-pty-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: project });
    await execFileAsync("git", ["config", "user.name", "Test"], {
      cwd: project,
    });
    await execFileAsync("git", ["config", "user.email", "t@example.invalid"], {
      cwd: project,
    });
    await fs.writeFile(path.join(project, "README.md"), "# w04\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: project });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], {
      cwd: project,
    });

    const server = http.createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const send = (payload) => {
          response.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        send({
          id: "w04",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "TURN_OK" },
              finish_reason: null,
            },
          ],
        });
        send({
          id: "w04",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
        response.write("data: [DONE]\n\n");
        response.end();
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    await fs.writeFile(
      path.join(home, "models.json"),
      `${JSON.stringify({
        providers: {
          local: {
            api: "openai-completions",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: "test-key",
            models: [
              {
                id: "local-test",
                name: "local-test",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 1024,
              },
            ],
          },
        },
      })}\n`,
    );
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[model]\nprovider = "local"\nid = "local-test"\n',
    );

    const child = spawn(
      PTY_RUNNER[0],
      [...PTY_RUNNER.slice(1), process.execPath, cli],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          PTY_RUN_TIMEOUT: "45",
        },
      },
    );
    let output = "";
    const exited = new Promise((resolve) => {
      child.once("exit", () => resolve());
    });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });

    const waitFor = async (marker, from = 0, timeoutMs = 15_000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (stripAnsi(output.slice(from)).includes(marker)) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        `timed out waiting for ${marker}\n${stripAnsi(output.slice(from)).slice(-2000)}`,
      );
    };

    const verifyFirstCommands = async (label) => {
      for (const [cmd, expected] of [
        ["/status", "Capabilities & Evidence"],
        ["/context", "codepunk context"],
        ["/diff", "Working tree diff"],
      ]) {
        const mark = output.length;
        child.stdin.write(`${cmd}\r`);
        await waitFor(expected, mark, 10_000);
        assert.doesNotMatch(
          stripAnsi(output.slice(mark)),
          /stale after session replacement/u,
          `${label} -> ${cmd} hit stale ctx`,
        );
        child.stdin.write("\u001b");
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    };

    try {
      await waitFor("permissions standard");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.doesNotMatch(
        stripAnsi(output),
        /Extension command '\/copy' conflicts|conflicts with built-in interactive command/u,
        "W-07: startup emitted /copy built-in command conflict warning",
      );

      // W-07: verify /copy intercepts cleanly via EditorBridge without built-in conflict.
      let copyMark = output.length;
      child.stdin.write("/copy code\r");
      await waitFor("No matching fenced code block", copyMark, 8_000);

      // Create one settled turn so /fork and /clone have agent state.
      let mark = output.length;
      child.stdin.write("hello\r");
      await waitFor("TURN_OK", mark, 12_000);
      await new Promise((resolve) => setTimeout(resolve, 400));

      // 1. /fork
      mark = output.length;
      child.stdin.write("/fork\r");
      await waitFor("forked ", mark, 10_000);
      const forkMatch = stripAnsi(output.slice(mark)).match(
        /forked ([A-Z0-9]+) -> ([A-Z0-9]+)/u,
      );
      assert.ok(forkMatch !== null, "expected parent -> child fork IDs");
      const parentSessionId = forkMatch[1];
      await verifyFirstCommands("/fork");

      // 2. /clone
      mark = output.length;
      child.stdin.write("/clone\r");
      await waitFor("forked ", mark, 10_000);
      await verifyFirstCommands("/clone");

      // 3. /new
      mark = output.length;
      child.stdin.write("/new\r");
      await waitFor("Start new session", mark, 8_000);
      child.stdin.write("\r");
      await waitFor("started session ", mark, 10_000);
      await verifyFirstCommands("/new");

      // 4. /resume <parentSessionId>
      mark = output.length;
      child.stdin.write(`/resume ${parentSessionId}\r`);
      await waitFor(`resumed session ${parentSessionId}`, mark, 10_000);
      await verifyFirstCommands("/resume");

      assert.doesNotMatch(
        stripAnsi(output),
        /This extension ctx is stale/u,
        "stale extension ctx surfaced during session replacements",
      );

      child.stdin.write("/quit\r");
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
