import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import { makeProject, withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();

function config(overrides = {}) {
  return {
    tools: {
      enabled: ["read", "search", "plan", "todo", "write", "edit", "shell"],
    },
    autonomy: { profile: "ask" },
    model: { enabled: [], thinking: "medium" },
    ...overrides,
  };
}

async function writePresets(paths, body) {
  await fs.writeFile(path.join(paths.home, "presets.toml"), body, "utf8");
}

test("presets load only from the user home and reject unknown keys", async () => {
  await withTempDirectory("codepunk-presets-", async (root) => {
    const { paths } = await makeProject(root);
    await writePresets(
      paths,
      [
        "version = 1",
        "[[preset]]",
        'name = "review"',
        'description = "Read-only review"',
        'model = "local/reviewer"',
        'thinking = "high"',
        'permission = "read-only"',
        'tools = ["read", "search"]',
        "",
      ].join("\n"),
    );
    const bundle = await core.loadProductPresets(paths);
    assert.equal(bundle.presets.length, 1);
    assert.equal(bundle.presets[0].model, "local/reviewer");
    const selected = core.selectProductPreset(
      bundle,
      config({ model: { enabled: ["local/reviewer"], thinking: "low" } }),
      "review",
    );
    assert.equal(selected.model, "local/reviewer");
    assert.equal(selected.thinking, "high");
    assert.deepEqual(selected.tools, ["read", "search"]);

    await fs.mkdir(paths.projectConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(paths.projectConfigDir, "presets.toml"),
      'version = 1\n[[preset]]\nname = "project"\n',
    );
    const ordered = await core.loadProductPresets(paths);
    assert.equal(ordered.presets.length, 1);
    assert.match(ordered.warnings.join("\n"), /inert/u);

    await writePresets(
      paths,
      'version = 1\n[[preset]]\nname = "bad"\napproval = "allow"\n',
    );
    await assert.rejects(
      core.loadProductPresets(paths),
      (error) =>
        error instanceof core.ProductPresetError &&
        error.code === "preset.unknown_key",
    );
    await writePresets(
      paths,
      [
        "version = 1",
        "[[preset]]",
        'name = "readonly-exec"',
        'permission = "read-only"',
        'tools = ["read", "exec"]',
        "",
      ].join("\n"),
    );
    await assert.rejects(
      core.loadProductPresets(paths),
      (error) => error.code === "preset.permission_mutation",
    );
  });
});

test("presets cannot widen tools, models, or read-only autonomy", async () => {
  const bundle = {
    presets: [
      {
        name: "wide",
        description: "",
        model: "local/other",
        thinking: null,
        permission: "standard",
        tools: ["shell"],
      },
    ],
    warnings: [],
  };
  assert.throws(
    () =>
      core.selectProductPreset(
        bundle,
        config({
          tools: { enabled: ["read", "search", "plan", "todo"] },
          model: { enabled: ["local/allowed"], thinking: "medium" },
        }),
        "wide",
      ),
    (error) => error.code === "preset.widen_tools",
  );
  assert.throws(
    () =>
      core.selectProductPreset(
        { ...bundle, presets: [{ ...bundle.presets[0], tools: [] }] },
        config({
          autonomy: { profile: "read-only" },
          tools: { enabled: [] },
          model: { enabled: ["local/other"], thinking: "medium" },
        }),
        "wide",
      ),
    (error) => error.code === "preset.widen_permission",
  );
  assert.throws(
    () =>
      core.selectProductPreset(
        { ...bundle, presets: [{ ...bundle.presets[0], tools: [] }] },
        config({
          tools: { enabled: [] },
          model: { enabled: ["local/allowed"], thinking: "medium" },
        }),
        "wide",
      ),
    (error) => error.code === "preset.widen_model",
  );
  assert.throws(
    () =>
      core.selectProductPreset(
        {
          ...bundle,
          presets: [
            {
              ...bundle.presets[0],
              permission: null,
              tools: ["read", "exec"],
            },
          ],
        },
        config({
          autonomy: { profile: "read-only" },
          tools: { enabled: ["read", "exec"] },
        }),
        "wide",
      ),
    (error) => error.code === "preset.permission_mutation",
  );
});

test("side task queues preserve independent bounded events", async () => {
  await withTempDirectory("codepunk-side-tasks-", async (root) => {
    const { paths } = await makeProject(root);
    const queue = new core.SideTaskQueue({
      paths,
      sessionId: "session-side",
      maxPending: 1,
      maxBudget: 2,
    });
    const record = await queue.enqueue("btw", "check the release note", 1);
    assert.equal(record.kind, "btw");
    assert.match(record.prompt_sha256, /^sha256:[0-9a-f]{64}$/u);
    await assert.rejects(
      queue.enqueue("side", "second", 1),
      (error) => error.code === "side.queue_full",
    );
    const filePath = path.join(
      paths.projectDir,
      "product",
      "side-tasks",
      "session-side.jsonl",
    );
    const records = (await fs.readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].type, "codepunk/side-task");
    assert.equal(records[0].status, "queued");
    assert.equal(records[0].budget, 1);
    assert.equal(records[0].prompt, "check the release note");
  });
});

test("side task queues hydrate durable state and advance transitions", async () => {
  await withTempDirectory("codepunk-side-tasks-restart-", async (root) => {
    const { paths } = await makeProject(root);
    const first = new core.SideTaskQueue({
      paths,
      sessionId: "session-restart",
      maxPending: 2,
      maxBudget: 2,
    });
    const record = await first.enqueue("side", "inspect the failing test", 2);
    const restarted = new core.SideTaskQueue({
      paths,
      sessionId: "session-restart",
      maxPending: 2,
      maxBudget: 2,
    });
    assert.equal(restarted.queued.length, 0);
    await restarted.hydrate();
    assert.equal(restarted.queued.length, 1);
    assert.equal(restarted.queued[0].id, record.id);
    assert.equal(restarted.queued[0].prompt, "inspect the failing test");
    const running = await restarted.take(record.id);
    assert.equal(running?.status, "running");
    assert.equal(restarted.queued.length, 0);
    const interrupted = new core.SideTaskQueue({
      paths,
      sessionId: "session-restart",
      maxPending: 2,
      maxBudget: 2,
    });
    await interrupted.hydrate();
    assert.equal(interrupted.queued.length, 0);
    assert.equal(interrupted.running.length, 1);
    assert.equal(interrupted.running[0].id, record.id);
    const recovered = await interrupted.recover(record.id);
    assert.equal(recovered?.status, "queued");
    assert.equal(interrupted.queued.length, 1);
    assert.equal(interrupted.queued[0].prompt, "inspect the failing test");
    await interrupted.take(record.id);
    const completed = await restarted.finish(record.id, "completed");
    assert.equal(completed?.status, "completed");
    await assert.rejects(
      restarted.finish(record.id, "cancelled"),
      (error) => error.code === "side.transition",
    );
    await assert.rejects(
      restarted.enqueue("btw", "third", 3),
      (error) => error.code === "side.budget",
    );
    await assert.rejects(
      restarted.enqueue("btw", "   ", 1),
      (error) => error.code === "side.prompt",
    );
  });
});

test("side task queue ids are path-safe and multi-instance writes serialize", async () => {
  await withTempDirectory("codepunk-side-tasks-concurrent-", async (root) => {
    const { paths } = await makeProject(root);
    assert.throws(
      () =>
        new core.SideTaskQueue({
          paths,
          sessionId: "../../escaped",
        }),
      (error) => error.code === "side.session_id",
    );
    const first = new core.SideTaskQueue({
      paths,
      sessionId: "session-concurrent",
      maxPending: 40,
    });
    const second = new core.SideTaskQueue({
      paths,
      sessionId: "session-concurrent",
      maxPending: 40,
    });
    const records = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 === 0 ? first : second).enqueue(
          index % 2 === 0 ? "btw" : "side",
          `task ${index}`,
          1,
        ),
      ),
    );
    assert.equal(new Set(records.map((record) => record.seq)).size, 40);
    const restarted = new core.SideTaskQueue({
      paths,
      sessionId: "session-concurrent",
      maxPending: 40,
    });
    await restarted.hydrate();
    assert.equal(restarted.queued.length, 40);
  });
});

test("side task queue compacts before its on-disk byte limit is exceeded", async () => {
  await withTempDirectory("codepunk-side-tasks-bounded-", async (root) => {
    const { paths } = await makeProject(root);
    const queue = new core.SideTaskQueue({
      paths,
      sessionId: "session-bounded",
      maxPending: 1,
      maxBudget: 1,
    });
    const prompt = "x".repeat(32_000);
    for (let index = 0; index < 20; index += 1) {
      const record = await queue.enqueue("btw", prompt, 1);
      await queue.take(record.id);
      await queue.finish(record.id, "completed");
    }
    const filePath = path.join(
      paths.projectDir,
      "product",
      "side-tasks",
      "session-bounded.jsonl",
    );
    const stat = await fs.stat(filePath);
    assert.ok(stat.size <= 1024 * 1024);
    const restarted = new core.SideTaskQueue({
      paths,
      sessionId: "session-bounded",
      maxPending: 1,
      maxBudget: 1,
    });
    await restarted.hydrate();
    assert.equal(restarted.queued.length, 0);
    assert.equal(restarted.running.length, 0);
  });
});

test("side task recoverAll requeues every interrupted task", async () => {
  await withTempDirectory("codepunk-side-tasks-recover-all-", async (root) => {
    const { paths } = await makeProject(root);
    const first = new core.SideTaskQueue({
      paths,
      sessionId: "session-recover-all",
      maxPending: 2,
    });
    const left = await first.enqueue("btw", "left", 1);
    const right = await first.enqueue("side", "right", 1);
    await first.take(left.id);
    await first.take(right.id);
    const restarted = new core.SideTaskQueue({
      paths,
      sessionId: "session-recover-all",
      maxPending: 2,
    });
    await restarted.hydrate();
    assert.equal(restarted.running.length, 2);
    const recovered = await restarted.recoverAll();
    assert.equal(recovered.length, 2);
    assert.equal(restarted.queued.length, 2);
    assert.equal(restarted.running.length, 0);
  });
});

test("side task lock ignores and prunes stale claims", async () => {
  await withTempDirectory("codepunk-side-tasks-stale-lock-", async (root) => {
    const { paths } = await makeProject(root);
    const queue = new core.SideTaskQueue({
      paths,
      sessionId: "session-stale-lock",
    });
    await queue.enqueue("btw", "first", 1);
    const lockDir = path.join(
      paths.projectDir,
      "product",
      "side-tasks",
      "session-stale-lock.jsonl.lock.d",
    );
    await fs.mkdir(lockDir, { recursive: true });
    const stale = path.join(lockDir, "1-1-stale.claim");
    await fs.writeFile(
      stale,
      `${JSON.stringify({
        pid: 1,
        nonce: "stale",
        created_ms: 1,
        created_at: "1970-01-01T00:00:00.000Z",
      })}\n`,
    );
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(stale, old, old);
    await queue.enqueue("btw", "second", 1);
    await assert.rejects(fs.stat(stale), (error) => error.code === "ENOENT");
  });
});

test("side task queue waits for a fresh foreign claim", async () => {
  await withTempDirectory("codepunk-side-tasks-foreign-lock-", async (root) => {
    const { paths } = await makeProject(root);
    const queue = new core.SideTaskQueue({
      paths,
      sessionId: "session-foreign-lock",
      lockTimeoutMs: 150,
    });
    const lockDir = path.join(
      paths.projectDir,
      "product",
      "side-tasks",
      "session-foreign-lock.jsonl.lock.d",
    );
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      path.join(lockDir, "foreign.claim"),
      `${JSON.stringify({
        pid: process.pid,
        nonce: "foreign",
        created_ms: Date.now() - 1_000,
        created_at: new Date().toISOString(),
      })}\n`,
    );
    await assert.rejects(
      queue.enqueue("btw", "blocked", 1),
      (error) => error.code === "side.queue_busy",
    );
  });
});

test("side task queue corruption fails closed", async () => {
  await withTempDirectory("codepunk-side-tasks-corrupt-", async (root) => {
    const { paths } = await makeProject(root);
    const queue = new core.SideTaskQueue({
      paths,
      sessionId: "session-corrupt",
    });
    const filePath = path.join(
      paths.projectDir,
      "product",
      "side-tasks",
      "session-corrupt.jsonl",
    );
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      `${JSON.stringify({
        type: "codepunk/side-task",
        version: 1,
        seq: 2,
        id: "broken",
        session_id: "session-corrupt",
        kind: "btw",
        prompt: "broken",
        prompt_sha256: `sha256:${"0".repeat(64)}`,
        budget: 1,
        status: "queued",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    await assert.rejects(
      queue.hydrate(),
      (error) => error.code === "side.queue_corrupt",
    );
  });
});

test("recap binds a contiguous event range", () => {
  const events = [1, 2, 3].map((seq) => ({
    seq,
    kind: seq === 2 ? "user/input" : "run/start",
  }));
  const recap = core.createSessionRecap(events, 1, 3);
  assert.equal(recap.event_count, 3);
  assert.deepEqual(recap.kinds, { "run/start": 2, "user/input": 1 });
  assert.match(recap.body_sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.throws(
    () => core.createSessionRecap([events[0], events[2]], 1, 3),
    (error) => error.code === "recap.broken_range",
  );
  assert.throws(
    () => core.createSessionRecap(events, 2, 4),
    (error) => error.code === "recap.broken_range",
  );
  assert.throws(
    () => core.createSessionRecap(events, 0, 2),
    (error) => error.code === "recap.range",
  );
});
