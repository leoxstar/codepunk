import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  getPackageDir,
  loadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";
import { importCore } from "./support/core.mjs";
import { installScriptedStream, TEST_MODEL } from "./support/pi-model.mjs";

const core = await importCore();

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function workspace() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "codepunk-context-")),
  );
  const home = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "codepunk-home-")),
  );
  const repo = path.join(root, "repo");
  const nested = path.join(repo, "src", "nested");
  await fs.mkdir(nested, { recursive: true });
  const initialized = spawnSync("git", ["init", "-q", repo], {
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  return { root, home, repo, nested };
}

test("Pi context discovery loads user, repo, and nested instructions", async () => {
  const setup = await workspace();
  const projectText = "# Project\n\nUse the project rules.\n";
  const userText = "# User\n\nPrefer small changes.\n";
  const appendText = "# Appendix\n\nLocal context.\n";
  await fs.writeFile(path.join(setup.repo, "AGENTS.md"), projectText);
  await fs.writeFile(
    path.join(setup.nested, "AGENTS.md"),
    "Nested instructions load too.\n",
  );
  await fs.writeFile(path.join(setup.home, "AGENTS.md"), userText);
  const appendPath = path.join(setup.repo, "local-context.md");
  await fs.writeFile(appendPath, appendText);

  const bundle = await core.loadContext({
    cwd: setup.nested,
    deliveryRoot: setup.repo,
    codepunkHome: setup.home,
    appendFiles: [{ path: appendPath, label: "local.md" }],
  });

  assert.deepEqual(
    bundle.sources.map((source) => source.kind),
    [
      "user-instructions",
      "project-instructions",
      "project-instructions",
      "append",
    ],
  );
  assert.equal(bundle.sources[0].sha256, sha256(Buffer.from(userText, "utf8")));
  assert.equal(
    bundle.sources[1].sha256,
    sha256(Buffer.from(projectText, "utf8")),
  );
  assert.match(bundle.instructionBlock, /Use the project rules/u);
  assert.match(bundle.instructionBlock, /Prefer small changes/u);
  assert.match(bundle.instructionBlock, /Local context/u);
  assert.match(bundle.instructionBlock, /Nested instructions load too/u);
  assert.equal(bundle.truncated, false);
});

test("instruction discovery uses Pi precedence and stops at the delivery root", async () => {
  const setup = await workspace();
  await fs.writeFile(
    path.join(setup.root, "AGENTS.md"),
    "PARENT SENTINEL MUST NOT LOAD\n",
  );
  await fs.writeFile(
    path.join(setup.repo, "AGENTS.override.md"),
    "REPO OVERRIDE SENTINEL\n",
  );
  await fs.writeFile(
    path.join(setup.repo, "AGENTS.md"),
    "REPO BASE SENTINEL MUST NOT WIN\n",
  );
  await fs.writeFile(
    path.join(setup.nested, "CLAUDE.MD"),
    "NESTED CLAUDE SENTINEL\n",
  );

  const bundle = await core.loadContext({
    cwd: setup.nested,
    deliveryRoot: setup.repo,
    codepunkHome: setup.home,
  });
  assert.match(bundle.instructionBlock, /REPO OVERRIDE SENTINEL/u);
  assert.doesNotMatch(bundle.instructionBlock, /REPO BASE SENTINEL/u);
  assert.match(bundle.instructionBlock, /NESTED CLAUDE SENTINEL/u);
  assert.doesNotMatch(bundle.instructionBlock, /PARENT SENTINEL/u);
  assert.deepEqual(
    await core.findTrustRequiringProjectResources(setup.repo, setup.nested),
    ["AGENTS.override.md", "src/nested/CLAUDE.md"],
  );
  const piDiscovered = loadProjectContextFiles({
    cwd: setup.nested,
    agentDir: setup.home,
  });
  assert.deepEqual(
    piDiscovered
      .filter((file) => file.path.startsWith(`${setup.repo}${path.sep}`))
      .map((file) =>
        path.relative(setup.repo, file.path).split(path.sep).join("/"),
      ),
    ["AGENTS.override.md", "src/nested/CLAUDE.md"],
  );
});

test("the instruction filename contract matches the pinned Pi candidate list", async () => {
  const setup = await workspace();
  const loaderSource = await fs.readFile(
    path.join(getPackageDir(), "dist/core/resource-loader.js"),
    "utf8",
  );
  const candidateMatch = loaderSource.match(
    /const candidates = (\[[^\]]*\]);/u,
  );
  assert.ok(candidateMatch, "Pi loader must expose its candidate list");
  const piCandidates = JSON.parse(candidateMatch[1]);
  assert.ok(Array.isArray(piCandidates));
  for (const [index, name] of piCandidates.entries()) {
    const directory = path.join(setup.repo, `candidate-${index}`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, name), `candidate ${name}\n`);
    const resources = await core.findTrustRequiringProjectResources(
      setup.repo,
      directory,
    );
    assert.equal(
      resources.length,
      1,
      `Codepunk must recognize Pi candidate ${name}`,
    );
    assert.equal(
      path.dirname(resources[0]),
      `candidate-${index}`,
      `Codepunk must recognize Pi candidate ${name}`,
    );
    assert.equal(
      path.basename(resources[0]).toLowerCase(),
      name.toLowerCase(),
      `Codepunk must recognize Pi candidate ${name}`,
    );
    const discovered = loadProjectContextFiles({
      cwd: directory,
      agentDir: setup.home,
    }).filter((file) => file.path.startsWith(`${directory}${path.sep}`));
    assert.equal(discovered.length, 1, `Pi must still load ${name}`);
  }
});

test("runtime facts use the Pi system-prompt section without a weekday adapter", () => {
  const environment = core.renderRuntimeEnvironment(
    new Date("2026-11-14T01:30:00.000Z"),
    "Asia/Shanghai",
  );
  assert.match(
    environment,
    /Current host time is 2026-11-14T09:30:00\+08:00 \(Asia\/Shanghai\)/u,
  );
  assert.doesNotMatch(environment, /Saturday|weekday/iu);

  const fallback = core.renderRuntimeEnvironment(
    new Date("2026-11-14T01:30:00.000Z"),
    "Not/AZone",
  );
  assert.match(fallback, /T01:30:00\+00:00 \(UTC\)/u);
});

test("the host applies runtime facts through before_agent_start sections", async () => {
  const setup = await workspace();
  const requestSystemPrompts = [];
  const ledger = await core.EvidenceLedger.open(
    path.join(setup.root, "evidence.jsonl"),
  );
  const host = await core.createPiHost({
    cwd: setup.repo,
    workspaceRoot: setup.repo,
    deliveryRoot: setup.repo,
    codepunkHome: setup.home,
    sessionId: "session-runtime-facts",
    runId: "run-runtime-facts",
    writeSet: [setup.repo],
    mode: "print",
    approval: null,
    ledger,
    sandbox: null,
    model: TEST_MODEL,
    bindMode: "print",
    runtimeFacts: {
      now: () => {
        const tick = requestSystemPrompts.length;
        return new Date(Date.parse("2026-11-14T01:30:00.000Z") + tick * 1_000);
      },
      timeZone: "Asia/Shanghai",
    },
  });
  try {
    await host.services.modelRuntime.setRuntimeApiKey("openai", "test-key");
    installScriptedStream(host.session, () => {
      requestSystemPrompts.push(host.session.systemPrompt);
      return { type: "text", text: "ok" };
    });
    await host.session.prompt("what time is it?");
    await host.session.prompt("and now?");
    const requestSystemPrompt = requestSystemPrompts[0];
    assert.match(
      requestSystemPrompt,
      /<environment>[\s\S]*2026-11-14T09:30:00\+08:00[\s\S]*<\/environment>/u,
    );
    assert.match(
      requestSystemPrompts[1],
      /<environment>[\s\S]*2026-11-14T09:30:01\+08:00[\s\S]*<\/environment>/u,
      "runtime time must be recomputed for a later turn",
    );
    assert.doesNotMatch(requestSystemPrompt, /Saturday|weekday/iu);
    assert.match(
      requestSystemPrompt,
      /<product>\nYou are Codepunk, a local-first coding agent\./u,
    );
    assert.match(
      requestSystemPrompt,
      /Do not try to reach the same effect through another tool, path,\n  or indirection\./u,
    );
    assert.equal(
      requestSystemPrompt.match(/<product>/gu)?.length,
      1,
      "the product section must appear exactly once",
    );
  } finally {
    await host.dispose();
    await fs.rm(setup.root, { recursive: true, force: true });
    await fs.rm(setup.home, { recursive: true, force: true });
  }
});

test("createPiHost without an explicit context does not trust project instructions", async () => {
  const setup = await workspace();
  const sentinel = "UNTRUSTED PROJECT INSTRUCTION MUST NOT LOAD";
  await fs.writeFile(path.join(setup.repo, "AGENTS.md"), sentinel);
  const ledger = await core.EvidenceLedger.open(
    path.join(setup.root, "evidence.jsonl"),
  );
  const store = await core.SessionStore.create({
    rootDir: setup.home,
    cwd: setup.repo,
    sessionId: "session-untrusted-context",
    heartbeatMs: 60_000,
  });
  const host = await core.createPiHost({
    cwd: setup.repo,
    workspaceRoot: setup.repo,
    deliveryRoot: setup.repo,
    codepunkHome: setup.home,
    sessionId: store.sessionId,
    runId: "run-untrusted-context",
    writeSet: [setup.repo],
    mode: "print",
    approval: null,
    ledger,
    sandbox: null,
    sessionStore: store,
    bindMode: "print",
  });
  try {
    const loaded = store.allEvents.find(
      (event) => event.kind === "context/loaded",
    );
    assert.ok(loaded);
    assert.match(
      JSON.stringify(loaded.data),
      /context\.untrusted_project_instruction/u,
    );
    assert.doesNotMatch(host.session.systemPrompt, new RegExp(sentinel, "u"));
  } finally {
    await host.dispose();
    await fs.rm(setup.root, { recursive: true, force: true });
    await fs.rm(setup.home, { recursive: true, force: true });
  }
});

test("symlinks and outside append files are ignored with warnings", async () => {
  const setup = await workspace();
  const outside = path.join(setup.root, "outside.md");
  await fs.writeFile(outside, "outside");
  await fs.symlink(outside, path.join(setup.repo, "AGENTS.md"));

  const bundle = await core.loadContext({
    cwd: setup.repo,
    deliveryRoot: setup.repo,
    codepunkHome: setup.home,
    appendFiles: [
      { path: outside },
      { path: path.join(setup.repo, ".env"), label: "secret.md" },
    ],
  });

  assert.equal(bundle.sources.length, 0);
  assert.deepEqual(bundle.warnings.map((warning) => warning.code).sort(), [
    "context.outside_root",
    "context.sensitive_path",
    "context.symlink",
  ]);
  assert.doesNotMatch(bundle.instructionBlock, /outside/u);
});

test("truncation is visible, hashed from the full file, and recorded", async () => {
  const setup = await workspace();
  const content = `header\n${"x".repeat(400)}`;
  await fs.writeFile(path.join(setup.repo, "AGENTS.md"), content);

  const bundle = await core.loadContext({
    cwd: setup.repo,
    deliveryRoot: setup.repo,
    codepunkHome: setup.home,
    maxFileBytes: 32,
    maxTotalBytes: 64,
  });

  assert.equal(bundle.sources.length, 1);
  const source = bundle.sources[0];
  assert.equal(source.truncated, true);
  assert.equal(source.sha256, sha256(Buffer.from(content, "utf8")));
  assert.match(bundle.instructionBlock, /context truncated/u);
  assert.doesNotMatch(bundle.instructionBlock, new RegExp(`x{100}`, "u"));
  assert.equal(bundle.truncated, true);
  assert.ok(bundle.totalBytes <= 32);
});

test("config append is hashed and system prompt replacement is user-scoped", async () => {
  const setup = await workspace();
  await fs.writeFile(
    path.join(setup.repo, "AGENTS.md"),
    "PROJECT MUST BE REPLACED\n",
  );
  const replacement = path.join(setup.home, "SYSTEM.md");
  await fs.writeFile(replacement, "REPLACED PRODUCT BLOCK\n");

  const appended = await core.loadContext({
    cwd: setup.repo,
    deliveryRoot: setup.repo,
    codepunkHome: setup.home,
    appendText: "APPENDED CONFIG TEXT\n",
  });
  const appendSource = appended.sources.find(
    (source) => source.source === "config/append",
  );
  assert.equal(
    appendSource.sha256,
    sha256(Buffer.from("APPENDED CONFIG TEXT\n", "utf8")),
  );
  assert.match(appended.instructionBlock, /APPENDED CONFIG TEXT/u);

  const replaced = await core.loadContext({
    cwd: setup.repo,
    deliveryRoot: setup.repo,
    codepunkHome: setup.home,
    replaceSystemPrompt: true,
    systemPromptFile: replacement,
  });
  assert.deepEqual(
    replaced.sources.map((source) => source.source),
    ["system-prompt"],
  );
  assert.match(replaced.instructionBlock, /REPLACED PRODUCT BLOCK/u);
  assert.doesNotMatch(replaced.instructionBlock, /PROJECT MUST BE REPLACED/u);

  const outside = path.join(setup.root, "outside-system.md");
  await fs.writeFile(outside, "OUTSIDE MUST NOT LOAD\n");
  const denied = await core.loadContext({
    cwd: setup.repo,
    deliveryRoot: setup.repo,
    codepunkHome: setup.home,
    replaceSystemPrompt: true,
    systemPromptFile: outside,
  });
  assert.equal(denied.instructionBlock, "");
  assert.ok(
    denied.warnings.some((warning) => warning.code === "context.outside_root"),
  );
});

test("the current request survives the host context hook", async () => {
  const setup = await workspace();
  const context = await core.loadContext({
    cwd: setup.repo,
    deliveryRoot: setup.repo,
    codepunkHome: setup.home,
    appendText: "STATIC CONTEXT\n",
  });
  const ledger = await core.EvidenceLedger.open(
    path.join(setup.root, "evidence.jsonl"),
  );
  const host = await core.createPiHost({
    cwd: setup.repo,
    workspaceRoot: setup.repo,
    deliveryRoot: setup.repo,
    codepunkHome: setup.home,
    sessionId: "session-context",
    runId: "run-context",
    writeSet: [setup.repo],
    mode: "print",
    approval: null,
    ledger,
    sandbox: null,
    context,
    bindMode: "print",
  });
  try {
    const current = {
      role: "user",
      content: [{ type: "text", text: "CURRENT REQUEST MUST REMAIN" }],
      timestamp: Date.now(),
    };
    const transformed = await host.session.agent.transformContext([current]);
    assert.equal(transformed.length, 1);
    assert.deepEqual(transformed[0], current);
  } finally {
    await host.dispose();
    await fs.rm(setup.root, { recursive: true, force: true });
    await fs.rm(setup.home, { recursive: true, force: true });
  }
});

test("turn-boundary truncation only drops historical tool output", async () => {
  const oldOutput = "old tool output ".repeat(400);
  const secondOutput = "second tool output ".repeat(200);
  const currentToolOutput = "CURRENT TOOL RESULT MUST REMAIN";
  const currentRequest = {
    role: "user",
    content: [{ type: "text", text: "CURRENT REQUEST MUST REMAIN" }],
    timestamp: 7,
  };
  const currentTool = {
    role: "toolResult",
    toolCallId: "call-current",
    toolName: "read",
    content: [{ type: "text", text: currentToolOutput }],
    isError: false,
    timestamp: 9,
  };
  const messages = [
    { role: "system", content: "system", timestamp: 1 },
    {
      role: "user",
      content: [{ type: "text", text: "old request" }],
      timestamp: 2,
    },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-old", name: "read", arguments: {} },
      ],
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: "call-old",
      toolName: "read",
      content: [{ type: "text", text: oldOutput }],
      details: { source: "historical" },
      isError: false,
      timestamp: 4,
    },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-second", name: "shell", arguments: {} },
      ],
      timestamp: 5,
    },
    {
      role: "toolResult",
      toolCallId: "call-second",
      toolName: "shell",
      content: [{ type: "text", text: secondOutput }],
      isError: false,
      timestamp: 6,
    },
    currentRequest,
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-current", name: "read", arguments: {} },
      ],
      timestamp: 8,
    },
    currentTool,
  ];
  const totalTokens = core.truncateContextAtTurnBoundary(messages, {
    maxTokens: Number.MAX_SAFE_INTEGER,
  }).tokensBefore;

  const first = core.truncateContextAtTurnBoundary(messages, {
    maxTokens: totalTokens - 1,
  });
  assert.equal(first.truncated, true);
  assert.equal(first.droppedToolResults, 1);
  assert.match(
    first.messages[3].content[0].text,
    /oldest tool output removed/u,
  );
  assert.match(first.messages[3].content[0].text, /tool="read"/u);
  assert.match(first.messages[3].content[0].text, /reason=turn-boundary/u);
  assert.match(first.messages[3].content[0].text, /sha256=sha256:/u);
  assert.equal(first.messages[3].details, undefined);
  assert.deepEqual(first.messages[5], messages[5]);
  assert.deepEqual(first.messages[6], currentRequest);
  assert.deepEqual(first.messages[8], currentTool);

  const all = core.truncateContextAtTurnBoundary(messages, { maxTokens: 0 });
  assert.equal(all.droppedToolResults, 2);
  assert.match(all.messages[5].content[0].text, /oldest tool output removed/u);
  assert.deepEqual(all.messages[6], currentRequest);
  assert.deepEqual(all.messages[8], currentTool);
  assert.deepEqual(all.messages[0], messages[0]);
  assert.ok(all.tokensAfter < all.tokensBefore);
});

test("the host wires turn-boundary truncation to the model budget", async () => {
  const setup = await workspace();
  const context = await core.loadContext({
    cwd: setup.repo,
    deliveryRoot: setup.repo,
    codepunkHome: setup.home,
    appendText: "STATIC CONTEXT\n",
  });
  const ledger = await core.EvidenceLedger.open(
    path.join(setup.root, "evidence.jsonl"),
  );
  const host = await core.createPiHost({
    cwd: setup.repo,
    workspaceRoot: setup.repo,
    deliveryRoot: setup.repo,
    codepunkHome: setup.home,
    sessionId: "session-truncation",
    runId: "run-truncation",
    writeSet: [setup.repo],
    mode: "print",
    approval: null,
    ledger,
    sandbox: null,
    context,
    bindMode: "print",
    model: TEST_MODEL,
    truncation: "turn-boundary",
    truncationThreshold: 0.01,
  });
  try {
    const current = {
      role: "user",
      content: [{ type: "text", text: "CURRENT REQUEST MUST REMAIN" }],
      timestamp: Date.now(),
    };
    const pending = {
      role: "toolResult",
      toolCallId: "call-pending",
      toolName: "read",
      content: [{ type: "text", text: "PENDING TOOL RESULT MUST REMAIN" }],
      isError: false,
      timestamp: Date.now(),
    };
    const transformed = await host.session.agent.transformContext([
      {
        role: "user",
        content: [{ type: "text", text: "old request" }],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call-old",
        toolName: "read",
        content: [{ type: "text", text: "historical output ".repeat(2_000) }],
        isError: false,
        timestamp: 2,
      },
      current,
      pending,
    ]);
    assert.match(transformed[1].content[0].text, /oldest tool output removed/u);
    assert.deepEqual(transformed[2], current);
    assert.deepEqual(transformed[3], pending);
  } finally {
    await host.dispose();
    await fs.rm(setup.root, { recursive: true, force: true });
    await fs.rm(setup.home, { recursive: true, force: true });
  }
});
