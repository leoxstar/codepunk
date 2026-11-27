import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { importCore, importProtocol } from "./support/core.mjs";
import {
  makeProject,
  trustWorkspace,
  withTempDirectory,
  writeFile,
} from "./support/helpers.mjs";
import { TEST_MODEL } from "./support/pi-model.mjs";

const core = await importCore();
const protocol = await importProtocol();
const execFileAsync = promisify(execFile);

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

async function waitForPidExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") {
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return false;
}

const ISOLATED_PLUGIN_ENTRY = [
  "export default function (pi) {",
  "  pi.registerTool({",
  '    name: "inspect_env",',
  '    label: "Inspect Env",',
  '    description: "return child pid and scrubbed env check",',
  '    parameters: { type: "object", properties: {}, additionalProperties: false },',
  "    async execute() {",
  "      return {",
  "        content: [",
  "          {",
  '            type: "text",',
  "            text: JSON.stringify({",
  "              pid: process.pid,",
  "              hasCodepunkHome: Boolean(process.env.CODEPUNK_HOME),",
  "            }),",
  "          },",
  "        ],",
  "        details: {},",
  "      };",
  "    },",
  "  });",
  "  pi.registerTool({",
  '    name: "host_proxy",',
  '    label: "Host Proxy",',
  '    description: "invoke a main-process product tool via IPC",',
  "    parameters: {",
  '      type: "object",',
  "      properties: {",
  '        tool: { type: "string" },',
  '        args: { type: "object" },',
  "      },",
  '      required: ["tool"],',
  "    },",
  "    async execute(_callId, params, _signal, _onUpdate, context) {",
  "      try {",
  "        const res = await context.callTool(params.tool, params.args ?? {});",
  "        return {",
  '          content: [{ type: "text", text: JSON.stringify({ ok: true, res }) }],',
  "          details: {},",
  "        };",
  "      } catch (err) {",
  "        return {",
  "          content: [",
  "            {",
  '              type: "text",',
  "              text: JSON.stringify({",
  "                ok: false,",
  '                code: err && typeof err === "object" ? err.code : "unknown",',
  "                message: err instanceof Error ? err.message : String(err),",
  "              }),",
  "            },",
  "          ],",
  "          details: {},",
  "        };",
  "      }",
  "    },",
  "  });",
  "}",
  "",
].join("\n");

async function installIsolatedFixturePlugin(home, id = "inspector") {
  const pluginDir = path.join(home, "extensions", id);
  await writeFile(
    path.join(pluginDir, "plugin.toml"),
    [
      `id = "${id}"`,
      'version = "1.2.0"',
      'entry = "index.mjs"',
      'tools = ["inspect_env", "host_proxy"]',
      'capabilities = ["tools", "filesystem.read", "filesystem.write"]',
      "",
    ].join("\n"),
  );
  await writeFile(path.join(pluginDir, "index.mjs"), ISOLATED_PLUGIN_ENTRY);
  return core.loadPluginManifest(pluginDir);
}

test("isolated plugin runs in a guarded child host with evidence and session events", async () => {
  await withTempDirectory("codepunk-plugin-w2-pos-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
    await trustWorkspace(paths.home, projectRoot);
    await writeFile(
      path.join(paths.home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await writeFile(path.join(projectRoot, "README.md"), "HELLO_FROM_MAIN\n");
    const manifest = await installIsolatedFixturePlugin(paths.home);

    const approvals = [];
    const runtime = await core.createRuntime({
      cwd: projectRoot,
      environment: { CODEPUNK_HOME: paths.home },
      model: TEST_MODEL,
      allowPlugins: true,
      approvalChannel: {
        id: "tui-test",
        kind: "tui",
        isTTY: true,
        async ask(request) {
          approvals.push(request);
          return answerFor(request, { scope: "once" });
        },
      },
    });

    let childPid = 0;
    try {
      assert.equal(runtime.plugins.enabled, true);
      assert.ok(runtime.plugins.paths.includes(manifest.manifestPath));
      // Directory plugin must NOT be passed into Pi's in-process extension loader
      assert.equal(
        runtime.host.services.resourceLoader
          .getExtensions()
          .extensions.some((ext) =>
            String(ext.path ?? "").includes("inspector"),
          ),
        false,
      );

      const inspectTool = runtime.host.session.getToolDefinition(
        "plugin__inspector__inspect_env",
      );
      assert.ok(inspectTool, "expected wrapped isolated plugin tool");

      const inspectRes = await inspectTool.execute(
        "call-inspect-1",
        {},
        undefined,
        undefined,
        { cwd: projectRoot },
      );
      const parsed = JSON.parse(inspectRes.content[0].text);
      childPid = parsed.pid;
      assert.ok(childPid > 0 && childPid !== process.pid);
      assert.equal(parsed.hasCodepunkHome, false);
      assert.equal(approvals.length, 1);

      // Plugin calls back into main-process `read` tool over IPC
      const proxyTool = runtime.host.session.getToolDefinition(
        "plugin__inspector__host_proxy",
      );
      assert.ok(proxyTool);
      const readRes = await proxyTool.execute(
        "call-proxy-read-1",
        { tool: "read", args: { path: "README.md" } },
        undefined,
        undefined,
        { cwd: projectRoot },
      );
      const proxyPayload = JSON.parse(readRes.content[0].text);
      assert.equal(proxyPayload.ok, true);
      assert.match(proxyPayload.res.content[0].text, /HELLO_FROM_MAIN/u);

      const startedEvent = runtime.session.allEvents.find(
        (event) => event.kind === "plugin/started",
      );
      assert.ok(startedEvent);
      assert.equal(startedEvent.data.plugin_id, "inspector");
      assert.equal(startedEvent.data.pid, childPid);
      assert.equal(startedEvent.data.credential_verified, true);
      assert.equal(
        protocol.validateSchema(protocol.SessionEventSchema, startedEvent).ok,
        true,
      );

      const toolEvents = runtime.session.allEvents.filter(
        (event) => event.kind === "plugin/tool_call",
      );
      assert.ok(toolEvents.length >= 2);
      for (const event of toolEvents) {
        assert.equal(
          protocol.validateSchema(protocol.SessionEventSchema, event).ok,
          true,
        );
        assert.equal(event.data.plugin_id, "inspector");
        assert.equal(
          event.data.plugin_manifest_sha256,
          manifest.manifestSha256,
        );
        assert.equal(event.data.executor, "child-host");
      }

      const evidenceFile = await core.readEvidenceFile(runtime.ledger.filePath);
      const pluginRecords = evidenceFile.records.filter(
        (record) => record.plugin_id === "inspector",
      );
      assert.equal(pluginRecords.length, 3);
      for (const record of pluginRecords) {
        assert.equal(record.source, "plugin");
        assert.equal(record.executor, "child-host");
        assert.equal(record.plugin_manifest_sha256, manifest.manifestSha256);
      }
    } finally {
      await runtime.dispose();
    }

    if (process.platform !== "win32" && childPid > 0) {
      assert.equal(
        await waitForPidExit(childPid),
        true,
        "plugin child host must be reaped after runtime.dispose()",
      );
    }
  });
});

test("plugin IPC frame timeout cancel and approval routing enforce main-process policy and approval", async () => {
  await withTempDirectory("codepunk-plugin-w2-neg-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
    await writeFile(
      path.join(paths.home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await installIsolatedFixturePlugin(paths.home);

    let approveShell = false;
    const runtime = await core.createRuntime({
      cwd: projectRoot,
      environment: { CODEPUNK_HOME: paths.home },
      model: TEST_MODEL,
      allowPlugins: true,
      allowUnsandboxedShell: true,
      approvalChannel: {
        id: "tui-test",
        kind: "tui",
        isTTY: true,
        async ask(request) {
          if (request.tool === "bash") {
            return answerFor(request, {
              answer: approveShell ? "allow" : "deny",
              scope: "once",
            });
          }
          return answerFor(request, { answer: "allow", scope: "once" });
        },
      },
    });

    try {
      const proxyTool = runtime.host.session.getToolDefinition(
        "plugin__inspector__host_proxy",
      );
      assert.ok(proxyTool);

      // Negative control 1: plugin attempts to write protected .codepunk/config.toml
      const protectedPath = path.join(projectRoot, ".codepunk", "hacked.toml");
      const policyDeniedRes = await proxyTool.execute(
        "call-policy-deny",
        {
          tool: "write",
          args: { path: ".codepunk/hacked.toml", content: "bad = true\n" },
        },
        undefined,
        undefined,
        { cwd: projectRoot },
      );
      const policyDenied = JSON.parse(policyDeniedRes.content[0].text);
      assert.equal(policyDenied.ok, false);
      assert.equal(policyDenied.code, "plugin.policy_denied");
      await assert.rejects(fs.stat(protectedPath), { code: "ENOENT" });

      // Negative control 2: plugin attempts bash when human denies approval
      const createdByPlugin = path.join(projectRoot, "plugin-shell-dir");
      approveShell = false;
      const approvalDeniedRes = await proxyTool.execute(
        "call-approval-deny",
        {
          tool: "bash",
          args: { command: "mkdir plugin-shell-dir" },
        },
        undefined,
        undefined,
        { cwd: projectRoot },
      );
      const approvalDenied = JSON.parse(approvalDeniedRes.content[0].text);
      assert.equal(approvalDenied.ok, false);
      assert.equal(approvalDenied.code, "plugin.approval_denied");
      await assert.rejects(fs.stat(createdByPlugin), { code: "ENOENT" });

      // Positive control: human grants once approval -> executes; next call still requires fresh approval!
      approveShell = true;
      const approvalAllowedRes = await proxyTool.execute(
        "call-approval-allow",
        {
          tool: "bash",
          args: { command: "mkdir plugin-shell-dir" },
        },
        undefined,
        undefined,
        { cwd: projectRoot },
      );
      const approvalAllowed = JSON.parse(approvalAllowedRes.content[0].text);
      assert.equal(approvalAllowed.ok, true);
      assert.equal((await fs.stat(createdByPlugin)).isDirectory(), true);

      // Subsequent bash call cannot replay the previous `once` approval
      approveShell = false;
      const secondDir = path.join(projectRoot, "plugin-shell-dir-2");
      const replayBlockedRes = await proxyTool.execute(
        "call-approval-no-replay",
        {
          tool: "bash",
          args: { command: "mkdir plugin-shell-dir-2" },
        },
        undefined,
        undefined,
        { cwd: projectRoot },
      );
      const replayBlocked = JSON.parse(replayBlockedRes.content[0].text);
      assert.equal(replayBlocked.ok, false);
      assert.equal(replayBlocked.code, "plugin.approval_denied");
      await assert.rejects(fs.stat(secondDir), { code: "ENOENT" });

      // Verify denied calls are recorded in both EvidenceLedger and SessionStore
      const deniedToolEvents = runtime.session.allEvents.filter(
        (event) =>
          event.kind === "plugin/tool_call" && event.data.decision === "deny",
      );
      assert.equal(deniedToolEvents.length, 3);
    } finally {
      await runtime.dispose();
    }
  });
});

test("unmanifested plugin directories fail closed and isolation flags prevent plugin child startup", async () => {
  await withTempDirectory("codepunk-plugin-w2-gates-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    await writeFile(
      path.join(paths.home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n\n[plugins]\nenabled = true\n',
    );
    const canaryMarker = path.join(root, "canary-ran.txt");
    await writeFile(
      path.join(paths.home, "extensions", "unmanifested-dir", "index.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(canaryMarker)}, "ran");`,
        "export default () => {};",
        "",
      ].join("\n"),
    );
    await installIsolatedFixturePlugin(paths.home, "valid-iso");

    // 1. --no-plugins prevents any child host from starting
    const disabledRuntime = await core.createRuntime({
      cwd: projectRoot,
      environment: { CODEPUNK_HOME: paths.home },
      model: TEST_MODEL,
      disablePlugins: true,
    });
    try {
      assert.equal(disabledRuntime.plugins.enabled, false);
      assert.equal(
        disabledRuntime.session.allEvents.some(
          (event) => event.kind === "plugin/started",
        ),
        false,
      );
    } finally {
      await disabledRuntime.dispose();
    }

    // 2. Enabled runtime starts `valid-iso` in child host, rejects `unmanifested-dir` fail-closed
    const activeRuntime = await core.createRuntime({
      cwd: projectRoot,
      environment: { CODEPUNK_HOME: paths.home },
      model: TEST_MODEL,
    });
    try {
      assert.equal(activeRuntime.plugins.enabled, true);
      assert.ok(
        activeRuntime.plugins.errors.some((err) =>
          err.includes("plugin.manifest_missing"),
        ),
      );
      await assert.rejects(fs.stat(canaryMarker), { code: "ENOENT" });
      assert.equal(
        activeRuntime.session.allEvents.some(
          (event) =>
            event.kind === "plugin/started" &&
            event.data.plugin_id === "valid-iso",
        ),
        true,
      );
    } finally {
      await activeRuntime.dispose();
    }
  });
});
