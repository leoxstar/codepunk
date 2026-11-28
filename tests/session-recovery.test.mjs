import assert from "node:assert/strict";
import { promises as fsPromises } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importCore, importSource } from "./support/core.mjs";
import { makeProject } from "./support/helpers.mjs";

const core = await importCore();

const SHA256_ZERO = `sha256:${"0".repeat(64)}`;

function advancingClock() {
  let current = new Date("2026-11-12T00:00:00.000Z");
  return () => {
    const value = new Date(current);
    current = new Date(current.getTime() + 1000);
    return value;
  };
}

const BENIGN_KINDS = [
  "context/loaded",
  "autonomy/profile",
  "autonomy/revoked",
  "trust/decision",
  "memory/write",
  "verdict/sign_off",
];

async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codepunk-recovery-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function benignEventData(kind) {
  switch (kind) {
    case "context/loaded":
      return { sources: [], warnings: [], total_bytes: 0, truncated: false };
    case "autonomy/profile":
      return {
        profile: "read-only",
        source: "default",
        rules_sha256: null,
        rules: [],
      };
    case "autonomy/revoked":
      return { profile: "read-only", reason: "session_end" };
    case "trust/decision":
      return {
        cwd: "/workspace",
        root: "/workspace",
        decision: "trusted",
        source: "default",
        resources: [],
        skipped: [],
      };
    case "memory/write":
      return {
        scope: "project",
        action: "add",
        memory_id: null,
        content_sha256: SHA256_ZERO,
        source_refs: [],
        reason: null,
      };
    case "verdict/sign_off":
      return {
        sign_off_id: "sign-off-1",
        previous_sign_off_id: null,
        run_id: "run-1",
        evidence_head: SHA256_ZERO,
        signed_verdict: "complete",
        channel: "cli",
        actor: "test",
        signed_at: "2026-11-24T00:00:00.000Z",
      };
    default:
      throw new Error(`unknown benign tail kind: ${kind}`);
  }
}

async function prepareRecoveryProject(root, tailKinds) {
  const { projectRoot, paths } = await makeProject(
    await fsPromises.realpath(root),
  );
  const projectId = core.projectIdFor(projectRoot);
  const store = await core.SessionStore.create({
    rootDir: paths.home,
    cwd: projectRoot,
    projectId,
    now: advancingClock(),
    heartbeatMs: 60_000,
  });
  const writer = await store.acquireWriter();
  await store.append("user/input", { run_id: "run-1", text: "committed" });
  await store.saveAgentState(
    { type: "session", id: store.sessionId, cwd: projectRoot },
    [],
    { entries: [], leafId: null },
  );
  const coveredSeq = store.metadata.state_covers_seq;
  for (const kind of tailKinds) {
    await store.append(kind, benignEventData(kind));
  }
  await writer.release();
  return { projectRoot, paths, projectId, store, coveredSeq };
}

async function createRuntimeForSession(projectRoot, paths, sessionId) {
  return core.createRuntime({
    cwd: projectRoot,
    environment: { ...process.env, CODEPUNK_HOME: paths.home },
    sessionId,
    allowMissingModel: true,
  });
}

async function readPersistedFiles(store) {
  return {
    log: await readFile(store.paths.logPath, "utf8"),
    meta: await readFile(store.paths.metaPath, "utf8"),
    state: await readFile(store.paths.statePath, "utf8"),
  };
}

async function reopenStore(rootDir, projectId, projectRoot, sessionId) {
  return core.SessionStore.open({
    rootDir,
    cwd: projectRoot,
    projectId,
    sessionId,
  });
}

async function openAnotherWriter(paths, projectId, projectRoot, sessionId) {
  const store = await reopenStore(
    paths.home,
    projectId,
    projectRoot,
    sessionId,
  );
  const writer = await store.acquireWriter();
  return {
    store,
    async release() {
      await writer.release();
    },
  };
}

async function createHostForStore(projectRoot, paths, store) {
  const ledger = await core.EvidenceLedger.open(
    path.join(paths.home, "recovery-race-evidence.jsonl"),
  );
  return core.createPiHost({
    cwd: projectRoot,
    workspaceRoot: projectRoot,
    deliveryRoot: projectRoot,
    codepunkHome: paths.home,
    sessionId: store.sessionId,
    runId: "run-recovery-race",
    writeSet: [projectRoot],
    mode: "print",
    approval: null,
    ledger,
    sandbox: null,
    sessionStore: store,
    restore: await store.readAgentState(),
    bindMode: "print",
  });
}

for (const kind of BENIGN_KINDS) {
  test(`benign tail recovery restores a single ${kind} event`, async () => {
    await withTempDirectory(async (root) => {
      const { projectRoot, paths, projectId, store, coveredSeq } =
        await prepareRecoveryProject(root, [kind]);
      const before = await readPersistedFiles(store);

      const runtime = await createRuntimeForSession(
        projectRoot,
        paths,
        store.sessionId,
      );
      await runtime.dispose();
      const reopened = await reopenStore(
        paths.home,
        projectId,
        projectRoot,
        store.sessionId,
      );
      assert.equal(
        reopened.metadata.state_covers_seq,
        reopened.metadata.log_seq,
      );
      assert.ok(reopened.metadata.state_covers_seq > coveredSeq);
      const after = await readPersistedFiles(reopened);
      assert.ok(after.log.startsWith(before.log));
      const afterMeta = JSON.parse(after.meta);
      assert.ok(afterMeta.log_seq > JSON.parse(before.meta).log_seq);
      assert.notEqual(after.state, before.state);
    });
  });
}

test("benign tail recovery restores a mixed whitelist tail", async () => {
  await withTempDirectory(async (root) => {
    const mixedKinds = [...BENIGN_KINDS].reverse();
    const { projectRoot, paths, projectId, store, coveredSeq } =
      await prepareRecoveryProject(root, mixedKinds);
    const before = await readPersistedFiles(store);

    const runtime = await createRuntimeForSession(
      projectRoot,
      paths,
      store.sessionId,
    );
    await runtime.dispose();
    const reopened = await reopenStore(
      paths.home,
      projectId,
      projectRoot,
      store.sessionId,
    );
    assert.equal(reopened.metadata.state_covers_seq, reopened.metadata.log_seq);
    assert.ok(reopened.metadata.state_covers_seq > coveredSeq);
    const after = await readPersistedFiles(reopened);
    assert.ok(after.log.startsWith(before.log));
    assert.ok(after.log.length > before.log.length);
    const state = await reopened.readAgentState();
    assert.ok(state);
    const leafEntry = state.entries.find(
      (entry) => entry?.id === state.leaf_id,
    );
    assert.ok(leafEntry);
  });
});

for (const [name, tailKinds] of [
  ["user/input", ["user/input"]],
  ["approval/answer", ["approval/answer"]],
  ["a whitelist event followed by run/start", ["context/loaded", "run/start"]],
]) {
  test(`runtime refuses a non-benign tail (${name}) without changing files`, async () => {
    await withTempDirectory(async (root) => {
      const { projectRoot, paths, store } = await prepareRecoveryProject(
        root,
        [],
      );
      const writer = await store.acquireWriter();
      for (const kind of tailKinds) {
        if (kind === "user/input") {
          await store.append("user/input", { run_id: "run-1", text: "tail" });
        } else if (kind === "approval/answer") {
          await store.append("approval/answer", {
            request_id: "request-1",
            answer: "deny",
            channel: "test",
            channel_id: "channel-1",
            nonce_sha256: SHA256_ZERO,
            worker_id: "worker-1",
            session_id: store.sessionId,
            tool_call_id: "tool-call-1",
            answered_at: "2026-11-24T00:00:00.000Z",
          });
        } else if (kind === "run/start") {
          await store.append("run/start", {
            run_id: "run-2",
            session_id: store.sessionId,
          });
        } else {
          await store.append(kind, benignEventData(kind));
        }
      }
      await writer.release();
      const before = await readPersistedFiles(store);

      await assert.rejects(
        () => createRuntimeForSession(projectRoot, paths, store.sessionId),
        /uncommitted event\(s\) after the last agent-state snapshot/u,
      );
      const after = await readPersistedFiles(store);
      assert.deepEqual(after, before);
    });
  });
}

for (const missingField of ["entries", "leaf_id"]) {
  test(`runtime refuses a benign tail when agent-state lacks ${missingField}`, async () => {
    await withTempDirectory(async (root) => {
      const { projectRoot, paths, store } = await prepareRecoveryProject(
        root,
        [],
      );
      const writer = await store.acquireWriter();
      await store.append("context/loaded", benignEventData("context/loaded"));
      await writer.release();

      const saved = JSON.parse(await readFile(store.paths.statePath, "utf8"));
      delete saved[missingField];
      await writeFile(
        store.paths.statePath,
        `${JSON.stringify(saved)}\n`,
        "utf8",
      );
      const before = await readPersistedFiles(store);
      const metadataBeforeAttempt = before.meta;

      await assert.rejects(
        () => createRuntimeForSession(projectRoot, paths, store.sessionId),
        /agent-state entry tree is incomplete/u,
      );
      assert.equal(
        await readFile(store.paths.metaPath, "utf8"),
        metadataBeforeAttempt,
      );
      assert.equal(await readFile(store.paths.statePath, "utf8"), before.state);
    });
  });
}

test("TUI resume preflight accepts benign tails and rejects semantic tails", async () => {
  const { sessionResumeIssue } = await importSource("packages/cli/src/tui.ts");
  await withTempDirectory(async (root) => {
    const { projectRoot, paths, store } = await prepareRecoveryProject(root, [
      "context/loaded",
      "memory/write",
    ]);
    const runtime = {
      paths: {
        home: paths.home,
        cwd: projectRoot,
        deliveryRoot: projectRoot,
        projectId: core.projectIdFor(projectRoot),
      },
    };
    assert.equal(await sessionResumeIssue(runtime, store.sessionId), null);

    const writer = await store.acquireWriter();
    await store.append("run/start", {
      run_id: "run-2",
      session_id: store.sessionId,
    });
    await writer.release();
    const issue = await sessionResumeIssue(runtime, store.sessionId);
    assert.match(
      issue ?? "",
      /uncommitted event\(s\) after the last agent-state snapshot/u,
    );
  });
});

test("a semantic event appended after open is rejected before any session write", async () => {
  await withTempDirectory(async (root) => {
    const { projectRoot, paths, projectId, store } =
      await prepareRecoveryProject(root, []);
    const stale = await reopenStore(
      paths.home,
      projectId,
      projectRoot,
      store.sessionId,
    );
    const other = await openAnotherWriter(
      paths,
      projectId,
      projectRoot,
      store.sessionId,
    );
    await other.store.append("user/input", {
      run_id: "run-raced",
      text: "appended after the reader opened",
    });
    await other.release();
    const before = await readPersistedFiles(stale);

    await assert.rejects(
      () => createHostForStore(projectRoot, paths, stale),
      /benign tail recovery cannot verify the session snapshot coverage/u,
    );

    const after = await readPersistedFiles(stale);
    assert.deepEqual(after, before);
    const seqs = after.log
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line).seq);
    assert.equal(new Set(seqs).size, seqs.length);
  });
});

test("a benign event appended after open is covered by the recovery snapshot", async () => {
  await withTempDirectory(async (root) => {
    const { projectRoot, paths, projectId, store, coveredSeq } =
      await prepareRecoveryProject(root, []);
    const stale = await reopenStore(
      paths.home,
      projectId,
      projectRoot,
      store.sessionId,
    );
    const other = await openAnotherWriter(
      paths,
      projectId,
      projectRoot,
      store.sessionId,
    );
    await other.store.append("memory/write", benignEventData("memory/write"));
    await other.release();
    const before = await readPersistedFiles(stale);

    const host = await createHostForStore(projectRoot, paths, stale);
    await host.dispose();

    const reopened = await reopenStore(
      paths.home,
      projectId,
      projectRoot,
      store.sessionId,
    );
    assert.ok(reopened.metadata.state_covers_seq > coveredSeq);
    assert.equal(reopened.metadata.state_covers_seq, reopened.metadata.log_seq);
    const after = await readPersistedFiles(reopened);
    assert.ok(after.log.startsWith(before.log));
    const seqs = after.log
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line).seq);
    assert.equal(new Set(seqs).size, seqs.length);
  });
});

test("a lagging meta log_seq is recovered from the durable log end", async () => {
  await withTempDirectory(async (root) => {
    const { projectRoot, paths, store } = await prepareRecoveryProject(root, [
      "context/loaded",
      "memory/write",
      "autonomy/profile",
    ]);
    const meta = JSON.parse(await readFile(store.paths.metaPath, "utf8"));
    meta.log_seq -= 1;
    await writeFile(store.paths.metaPath, `${JSON.stringify(meta)}\n`, "utf8");
    const before = await readPersistedFiles(store);

    const runtime = await createRuntimeForSession(
      projectRoot,
      paths,
      store.sessionId,
    );
    await runtime.dispose();

    const reopened = await reopenStore(
      paths.home,
      core.projectIdFor(projectRoot),
      projectRoot,
      store.sessionId,
    );
    assert.equal(reopened.metadata.state_covers_seq, reopened.metadata.log_seq);
    assert.ok((await readPersistedFiles(reopened)).log.startsWith(before.log));
  });
});

test("metadata ahead of the log is refused by preflight and runtime", async () => {
  await withTempDirectory(async (root) => {
    const { projectRoot, paths, store } = await prepareRecoveryProject(
      root,
      [],
    );
    const meta = JSON.parse(await readFile(store.paths.metaPath, "utf8"));
    meta.log_seq += 1;
    await writeFile(store.paths.metaPath, `${JSON.stringify(meta)}\n`, "utf8");
    const before = await readPersistedFiles(store);
    const { sessionResumeIssue } = await importSource(
      "packages/cli/src/tui.ts",
    );
    const issue = await sessionResumeIssue(
      {
        paths: {
          home: paths.home,
          cwd: projectRoot,
          deliveryRoot: projectRoot,
          projectId: core.projectIdFor(projectRoot),
        },
      },
      store.sessionId,
    );
    assert.match(issue ?? "", /metadata is ahead of its event log/u);

    await assert.rejects(
      () => createRuntimeForSession(projectRoot, paths, store.sessionId),
      /session meta log_seq is ahead of the session log/u,
    );
    assert.deepEqual(await readPersistedFiles(store), before);
  });
});

test("a non-contiguous session log is refused by preflight and runtime", async () => {
  await withTempDirectory(async (root) => {
    const { projectRoot, paths, store } = await prepareRecoveryProject(root, [
      "context/loaded",
      "memory/write",
      "autonomy/profile",
    ]);
    const lines = (await readFile(store.paths.logPath, "utf8"))
      .trimEnd()
      .split("\n");
    const third = JSON.parse(lines[3]);
    third.seq = 4;
    lines[3] = JSON.stringify(third);
    await writeFile(store.paths.logPath, `${lines.join("\n")}\n`, "utf8");

    const { sessionResumeIssue } = await importSource(
      "packages/cli/src/tui.ts",
    );
    const issue = await sessionResumeIssue(
      {
        paths: {
          home: paths.home,
          cwd: projectRoot,
          deliveryRoot: projectRoot,
          projectId: core.projectIdFor(projectRoot),
        },
      },
      store.sessionId,
    );
    assert.match(issue ?? "", /event log seqs are not contiguous/u);
    await assert.rejects(
      () => createRuntimeForSession(projectRoot, paths, store.sessionId),
      /session event seq \d+ is not contiguous/u,
    );
  });
});
