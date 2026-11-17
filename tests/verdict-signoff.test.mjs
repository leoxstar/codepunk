import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import { readRecord } from "./support/fixtures.mjs";
import {
  ensureBuilt,
  REPO_ROOT,
  withTempDirectory,
} from "./support/helpers.mjs";

const core = await importCore();
const execFileAsync = promisify(execFile);
const PTY_RUNNER =
  process.platform === "win32"
    ? [
        process.execPath,
        path.join(REPO_ROOT, "tests", "support", "pty-run.mjs"),
      ]
    : ["python3", path.join(REPO_ROOT, "tests", "support", "pty-run.py")];

function stripTerminalControls(value) {
  return value
    .replaceAll(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "")
    .replaceAll(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "")
    .replaceAll(/\x1b[@-_]/gu, "");
}

test("the product sign path writes a sign-off event and artifact", async () => {
  await withTempDirectory("codepunk-verdict-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(path.join(project, "a.txt"), "x\n");
    const context = await core.findDeliveryRoot(project);
    const paths = core.projectPaths(context, path.join(root, "home"));
    await core.ensureProjectRegistration(context, paths);
    await core.ensureProjectConfigDir(paths);
    await fs.writeFile(
      path.join(paths.projectConfigDir, "config.toml"),
      '[model]\nprovider = "project-only"\nid = "project-only"\n',
    );
    const session = await core.SessionStore.create({
      rootDir: paths.home,
      cwd: paths.cwd,
      projectRoot: paths.deliveryRoot,
      projectId: paths.projectId,
    });
    const runId = "01J0XRUN0000000000000000";
    const ledger = await core.EvidenceLedger.open(
      core.evidenceRunPath(paths, session.sessionId, runId),
    );
    const record = await ledger.append({
      ...readRecord({
        run_id: runId,
        session_id: session.sessionId,
      }),
    });
    const writer = await session.acquireWriter();
    await session.append("run/end", {
      run_id: runId,
      state: "settled",
      termination: null,
      evidence_head: core.evidenceRecordHash(record),
      actor: "local-user",
    });
    await writer.release();
    const result = await core.signStandalone({
      cwd: project,
      environment: { CODEPUNK_HOME: paths.home },
      runId,
      verdict: "complete",
      tty: true,
    });
    assert.equal(result.verdict.verdict, "complete");
    const artifact = JSON.parse(await fs.readFile(result.artifactPath, "utf8"));
    assert.equal(artifact.run_id, runId);
    assert.equal(artifact.signed_verdict, "complete");
    const reopened = await core.SessionStore.open({
      rootDir: paths.home,
      cwd: paths.cwd,
      projectRoot: paths.deliveryRoot,
      projectId: paths.projectId,
      sessionId: session.sessionId,
    });
    assert.equal(
      reopened.allEvents.filter((event) => event.kind === "verdict/sign_off")
        .length,
      1,
    );
    await assert.rejects(
      () =>
        core.signStandalone({
          cwd: project,
          environment: { CODEPUNK_HOME: paths.home },
          runId,
          verdict: "incomplete",
          tty: true,
        }),
      /previous_sign_off_mismatch|previous sign-off/u,
    );
  });
});

test("the CLI sign command prints the verdict value under a TTY", async () => {
  await withTempDirectory("codepunk-verdict-cli-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(path.join(project, "a.txt"), "x\n");
    const context = await core.findDeliveryRoot(project);
    const paths = core.projectPaths(context, path.join(root, "home"));
    await core.ensureProjectRegistration(context, paths);
    await core.ensureProjectConfigDir(paths);
    const session = await core.SessionStore.create({
      rootDir: paths.home,
      cwd: paths.cwd,
      projectRoot: paths.deliveryRoot,
      projectId: paths.projectId,
    });
    const runId = "01J0XCLISIGN0000000000000";
    const ledger = await core.EvidenceLedger.open(
      core.evidenceRunPath(paths, session.sessionId, runId),
    );
    const record = await ledger.append(
      readRecord({
        run_id: runId,
        session_id: session.sessionId,
      }),
    );
    const writer = await session.acquireWriter();
    await session.append("run/end", {
      run_id: runId,
      state: "settled",
      termination: null,
      evidence_head: core.evidenceRecordHash(record),
      actor: "local-user",
    });
    await writer.release();

    const cli = await ensureBuilt();
    const child = spawn(
      PTY_RUNNER[0],
      [
        ...PTY_RUNNER.slice(1),
        process.execPath,
        cli,
        "sign",
        runId,
        "--verdict",
        "complete",
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          CODEPUNK_HOME: paths.home,
          NO_COLOR: "1",
          PTY_RUN_COLS: "240",
          PTY_RUN_TIMEOUT: "10",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    const result = await Promise.race([
      new Promise((resolve) =>
        child.on("close", (code, signal) => resolve({ code, signal })),
      ),
      new Promise((resolve) =>
        setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
      ),
    ]);
    assert.deepEqual(result, { code: 0, signal: null });
    const cleaned = stripTerminalControls(output);
    assert.match(cleaned, /^complete .+\.json$/mu);
    assert.doesNotMatch(cleaned, /\[object Object\]/u);
  });
});

test("an ambiguous run id is refused before writing", async () => {
  await withTempDirectory("codepunk-verdict-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const context = await core.findDeliveryRoot(project);
    const paths = core.projectPaths(context, path.join(root, "home"));
    await core.ensureProjectRegistration(context, paths);
    await core.ensureProjectConfigDir(paths);
    const runId = "01J0XAMBIGUOUS0000000000";
    for (const sessionId of ["session-a", "session-b"]) {
      const directory = path.join(paths.evidenceDir, sessionId);
      await fs.mkdir(directory, { recursive: true });
      const ledger = await core.EvidenceLedger.open(
        path.join(directory, `${runId}.jsonl`),
      );
      await ledger.append(readRecord({ run_id: runId, session_id: sessionId }));
    }
    await assert.rejects(
      () =>
        core.signStandalone({
          cwd: project,
          environment: { CODEPUNK_HOME: paths.home },
          runId,
          verdict: "complete",
          tty: true,
        }),
      /more than one session/u,
    );
    assert.equal((await core.findRunOwner(paths, runId)).length, 2);
  });
});

test("a live writer blocks sign-off until it is released", async () => {
  await withTempDirectory("codepunk-verdict-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const context = await core.findDeliveryRoot(project);
    const paths = core.projectPaths(context, path.join(root, "home"));
    await core.ensureProjectRegistration(context, paths);
    await core.ensureProjectConfigDir(paths);
    const session = await core.SessionStore.create({
      rootDir: paths.home,
      cwd: paths.cwd,
      projectRoot: paths.deliveryRoot,
      projectId: paths.projectId,
      heartbeatMs: 60_000,
    });
    const runId = "01J0XLIVEWRITER000000000";
    const ledger = await core.EvidenceLedger.open(
      core.evidenceRunPath(paths, session.sessionId, runId),
    );
    const record = await ledger.append(
      readRecord({
        run_id: runId,
        session_id: session.sessionId,
      }),
    );
    const writer = await session.acquireWriter();
    await session.append("run/end", {
      run_id: runId,
      state: "settled",
      termination: null,
      evidence_head: core.evidenceRecordHash(record),
      actor: "local-user",
    });
    try {
      await assert.rejects(
        () =>
          core.signStandalone({
            cwd: project,
            environment: { CODEPUNK_HOME: paths.home },
            runId,
            verdict: "complete",
            tty: true,
          }),
        /live writer|lease is still active/u,
      );
    } finally {
      await writer.release();
    }
    const signed = await core.signStandalone({
      cwd: project,
      environment: { CODEPUNK_HOME: paths.home },
      runId,
      verdict: "complete",
      tty: true,
    });
    assert.equal(signed.verdict.verdict, "complete");
  });
});
