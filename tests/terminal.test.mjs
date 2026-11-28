import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { ensureBuilt, withTempDirectory } from "./support/helpers.mjs";
import { importCore } from "./support/core.mjs";
import { sandboxTempBase, windowsSrtSkipReason } from "./support/helpers.mjs";

const core = await importCore();
const TESTS_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(TESTS_DIR, "..");
const execFileAsync = promisify(execFile);
const CHILD_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SystemRoot",
  "PATHEXT",
  "USERNAME",
];
const WINDOWS_SRT_SKIP = await windowsSrtSkipReason(core);
const PTY_RUNNER =
  process.platform === "win32"
    ? [process.execPath, path.join(TESTS_DIR, "support", "pty-run.mjs")]
    : ["python3", path.join(TESTS_DIR, "support", "pty-run.py")];

async function runProbe(command, args, env, cwd = REPO_ROOT) {
  const child = spawn(command, args, {
    cwd,
    env: {
      ...childEnv(env),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const result = await new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return { ...result, stdout, stderr };
}

function childEnv(env) {
  return {
    ...Object.fromEntries(
      CHILD_ENV_KEYS.flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    ),
    ...env,
  };
}

async function startModelServer() {
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const send = (value) => {
        response.write(`data: ${JSON.stringify(value)}\n\n`);
      };
      send({
        id: "terminal-print-response",
        object: "chat.completion.chunk",
        created: 1,
        model: "local-test",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "terminal print response" },
            finish_reason: null,
          },
        ],
      });
      send({
        id: "terminal-print-response",
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
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

function startPty(command, args, { cwd, env }) {
  const pidFile = path.join(
    env.CODEPUNK_HOME,
    `pty-child-${process.pid}-${Date.now()}.pid`,
  );
  const child = spawn(
    PTY_RUNNER[0],
    [...PTY_RUNNER.slice(1), command, ...args],
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
  // `close` waits for stdio EOF, which a descendant can hold open after the
  // process itself is gone. `terminated` reports the process exit separately.
  const terminated = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, terminated, pidFile, output: () => output };
}

async function killPtyGroup(session) {
  let pid;
  try {
    pid = Number.parseInt(await fs.readFile(session.pidFile, "utf8"), 10);
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      execFile(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 5_000 },
        () => resolve(),
      );
    });
    return pid;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
  return pid;
}

async function stopPty(session) {
  const startedAt = Date.now();
  let ptyPid = null;
  try {
    ptyPid = await killPtyGroup(session);
    if (session.child.exitCode === null && session.child.signalCode === null) {
      if (process.platform === "win32" && session.child.pid !== undefined) {
        await new Promise((resolve) => {
          execFile(
            "taskkill",
            ["/PID", String(session.child.pid), "/T", "/F"],
            { windowsHide: true, timeout: 5_000 },
            () => resolve(),
          );
        });
      }
      session.child.kill("SIGTERM");
      const graceful = await waitForExit(session.terminated, 2_000);
      if (graceful === null) {
        session.child.kill("SIGKILL");
        const forced = await waitForExit(session.terminated, 5_000);
        if (forced === null) {
          throw new Error(
            [
              `stopPty timed out after ${Date.now() - startedAt}ms`,
              `wrapperPid=${session.child.pid ?? "unknown"}`,
              `ptyPid=${ptyPid ?? "unknown"}`,
              `exitCode=${session.child.exitCode}`,
              `signal=${session.child.signalCode}`,
              `lastOutput=${JSON.stringify(session.output().slice(-4000))}`,
            ].join(" "),
          );
        }
      }
    }
    // A process that has terminated may never close its stdio pipes while a
    // descendant holds them. Do not let cleanup wait for that indefinitely.
    await waitForExit(session.exited, 250);
  } finally {
    session.child.stdin?.destroy();
    session.child.stdout?.destroy();
    session.child.stderr?.destroy();
    session.child.unref?.();
    await fs.rm(session.pidFile, { force: true });
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function waitForOutput(output, mark, marker, label) {
  return waitFor(
    () => (output.join("").slice(mark).includes(marker) ? true : null),
    label,
  );
}

async function waitForPtyOutput(session, marker, label) {
  return waitFor(
    () => (session.output().includes(marker) ? true : null),
    label,
  );
}

async function readEvidence(evidencePath) {
  try {
    return (await core.readEvidenceFile(evidencePath)).records;
  } catch (error) {
    if (error instanceof Error && /cannot be read/u.test(error.message)) {
      return [];
    }
    throw error;
  }
}

async function readSessionEvents(sessionPath) {
  const lines = (await fs.readFile(sessionPath, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
  return lines.slice(1).map((line) => JSON.parse(line));
}

test("terminal capability detection covers truecolor and explicit override", async () => {
  await withTempDirectory("codepunk-terminal-truecolor-", async (root) => {
    const home = path.join(root, "home");
    await fs.mkdir(home, { recursive: true });
    const probe = [
      "--input-type=module",
      "-e",
      [
        "import * as tui from " +
          JSON.stringify(
            pathToFileURL(
              path.join(
                REPO_ROOT,
                "packages",
                "cli",
                "node_modules",
                "@earendil-works",
                "pi-tui",
                "dist",
                "index.js",
              ),
            ).href,
          ) +
          ";",
        "const capabilities = tui.detectCapabilities(() => false);",
        "process.stdout.write(JSON.stringify({",
        "  trueColor: capabilities.trueColor,",
        "  colorMode: tui.getTerminalColorMode(capabilities),",
        "}));",
      ].join("\n"),
    ];

    const detected = await runProbe(process.execPath, probe, {
      ...childEnv({
        CODEPUNK_HOME: home,
        COLORTERM: "truecolor",
        TERM: "xterm-256color",
      }),
    });
    assert.equal(detected.code, 0, detected.stderr);
    assert.deepEqual(JSON.parse(detected.stdout), {
      trueColor: true,
      colorMode: "truecolor",
    });

    const override = await runProbe(process.execPath, probe, {
      ...childEnv({
        CODEPUNK_HOME: home,
        COLORTERM: "truecolor",
        PI_TRUE_COLOR: "0",
        TERM: "xterm-256color",
      }),
    });
    assert.equal(override.code, 0, override.stderr);
    assert.deepEqual(JSON.parse(override.stdout), {
      trueColor: false,
      colorMode: "256color",
    });
  });
});

test("ANSI styling is enabled on a real PTY and disabled by NO_COLOR", async () => {
  await withTempDirectory("codepunk-terminal-noninteractive-", async (root) => {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "TERMINAL_ANSI_SENTINEL\n",
    );
    const cli = await ensureBuilt();
    const startPtyWithColor = (color) =>
      startPty(process.execPath, [cli], {
        cwd: project,
        env: childEnv({
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          ...(color
            ? { TERM: "xterm-256color" }
            : { NO_COLOR: "1", TERM: "dumb" }),
        }),
      });
    const session = startPtyWithColor(true);
    let promptRendered = false;
    try {
      await waitForPtyOutput(session, "Project trust", "colored trust prompt");
      promptRendered = true;
      const output = session.output();
      assert.match(
        output,
        /\u001b\[(?:[0-9;]*;)?(?:3[0-7]|9[0-7]|38|48)(?:;[0-9;]*)?m[\s\S]*\u001b\[(?:0*(?:;0*)*)?m/u,
        "expected a colored SGR sequence followed by a reset",
      );
    } finally {
      await stopPty(session);
      assert.equal(promptRendered, true);
    }

    const plainSession = startPtyWithColor(false);
    let plainPromptRendered = false;
    try {
      await waitForPtyOutput(
        plainSession,
        "Project trust",
        "NO_COLOR trust prompt",
      );
      plainPromptRendered = true;
      assert.doesNotMatch(
        plainSession.output(),
        /\u001b\[(?!(?:0*(?:;0*)*)?m)[0-9;]*m/u,
        "expected NO_COLOR to disable non-reset SGR output",
      );
    } finally {
      await stopPty(plainSession);
      assert.equal(plainPromptRendered, true);
    }
  });
});

test("interactive selection refuses a non-TTY", async () => {
  await withTempDirectory("codepunk-terminal-selection-", async (root) => {
    const home = path.join(root, "home");
    await fs.mkdir(home, { recursive: true });

    const cli = await ensureBuilt();
    const result = await runProbe(
      process.execPath,
      [cli, "sign", "run", "--verdict", "complete"],
      childEnv({
        CODEPUNK_HOME: home,
        NO_COLOR: "1",
      }),
    );
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /sign requires a top-level TTY/u);
    assert.equal(result.stdout.trim(), "");
  });
});

test("noninteractive stdin degrades to print mode", async () => {
  await withTempDirectory("codepunk-terminal-print-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ local: { type: "api_key", key: "test-key" } }),
      { mode: 0o600 },
    );
    await fs.writeFile(path.join(project, "a.txt"), "unchanged\n");
    const modelServer = await startModelServer();
    try {
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
      const cli = await ensureBuilt();
      const result = await runProbe(
        process.execPath,
        [cli, "hello", "--model", "local/local-test"],
        childEnv({
          CODEPUNK_HOME: home,
          NO_COLOR: "1",
          PI_OFFLINE: "1",
          TERM: "dumb",
        }),
        project,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /terminal print response/u);
      assert.equal(
        await fs.readFile(path.join(project, "a.txt"), "utf8"),
        "unchanged\n",
      );
    } finally {
      modelServer.server.closeAllConnections?.();
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test(
  "real pty gates !, records /compact, and exits without a Pi banner",
  {
    skip: process.platform === "win32" ? WINDOWS_SRT_SKIP : false,
  },
  async () => {
    const tempBase = sandboxTempBase();
    await fs.mkdir(tempBase, { recursive: true });
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(tempBase, "codepunk-pty-")),
    );
    const allowedCommand =
      process.platform === "win32"
        ? "echo codepunk-allowed"
        : "printf 'code''punk-allowed'";
    const evidencePath = path.join(root, "evidence.jsonl");
    const detectorPath = path.join(root, "detector.json");
    const readyPath = path.join(root, "ready.json");
    const sessionPathFile = path.join(root, "session-path.txt");
    const spawnMarker = path.join(root, "project", "rm-spawned");
    const output = [];
    const child = spawn(
      PTY_RUNNER[0],
      [
        ...PTY_RUNNER.slice(1),
        process.execPath,
        path.join(TESTS_DIR, "support", "pty-host.mjs"),
        root,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
    const exited = new Promise((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    });

    try {
      const ready = await waitFor(async () => {
        try {
          return JSON.parse(await fs.readFile(readyPath, "utf8"));
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return null;
          }
          throw error;
        }
      }, "pty host readiness");
      assert.equal(ready.tty, true);
      assert.equal(await fs.readFile(detectorPath, "utf8"), "ok\n");
      await delay(300);

      const allowedMark = output.join("").length;
      child.stdin.write(`!${allowedCommand}\r`);
      await waitForOutput(
        output,
        allowedMark,
        "codepunk-allowed",
        "allowed user_bash rendering",
      );
      await delay(500);
      const allowed = await waitFor(
        async () =>
          (await readEvidence(evidencePath)).find(
            (record) =>
              record.source === "user_bash" &&
              record.command === allowedCommand &&
              record.decision === "allow",
          ) ?? null,
        "allowed user_bash evidence",
      );
      assert.equal(allowed.exit_code, 0);
      assert.equal(allowed.executor, "srt");
      assert.equal(allowed.sandbox.backend, "srt");
      assert.equal(allowed.output_preview.trim(), "codepunk-allowed");

      const deniedMark = output.join("").length;
      child.stdin.write("!rm -rf /\r");
      await waitForOutput(
        output,
        deniedMark,
        "denied: shell.dangerous",
        "denied user_bash rendering",
      );
      await delay(500);
      const denied = await waitFor(
        async () =>
          (await readEvidence(evidencePath)).find(
            (record) =>
              record.source === "user_bash" &&
              record.command === "rm -rf /" &&
              record.decision === "deny",
          ) ?? null,
        "denied user_bash evidence",
      );
      assert.equal(denied.rule, "shell.dangerous");
      assert.equal(denied.executor, null);
      assert.equal(denied.exit_code, null);
      assert.equal(
        await fs.readFile(spawnMarker, "utf8").catch(() => null),
        null,
      );

      child.stdin.write("/compact\r");
      const sessionPath = (await fs.readFile(sessionPathFile, "utf8")).trim();
      const compactDecision = await waitFor(
        async () =>
          (await readSessionEvents(sessionPath)).find(
            (event) =>
              event.kind === "compaction/decision" &&
              event.data.reason === "manual",
          ) ?? null,
        "manual compaction decision",
      );
      assert.equal(compactDecision.data.cancelled, false);
      assert.equal(compactDecision.data.entries, 1);
      assert.ok(compactDecision.data.checkpoint);
      assert.ok(compactDecision.data.checkpoint.first_kept_entry_id);
      assert.ok(compactDecision.data.checkpoint.messages_before > 0);
      assert.ok(compactDecision.data.checkpoint.messages_after > 0);

      child.stdin.write("/quit\r");
      const result = await waitForExit(exited, 15_000);
      assert.ok(result);
      assert.equal(result.code, 0);
      const transcript = output.join("");
      assert.ok(transcript.trim().length > 0);
      assert.doesNotMatch(transcript, /pi --session/u);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
