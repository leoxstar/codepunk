#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const corpusRoot = path.resolve(
  import.meta.dirname,
  "../tests/fixtures/compat/0.1.0",
);
const publishedCoreRoot = process.env["CODEPUNK_COMPAT_CORE_ROOT"];
if (publishedCoreRoot === undefined || publishedCoreRoot.length === 0) {
  process.stderr.write(
    "collect-compat-0.1.0: set CODEPUNK_COMPAT_CORE_ROOT to the extracted codepunk-core@0.1.0 package root\n",
  );
  process.exit(1);
}
const publishedCorePackage = JSON.parse(
  await fs.readFile(path.join(publishedCoreRoot, "package.json"), "utf8"),
);
if (
  publishedCorePackage.name !== "codepunk-core" ||
  publishedCorePackage.version !== "0.1.0"
) {
  process.stderr.write(
    "collect-compat-0.1.0: CODEPUNK_COMPAT_CORE_ROOT is not the published codepunk-core@0.1.0 package\n",
  );
  process.exit(1);
}
const fixedDate = "2026-11-24T00:00:00.000Z";
const fixedNotificationId = "01M85DMB000000000000000000";
const projectId = "8be5f63f7fee6b9c";

function die(message) {
  process.stderr.write(`collect-compat-0.1.0: ${message}\n`);
  process.exit(1);
}

async function writeCollected(relativePath, content) {
  const target = path.join(corpusRoot, relativePath);
  try {
    await fs.access(target);
    die(`refusing to overwrite existing corpus file: ${relativePath}`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      die(`cannot check ${relativePath}: ${error.message}`);
    }
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

async function collectOnce() {
  const outputRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codepunk-c5-core-capture-"),
  );
  const workerPath = path.join(outputRoot, "worker.mjs");
  await fs.writeFile(
    workerPath,
    [
      `import { promises as fs } from "node:fs";`,
      `import path from "node:path";`,
      `const core = await import(${JSON.stringify(`${publishedCoreRoot}/dist/index.js`)});`,
      `const outputRoot = process.argv[2];`,
      `const fixedDate = new Date(${JSON.stringify(fixedDate)});`,
      `const fixedClock = () => fixedDate;`,
      `const paths = { home: "{{HOME}}", projectDir: path.join(outputRoot, "{{PROJECT}}") };`,
      `const claims = new core.ClaimStore({ paths, leaseMs: 60_000, now: fixedClock });`,
      `const claim = await claims.acquire("compat-claim", "compat-worker");`,
      `const bridge = new core.MessageBridge({ paths, now: fixedClock, maxQueue: 128 });`,
      `const status = await bridge.notify({ kind: "worker", title: "compat worker completed", body: "compat notification captured", task_id: "compat-claim" });`,
      `if (status !== "queued") throw new Error("unexpected notify status: " + status);`,
      `if ((await bridge.queueSize()) !== 1) throw new Error("unexpected queue size");`,
      `await fs.writeFile(path.join(outputRoot, "claim.json"), JSON.stringify(claim));`,
      `await fs.writeFile(path.join(outputRoot, "result.json"), JSON.stringify({ status, queueSize: await bridge.queueSize(), claimsPath: claims.filePath, queuePath: bridge.queuePath }));`,
    ].join("\n"),
  );
  const child = spawn(process.execPath, [workerPath, outputRoot], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) {
    die(`published-core capture worker failed with exit ${code}: ${stderr}`);
  }
  const result = JSON.parse(
    await fs.readFile(path.join(outputRoot, "result.json"), "utf8"),
  );
  const claims = await fs.readFile(result.claimsPath, "utf8");
  const notificationsRaw = await fs.readFile(result.queuePath, "utf8");
  const lines = notificationsRaw.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 1) {
    die("unexpected notification queue shape");
  }
  const notification = JSON.parse(lines[0]);
  if (
    notification.id === fixedNotificationId ||
    notification.version !== 1 ||
    notification.kind !== "worker" ||
    notification.title !== "compat worker completed" ||
    notification.body !== "compat notification captured" ||
    notification.task_id !== "compat-claim" ||
    notification.created_at !== fixedDate
  ) {
    die("notification normalization did not match the published shape");
  }
  notification.id = fixedNotificationId;
  const notifications = `${JSON.stringify(notification)}\n`;
  await fs.rm(outputRoot, { recursive: true, force: true });
  return { claims, notifications };
}

async function main() {
  const first = await collectOnce();
  const replay = await collectOnce();
  if (
    replay.claims !== first.claims ||
    replay.notifications !== first.notifications
  ) {
    die("published-core capture replay bytes differ");
  }
  await writeCollected(`home/projects/${projectId}/claims.json`, first.claims);
  await writeCollected(
    `home/projects/${projectId}/notifications.jsonl`,
    first.notifications,
  );
}

await main();
