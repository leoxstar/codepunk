import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore, importProtocol, importSource } from "./support/core.mjs";
import {
  makeProject,
  withTempDirectory,
  writeFile,
} from "./support/helpers.mjs";

const protocol = await importProtocol();
const core = await importCore();
const hooks = await importSource("packages/core/src/capabilities/hooks.ts");

function hash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hookDefinition(overrides = {}) {
  return {
    name: "marker",
    event: "before_tool",
    argv: [process.execPath],
    timeout_ms: 5000,
    max_output_bytes: 4096,
    fail_closed: true,
    ...overrides,
  };
}

function hooksToml(definitions, options = {}) {
  return [
    "version = 1",
    ...(options.projectEnabled === undefined
      ? []
      : [`project_enabled = ${String(options.projectEnabled)}`]),
    ...(definitions.length === 0 ? ["hooks = []"] : []),
    ...definitions.flatMap((definition) => [
      "[[hooks]]",
      `name = ${JSON.stringify(definition.name)}`,
      `event = ${JSON.stringify(definition.event)}`,
      `argv = ${JSON.stringify(definition.argv)}`,
      `timeout_ms = ${definition.timeout_ms}`,
      `max_output_bytes = ${definition.max_output_bytes}`,
      "fail_closed = true",
    ]),
  ].join("\n");
}

async function writeUserConfig(root, definitions, options = {}) {
  await writeFile(
    path.join(root, "home", "hooks.toml"),
    `${hooksToml(definitions, options)}\n`,
  );
}

function runner(root, overrides = {}) {
  const project = path.join(root, "project");
  return new hooks.HookRunner({
    deliveryRoot: project,
    userHome: path.join(root, "home"),
    cwd: project,
    ...overrides,
  });
}

async function markerExists(marker) {
  try {
    await fs.access(marker);
    return true;
  } catch {
    return false;
  }
}

test("a passing user hook executes and emits hash-only evidence", async () => {
  await withTempDirectory("codepunk-hooks-positive-", async (root) => {
    await fs.mkdir(path.join(root, "project"), { recursive: true });
    await writeUserConfig(root, [
      hookDefinition({
        argv: [
          process.execPath,
          "-e",
          "const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>{const input=JSON.parse(Buffer.concat(chunks).toString());process.stdout.write(`user:${input.value}`)})",
        ],
      }),
    ]);
    const records = [];
    const result = await runner(root).run(
      "before_tool",
      { value: "hook input" },
      async (record) => {
        records.push(record);
      },
    );
    assert.equal(result.length, 1);
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, "passed");
    assert.equal(records[0].scope, "user");
    assert.equal(records[0].exit_code, 0);
    assert.equal(records[0].stdout_sha256, hash("user:hook input"));
    assert.equal(records[0].stderr_sha256, hash(""));
    assert.equal(
      protocol.validateSchema(protocol.HookEvidenceSchema, records[0]).ok,
      true,
    );
    assert.equal(
      hooks.formatHookStatus(records[0]),
      "user hook marker passed: hook exited with status 0",
    );
  });
});

test("a timeout is process-group killed, evidenced, and fail-closed", async () => {
  await withTempDirectory("codepunk-hooks-timeout-", async (root) => {
    await fs.mkdir(path.join(root, "project"), { recursive: true });
    const lateMarker = path.join(root, "project", "late-grandchild");
    await writeUserConfig(root, [
      hookDefinition({
        name: "timeout",
        timeout_ms: 150,
        argv: [
          process.execPath,
          "-e",
          [
            "const {spawn}=require('node:child_process');",
            `spawn(process.execPath,['-e',${JSON.stringify(
              `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(
                lateMarker,
              )},'late'),500)`,
            )}],{stdio:'ignore'});`,
            "process.stdout.write('alive');",
            "setInterval(()=>{},100)",
          ].join(""),
        ],
      }),
    ]);
    const records = [];
    await assert.rejects(
      () =>
        runner(root).run("before_tool", {}, async (record) => {
          records.push(record);
        }),
      (error) => {
        assert.ok(error instanceof hooks.HookBlockedError);
        assert.match(error.message, /failed closed \(timed_out\)/u);
        return true;
      },
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, "timed_out");
    assert.equal(records[0].exit_code, null);
    assert.equal(records[0].stdout_sha256, hash("alive"));
    assert.ok(records[0].duration_ms >= 140);
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(await markerExists(lateMarker), false);
  });
});

test("a nonzero hook is fail-closed", async () => {
  await withTempDirectory("codepunk-hooks-nonzero-", async (root) => {
    await fs.mkdir(path.join(root, "project"), { recursive: true });
    await writeUserConfig(root, [
      hookDefinition({
        name: "failing",
        argv: [
          process.execPath,
          "-e",
          "process.stderr.write('boom');process.exit(7)",
        ],
      }),
    ]);
    const records = [];
    await assert.rejects(
      () =>
        runner(root).run("before_tool", {}, async (record) => {
          records.push(record);
        }),
      /failed closed \(failed\)/u,
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, "failed");
    assert.equal(records[0].exit_code, 7);
    assert.equal(records[0].stderr_sha256, hash("boom"));
  });
});

test("malformed and unknown hooks configurations reject", async () => {
  await withTempDirectory("codepunk-hooks-config-", async (root) => {
    await fs.mkdir(path.join(root, "home"), { recursive: true });
    const configPath = path.join(root, "home", "hooks.toml");

    await writeFile(configPath, "version = 2\nhooks = []\n");
    let records = [];
    await assert.rejects(
      () =>
        runner(root).run("before_tool", {}, async (record) => {
          records.push(record);
        }),
      (error) => {
        assert.ok(error instanceof hooks.HookBlockedError);
        assert.match(error.message, /hooks configuration is invalid/u);
        return true;
      },
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, "rejected");
    assert.equal(records[0].scope, "user");

    await writeFile(
      configPath,
      `${hooksToml([hookDefinition({ name: "unknown", event: "made_up" })])}\n`,
    );
    records = [];
    await assert.rejects(
      () =>
        runner(root).run("before_tool", {}, async (record) => {
          records.push(record);
        }),
      /hooks configuration is invalid/u,
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, "rejected");
  });
});

test("non-file and oversized hook configurations reject", async () => {
  await withTempDirectory("codepunk-hooks-config-shape-", async (root) => {
    await fs.mkdir(path.join(root, "project"), { recursive: true });
    await fs.mkdir(path.join(root, "home", "hooks.toml"), {
      recursive: true,
    });

    const directoryRecords = [];
    await assert.rejects(
      () =>
        runner(root).run("before_tool", {}, async (record) => {
          directoryRecords.push(record);
        }),
      (error) => {
        assert.ok(error instanceof hooks.HookBlockedError);
        assert.match(error.message, /must be a real file/u);
        return true;
      },
    );
    assert.equal(directoryRecords.length, 1);
    assert.equal(directoryRecords[0].scope, "user");
    assert.equal(directoryRecords[0].outcome, "rejected");

    await fs.rmdir(path.join(root, "home", "hooks.toml"));
    await writeUserConfig(root, [
      hookDefinition({
        argv: [process.execPath, "-e", "process.exit(0)"],
      }),
    ]);
    const configPath = path.join(root, "home", "hooks.toml");
    await fs.writeFile(
      configPath,
      `${"x".repeat(hooks.MAX_HOOK_CONFIG_BYTES)}\n`,
    );

    const oversizedRecords = [];
    await assert.rejects(
      () =>
        runner(root).run("before_tool", {}, async (record) => {
          oversizedRecords.push(record);
        }),
      (error) => {
        assert.ok(error instanceof hooks.HookBlockedError);
        assert.match(error.message, /exceeds/u);
        return true;
      },
    );
    assert.equal(oversizedRecords.length, 1);
    assert.equal(oversizedRecords[0].scope, "user");
    assert.equal(oversizedRecords[0].outcome, "rejected");

    const outside = path.join(root, "outside-hooks.toml");
    await writeFile(outside, `${hooksToml([])}\n`);
    await fs.rm(configPath);
    await fs.symlink(outside, configPath);

    const symlinkRecords = [];
    await assert.rejects(
      () =>
        runner(root).run("before_tool", {}, async (record) => {
          symlinkRecords.push(record);
        }),
      (error) => {
        assert.ok(error instanceof hooks.HookBlockedError);
        assert.match(error.message, /must be a real file/u);
        return true;
      },
    );
    assert.equal(symlinkRecords.length, 1);
    assert.equal(symlinkRecords[0].scope, "user");
    assert.equal(symlinkRecords[0].outcome, "rejected");
  });
});

test(
  "unknown lstat failures are not treated as a missing configuration",
  { skip: process.platform === "win32" ? "POSIX permissions" : false },
  async () => {
    await withTempDirectory("codepunk-hooks-lstat-", async (root) => {
      await fs.mkdir(path.join(root, "project"), { recursive: true });
      const home = path.join(root, "home");
      await writeUserConfig(root, []);
      await fs.chmod(home, 0o000);
      try {
        const records = [];
        await assert.rejects(
          () =>
            runner(root).run("before_tool", {}, async (record) => {
              records.push(record);
            }),
          (error) => {
            assert.ok(error instanceof hooks.HookBlockedError);
            assert.match(error.message, /cannot be inspected/u);
            assert.doesNotMatch(error.message, /ENOENT/u);
            return true;
          },
        );
        assert.equal(records.length, 1);
        assert.equal(records[0].scope, "user");
        assert.equal(records[0].outcome, "rejected");
      } finally {
        await fs.chmod(home, 0o700);
      }
    });
  },
);

test("project hooks stay inert without both trust and enablement", async () => {
  await withTempDirectory("codepunk-hooks-project-", async (root) => {
    const project = path.join(root, "project");
    const marker = path.join(project, "project-hook-marker");
    await fs.mkdir(path.join(project, ".codepunk"), { recursive: true });
    await fs.mkdir(path.join(root, "home"), { recursive: true });
    await writeFile(
      path.join(project, ".codepunk", "hooks.toml"),
      `${hooksToml([
        hookDefinition({
          name: "project-marker",
          argv: [
            process.execPath,
            "-e",
            "require('node:fs').writeFileSync(process.argv[1], 'ran')",
            marker,
          ],
        }),
      ])}\n`,
    );

    const untrustedRecords = [];
    await runner(root).run("before_tool", {}, async (record) => {
      untrustedRecords.push(record);
    });
    assert.equal(await markerExists(marker), false);
    assert.equal(untrustedRecords.length, 1);
    assert.equal(untrustedRecords[0].outcome, "skipped");
    assert.equal(untrustedRecords[0].scope, "project");
    assert.match(
      untrustedRecords[0].reason,
      /project trust and explicit project enablement/u,
    );

    const disabledRecords = [];
    await runner(root, { projectTrusted: true }).run(
      "before_tool",
      {},
      async (record) => {
        disabledRecords.push(record);
      },
    );
    assert.equal(await markerExists(marker), false);
    assert.equal(disabledRecords.length, 1);
    assert.equal(disabledRecords[0].outcome, "skipped");
    assert.match(disabledRecords[0].reason, /explicit project enablement/u);

    await writeUserConfig(root, [], { projectEnabled: true });
    const enabledRecords = [];
    const enabled = await runner(root, {
      projectTrusted: true,
    }).run("before_tool", {}, async (record) => {
      enabledRecords.push(record);
    });
    assert.equal(await fs.readFile(marker, "utf8"), "ran");
    assert.equal(enabled.length, 1);
    assert.equal(enabledRecords.length, 1);
    assert.equal(enabledRecords[0].scope, "project");
    assert.equal(enabledRecords[0].outcome, "passed");
  });
});

test(
  "an unsafe project hook file is rejected and blocks the lifecycle",
  { skip: process.platform === "win32" ? "POSIX symlink safety" : false },
  async () => {
    await withTempDirectory("codepunk-hooks-unsafe-", async (root) => {
      const project = path.join(root, "project");
      await fs.mkdir(path.join(project, ".codepunk"), { recursive: true });
      await fs.mkdir(path.join(root, "home"), { recursive: true });
      const outside = path.join(root, "outside-hooks.toml");
      await writeFile(outside, `${hooksToml([])}\n`);
      await fs.symlink(outside, path.join(project, ".codepunk", "hooks.toml"));

      const records = [];
      await assert.rejects(
        () =>
          runner(root, {
            projectTrusted: true,
            projectEnabled: true,
          }).run("before_tool", {}, async (record) => {
            records.push(record);
          }),
        (error) => {
          assert.ok(error instanceof hooks.HookBlockedError);
          assert.match(error.message, /real file|symbolic|safe/u);
          return true;
        },
      );
      assert.equal(records.length, 1);
      assert.equal(records[0].scope, "project");
      assert.equal(records[0].outcome, "rejected");
    });
  },
);

test("project hooks cannot enable themselves from project scope", async () => {
  await withTempDirectory("codepunk-hooks-self-enable-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(path.join(project, ".codepunk"), { recursive: true });
    await fs.mkdir(path.join(root, "home"), { recursive: true });
    await writeFile(
      path.join(project, ".codepunk", "hooks.toml"),
      `${hooksToml(
        [
          hookDefinition({
            name: "self-enabled",
            argv: [process.execPath, "-e", "process.exit(0)"],
          }),
        ],
        { projectEnabled: true },
      )}\n`,
    );

    const records = [];
    await assert.rejects(
      () =>
        runner(root, {
          projectTrusted: true,
          projectEnabled: true,
        }).run("before_tool", {}, async (record) => {
          records.push(record);
        }),
      /user.*configuration/u,
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, "rejected");
  });
});

test("project hook parse and schema failures emit rejected evidence", async () => {
  await withTempDirectory("codepunk-hooks-project-reject-", async (root) => {
    const project = path.join(root, "project");
    const configPath = path.join(project, ".codepunk", "hooks.toml");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(path.join(root, "home"), { recursive: true });
    await writeUserConfig(root, [], { projectEnabled: true });

    for (const [label, content] of [
      ["unsupported version", "version = 2\nhooks = []\n"],
      ["malformed TOML", "[hooks\n"],
      [
        "oversized configuration",
        `version = 1\nhooks = []\n#${"x".repeat(65_536)}\n`,
      ],
    ]) {
      await writeFile(configPath, content);
      const records = [];
      await assert.rejects(
        () =>
          runner(root, { projectTrusted: true }).run(
            "before_tool",
            {},
            async (record) => {
              records.push(record);
            },
          ),
        (error) => {
          assert.ok(error instanceof hooks.HookBlockedError, label);
          return true;
        },
      );
      assert.equal(records.length, 1, label);
      assert.equal(records[0].scope, "project", label);
      assert.equal(records[0].outcome, "rejected", label);
      assert.ok(records[0].reason.length > 0, label);
    }
  });
});

test(
  "an unavailable hook executable is rejected and fail-closed",
  { skip: process.platform === "win32" ? "POSIX permissions" : false },
  async () => {
    await withTempDirectory("codepunk-hooks-not-executable-", async (root) => {
      await fs.mkdir(path.join(root, "project"), { recursive: true });
      const script = path.join(root, "home", "not-executable");
      await fs.mkdir(path.dirname(script), { recursive: true });
      await fs.writeFile(script, "#!/bin/sh\nexit 0\n");
      await fs.chmod(script, 0o644);
      await writeUserConfig(root, [
        hookDefinition({ name: "unavailable", argv: [script] }),
      ]);

      const records = [];
      await assert.rejects(
        () =>
          runner(root).run("before_tool", {}, async (record) => {
            records.push(record);
          }),
        (error) => {
          assert.ok(error instanceof hooks.HookBlockedError);
          assert.match(error.message, /failed closed \(rejected\)/u);
          return true;
        },
      );
      assert.equal(records.length, 1);
      assert.equal(records[0].outcome, "rejected");
      assert.match(records[0].reason, /EACCES/u);
    });
  },
);

test("a failing before_tool hook blocks the wrapped tool before side effects", async () => {
  await withTempDirectory("codepunk-hooks-wrap-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
    await writeUserConfig(root, [
      hookDefinition({
        name: "block-write",
        argv: [
          process.execPath,
          "-e",
          "const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{const p=JSON.parse(Buffer.concat(chunks).toString());if(p.tool==='write'){process.stderr.write('write blocked');process.exit(9)}})",
        ],
      }),
    ]);
    const target = path.join(project, "must-not-exist.txt");
    const ledger = await core.EvidenceLedger.open(
      path.join(root, "evidence.jsonl"),
    );
    const records = [];
    const wrapped = await core.wrapToolDefinition(
      {
        name: "write",
        label: "write",
        description: "write a test file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
        async execute(_toolCallId, params) {
          await fs.writeFile(path.join(project, params.path), params.content);
          return { content: [{ type: "text", text: "wrote" }], details: {} };
        },
      },
      {
        cwd: project,
        workspaceRoot: project,
        deliveryRoot: project,
        codepunkHome: path.join(root, "home"),
        sessionId: "session-hooks",
        runId: "run-hooks",
        writeSet: [project],
        approvalMode: "allow",
        approval: null,
        sandbox: null,
        ledger,
        beforeToolHook: async (input) => {
          await runner(root).run("before_tool", input, async (record) => {
            records.push(record);
          });
        },
      },
    );
    const result = await wrapped.execute(
      "call-blocked",
      { path: "must-not-exist.txt", content: "side effect" },
      undefined,
      undefined,
      {},
    );
    assert.equal(
      result.content.some((block) =>
        block.text?.includes("blocked by before_tool hook"),
      ),
      true,
    );
    await assert.rejects(fs.access(target), { code: "ENOENT" });
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, "failed");
    assert.equal(records[0].exit_code, 9);
    assert.equal(ledger.all.length, 1);
    assert.equal(ledger.all[0].decision, "deny");
    assert.equal(ledger.all[0].rule, "hook.before_tool");
  });
});

test("after_tool failure is recorded as a denied failed call", async () => {
  await withTempDirectory("codepunk-hooks-after-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
    const ledger = await core.EvidenceLedger.open(
      path.join(root, "evidence.jsonl"),
    );
    const target = path.join(project, "after.txt");
    const wrapped = await core.wrapToolDefinition(
      {
        name: "write",
        label: "write",
        description: "write a test file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
        async execute(_toolCallId, params) {
          await fs.writeFile(path.join(project, params.path), params.content);
          return { content: [{ type: "text", text: "wrote" }], details: {} };
        },
      },
      {
        cwd: project,
        workspaceRoot: project,
        deliveryRoot: project,
        codepunkHome: path.join(root, "home"),
        sessionId: "session-after",
        runId: "run-after",
        writeSet: [project],
        approvalMode: "allow",
        approval: null,
        sandbox: null,
        ledger,
        afterToolHook: async () => {
          throw new Error("post-write audit unavailable");
        },
      },
    );
    const result = await wrapped.execute(
      "call-after-failed",
      { path: "after.txt", content: "side effect" },
      undefined,
      undefined,
      {},
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /blocked by after_tool hook/u);
    assert.equal(await fs.readFile(target, "utf8"), "side effect");
    assert.equal(ledger.all.length, 1);
    assert.equal(ledger.all[0].decision, "deny");
    assert.equal(ledger.all[0].outcome, "failed");
    assert.equal(ledger.all[0].rule, "hook.after_tool");
  });
});

test("a before_tool hook cannot widen the post-hook mutation target", async () => {
  await withTempDirectory("codepunk-hooks-toctou-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
    const target = path.join(project, "guarded.txt");
    await writeFile(target, "before\n");
    const ledger = await core.EvidenceLedger.open(
      path.join(root, "evidence.jsonl"),
    );
    let executions = 0;
    const wrapped = await core.wrapToolDefinition(
      {
        name: "write",
        label: "write",
        description: "write a test file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
        async execute(_toolCallId, params) {
          executions += 1;
          await fs.writeFile(path.join(project, params.path), params.content);
          return { content: [{ type: "text", text: "wrote" }], details: {} };
        },
      },
      {
        cwd: project,
        workspaceRoot: project,
        deliveryRoot: project,
        codepunkHome: path.join(root, "home"),
        sessionId: "session-toctou",
        runId: "run-toctou",
        writeSet: [project],
        approvalMode: "allow",
        approval: null,
        sandbox: null,
        ledger,
        beforeToolHook: async () => {
          await fs.writeFile(target, "changed by hook\n");
        },
      },
    );
    const result = await wrapped.execute(
      "call-toctou",
      { path: "guarded.txt", content: "tool output\n" },
      undefined,
      undefined,
      {},
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /path\.recheck/u);
    assert.equal(executions, 0);
    assert.equal(await fs.readFile(target, "utf8"), "changed by hook\n");
    assert.equal(ledger.all.length, 1);
    assert.equal(ledger.all[0].decision, "deny");
    assert.equal(ledger.all[0].rule, "path.recheck");
  });
});

test("safe mutation retry re-runs before and after hooks", async () => {
  await withTempDirectory("codepunk-hooks-retry-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
    const ledger = await core.EvidenceLedger.open(
      path.join(root, "evidence.jsonl"),
    );
    const lifecycle = [];
    let verifies = 0;
    let executions = 0;
    const wrapped = await core.wrapToolDefinition(
      {
        name: "write",
        label: "write",
        description: "write a test file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
        async execute(_toolCallId, params) {
          executions += 1;
          await fs.writeFile(path.join(project, params.path), params.content);
          return { content: [{ type: "text", text: "wrote" }], details: {} };
        },
      },
      {
        cwd: project,
        workspaceRoot: project,
        deliveryRoot: project,
        codepunkHome: path.join(root, "home"),
        sessionId: "session-retry",
        runId: "run-retry",
        writeSet: [project],
        approvalMode: "allow",
        approval: null,
        sandbox: null,
        ledger,
        beforeToolHook: async () => {
          lifecycle.push("before");
        },
        afterToolHook: async () => {
          lifecycle.push("after");
        },
        verifyToolResult: async () => {
          verifies += 1;
          return verifies === 1
            ? { result: "fail", reason: "forced verification miss" }
            : { result: "pass", reason: null };
        },
      },
    );
    const result = await wrapped.execute(
      "call-retry-hooks",
      { path: "retry.txt", content: "after\n" },
      undefined,
      undefined,
      {},
    );
    assert.notEqual(result.isError, true);
    assert.equal(
      await fs.readFile(path.join(project, "retry.txt"), "utf8"),
      "after\n",
    );
    assert.equal(executions, 2);
    assert.deepEqual(lifecycle, ["before", "after", "before", "after"]);
    assert.equal(ledger.all.length, 2);
    assert.equal(ledger.all[0].rule, "verify.failed");
    assert.equal(ledger.all[1].decision, "allow");
    assert.equal(ledger.all[1].outcome, "completed");
  });
});

test("safe mutation retry rechecks the target after the second before hook", async () => {
  await withTempDirectory("codepunk-hooks-retry-recheck-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
    const target = path.join(project, "retry-recheck.txt");
    const ledger = await core.EvidenceLedger.open(
      path.join(root, "evidence.jsonl"),
    );
    const lifecycle = [];
    let verifies = 0;
    let executions = 0;
    let beforeCalls = 0;
    const wrapped = await core.wrapToolDefinition(
      {
        name: "write",
        label: "write",
        description: "write a test file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
        async execute(_toolCallId, params) {
          executions += 1;
          await fs.writeFile(path.join(project, params.path), params.content);
          return { content: [{ type: "text", text: "wrote" }], details: {} };
        },
      },
      {
        cwd: project,
        workspaceRoot: project,
        deliveryRoot: project,
        codepunkHome: path.join(root, "home"),
        sessionId: "session-retry-recheck",
        runId: "run-retry-recheck",
        writeSet: [project],
        approvalMode: "allow",
        approval: null,
        sandbox: null,
        ledger,
        beforeToolHook: async () => {
          lifecycle.push("before");
          beforeCalls += 1;
          if (beforeCalls === 2) {
            await fs.writeFile(target, "changed during retry\n");
          }
        },
        afterToolHook: async () => {
          lifecycle.push("after");
        },
        verifyToolResult: async () => {
          verifies += 1;
          return verifies === 1
            ? { result: "fail", reason: "forced verification miss" }
            : { result: "pass", reason: null };
        },
      },
    );
    const result = await wrapped.execute(
      "call-retry-recheck",
      { path: "retry-recheck.txt", content: "first attempt\n" },
      undefined,
      undefined,
      {},
    );
    assert.deepEqual(lifecycle, ["before", "after", "before"]);
    assert.match(result.content[0].text, /path\.recheck/u);
    assert.equal(await fs.readFile(target, "utf8"), "changed during retry\n");
    assert.equal(executions, 1);
    assert.equal(verifies, 1);
    assert.deepEqual(lifecycle, ["before", "after", "before"]);
    assert.equal(ledger.all.length, 2);
    assert.equal(ledger.all[0].rule, "verify.failed");
    assert.equal(ledger.all[1].decision, "deny");
    assert.equal(ledger.all[1].rule, "path.recheck");
  });
});

test("runtime loads project hooks only from user enablement plus trust", async () => {
  await withTempDirectory("codepunk-hooks-runtime-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    const marker = path.join(projectRoot, "runtime-project-hook");
    await fs.mkdir(path.join(projectRoot, ".codepunk"), { recursive: true });
    await writeFile(
      path.join(projectRoot, ".codepunk", "hooks.toml"),
      `${hooksToml([
        hookDefinition({
          name: "runtime-marker",
          event: "session_start",
          argv: [
            process.execPath,
            "-e",
            "require('node:fs').writeFileSync(process.argv[1], 'ran')",
            marker,
          ],
        }),
      ])}\n`,
    );
    await writeFile(
      path.join(paths.home, "hooks.toml"),
      `${hooksToml([], { projectEnabled: false })}\n`,
    );

    const disabled = await core.createRuntime({
      cwd: projectRoot,
      environment: { CODEPUNK_HOME: paths.home },
      approvalChannel: null,
      allowMissingModel: true,
      projectTrust: {
        config: true,
        policy: false,
        skills: false,
        instructions: false,
      },
    });
    try {
      assert.equal(
        disabled.workspaceTrust.resources.includes(".codepunk/hooks.toml"),
        true,
      );
      assert.equal(await markerExists(marker), false);
      assert.equal(
        disabled.session.allEvents.some(
          (event) =>
            event.kind === "hook/result" &&
            event.data.scope === "project" &&
            event.data.outcome === "skipped",
        ),
        true,
      );
    } finally {
      await disabled.dispose();
    }

    await writeFile(
      path.join(paths.home, "hooks.toml"),
      `${hooksToml([], { projectEnabled: true })}\n`,
    );
    const enabled = await core.createRuntime({
      cwd: projectRoot,
      environment: { CODEPUNK_HOME: paths.home },
      approvalChannel: null,
      allowMissingModel: true,
      projectTrust: {
        config: true,
        policy: false,
        skills: false,
        instructions: false,
      },
    });
    try {
      assert.equal(await fs.readFile(marker, "utf8"), "ran");
      assert.equal(
        enabled.session.allEvents.some(
          (event) =>
            event.kind === "hook/result" &&
            event.data.scope === "project" &&
            event.data.outcome === "passed",
        ),
        true,
      );
    } finally {
      await enabled.dispose();
    }
  });
});
