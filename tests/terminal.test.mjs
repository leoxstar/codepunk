import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";

const core = await importCore();
const TESTS_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(TESTS_DIR, "..");
const PTY_RUNNER =
  process.platform === "win32"
    ? [process.execPath, path.join(TESTS_DIR, "support", "pty-run.mjs")]
    : ["python3", path.join(TESTS_DIR, "support", "pty-run.py")];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForExit(exited, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value !== null && value !== undefined && value !== false) {
      return value;
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForOutput(output, mark, marker, label) {
  return waitFor(
    () => (output.join("").slice(mark).includes(marker) ? true : null),
    label,
  );
}

async function readEvidence(evidencePath) {
  try {
    return (await core.readEvidenceFile(evidencePath)).records;
  } catch (error) {
    if (error instanceof Error && /cannot be read/u.test(error.message)) {
      return [];
    }
    throw error;
  }
}

async function readSessionEvents(sessionPath) {
  const lines = (await fs.readFile(sessionPath, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
  return lines.slice(1).map((line) => JSON.parse(line));
}

test(
  "real pty gates !, records /compact, and exits without a Pi banner",
  {
    skip:
      process.platform === "win32"
        ? "the srt sandbox is not provisioned on this Windows host"
        : false,
  },
  async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "codepunk-pty-")),
    );
    const evidencePath = path.join(root, "evidence.jsonl");
    const detectorPath = path.join(root, "detector.json");
    const readyPath = path.join(root, "ready.json");
    const sessionPathFile = path.join(root, "session-path.txt");
    const spawnMarker = path.join(root, "project", "rm-spawned");
    const output = [];
    const child = spawn(
      PTY_RUNNER[0],
      [
        ...PTY_RUNNER.slice(1),
        process.execPath,
        path.join(TESTS_DIR, "support", "pty-host.mjs"),
        root,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
    const exited = new Promise((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    });

    try {
      const ready = await waitFor(async () => {
        try {
          return JSON.parse(await fs.readFile(readyPath, "utf8"));
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return null;
          }
          throw error;
        }
      }, "pty host readiness");
      assert.equal(ready.tty, true);
      assert.equal(await fs.readFile(detectorPath, "utf8"), "ok\n");
      await delay(300);

      const allowedMark = output.join("").length;
      child.stdin.write("!printf 'code''punk-allowed'\r");
      await waitForOutput(
        output,
        allowedMark,
        "codepunk-allowed",
        "allowed user_bash rendering",
      );
      await delay(500);
      const allowed = await waitFor(
        async () =>
          (await readEvidence(evidencePath)).find(
            (record) =>
              record.source === "user_bash" &&
              record.command === "printf 'code''punk-allowed'" &&
              record.decision === "allow",
          ) ?? null,
        "allowed user_bash evidence",
      );
      assert.equal(allowed.exit_code, 0);
      assert.equal(allowed.executor, "srt");
      assert.equal(allowed.sandbox.backend, "srt");
      assert.equal(allowed.output_preview.trim(), "codepunk-allowed");

      const deniedMark = output.join("").length;
      child.stdin.write("!rm -rf /\r");
      await waitForOutput(
        output,
        deniedMark,
        "denied: shell.dangerous",
        "denied user_bash rendering",
      );
      await delay(500);
      const denied = await waitFor(
        async () =>
          (await readEvidence(evidencePath)).find(
            (record) =>
              record.source === "user_bash" &&
              record.command === "rm -rf /" &&
              record.decision === "deny",
          ) ?? null,
        "denied user_bash evidence",
      );
      assert.equal(denied.rule, "shell.dangerous");
      assert.equal(denied.executor, null);
      assert.equal(denied.exit_code, null);
      assert.equal(
        await fs.readFile(spawnMarker, "utf8").catch(() => null),
        null,
      );

      child.stdin.write("/compact\r");
      const sessionPath = (await fs.readFile(sessionPathFile, "utf8")).trim();
      const compactDecision = await waitFor(
        async () =>
          (await readSessionEvents(sessionPath)).find(
            (event) =>
              event.kind === "compaction/decision" &&
              event.data.reason === "manual",
          ) ?? null,
        "manual compaction decision",
      );
      assert.equal(compactDecision.data.cancelled, false);
      assert.equal(compactDecision.data.entries, 1);
      assert.ok(compactDecision.data.checkpoint);
      assert.ok(compactDecision.data.checkpoint.first_kept_entry_id);
      assert.ok(compactDecision.data.checkpoint.messages_before > 0);
      assert.ok(compactDecision.data.checkpoint.messages_after > 0);

      child.stdin.write("/quit\r");
      const result = await waitForExit(exited, 15_000);
      assert.ok(result);
      assert.equal(result.code, 0);
      const transcript = output.join("");
      assert.ok(transcript.trim().length > 0);
      assert.doesNotMatch(transcript, /pi --session/u);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
