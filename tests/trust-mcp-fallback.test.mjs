import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { importCore } from "./support/core.mjs";
import { withTempDirectory, writeFile } from "./support/helpers.mjs";
import { TEST_MODEL } from "./support/pi-model.mjs";

const core = await importCore();
const execFileAsync = promisify(execFile);
const MCP_ECHO_SERVER = path.join(
  import.meta.dirname,
  "support",
  "mcp-echo-server.mjs",
);

async function makeGitRepo(root) {
  const project = path.join(root, "project");
  await fs.mkdir(project, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: project });
  return project;
}

test("trusted .mcp.json loads project MCP servers while user-scope mcp.toml takes precedence on collisions", async () => {
  await withTempDirectory("codepunk-dot-mcp-json-", async (root) => {
    const project = await makeGitRepo(root);
    const home = path.join(root, "home");
    const projectPid = path.join(root, "dot-mcp.pid");
    const userPid = path.join(root, "user-mcp.pid");
    const shadowedPid = path.join(root, "shadowed-mcp.pid");

    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await writeFile(
      path.join(home, "mcp.toml"),
      [
        "[servers.shared]",
        `command = ${JSON.stringify(process.execPath)}`,
        `args = [${JSON.stringify(MCP_ECHO_SERVER)}]`,
        "[servers.shared.env]",
        `CODEPUNK_MCP_FIXTURE_PID_FILE = ${JSON.stringify(userPid)}`,
      ].join("\n"),
    );
    await writeFile(
      path.join(project, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            shared: {
              command: process.execPath,
              args: [MCP_ECHO_SERVER],
              env: { CODEPUNK_MCP_FIXTURE_PID_FILE: shadowedPid },
            },
            repo_echo: {
              command: process.execPath,
              args: [MCP_ECHO_SERVER],
              env: { CODEPUNK_MCP_FIXTURE_PID_FILE: projectPid },
            },
          },
        },
        null,
        2,
      ),
    );

    const runtime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      model: TEST_MODEL,
      projectTrust: {
        config: true,
        policy: true,
        skills: true,
        instructions: true,
      },
    });
    try {
      assert.deepEqual([...runtime.mcpServers].sort(), ["repo_echo", "shared"]);
      await fs.access(userPid);
      await fs.access(projectPid);
      await assert.rejects(
        () => fs.access(shadowedPid),
        "project .mcp.json must not shadow user-scope server of same name",
      );
      assert.equal(
        runtime.host.session
          .getAllTools()
          .some((t) => t.name.startsWith("mcp__repo_echo__")),
        true,
      );
    } finally {
      await runtime.dispose();
    }
  });
});

test("interactive standard mode degrades gracefully to human-approved UnsandboxedShell when srt is unavailable, while auto and headless fail closed", async () => {
  await withTempDirectory("codepunk-standard-fallback-", async (root) => {
    const project = await makeGitRepo(root);
    const home = path.join(root, "home");
    await fs.mkdir(home, { recursive: true });

    const failingCreateSandbox = async () => {
      throw new core.SandboxUnavailableError("bwrap missing on host");
    };

    let approvalCount = 0;
    const channel = {
      id: "test-tty",
      kind: "cli",
      isTTY: true,
      async ask(request) {
        approvalCount += 1;
        assert.match(request.reason ?? "", /degraded unsandboxed shell/u);
        assert.match(
          request.coverage_preview ?? "",
          /no srt sandbox; this command runs directly on your machine/u,
        );
        return {
          request_id: request.request_id,
          answer: "allow",
          scope: "once",
          channel: "cli",
          channel_id: "test-tty",
          nonce_sha256: request.nonce_sha256,
          worker_id: request.worker_id,
          session_id: request.session_id,
          tool_call_id: request.tool_call_id,
          answered_at: new Date().toISOString(),
        };
      },
    };

    const standardRuntime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      model: TEST_MODEL,
      approvalChannel: channel,
      createSandbox: failingCreateSandbox,
    });
    try {
      const resolved = await standardRuntime.sandboxReady;
      assert.ok(resolved);
      assert.equal(resolved.sandboxed, false);
      assert.match(
        standardRuntime.loadedConfig.warnings.join("\n"),
        /standard interactive mode degraded to per-command human-approved unsandboxed shell/u,
      );

      const bashDef = standardRuntime.host.session.getToolDefinition("bash");
      assert.ok(bashDef, "bash remains registered in degraded standard mode");
      const out = await bashDef.execute(
        "degraded-bash-1",
        { command: "printf degraded_ok" },
        undefined,
        undefined,
        {},
      );
      assert.notEqual(out.isError, true);
      assert.equal(
        approvalCount,
        1,
        "even routine shell requires human approval when degraded",
      );
      const lastRecord = standardRuntime.ledger.all.at(-1);
      assert.equal(lastRecord?.decision, "allow");
      assert.equal(lastRecord?.coverage, "uncovered");
      assert.equal(lastRecord?.executor, "direct");

      // Live switch to auto mode must immediately cut off unsandboxed fallback and fail closed!
      standardRuntime.setApprovalMode("auto");
      const autoDenied = await bashDef.execute(
        "degraded-bash-auto-blocked",
        { command: "printf must_not_run" },
        undefined,
        undefined,
        {},
      );
      assert.equal(autoDenied.isError, true);
      assert.equal(
        standardRuntime.ledger.all.at(-1)?.rule,
        "sandbox.unavailable",
      );
    } finally {
      await standardRuntime.dispose();
    }

    // Counterexample 1: auto startup fails closed when srt is unavailable
    await writeFile(
      path.join(home, "config.toml"),
      '[approval]\nmode = "auto"\n',
    );
    const delayedFailingCreateSandbox = async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new core.SandboxUnavailableError("bwrap missing on host");
    };
    const autoRuntime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      model: TEST_MODEL,
      approvalChannel: channel,
      createSandbox: delayedFailingCreateSandbox,
    });
    try {
      const bashDef = autoRuntime.host.session.getToolDefinition("bash");
      const resolvedAuto = await autoRuntime.sandboxReady;
      assert.equal(resolvedAuto, null);
      if (bashDef !== undefined) {
        const res = await bashDef.execute(
          "auto-fail-closed",
          { command: "printf no" },
          undefined,
          undefined,
          {},
        );
        assert.equal(res.isError, true);
        assert.equal(
          autoRuntime.ledger.all.at(-1)?.rule,
          "sandbox.unavailable",
        );
      }
      assert.match(
        autoRuntime.loadedConfig.warnings.join("\n"),
        /sandbox required but srt is unavailable/u,
      );
    } finally {
      await autoRuntime.dispose();
    }

    // Counterexample 2: headless mode fails closed even when approval=ask and autonomy=ask
    await writeFile(
      path.join(home, "config.toml"),
      '[approval]\nmode = "ask"\n',
    );
    const headlessRuntime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      model: TEST_MODEL,
      headless: true,
      createSandbox: failingCreateSandbox,
    });
    try {
      const resolvedHeadless = await headlessRuntime.sandboxReady;
      assert.equal(resolvedHeadless, null);
      assert.equal(
        headlessRuntime.host.session.getToolDefinition("bash"),
        undefined,
        "headless never falls back to UnsandboxedShell",
      );
      assert.match(
        headlessRuntime.loadedConfig.warnings.join("\n"),
        /sandbox required but srt is unavailable/u,
      );
    } finally {
      await headlessRuntime.dispose();
    }
  });
});
