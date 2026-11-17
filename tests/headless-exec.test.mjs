import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { ensureBuilt, withTempDirectory } from "./support/helpers.mjs";

const SRT_SKIP =
  process.platform === "win32"
    ? "headless exec requires the srt sandbox, which is not provisioned here"
    : false;

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function runCli(args, { cwd, home }) {
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function startToolServer(argv) {
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
          id: "tool-response",
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
                    id: "call-exec",
                    type: "function",
                    function: {
                      name: "exec",
                      arguments: JSON.stringify({ argv }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({
          id: "tool-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        });
      } else {
        send({
          id: "tool-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "finished" },
              finish_reason: null,
            },
          ],
        });
        send({
          id: "tool-response",
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

async function setup(root, argv) {
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  await fs.mkdir(project);
  await fs.mkdir(home);
  await fs.writeFile(
    path.join(home, "auth.json"),
    JSON.stringify({ local: { type: "api_key", key: "sk-local-test" } }),
    { mode: 0o600 },
  );
  const modelServer = await startToolServer(argv);
  await fs.writeFile(
    path.join(home, "models.json"),
    JSON.stringify({
      providers: {
        local: {
          baseUrl: modelServer.baseUrl,
          apiKey: "sk-local-test",
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
  await new Promise((resolve, reject) => {
    const child = spawn("git", ["init", "-q"], { cwd: project });
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { project, home, modelServer };
}

test(
  "an explicit headless policy allows exact argv exec",
  {
    skip: SRT_SKIP,
  },
  async () => {
    await withTempDirectory("codepunk-headless-exec-", async (root) => {
      const argv = ["/bin/echo", "headless-exec"];
      const digestValue = digest(await fs.readFile("/bin/echo"));
      const { project, home, modelServer } = await setup(root, argv);
      const policy = path.join(root, "headless.toml");
      await fs.writeFile(
        policy,
        [
          "version = 1",
          "[allow]",
          'tools = ["exec"]',
          "[[allow.commands]]",
          `argv = ${JSON.stringify(argv)}`,
          `executable_sha256 = ${JSON.stringify(digestValue)}`,
          `cwd = ${JSON.stringify(project)}`,
          "",
        ].join("\n"),
      );
      try {
        const result = await runCli(
          [
            "-p",
            "run the approved command",
            "--model",
            "local/local-test",
            "--headless-policy",
            policy,
          ],
          { cwd: project, home },
        );
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /finished/u);
        const records = await readEvidence(home);
        const exec = records.find(
          (record) => record.tool === "exec" && record.decision === "allow",
        );
        assert.ok(exec, JSON.stringify(records));
        assert.deepEqual(exec.command_argv, argv);
        assert.equal(exec.executor, "srt");
        assert.equal(exec.coverage, "enforced");
        assert.match(exec.output_preview, /headless-exec/u);
      } finally {
        await new Promise((resolve) => modelServer.server.close(resolve));
      }
    });
  },
);

test(
  "an argv change is denied without a new approval",
  {
    skip: SRT_SKIP,
  },
  async () => {
    await withTempDirectory("codepunk-headless-exec-deny-", async (root) => {
      const approved = ["/bin/echo", "approved"];
      const requested = ["/bin/echo", "changed"];
      const digestValue = digest(await fs.readFile("/bin/echo"));
      const { project, home, modelServer } = await setup(root, requested);
      const policy = path.join(root, "headless.toml");
      await fs.writeFile(
        policy,
        [
          "version = 1",
          "[allow]",
          'tools = ["exec"]',
          "[[allow.commands]]",
          `argv = ${JSON.stringify(approved)}`,
          `executable_sha256 = ${JSON.stringify(digestValue)}`,
          `cwd = ${JSON.stringify(project)}`,
          "",
        ].join("\n"),
      );
      try {
        const result = await runCli(
          [
            "-p",
            "run the changed command",
            "--model",
            "local/local-test",
            "--headless-policy",
            policy,
          ],
          { cwd: project, home },
        );
        assert.equal(result.code, 0, result.stderr);
        const records = await readEvidence(home);
        const exec = records.find((record) => record.tool === "exec");
        assert.ok(exec);
        assert.equal(exec.decision, "deny");
        assert.deepEqual(exec.command_argv, requested);
      } finally {
        await new Promise((resolve) => modelServer.server.close(resolve));
      }
    });
  },
);

test(
  "a symlinked shell is denied despite an approved digest",
  {
    skip: SRT_SKIP,
  },
  async () => {
    await withTempDirectory("codepunk-headless-symlink-", async (root) => {
      const shell = path.join(root, "custom-shell");
      await fs.symlink("/bin/sh", shell);
      const argv = [shell, "-c", "printf shell-bypass"];
      const digestValue = digest(await fs.readFile(shell));
      const { project, home, modelServer } = await setup(root, argv);
      const policy = path.join(root, "headless.toml");
      await fs.writeFile(
        policy,
        [
          "version = 1",
          "[allow]",
          'tools = ["exec"]',
          "[[allow.commands]]",
          `argv = ${JSON.stringify(argv)}`,
          `executable_sha256 = ${JSON.stringify(digestValue)}`,
          `cwd = ${JSON.stringify(project)}`,
          "",
        ].join("\n"),
      );
      try {
        const result = await runCli(
          [
            "-p",
            "run the symlinked shell",
            "--model",
            "local/local-test",
            "--headless-policy",
            policy,
          ],
          { cwd: project, home },
        );
        assert.equal(result.code, 0, result.stderr);
        const records = await readEvidence(home);
        const exec = records.find((record) => record.tool === "exec");
        assert.ok(exec);
        assert.equal(exec.decision, "deny");
        assert.match(exec.output_preview, /launchers are not allowed/u);
      } finally {
        await new Promise((resolve) => modelServer.server.close(resolve));
      }
    });
  },
);

test(
  "a shebang script is denied as non-native",
  {
    skip: SRT_SKIP,
  },
  async () => {
    await withTempDirectory("codepunk-headless-script-", async (root) => {
      const script = path.join(root, "approved-script");
      await fs.writeFile(script, "#!/bin/sh\nprintf script-bypass\n", {
        mode: 0o755,
      });
      const argv = [script];
      const digestValue = digest(await fs.readFile(script));
      const { project, home, modelServer } = await setup(root, argv);
      const policy = path.join(root, "headless.toml");
      await fs.writeFile(
        policy,
        [
          "version = 1",
          "[allow]",
          'tools = ["exec"]',
          "[[allow.commands]]",
          `argv = ${JSON.stringify(argv)}`,
          `executable_sha256 = ${JSON.stringify(digestValue)}`,
          `cwd = ${JSON.stringify(project)}`,
          "",
        ].join("\n"),
      );
      try {
        const result = await runCli(
          [
            "-p",
            "run the script",
            "--model",
            "local/local-test",
            "--headless-policy",
            policy,
          ],
          { cwd: project, home },
        );
        assert.equal(result.code, 0, result.stderr);
        const records = await readEvidence(home);
        const exec = records.find((record) => record.tool === "exec");
        assert.ok(exec);
        assert.equal(exec.decision, "deny");
        assert.match(exec.output_preview, /native executables only/u);
      } finally {
        await new Promise((resolve) => modelServer.server.close(resolve));
      }
    });
  },
);

async function runInterpreterCase({ root, withScriptDigest, scriptBytes }) {
  const script = path.join(root, "approved.mjs");
  await fs.writeFile(script, 'process.stdout.write("SCRIPT_OK\\n");\n');
  const argv = [process.execPath, script];
  const exeDigest = digest(await fs.readFile(process.execPath));
  const scriptDigest = digest(scriptBytes);
  const { project, home, modelServer } = await setup(root, argv);
  const policy = path.join(root, "headless.toml");
  await fs.writeFile(
    policy,
    [
      "version = 1",
      "[allow]",
      'tools = ["exec"]',
      "[[allow.commands]]",
      `argv = ${JSON.stringify(argv)}`,
      `executable_sha256 = ${JSON.stringify(exeDigest)}`,
      ...(withScriptDigest
        ? [`script_sha256 = ${JSON.stringify(scriptDigest)}`]
        : []),
      `cwd = ${JSON.stringify(project)}`,
      "",
    ].join("\n"),
  );
  try {
    const result = await runCli(
      [
        "-p",
        "run the approved script",
        "--model",
        "local/local-test",
        "--headless-policy",
        policy,
      ],
      { cwd: project, home },
    );
    assert.equal(result.code, 0, result.stderr);
    const records = await readEvidence(home);
    const exec = records.find((record) => record.tool === "exec");
    assert.ok(exec);
    return exec;
  } finally {
    await new Promise((resolve) => modelServer.server.close(resolve));
  }
}

test(
  "an interpreter is allowed once its script digest is approved",
  {
    skip: SRT_SKIP,
  },
  async () => {
    await withTempDirectory("codepunk-headless-interp-", async (root) => {
      const bytes = Buffer.from('process.stdout.write("SCRIPT_OK\\n");\n');
      const exec = await runInterpreterCase({
        root,
        withScriptDigest: true,
        scriptBytes: bytes,
      });
      assert.equal(exec.decision, "allow");
      assert.match(exec.output_preview, /SCRIPT_OK/u);
    });
  },
);

test(
  "an interpreter without a pinned script digest stays denied",
  {
    skip: SRT_SKIP,
  },
  async () => {
    await withTempDirectory("codepunk-headless-interp-", async (root) => {
      const exec = await runInterpreterCase({
        root,
        withScriptDigest: false,
        scriptBytes: Buffer.from(""),
      });
      assert.equal(exec.decision, "deny");
      assert.match(exec.output_preview, /launchers are not allowed/u);
    });
  },
);

test(
  "an interpreter whose script digest changed is denied",
  {
    skip: SRT_SKIP,
  },
  async () => {
    await withTempDirectory("codepunk-headless-interp-", async (root) => {
      const exec = await runInterpreterCase({
        root,
        withScriptDigest: true,
        scriptBytes: Buffer.from("not the approved script\n"),
      });
      assert.equal(exec.decision, "deny");
      assert.match(exec.output_preview, /approved script digest changed/u);
    });
  },
);

test("a headless policy inside the repository is refused", async () => {
  await withTempDirectory("codepunk-headless-inside-", async (root) => {
    const { project, modelServer } = await setup(root, ["/bin/echo", "x"]);
    try {
      const policy = path.join(project, "headless.toml");
      await fs.writeFile(policy, "version = 1\n[allow]\ntools = []\n");
      const result = await runCli(
        ["-p", "hello", "--headless-policy", policy],
        { cwd: project, home: path.join(root, "home") },
      );
      assert.equal(result.code, 1);
      assert.match(result.stderr, /outside the repository/u);
    } finally {
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("print mode refuses an exhausted session budget", async () => {
  await withTempDirectory("codepunk-headless-budget-", async (root) => {
    const { project, home, modelServer } = await setup(root, [
      "/bin/echo",
      "unused",
    ]);
    try {
      await fs.writeFile(
        path.join(home, "config.toml"),
        "[budget]\nmax_tokens = 1\n",
      );
      const first = await runCli(
        ["-p", "first prompt", "--model", "local/local-test"],
        { cwd: project, home },
      );
      assert.equal(first.code, 0, first.stderr);
      assert.match(first.stdout, /finished/u);

      const listed = await runCli(["sessions", "--json"], {
        cwd: project,
        home,
      });
      assert.equal(listed.code, 0, listed.stderr);
      const sessionId = JSON.parse(listed.stdout)[0].id;

      const second = await runCli(
        [
          "--session",
          sessionId,
          "-p",
          "second prompt",
          "--model",
          "local/local-test",
        ],
        { cwd: project, home },
      );
      assert.equal(second.code, 1);
      assert.match(
        second.stderr,
        /session budget exhausted \(6\/1 tokens\); start a new session to continue/u,
      );
      assert.doesNotMatch(second.stdout, /finished/u);
    } finally {
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("plugins are not loadable in print mode", async () => {
  await withTempDirectory("codepunk-headless-plugin-", async (root) => {
    const { project, home, modelServer } = await setup(root, [
      "/bin/echo",
      "unused",
    ]);
    try {
      const result = await runCli(["-p", "hello", "--allow-plugins"], {
        cwd: project,
        home,
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /--allow-plugins is interactive only/u);
    } finally {
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});
