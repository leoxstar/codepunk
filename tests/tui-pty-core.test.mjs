import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import {
  ensureBuilt,
  REPO_ROOT,
  trustWorkspace,
  withTempDirectory,
} from "./support/helpers.mjs";
import {
  BASE_ENV,
  IMAGE_PNG_BASE64,
  SRT_PTY_SKIP,
  closeOverlay,
  core,
  execFileAsync,
  readEvidence,
  runCommandAfter,
  startPlanRoundModelServer,
  startPty,
  startReviewModelServer,
  startTextModelServer,
  startToolProjectionModelServer,
  startWriteModelServer,
  stopPty,
  stripAnsi,
  waitFor,
  waitForOutput,
  waitForOutputAfter,
  waitForQuiet,
} from "./support/tui-pty.mjs";

test("a real pty renders codepunk chrome and exit hints", async () => {
  await withTempDirectory("codepunk-tui-", async (root) => {
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
      await waitForQuiet(session, 250);
      const output = stripAnsi(session.output());
      assert.match(output, /codepunk · auto\/auto · session [0-9A-Z]{10}/u);
      assert.match(
        output,
        /permissions custom · trust trusted · shell disabled · evidence 0/u,
      );
      assert.match(output, /session [0-9A-Z]{10}/u);
      assert.doesNotMatch(output, /project [0-9a-f]{16}/u);
      assert.doesNotMatch(output, /next sandbox uncovered · fs workspace/u);
      assert.doesNotMatch(output, /v1\.5\.2/u);
      session.child.stdin.write("/quit\r");
      const exited = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(exited, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test(
  "a real pty remains interactive while the srt sandbox prepares",
  { skip: SRT_PTY_SKIP },
  async () => {
    await withTempDirectory("codepunk-tui-srt-preparing-", async (root) => {
      const project = path.join(root, "project");
      const home = path.join(root, "home");
      await fs.mkdir(project);
      await fs.mkdir(home);
      await fs.writeFile(
        path.join(home, "config.toml"),
        '[sandbox]\nmode = "required"\n',
      );
      await execFileAsync("git", ["init", "-q"], { cwd: project });
      const cli = await ensureBuilt();
      const sandboxMarker = path.join(home, "sandbox-ready");
      const session = startPty(
        process.execPath,
        [
          "--import",
          path.join(REPO_ROOT, "tests", "support", "slow-sandbox.mjs"),
          cli,
        ],
        {
          cwd: project,
          env: {
            ...BASE_ENV,
            CODEPUNK_HOME: home,
            CODEPUNK_TEST_SANDBOX_MARKER: sandboxMarker,
            TERM: "xterm-256color",
            NO_COLOR: "1",
          },
        },
      );
      try {
        await waitForOutput(
          session,
          "srt sandbox preparing; shell tools will wait until it is ready",
          "sandbox preparing",
        );
        assert.notEqual(
          await fs.readFile(sandboxMarker, "utf8").catch(() => null),
          "ready",
          "the sandbox finished before the preparing status was rendered",
        );

        const mark = session.output().length;
        session.child.stdin.write("/help\r");
        await waitForOutputAfter(
          session,
          mark,
          "Codepunk help",
          "interactive /help",
        );
        await closeOverlay(session);
        await waitForOutput(session, "shell srt ·", "sandbox ready status");

        const markerStarted = Date.now();
        while (
          Date.now() - markerStarted < 20_000 &&
          (await fs.readFile(sandboxMarker, "utf8").catch(() => null)) !==
            "ready"
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(
          await fs.readFile(sandboxMarker, "utf8").catch(() => null),
          "ready",
          "the sandbox never reported readiness",
        );

        session.child.stdin.write("/quit\r");
        const exited = await Promise.race([
          session.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(exited, { code: 0, signal: null });
      } finally {
        await stopPty(session);
      }
    });
  },
);

test("a real pty shows the working tree diff", async () => {
  await withTempDirectory("codepunk-tui-diff-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: project,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], {
      cwd: project,
    });
    await fs.writeFile(path.join(project, "tracked.txt"), "one\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: project });
    await execFileAsync("git", ["commit", "-q", "-m", "initial"], {
      cwd: project,
    });
    await fs.writeFile(path.join(project, "tracked.txt"), "two\n");
    await fs.writeFile(path.join(project, "new.txt"), "new\n");
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
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
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const diffMark = session.output().length;
      await runCommandAfter(session, "/diff", "Working tree diff");
      const output = session.output().slice(diffMark);
      assert.match(output, /M tracked\.txt/u);
      assert.match(output, /\?\? new\.txt/u);
      assert.match(output, /\+two/u);
      assert.match(output, /-one/u);
      assert.match(output, /untracked files \(1; no patch until staged\)/u);
      assert.match(output, /internal \.codepunk\/ file\(s\) omitted/u);
      assert.match(output, /esc close/u);
      assert.match(output, /│/u);
      await closeOverlay(session);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
      // Commands alone are not a conversation, so no resume hint is printed.
      assert.doesNotMatch(
        stripAnsi(session.output()),
        /To resume this session/u,
      );
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty explains /diff outside a Git worktree", async () => {
  await withTempDirectory("codepunk-tui-diff-nongit-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
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
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await runCommandAfter(session, "/diff", "Not a Git worktree");
      assert.match(
        stripAnsi(session.output()),
        /Not a Git worktree; \/diff needs a Git repository/u,
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

test("a real pty covers the plan mode command surface", async () => {
  await withTempDirectory("codepunk-tui-plan-mode-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
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
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await runCommandAfter(session, "/plan status", "Plan mode: off");
      await runCommandAfter(session, "/plan on", "Plan mode: planning");
      await runCommandAfter(
        session,
        "/plan approve",
        "/plan failed: No plan to approve",
      );
      await runCommandAfter(session, "/plan off", "Plan mode: off");
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

test("a real pty plans a requested task in plan mode", async () => {
  await withTempDirectory("codepunk-tui-plan-request-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const model = await startPlanRoundModelServer();
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      await runCommandAfter(
        session,
        "/plan add a health check",
        "Plan mode: planning",
      );
      await waitForOutput(session, "PLAN_RECORDED", "plan request");
      const planOutput = stripAnsi(session.output());
      assert.match(
        planOutput,
        /plan · 2 steps · in progress: inspect the repository/u,
      );
      assert.match(planOutput, /plan · 2 steps · sha [0-9a-f]{12}…/u);
      await runCommandAfter(session, "/plan", "[>] inspect the repository");
      session.child.stdin.write("\u001b");
      await waitForQuiet(session, 250);
      await runCommandAfter(session, "/plan status", "Plan mode: planning");

      const sent = JSON.stringify(model.requests[0]);
      assert.match(sent, /add a health check/u);
      assert.match(sent, /plan tool/u);

      const eventFiles = (await fs.readdir(home, { recursive: true })).filter(
        (entry) => entry.endsWith("session.jsonl"),
      );
      assert.equal(eventFiles.length, 1);
      const events = (await fs.readFile(path.join(home, eventFiles[0]), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      const planEvents = events.filter((entry) => entry.kind === "plan/update");
      assert.equal(planEvents.length, 1);
      assert.deepEqual(
        planEvents[0].data.steps.map((step) => step.step),
        ["inspect the repository", "implement the health check"],
      );
      assert.equal(
        events.filter((entry) => entry.kind === "plan_mode/update").at(-1).data
          .mode,
        "planning",
      );

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
      // A session with a conversation ends with Codepunk's resume command,
      // written after Pi has restored the terminal.
      assert.ok(
        events.some((entry) => entry.kind === "user/input"),
        "the plan request records a conversation",
      );
      const sessionId = path.basename(path.dirname(eventFiles[0]));
      assert.match(
        stripAnsi(session.output()),
        new RegExp(`To resume this session: codepunk resume ${sessionId}`, "u"),
      );
    } finally {
      await stopPty(session);
      model.server.closeAllConnections?.();
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test("a real pty covers Goal, hooks, and structured review events", async () => {
  await withTempDirectory("codepunk-tui-p0-capabilities-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: project,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], {
      cwd: project,
    });
    await fs.writeFile(path.join(project, "tracked.txt"), "one\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: project });
    await execFileAsync("git", ["commit", "-q", "-m", "initial"], {
      cwd: project,
    });
    await fs.writeFile(path.join(project, "tracked.txt"), "two\n");

    const model = await startReviewModelServer([
      JSON.stringify({
        findings: [
          {
            severity: "high",
            file: "tracked.txt",
            line: 1,
            reason: "the changed value loses the original state",
          },
        ],
      }),
      "REVIEW_FAILED_NOT_JSON",
    ]);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(home, "hooks.toml"),
      [
        "version = 1",
        "[[hooks]]",
        'name = "startup"',
        'event = "session_start"',
        `argv = ${JSON.stringify([process.execPath, "-e", "process.exit(0)"])}`,
        "timeout_ms = 5000",
        "max_output_bytes = 1024",
        "fail_closed = true",
        "",
      ].join("\n"),
    );

    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      await runCommandAfter(
        session,
        "/goal Ship the capability wave",
        "Goal: active",
      );
      assert.match(session.output(), /Ship the capability wave/u);
      await runCommandAfter(session, "/goal pause", "Goal: paused");
      await runCommandAfter(session, "/goal resume", "Goal: active");
      await runCommandAfter(session, "/hooks status", "Lifecycle hooks");
      assert.match(session.output(), /user hook startup passed/u);

      await runCommandAfter(session, "/review", "Structured review");
      assert.match(session.output(), /HIGH tracked\.txt:1/u);
      assert.match(session.output(), /loses the original state/u);
      await runCommandAfter(
        session,
        "/review",
        "/review failed: review model did not return a JSON object",
      );
      await runCommandAfter(session, "/goal clear", "No goal is active");

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });

      const eventFiles = (await fs.readdir(home, { recursive: true })).filter(
        (entry) => entry.endsWith("session.jsonl"),
      );
      assert.equal(eventFiles.length, 1);
      const events = (await fs.readFile(path.join(home, eventFiles[0]), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type === "codepunk/event");
      assert.equal(
        events.some(
          (entry) =>
            entry.kind === "goal/update" && entry.data.action === "set",
        ),
        true,
      );
      assert.equal(
        events.some(
          (entry) =>
            entry.kind === "goal/update" && entry.data.action === "clear",
        ),
        true,
      );
      assert.equal(
        events.some(
          (entry) =>
            entry.kind === "hook/result" &&
            entry.data.hook_name === "startup" &&
            entry.data.outcome === "passed",
        ),
        true,
      );
      assert.equal(
        events.some((entry) => entry.kind === "review/result"),
        true,
      );
      assert.equal(
        events.some((entry) => entry.kind === "review/error"),
        true,
      );
    } finally {
      await stopPty(session);
      model.server.closeAllConnections?.();
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test(
  "a real pty lists, reads, and stops durable background tasks",
  {
    skip:
      process.platform === "win32"
        ? "background tasks require POSIX process groups"
        : false,
  },
  async () => {
    await withTempDirectory("codepunk-tui-background-", async (root) => {
      const project = path.join(root, "project");
      const home = path.join(root, "home");
      await fs.mkdir(project);
      await fs.mkdir(home);
      await execFileAsync("git", ["init", "-q"], { cwd: project });
      await fs.writeFile(
        path.join(home, "config.toml"),
        '[sandbox]\nmode = "uncovered"\n',
      );
      const projectId = core.projectIdFor(project);
      const paths = core.projectPaths(
        { cwd: project, deliveryRoot: project, projectId },
        home,
      );
      await core.ensureProjectRegistration(
        {
          cwd: project,
          deliveryRoot: project,
          projectId,
          isGitRepository: true,
        },
        paths,
      );
      const seed = new core.BackgroundTaskManager({
        paths,
        sessionId: "seed-session",
      });
      const started = await seed.start({
        id: "tui-background",
        title: "TUI background task",
        command: process.execPath,
        args: ["-e", 'process.stdout.write("BGREADY\\n"); process.exit(0);'],
        cwd: project,
      });
      await seed.wait(started.id);

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
        await waitForOutput(session, "codepunk · auto/auto", "startup");
        await runCommandAfter(session, "/ps", "tui-background");
        await runCommandAfter(session, "/logs tui-background", "stdout:");
        assert.match(session.output(), /BGREADY/u);
        await runCommandAfter(
          session,
          "/stop tui-background",
          "Background task tui-background: completed",
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

test("a real pty lists presets and roles and applies a preset", async () => {
  await withTempDirectory("codepunk-tui-p1-commands-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const model = await startReviewModelServer(["not json"]);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
                input: ["text", "image"],
              },
            ],
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(home, "presets.toml"),
      [
        "version = 1",
        "[[preset]]",
        'name = "reader"',
        'description = "Read-only review"',
        'model = "local/local-test"',
        'thinking = "low"',
        'permission = "read-only"',
        'tools = ["read", "search"]',
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(home, "roles.toml"),
      [
        "version = 1",
        "[roles]",
        'plan = "local/local-test"',
        "",
        "[[pool]]",
        'name = "subagent"',
        'models = ["local/local-test"]',
        "max = 1",
        "",
      ].join("\n"),
    );

    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      await runCommandAfter(session, "/roles status", "Model roles");
      assert.match(session.output(), /plan: local\/local-test \(user\)/u);
      assert.match(session.output(), /subagent: max 1/u);
      await runCommandAfter(session, "/preset list", "reader");
      assert.match(session.output(), /Read-only review/u);
      await runCommandAfter(session, "/preset use reader", "preset reader");
      assert.match(session.output(), /permission read-only/u);
      assert.match(session.output(), /tools read,search/u);
      await runCommandAfter(session, "/recap all", "Session recap");
      assert.match(session.output(), /autonomy\/profile: 1/u);
      assert.match(session.output(), /trust\/decision: 1/u);
      if (process.platform !== "win32") {
        await runCommandAfter(
          session,
          "/btw summarize the current state",
          "btw task queued",
        );
        await runCommandAfter(session, "/ps", "Side tasks");
        assert.match(session.output(), /btw\s+budget=1/u);
        await waitFor(async () => {
          const files = (
            await fs.readdir(path.join(home, "projects"), { recursive: true })
          ).filter((entry) => entry.endsWith(".jsonl"));
          const sideFile = files.find((entry) =>
            entry.includes("product/side-tasks"),
          );
          if (sideFile === undefined) {
            return false;
          }
          const lines = (
            await fs.readFile(path.join(home, "projects", sideFile), "utf8")
          )
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          return lines.some(
            (entry) =>
              entry.type === "codepunk/side-task" &&
              (entry.status === "completed" || entry.status === "failed"),
          );
        }, "side task settlement");
      }
      const imagePath = path.join(project, "pixel.png");
      await fs.writeFile(imagePath, Buffer.from(IMAGE_PNG_BASE64, "base64"));
      await runCommandAfter(
        session,
        "/image pixel.png what is in this image",
        "image confirmed",
      );
      assert.match(session.output(), /type: image\/png/u);
      await waitFor(
        () =>
          model.requests.some((request) =>
            JSON.stringify(request).includes(
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAANCAI",
            ),
          ),
        "image request",
      );
      const imageRecord = await waitFor(
        async () =>
          (await readEvidence(home)).find(
            (record) =>
              record.tool === "image_input" &&
              record.path_check.target === "pixel.png",
          ) ?? null,
        "image input evidence",
      );
      assert.equal(imageRecord.decision, "allow");
      assert.equal(
        imageRecord.output_sha256,
        `sha256:${createHash("sha256")
          .update(Buffer.from(IMAGE_PNG_BASE64, "base64"))
          .digest("hex")}`,
      );
      assert.match(
        imageRecord.output_preview,
        /bytes: 687\nsha256: sha256:[0-9a-f]{64}\nredactions: path/u,
      );
      await waitForQuiet(session, 500);
      const requestsBeforeMissingImage = model.requests.length;
      await runCommandAfter(
        session,
        "/image missing.png",
        "image input was not found",
      );
      const failedImageRecord = await waitFor(
        async () =>
          (await readEvidence(home)).find(
            (record) =>
              record.tool === "image_input" &&
              record.outcome === "failed" &&
              record.rule === "product.image.input_failed" &&
              record.path_check.target === "missing.png",
          ) ?? null,
        "failed image input evidence",
      );
      assert.equal(failedImageRecord.decision, "allow");
      assert.equal(failedImageRecord.exit_code, 1);
      assert.equal(failedImageRecord.effects.fs, "none");
      assert.equal(failedImageRecord.effects.network, false);
      assert.equal(model.requests.length, requestsBeforeMissingImage);
      await runCommandAfter(
        session,
        "/image-gen a red fox in snow",
        "no image generation adapter is configured",
      );
      const rejectedImageGeneration = await waitFor(
        async () =>
          (await readEvidence(home)).find(
            (record) =>
              record.tool === "image_generate" &&
              record.decision === "deny" &&
              record.rule === "product.image.generate_denied",
          ) ?? null,
        "rejected image generation evidence",
      );
      assert.equal(rejectedImageGeneration.outcome, "denied");
      assert.equal(rejectedImageGeneration.approval, null);
      assert.match(
        rejectedImageGeneration.output_preview,
        /no image generation adapter is configured/u,
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
      model.server.closeAllConnections?.();
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test("a real pty generates an image through a configured image model", async () => {
  await withTempDirectory("codepunk-tui-image-gen-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const model = await startReviewModelServer(["not json"], {
      imageBase64: IMAGE_PNG_BASE64,
    });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
                input: ["text"],
              },
            ],
          },
          openrouter: {
            name: "OpenRouter",
            baseUrl: model.baseUrl,
            apiKey: "test",
          },
        },
      }),
    );

    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      const mark = session.output().length;
      const command =
        "/image-gen --model openrouter/black-forest-labs/flux.2-pro a red fox in snow";
      session.child.stdin.write(`${command}\r`);
      await waitForOutputAfter(
        session,
        mark,
        "Approval required",
        "image generation approval prompt",
      );
      assert.match(
        stripAnsi(session.output().slice(mark)),
        /command: image-generate openrouter\/black-forest-labs\/flux\.2-pro/u,
      );
      session.child.stdin.write("a");
      await waitForOutputAfter(
        session,
        mark,
        "image generated:",
        "image generation result",
      );

      const record = await waitFor(
        async () =>
          (await readEvidence(home)).find(
            (entry) =>
              entry.tool === "image_generate" &&
              entry.command ===
                "image-generate openrouter/black-forest-labs/flux.2-pro",
          ) ?? null,
        "image generation evidence",
      );
      assert.equal(record.decision, "allow");
      assert.equal(record.outcome, "completed");
      assert.notEqual(record.approval, null);
      assert.equal(record.approval.answer, "allow");
      assert.match(record.output_sha256, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(record.after_sha256, record.output_sha256);
      assert.equal(record.effects.network, true);
      assert.equal(record.effects.fs, "write");
      assert.match(
        record.output_ref,
        /^artifacts\/images\/[0-9a-f]{24}\.png$/u,
      );

      const artifactEntry = (await fs.readdir(home, { recursive: true })).find(
        (entry) => entry.split(path.sep).join("/").endsWith(record.output_ref),
      );
      assert.ok(artifactEntry, "generated artifact is missing");
      const bytes = await fs.readFile(path.join(home, artifactEntry));
      assert.equal(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        record.output_sha256,
      );
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.ok(
        model.requests.some(
          (request) =>
            Array.isArray(request.modalities) &&
            request.modalities.includes("image") &&
            JSON.stringify(request).includes("a red fox in snow"),
        ),
        "image generation request is missing",
      );

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });

      const imageRequestsBeforeScope = model.requests.filter(
        (request) =>
          Array.isArray(request.modalities) &&
          request.modalities.includes("image"),
      ).length;
      await fs.writeFile(
        path.join(home, "config.toml"),
        [
          "[sandbox]",
          'mode = "uncovered"',
          "",
          "[model]",
          'enabled = ["local/local-test"]',
          "",
        ].join("\n"),
      );
      const scoped = startPty(
        process.execPath,
        [cli, "--model", "local/local-test"],
        {
          cwd: project,
          env: {
            ...BASE_ENV,
            CODEPUNK_HOME: home,
            PI_OFFLINE: "1",
            TERM: "xterm-256color",
            NO_COLOR: "1",
          },
        },
      );
      try {
        await waitForOutput(
          scoped,
          "codepunk · local/local-test",
          "scoped startup",
        );
        await runCommandAfter(
          scoped,
          "/image-gen --model openrouter/black-forest-labs/flux.2-pro a blocked fox",
          "model.enabled",
        );
        const denied = await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (entry) =>
                entry.tool === "image_generate" &&
                entry.decision === "deny" &&
                entry.rule === "product.image.generate_denied" &&
                entry.command ===
                  "image-generate openrouter/black-forest-labs/flux.2-pro",
            ) ?? null,
          "image generation scope denial",
        );
        assert.equal(denied.outcome, "denied");
        assert.match(denied.output_preview, /model\.enabled/u);
        assert.equal(
          model.requests.filter(
            (request) =>
              Array.isArray(request.modalities) &&
              request.modalities.includes("image"),
          ).length,
          imageRequestsBeforeScope,
        );
        scoped.child.stdin.write("/quit\r");
        const scopedResult = await Promise.race([
          scoped.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(scopedResult, { code: 0, signal: null });
      } finally {
        await stopPty(scoped);
      }

      await fs.writeFile(
        path.join(home, "config.toml"),
        [
          "[sandbox]",
          'mode = "uncovered"',
          "",
          "[model]",
          'enabled = ["local/local-test", "openrouter/**"]',
          "",
        ].join("\n"),
      );
      const wildcard = startPty(
        process.execPath,
        [cli, "--model", "local/local-test"],
        {
          cwd: project,
          env: {
            ...BASE_ENV,
            CODEPUNK_HOME: home,
            PI_OFFLINE: "1",
            TERM: "xterm-256color",
            NO_COLOR: "1",
          },
        },
      );
      try {
        await waitForOutput(
          wildcard,
          "codepunk · local/local-test",
          "wildcard scoped startup",
        );
        const evidenceBefore = (await readEvidence(home)).filter(
          (entry) =>
            entry.tool === "image_generate" &&
            entry.outcome === "completed" &&
            entry.command ===
              "image-generate openrouter/black-forest-labs/flux.2-pro",
        ).length;
        const mark = wildcard.output().length;
        wildcard.child.stdin.write(
          "/image-gen --model openrouter/black-forest-labs/flux.2-pro a wildcard fox\r",
        );
        await waitForOutputAfter(
          wildcard,
          mark,
          "Approval required",
          "wildcard-scoped image generation approval prompt",
        );
        wildcard.child.stdin.write("a");
        await waitForOutputAfter(
          wildcard,
          mark,
          "image generated:",
          "wildcard-scoped image generation result",
        );
        await waitFor(
          async () =>
            (await readEvidence(home)).filter(
              (entry) =>
                entry.tool === "image_generate" &&
                entry.outcome === "completed" &&
                entry.command ===
                  "image-generate openrouter/black-forest-labs/flux.2-pro",
            ).length > evidenceBefore,
          "wildcard-scoped image generation evidence",
        );
        wildcard.child.stdin.write("/quit\r");
        const wildcardResult = await Promise.race([
          wildcard.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(wildcardResult, { code: 0, signal: null });
      } finally {
        await stopPty(wildcard);
      }
    } finally {
      await stopPty(session);
      model.server.closeAllConnections?.();
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test("a real pty records a failed image input when dispatch is rejected", async () => {
  await withTempDirectory(
    "codepunk-tui-image-dispatch-failure-",
    async (root) => {
      const project = path.join(root, "project");
      const home = path.join(root, "home");
      await fs.mkdir(project);
      await fs.mkdir(home);
      await execFileAsync("git", ["init", "-q"], { cwd: project });
      let requestSeen;
      const firstRequest = new Promise((resolve) => {
        requestSeen = resolve;
      });
      const server = http.createServer((request, _response) => {
        request.resume();
        request.on("end", () => {
          requestSeen();
        });
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address);
      await fs.writeFile(
        path.join(home, "config.toml"),
        '[sandbox]\nmode = "uncovered"\n',
      );
      await fs.writeFile(
        path.join(home, "models.json"),
        JSON.stringify({
          providers: {
            local: {
              name: "Local",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              api: "openai-completions",
              apiKey: "test",
              models: [
                {
                  id: "local-test",
                  name: "Local Test",
                  api: "openai-completions",
                  contextWindow: 128000,
                  maxTokens: 1024,
                  input: ["text", "image"],
                },
              ],
            },
          },
        }),
      );

      const cli = await ensureBuilt();
      const session = startPty(
        process.execPath,
        [cli, "--model", "local/local-test"],
        {
          cwd: project,
          env: {
            ...BASE_ENV,
            CODEPUNK_HOME: home,
            PI_OFFLINE: "1",
            TERM: "xterm-256color",
            NO_COLOR: "1",
          },
        },
      );
      try {
        await waitForOutput(session, "codepunk · local/local-test", "startup");
        await fs.writeFile(
          path.join(project, "pixel.png"),
          Buffer.from(IMAGE_PNG_BASE64, "base64"),
        );
        session.child.stdin.write("hold the current request\r");
        await firstRequest;
        const mark = session.output().length;
        session.child.stdin.write("/image pixel.png rejected prompt\r");
        await waitForOutputAfter(
          session,
          mark,
          "image confirmed",
          "image confirmation",
        );
        await waitForOutputAfter(
          session,
          mark,
          "/image failed",
          "image dispatch failure",
        );
        const record = await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (entry) =>
                entry.tool === "image_input" &&
                entry.path_check.target === "pixel.png",
            ) ?? null,
          "failed image input evidence",
        );
        assert.equal(record.decision, "allow");
        assert.equal(record.outcome, "failed");
        assert.equal(record.rule, "product.image.input_failed");
        assert.equal(record.exit_code, 1);
        assert.equal(record.effects.network, false);
        assert.match(record.output_preview, /already processing/u);
      } finally {
        await stopPty(session);
        server.closeAllConnections();
        server.close();
      }
    },
  );
});

test("a real pty undoes and redoes Codepunk file changes", async (t) => {
  if (process.platform === "win32") {
    t.skip(
      "hosted Windows ConPTY /undo timing is not reliable; real Windows 11 acceptance is required",
    );
    return;
  }
  await withTempDirectory("codepunk-tui-undo-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(path.join(project, "note.txt"), "before\n");
    const model = await startWriteModelServer({
      path: "note.txt",
      content: "after\n",
    });
    await fs.writeFile(
      path.join(home, "config.toml"),
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[approval]",
        'mode = "allow"',
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      session.child.stdin.write("write note.txt\r");
      await waitForOutput(session, "WRITE_DONE", "model write");
      assert.equal(
        await fs.readFile(path.join(project, "note.txt"), "utf8"),
        "after\n",
      );

      await runCommandAfter(session, "/undo", "Undo file changes?");
      session.child.stdin.write("\r");
      await waitForOutput(session, "undo: 1 file checkpoint(s) restored");
      assert.equal(
        await fs.readFile(path.join(project, "note.txt"), "utf8"),
        "before\n",
      );

      await runCommandAfter(session, "/redo", "Redo file changes?");
      session.child.stdin.write("\r");
      await waitForOutput(session, "redo: 1 file checkpoint(s) restored");
      assert.equal(
        await fs.readFile(path.join(project, "note.txt"), "utf8"),
        "after\n",
      );

      const eventFiles = (await fs.readdir(home, { recursive: true })).filter(
        (entry) => entry.endsWith("session.jsonl"),
      );
      assert.equal(eventFiles.length, 1);
      const events = (await fs.readFile(path.join(home, eventFiles[0]), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      const restores = events.filter(
        (entry) => entry.kind === "checkpoint/restore",
      );
      assert.deepEqual(
        restores.map((entry) => entry.data.action),
        ["undo", "redo"],
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
      model.server.closeAllConnections?.();
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test("a real pty signs a settled run with an explicit verdict", async () => {
  await withTempDirectory("codepunk-tui-sign-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(path.join(project, "note.txt"), "before\n");
    const model = await startWriteModelServer({
      path: "note.txt",
      content: "after\n",
    });
    await fs.writeFile(
      path.join(home, "config.toml"),
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[approval]",
        'mode = "allow"',
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      await runCommandAfter(
        session,
        "/sign maybe",
        "usage: /sign [complete|incomplete]",
      );
      session.child.stdin.write("write note.txt\r");
      await waitForOutput(session, "WRITE_DONE", "model write");

      await runCommandAfter(session, "/sign", "Sign as incomplete");
      session.child.stdin.write("\u001b[B\r");
      await waitForOutput(session, "verdict incomplete ·", "incomplete sign");

      const eventFiles = (await fs.readdir(home, { recursive: true })).filter(
        (entry) => entry.endsWith("session.jsonl"),
      );
      assert.equal(eventFiles.length, 1);
      const events = (await fs.readFile(path.join(home, eventFiles[0]), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      const signOff = events.find((entry) => entry.kind === "verdict/sign_off");
      assert.ok(signOff);
      assert.equal(signOff.data.signed_verdict, "incomplete");
      assert.equal(signOff.data.channel, "tui");

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
      model.server.closeAllConnections?.();
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test("a real pty creates a human-confirmed commit and records it", async () => {
  await withTempDirectory("codepunk-tui-commit-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: project,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], {
      cwd: project,
    });
    await fs.writeFile(path.join(project, "tracked.txt"), "one\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: project });
    await execFileAsync("git", ["commit", "-q", "-m", "initial"], {
      cwd: project,
    });
    await fs.writeFile(path.join(project, "tracked.txt"), "two\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
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
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await runCommandAfter(
        session,
        "/commit update tracked file",
        "Commit scope",
      );
      const scopeMark = session.output().length;
      session.child.stdin.write("\r");
      await waitForOutputAfter(
        session,
        scopeMark,
        "Create this commit?",
        "commit confirmation",
      );
      const confirmMark = session.output().length;
      session.child.stdin.write("\r");
      await waitForOutputAfter(
        session,
        confirmMark,
        "commit created:",
        "commit result",
      );
      const log = await execFileAsync("git", ["log", "-1", "--pretty=%s"], {
        cwd: project,
      });
      assert.equal(log.stdout.trim(), "update tracked file");

      const evidence = await readEvidence(home);
      const commitRecord = evidence.find((record) => record.tool === "commit");
      assert.ok(commitRecord);
      assert.equal(commitRecord.decision, "allow");
      assert.equal(commitRecord.outcome, "completed");
      assert.equal(commitRecord.executor, "codepunk-commit");
      assert.match(commitRecord.vcs.commit, /^[0-9a-f]{40,64}$/u);

      const eventFiles = (await fs.readdir(home, { recursive: true })).filter(
        (entry) => entry.endsWith("session.jsonl"),
      );
      assert.equal(eventFiles.length, 1);
      const events = (await fs.readFile(path.join(home, eventFiles[0]), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      const commitEvent = events.find(
        (entry) => entry.kind === "commit/created",
      );
      assert.ok(commitEvent);
      assert.equal(commitEvent.data.files.length, 1);
      assert.equal(commitEvent.data.files[0], "tracked.txt");

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

test("a real pty manages MCP auth without leaving the TUI", async () => {
  await withTempDirectory("codepunk-tui-mcp-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
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
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await runCommandAfter(
        session,
        "/mcp status",
        "no user MCP servers configured",
      );
      await fs.writeFile(
        path.join(home, "mcp.toml"),
        [
          "[servers.alpha]",
          'url = "https://alpha.example.invalid/mcp"',
          "",
          "[servers.beta]",
          'url = "https://beta.example.invalid/mcp"',
          "",
        ].join("\n"),
      );
      const logoutMark = session.output().length;
      session.child.stdin.write("/mcp logout\r");
      await waitForOutputAfter(
        session,
        logoutMark,
        "MCP server to sign out",
        "/mcp logout selector",
      );
      assert.match(
        stripAnsi(session.output().slice(logoutMark)),
        /\u2192 alpha/u,
      );
      assert.match(stripAnsi(session.output().slice(logoutMark)), /beta/u);
      session.child.stdin.write("\u001b[B\r");
      await waitForOutputAfter(
        session,
        logoutMark,
        "beta: no stored credentials",
        "/mcp logout completion",
      );
      await fs.rm(path.join(home, "mcp.toml"));
      await runCommandAfter(
        session,
        "/mcp login",
        "MCP sign-in failed: mcp login requires an HTTP server",
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

test("a real pty adds and removes an MCP server without editing TOML", async () => {
  await withTempDirectory("codepunk-tui-mcp-edit-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
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
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await runCommandAfter(session, "/mcp add echo", "MCP transport");
      session.child.stdin.write("\r");
      await waitForOutput(session, "Command and arguments", "stdio command");
      session.child.stdin.write('node -e "process.exit(0)"\r');
      await waitForOutput(
        session,
        "Working directory inside the project",
        "stdio cwd",
      );
      session.child.stdin.write("\r");
      await waitForOutput(session, "MCP server echo saved", "MCP server saved");
      const config = await fs.readFile(path.join(home, "mcp.toml"), "utf8");
      assert.match(config, /\[servers\.echo\]/u);
      assert.match(config, /command = "node"/u);
      assert.match(config, /args = \["-e", "process\.exit\(0\)"\]/u);

      await runCommandAfter(
        session,
        "/mcp remove echo",
        "Remove MCP server echo?",
      );
      session.child.stdin.write("\r");
      await waitForOutput(session, "MCP server echo removed", "MCP removal");
      const after = await fs.readFile(path.join(home, "mcp.toml"), "utf8");
      assert.doesNotMatch(after, /servers\.echo/u);

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

test("a real pty guides first-run model setup without a Pi-only warning", async () => {
  await withTempDirectory("codepunk-tui-no-model-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
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
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const modelMark = session.output().length;
      session.child.stdin.write("/model\r");
      await waitForOutputAfter(
        session,
        modelMark,
        "No authenticated models.",
        "/model without credentials",
      );
      assert.doesNotMatch(
        session.output().slice(modelMark),
        /Pi-only command intercepted/u,
      );

      const promptMark = session.output().length;
      session.child.stdin.write("hello\r");
      await waitForOutputAfter(
        session,
        promptMark,
        "No model configured",
        "first-run prompt gate",
      );
      await waitForOutputAfter(
        session,
        promptMark,
        "escape/ctrl+c cancel",
        "first-run setup selector hint",
      );
      assert.match(
        session.output().slice(promptMark),
        /Sign in to a provider/u,
      );
      const setupOutput = stripAnsi(session.output().slice(promptMark));
      assert.match(setupOutput, /\u2192 Sign in to a provider/u);
      assert.match(
        setupOutput,
        /\u2191\u2193 navigate  enter select  escape\/ctrl\+c cancel/u,
      );
      assert.doesNotMatch(setupOutput, /(?:^|\n)\s*1\. Sign in to a provider/u);
      assert.doesNotMatch(setupOutput, /\[1\/2/u);
      const setupMark = session.output().length;
      session.child.stdin.write("\u001b[B\u001b[B\r");
      await waitForOutputAfter(
        session,
        setupMark,
        "codepunk models import",
        "first-run setup commands",
      );

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

test("a real pty reports status without a configured model", async () => {
  await withTempDirectory("codepunk-tui-status-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
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
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const mark = session.output().length;
      session.child.stdin.write("/status\r");
      await waitForOutputAfter(
        session,
        mark,
        "codepunk status",
        "/status command",
      );
      await waitForOutputAfter(
        session,
        mark,
        "esc close",
        "/status completion",
      );
      const output = stripAnsi(session.output().slice(mark));
      assert.match(output, /project: /u);
      assert.match(output, /model: not selected/u);
      assert.match(output, /permissions: /u);
      assert.match(output, /trust: (trusted|untrusted)(?: \([^)]+\))? · /u);
      assert.match(output, /capabilities: /u);
      assert.match(output, /evidence: /u);
      assert.match(output, /Project/u);
      assert.match(output, /Session/u);
      assert.match(output, /Permissions/u);
      assert.match(output, /esc close/u);
      assert.match(output, /│/u);
      session.child.stdin.write("\u001b");
      await waitForQuiet(session, 250);
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

test("a real pty reloads config in place and preserves state on invalid input", async () => {
  await withTempDirectory("codepunk-tui-config-reload-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const configPath = path.join(home, "config.toml");
    await fs.writeFile(
      configPath,
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[approval]",
        'mode = "ask"',
        "",
        "[autonomy]",
        'profile = "ask"',
        "",
      ].join("\n"),
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--allow-unsandboxed-shell"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await fs.writeFile(
        configPath,
        [
          "[sandbox]",
          'mode = "required"',
          "",
          "[approval]",
          'mode = "deny"',
          "",
          "[autonomy]",
          'profile = "read-only"',
          "",
          "[model]",
          'provider = "next"',
          'id = "next-model"',
          "",
        ].join("\n"),
      );

      const reloadMark = session.output().length;
      await runCommandAfter(session, "/reload", "Codepunk config reloaded.");
      const reloaded = session.output().slice(reloadMark);
      assert.match(
        reloaded,
        /applied now: approval\.mode=deny, autonomy=read-only/u,
      );
      assert.match(reloaded, /next session: model, sandbox/u);
      assert.match(
        reloaded,
        /Plugins are not loaded while autonomy is read-only\./u,
      );
      assert.match(
        reloaded,
        /MCP is not started while autonomy is read-only\./u,
      );

      const permissionsMark = session.output().length;
      await runCommandAfter(session, "/permissions status", "approvals: deny");
      const permissions = session.output().slice(permissionsMark);
      assert.match(permissions, /codepunk permissions/u);
      assert.match(permissions, /Profile/u);
      assert.match(permissions, /Approvals/u);
      assert.match(permissions, /esc close/u);
      assert.match(permissions, /autonomy: read-only/u);
      assert.match(permissions, /current shell: explicit-unsandboxed/u);
      assert.match(permissions, /next session sandbox: required/u);
      await closeOverlay(session);

      await fs.writeFile(configPath, '[approval]\nmode = "not-a-mode"\n');
      const invalidMark = session.output().length;
      await runCommandAfter(session, "/reload", "Reload failed:");
      assert.match(
        session.output().slice(invalidMark),
        /approval\.mode|not-a-mode/u,
      );

      const preservedMark = session.output().length;
      await runCommandAfter(session, "/permissions status", "approvals: deny");
      assert.match(
        session.output().slice(preservedMark),
        /autonomy: read-only/u,
      );
      await closeOverlay(session);

      const sessionsBeforeQuit = (
        await fs.readdir(home, { recursive: true })
      ).filter((entry) => entry.endsWith("session.jsonl"));
      assert.equal(sessionsBeforeQuit.length, 1);

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

test("/init refuses to overwrite an existing root instruction file", async () => {
  await withTempDirectory("codepunk-tui-init-existing-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(path.join(project, "AGENTS.md"), "EXISTING_RULE\n");
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await trustWorkspace(home, project);
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
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const mark = session.output().length;
      session.child.stdin.write("/init\r");
      await waitForOutputAfter(
        session,
        mark,
        "Use /init --update to let the agent revise that file in place.",
        "/init existing file guard",
      );
      assert.match(session.output().slice(mark), /\/init --update/u);
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

test("a real pty projects search, todo, and plan tool output", async () => {
  await withTempDirectory("codepunk-tui-tool-projection-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await fs.writeFile(path.join(project, "note.txt"), "projection target\n");
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const model = await startToolProjectionModelServer();
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      session.child.stdin.write("project the tools\r");
      await waitForOutput(session, "TOOLS_PROJECTED", "tool projections");
      const output = stripAnsi(session.output());
      assert.match(output, /search · ls \. "note"/u);
      assert.match(output, /search · 1 entry · note\.txt/u);
      assert.match(
        output,
        /todo · 2 items · in progress: inspect the repository/u,
      );
      assert.match(output, /todo · 2 items · 1 in progress · 0 completed/u);
      assert.match(
        output,
        /plan · 2 steps · in progress: inspect the repository/u,
      );
      assert.match(output, /plan · 2 steps · sha [0-9a-f]{12}…/u);
      assert.doesNotMatch(output, /implement the health check/u);

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
      model.server.closeAllConnections?.();
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test("/init sends the repository-evidence prompt to the selected model", async () => {
  await withTempDirectory("codepunk-tui-init-model-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const model = await startTextModelServer();
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      await runCommandAfter(session, "/init", "CHILD_OK");
      assert.match(
        session.output(),
        /The new file applies when the next session starts\./u,
      );
      assert.ok(model.requests.length > 0);
      const request = JSON.stringify(model.requests);
      assert.match(request, /Create the repository guidance file/u);
      assert.match(request, /AGENTS\.md/u);
      assert.match(request, /Keep it under 120 lines/u);
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
      model.server.closeAllConnections?.();
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});
