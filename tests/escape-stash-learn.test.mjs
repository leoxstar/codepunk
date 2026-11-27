import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { importCore } from "./support/core.mjs";
import { withTempDirectory, writeFile } from "./support/helpers.mjs";
import { TEST_MODEL } from "./support/pi-model.mjs";
import { TuiApprovalChannel } from "../packages/cli/src/tui/approval/channel.ts";
import {
  applyPromptStashAction,
  MAX_PROMPT_STASH_ENTRIES,
} from "../packages/cli/src/tui/commands/stash.ts";
import {
  extractSessionLearnings,
  proposeAgentsMdRulePatch,
  runLearnAction,
} from "../packages/cli/src/tui/commands/learn.ts";

const core = await importCore();
const execFileAsync = promisify(execFile);

async function makeGitRepo(root) {
  const project = path.join(root, "project");
  await fs.mkdir(project, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: project });
  return project;
}

test("unsandboxed_once runs a single interactive shell call outside srt while keeping subsequent calls sandboxed and rejecting session/persistent/headless abuse", async () => {
  await withTempDirectory("codepunk-unsandboxed-once-", async (root) => {
    const project = await makeGitRepo(root);
    const home = path.join(root, "home");
    await fs.mkdir(home, { recursive: true });

    let fakeSrtCalls = 0;
    const fakeSrtProvider = {
      sandboxed: true,
      descriptor: {
        backend: "srt",
        version: "0.0.82",
        profile_sha256: `sha256:${"a".repeat(64)}`,
        network_allowed_domains: [],
        network_denied_domains: [],
      },
      async execCommand(command) {
        fakeSrtCalls += 1;
        return {
          output: `SRT:${command}`,
          exitCode: 0,
          cancelled: false,
          timedOut: false,
          executor: "srt",
          descriptor: this.descriptor,
        };
      },
      async execArgv(argv) {
        fakeSrtCalls += 1;
        return {
          output: `SRT:${argv.join(" ")}`,
          exitCode: 0,
          cancelled: false,
          timedOut: false,
          executor: "srt",
          descriptor: this.descriptor,
        };
      },
      async close() {},
    };

    let nextUnsandboxedOnce = true;
    const channel = {
      id: "test-tty",
      kind: "tui",
      isTTY: true,
      async ask(request) {
        return {
          request_id: request.request_id,
          answer: "allow",
          scope: "once",
          ...(nextUnsandboxedOnce ? { unsandboxed_once: true } : {}),
          channel: "tui",
          channel_id: request.channel_id,
          nonce_sha256: request.nonce_sha256,
          worker_id: request.worker_id,
          session_id: request.session_id,
          tool_call_id: request.tool_call_id,
          answered_at: new Date().toISOString(),
        };
      },
    };

    const runtime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      model: TEST_MODEL,
      approvalChannel: channel,
      createSandbox: async () => fakeSrtProvider,
    });
    try {
      await runtime.sandboxReady;
      const bashDef = runtime.host.session.getToolDefinition("bash");
      assert.ok(bashDef);

      // Call 1: unsandboxed_once: true -> bypasses fakeSrtProvider and runs via UnsandboxedShell
      const first = await bashDef.execute(
        "call-unsandboxed-1",
        {
          command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('host_escape_ok')"`,
        },
        undefined,
        undefined,
        {},
      );
      assert.notEqual(first.isError, true);
      assert.equal(
        fakeSrtCalls,
        0,
        "unsandboxed_once must bypass srt for this single call",
      );
      const rec1 = runtime.ledger.all.at(-1);
      assert.equal(rec1?.coverage, "uncovered");
      assert.equal(rec1?.executor, "direct");
      assert.deepEqual(rec1?.coverage_basis, ["policy", "unsandboxed-once"]);
      assert.equal(rec1?.approval?.unsandboxed_once, true);

      // Call 2: normal allow once -> runs inside fakeSrtProvider again!
      nextUnsandboxedOnce = false;
      const second = await bashDef.execute(
        "call-sandboxed-2",
        {
          command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('back_in_srt')"`,
        },
        undefined,
        undefined,
        {},
      );
      assert.notEqual(second.isError, true);
      assert.equal(fakeSrtCalls, 1, "subsequent call must remain in srt");
      const rec2 = runtime.ledger.all.at(-1);
      assert.equal(rec2?.coverage, "enforced");
      assert.equal(rec2?.executor, "srt");
    } finally {
      await runtime.dispose();
    }

    // Negative controls on ApprovalBroker: unsandboxed_once cannot combine with session/persistent or non-shell tools
    const broker = new core.ApprovalBroker({ workspaceTrusted: true });
    broker.registerChannel({
      id: "bad-ch",
      kind: "tui",
      isTTY: true,
      async ask(req) {
        return {
          request_id: req.request_id,
          answer: "allow",
          scope: "session",
          unsandboxed_once: true,
          channel: "tui",
          channel_id: req.channel_id,
          nonce_sha256: req.nonce_sha256,
          worker_id: req.worker_id,
          session_id: req.session_id,
          tool_call_id: req.tool_call_id,
          answered_at: new Date().toISOString(),
        };
      },
    });
    const badScope = await broker.request({
      sessionId: "s1",
      workerId: "local",
      toolCallId: "tc1",
      tool: "bash",
      command: "echo hi",
      argv: ["echo", "hi"],
      cwd: project,
      reason: "test",
    });
    assert.equal(badScope.approved, false);
    assert.equal(badScope.failure, "mismatch");
  });
});

test("sandbox.user_bash=uncovered runs interactive !cmd directly on host while blocking project-config escalation", async () => {
  await withTempDirectory("codepunk-user-bash-host-", async (root) => {
    const project = await makeGitRepo(root);
    const home = path.join(root, "home");
    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "required"\nuser_bash = "uncovered"\n[approval]\nmode = "allow"\n',
    );

    const runtime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      model: TEST_MODEL,
      createSandbox: async () => {
        throw new core.SandboxUnavailableError("srt missing");
      },
    });
    try {
      await runtime.sandboxReady;
      const wrapped = await core.wrapUserBashCommand(
        "printf user_host_ok",
        "ub-1",
        {
          cwd: project,
          workspaceRoot: project,
          deliveryRoot: project,
          codepunkHome: home,
          sessionId: runtime.session.sessionId,
          runId: runtime.runId,
          mode: "interactive",
          approvalMode: "allow",
          ledger: runtime.ledger,
          sandbox: () => runtime.sandbox,
          userBashUnsandboxed: () => true,
        },
      );
      assert.ok(
        wrapped.operations,
        "user_bash succeeds via host UnsandboxedShell",
      );
      let out = "";
      const execRes = await wrapped.operations.exec(
        "printf user_host_ok",
        project,
        {
          onData: (chunk) => {
            out += chunk.toString("utf8");
          },
        },
      );
      assert.equal(execRes.exitCode, 0);
      assert.equal(out, "user_host_ok");
      const rec = runtime.ledger.all.at(-1);
      assert.equal(rec?.coverage, "uncovered");
      assert.deepEqual(rec?.coverage_basis, ["policy", "user-bash-uncovered"]);
      assert.equal(rec?.executor, "direct");
    } finally {
      await runtime.dispose();
    }

    // Negative control: project .codepunk/config.toml must NOT be allowed to set sandbox.user_bash
    await writeFile(path.join(home, "config.toml"), "");
    await writeFile(
      path.join(project, ".codepunk", "config.toml"),
      '[sandbox]\nuser_bash = "uncovered"\n',
    );
    const paths = core.projectPaths(await core.findDeliveryRoot(project), home);
    await assert.rejects(
      () =>
        core.loadConfig(
          paths,
          { CODEPUNK_HOME: home },
          {},
          { projectTrusted: true },
        ),
      /sandbox\.user_bash is user\/CLI-only/u,
    );
  });
});

test("TuiApprovalChannel offers Allow once (unsandboxed) only for srt-covered shell requests, and /stash + /learn helpers work safely", async () => {
  // 1. TuiApprovalChannel choice filtering
  const seenMenus = [];
  const tuiChannel = new TuiApprovalChannel(true);
  tuiChannel.attach({
    ui: {
      async select(_prompt, options) {
        seenMenus.push(options);
        return (
          options.find((opt) => opt.includes("unsandboxed")) ?? "Allow once"
        );
      },
      notify() {},
    },
  });
  const shellAnswer = await tuiChannel.ask({
    request_id: "req-1",
    nonce_sha256: "b".repeat(64),
    ttl_ms: 60_000,
    worker_id: "local",
    session_id: "s1",
    tool_call_id: "tc-shell",
    channel_id: "codepunk-tui",
    tool: "bash",
    command: "pnpm install",
    cwd: "/tmp",
    coverage_preview: "srt 0.0.82 enforced; network off unless allowlisted",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(shellAnswer?.unsandboxed_once, true);
  assert.ok(seenMenus[0].includes("Allow once (unsandboxed)"));

  await tuiChannel.ask({
    request_id: "req-2",
    nonce_sha256: "c".repeat(64),
    ttl_ms: 60_000,
    worker_id: "local",
    session_id: "s1",
    tool_call_id: "tc-write",
    channel_id: "codepunk-tui",
    tool: "write",
    path: "/tmp/a.txt",
    coverage_preview: "path and write-set policy enforced",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(
    seenMenus[1].includes("Allow once (unsandboxed)"),
    false,
    "write tool must never offer unsandboxed shell escape",
  );

  // 2. Prompt stash push / pop / bounds / negative control
  const stack = [];
  const pushed = applyPromptStashAction(stack, "toggle", "draft one");
  assert.equal(pushed.nextEditorText, "");
  assert.equal(pushed.outcome.kind, "pushed");
  const outOfRange = applyPromptStashAction(stack, "pop", "", { index: 5 });
  assert.equal(outOfRange.outcome.kind, "out_of_range");
  const popped = applyPromptStashAction(stack, "toggle", "");
  assert.equal(popped.nextEditorText, "draft one");
  assert.equal(popped.outcome.kind, "popped");
  for (let i = 0; i < MAX_PROMPT_STASH_ENTRIES + 5; i += 1) {
    applyPromptStashAction(stack, "push", `item-${i}`);
  }
  assert.equal(stack.length, MAX_PROMPT_STASH_ENTRIES);

  // 3. /learn extraction, idempotency, and symlink refusal negative control
  const learnings = extractSessionLearnings(
    [
      {
        role: "user",
        content:
          "Always run node scripts/check-repo.mjs --require-built after building.",
      },
      { role: "user", content: "hello world" },
    ],
    [
      {
        approval: {
          guidance: "Never use tsc -b because it emits .tsbuildinfo files",
        },
      },
    ],
  );
  assert.equal(learnings.length, 2);
  assert.match(learnings[0], /Never use tsc -b/u);
  assert.match(learnings[1], /Always run node scripts\/check-repo\.mjs/u);

  const patch1 = proposeAgentsMdRulePatch("# Project\n", learnings[0]);
  assert.equal(patch1.alreadyPresent, false);
  assert.match(patch1.updatedContent, /## Learned Rules/u);
  const patch2 = proposeAgentsMdRulePatch(patch1.updatedContent, learnings[0]);
  assert.equal(patch2.alreadyPresent, true);

  await withTempDirectory("codepunk-learn-symlink-", async (root) => {
    const project = await makeGitRepo(root);
    const home = path.join(root, "home");
    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const outsideTarget = path.join(root, "outside.md");
    await writeFile(outsideTarget, "SECRET\n");
    await fs.symlink(outsideTarget, path.join(project, "AGENTS.md"));
    const runtime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      model: TEST_MODEL,
    });
    try {
      const notices = [];
      await runLearnAction(
        runtime,
        {
          ui: {
            notify(msg, level) {
              notices.push({ msg, level });
            },
            async select() {
              return "Write to AGENTS.md";
            },
          },
        },
        "Always run tests before committing",
      );
      assert.equal(notices[0]?.level, "error");
      assert.match(
        notices[0]?.msg ?? "",
        /Refused to modify symlinked AGENTS\.md/u,
      );
      assert.equal(await fs.readFile(outsideTarget, "utf8"), "SECRET\n");
    } finally {
      await runtime.dispose();
    }
  });
});
