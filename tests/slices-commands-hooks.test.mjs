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
import { installScriptedStream, TEST_MODEL } from "./support/pi-model.mjs";

const core = await importCore();

test("@file#L context slices inline bounded workspace ranges and refuse escapes, sensitive files, and fenced code", async () => {
  await withTempDirectory("codepunk-file-slices-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    await writeFile(
      path.join(projectRoot, "src", "demo.ts"),
      [
        "const a = 1;",
        "export function greet(name: string) {",
        "  return `hi ${name}`;",
        "}",
        "const z = 9;",
      ].join("\n"),
    );
    await writeFile(path.join(projectRoot, ".env"), "SECRET_KEY=do_not_leak\n");
    await writeFile(path.join(root, "outside.txt"), "outside secret\n");

    const prompt = [
      "Please check @src/demo.ts#L2-4 and ignore `@src/demo.ts#L1-5`.",
      "```md",
      "@src/demo.ts#L1-5",
      "```",
      "Also test @../outside.txt#L1-1 and @.env#L1-1.",
    ].join("\n");

    const result = await core.expandPromptFileSlices(prompt, {
      cwd: projectRoot,
      workspaceRoot: projectRoot,
      deliveryRoot: projectRoot,
      codepunkHome: paths.home,
    });

    assert.equal(result.slices.length, 1);
    assert.equal(result.slices[0].path, "src/demo.ts");
    assert.equal(result.slices[0].startLine, 2);
    assert.equal(result.slices[0].endLine, 4);
    assert.match(result.text, /<file_slice path="src\/demo\.ts" lines="2-4">/u);
    assert.match(result.text, /2: export function greet/u);
    assert.equal(result.text.includes("do_not_leak"), false);
    assert.equal(result.text.includes("outside secret"), false);
    assert.equal(
      result.warnings.some((w) => /outside the workspace/u.test(w)),
      true,
    );
    assert.equal(
      result.warnings.some((w) => /sensitive path/u.test(w)),
      true,
    );
  });
});

test("custom Markdown commands gate project templates on workspace trust and expand positional arguments", async () => {
  await withTempDirectory("codepunk-custom-commands-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    await writeFile(
      path.join(paths.home, "commands", "triage.md"),
      [
        "---",
        "description: Triage an issue with focus area",
        "---",
        "Investigate issue #$1 in module $2. Full context: $ARGUMENTS",
      ].join("\n"),
    );
    await writeFile(
      path.join(projectRoot, ".codepunk", "commands", "check-ci.md"),
      "Verify CI workflow $1 before release.\n",
    );

    const untrusted = await core.loadCustomCommands({
      codepunkHome: paths.home,
      deliveryRoot: projectRoot,
      projectTrusted: false,
    });
    assert.deepEqual(
      untrusted.commands.map((c) => c.name),
      ["triage"],
    );
    assert.equal(
      untrusted.warnings.some((w) => /not trusted/u.test(w)),
      true,
    );

    const trusted = await core.loadCustomCommands({
      codepunkHome: paths.home,
      deliveryRoot: projectRoot,
      projectTrusted: true,
    });
    assert.deepEqual(
      trusted.commands.map((c) => c.name),
      ["check-ci", "triage"],
    );

    const triage = trusted.commands.find((c) => c.name === "triage");
    const expanded = core.expandCustomCommand(
      triage,
      '42 "packages/core" --strict',
    );
    assert.equal(
      expanded,
      'Investigate issue #42 in module packages/core. Full context: 42 "packages/core" --strict',
    );
  });
});

test("before_stop hook blocks premature completion, steers a self-repair turn, and fails closed if retries exhaust", async () => {
  await withTempDirectory("codepunk-before-stop-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    const gateFile = path.join(projectRoot, "gate-passed.txt");
    await writeFile(
      path.join(paths.home, "hooks.toml"),
      [
        "version = 1",
        "[[hooks]]",
        'name = "verify-gate"',
        'event = "before_stop"',
        `argv = [${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(
          `const fs=require('node:fs');if(!fs.existsSync(${JSON.stringify(gateFile)})){process.stderr.write('gate-passed.txt missing');process.exit(1)}`,
        )}]`,
        "timeout_ms = 5000",
        "max_output_bytes = 4096",
        "fail_closed = true",
      ].join("\n"),
    );

    const hookEvents = [];
    const hookRunner = new core.HookRunner({
      deliveryRoot: projectRoot,
      userHome: paths.home,
      cwd: projectRoot,
    });
    const sessionStore = await core.SessionStore.create({
      rootDir: paths.home,
      cwd: projectRoot,
      sessionId: "sess-stop-gate",
    });
    const ledger = await core.EvidenceLedger.open(
      path.join(root, "evidence.jsonl"),
    );
    const host = await core.createPiHost({
      cwd: projectRoot,
      workspaceRoot: projectRoot,
      deliveryRoot: projectRoot,
      codepunkHome: paths.home,
      sessionId: sessionStore.sessionId,
      runId: "run-stop-gate",
      writeSet: [projectRoot],
      approval: new core.ApprovalBroker(),
      ledger,
      sessionStore,
      model: TEST_MODEL,
      beforeStopHook: async (input) => {
        await hookRunner.run("before_stop", input, async (record) => {
          hookEvents.push(record);
        });
      },
    });
    try {
      await host.services.modelRuntime.setRuntimeApiKey("openai", "test-key");
      const calls = installScriptedStream(host.session, (index, context) => {
        if (index === 1) {
          const serialized = JSON.stringify(context.messages);
          assert.match(serialized, /before_stop hook blocked completion/u);
          assert.match(serialized, /gate-passed\.txt missing/u);
          return {
            type: "toolCall",
            id: "write-gate-file",
            name: "write",
            args: { path: "gate-passed.txt", content: "ok\n" },
          };
        }
        return { type: "text", text: `turn-${index + 1}` };
      });
      await host.session.prompt("finish the task");
      assert.equal(
        calls.length,
        3,
        "turn 1 blocked -> turn 2 wrote gate-passed.txt -> turn 3 settled",
      );
      assert.equal(hookEvents.length, 2);
      assert.equal(hookEvents[0].outcome, "failed");
      assert.equal(hookEvents[1].outcome, "passed");
      const runEnds = sessionStore.allEvents.filter(
        (ev) => ev.kind === "run/end",
      );
      assert.equal(runEnds.at(-1)?.data.state, "settled");
    } finally {
      await host.dispose();
      await ledger.close?.();
    }

    // Counterexample: persistent failure exhausts maxBeforeStopRetries and fails closed!
    await fs.unlink(gateFile);
    const failStore = await core.SessionStore.create({
      rootDir: paths.home,
      cwd: projectRoot,
      sessionId: "sess-stop-fail",
    });
    const failLedger = await core.EvidenceLedger.open(
      path.join(root, "evidence-fail.jsonl"),
    );
    const failHost = await core.createPiHost({
      cwd: projectRoot,
      workspaceRoot: projectRoot,
      deliveryRoot: projectRoot,
      codepunkHome: paths.home,
      sessionId: failStore.sessionId,
      runId: "run-stop-fail",
      writeSet: [projectRoot],
      approval: new core.ApprovalBroker(),
      ledger: failLedger,
      sessionStore: failStore,
      model: TEST_MODEL,
      maxBeforeStopRetries: 1,
      beforeStopHook: async (input) => {
        await hookRunner.run("before_stop", input, async () => {});
      },
    });
    try {
      await failHost.services.modelRuntime.setRuntimeApiKey(
        "openai",
        "test-key",
      );
      const failCalls = installScriptedStream(failHost.session, (index) => ({
        type: "text",
        text: `still-broken-${index + 1}`,
      }));
      await failHost.session.prompt("try finishing while broken");
      assert.equal(failCalls.length, 2);
      const failEnds = failStore.allEvents.filter(
        (ev) => ev.kind === "run/end",
      );
      assert.equal(failEnds.at(-1)?.data.state, "failed");
      assert.equal(failEnds.at(-1)?.data.termination, "before_stop_blocked");
    } finally {
      await failHost.dispose();
      await failLedger.close?.();
    }
  });
});
