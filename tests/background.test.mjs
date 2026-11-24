import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import nodeTest from "node:test";
import { importCore } from "./support/core.mjs";
import { withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();

// Background tasks require POSIX process groups, so the whole suite is
// unsupported on Windows.
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;

const CHILD_SCRIPT = `
const fs = require("node:fs");
const target = process.argv[1];
process.stdout.write("ready\\n");
process.stderr.write("stderr-ready\\n");
fs.writeFileSync(target, "0\\n");
let count = 0;
const timer = setInterval(() => {
  count += 1;
  fs.appendFileSync(target, String(count) + "\\n");
}, 25);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      process.stdout.write("steer:" + line + "\\n");
    }
  }
});
const stop = () => {
  clearInterval(timer);
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;

async function project(root) {
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  const projectId = core.projectIdFor(cwd);
  const paths = core.projectPaths({ cwd, deliveryRoot: cwd, projectId }, home);
  await core.ensureProjectRegistration(
    {
      cwd,
      deliveryRoot: cwd,
      projectId,
      isGitRepository: false,
    },
    paths,
  );
  return { cwd, home, paths };
}

function manager(paths, options = {}) {
  return new core.BackgroundTaskManager({
    paths,
    sessionId: "session-background",
    ...options,
  });
}

async function waitFor(predicate, message = "condition was not reached") {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

async function readEvidence(filePath) {
  return (await fs.readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function startChild(instance, root, title = "long task") {
  const marker = path.join(root, `${title.replaceAll(" ", "-")}.txt`);
  const snapshot = await instance.start({
    title,
    command: process.execPath,
    args: ["-e", CHILD_SCRIPT, marker],
    cwd: root,
  });
  await waitFor(
    async () => (await instance.logs(snapshot.id)).stdout.includes("ready"),
    "background child did not start",
  );
  return { snapshot, marker };
}

async function killLeftover(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

test("background tasks expose ps/logs/stop, steering, artifacts, and evidence", async () => {
  await withTempDirectory("codepunk-background-", async (root) => {
    const { paths } = await project(root);
    const instance = manager(paths);
    const { snapshot, marker } = await startChild(instance, root);
    try {
      const listed = instance.ps();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].id, snapshot.id);
      assert.equal(listed[0].status, "running");
      assert.ok(listed[0].pid > 0);

      const logs = await instance.logs(snapshot.id);
      assert.match(logs.stdout, /ready/u);
      assert.match(logs.stderr, /stderr-ready/u);
      assert.equal(logs.stdout_truncated, false);

      const steered = await instance.steer(snapshot.id, "keep going");
      assert.deepEqual(steered.steering_history, ["keep going"]);
      await waitFor(
        async () =>
          (await instance.logs(snapshot.id)).stdout.includes(
            "steer:keep going",
          ),
        "steering message was not delivered",
      );

      const stopped = await instance.stop(snapshot.id);
      assert.equal(stopped.status, "stopped");
      const before = await fs.readFile(marker, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(
        await fs.readFile(marker, "utf8"),
        before,
        "stopped task continued to create side effects",
      );

      const stdout = path.join(
        paths.artifactsDir,
        "background",
        snapshot.id,
        "stdout.log",
      );
      const stderr = path.join(
        paths.artifactsDir,
        "background",
        snapshot.id,
        "stderr.log",
      );
      assert.match(await fs.readFile(stdout, "utf8"), /ready/u);
      assert.match(await fs.readFile(stderr, "utf8"), /stderr-ready/u);

      const evidencePath = path.join(
        paths.projectDir,
        "background",
        snapshot.id,
        "evidence.jsonl",
      );
      const evidence = await readEvidence(evidencePath);
      assert.deepEqual(
        evidence.map((record) => record.rule),
        [
          "background.start",
          "background.steer",
          "background.stop",
          "background.end",
        ],
      );
      assert.equal(
        evidence.at(-1).output_ref,
        `background/${snapshot.id}/stdout.log`,
      );
      assert.match(evidence.at(-1).output_sha256, /^sha256:[0-9a-f]{64}$/u);
    } finally {
      const current = instance.status(snapshot.id);
      if (current.status === "running" || current.status === "stopping") {
        await instance.stop(snapshot.id).catch(() => undefined);
      }
    }
  });
});

test("background queue bounds preserve rejection evidence", async () => {
  await withTempDirectory("codepunk-background-queue-", async (root) => {
    const { paths } = await project(root);
    const instance = manager(paths, {
      maxConcurrent: 1,
      maxTasks: 2,
      maxSteeringQueue: 1,
    });
    const first = await startChild(instance, root, "blocking task");
    const second = await instance.start({
      title: "queued task",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
    });
    try {
      assert.equal(second.status, "queued");
      const queued = await instance.steer(second.id, "one");
      assert.deepEqual(queued.steering, ["one"]);
      await assert.rejects(
        instance.steer(second.id, "two"),
        core.BackgroundQueueFullError,
      );
      const evidence = await readEvidence(
        path.join(paths.projectDir, "background", second.id, "evidence.jsonl"),
      );
      assert.equal(evidence.at(-1).rule, "background.queue_full");
      assert.equal(evidence.at(-1).decision, "deny");

      await assert.rejects(
        instance.start({
          title: "overflow task",
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: root,
        }),
        (error) =>
          error instanceof core.BackgroundQueueFullError &&
          typeof error.evidenceRef === "string",
      );
    } finally {
      await instance.stop(second.id).catch(() => undefined);
      await instance.stop(first.snapshot.id).catch(() => undefined);
    }
  });
});

test("background rejects path traversal before queue rejection writes", async () => {
  await withTempDirectory("codepunk-background-id-", async (root) => {
    const { paths } = await project(root);
    const instance = manager(paths, { maxConcurrent: 1, maxTasks: 1 });
    const first = await startChild(instance, root, "queue blocker");
    try {
      await assert.rejects(
        instance.start({
          id: "../escaped",
          title: "escaped",
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: root,
        }),
        (error) =>
          error instanceof core.BackgroundTaskError &&
          error.code === "background.invalid_id",
      );
      await assert.rejects(
        fs.access(path.join(paths.projectDir, "escaped", "task.json")),
        /ENOENT/u,
      );
      await assert.rejects(
        fs.access(path.join(paths.projectDir, "escaped", "evidence.jsonl")),
        /ENOENT/u,
      );
    } finally {
      await instance.stop(first.snapshot.id).catch(() => undefined);
    }
  });
});

test("background log sink failure prevents the child from starting", async () => {
  await withTempDirectory("codepunk-background-log-error-", async (root) => {
    const { paths } = await project(root);
    const instance = manager(paths);
    const marker = path.join(root, "log-side-effect.txt");
    await fs.mkdir(
      path.join(paths.artifactsDir, "background", "bad-log", "stdout.log"),
      { recursive: true },
    );
    const started = await instance.start({
      id: "bad-log",
      title: "unwritable log",
      command: process.execPath,
      args: [
        "-e",
        `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(
          marker,
        )}, "SIDE EFFECT"), 100)`,
      ],
      cwd: root,
    });
    assert.equal(started.status, "failed");
    assert.equal(started.pid, null);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await assert.rejects(fs.access(marker), /ENOENT/u);
    const evidence = await readEvidence(
      path.join(paths.projectDir, "background", "bad-log", "evidence.jsonl"),
    );
    assert.equal(evidence.at(-1).rule, "background.spawn_refused");
  });
});

test("background start persistence failure releases the claim", async () => {
  await withTempDirectory("codepunk-background-record-error-", async (root) => {
    const { paths } = await project(root);
    const claimStore = new core.ClaimStore({
      paths,
      leaseMs: 120,
    });
    const instance = manager(paths, { claimStore });
    await fs.mkdir(
      path.join(paths.projectDir, "background", "bad-record", "task.json"),
      { recursive: true },
    );
    await assert.rejects(
      instance.start({
        id: "bad-record",
        title: "unwritable record",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: root,
      }),
      /EISDIR|directory/u,
    );
    assert.deepEqual(instance.ps(), []);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(
      await claimStore.inspect("background:bad-record"),
      null,
      "an unreported task must not keep renewing a claim",
    );
  });
});

test("background steering reports a closed stdin as a failure", async () => {
  await withTempDirectory("codepunk-background-steer-error-", async (root) => {
    const { paths } = await project(root);
    const instance = manager(paths);
    const started = await instance.start({
      id: "closed-stdin",
      title: "closed stdin",
      command: process.execPath,
      args: [
        "-e",
        'require("node:fs").closeSync(0); process.stdout.write("READY\\n"); setInterval(() => {}, 1000)',
      ],
      cwd: root,
    });
    try {
      await waitFor(
        async () => (await instance.logs(started.id)).stdout.includes("READY"),
        "closed-stdin child did not start",
      );
      await assert.rejects(
        instance.steer(started.id, "must not claim delivery"),
        (error) =>
          error instanceof core.BackgroundTaskError &&
          error.code === "background.steer_failed",
      );
      const current = instance.status(started.id);
      assert.deepEqual(current.steering, ["must not claim delivery"]);
      assert.deepEqual(current.steering_history, []);
      const evidence = await readEvidence(
        path.join(paths.projectDir, "background", started.id, "evidence.jsonl"),
      );
      const failure = evidence.find(
        (record) => record.rule === "background.steer_failed",
      );
      assert.ok(failure);
      assert.equal(failure.decision, "deny");
    } finally {
      await instance.stop(started.id).catch(() => undefined);
      await instance.wait(started.id).catch(() => undefined);
    }
  });
});

test("queued steering is delivered when the task starts", async () => {
  await withTempDirectory("codepunk-background-steering-", async (root) => {
    const { paths } = await project(root);
    const instance = manager(paths, { maxConcurrent: 1, maxTasks: 2 });
    const first = await startChild(instance, root, "first task");
    const second = await instance.start({
      title: "second task",
      command: process.execPath,
      args: ["-e", CHILD_SCRIPT, path.join(root, "second.txt")],
      cwd: root,
    });
    try {
      assert.equal(second.status, "queued");
      const queued = await instance.steer(second.id, "queued-message");
      assert.deepEqual(queued.steering, ["queued-message"]);
      await instance.stop(first.snapshot.id);
      await waitFor(
        async () => (await instance.status(second.id)).status === "running",
        "second task did not start",
      );
      await waitFor(
        async () =>
          (await instance.logs(second.id)).stdout.includes(
            "steer:queued-message",
          ),
        "queued steering was not delivered",
      );
      const running = instance.status(second.id);
      assert.deepEqual(running.steering, []);
      assert.deepEqual(running.steering_history, ["queued-message"]);
    } finally {
      await instance.stop(second.id).catch(() => undefined);
      await instance.stop(first.snapshot.id).catch(() => undefined);
    }
  });
});

test("background hydration exposes durable tasks and logs", async () => {
  await withTempDirectory("codepunk-background-hydrate-", async (root) => {
    const { paths } = await project(root);
    const first = manager(paths);
    const started = await first.start({
      title: "durable task",
      command: process.execPath,
      args: ["-e", 'process.stdout.write("durable\\n"); process.exit(0);'],
      cwd: root,
    });
    const finished = await first.wait(started.id);
    assert.equal(finished.status, "completed");

    const second = manager(paths);
    await second.hydrate();
    const listed = second.ps().find((task) => task.id === started.id);
    assert.ok(listed);
    assert.equal(listed.status, "completed");
    assert.match((await second.logs(started.id)).stdout, /durable/u);
  });
});

test("a lost background lease cannot stop or be reclaimed with the old claim", async () => {
  await withTempDirectory("codepunk-background-lease-", async (root) => {
    const { paths } = await project(root);
    let now = Date.parse("2026-11-20T09:00:00.000Z");
    const claimStore = new core.ClaimStore({
      paths,
      leaseMs: 10_000,
      now: () => new Date(now),
    });
    const instance = manager(paths, {
      claimStore,
      now: () => new Date(now),
    });
    const { snapshot } = await startChild(instance, root, "lease task");
    try {
      assert.ok(snapshot.claim);
      now += 10_001;
      await assert.rejects(
        instance.stop(snapshot.id),
        (error) =>
          error instanceof core.BackgroundTaskError &&
          error.code === "background.stale_lease",
      );
      const reclaimed = await claimStore.acquire(
        `background:${snapshot.id}`,
        "background:other-session",
      );
      assert.ok(reclaimed.fence > snapshot.claim.fence);
      await assert.rejects(
        instance.stop(snapshot.id),
        (error) =>
          error instanceof core.BackgroundTaskError &&
          error.code === "background.stale_lease",
      );
      const evidence = await readEvidence(
        path.join(
          paths.projectDir,
          "background",
          snapshot.id,
          "evidence.jsonl",
        ),
      );
      assert.equal(
        evidence.filter((record) => record.rule === "background.stale_lease")
          .length,
        2,
      );
    } finally {
      if (snapshot.pid !== null) {
        await killLeftover(snapshot.pid);
      }
      await instance.wait(snapshot.id).catch(() => undefined);
    }
  });
});

test("background status converges for a normal process exit", async () => {
  await withTempDirectory("codepunk-background-exit-", async (root) => {
    const { paths } = await project(root);
    const instance = manager(paths);
    const started = await instance.start({
      title: "short task",
      command: process.execPath,
      args: ["-e", 'process.stdout.write("done\\n"); process.exit(0);'],
      cwd: root,
    });
    const finished = await instance.wait(started.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.exit_code, 0);
    assert.notEqual(finished.ended_at, null);
    assert.match((await instance.logs(started.id)).stdout, /done/u);
  });
});
