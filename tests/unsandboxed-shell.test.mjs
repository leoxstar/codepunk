import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import {
  ensureBuilt,
  makeProject,
  withTempDirectory,
} from "./support/helpers.mjs";

const core = await importCore();
const execFileAsync = promisify(execFile);

test("explicit unsandboxed shell records direct execution and uncovered coverage", async () => {
  await withTempDirectory("codepunk-unsandboxed-", async (root) => {
    const shell = new core.UnsandboxedShell();
    const command = await shell.execCommand("printf direct", root);
    assert.equal(command.exitCode, 0);
    assert.equal(command.output, "direct");
    assert.equal(command.executor, "direct");
    assert.deepEqual(command.descriptor, {
      backend: "none",
      version: null,
      profile_sha256: null,
    });

    const argv = await shell.execArgv(
      [process.execPath, "-e", "process.stdout.write('argv')"],
      root,
    );
    assert.equal(argv.exitCode, 0);
    assert.equal(argv.output, "argv");
    await shell.close();
  });
});

test("unsandboxed shell evidence is labeled uncovered", async () => {
  await withTempDirectory("codepunk-unsandboxed-evidence-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
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
          content: [{ type: "text", text: "ok" }],
          details: {},
          structuredContent: { output: "ok", exit_code: 0 },
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
      sandbox: new core.UnsandboxedShell(),
    });
    await wrapped.execute(
      "call-1",
      { command: "printf ok" },
      undefined,
      undefined,
      undefined,
    );
    const record = ledger.all[0];
    assert.equal(record.decision, "allow");
    assert.equal(record.coverage, "uncovered");
    assert.equal(record.executor, "direct");
    assert.deepEqual(record.sandbox, {
      backend: "none",
      version: null,
      profile_sha256: null,
    });
    const verdict = core.validateEvidenceForClass(record);
    assert.equal(verdict.ok, false);
    assert.match(verdict.issues.join("\n"), /uncovered/u);
  });
});

test("--allow-unsandboxed-shell is rejected in print mode", async () => {
  const entry = await ensureBuilt();
  await withTempDirectory("codepunk-unsandboxed-cli-", async (root) => {
    await makeProject(root);
    let code = 0;
    let stderr = "";
    try {
      await execFileAsync(
        process.execPath,
        [entry, "-p", "hello", "--allow-unsandboxed-shell"],
        { cwd: path.join(root, "project") },
      );
    } catch (error) {
      code = error.code;
      stderr = error.stderr;
    }
    assert.equal(code, 1);
    assert.match(stderr, /interactive only/u);
  });
});
