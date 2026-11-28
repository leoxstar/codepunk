import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { importCore, importSource } from "./support/core.mjs";
import { withTempDirectory } from "./support/helpers.mjs";

const execFileAsync = promisify(execFile);
const core = await importCore();
const { parseCli } = await importSource("packages/cli/src/args/parse.ts");
const { prepareCliWorktree, validateWorktreeName } = await importSource(
  "packages/cli/src/run/worktree.ts",
);
const { normalizeAcpPrompt } = await importSource(
  "packages/core/src/daemon/acp.ts",
);

function lease(sessionId, runId) {
  return {
    session_id: sessionId,
    run_id: runId,
    token: `lease-${sessionId}`,
    channel_id: "codepunk-acp",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

class StandardTestBackend {
  constructor() {
    this.sessions = new Map();
    this.persisted = new Set(["persisted-session-1"]);
    this.prompts = [];
    this.nextId = 1;
  }

  async newSession(scopes, options) {
    const sessionId = `std-session-${this.nextId++}`;
    const writerLease = lease(sessionId, `run-${this.nextId}`);
    this.sessions.set(sessionId, { scopes, cwd: options?.cwd, writerLease });
    return { sessionId, writerLease };
  }

  async loadSession(sessionId, scopes, options) {
    if (!this.persisted.has(sessionId) && !this.sessions.has(sessionId)) {
      throw new core.ControlNotFoundError(
        `control session ${sessionId} was not found`,
      );
    }
    const writerLease = lease(sessionId, `run-loaded-${this.nextId++}`);
    this.sessions.set(sessionId, { scopes, cwd: options?.cwd, writerLease });
    return { sessionId, writerLease };
  }

  async run(request) {
    this.prompts.push(request.prompt);
    return {
      session_id: request.sessionId,
      run_id: request.writerLease.run_id,
      assistantText: `Handled: ${request.prompt.splitlines ? "" : request.prompt.split("\n")[0]}`,
      events: [
        {
          type: "codepunk/daemon-control-event",
          version: 1,
          session_id: request.sessionId,
          run_id: request.writerLease.run_id,
          seq: 1,
          kind: "control/accepted",
          reason: request.reason,
        },
        {
          type: "codepunk/daemon-control-event",
          version: 1,
          session_id: request.sessionId,
          run_id: request.writerLease.run_id,
          seq: 2,
          kind: "control/completed",
        },
      ],
      writer_lease: request.writerLease,
    };
  }

  async stop(request) {
    return {
      session_id: request.sessionId,
      run_id: request.writerLease.run_id,
      events: [
        {
          type: "codepunk/daemon-control-event",
          version: 1,
          session_id: request.sessionId,
          run_id: request.writerLease.run_id,
          seq: 3,
          kind: "control/stopped",
          reason: request.reason,
        },
      ],
      writer_lease: request.writerLease,
    };
  }
}

async function runStandardAcp(messages, backend = new StandardTestBackend()) {
  const input = new PassThrough();
  const output = new PassThrough();
  const received = [];
  const reader = createInterface({ input: output });
  reader.on("line", (line) => received.push(JSON.parse(line)));
  const server = new core.AcpServer({ backend, input, output });
  const completion = server.run();
  for (const msg of messages) {
    input.write(`${JSON.stringify(msg)}\n`);
  }
  input.end();
  await completion;
  await delay(0);
  reader.close();
  return { received, backend };
}

test("Standard ACP mode handles clientInfo initialize, session/new, session/load, block prompts, session/update, and unknown-session negative control", async () => {
  const { received, backend } = await runStandardAcp([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true } },
        clientInfo: { name: "zed", title: "Zed", version: "0.180.0" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/tmp/project", mcpServers: [] },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: "std-session-1",
        prompt: [
          { type: "text", text: "Explain main.ts" },
          {
            type: "resource",
            resource: {
              uri: "file:///tmp/project/main.ts",
              text: "export const x = 1;",
            },
          },
        ],
      },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "session/load",
      params: { sessionId: "persisted-session-1", cwd: "/tmp/project" },
    },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
      params: { sessionId: "missing-session-999" },
    },
    {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "std-session-1" },
    },
  ]);

  const initRes = received.find((m) => m.id === 1);
  assert.equal(initRes.result.protocolVersion, 1);
  assert.equal(initRes.result.agentCapabilities.loadSession, true);
  assert.equal(
    initRes.result.agentCapabilities.promptCapabilities.embeddedContext,
    true,
  );
  assert.equal(initRes.result.agentInfo.name, "codepunk");

  const newRes = received.find((m) => m.id === 2);
  assert.deepEqual(newRes.result, { sessionId: "std-session-1" });

  assert.equal(backend.prompts.length, 1);
  assert.match(backend.prompts[0], /Explain main\.ts/u);
  assert.match(backend.prompts[0], /export const x = 1;/u);

  const updates = received.filter((m) => m.method === "session/update");
  assert.ok(
    updates.some(
      (u) =>
        u.params.sessionId === "std-session-1" &&
        u.params.update.sessionUpdate === "agent_message_chunk" &&
        /Handled: Explain main\.ts/u.test(u.params.update.content.text),
    ),
  );

  const promptRes = received.find((m) => m.id === 3);
  assert.equal(promptRes.result.stopReason, "end_turn");
  assert.equal(promptRes.result.sessionId, "std-session-1");

  const loadRes = received.find((m) => m.id === 4);
  assert.deepEqual(loadRes.result, { sessionId: "persisted-session-1" });

  // Negative control: unknown session on session/load returns 49005
  const missingRes = received.find((m) => m.id === 5);
  assert.equal(missingRes.error.code, 49005);

  assert.equal(normalizeAcpPrompt(""), null);
});

test("CLI --worktree parses bare and named flags, creates and reuses isolated git worktrees, and rejects unsafe slugs or non-git dirs", async () => {
  assert.equal(parseCli(["--worktree"]).worktree, "auto");
  assert.equal(parseCli(["-w", "-p", "hi"]).worktree, "auto");
  assert.equal(parseCli(["--worktree", "feat-auth"]).worktree, "feat-auth");
  assert.equal(parseCli(["-w", "fix_1.2"]).worktree, "fix_1.2");

  // Negative control 1: path traversal / unsafe slug rejected
  assert.throws(
    () => parseCli(["--worktree", "../escape"]),
    /--worktree name must match/u,
  );
  assert.throws(
    () => validateWorktreeName("bad/slash"),
    /--worktree name must match/u,
  );

  await withTempDirectory("codepunk-cli-worktree-", async (root) => {
    const home = path.join(root, "home");
    const nonGit = path.join(root, "plain-dir");
    await fs.mkdir(nonGit, { recursive: true });

    // Negative control 2: non-git directory rejected
    await assert.rejects(
      () => prepareCliWorktree("feat-x", nonGit, { CODEPUNK_HOME: home }, true),
      /--worktree requires a git repository/u,
    );

    // Positive: git repository creates isolated worktree on branch codepunk/<slug> and reuses it
    const repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd: repo });
    await execFileAsync("git", ["config", "core.autocrlf", "false"], {
      cwd: repo,
    });
    await fs.writeFile(path.join(repo, "README.md"), "# hello\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: repo });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "init",
      ],
      { cwd: repo },
    );

    const created = await prepareCliWorktree(
      "feat-isolated",
      repo,
      { CODEPUNK_HOME: home },
      true,
    );
    assert.ok(created);
    assert.equal(created.created, true);
    assert.equal(created.branch, "codepunk/feat-isolated");
    assert.notEqual(created.cwd, await fs.realpath(repo));
    assert.equal(
      await fs.readFile(path.join(created.cwd, "README.md"), "utf8"),
      "# hello\n",
    );

    // Mutate inside isolated worktree -> main repo stays untouched!
    await fs.writeFile(path.join(created.cwd, "README.md"), "# isolated\n");
    assert.equal(
      await fs.readFile(path.join(repo, "README.md"), "utf8"),
      "# hello\n",
    );

    const reused = await prepareCliWorktree(
      "feat-isolated",
      repo,
      { CODEPUNK_HOME: home },
      true,
    );
    assert.equal(reused?.created, false);
    assert.equal(reused?.cwd, created.cwd);
  });
});
