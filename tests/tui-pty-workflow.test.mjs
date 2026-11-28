import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ensureBuilt,
  trustWorkspace,
  withTempDirectory,
} from "./support/helpers.mjs";
import {
  BASE_ENV,
  closeOverlay,
  execFileAsync,
  runCommandAfter,
  startHeldModelServer,
  startPty,
  startTextModelServer,
  startWriteModelServer,
  stopPty,
  stripAnsi,
  waitFor,
  waitForOutput,
  waitForOutputAfter,
  waitForQuiet,
} from "./support/tui-pty.mjs";

test("a real pty selects and persists a configured model", async () => {
  await withTempDirectory("codepunk-tui-model-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
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
                reasoning: true,
                contextWindow: 128000,
                maxTokens: 1024,
              },
              {
                id: "other",
                name: "Other Choice",
                reasoning: true,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
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
      await waitForOutput(session, "No default model configured.", "startup");
      await runCommandAfter(
        session,
        "/model test/fake",
        "model set to test/fake",
      );
      const partialMark = session.output().length;
      session.child.stdin.write("/model oth\r");
      await waitForOutputAfter(
        session,
        partialMark,
        "Other Choice",
        "Pi fuzzy model search",
      );
      assert.doesNotMatch(
        session.output().slice(partialMark),
        /usage: \/model/u,
      );
      assert.doesNotMatch(session.output().slice(partialMark), /Fake model/u);
      session.child.stdin.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 200));
      const searchMark = session.output().length;
      session.child.stdin.write("/model\r");
      await waitForOutputAfter(
        session,
        searchMark,
        "Other Choice",
        "Pi model selector",
      );
      session.child.stdin.write("other\r");
      await waitForOutputAfter(
        session,
        searchMark,
        "codepunk · test/other",
        "Pi model selection",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const sessionOnly = await fs.readFile(
        path.join(home, "config.toml"),
        "utf8",
      );
      assert.match(sessionOnly, /id = "fake"/u);
      await runCommandAfter(
        session,
        "/model test/other",
        "model set to test/other",
      );
      const config = await waitFor(async () => {
        try {
          const text = await fs.readFile(
            path.join(home, "config.toml"),
            "utf8",
          );
          return /id = "other"/u.test(text) ? text : null;
        } catch {
          return null;
        }
      }, "model config persistence");
      assert.match(config, /\[model\]/u);
      assert.match(config, /provider = "test"/u);
      assert.match(config, /id = "other"/u);
      assert.doesNotMatch(session.output(), /Pi-only command intercepted/u);

      const saveMark = session.output().length;
      session.child.stdin.write("/model\r");
      await waitForOutputAfter(
        session,
        saveMark,
        "Other Choice",
        "Pi model selector for default save",
      );
      session.child.stdin.write("fake");
      await waitForOutputAfter(
        session,
        saveMark,
        "Fake model",
        "Pi model filter for default save",
      );
      session.child.stdin.write("\u0013");
      await waitForOutputAfter(
        session,
        saveMark,
        "Default model: test/fake",
        "Pi default model save",
      );
      const savedDefault = await waitFor(async () => {
        try {
          const text = await fs.readFile(
            path.join(home, "config.toml"),
            "utf8",
          );
          return /id = "fake"/u.test(text) ? text : null;
        } catch {
          return null;
        }
      }, "saved default model");
      assert.match(savedDefault, /provider = "test"/u);

      const thinkingMark = session.output().length;
      session.child.stdin.write("/thinking high\r");
      await waitForOutputAfter(
        session,
        thinkingMark,
        "Thinking level: high",
        "Pi thinking selection",
      );
      const thinkingConfig = await waitFor(async () => {
        try {
          const text = await fs.readFile(
            path.join(home, "config.toml"),
            "utf8",
          );
          return /thinking = "high"/u.test(text) ? text : null;
        } catch {
          return null;
        }
      }, "thinking config persistence");
      assert.match(thinkingConfig, /provider = "test"/u);
      assert.match(thinkingConfig, /id = "fake"/u);
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

test("a real pty scopes the model picker to physical fallback members", async () => {
  await withTempDirectory("codepunk-tui-fallback-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[model]",
        'provider = "test"',
        'id = "fake"',
        'fallback = ["test/other"]',
        "",
      ].join("\n"),
    );
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
                reasoning: true,
                contextWindow: 128000,
                maxTokens: 1024,
              },
              {
                id: "other",
                name: "Other Choice",
                reasoning: true,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
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
      await waitForOutput(session, "codepunk · auto -> test/fake", "startup");
      const mark = session.output().length;
      session.child.stdin.write("/model\r");
      await waitForOutputAfter(
        session,
        mark,
        "Other Choice",
        "physical fallback member",
      );
      const picker = session
        .output()
        .slice(mark)
        .replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, "");
      assert.match(picker, /Scope:\s*all\s*\|\s*scoped/u);
      assert.doesNotMatch(picker, /codepunk\/auto/u);
      session.child.stdin.write("\u001b[B");
      session.child.stdin.write("\u0013");
      await waitForOutputAfter(
        session,
        mark,
        "Default model: test/other",
        "fallback default persistence",
      );
      const config = await waitFor(async () => {
        const value = await fs.readFile(path.join(home, "config.toml"), "utf8");
        return value.includes('id = "other"') ? value : false;
      }, "fallback default config persistence");
      assert.match(config, /provider = "test"/u);
      assert.match(config, /id = "other"/u);
      assert.doesNotMatch(config, /id = "auto"/u);
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty selects recent and favorite models without replacing Pi search", async () => {
  await withTempDirectory("codepunk-tui-model-history-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
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
              {
                id: "other",
                name: "Other Choice",
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
      await waitForOutput(session, "No default model configured.", "startup");
      await runCommandAfter(
        session,
        "/model test/fake",
        "model set to test/fake",
      );
      await runCommandAfter(
        session,
        "/favorite",
        "Added to favorites: test/fake",
      );
      await runCommandAfter(
        session,
        "/model test/other",
        "model set to test/other",
      );

      const menuMark = session.output().length;
      session.child.stdin.write("/models\r");
      await waitForOutputAfter(
        session,
        menuMark,
        "★ test/fake",
        "favorite model menu",
      );
      await waitForOutputAfter(
        session,
        menuMark,
        "↺ test/other (current)",
        "recent model menu",
      );
      await waitForOutputAfter(
        session,
        menuMark,
        "Search all models",
        "Pi search escape hatch",
      );
      session.child.stdin.write("\r");
      await waitForOutputAfter(
        session,
        menuMark,
        "model set to test/fake",
        "favorite model selection",
      );
      await runCommandAfter(
        session,
        "/favorite",
        "Removed from favorites: test/fake",
      );
      const history = JSON.parse(
        await fs.readFile(path.join(home, "model-history.json"), "utf8"),
      );
      assert.deepEqual(history.favorites, []);
      assert.equal(history.recent[0], "test/fake");
      assert.equal(history.recent[1], "test/other");

      const cycleMark = session.output().length;
      session.child.stdin.write("\u001bOQ");
      await waitForOutputAfter(
        session,
        cycleMark,
        "model set to test/other",
        "F2 recent model cycle",
      );

      const searchMark = session.output().length;
      session.child.stdin.write("/model\r");
      await waitForOutputAfter(
        session,
        searchMark,
        "Other Choice",
        "Pi search still works after Codepunk history",
      );
      session.child.stdin.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 500));

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

test("a real pty persists a Pi default even when the picker keeps the current model", async () => {
  await withTempDirectory("codepunk-tui-default-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
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
                reasoning: true,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
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
      await waitForOutput(session, "codepunk · test/fake", "startup");
      const mark = session.output().length;
      session.child.stdin.write("/model\r");
      await waitForOutputAfter(
        session,
        mark,
        "Fake model",
        "default model picker",
      );
      session.child.stdin.write("\u0013");
      await waitForOutputAfter(
        session,
        mark,
        "Default model: test/fake",
        "Pi default model status",
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
      const config = await fs.readFile(path.join(home, "config.toml"), "utf8");
      assert.match(config, /provider = "test"/u);
      assert.match(config, /id = "fake"/u);
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty shows and persists permission modes", async () => {
  await withTempDirectory("codepunk-tui-permissions-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
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
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const summaryMark = session.output().length;
      await runCommandAfter(session, "/permissions status", "profile: custom");
      assert.match(
        session.output().slice(summaryMark),
        /codepunk permissions/u,
      );
      assert.match(session.output().slice(summaryMark), /Profile/u);
      assert.match(session.output().slice(summaryMark), /Approvals/u);
      assert.match(session.output().slice(summaryMark), /esc close/u);
      assert.match(session.output().slice(summaryMark), /approvals: ask/u);
      assert.match(
        session.output().slice(summaryMark),
        /current shell: explicit-unsandboxed/u,
      );
      await closeOverlay(session);
      const menuMark = session.output().length;
      await runCommandAfter(session, "/permissions", "codepunk permissions");
      assert.match(session.output().slice(menuMark), /approval\s+ask/u);
      assert.match(session.output().slice(menuMark), /Scoped rules/u);
      assert.match(session.output().slice(menuMark), /Close/u);
      await closeOverlay(session);
      const emptyRulesMark = session.output().length;
      await runCommandAfter(
        session,
        "/permissions rules",
        "Scoped rules: none",
      );
      assert.match(session.output().slice(emptyRulesMark), /No scoped rules/u);
      assert.match(session.output().slice(emptyRulesMark), /esc close/u);
      await closeOverlay(session);
      await runCommandAfter(
        session,
        "/permissions reviewer",
        "scope: network commands and headless argv exec",
      );
      await runCommandAfter(
        session,
        "/permissions reviewer model gateway/reviewer",
        "reviewer: model",
      );
      await runCommandAfter(
        session,
        "/permissions reviewer timeout 5000",
        "reviewer timeout: 5000 ms",
      );
      await runCommandAfter(
        session,
        "/permissions reviewer off",
        "reviewer: off",
      );
      const whyMark = session.output().length;
      await runCommandAfter(
        session,
        "/permissions why date +%A",
        "rule: shell.read.date",
      );
      assert.match(session.output().slice(whyMark), /requires approval: no/u);
      assert.match(session.output().slice(whyMark), /execution: available/u);
      const dashedWhyMark = session.output().length;
      await runCommandAfter(
        session,
        "/permissions why -- touch probe.txt",
        "decision: ask",
      );
      assert.match(
        session.output().slice(dashedWhyMark),
        /rule: policy\.default/u,
      );
      await runCommandAfter(
        session,
        "/permissions approval",
        "Permission approval",
      );
      const approvalMark = session.output().length;
      session.child.stdin.write("\u001b[B\r");
      await waitForOutputAfter(
        session,
        approvalMark,
        "approvals set to deny",
        "approval picker",
      );
      const deniedMark = session.output().length;
      session.child.stdin.write("!touch denied-by-permission.txt\r");
      await waitForOutputAfter(
        session,
        deniedMark,
        "denied: approval.denied",
        "live approval mode",
      );
      assert.equal(
        await fs
          .stat(path.join(project, "denied-by-permission.txt"))
          .catch(() => null),
        null,
      );
      await runCommandAfter(
        session,
        "/permissions autonomy read-only",
        "autonomy set to read-only",
      );
      await runCommandAfter(
        session,
        "/permissions sandbox required",
        "sandbox set to required for the next session",
      );
      const config = await fs.readFile(path.join(home, "config.toml"), "utf8");
      assert.match(config, /mode = "deny"/u);
      assert.match(config, /profile = "read-only"/u);
      assert.match(config, /mode = "required"/u);
      await runCommandAfter(
        session,
        "/permissions autonomy ask",
        "autonomy set to ask",
      );
      await runCommandAfter(
        session,
        "/permissions profile full-access",
        "full-access cannot be enabled from a running session",
      );
      await runCommandAfter(
        session,
        "/permissions profile read-only",
        "permission profile set to read-only",
      );
      const profiled = await fs.readFile(
        path.join(home, "config.toml"),
        "utf8",
      );
      assert.match(profiled, /mode = "ask"/u);
      assert.match(profiled, /profile = "read-only"/u);
      assert.match(profiled, /mode = "required"/u);
      const finalPermissionsMark = session.output().length;
      await runCommandAfter(
        session,
        "/permissions status",
        "profile: read-only",
      );
      assert.match(
        session.output().slice(finalPermissionsMark),
        /autonomy: read-only/u,
      );
      assert.match(
        session.output().slice(finalPermissionsMark),
        /current shell: explicit-unsandboxed/u,
      );
      assert.match(
        session.output().slice(finalPermissionsMark),
        /next session sandbox: required/u,
      );
      assert.match(
        session.output().slice(finalPermissionsMark),
        /codepunk permissions/u,
      );
      await closeOverlay(session);
      assert.match(
        session.output(),
        /permissions read-only · trust trusted · shell explicit-unsandboxed/u,
      );
      await runCommandAfter(
        session,
        "/permissions sandbox uncovered",
        "sandbox set to uncovered for the next session",
      );
      assert.match(
        session.output(),
        /no shell unless started with --allow-unsandboxed-shell/u,
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

test("product commands and intercepted Pi builtins render through a real pty", async () => {
  await withTempDirectory("codepunk-tui-commands-", async (root) => {
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
      await runCommandAfter(session, "/cp-sessions", "events  (untitled)");
      await runCommandAfter(
        session,
        "/evidence",
        "No evidence in the current run.",
      );
      await closeOverlay(session);
      await runCommandAfter(session, "/doctor", "codepunk doctor (");
      await closeOverlay(session);
      await runCommandAfter(session, "/policy", "approval: ask");
      await closeOverlay(session);
      await runCommandAfter(
        session,
        "/cp-export",
        "Exported redacted transcript:",
      );
      await runCommandAfter(session, "/mcp", "MCP servers (user scope)");
      await closeOverlay(session);
      await runCommandAfter(session, "/skills", "Skills (0)");
      await closeOverlay(session);
      await runCommandAfter(session, "/plugins", "Plugins (disabled, 0 files)");
      await closeOverlay(session);
      await runCommandAfter(
        session,
        "/sign",
        "the current run has no durable run/end",
      );
      await runCommandAfter(session, "/session", "session: ");
      assert.match(session.output(), /model: unknown\/unknown/u);
      assert.match(session.output(), /evidence: 0 record/u);
      await runCommandAfter(session, "/resume", "Already in session ");
      assert.match(session.output(), /events  \(untitled\)/u);
      await runCommandAfter(
        session,
        "/export",
        "Exported redacted transcript:",
      );
      await runCommandAfter(session, "/new", "Start a new codepunk session?");
      session.child.stdin.write("\u001b");
      await waitForQuiet(session, 250);
      await runCommandAfter(
        session,
        "/import probe.jsonl",
        "Codepunk sessions keep their own evidence chain; use /cp-sessions or `codepunk --session <id>`.",
      );
      assert.doesNotMatch(session.output(), /codepunk --resume/u);
      await runCommandAfter(session, "/compact", "Compaction");
      await runCommandAfter(session, "/remember probe fact", "remembered mem_");
      await runCommandAfter(
        session,
        "/memory search probe",
        "[project] probe fact",
      );
      await runCommandAfter(
        session,
        "/remember list marker",
        "remembered mem_",
      );
      await runCommandAfter(session, "/memory list", "list marker");
      await runCommandAfter(
        session,
        "/remember archive marker",
        "remembered mem_",
      );
      const archiveCandidates = [
        ...session.output().matchAll(/remembered (mem_[a-z0-9]+)/gu),
      ];
      const archiveId = archiveCandidates.at(-1)?.[1];
      assert.ok(archiveId);
      await runCommandAfter(
        session,
        `/memory archive ${archiveId}`,
        `archived ${archiveId}`,
      );
      await runCommandAfter(
        session,
        "/memory search archive marker",
        "No memory records matched.",
      );
      await runCommandAfter(
        session,
        "/remember user preference --scope user",
        "remembered mem_",
      );
      await runCommandAfter(
        session,
        "/memory search user preference",
        "[user] user preference",
      );
      const remembered = [
        ...session.output().matchAll(/remembered (mem_[a-z0-9]+)/gu),
      ];
      const memoryId = remembered.at(-1)?.[1];
      assert.ok(memoryId);
      await runCommandAfter(
        session,
        `/memory delete ${memoryId}`,
        `deleted ${memoryId}`,
      );
      await runCommandAfter(
        session,
        "/memory search user preference",
        "No memory records matched.",
      );
      await runCommandAfter(session, "/permissions", "codepunk permissions");
      await closeOverlay(session);
      await runCommandAfter(session, "/permissions status", "approvals: ask");
      await closeOverlay(session);
      await runCommandAfter(session, "/model", "No authenticated models.");
      assert.match(session.output(), /Add a provider first:/u);
      assert.match(session.output(), /Then run \/model to choose a model\./u);
      await runCommandAfter(
        session,
        "/model test/fake",
        "No authenticated models.",
      );
      await runCommandAfter(session, "/settings", "codepunk settings");
      await closeOverlay(session);
      await runCommandAfter(
        session,
        "/settings permissions",
        "codepunk permissions",
      );
      await closeOverlay(session);
      await runCommandAfter(
        session,
        "/scoped-models",
        "Model scope is file-backed in codepunk.",
      );
      await runCommandAfter(session, "/trust", "project resources: none");
      await closeOverlay(session);
      await runCommandAfter(
        session,
        "/trust grant",
        "workspace trust saved as trusted",
      );
      await runCommandAfter(
        session,
        "/trust status",
        "saved decision: trusted",
      );
      await runCommandAfter(
        session,
        "/import session.jsonl",
        "External session import is not supported",
      );
      await runCommandAfter(session, "/share", "Use /cp-export");
      await runCommandAfter(
        session,
        "/bug a synthetic report hint",
        "The built-in /bug flow can upload a session transcript",
      );
      await runCommandAfter(
        session,
        "/reload",
        "Reloaded Pi resources and MCP configuration.",
      );
      await runCommandAfter(
        session,
        "/skills",
        "run /reload after changing skills",
      );
      await closeOverlay(session);
      await runCommandAfter(
        session,
        "/mcp list",
        "run /reload after changing MCP configuration",
      );
      await runCommandAfter(session, "/fork", "forked ");
      await runCommandAfter(session, "/tree list", "Session tree");
      await runCommandAfter(
        session,
        "/definitely-not-a-command",
        "Unknown command /definitely-not-a-command.",
      );
      assert.match(
        session.output(),
        /Type \/help for the available Codepunk commands\./u,
      );
      await runCommandAfter(session, "/help", "Codepunk help");
      await closeOverlay(session);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
      assert.match(session.output(), /exported|Exported/u);
    } finally {
      await stopPty(session);
    }
  });
});

test("/login and /logout reach the Pi host instead of being intercepted", async () => {
  await withTempDirectory("codepunk-tui-auth-", async (root) => {
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

      const loginMark = session.output().length;
      session.child.stdin.write("/login\r");
      await waitForOutputAfter(
        session,
        loginMark,
        "Select authentication method:",
        "/login",
      );
      assert.doesNotMatch(
        session.output().slice(loginMark),
        /Pi-only command intercepted/u,
      );
      session.child.stdin.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 250));

      const logoutMark = session.output().length;
      session.child.stdin.write("/logout\r");
      await waitForOutputAfter(
        session,
        logoutMark,
        "No stored credentials to remove.",
        "/logout",
      );
      assert.doesNotMatch(
        session.output().slice(logoutMark),
        /Pi-only command intercepted/u,
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

test("a real pty resumes another session without restarting the CLI", async () => {
  await withTempDirectory("codepunk-tui-resume-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const model = await startTextModelServer();
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
                id: "chat",
                name: "Chat",
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    try {
      const cli = await ensureBuilt();
      const env = {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      };
      const first = startPty(process.execPath, [cli], { cwd: project, env });
      let firstId;
      try {
        await waitForOutput(first, "codepunk · local/chat", "first startup");
        first.child.stdin.write("first question\r");
        await waitForOutput(first, "CHILD_OK", "first model reply");
        const firstMarker = first.output().length;
        first.child.stdin.write("unique-body-marker\r");
        await waitForOutputAfter(
          first,
          firstMarker,
          "CHILD_OK",
          "first marker reply",
        );
        await runCommandAfter(first, "/session", "session: ");
        const ids = [...first.output().matchAll(/session: ([0-9A-Z]{10,})/gu)];
        firstId = ids.at(-1)?.[1];
        assert.ok(firstId);
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
        assert.deepEqual(exited, { code: 0, signal: null });
      } finally {
        await stopPty(first);
      }

      const second = startPty(process.execPath, [cli, "--new-session"], {
        cwd: project,
        env,
      });
      try {
        await waitForOutput(second, "codepunk · local/chat", "second startup");
        second.child.stdin.write("second question\r");
        await waitForOutput(second, "CHILD_OK", "second model reply");
        await runCommandAfter(second, "/session", "session: ");
        const ids = [...second.output().matchAll(/session: ([0-9A-Z]{10,})/gu)];
        const secondId = ids.at(-1)?.[1];
        assert.ok(secondId);
        assert.notEqual(secondId, firstId);

        await runCommandAfter(
          second,
          "/resume unique-body-marker",
          `resumed session ${firstId}`,
        );
        await runCommandAfter(second, "/session", `session: ${firstId}`);
        second.child.stdin.write("after resume\r");
        await waitForOutput(second, "CHILD_OK", "model reply after resume");
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
        assert.deepEqual(exited, { code: 0, signal: null });
      } finally {
        await stopPty(second);
      }
    } finally {
      model.server.closeAllConnections?.();
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test("a real pty starts a new session in place", async () => {
  await withTempDirectory("codepunk-tui-new-", async (root) => {
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
      await runCommandAfter(session, "/session", "session: ");
      const firstMatches = [
        ...session.output().matchAll(/session: ([0-9A-Z]{10,})/gu),
      ];
      const firstId = firstMatches.at(-1)?.[1];
      assert.ok(firstId);
      await runCommandAfter(session, "/new", "Start a new codepunk session?");
      session.child.stdin.write("\r");
      await waitForOutput(session, "started session ", "new session");
      await runCommandAfter(session, "/session", "session: ");
      const secondMatches = [
        ...session.output().matchAll(/session: ([0-9A-Z]{10,})/gu),
      ];
      const secondId = secondMatches.at(-1)?.[1];
      assert.ok(secondId);
      assert.notEqual(secondId, firstId);
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

test("a real pty navigates the session tree and forks into a child session", async () => {
  await withTempDirectory("codepunk-tui-fork-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const model = await startTextModelServer();
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
                id: "chat",
                name: "Chat",
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    try {
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
        await waitForOutput(session, "codepunk · local/chat", "startup");
        session.child.stdin.write("first branch prompt\r");
        await waitForOutput(session, "CHILD_OK", "first reply");
        session.child.stdin.write("second branch prompt\r");
        await waitForOutput(session, "CHILD_OK", "second reply");
        await runCommandAfter(session, "/session", "session: ");
        const idMatches = [
          ...session.output().matchAll(/session: ([0-9A-Z]{10,})/gu),
        ];
        const parentId = idMatches.at(-1)?.[1];
        assert.ok(parentId);
        const stateEntry = await waitFor(
          async () =>
            (await fs.readdir(home, { recursive: true })).find((entry) =>
              entry.endsWith(
                path.join("sessions", parentId, "agent-state.json"),
              ),
            ) ?? null,
          "parent agent state",
        );
        const statePath = path.join(home, stateEntry);
        const parentState = JSON.parse(await fs.readFile(statePath, "utf8"));
        const firstEntry = parentState.branch.find(
          (entry) => entry.type === "message" && entry.message?.role === "user",
        );
        assert.ok(firstEntry);

        session.child.stdin.write("/tree\r");
        await waitForOutput(session, "Session Tree", "Pi tree selector");
        session.child.stdin.write("\u001b");
        await new Promise((resolve) => setTimeout(resolve, 250));
        await runCommandAfter(
          session,
          `/tree ${firstEntry.id}`,
          `moved to ${firstEntry.id}`,
        );
        const sessionLog = await waitFor(
          async () =>
            (await fs.readdir(home, { recursive: true })).find((entry) =>
              entry.endsWith(path.join("sessions", parentId, "session.jsonl")),
            ) ?? null,
          "parent session log",
        );
        const logRecords = (
          await fs.readFile(path.join(home, sessionLog), "utf8")
        )
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line));
        assert.ok(
          logRecords.some(
            (record) =>
              record.kind === "session/tree" &&
              record.data?.target_entry_id === firstEntry.id &&
              record.data?.to_entry_id === (firstEntry.parentId ?? null),
          ),
          JSON.stringify({
            firstEntryId: firstEntry.id,
            treeRecords: logRecords.filter(
              (record) => record.kind === "session/tree",
            ),
          }),
        );

        session.child.stdin.write("third branch prompt\r");
        await waitForOutput(session, "CHILD_OK", "reply after tree move");
        await runCommandAfter(session, "/fork", "forked ");
        await runCommandAfter(session, "/session", "session: ");
        const childMatches = [
          ...session.output().matchAll(/session: ([0-9A-Z]{10,})/gu),
        ];
        const childId = childMatches.at(-1)?.[1];
        assert.ok(childId);
        assert.notEqual(childId, parentId);
        const childStateEntry = await waitFor(
          async () =>
            (await fs.readdir(home, { recursive: true })).find((entry) =>
              entry.endsWith(
                path.join("sessions", childId, "agent-state.json"),
              ),
            ) ?? null,
          "child agent state",
        );
        const childState = JSON.parse(
          await fs.readFile(path.join(home, childStateEntry), "utf8"),
        );
        assert.equal(childState.header.id, childId);
        const childLogEntry = await waitFor(
          async () =>
            (await fs.readdir(home, { recursive: true })).find((entry) =>
              entry.endsWith(path.join("sessions", childId, "session.jsonl")),
            ) ?? null,
          "child session log",
        );
        const childLog = (
          await fs.readFile(path.join(home, childLogEntry), "utf8")
        )
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line));
        assert.equal(childLog[0].type, "codepunk/session");
        assert.equal(childLog[0].parent_session_id, parentId);
        const forkedEvent = childLog.find(
          (record) => record.kind === "session/forked",
        );
        assert.ok(forkedEvent);
        assert.equal(forkedEvent.data.parent_session_id, parentId);
        assert.equal(forkedEvent.data.mode, "live");

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
    } finally {
      model.server.closeAllConnections?.();
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test("a real pty queues input as steering while the model is streaming", async () => {
  await withTempDirectory("codepunk-tui-steer-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const model = await startHeldModelServer();
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
                id: "chat",
                name: "Chat",
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    try {
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
        await waitForOutput(session, "codepunk · local/chat", "startup");
        session.child.stdin.write("first question\r");
        await waitFor(
          () => (model.requests.length === 1 ? true : null),
          "first model request",
        );
        session.child.stdin.write("steer now\r");
        await waitForOutput(
          session,
          "Steering: steer now",
          "queued steering message",
        );
        assert.equal(model.requests.length, 1);
        model.releaseFirst();
        await waitForOutput(session, "FIRST_DONE", "first model reply");
        await waitForOutput(session, "STEER_DONE", "steered model reply");
        const files = await fs.readdir(home, { recursive: true });
        const logEntry = files.find((entry) => entry.endsWith("session.jsonl"));
        assert.ok(logEntry);
        const inputs = (await fs.readFile(path.join(home, logEntry), "utf8"))
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line))
          .filter((record) => record.kind === "user/input")
          .map((record) => record.data.text);
        assert.ok(inputs.includes("first question"));
        assert.ok(inputs.includes("steer now"));
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
    } finally {
      model.server.closeAllConnections?.();
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test("a real pty surfaces a stopped budget and refuses more model calls", async () => {
  await withTempDirectory("codepunk-tui-budget-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[budget]",
        "max_tokens = 1",
        "",
      ].join("\n"),
    );
    const model = await startTextModelServer();
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
                id: "chat",
                name: "Chat",
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    try {
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
        await waitForOutput(session, "codepunk · local/chat", "startup");
        assert.match(stripAnsi(session.output()), /budget 0\/1 tokens/u);
        session.child.stdin.write("first question\r");
        await waitForOutput(session, "CHILD_OK", "first model reply");
        await waitForOutput(
          session,
          "budget stopped at 5/1 tokens",
          "budget status line",
        );
        await runCommandAfter(
          session,
          "/budget",
          "budget: stopped at 5/1 tokens; start a new session with /new",
        );
        await closeOverlay(session);
        await runCommandAfter(
          session,
          "/status",
          "budget: stopped at 5/1 tokens; start a new session with /new",
        );
        session.child.stdin.write("\u001b");
        await waitForQuiet(session, 250);
        await runCommandAfter(
          session,
          "/session",
          "budget: stopped at 5/1 tokens; start a new session with /new",
        );
        const requestsBefore = model.requests.length;
        assert.equal(requestsBefore, 1);
        session.child.stdin.write("second question\r");
        await waitForOutput(
          session,
          "session budget exhausted (5/1 tokens)",
          "budget refusal",
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(model.requests.length, requestsBefore);
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
    } finally {
      model.server.closeAllConnections?.();
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test("a real pty runs /subagent as a read-only child session", async () => {
  await withTempDirectory("codepunk-tui-subagent-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await fs.mkdir(path.join(home, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(home, "agents", "reviewer.md"),
      [
        "---",
        "name: reviewer",
        "description: Review a bounded change set",
        "tools: read, search",
        "---",
        "Review the requested change.",
        "",
      ].join("\n"),
    );
    await fs.writeFile(path.join(project, "hello.txt"), "hello\n");
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.email=child@example.test",
        "-c",
        "user.name=Child Test",
        "add",
        "hello.txt",
      ],
      { cwd: project },
    );
    await execFileAsync(
      "git",
      [
        "-c",
        "user.email=child@example.test",
        "-c",
        "user.name=Child Test",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: project },
    );
    const modelServer = await startHeldModelServer();
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ local: { type: "api_key", key: "sk-child-test" } }),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: modelServer.baseUrl,
            apiKey: "sk-child-test",
            api: "openai-completions",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 4_000,
                maxTokens: 1_000,
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
          TERM: "xterm-256color",
          NO_COLOR: "1",
          PI_OFFLINE: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      await runCommandAfter(session, "/agents", "No subagents");
      assert.match(session.output(), /Background subagents/u);
      assert.match(session.output(), /esc close/u);
      await closeOverlay(session);
      await runCommandAfter(session, "/agents profiles", "reviewer (user)");
      const mark = session.output().length;
      session.child.stdin.write(
        "/subagent --profile reviewer reply with exactly CHILD_OK\r",
      );
      await waitForOutputAfter(
        session,
        mark,
        "subagent started:",
        "/subagent start",
      );
      await waitForOutputAfter(
        session,
        mark,
        "profile: reviewer (user)",
        "/subagent profile",
      );
      const childSessionId = session
        .output()
        .slice(mark)
        .match(/subagent started: ([A-Za-z0-9_-]+)/u)?.[1];
      assert.ok(childSessionId);
      await waitFor(
        () => modelServer.requests.length > 0,
        "the held child model request",
      );

      const transcriptMark = session.output().length;
      session.child.stdin.write(`/agents transcript ${childSessionId}\r`);
      await waitForOutputAfter(
        session,
        transcriptMark,
        "CODEPUNK SUBAGENT TRANSCRIPT",
        "/agents transcript browser",
      );
      await waitForOutputAfter(
        session,
        transcriptMark,
        "live",
        "/agents transcript live state",
      );
      modelServer.releaseFirst();
      await waitForOutputAfter(
        session,
        transcriptMark,
        "FIRST_DONE",
        "/agents transcript live output",
      );
      session.child.stdin.write("\u001b");
      await waitForOutputAfter(
        session,
        transcriptMark,
        "codepunk · local/local-test",
        "/agents transcript close",
      );
      await waitForOutputAfter(
        session,
        mark,
        `completed; use /agents result ${childSessionId}`,
        "/subagent completion",
      );
      assert.match(session.output().slice(mark), /FIRST_DONE/u);
      await runCommandAfter(
        session,
        `/agents result ${childSessionId}`,
        "FIRST_DONE",
      );
      const agentsMark = session.output().length;
      await runCommandAfter(session, "/agents", "completed");
      assert.match(session.output().slice(agentsMark), /AGENT/u);
      assert.match(session.output().slice(agentsMark), /SESSION/u);
      assert.match(session.output().slice(agentsMark), /STATUS/u);
      assert.match(session.output().slice(agentsMark), /NEXT/u);
      assert.match(session.output().slice(agentsMark), /esc close/u);
      await closeOverlay(session);
      await runCommandAfter(
        session,
        `/agents stop ${childSessionId}`,
        `subagent ${childSessionId} is already completed`,
      );
      assert.doesNotMatch(session.output().slice(mark), /failed:/u);
      assert.doesNotMatch(session.output().slice(mark), /parent waits/u);

      const logs = [];
      for (const entry of await fs.readdir(home, { recursive: true })) {
        if (!entry.endsWith("session.jsonl")) {
          continue;
        }
        const lines = (await fs.readFile(path.join(home, entry), "utf8"))
          .split("\n")
          .filter((line) => line.length > 0);
        for (const line of lines.slice(1)) {
          logs.push({ entry, event: JSON.parse(line) });
        }
      }
      const linked = logs.find(({ event }) => event.kind === "subagent/result");
      assert.ok(linked);
      assert.equal(linked.event.data.status, "completed");
      assert.equal(linked.event.data.depth, 1);
      assert.equal(linked.event.data.isolation, "shared");
      assert.equal(linked.event.data.model, "local/local-test");
      assert.equal(linked.event.data.profile, "reviewer");
      assert.match(linked.event.data.profile_sha256, /^sha256:[a-f0-9]{64}$/u);
      assert.equal(linked.event.data.summary, "FIRST_DONE");
      assert.equal(linked.event.data.evidence_head, null);
      assert.equal(linked.event.data.worktree, null);
      assert.equal(linked.event.data.changed_files, 0);
      assert.ok(
        logs.some(({ entry }) =>
          entry.endsWith(
            path.join(linked.event.data.child_session_id, "session.jsonl"),
          ),
        ),
      );

      const capabilitiesMark = session.output().length;
      session.child.stdin.write("/capabilities\r");
      await waitForOutputAfter(
        session,
        capabilitiesMark,
        "codepunk capabilities",
        "/capabilities",
      );
      await waitForOutputAfter(
        session,
        capabilitiesMark,
        "Skills (0)",
        "/capabilities skills",
      );
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
      modelServer.server.closeAllConnections?.();
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("a real pty reviews, signs, and merges a mutating subagent worktree", async () => {
  await withTempDirectory("codepunk-tui-subagent-delivery-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(path.join(home, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(home, "agents", "worker.md"),
      [
        "---",
        "name: worker",
        "description: Write a bounded child change",
        "tools: read, write",
        "---",
        "Write the requested file in the child worktree.",
        "",
      ].join("\n"),
    );
    await fs.writeFile(path.join(project, "hello.txt"), "hello\n");
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "child@example.test"], {
      cwd: project,
    });
    await execFileAsync("git", ["config", "user.name", "Child Test"], {
      cwd: project,
    });
    await execFileAsync("git", ["config", "core.autocrlf", "false"], {
      cwd: project,
    });
    await execFileAsync("git", ["add", "hello.txt"], { cwd: project });
    await execFileAsync("git", ["commit", "-qm", "fixture"], {
      cwd: project,
    });
    await trustWorkspace(home, project);
    const modelServer = await startWriteModelServer({
      path: "child-output.txt",
      content: "merged by child\n",
    });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ local: { type: "api_key", key: "sk-child-test" } }),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: modelServer.baseUrl,
            apiKey: "sk-child-test",
            api: "openai-completions",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 4_000,
                maxTokens: 1_000,
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
          TERM: "xterm-256color",
          NO_COLOR: "1",
          PI_OFFLINE: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      await runCommandAfter(session, "/agents profiles", "worker (user)");
      const startMark = session.output().length;
      session.child.stdin.write(
        "/subagent --profile worker write child-output.txt\r",
      );
      await waitForOutputAfter(
        session,
        startMark,
        "subagent started:",
        "/subagent start",
      );
      const childSessionId = session
        .output()
        .slice(startMark)
        .match(/subagent started: ([A-Za-z0-9_-]+)/u)?.[1];
      assert.ok(childSessionId);
      await waitForOutputAfter(
        session,
        startMark,
        `completed; use /agents result ${childSessionId}`,
        "/subagent completion",
      );
      await waitForOutputAfter(
        session,
        startMark,
        "transcript.jsonl",
        "/agents completion transcript",
      );
      assert.match(session.output().slice(startMark), /transcript:/u);
      const transcriptMark = session.output().length;
      session.child.stdin.write(`/agents transcript ${childSessionId}\r`);
      await waitForOutputAfter(
        session,
        transcriptMark,
        "CODEPUNK SUBAGENT TRANSCRIPT",
        "/agents transcript browser",
      );
      await waitForOutputAfter(
        session,
        transcriptMark,
        "TOOL write [ok",
        "/agents transcript tool output",
      );
      await waitForOutputAfter(
        session,
        transcriptMark,
        "WRITE_DONE",
        "/agents transcript assistant output",
      );
      session.child.stdin.write("\u001b");
      await waitForOutputAfter(
        session,
        transcriptMark,
        "codepunk · local/local-test",
        "/agents transcript close",
      );
      await runCommandAfter(
        session,
        `/agents review ${childSessionId}`,
        "child-output.txt",
      );

      const signMark = session.output().length;
      session.child.stdin.write(`/agents sign ${childSessionId}\r`);
      await waitForOutputAfter(
        session,
        signMark,
        `Sign subagent ${childSessionId}`,
        "/agents sign menu",
      );
      session.child.stdin.write("\r");
      await waitForOutputAfter(
        session,
        signMark,
        "signed complete",
        "/agents sign complete",
      );

      const mergeMark = session.output().length;
      session.child.stdin.write(`/agents merge ${childSessionId}\r`);
      await waitForOutputAfter(
        session,
        mergeMark,
        `Merge subagent ${childSessionId}?`,
        "/agents merge menu",
      );
      session.child.stdin.write("\r");
      await waitForOutputAfter(
        session,
        mergeMark,
        "merge commit:",
        "/agents merge commit",
      );
      assert.equal(
        await fs.readFile(path.join(project, "child-output.txt"), "utf8"),
        "merged by child\n",
      );
      assert.match(session.output().slice(mergeMark), /worktree removed/u);
      await runCommandAfter(session, "/agents", childSessionId);
      assert.match(session.output(), /merged/u);
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
      modelServer.server.closeAllConnections?.();
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("a read-only parent rejects a mutating subagent profile", async () => {
  await withTempDirectory("codepunk-tui-subagent-ceiling-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(path.join(home, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(home, "agents", "worker.md"),
      [
        "---",
        "name: worker",
        "description: Write in a child worktree",
        "tools: read, write",
        "---",
        "Write the requested file.",
        "",
      ].join("\n"),
    );
    await fs.writeFile(path.join(project, "hello.txt"), "hello\n");
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "child@example.test"], {
      cwd: project,
    });
    await execFileAsync("git", ["config", "user.name", "Child Test"], {
      cwd: project,
    });
    await execFileAsync("git", ["add", "hello.txt"], { cwd: project });
    await execFileAsync("git", ["commit", "-qm", "fixture"], {
      cwd: project,
    });
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--permission-mode", "read-only"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          TERM: "xterm-256color",
          NO_COLOR: "1",
          PI_OFFLINE: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const mark = session.output().length;
      session.child.stdin.write(
        "/subagent --profile worker write child-output.txt\r",
      );
      await waitForOutputAfter(
        session,
        mark,
        "failed: a read-only parent cannot spawn a mutating subagent",
        "parent ceiling rejection",
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
