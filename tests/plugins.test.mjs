import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { importCore, importProtocol } from "./support/core.mjs";
import {
  createLinkedEntry,
  makeProject,
  trustWorkspace,
  withTempDirectory,
  writeFile,
} from "./support/helpers.mjs";
import { TEST_MODEL } from "./support/pi-model.mjs";

const core = await importCore();
const protocol = await importProtocol();
const execFileAsync = promisify(execFile);

async function createHost(paths, extensionPaths, sessionId, overrides = {}) {
  const ledger = await core.EvidenceLedger.open(
    path.join(paths.evidenceDir, `${sessionId}.jsonl`),
  );
  const store = await core.SessionStore.create({
    rootDir: paths.home,
    cwd: paths.cwd,
    projectRoot: paths.deliveryRoot,
    projectId: paths.projectId,
    sessionId,
    heartbeatMs: 60_000,
  });
  const host = await core.createPiHost({
    cwd: paths.cwd,
    workspaceRoot: paths.deliveryRoot,
    deliveryRoot: paths.deliveryRoot,
    codepunkHome: paths.home,
    sessionId: store.sessionId,
    runId: "run-plugin",
    writeSet: [paths.cwd],
    mode: "interactive",
    approval: null,
    ledger,
    sandbox: null,
    sessionStore: store,
    extensionPaths,
    bindMode: "print",
    ...overrides,
  });
  return { host, store };
}

test("user plugins are opt-in and project plugins are never scanned", async () => {
  await withTempDirectory("codepunk-plugin-", async (root) => {
    const { paths } = await makeProject(root);
    const extensionDir = path.join(paths.home, "extensions");
    const pluginPath = path.join(extensionDir, "hello.mjs");
    await writeFile(pluginPath, "export default function () {}\n");
    const projectPlugin = path.join(
      paths.projectConfigDir,
      "extensions",
      "project.mjs",
    );
    await writeFile(projectPlugin, "export default function () {}\n");
    const disabled = await core.loadUserPlugins({
      allowed: false,
      extensionDir,
    });
    assert.deepEqual(disabled.paths, []);
    assert.equal(disabled.summary.enabled, false);
    const enabled = await core.loadUserPlugins({
      allowed: true,
      extensionDir,
    });
    assert.deepEqual(enabled.paths, [pluginPath]);
    assert.equal(enabled.paths.includes(projectPlugin), false);
  });
});

function sessionFrame(kind, data) {
  return {
    type: "codepunk/event",
    version: 1,
    seq: 1,
    at: "2026-11-18T00:00:00.000Z",
    kind,
    data,
  };
}

test("plugin events validate against the session schema", () => {
  const manifest = `sha256:${"a".repeat(64)}`;
  const started = sessionFrame("plugin/started", {
    plugin_id: "hello",
    version: "1.0.0",
    manifest_sha256: manifest,
    pid: 4242,
    credential_verified: true,
    started_at: "2026-11-18T00:00:00.000Z",
  });
  const call = sessionFrame("plugin/tool_call", {
    run_id: "run-1",
    tool_call_id: "call-1",
    plugin_id: "hello",
    plugin_manifest_sha256: manifest,
    executor: "child-host",
    decision: "allow",
    approval: null,
    outcome: "completed",
    reason: null,
  });
  const stopped = sessionFrame("plugin/stopped", {
    plugin_id: "hello",
    pid: 4242,
    credential_verified: true,
    reason: "exit",
    exit_code: 0,
    stopped_at: "2026-11-18T00:00:01.000Z",
  });
  for (const event of [started, call, stopped]) {
    const validation = protocol.validateSchema(
      protocol.SessionEventSchema,
      event,
    );
    assert.ok(
      validation.ok,
      `${event.kind} failed schema: ${JSON.stringify(validation)}`,
    );
  }

  const missingCredential = structuredClone(stopped);
  delete missingCredential.data.credential_verified;
  assert.equal(
    protocol.validateSchema(protocol.SessionEventSchema, missingCredential).ok,
    false,
  );
  const wrongExecutor = structuredClone(call);
  wrongExecutor.data.executor = "in-process";
  assert.equal(
    protocol.validateSchema(protocol.SessionEventSchema, wrongExecutor).ok,
    false,
  );
});

test("plugin IPC frames reject malformed requests and responses", () => {
  const request = {
    type: "codepunk/plugin-request",
    version: 1,
    call_id: "call-1",
    plugin_id: "hello",
    method: "tools/call",
    params: { name: "read" },
    timeout_ms: 1000,
  };
  assert.equal(
    protocol.validateSchema(protocol.PluginRequestSchema, request).ok,
    true,
  );

  const unknownField = structuredClone(request);
  unknownField.argv = ["/bin/sh"];
  assert.equal(
    protocol.validateSchema(protocol.PluginRequestSchema, unknownField).ok,
    false,
  );

  const unknownMethod = structuredClone(request);
  unknownMethod.method = "tools/spawn";
  assert.equal(
    protocol.validateSchema(protocol.PluginRequestSchema, unknownMethod).ok,
    false,
  );

  const response = {
    type: "codepunk/plugin-response",
    version: 1,
    call_id: "call-1",
    plugin_id: "hello",
    ok: false,
    error: {
      code: "plugin.timeout",
      message: "timed out",
      retryable: false,
    },
  };
  assert.equal(
    protocol.validateSchema(protocol.PluginResponseSchema, response).ok,
    true,
  );
  const unknownCode = structuredClone(response);
  unknownCode.error.code = "plugin.magic";
  assert.equal(
    protocol.validateSchema(protocol.PluginResponseSchema, unknownCode).ok,
    false,
  );
  assert.ok(protocol.PLUGIN_MAX_FRAME_BYTES > 0);
});

const PLUGIN_ENTRY = [
  'import { spawn } from "node:child_process";',
  "export default function (pi) {",
  "  pi.registerTool({",
  '    name: "echo",',
  '    label: "Echo",',
  '    description: "echo text",',
  '    parameters: { type: "object", properties: { text: { type: "string" } } },',
  "    async execute(_id, params) {",
  '      return { content: [{ type: "text", text: String(params.text ?? "") }], details: {} };',
  "    },",
  "  });",
  "  pi.registerTool({",
  '    name: "slow",',
  '    label: "Slow",',
  '    description: "wait",',
  '    parameters: { type: "object", properties: { ms: { type: "number" } } },',
  "    async execute(_id, params, signal) {",
  "      await new Promise((resolve, reject) => {",
  "        const timer = setTimeout(resolve, Number(params.ms ?? 1000));",
  '        signal?.addEventListener("abort", () => {',
  "          clearTimeout(timer);",
  '          reject(new Error("cancelled"));',
  "        });",
  "      });",
  '      return { content: [{ type: "text", text: "slow" }], details: {} };',
  "    },",
  "  });",
  "  pi.registerTool({",
  '    name: "grandchild",',
  '    label: "Grandchild",',
  '    description: "spawn a grandchild",',
  '    parameters: { type: "object", properties: {} },',
  "    async execute() {",
  '      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
  '      return { content: [{ type: "text", text: String(child.pid) }], details: {} };',
  "    },",
  "  });",
  '  pi.registerCommand("hello", { description: "hello" });',
  "}",
  "",
].join("\n");

async function writePluginFixture(root, overrides = {}) {
  const dir = path.join(root, "extensions", overrides.id ?? "hello");
  await writeFile(
    path.join(dir, "plugin.toml"),
    overrides.manifest ??
      [
        'id = "hello"',
        'version = "1.0.0"',
        'entry = "index.mjs"',
        'tools = ["echo", "slow", "grandchild"]',
        'commands = ["hello"]',
        'capabilities = ["tools", "commands"]',
        "",
      ].join("\n"),
  );
  await writeFile(path.join(dir, "index.mjs"), overrides.entry ?? PLUGIN_ENTRY);
  return dir;
}

test("plugin manifest and capability validation", async () => {
  await withTempDirectory("codepunk-plugin-manifest-", async (root) => {
    const dir = await writePluginFixture(root);
    const manifest = await core.loadPluginManifest(dir);
    assert.equal(manifest.id, "hello");
    assert.equal(manifest.entry, path.join(manifest.dir, "index.mjs"));
    assert.match(manifest.manifestSha256, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(manifest.tools, ["echo", "grandchild", "slow"]);
    assert.deepEqual(manifest.commands, ["hello"]);

    await assert.rejects(
      core.loadPluginManifest(path.join(root, "missing")),
      (error) => error.code === "plugin.manifest_missing",
    );

    const unknown = path.join(root, "unknown");
    await writeFile(
      path.join(unknown, "plugin.toml"),
      'id = "bad"\nversion = "1.0.0"\nentry = "index.mjs"\nargv = ["/bin/sh"]\n',
    );
    await writeFile(
      path.join(unknown, "index.mjs"),
      "export default () => {};\n",
    );
    await assert.rejects(
      core.loadPluginManifest(unknown),
      (error) => error.code === "plugin.manifest_unknown_field",
    );

    const escape = path.join(root, "escape");
    await writeFile(
      path.join(escape, "plugin.toml"),
      'id = "escape"\nversion = "1.0.0"\nentry = "../outside.mjs"\n',
    );
    await assert.rejects(
      core.loadPluginManifest(escape),
      (error) => error.code === "plugin.manifest_invalid",
    );

    const capability = path.join(root, "capability");
    await writeFile(
      path.join(capability, "plugin.toml"),
      'id = "capability"\nversion = "1.0.0"\nentry = "index.mjs"\ncapabilities = ["shell"]\n',
    );
    await writeFile(
      path.join(capability, "index.mjs"),
      "export default () => {};\n",
    );
    await assert.rejects(
      core.loadPluginManifest(capability),
      (error) => error.code === "plugin.capability_unknown",
    );

    const undeclared = path.join(root, "undeclared");
    await writeFile(
      path.join(undeclared, "plugin.toml"),
      'id = "undeclared"\nversion = "1.0.0"\nentry = "index.mjs"\ntools = ["echo"]\n',
    );
    await writeFile(
      path.join(undeclared, "index.mjs"),
      "export default () => {};\n",
    );
    await assert.rejects(
      core.loadPluginManifest(undeclared),
      (error) => error.code === "plugin.manifest_invalid",
    );
  });
});

test("plugin runs in a guarded child host", async () => {
  await withTempDirectory("codepunk-plugin-host-", async (root) => {
    const dir = await writePluginFixture(root);
    const events = [];
    const manifest = await core.loadPluginManifest(dir);
    const host = await core.PluginHost.start({
      manifest,
      onEvent: (kind, data) => {
        events.push({ kind, data });
      },
    });
    try {
      assert.notEqual(host.pid, process.pid);
      assert.deepEqual(host.tools, ["echo", "grandchild", "slow"]);
      assert.deepEqual(host.commands, ["hello"]);
      const result = await host.callTool("echo", { text: "hello" });
      assert.equal(result.content[0].text, "hello");
      assert.equal(events[0].kind, "plugin/started");
      assert.equal(events[0].data.pid, host.pid);
      assert.equal(events[0].data.credential_verified, true);
      assert.equal(events[0].data.plugin_id, "hello");
    } finally {
      await host.stop();
    }
    assert.equal(events.at(-1).kind, "plugin/stopped");
    assert.equal(events.at(-1).data.credential_verified, true);
  });
});

test("plugin IPC frame timeout cancel and duplicate call routing", async () => {
  await withTempDirectory("codepunk-plugin-ipc-", async (root) => {
    const dir = await writePluginFixture(root);
    const manifest = await core.loadPluginManifest(dir);
    const host = await core.PluginHost.start({ manifest });
    try {
      const first = host.callTool("slow", { ms: 500 }, { callId: "same" });
      await assert.rejects(
        host.callTool("slow", { ms: 500 }, { callId: "same" }),
        (error) => error.code === "plugin.duplicate_call",
      );
      await host.cancel("same");
      await assert.rejects(first, (error) => error.code === "plugin.cancelled");

      await assert.rejects(
        host.callTool("slow", { ms: 500 }, { timeoutMs: 20 }),
        (error) => error.code === "plugin.timeout",
      );
      await assert.rejects(
        host.callTool("echo", {
          text: "x".repeat(protocol.PLUGIN_MAX_FRAME_BYTES),
        }),
        (error) => error.code === "plugin.frame_too_large",
      );
      await assert.rejects(
        host.request("tools/spawn", {}),
        (error) => error.code === "plugin.unknown_method",
      );
    } finally {
      await host.stop();
    }
  });
});

test(
  "plugin process tree is terminated on stop",
  { skip: process.platform === "win32" },
  async () => {
    await withTempDirectory("codepunk-plugin-tree-", async (root) => {
      const dir = await writePluginFixture(root);
      const manifest = await core.loadPluginManifest(dir);
      const host = await core.PluginHost.start({ manifest });
      const result = await host.callTool("grandchild", {});
      const grandchild = Number(result.content[0].text);
      assert.ok(grandchild > 0);
      await host.stop();
      const deadline = Date.now() + 5_000;
      let alive = true;
      while (Date.now() < deadline) {
        try {
          process.kill(grandchild, 0);
        } catch (error) {
          if (error.code === "ESRCH") {
            alive = false;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(alive, false, "grandchild survived plugin shutdown");
    });
  },
);

test("a user command plugin loads through the guarded host", async () => {
  await withTempDirectory("codepunk-plugin-host-", async (root) => {
    const { paths } = await makeProject(root);
    const extensionDir = path.join(paths.home, "extensions");
    const marker = path.join(root, "plugin-loaded.txt");
    const pluginPath = path.join(extensionDir, "hello.mjs");
    await writeFile(
      pluginPath,
      [
        'import { writeFileSync } from "node:fs";',
        "export default function (pi) {",
        `  writeFileSync(${JSON.stringify(marker)}, "loaded");`,
        '  pi.registerCommand("codepunk-plugin-hello", {',
        '    description: "plugin hello",',
        "    handler: async () => {},",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    const loaded = await core.loadUserPlugins({
      allowed: true,
      extensionDir,
    });
    const { host } = await createHost(
      paths,
      loaded.paths,
      "session-plugin-host",
    );
    try {
      assert.equal(await fs.readFile(marker, "utf8"), "loaded");
      assert.ok(
        host.session.extensionRunner
          .getRegisteredCommands()
          .some((command) => command.name === "codepunk-plugin-hello"),
      );
    } finally {
      await host.dispose();
    }
  });
});

test("a tool-registering user plugin aborts startup", async () => {
  await withTempDirectory("codepunk-plugin-tool-", async (root) => {
    const { paths } = await makeProject(root);
    const extensionDir = path.join(paths.home, "extensions");
    const pluginPath = path.join(extensionDir, "rogue.mjs");
    await writeFile(
      pluginPath,
      [
        "export default function (pi) {",
        "  pi.registerTool({",
        '    name: "rogue",',
        '    label: "Rogue",',
        '    description: "unwrapped plugin tool",',
        "    parameters: {",
        '      type: "object",',
        "      properties: {},",
        "      additionalProperties: false,",
        "    },",
        "    async execute() {",
        '      return { content: [{ type: "text", text: "rogue" }], details: {} };',
        "    },",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    await assert.rejects(
      () => createHost(paths, [pluginPath], "session-plugin-tool"),
      /registered tool "rogue" is not wrapped/u,
    );
  });
});

test("inline extension names cannot bypass exact allowlisting", async () => {
  await withTempDirectory("codepunk-plugin-inline-", async (root) => {
    const { paths } = await makeProject(root);
    await assert.rejects(
      () =>
        createHost(paths, [], "session-plugin-inline", {
          additionalExtensionFactories: [
            {
              name: "codepunk-codepunk-product",
              factory: () => {},
            },
          ],
        }),
      /unexpected extension set/u,
    );
  });
});

test("enabling plugins disables the bare ! path", async () => {
  await withTempDirectory("codepunk-plugin-", async (root) => {
    const { paths } = await makeProject(root);
    const ledger = await core.EvidenceLedger.open(
      path.join(paths.evidenceDir, "run.jsonl"),
    );
    const result = await core.wrapUserBashCommand("printf ok", "call-plugin", {
      cwd: paths.cwd,
      workspaceRoot: paths.deliveryRoot,
      deliveryRoot: paths.deliveryRoot,
      codepunkHome: paths.home,
      sessionId: "session-plugin",
      runId: "run-plugin",
      ledger,
      disableUserBash: true,
    });
    assert.equal("operations" in result, false);
    assert.match(
      result.result.output,
      /disabled while Pi plugins are enabled/u,
    );
    const record = ledger.all.at(-1);
    assert.equal(record.decision, "deny");
    assert.equal(record.rule, "user_bash.plugins_enabled");
  });
});

test("plugin installation validates files and replacement", async () => {
  await withTempDirectory("codepunk-plugin-install-", async (root) => {
    const { paths } = await makeProject(root);
    const extensionDir = path.join(paths.home, "extensions");
    const source = path.join(root, "source", "hello.mjs");
    await writeFile(source, "export default function () {}\n");

    assert.equal(
      await core.installUserPlugin({ extensionDir, source }),
      path.join(extensionDir, "hello.mjs"),
    );
    assert.deepEqual(await core.listUserPluginFiles(extensionDir), [
      path.join(extensionDir, "hello.mjs"),
    ]);
    await assert.rejects(
      () => core.installUserPlugin({ extensionDir, source }),
      /already exists/u,
    );

    await writeFile(source, "export default function replacement() {}\n");
    await core.installUserPlugin({ extensionDir, source, force: true });
    assert.match(
      await fs.readFile(path.join(extensionDir, "hello.mjs"), "utf8"),
      /replacement/u,
    );

    const linkedSource = path.join(root, "source", "linked.js");
    await createLinkedEntry(
      source,
      linkedSource,
      path.join(root, "linked-target"),
    );
    await assert.rejects(
      () => core.installUserPlugin({ extensionDir, source: linkedSource }),
      /regular \.mjs/u,
    );

    const wrongType = path.join(root, "source", "plugin.txt");
    await writeFile(wrongType, "text\n");
    await assert.rejects(
      () => core.installUserPlugin({ extensionDir, source: wrongType }),
      /regular \.mjs/u,
    );

    const oversized = path.join(root, "source", "oversized.js");
    await fs.writeFile(
      oversized,
      Buffer.alloc(core.MAX_PLUGIN_BYTES + 1, 0x61),
    );
    await assert.rejects(
      () => core.installUserPlugin({ extensionDir, source: oversized }),
      /exceeds/u,
    );

    assert.equal(
      await core.removeUserPlugin({ extensionDir, name: "hello.mjs" }),
      path.join(extensionDir, "hello.mjs"),
    );
    await assert.rejects(
      () => core.removeUserPlugin({ extensionDir, name: "hello.mjs" }),
      /not installed/u,
    );
    await assert.rejects(
      () => core.removeUserPlugin({ extensionDir, name: "../outside.js" }),
      /name is invalid/u,
    );
  });
});

test("W-06: plugin installation and removal support plugin.toml directories with validation", async () => {
  await withTempDirectory("codepunk-w06-plugin-dir-", async (root) => {
    const { paths } = await makeProject(root);
    const extensionDir = path.join(paths.home, "extensions");
    const sourceDir = path.join(root, "source-plugin-dir");
    await writeFile(
      path.join(sourceDir, "plugin.toml"),
      [
        'id = "demo-dir"',
        'version = "1.0.0"',
        'entry = "lib/index.mjs"',
        'tools = ["echo"]',
        'capabilities = ["tools"]',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(sourceDir, "lib", "index.mjs"),
      [
        "export default function (pi) {",
        "  pi.registerTool({",
        '    name: "echo",',
        '    label: "Echo",',
        '    description: "echo text",',
        '    parameters: { type: "object", properties: { text: { type: "string" } } },',
        "    async execute(_id, params) {",
        '      return { content: [{ type: "text", text: `v1:${String(params.text ?? "")}` }], details: {} };',
        "    },",
        "  });",
        "}",
        "",
      ].join("\n"),
    );

    // Positive control: installs directory by manifest.id, lists manifest, loads and runs in PluginHost
    const installedDir = await core.installUserPlugin({
      extensionDir,
      source: sourceDir,
    });
    assert.equal(installedDir, path.join(extensionDir, "demo-dir"));
    assert.deepEqual(await core.listUserPluginFiles(extensionDir), [
      path.join(extensionDir, "demo-dir", "plugin.toml"),
    ]);
    const loaded = await core.loadPluginManifests(extensionDir);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.manifests.length, 1);
    assert.equal(loaded.manifests[0].id, "demo-dir");

    const host = await core.PluginHost.start({ manifest: loaded.manifests[0] });
    try {
      const response = await host.callTool("echo", { text: "ok" });
      assert.equal(response.content[0].text, "v1:ok");
    } finally {
      await host.stop();
    }

    // Duplicate without --force fails
    await assert.rejects(
      () => core.installUserPlugin({ extensionDir, source: sourceDir }),
      (error) => error.code === "plugin.already_exists",
    );

    // Replace with --force updates files atomically
    await writeFile(
      path.join(sourceDir, "lib", "index.mjs"),
      [
        "export default function (pi) {",
        "  pi.registerTool({",
        '    name: "echo",',
        '    label: "Echo",',
        '    description: "echo text",',
        '    parameters: { type: "object", properties: { text: { type: "string" } } },',
        "    async execute(_id, params) {",
        '      return { content: [{ type: "text", text: `v2:${String(params.text ?? "")}` }], details: {} };',
        "    },",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    await core.installUserPlugin({
      extensionDir,
      source: sourceDir,
      force: true,
    });
    assert.match(
      await fs.readFile(path.join(installedDir, "lib", "index.mjs"), "utf8"),
      /v2:/u,
    );

    // Negative control 1: directory missing plugin.toml is rejected
    const unmanifested = path.join(root, "unmanifested");
    await writeFile(
      path.join(unmanifested, "index.mjs"),
      "export default () => {};\n",
    );
    await assert.rejects(
      () => core.installUserPlugin({ extensionDir, source: unmanifested }),
      (error) => error.code === "plugin.manifest_missing",
    );

    // Negative control 2: directory containing NUL bytes is rejected
    const binaryDir = path.join(root, "binary-plugin");
    await writeFile(
      path.join(binaryDir, "plugin.toml"),
      'id = "bin-plugin"\nversion = "1.0.0"\nentry = "index.mjs"\n',
    );
    await writeFile(
      path.join(binaryDir, "index.mjs"),
      "export default () => {};\n",
    );
    await fs.writeFile(
      path.join(binaryDir, "blob.dat"),
      Buffer.from([1, 0, 2]),
    );
    await assert.rejects(
      () => core.installUserPlugin({ extensionDir, source: binaryDir }),
      (error) => error.code === "plugin.binary_content",
    );

    // Negative control 3: directory containing symlink is rejected (POSIX)
    if (process.platform !== "win32") {
      const symlinkDir = path.join(root, "symlink-plugin");
      await writeFile(
        path.join(symlinkDir, "plugin.toml"),
        'id = "sym-plugin"\nversion = "1.0.0"\nentry = "index.mjs"\n',
      );
      await writeFile(
        path.join(symlinkDir, "index.mjs"),
        "export default () => {};\n",
      );
      await fs.symlink(
        path.join(root, "source-plugin-dir", "plugin.toml"),
        path.join(symlinkDir, "extra.toml"),
      );
      await assert.rejects(
        () => core.installUserPlugin({ extensionDir, source: symlinkDir }),
        (error) => error.code === "plugin.source_symlink",
      );
    }

    // Positive control: removeUserPlugin removes directory plugin by id
    assert.equal(
      await core.removeUserPlugin({ extensionDir, name: "demo-dir" }),
      installedDir,
    );
    assert.deepEqual(await core.listUserPluginFiles(extensionDir), []);
    await assert.rejects(
      () => core.removeUserPlugin({ extensionDir, name: "demo-dir" }),
      (error) => error.code === "plugin.not_found",
    );
  });
});

test("runtime plugin reload replaces the extension surface in place", async () => {
  await withTempDirectory("codepunk-plugin-reload-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await trustWorkspace(home, project);
    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const extensionDir = path.join(home, "extensions");
    const first = path.join(extensionDir, "first.mjs");
    await writeFile(
      first,
      [
        "export default function (pi) {",
        '  pi.registerCommand("plugin-first", {',
        '    description: "first plugin",',
        "    handler: async () => {},",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    const runtime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      model: TEST_MODEL,
      allowPlugins: true,
    });
    try {
      assert.deepEqual(runtime.plugins.paths, [first]);
      assert.ok(
        runtime.host.session.extensionRunner
          .getRegisteredCommands()
          .some((command) => command.name === "plugin-first"),
      );

      await fs.unlink(first);
      const second = path.join(extensionDir, "second.mjs");
      await writeFile(
        second,
        [
          "export default function (pi) {",
          '  pi.registerCommand("plugin-second", {',
          '    description: "second plugin",',
          "    handler: async () => {},",
          "  });",
          "}",
          "",
        ].join("\n"),
      );
      const reloaded = await runtime.reloadPlugins();
      assert.equal(reloaded.error, null);
      assert.deepEqual(runtime.plugins.paths, [second]);
      const commands = runtime.host.session.extensionRunner
        .getRegisteredCommands()
        .map((command) => command.name);
      assert.ok(commands.includes("plugin-second"));
      assert.equal(commands.includes("plugin-first"), false);

      const rogue = path.join(extensionDir, "rogue.mjs");
      await writeFile(
        rogue,
        [
          "export default function (pi) {",
          "  pi.registerTool({",
          '    name: "rogue",',
          '    label: "Rogue",',
          '    description: "unwrapped plugin tool",',
          "    parameters: {",
          '      type: "object",',
          "      properties: {},",
          "      additionalProperties: false,",
          "    },",
          "    async execute() {",
          '      return { content: [{ type: "text", text: "rogue" }], details: {} };',
          "    },",
          "  });",
          "}",
          "",
        ].join("\n"),
      );
      const rejected = await runtime.reloadPlugins();
      assert.match(
        rejected.error ?? "",
        /registered tool "rogue" is not wrapped/u,
      );
      assert.deepEqual(runtime.plugins.paths, [second]);
      assert.ok(
        runtime.host.session.extensionRunner
          .getRegisteredCommands()
          .some((command) => command.name === "plugin-second"),
      );
    } finally {
      await runtime.dispose();
    }
  });
});
