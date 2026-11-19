import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { windowsSrtSkipReason } from "./support/helpers.mjs";
import { importCore } from "./support/core.mjs";
import { installScriptedStream, TEST_MODEL } from "./support/pi-model.mjs";

const core = await importCore();
const WINDOWS_SRT_SKIP = await windowsSrtSkipReason(core);

async function setup() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "codepunk-runtime-budget-")),
  );
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  const evidencePath = path.join(root, "evidence.jsonl");
  const ledger = await core.EvidenceLedger.open(evidencePath);
  return { root, project, home, evidencePath, ledger };
}

test("tool call budget blocks before execution on the runtime host path", async () => {
  const paths = await setup();
  try {
    await fs.writeFile(path.join(paths.project, "note.txt"), "note\n");
    const store = await core.SessionStore.create({
      rootDir: paths.home,
      cwd: paths.project,
      sessionId: "session-runtime-budget",
      heartbeatMs: 60_000,
    });
    const host = await core.createPiHost({
      cwd: paths.project,
      workspaceRoot: paths.project,
      deliveryRoot: paths.project,
      codepunkHome: paths.home,
      sessionId: store.sessionId,
      runId: "run-runtime-budget",
      writeSet: [paths.project],
      mode: "interactive",
      approval: null,
      ledger: paths.ledger,
      sandbox: null,
      sessionStore: store,
      model: TEST_MODEL,
      budget: { maxToolCalls: 2 },
    });
    try {
      await host.services.modelRuntime.setRuntimeApiKey("openai", "test-key");
      installScriptedStream(host.session, (index) => {
        if (index < 3) {
          return {
            type: "toolCall",
            id: `runtime-read-${index + 1}`,
            name: "read",
            args: { path: "note.txt" },
          };
        }
        return { type: "text", text: "done" };
      });

      await host.session.prompt("read the note three times");

      const budgetEvents = store.allEvents.filter(
        (event) => event.kind === "budget/exceeded",
      );
      assert.equal(budgetEvents.length, 1);
      assert.deepEqual(budgetEvents[0].data, {
        run_id: "run-runtime-budget",
        limit_kind: "tool_calls",
        limit: 2,
        used: 2,
        action: "reject_call",
      });
      const toolResults = host.session.messages.filter(
        (message) => message.role === "toolResult",
      );
      assert.equal(toolResults.length, 3);
      assert.match(
        JSON.stringify(toolResults[2].content),
        /denied: budget\.tool_calls/u,
      );
      const records = (await core.readEvidenceFile(paths.evidencePath)).records;
      const denied = records.find(
        (record) => record.tool_call_id === "runtime-read-3",
      );
      assert.ok(denied);
      assert.equal(denied.decision, "deny");
      assert.deepEqual(denied.budget_exceeded, budgetEvents[0].data);
    } finally {
      await host.dispose();
    }
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test(
  "wall budget aborts an in-flight host command with abort_run",
  {
    skip: process.platform === "win32" ? WINDOWS_SRT_SKIP : false,
  },
  async () => {
    const paths = await setup();
    const sandbox = await core.SrtSandbox.create({
      cwd: paths.project,
      workspaceRoot: paths.project,
      deliveryRoot: paths.project,
      codepunkHome: paths.home,
      writeSet: [paths.project],
      networkAllow: [],
    });
    try {
      const store = await core.SessionStore.create({
        rootDir: paths.home,
        cwd: paths.project,
        sessionId: "session-runtime-wall",
        heartbeatMs: 60_000,
      });
      const host = await core.createPiHost({
        cwd: paths.project,
        workspaceRoot: paths.project,
        deliveryRoot: paths.project,
        codepunkHome: paths.home,
        sessionId: store.sessionId,
        runId: "run-runtime-wall",
        writeSet: [paths.project],
        mode: "interactive",
        approvalMode: "allow",
        approval: null,
        ledger: paths.ledger,
        sandbox,
        sessionStore: store,
        model: TEST_MODEL,
        budget: { maxWallMs: 500 },
      });
      try {
        await host.services.modelRuntime.setRuntimeApiKey("openai", "test-key");
        installScriptedStream(host.session, (index) => {
          if (index === 0) {
            return {
              type: "toolCall",
              id: "runtime-wall-1",
              name: "bash",
              args: { command: "sleep 10" },
            };
          }
          return { type: "text", text: "done" };
        });

        const startedAt = performance.now();
        await host.session.prompt("sleep for ten seconds");
        const elapsed = performance.now() - startedAt;
        assert.ok(
          elapsed < 8_000,
          `wall budget did not interrupt the command (${elapsed} ms)`,
        );
        const budgetEvent = store.allEvents.find(
          (event) => event.kind === "budget/exceeded",
        );
        assert.ok(budgetEvent);
        assert.equal(budgetEvent.data.limit_kind, "wall_ms");
        assert.equal(budgetEvent.data.limit, 500);
        assert.equal(budgetEvent.data.action, "abort_run");
        const toolResult = host.session.messages.find(
          (message) => message.role === "toolResult",
        );
        assert.ok(toolResult);
        assert.match(JSON.stringify(toolResult.content), /Command aborted/u);
      } finally {
        await host.dispose();
      }
    } finally {
      await sandbox.close();
      await fs.rm(paths.root, { recursive: true, force: true });
    }
  },
);
