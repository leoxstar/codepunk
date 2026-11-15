import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { importCore } from "./support/core.mjs";
import {
  makeProject,
  trustWorkspace,
  withTempDirectory,
  writeFile,
} from "./support/helpers.mjs";
import { TEST_MODEL } from "./support/pi-model.mjs";

const core = await importCore();
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
    await fs.symlink(source, linkedSource);
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
