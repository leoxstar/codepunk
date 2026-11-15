import { promises as fs } from "node:fs";
import path from "node:path";
import { importCore } from "./core.mjs";
import { installScriptedStream, TEST_MODEL } from "./pi-model.mjs";

const core = await importCore();
const [root, phase, marker] = process.argv.slice(2);
if (root === undefined || phase === undefined || marker === undefined) {
  throw new Error("restart child requires root, phase, and marker");
}

const project = path.join(root, "project");
const home = path.join(root, "home");
const evidencePath = path.join(root, "evidence.jsonl");
const sessionId = "session-restart-child";

await fs.mkdir(project, { recursive: true });
await fs.mkdir(home, { recursive: true });

function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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
    timestamp: Date.now(),
  };
}

function createHost(store, ledger, overrides = {}) {
  return core.createPiHost({
    cwd: project,
    workspaceRoot: project,
    deliveryRoot: project,
    codepunkHome: home,
    sessionId,
    runId: "run-restart-child",
    writeSet: [project],
    mode: "interactive",
    approval: null,
    ledger,
    sandbox: null,
    sessionStore: store,
    model: TEST_MODEL,
    ...overrides,
  });
}

async function savePhase(store, ledger) {
  const host = await createHost(store, ledger);
  try {
    host.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: marker }],
      timestamp: Date.now(),
    });
    host.sessionManager.appendMessage(assistantMessage("stored"));
    const state = await host.saveAgentState();
    if (state === null) {
      throw new Error("saveAgentState returned null");
    }
    return {
      phase,
      sessionId: store.sessionId,
      saved: true,
      persisted: host.sessionManager.isPersisted(),
      sessionFile: host.session.sessionFile ?? null,
      piSessionFiles: (
        await fs.readdir(path.join(home, "sessions")).catch(() => [])
      ).filter((entry) => entry.endsWith(".jsonl")),
    };
  } finally {
    await host.dispose();
  }
}

async function resumePhase(store, ledger) {
  const resumed = await store.resume();
  if (resumed.uncommittedEvents.length !== 0) {
    throw new Error("restart resumed with uncommitted events");
  }
  const host = await createHost(store, ledger, { restore: resumed.state });
  try {
    await host.services.modelRuntime.setRuntimeApiKey("openai", "test-key");
    let contextRestored = false;
    installScriptedStream(host.session, (_index, context) => {
      contextRestored = JSON.stringify(context.messages).includes(marker);
      return {
        type: "text",
        text: contextRestored
          ? "stored value is 47"
          : "stored value is missing",
      };
    });
    await host.session.prompt("What was the stored value?");
    const answer = host.session.messages
      .filter((message) => message.role === "assistant")
      .at(-1);
    if (answer === undefined) {
      throw new Error("restart did not produce an assistant answer");
    }
    return {
      phase,
      sessionId: store.sessionId,
      contextRestored,
      answer: answer.content.map((part) => part.text ?? "").join("\n"),
      persisted: host.sessionManager.isPersisted(),
      sessionFile: host.session.sessionFile ?? null,
      piSessionFiles: (
        await fs.readdir(path.join(home, "sessions")).catch(() => [])
      ).filter((entry) => entry.endsWith(".jsonl")),
    };
  } finally {
    await host.dispose();
  }
}

async function overflowPhase(store, ledger) {
  const host = await createHost(store, ledger, {
    settings: {
      compaction: {
        enabled: true,
        reserveTokens: 1,
        keepRecentTokens: 1,
      },
    },
  });
  try {
    await host.services.modelRuntime.setRuntimeApiKey("openai", "test-key");
    const calls = installScriptedStream(host.session, (index) => {
      if (index === 0) {
        return { type: "error" };
      }
      if (index === 1) {
        return { type: "text", text: "compacted summary" };
      }
      return { type: "text", text: "recovered after compaction" };
    });
    const events = [];
    host.session.subscribe((event) => {
      if (event.type.startsWith("compaction_")) {
        events.push(event.type);
      }
    });
    await host.session.prompt("force an overflow");
    const decision = store.allEvents.find(
      (event) => event.kind === "compaction/decision",
    );
    const finalAssistant = host.session.messages
      .filter((message) => message.role === "assistant")
      .at(-1);
    return {
      phase,
      calls: calls.length,
      events,
      decision:
        decision === undefined
          ? null
          : {
              reason: decision.data.reason,
              cancelled: decision.data.cancelled,
              entries: decision.data.entries,
            },
      finalAnswer:
        finalAssistant?.content.map((part) => part.text ?? "").join("\n") ??
        null,
      persisted: host.sessionManager.isPersisted(),
      sessionFile: host.session.sessionFile ?? null,
    };
  } finally {
    await host.dispose();
  }
}

let store;
if (phase === "save") {
  store = await core.SessionStore.create({
    rootDir: home,
    cwd: project,
    sessionId,
    heartbeatMs: 60_000,
  });
} else if (phase === "resume") {
  store = await core.SessionStore.open({
    rootDir: home,
    cwd: project,
    sessionId,
  });
} else if (phase === "overflow") {
  store = await core.SessionStore.create({
    rootDir: home,
    cwd: project,
    sessionId,
    heartbeatMs: 60_000,
  });
} else {
  throw new Error(`unknown restart phase: ${phase}`);
}

const ledger = await core.EvidenceLedger.open(evidencePath);
const result =
  phase === "save"
    ? await savePhase(store, ledger)
    : phase === "resume"
      ? await resumePhase(store, ledger)
      : await overflowPhase(store, ledger);

process.stdout.write(`${JSON.stringify(result)}\n`);
