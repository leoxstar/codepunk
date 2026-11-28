import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assertPrivateFile,
  ensureBuilt,
  escapeRegExp,
  PRODUCT_VERSION,
  trustWorkspace,
  withTempDirectory,
} from "./support/helpers.mjs";
import {
  BASE_ENV,
  closeOverlay,
  execFileAsync,
  readEvidence,
  runCommandAfter,
  startPty,
  stopPty,
  stripAnsi,
  submitUserBashWhenIdle,
  waitFor,
  waitForBashResult,
  waitForOutput,
  waitForOutputAfter,
  waitForQuiet,
} from "./support/tui-pty.mjs";

test("a real pty asks before a project instruction file is trusted", async () => {
  await withTempDirectory("codepunk-tui-trust-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "PROJECT_RULE_SENTINEL\n",
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "Project trust", "trust prompt");
      assert.match(session.output(), /AGENTS\.md/u);
      assert.match(session.output(), /sha256:[a-f0-9]{12}\u2026/u);
      assert.doesNotMatch(session.output(), /sha256:[a-f0-9]{64}/u);
      assert.match(
        stripAnsi(session.output()),
        /Workspace trust\s+cwd: .+\s+checkout root: /u,
      );
      assert.match(
        stripAnsi(session.output()),
        /Trust only controls project config, policy, skills, and instruction files\./u,
      );
      assert.match(
        stripAnsi(session.output()),
        /It does not change approval, sandbox, or filesystem permissions\./u,
      );
      assert.match(
        stripAnsi(session.output()),
        /saved decision:\s+none for this checkout or an ancestor/u,
      );
      assert.doesNotMatch(
        stripAnsi(session.output()),
        new RegExp(
          `codepunk ${escapeRegExp(PRODUCT_VERSION)} · dist .+ · source current`,
          "u",
        ),
      );
      assert.match(
        stripAnsi(session.output()),
        /\u2191\u2193 navigate  enter select  esc\/ctrl\+c cancel/u,
      );
      assert.match(
        session.output(),
        /\u2192 Trust this workspace and remember/u,
      );
      assert.match(session.output(), /Load all resources · remember/u);
      assert.match(session.output(), /Skip all now · ask again next start/u);
      assert.doesNotMatch(
        session.output(),
        /1\. Trust this workspace and remember/u,
      );
      assert.doesNotMatch(session.output(), /1-3 to jump/u);
      assert.doesNotMatch(session.output(), /\[1\/2\/3\]/u);
      session.child.stdin.write("\u001b[B\u001b[B\r");
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const saved = JSON.parse(
        await fs.readFile(path.join(home, "trust.json"), "utf8"),
      );
      assert.equal(saved[await fs.realpath(project)], false);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
    const second = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(second, "codepunk · auto/auto", "saved decision");
      assert.doesNotMatch(second.output(), /Trust this workspace\?/u);
      second.child.stdin.write("/quit\r");
    } finally {
      await stopPty(second);
    }
  });
});

test("a real pty remembers the default trust choice", async () => {
  await withTempDirectory("codepunk-tui-trust-default-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "DEFAULT_TRUST_SENTINEL\n",
    );
    const cli = await ensureBuilt();
    const env = {
      ...BASE_ENV,
      CODEPUNK_HOME: home,
      PI_OFFLINE: "1",
      TERM: "xterm-256color",
      NO_COLOR: "1",
    };
    const first = startPty(process.execPath, [cli], { cwd: project, env });
    try {
      await waitForOutput(first, "Project trust", "first trust prompt");
      first.child.stdin.write("\r");
      await waitForOutput(first, "codepunk · auto/auto", "first startup");
      await waitForOutput(first, "trust trusted (saved)", "remembered status");
      const store = JSON.parse(
        await fs.readFile(path.join(home, "trust.json"), "utf8"),
      );
      const realProject = await fs.realpath(project);
      assert.equal(store[realProject], true);
      first.child.stdin.write("/quit\r");
      const result = await Promise.race([
        first.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(first);
    }

    const second = startPty(process.execPath, [cli], { cwd: project, env });
    try {
      await waitForOutput(second, "codepunk · auto/auto", "trusted restart");
      assert.doesNotMatch(second.output(), /Trust this workspace\?/u);
      assert.match(second.output(), /trust trusted \(saved\)/u);
      second.child.stdin.write("/quit\r");
      const result = await Promise.race([
        second.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(second);
    }
  });
});

test("a real pty applies a custom per-resource trust decision", async () => {
  await withTempDirectory("codepunk-tui-trust-custom-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(path.join(project, ".codepunk", "skills", "team"), {
      recursive: true,
    });
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, ".codepunk", "config.toml"),
      "[memory]\nmax_tokens = 400\n",
    );
    await fs.writeFile(
      path.join(project, ".codepunk", "skills", "team", "SKILL.md"),
      "---\nname: team\ndescription: team\n---\nbody\n",
    );
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "CUSTOM_TRUST_SENTINEL\n",
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "Project trust", "trust prompt");
      assert.doesNotMatch(session.output(), /Customize resources/u);
      assert.doesNotMatch(
        session.output(),
        /1\. Trust this workspace and remember/u,
      );
      await waitForQuiet(session, 250);
      // Choose "Do not trust and remember this decision" (3rd option), then grant instructions + config via /trust.
      session.child.stdin.write("\u001b[B\u001b[B\r");
      await waitForOutput(session, "codepunk · auto/auto", "untrusted startup");
      await runCommandAfter(
        session,
        "/trust grant instructions",
        "workspace trust saved as trusted",
      );
      const saved = JSON.parse(
        await fs.readFile(path.join(home, "workspace-trust.json"), "utf8"),
      );
      assert.deepEqual(saved.workspaces[await fs.realpath(project)].grants, {
        config: false,
        policy: false,
        skills: false,
        instructions: true,
      });
      const mark = session.output().length;
      session.child.stdin.write("/trust status\r");
      await waitForOutputAfter(
        session,
        mark,
        "saved resources:",
        "trust status",
      );
      assert.match(
        stripAnsi(session.output().slice(mark)),
        /config=skipped, policy=skipped, skills=skipped, instructions=allowed/u,
      );
      await runCommandAfter(
        session,
        "/trust grant config",
        "workspace trust saved as trusted",
      );
      const savedAfterGrant = JSON.parse(
        await fs.readFile(path.join(home, "workspace-trust.json"), "utf8"),
      );
      assert.deepEqual(
        savedAfterGrant.workspaces[await fs.realpath(project)].grants,
        {
          config: true,
          policy: false,
          skills: false,
          instructions: true,
        },
      );
      const revokeMark = session.output().length;
      await runCommandAfter(
        session,
        "/trust revoke instructions",
        "resources: config=allowed, policy=skipped, skills=skipped, instructions=skipped",
      );
      assert.doesNotMatch(
        stripAnsi(session.output().slice(revokeMark)),
        /workspace trust saved as untrusted/u,
      );
      const savedAfterRevoke = JSON.parse(
        await fs.readFile(path.join(home, "workspace-trust.json"), "utf8"),
      );
      assert.deepEqual(
        savedAfterRevoke.workspaces[await fs.realpath(project)].grants,
        {
          config: true,
          policy: false,
          skills: false,
          instructions: false,
        },
      );
      await runCommandAfter(
        session,
        "/trust revoke config",
        "workspace trust saved as untrusted",
      );
      const savedAfterFullRevoke = JSON.parse(
        await fs.readFile(path.join(home, "workspace-trust.json"), "utf8"),
      );
      assert.deepEqual(
        savedAfterFullRevoke.workspaces[await fs.realpath(project)].grants,
        {
          config: false,
          policy: false,
          skills: false,
          instructions: false,
        },
      );
      await waitForQuiet(session, 1_000);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(
        result,
        { code: 0, signal: null },
        stripAnsi(session.output()).slice(-4_000),
      );
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty labels an explicit one-run trust decision", async () => {
  await withTempDirectory("codepunk-tui-trust-flag-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "ONE_RUN_TRUST_SENTINEL\n",
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli, "--trust"], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      assert.match(session.output(), /trust trusted \(one run\)/u);
      await assert.rejects(
        fs.readFile(path.join(home, "trust.json"), "utf8"),
        /ENOENT/u,
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty explains an ancestor trust decision without inheriting it", async () => {
  await withTempDirectory("codepunk-tui-trust-parent-", async (root) => {
    const workspace = path.join(root, "workspace");
    const project = path.join(workspace, "packages", "app");
    const home = path.join(root, "home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "NESTED_PARENT_TRUST_SENTINEL\n",
    );
    await trustWorkspace(home, workspace);
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "Project trust", "trust prompt");
      const output = stripAnsi(session.output()).replace(/\s+/gu, " ");
      assert.match(
        output,
        /saved decision: trusted for parent .+; this checkout needs its own decision/u,
      );
      assert.ok(output.includes(`checkout root: ${project}`));
      session.child.stdin.write("\u001b");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 8_000),
        ),
      ]);
      assert.deepEqual(result, { code: 1, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty cancels workspace trust without hanging", async () => {
  await withTempDirectory("codepunk-tui-trust-cancel-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "CANCEL_TRUST_SENTINEL\n",
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "Project trust", "trust prompt");
      session.child.stdin.write("\u001b");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 8_000),
        ),
      ]);
      assert.deepEqual(result, { code: 1, signal: null });
      assert.match(
        stripAnsi(session.output()),
        /workspace trust was not decided/u,
      );
      await assert.rejects(
        fs.readFile(path.join(home, "trust.json"), "utf8"),
        /ENOENT/u,
      );
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty can deny workspace trust for one session without saving", async () => {
  await withTempDirectory("codepunk-tui-trust-deny-session-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "DENY_SESSION_SENTINEL\n",
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "Project trust", "trust prompt");
      assert.match(
        stripAnsi(session.output()),
        /Do not trust for this session only/u,
      );
      session.child.stdin.write("\u001b[B\u001b[B\u001b[B\r");
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      assert.match(session.output(), /trust untrusted \(session only\)/u);
      await assert.rejects(
        fs.readFile(path.join(home, "trust.json"), "utf8"),
        /ENOENT/u,
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("--no-skills keeps project skills out of the /trust view", async () => {
  await withTempDirectory("codepunk-tui-trust-noskills-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(path.join(project, "AGENTS.md"), "PROJECT_RULE\n");
    await fs.mkdir(path.join(project, ".codepunk", "skills", "team"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(project, ".codepunk", "skills", "team", "SKILL.md"),
      "---\nname: team\ndescription: team\n---\nbody\n",
    );
    await trustWorkspace(home, project);
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli, "--no-skills"], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const mark = session.output().length;
      session.child.stdin.write("/trust\r");
      await waitForOutputAfter(
        session,
        mark,
        "excluded from this session's trust check",
        "/trust under --no-skills",
      );
      const view = session.output().slice(mark);
      assert.match(view, /AGENTS\.md/u);
      assert.match(view, /project skills \(--no-skills or --bare\)/u);
      // A resource that was never part of this session's decision must not be
      // presented as one the user is being asked to trust.
      assert.doesNotMatch(view, /\.codepunk\/skills/u);
      await closeOverlay(session);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("header and footer can be disabled without disabling the session", async () => {
  await withTempDirectory("codepunk-tui-hidden-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[tui]",
        "header = false",
        "footer = false",
        "status = false",
        "widgets = false",
        "",
      ].join("\n"),
    );
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "No model configured.", "startup");
      await waitForOutput(
        session,
        "codepunk warning: sandbox mode is uncovered",
        "startup warning",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      await runCommandAfter(
        session,
        "/evidence",
        "No evidence in the current run.",
      );
      await closeOverlay(session);
      assert.doesNotMatch(session.output(), /codepunk · auto\/auto/u);
      assert.doesNotMatch(session.output(), /approvals ask · autonomy ask/u);
      assert.doesNotMatch(session.output(), /project [0-9a-f]{16}/u);
      await waitForQuiet(session, 250);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(
        result,
        { code: 0, signal: null },
        stripAnsi(session.output()).slice(-4_000),
      );
    } finally {
      await stopPty(session);
    }
  });
});

test(
  "a real pty approval selector allows and denies shell commands",
  {
    skip:
      process.platform === "win32"
        ? "the fixture uses POSIX date and rm commands"
        : false,
  },
  async () => {
    await withTempDirectory("codepunk-tui-approval-", async (root) => {
      const project = path.join(root, "project");
      await fs.mkdir(project);
      const home = path.join(root, "home");
      await fs.mkdir(home);
      await execFileAsync("git", ["init", "-q"], { cwd: project });
      const cli = await ensureBuilt();
      const session = startPty(process.execPath, [cli], {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      });
      try {
        await waitForOutput(session, "codepunk · auto/auto", "startup");

        const dateMark = session.output().length;
        session.child.stdin.write("!date +%A\r");
        const dateRecord = await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (record) =>
                record.command === "date +%A" && record.decision === "allow",
            ) ?? null,
          "read-only date evidence",
        );
        assert.equal(dateRecord.exit_code, 0);
        assert.doesNotMatch(
          session.output().slice(dateMark),
          /Approval required/u,
        );
        await waitForBashResult(home, "date +%A");
        await new Promise((resolve) => setTimeout(resolve, 300));

        const allowMark = session.output().length;
        session.child.stdin.write("!touch approved.txt\r");
        await waitForOutputAfter(
          session,
          allowMark,
          "Approval required",
          "allow approval prompt",
        );
        await waitForOutputAfter(
          session,
          allowMark,
          "esc cancel",
          "approval policy reason",
        );
        assert.match(
          session.output().slice(allowMark),
          /command: touch approved\.txt/u,
        );
        assert.match(session.output().slice(allowMark), /why: .+/u);
        assert.match(
          session.output().slice(allowMark),
          /coverage: (?:srt [^;]+ enforced|no srt sandbox; this command runs directly)/u,
        );
        assert.match(session.output().slice(allowMark), /Allow for session/u);
        assert.match(session.output().slice(allowMark), /Always allow exact/u);
        session.child.stdin.write("a");
        await waitFor(
          () =>
            fs
              .stat(path.join(project, "approved.txt"))
              .then(() => true)
              .catch(() => null),
          "approved command execution",
        );
        const allowed = await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (record) =>
                record.command === "touch approved.txt" &&
                record.decision === "allow",
            ) ?? null,
          "allowed command evidence",
        );
        assert.equal(allowed.exit_code, 0);
        assert.equal(allowed.rule, "policy.default");
        assert.equal(allowed.approval.channel, "tui");
        assert.equal(allowed.approval.scope, "once");
        assert.equal(allowed.approval.tool_call_id, allowed.tool_call_id);
        assert.equal(allowed.approval.worker_id, "local");
        assert.equal(allowed.approval.session_id, allowed.session_id);
        assert.match(allowed.approval.request_id, /^[0-9a-f-]{36}$/u);
        assert.match(allowed.approval.nonce_sha256, /^sha256:[0-9a-f]{64}$/u);
        assert.ok(allowed.approval.ttl_ms > 0);
        await waitForBashResult(home, "touch approved.txt");

        await submitUserBashWhenIdle(
          session,
          "!touch denied.txt",
          "deny approval prompt",
        );
        session.child.stdin.write("d");
        const denied = await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (record) =>
                record.command === "touch denied.txt" &&
                record.decision === "deny",
            ) ?? null,
          "denied command evidence",
        );
        assert.equal(denied.rule, "approval.denied");
        assert.equal(denied.approval.answer, "deny");
        assert.equal(denied.approval.scope, "once");
        assert.equal(
          await fs.stat(path.join(project, "denied.txt")).catch(() => null),
          null,
        );

        await submitUserBashWhenIdle(
          session,
          "!!touch excluded.txt",
          "excluded shell approval prompt",
        );
        session.child.stdin.write("a");
        await waitFor(
          () =>
            fs
              .stat(path.join(project, "excluded.txt"))
              .then(() => true)
              .catch(() => null),
          "excluded command execution",
        );
        const excluded = await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (record) =>
                record.command === "touch excluded.txt" &&
                record.decision === "allow",
            ) ?? null,
          "excluded command evidence",
        );
        assert.equal(excluded.exit_code, 0);
        await waitForBashResult(home, "touch excluded.txt");

        await waitForQuiet(session, 250);
        session.child.stdin.write("/quit\r");
        const result = await Promise.race([
          session.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(
          result,
          { code: 0, signal: null },
          stripAnsi(session.output()).slice(-2_000),
        );
      } finally {
        await stopPty(session);
      }
    });
  },
);

test(
  "a real pty persists an exact approval rule for later sessions",
  {
    skip:
      process.platform === "win32"
        ? "the fixture uses POSIX touch and shell syntax"
        : false,
  },
  async () => {
    await withTempDirectory("codepunk-tui-persist-approval-", async (root) => {
      const project = path.join(root, "project");
      await fs.mkdir(project);
      const home = path.join(root, "home");
      await fs.mkdir(home);
      await execFileAsync("git", ["init", "-q"], { cwd: project });
      const cli = await ensureBuilt();
      const env = {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      };
      const first = startPty(process.execPath, [cli], { cwd: project, env });
      try {
        await waitForOutput(first, "codepunk · auto/auto", "startup");
        const mark = first.output().length;
        first.child.stdin.write("!touch persisted-exact.txt\r");
        await waitForOutputAfter(
          first,
          mark,
          "Always allow exact",
          "persistent approval option",
        );
        first.child.stdin.write("p");
        await waitForOutputAfter(
          first,
          mark,
          "Persistent rule preview",
          "persistent approval confirmation",
        );
        const persistentPreview = first.output().slice(mark);
        assert.match(
          persistentPreview,
          /exact argv: \["touch","persisted-exact\.txt"\]/u,
        );
        assert.match(persistentPreview, /cwd: \S+/u);
        assert.match(persistentPreview, /storage: user scoped-rule file/u);
        assert.match(
          persistentPreview,
          /next session: autonomy switches to scoped/u,
        );
        first.child.stdin.write("\r");
        const allowed = await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (record) =>
                record.command === "touch persisted-exact.txt" &&
                record.decision === "allow" &&
                record.approval?.scope === "persistent",
            ) ?? null,
          "persistent approval evidence",
        );
        assert.match(allowed.rule, /^policy\.default$/u);

        await submitUserBashWhenIdle(
          first,
          "!touch cancelled-rule.txt",
          "cancelled persistent approval",
        );
        const cancelMark = first.output().length;
        first.child.stdin.write("p");
        await waitForOutputAfter(
          first,
          cancelMark,
          "Persistent rule preview",
          "cancelled persistent approval confirmation",
        );
        const backMark = first.output().length;
        first.child.stdin.write("\u001b");
        await waitForOutputAfter(
          first,
          backMark,
          "esc cancel",
          "approval card after leaving preview",
        );
        first.child.stdin.write("\u001b");
        await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (record) =>
                record.command === "touch cancelled-rule.txt" &&
                record.decision === "deny",
            ) ?? null,
          "cancelled persistent approval evidence",
        );
        assert.equal(
          await fs
            .stat(path.join(project, "cancelled-rule.txt"))
            .catch(() => null),
          null,
        );

        const configPath = path.join(home, "config.toml");
        const config = await waitFor(async () => {
          try {
            const text = await fs.readFile(configPath, "utf8");
            return /profile = "scoped"/u.test(text) ? text : null;
          } catch {
            return null;
          }
        }, "scoped autonomy config");
        const rulesPath = /scoped_rules = "(.*)"/u.exec(config)?.[1];
        assert.ok(rulesPath);
        const rules = await fs.readFile(rulesPath, "utf8");
        assert.match(rules, /argv = \["touch", "persisted-exact\.txt"\]/u);
        assert.doesNotMatch(rules, /cancelled-rule/u);
        await assertPrivateFile(rulesPath);
        // Forcing "ask" must not silently drop the stored scoped rules.
        const askMark = first.output().length;
        first.child.stdin.write("/permissions autonomy ask\r");
        await waitForOutputAfter(
          first,
          askMark,
          "autonomy set to ask",
          "ask autonomy profile",
        );
        const askConfig = await fs.readFile(configPath, "utf8");
        assert.match(askConfig, /profile = "ask"/u);
        assert.match(askConfig, /scoped_rules = "/u);
        const rulesMark = first.output().length;
        first.child.stdin.write("/permissions rules\r");
        await waitForOutputAfter(
          first,
          rulesMark,
          "Scoped rules: 1 (profile ask)",
          "scoped rules command",
        );
        assert.match(
          first.output().slice(rulesMark),
          /touch persisted-exact\.txt/u,
        );
        assert.match(first.output().slice(rulesMark), /ARGV/u);
        assert.match(first.output().slice(rulesMark), /HASH/u);
        assert.match(first.output().slice(rulesMark), /esc close/u);
        await closeOverlay(first);
        const restoreMark = first.output().length;
        first.child.stdin.write("/permissions autonomy scoped\r");
        await waitForOutputAfter(
          first,
          restoreMark,
          "autonomy set to scoped",
          "scoped autonomy profile",
        );
        await waitForQuiet(first, 250);
        first.child.stdin.write("/quit\r");
        const exited = await Promise.race([
          first.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(
          exited,
          { code: 0, signal: null },
          stripAnsi(first.output()).slice(-4_000),
        );
      } finally {
        await stopPty(first);
      }

      await fs.unlink(path.join(project, "persisted-exact.txt"));
      const second = startPty(process.execPath, [cli], { cwd: project, env });
      try {
        await waitForOutput(second, "codepunk · auto/auto", "second startup");
        const mark = second.output().length;
        second.child.stdin.write("!touch persisted-exact.txt\r");
        try {
          await waitFor(
            () =>
              fs
                .stat(path.join(project, "persisted-exact.txt"))
                .then(() => true)
                .catch(() => null),
            "persisted rule execution",
          );
        } catch (error) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n${second.output().slice(-4000)}`,
          );
        }
        assert.doesNotMatch(second.output().slice(mark), /Approval required/u);
        const reused = await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (record) =>
                record.command === "touch persisted-exact.txt" &&
                record.decision === "allow" &&
                record.approval === null &&
                record.rule.startsWith("scoped.approval-"),
            ) ?? null,
          "persisted rule evidence",
        );
        assert.equal(reused.autonomy.profile, "scoped");
        await waitForBashResult(home, "touch persisted-exact.txt", 2);
        await waitForQuiet(second, 250);
        second.child.stdin.write("/quit\r");
        const exited = await Promise.race([
          second.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(
          exited,
          { code: 0, signal: null },
          stripAnsi(second.output()).slice(-4_000),
        );
      } finally {
        await stopPty(second);
      }
    });
  },
);

test("the editor disables ! before user_bash when plugins are on", async () => {
  await withTempDirectory("codepunk-tui-plugins-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli, "--allow-plugins"], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await waitForOutput(
        session,
        "Plugins are trusted in-process code",
        "plugin trust warning",
      );
      const mark = session.output().length;
      session.child.stdin.write("!touch blocked.txt\r");
      await waitForOutputAfter(
        session,
        mark,
        "! is disabled while Pi plugins are enabled",
        "plugin shell interception",
      );
      assert.doesNotMatch(session.output().slice(mark), /Approval required/u);
      assert.equal(
        await fs.stat(path.join(project, "blocked.txt")).catch(() => null),
        null,
      );
      const configBefore = await fs.readFile(
        path.join(home, "config.toml"),
        "utf8",
      );
      await runCommandAfter(
        session,
        "/permissions autonomy read-only",
        "cannot switch to read-only while user plugins",
      );
      assert.equal(
        await fs.readFile(path.join(home, "config.toml"), "utf8"),
        configBefore,
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test(
  "read-only live switch refuses an already-writable srt profile",
  {
    skip:
      process.platform === "win32"
        ? "the fixture uses POSIX shell syntax"
        : false,
  },
  async () => {
    await withTempDirectory("codepunk-tui-readonly-srt-", async (root) => {
      const project = path.join(root, "project");
      await fs.mkdir(project);
      await execFileAsync("git", ["init", "-q"], { cwd: project });
      const home = path.join(root, "home");
      await fs.mkdir(home);
      await fs.writeFile(
        path.join(home, "models.json"),
        JSON.stringify({
          providers: {
            test: {
              name: "Test",
              baseUrl: "http://127.0.0.1:1/v1",
              api: "openai-completions",
              apiKey: "test",
              models: [
                {
                  id: "fake",
                  name: "Fake model",
                  reasoning: false,
                  contextWindow: 128000,
                  maxTokens: 1024,
                },
              ],
            },
          },
        }),
      );
      const cli = await ensureBuilt();
      const environment = {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      };
      await execFileAsync(
        process.execPath,
        [cli, "models", "set", "test/fake"],
        {
          cwd: project,
          env: environment,
        },
      );
      const session = startPty(process.execPath, [cli], {
        cwd: project,
        env: environment,
      });
      try {
        await waitForOutput(session, "shell srt", "writable srt startup");
        const configBefore = await fs.readFile(
          path.join(home, "config.toml"),
          "utf8",
        );
        await runCommandAfter(
          session,
          "/permissions autonomy read-only",
          "cannot switch to read-only while srt workspace write grants",
        );
        assert.equal(
          await fs.readFile(path.join(home, "config.toml"), "utf8"),
          configBefore,
        );
        session.child.stdin.write("/quit\r");
        const result = await Promise.race([
          session.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(result, { code: 0, signal: null });
      } finally {
        await stopPty(session);
      }
    });
  },
);

test(
  "read-only live switch refuses widening a read-only srt profile",
  {
    skip:
      process.platform === "win32"
        ? "the fixture uses POSIX shell syntax"
        : false,
  },
  async () => {
    await withTempDirectory("codepunk-tui-readonly-widen-", async (root) => {
      const project = path.join(root, "project");
      await fs.mkdir(project);
      await execFileAsync("git", ["init", "-q"], { cwd: project });
      const home = path.join(root, "home");
      await fs.mkdir(home);
      await fs.writeFile(
        path.join(home, "models.json"),
        JSON.stringify({
          providers: {
            test: {
              name: "Test",
              baseUrl: "http://127.0.0.1:1/v1",
              api: "openai-completions",
              apiKey: "test",
              models: [
                {
                  id: "fake",
                  name: "Fake model",
                  reasoning: false,
                  contextWindow: 128000,
                  maxTokens: 1024,
                },
              ],
            },
          },
        }),
      );
      const cli = await ensureBuilt();
      const environment = {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      };
      await execFileAsync(
        process.execPath,
        [cli, "models", "set", "test/fake"],
        {
          cwd: project,
          env: environment,
        },
      );
      const session = startPty(
        process.execPath,
        [cli, "--permission-mode", "read-only"],
        {
          cwd: project,
          env: environment,
        },
      );
      try {
        await waitForOutput(session, "shell srt", "read-only srt startup");
        const configBefore = await fs.readFile(
          path.join(home, "config.toml"),
          "utf8",
        );
        await runCommandAfter(
          session,
          "/permissions autonomy ask",
          "cannot switch from read-only to ask while the srt sandbox was started read-only",
        );
        assert.equal(
          await fs.readFile(path.join(home, "config.toml"), "utf8"),
          configBefore,
        );
        session.child.stdin.write("/quit\r");
        const result = await Promise.race([
          session.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(result, { code: 0, signal: null });
      } finally {
        await stopPty(session);
      }
    });
  },
);
