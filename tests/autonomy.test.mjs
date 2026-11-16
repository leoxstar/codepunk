import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import {
  makeProject,
  withTempDirectory,
  writeFile,
} from "./support/helpers.mjs";

const core = await importCore();

async function executableSha(executable) {
  const bytes = await fs.readFile(executable);
  return core.sha256Bytes(bytes);
}

async function rulesFile(root, lines) {
  const file = path.join(root, "scoped-rules.toml");
  await writeFile(file, `${lines.join("\n")}\n`);
  await fs.chmod(file, 0o600);
  return file;
}

function ruleBlock(id, argv, cwd, digest) {
  const quoted = argv.map((value) => JSON.stringify(value)).join(", ");
  return [
    "[[rules]]",
    `id = ${JSON.stringify(id)}`,
    `argv = [${quoted}]`,
    `cwd = ${JSON.stringify(cwd)}`,
    `executable_sha256 = ${JSON.stringify(digest)}`,
  ];
}

test("scoped rules are exact argv plus digest plus cwd", async () => {
  await withTempDirectory("codepunk-autonomy-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    const digest = await executableSha("/bin/mkdir");
    const file = await rulesFile(root, [
      "version = 1",
      ...ruleBlock("make-one", ["mkdir", "made"], projectRoot, digest),
    ]);
    const loaded = await core.loadScopedRules(file, paths);
    assert.equal(loaded.rules.length, 1);
    assert.match(loaded.rules[0].rule_sha256, /^sha256:[0-9a-f]{64}$/u);

    const controller = new core.AutonomyController({
      profile: "scoped",
      source: "cli",
      rules: loaded.rules,
      rulesSha256: loaded.rulesSha256,
    });
    const allowed = await controller.authorize({
      tool: "bash",
      command: "mkdir made",
      cwd: projectRoot,
    });
    assert.equal(allowed?.id, "make-one");
    const userBash = await controller.authorize({
      tool: "user_bash",
      command: "mkdir made",
      cwd: projectRoot,
    });
    assert.equal(userBash?.id, "make-one");
    assert.equal(
      await controller.authorize({
        tool: "bash",
        command: "mkdir made-other",
        cwd: projectRoot,
      }),
      null,
    );
    assert.equal(
      await controller.authorize({
        tool: "bash",
        command: "mkdir made",
        cwd: paths.home,
      }),
      null,
    );
    assert.equal(
      await controller.authorize({
        tool: "bash",
        command: "mkdir made && touch escape",
        cwd: projectRoot,
      }),
      null,
    );
    for (const command of [
      "mkdir $HOME/escape",
      "mkdir build-*",
      "mkdir ~/escape",
      "FOO=bar mkdir made",
    ]) {
      assert.equal(
        await controller.authorize({
          tool: "bash",
          command,
          cwd: projectRoot,
        }),
        null,
        command,
      );
    }
    controller.revoke();
    assert.equal(
      await controller.authorize({
        tool: "bash",
        command: "mkdir made",
        cwd: projectRoot,
      }),
      null,
    );
  });
});

test("scoped rules compare cwd through symlinks", async () => {
  await withTempDirectory("codepunk-autonomy-symlink-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    const link = path.join(root, "project-link");
    await fs.symlink(projectRoot, link, "dir");
    const digest = await executableSha("/bin/mkdir");
    const file = await rulesFile(root, [
      "version = 1",
      ...ruleBlock("make-through-link", ["mkdir", "made"], link, digest),
    ]);
    const loaded = await core.loadScopedRules(file, paths);
    assert.equal(loaded.rules[0].cwd, await fs.realpath(projectRoot));
    const controller = new core.AutonomyController({
      profile: "scoped",
      source: "cli",
      rules: loaded.rules,
      rulesSha256: loaded.rulesSha256,
    });
    for (const cwd of [projectRoot, link]) {
      const allowed = await controller.authorize({
        tool: "bash",
        command: "mkdir made",
        cwd,
      });
      assert.equal(allowed?.id, "make-through-link", cwd);
    }
  });
});

test("scoped autonomy rejects cwd-only, glob, and project files", async () => {
  await withTempDirectory("codepunk-autonomy-negative-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    const digest = await executableSha("/bin/mkdir");
    const cwdOnly = await rulesFile(root, [
      "version = 1",
      "[[rules]]",
      'id = "cwd-only"',
      `cwd = ${JSON.stringify(projectRoot)}`,
      `executable_sha256 = ${JSON.stringify(digest)}`,
    ]);
    await assert.rejects(
      () => core.loadScopedRules(cwdOnly, paths),
      /argv must be a non-empty string array/u,
    );

    const glob = await rulesFile(root, [
      "version = 1",
      "[[rules]]",
      'id = "glob"',
      'argv = ["mkdir", "build-*"]',
      `cwd = ${JSON.stringify(projectRoot)}`,
      `executable_sha256 = ${JSON.stringify(digest)}`,
    ]);
    await assert.rejects(
      () => core.loadScopedRules(glob, paths),
      /glob or pattern/u,
    );

    const prefix = await rulesFile(root, [
      "version = 1",
      "[[rules]]",
      'id = "prefix"',
      'argv = ["mkdir", "build"]',
      'prefix = "build"',
      `cwd = ${JSON.stringify(projectRoot)}`,
      `executable_sha256 = ${JSON.stringify(digest)}`,
    ]);
    await assert.rejects(
      () => core.loadScopedRules(prefix, paths),
      /unsupported match key prefix/u,
    );

    const inside = path.join(projectRoot, ".codepunk", "scoped.toml");
    await writeFile(
      inside,
      [
        "version = 1",
        ...ruleBlock("inside", ["mkdir", "made"], projectRoot, digest),
      ].join("\n"),
    );
    await fs.chmod(inside, 0o600);
    await assert.rejects(
      () => core.loadScopedRules(inside, paths),
      /outside the repository/u,
    );

    const shell = await rulesFile(root, [
      "version = 1",
      ...ruleBlock("shell", ["/bin/sh", "-c", "true"], projectRoot, digest),
    ]);
    await assert.rejects(
      () => core.loadScopedRules(shell, paths),
      /cannot launch a shell/u,
    );
  });
});

test("only exact scoped rules pass and argv changes ask again", async () => {
  await withTempDirectory("codepunk-autonomy-policy-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    const digest = await executableSha("/bin/mkdir");
    const file = await rulesFile(root, [
      "version = 1",
      ...ruleBlock("make-one", ["mkdir", "made"], projectRoot, digest),
    ]);
    const loaded = await core.loadScopedRules(file, paths);
    const controller = new core.AutonomyController({
      profile: "scoped",
      source: "cli",
      rules: loaded.rules,
      rulesSha256: loaded.rulesSha256,
    });
    const ledger = await core.EvidenceLedger.open(
      path.join(root, "evidence.jsonl"),
    );
    const definition = {
      name: "bash",
      label: "bash",
      description: "test shell",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
      async execute() {
        return {
          content: [{ type: "text", text: "made" }],
          details: {},
          structuredContent: { output: "made", exit_code: 0 },
        };
      },
    };
    const wrapped = await core.wrapToolDefinition(definition, {
      cwd: projectRoot,
      workspaceRoot: paths.deliveryRoot,
      deliveryRoot: paths.deliveryRoot,
      codepunkHome: paths.home,
      sessionId: "session",
      runId: "run",
      writeSet: [projectRoot],
      ledger,
      approval: new core.ApprovalBroker(),
      autonomy: controller,
      sandbox: {
        descriptor: {
          backend: "none",
          version: null,
          profile_sha256: null,
        },
        sandboxed: false,
        async execCommand() {
          throw new Error("not executed");
        },
        async execArgv() {
          throw new Error("not executed");
        },
      },
    });
    const allowed = await wrapped.execute(
      "call-1",
      { command: "mkdir made" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(allowed.isError, undefined);
    const record = ledger.all[0];
    assert.equal(record.decision, "allow");
    assert.equal(record.rule, "scoped.make-one");
    assert.equal(record.approval, null);
    assert.equal(record.autonomy.profile, "scoped");
    assert.equal(record.autonomy.rule_id, "make-one");
    assert.equal(record.coverage, "uncovered");

    const denied = await wrapped.execute(
      "call-2",
      { command: "mkdir made-other" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(denied.isError, true);
    assert.equal(ledger.all[1].decision, "deny");
    assert.equal(ledger.all[1].rule, "approval.unavailable");
    await ledger.close?.();
  });
});

test("read-only autonomy denies mutations without an approval", () => {
  const cwd = "/tmp/codepunk-read-only";
  for (const request of [
    {
      tool: "bash",
      command: "rm -rf build",
    },
    {
      tool: "bash",
      command: "git reset --hard",
    },
    {
      tool: "bash",
      command: "npm install",
    },
    {
      tool: "bash",
      command: "echo made > made.txt",
    },
    {
      tool: "bash",
      command: "mkdir made",
    },
    {
      tool: "write",
      args: { path: "made.txt" },
    },
    {
      tool: "edit",
      args: { path: "made.txt" },
    },
  ]) {
    const decision = core.decidePolicy({
      ...request,
      cwd,
      workspaceRoot: cwd,
      writeSet: [cwd],
      autonomy: "read-only",
    });
    assert.equal(decision.decision, "deny", request.tool);
    assert.match(decision.reason, /read-only/u, request.tool);
  }

  for (const command of [
    "date +%A",
    "ls",
    "pwd",
    "git status",
    "git diff --stat",
  ]) {
    const decision = core.decidePolicy({
      tool: "bash",
      command,
      cwd,
      workspaceRoot: cwd,
      writeSet: [cwd],
      autonomy: "read-only",
    });
    assert.equal(decision.decision, "allow", command);
    assert.match(decision.reason, /read-only shell/u, command);
  }
});

test("the read-only profile keeps shell reads and denies mutations", async () => {
  await withTempDirectory("codepunk-read-only-profile-", async (root) => {
    const workspace = path.join(root, "workspace");
    const home = path.join(root, "home");
    await fs.mkdir(workspace);
    await fs.mkdir(home);
    await fs.writeFile(path.join(workspace, "kept.txt"), "original\n");
    const ledger = await core.EvidenceLedger.open(
      path.join(root, "evidence.jsonl"),
    );
    const executed = [];
    let directExecutions = 0;
    const sandbox = {
      descriptor: { backend: "none", version: null, profile_sha256: null },
      sandboxed: false,
      async execCommand(command) {
        executed.push(command);
        return {
          output: `ran ${command}`,
          exitCode: 0,
          cancelled: false,
          timedOut: false,
          executor: "direct",
          descriptor: this.descriptor,
        };
      },
      async execArgv(argv) {
        executed.push(argv.join(" "));
        return {
          output: "ran",
          exitCode: 0,
          cancelled: false,
          timedOut: false,
          executor: "direct",
          descriptor: this.descriptor,
        };
      },
    };
    const bash = {
      name: "bash",
      label: "bash",
      description: "test shell",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
      async execute() {
        directExecutions += 1;
        return {
          content: [{ type: "text", text: "direct execution reached" }],
          details: {},
          structuredContent: {
            output: "direct execution reached",
            exit_code: 0,
          },
        };
      },
    };
    const write = {
      name: "write",
      label: "write",
      description: "test write",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      async execute() {
        throw new Error("write tool must not execute in read-only mode");
      },
    };
    const options = {
      cwd: workspace,
      workspaceRoot: workspace,
      deliveryRoot: workspace,
      codepunkHome: home,
      sessionId: "read-only-session",
      runId: "read-only-run",
      writeSet: [workspace],
      approvalMode: "ask",
      autonomy: new core.AutonomyController({
        profile: "read-only",
        source: "cli",
        rules: [],
        rulesSha256: null,
      }),
      approval: new core.ApprovalBroker(),
      ledger,
      sandbox,
    };
    const wrappedBash = await core.wrapToolDefinition(bash, options);
    const wrappedWrite = await core.wrapToolDefinition(write, options);
    const read = await wrappedBash.execute(
      "read-call",
      { command: "date +%A" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(read.isError, undefined);
    assert.equal(directExecutions, 1);
    const status = await wrappedBash.execute(
      "status-call",
      { command: "git status" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(status.isError, undefined);
    assert.equal(directExecutions, 2);
    for (const command of [
      "rm -rf build",
      "git reset --hard",
      "npm install",
      "mkdir made",
    ]) {
      const denied = await wrappedBash.execute(
        `deny-${command}`,
        { command },
        undefined,
        undefined,
        undefined,
      );
      assert.equal(denied.isError, true, command);
    }
    const deniedWrite = await wrappedWrite.execute(
      "write-call",
      { path: "kept.txt", content: "overwritten\n" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(deniedWrite.isError, true);
    assert.equal(
      await fs.readFile(path.join(workspace, "kept.txt"), "utf8"),
      "original\n",
    );
    assert.equal(directExecutions, 2);
    assert.deepEqual(executed, []);
    assert.deepEqual(
      ledger.all
        .filter((record) => record.decision === "deny")
        .map((record) => record.rule),
      [
        "autonomy.read_only.ask",
        "autonomy.read_only.ask",
        "autonomy.read_only.ask",
        "autonomy.read_only.ask",
        "autonomy.read_only.write",
      ],
    );
    await ledger.close?.();
  });
});

test("launcher detection covers wrappers and versioned interpreters", () => {
  for (const executable of [
    "/bin/sh",
    "/bin/dash",
    "/usr/bin/env",
    "/usr/bin/busybox",
    "/usr/bin/xargs",
    "/usr/bin/python3.13",
    "/opt/homebrew/bin/node",
  ]) {
    assert.equal(core.isShellLauncher([executable]), true, executable);
  }
  assert.equal(core.isShellLauncher(["/bin/ls"]), false);
  assert.equal(core.isShellLauncher(["/usr/bin/git"]), false);
});

test("autonomy profile can change live but scoped still requires rules", () => {
  const controller = new core.AutonomyController({
    profile: "ask",
    source: "default",
    rules: [],
    rulesSha256: null,
  });
  controller.setProfile("read-only");
  assert.equal(controller.profile, "read-only");
  controller.setProfile("ask");
  assert.equal(controller.profile, "ask");
  assert.throws(
    () => controller.setProfile("scoped"),
    /scoped autonomy requires/u,
  );
  assert.equal(controller.profile, "ask");

  const rule = {
    id: "make-one",
    argv: ["/bin/mkdir", "made"],
    cwd: path.resolve("/tmp"),
    executable_sha256: `sha256:${"0".repeat(64)}`,
    rule_sha256: `sha256:${"1".repeat(64)}`,
  };
  controller.replaceRules([rule], core.autonomyRulesHash([rule]));
  controller.setProfile("scoped");
  assert.equal(controller.profile, "scoped");
  assert.equal(controller.rules.length, 1);

  controller.setProfile("ask");
  controller.replaceRules([], null);
  assert.throws(
    () => controller.setProfile("scoped"),
    /scoped autonomy requires/u,
  );
});

test("project config cannot set autonomy", async () => {
  await withTempDirectory("codepunk-autonomy-config-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    await writeFile(
      path.join(projectRoot, ".codepunk", "config.toml"),
      '[autonomy]\nprofile = "scoped"\n',
    );
    await assert.rejects(
      () => core.loadConfig(paths),
      /autonomy\.profile is user\/CLI-only/u,
    );
  });
});

test("persisted approval rules are exact, deduplicated, and reloadable", async () => {
  await withTempDirectory("codepunk-autonomy-persist-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    const file = path.join(paths.home, "scoped-rules.toml");
    const first = await core.persistScopedRule({
      paths,
      argv: ["mkdir", "made"],
      cwd: projectRoot,
      filePath: file,
    });
    assert.equal(first.created, true);
    assert.match(first.rule.id, /^approval-[0-9a-f]{12}$/u);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

    const loaded = await core.loadScopedRules(file, paths);
    assert.equal(loaded.rules.length, 1);
    assert.deepEqual(loaded.rules[0].argv, ["mkdir", "made"]);
    assert.equal(loaded.rules[0].cwd, await fs.realpath(projectRoot));

    const duplicate = await core.persistScopedRule({
      paths,
      argv: ["mkdir", "made"],
      cwd: projectRoot,
      filePath: file,
    });
    assert.equal(duplicate.created, false);
    assert.equal((await core.loadScopedRules(file, paths)).rules.length, 1);

    await core.writeUserPermissionSelection(paths, {
      autonomy: "scoped",
      scopedRules: file,
    });
    const configText = await fs.readFile(
      path.join(paths.home, "config.toml"),
      "utf8",
    );
    assert.match(configText, /\[autonomy\]/u);
    assert.match(configText, /profile = "scoped"/u);
    assert.match(configText, /scoped_rules = ".*scoped-rules\.toml"/u);
    const config = await core.loadConfig(paths);
    assert.equal(config.config.autonomy.profile, "scoped");
    assert.equal(config.config.autonomy.scoped_rules, file);
  });
});

test("persisted approval rules reject shells, globs, escapes, and unsafe config", async () => {
  await withTempDirectory(
    "codepunk-autonomy-persist-negative-",
    async (root) => {
      const { projectRoot, paths } = await makeProject(root);
      const file = path.join(paths.home, "scoped-rules.toml");
      for (const request of [
        { argv: ["/bin/sh", "-c", "true"], error: /cannot launch a shell/u },
        { argv: ["mkdir", "build-*"], error: /glob or pattern/u },
        { argv: ["mkdir", "made"], cwd: "relative", error: /absolute path/u },
        {
          argv: ["mkdir", "made"],
          filePath: path.join(projectRoot, "rules.toml"),
          error: /outside the repository/u,
        },
      ]) {
        await assert.rejects(
          () =>
            core.persistScopedRule({
              paths,
              cwd: projectRoot,
              filePath: file,
              ...request,
            }),
          request.error,
        );
      }
      await assert.rejects(
        () =>
          core.writeUserPermissionSelection(paths, {
            autonomy: "ask",
            scopedRules: file,
          }),
        /scoped autonomy profile/u,
      );
      await assert.rejects(
        () =>
          core.writeUserPermissionSelection(paths, {
            autonomy: "scoped",
            scopedRules: "relative.toml",
          }),
        /absolute path/u,
      );
    },
  );
});

/**
 * Windows has no group or world write bit: Node synthesizes mode 0o666 for any
 * writable file. The guard must stay on POSIX and stand down on win32, so the
 * same file is exercised under both platforms.
 */
function withPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: platform,
  });
  return Promise.resolve()
    .then(run)
    .finally(() => {
      Object.defineProperty(process, "platform", original);
    });
}

test(
  "a group or world writable scoped rules file is rejected on POSIX and read on Windows",
  { skip: process.platform === "win32" },
  async () => {
    await withTempDirectory("codepunk-autonomy-mode-", async (root) => {
      const { projectRoot, paths } = await makeProject(root);
      const digest = await executableSha("/bin/mkdir");
      const file = await rulesFile(root, [
        "version = 1",
        ...ruleBlock("make-one", ["mkdir", "made"], projectRoot, digest),
      ]);
      await fs.chmod(file, 0o666);
      await assert.rejects(
        () => core.loadScopedRules(file, paths),
        /must not be group or world writable/u,
      );
      const loaded = await withPlatform("win32", () =>
        core.loadScopedRules(file, paths),
      );
      assert.equal(loaded.rules.length, 1);
      assert.equal(loaded.rules[0].id, "make-one");
    });
  },
);
