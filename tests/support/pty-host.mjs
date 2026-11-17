import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createAgentSessionRuntime,
  InteractiveMode,
} from "@earendil-works/pi-coding-agent";
import { importCore } from "./core.mjs";
import { installScriptedStream, TEST_MODEL } from "./pi-model.mjs";

const core = await importCore();
const root = process.argv[2];
if (root === undefined) {
  throw new Error("pty host root is required");
}

const project = path.join(root, "project");
const home = path.join(root, "home");
const evidencePath = path.join(root, "evidence.jsonl");
const sessionPathFile = path.join(root, "session-path.txt");
const readyPath = path.join(root, "ready.json");
const detectorPath = path.join(root, "detector.json");
const fakeBin = path.join(project, ".test-bin");
const spawnMarker = path.join(project, "rm-spawned");

await fs.mkdir(project, { recursive: true });
await fs.mkdir(home, { recursive: true });
await fs.mkdir(fakeBin, { recursive: true });
if (process.platform === "win32") {
  await fs.writeFile(
    path.join(fakeBin, "rm.cmd"),
    `@echo off\r\ntype nul > "${spawnMarker}"\r\nexit /b 0\r\n`,
  );
} else {
  await fs.writeFile(
    path.join(fakeBin, "rm"),
    `#!/bin/sh\ntouch ${JSON.stringify(spawnMarker)}\nexit 0\n`,
    { mode: 0o755 },
  );
}
const pathKey =
  Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
  "PATH";
process.env[pathKey] =
  `${fakeBin}${path.delimiter}${process.env[pathKey] ?? ""}`;
process.env["PI_OFFLINE"] = "1";

const ledger = await core.EvidenceLedger.open(evidencePath);
const store = await core.SessionStore.create({
  rootDir: home,
  cwd: project,
  sessionId: "session-pty-h1",
  heartbeatMs: 60_000,
});
const sandbox = await core.SrtSandbox.create({
  cwd: project,
  workspaceRoot: project,
  deliveryRoot: project,
  codepunkHome: home,
  writeSet: [project],
});
let host;
try {
  const detector = await sandbox.execCommand("rm -rf detector-probe", project);
  if (detector.exitCode !== 0) {
    throw new Error(`fake rm detector failed: ${detector.output}`);
  }
  await fs.access(spawnMarker);
  await fs.rm(spawnMarker);
  await fs.writeFile(detectorPath, "ok\n");
  host = await core.createPiHost({
    cwd: project,
    workspaceRoot: project,
    deliveryRoot: project,
    codepunkHome: home,
    sessionId: store.sessionId,
    runId: "run-pty-h1",
    writeSet: [project],
    mode: "interactive",
    approval: null,
    ledger,
    sandbox,
    sessionStore: store,
    model: TEST_MODEL,
    settings: {
      compaction: {
        enabled: true,
        reserveTokens: 1,
        keepRecentTokens: 1,
      },
    },
  });
  await host.services.modelRuntime.setRuntimeApiKey("openai", "test-key");
  installScriptedStream(host.session, () => ({
    type: "text",
    text: "manual compact summary",
  }));
  const now = Date.now();
  for (let index = 0; index < 3; index += 1) {
    host.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: `prime question ${index}` }],
      timestamp: now + index * 2,
    });
    host.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `prime answer ${index}` }],
      api: TEST_MODEL.api,
      provider: TEST_MODEL.provider,
      model: TEST_MODEL.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: now + index * 2 + 1,
    });
  }
  await fs.writeFile(sessionPathFile, `${store.paths.logPath}\n`);
  const runtime = await createAgentSessionRuntime(
    async () => ({
      session: host.session,
      services: host.services,
      diagnostics: host.services.diagnostics,
    }),
    {
      cwd: project,
      agentDir: home,
      sessionManager: host.sessionManager,
    },
  );
  const interactive = new InteractiveMode(runtime, {
    verbose: false,
    startupDiagnostics: [],
  });
  await interactive.init();
  await fs.writeFile(
    `${readyPath}.tmp`,
    `${JSON.stringify({
      pid: process.pid,
      tty: process.stdin.isTTY === true,
    })}\n`,
  );
  await fs.rename(`${readyPath}.tmp`, readyPath);
  await interactive.run();
} finally {
  await host?.dispose();
}
