import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  assertPrivateFile,
  createDirectoryLink,
  ensureBuilt,
  escapeRegExp,
  PRODUCT_VERSION,
  REPO_ROOT,
  trustWorkspace,
  withTempDirectory,
  withoutAmbientProviderEnv,
} from "./support/helpers.mjs";
import { importCore } from "./support/core.mjs";

const execFileAsync = promisify(execFile);
const core = await importCore();

// The model-catalog assertions below describe a workspace with nothing
// configured, so the provider credentials of the machine running the suite must
// not reach the CLI.
const BASE_ENV = withoutAmbientProviderEnv();
const SCOPED_RULE_COMMAND = process.platform === "win32" ? "robocopy" : "touch";

async function runCli(args, { cwd, home }) {
  return execFileAsync(process.execPath, [await ensureBuilt(), ...args], {
    cwd,
    env: {
      ...BASE_ENV,
      CODEPUNK_HOME: home,
      NO_COLOR: "1",
    },
  });
}

async function makeProject(root) {
  const project = path.join(root, "project");
  await fs.mkdir(project, { recursive: true });
  const home = path.join(root, "home");
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(
    path.join(home, "config.toml"),
    '[sandbox]\nmode = "uncovered"\n',
  );
  await execFileAsync("git", ["init", "-q"], { cwd: project });
  await fs.writeFile(path.join(project, "a.txt"), "x\n");
  await trustWorkspace(home, project);
  return { project, home };
}

test("the built CLI reports version and help", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    await ensureBuilt(),
    "--version",
  ]);
  assert.match(
    stdout,
    new RegExp(
      `^codepunk ${escapeRegExp(PRODUCT_VERSION)}\\nentry: .+\\nbuilt: .+\\nsource: .+\\n$`,
      "u",
    ),
  );
  const help = await execFileAsync(process.execPath, [
    await ensureBuilt(),
    "--help",
  ]);
  assert.match(help.stdout, /codepunk \[options\] \[prompt\]/u);
  assert.match(help.stdout, /codepunk sign/u);
  assert.match(help.stdout, /--fork <id>/u);
  assert.match(help.stdout, /codepunk permissions rules/u);
  assert.match(
    help.stdout,
    /codepunk trust \[status\|grant\|revoke\] \[path\] \[--resources config,policy,skills,instructions\]/u,
  );
  assert.match(help.stdout, /--bare\s+disable instructions/u);
  assert.match(help.stdout, /--no-skills\s+do not load skills/u);
  assert.match(help.stdout, /--no-plugins\s+do not load user plugins/u);
  assert.match(help.stdout, /codepunk completion <bash\|zsh\|fish>/u);
  assert.match(help.stdout, /codepunk config \[show\] \[--json\]/u);
  const permissionsHelp = await execFileAsync(process.execPath, [
    await ensureBuilt(),
    "permissions",
    "why",
    "--help",
  ]);
  assert.match(permissionsHelp.stdout, /permissions rules \[--json\]/u);
  assert.match(
    permissionsHelp.stdout,
    /permissions reviewer show\|off\|model \[provider\/model\]\|timeout <ms>/u,
  );
  assert.doesNotMatch(permissionsHelp.stdout, /codepunk \[options\]/u);
  const modelsHelp = await execFileAsync(process.execPath, [
    await ensureBuilt(),
    "models",
    "set",
    "--help",
  ]);
  assert.match(modelsHelp.stdout, /codepunk models import <base-url>/u);
  assert.doesNotMatch(modelsHelp.stdout, /codepunk \[options\]/u);
  const mcpHelp = await execFileAsync(process.execPath, [
    await ensureBuilt(),
    "mcp",
    "add",
    "--help",
  ]);
  assert.match(mcpHelp.stdout, /codepunk mcp add <name> --url <url>/u);
  assert.doesNotMatch(mcpHelp.stdout, /codepunk \[options\]/u);
  const sessionsHelp = await execFileAsync(process.execPath, [
    await ensureBuilt(),
    "sessions",
    "--help",
  ]);
  assert.match(sessionsHelp.stdout, /codepunk sessions prune \[--apply\]/u);
  assert.match(sessionsHelp.stdout, /codepunk sessions tree \[session-id\]/u);
  assert.match(sessionsHelp.stdout, /codepunk sessions graph \[--json\]/u);
  assert.match(
    sessionsHelp.stdout,
    /codepunk sessions search <query> \[--limit n\] \[--all-projects\]/u,
  );
  assert.doesNotMatch(sessionsHelp.stdout, /codepunk \[options\]/u);
  const completionHelp = await execFileAsync(process.execPath, [
    await ensureBuilt(),
    "completion",
    "--help",
  ]);
  assert.match(completionHelp.stdout, /codepunk completion bash\|zsh\|fish/u);
  const memoryHelp = await execFileAsync(process.execPath, [
    await ensureBuilt(),
    "memory",
    "search",
    "--help",
  ]);
  assert.match(
    memoryHelp.stdout,
    /codepunk memory search <query> \[--scope user\|project\]/u,
  );
  assert.match(
    memoryHelp.stdout,
    /codepunk memory edit <id> <text> \[--scope user\|project\]/u,
  );
});

test("config errors exit two", async () => {
  await withTempDirectory("codepunk-cli-config-error-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[session]",
        "heartbeat_seconds = 2",
        "lease_seconds = 1",
        "",
      ].join("\n"),
    );
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const cli = await ensureBuilt();
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [cli, "-p", "hello"], {
          cwd: project,
          env: {
            ...BASE_ENV,
            CODEPUNK_HOME: home,
            NO_COLOR: "1",
          },
        }),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /^codepunk: /u);
        assert.match(error.stderr, /session\.lease_seconds/u);
        return true;
      },
    );
  });
});

test(
  "windows daemon and view fail closed",
  { skip: process.platform !== "win32" ? "Windows-only behavior" : false },
  async () => {
    const cli = await ensureBuilt();
    for (const command of ["daemon", "view"]) {
      await assert.rejects(
        () =>
          execFileAsync(process.execPath, [cli, command], {
            cwd: os.tmpdir(),
            env: { ...BASE_ENV, NO_COLOR: "1" },
          }),
        (error) => {
          assert.notEqual(error.code, 0);
          assert.match(error.stderr, /not supported on Windows/u);
          assert.doesNotMatch(error.stderr, /\n\s+at /u);
          return true;
        },
      );
      const help = await execFileAsync(
        process.execPath,
        [cli, command, "--help"],
        { cwd: os.tmpdir(), env: { ...BASE_ENV, NO_COLOR: "1" } },
      );
      assert.match(help.stdout, new RegExp(`codepunk ${command}`, "u"));
    }
  },
);

test("completion prints scripts for the supported shells", async () => {
  const cli = await ensureBuilt();
  const bash = await execFileAsync(process.execPath, [
    cli,
    "completion",
    "bash",
  ]);
  assert.match(bash.stdout, /complete -F _codepunk_completion codepunk/u);
  assert.match(bash.stdout, /compgen -W "tree graph prune search"/u);
  const zsh = await execFileAsync(process.execPath, [cli, "completion", "zsh"]);
  assert.match(zsh.stdout, /^#compdef codepunk$/mu);
  assert.match(zsh.stdout, /'sessions:.*'/u);
  const fish = await execFileAsync(process.execPath, [
    cli,
    "completion",
    "fish",
  ]);
  assert.match(fish.stdout, /complete -c codepunk -f/u);
  assert.match(fish.stdout, /-a 'sessions'/u);
  await assert.rejects(
    () =>
      execFileAsync(process.execPath, [cli, "completion", "cmd"], {
        env: { ...process.env, NO_COLOR: "1" },
      }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(
        error.stderr,
        /completion requires one shell: bash, zsh, fish/u,
      );
      return true;
    },
  );
});

test("fork selectors cannot be combined with another session boundary", async () => {
  await withTempDirectory("codepunk-cli-fork-", async (root) => {
    const { project, home } = await makeProject(root);
    await assert.rejects(
      () =>
        runCli(["-p", "--fork", "parent", "--session", "other", "hello"], {
          cwd: project,
          home,
        }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--fork cannot be combined/u);
        return true;
      },
    );
  });
});

test("session isolation flags reject contradictory plugin and memory choices", async () => {
  await withTempDirectory("codepunk-cli-isolation-", async (root) => {
    const { project, home } = await makeProject(root);
    await assert.rejects(
      () =>
        runCli(["--allow-plugins", "--no-plugins", "hello"], {
          cwd: project,
          home,
        }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--allow-plugins cannot be combined/u);
        return true;
      },
    );
    await assert.rejects(
      () =>
        runCli(["--bare", "--memory", "true", "hello"], { cwd: project, home }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(
          error.stderr,
          /--bare cannot be combined with --memory true/u,
        );
        return true;
      },
    );
  });
});

test("print mode fails visibly without a model and changes no files", async () => {
  await withTempDirectory("codepunk-cli-", async (root) => {
    const { project, home } = await makeProject(root);
    const before = await fs.readFile(path.join(project, "a.txt"), "utf8");
    await assert.rejects(
      () =>
        runCli(["-p", "hello"], {
          cwd: project,
          home,
        }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /no model configured/u);
        assert.match(error.stderr, /codepunk models import/u);
        assert.match(error.stderr, /codepunk models set/u);
        return true;
      },
    );
    assert.equal(
      await fs.readFile(path.join(project, "a.txt"), "utf8"),
      before,
    );
  });
});

test("the runtime reports ignored unsafe project config", async () => {
  await withTempDirectory("codepunk-cli-config-", async (root) => {
    const { project, home } = await makeProject(root);
    const external = path.join(root, "external-config");
    await fs.mkdir(external);
    await fs.writeFile(
      path.join(external, "config.toml"),
      ["[memory]", "max_tokens = 1200", ""].join("\n"),
    );
    await fs.writeFile(
      path.join(external, "policy.toml"),
      ["version = 1", 'write_set = ["src/"]', ""].join("\n"),
    );
    await createDirectoryLink(external, path.join(project, ".codepunk"));
    await assert.rejects(
      () => runCli(["-p", "hello"], { cwd: project, home }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /project config ignored/u);
        assert.match(error.stderr, /project policy ignored/u);
        assert.match(error.stderr, /no model configured/u);
        return true;
      },
    );
  });
});

test("sessions and memory commands work through the product surface", async () => {
  await withTempDirectory("codepunk-cli-", async (root) => {
    const { project, home } = await makeProject(root);
    const sessions = await runCli(["sessions"], { cwd: project, home });
    assert.match(sessions.stdout, /No sessions\./u);
    const added = await runCli(
      ["memory", "add", "project uses pnpm workspaces"],
      { cwd: project, home },
    );
    assert.match(added.stdout.trim(), /^mem_/u);
    const editedId = added.stdout.trim();
    const edited = await runCli(
      [
        "memory",
        "edit",
        editedId,
        "project uses pnpm workspaces and node tests",
      ],
      { cwd: project, home },
    );
    assert.equal(edited.stdout.trim(), editedId);
    const projectPathNote = await runCli(
      ["memory", "add", `project notes live under ${home}/notes`],
      { cwd: project, home },
    );
    assert.match(projectPathNote.stdout.trim(), /^mem_/u);
    const userNote = await runCli(
      ["memory", "add", "user prefers compact output", "--scope", "user"],
      { cwd: project, home },
    );
    assert.match(userNote.stdout.trim(), /^mem_/u);
    const listed = await runCli(["memory", "list"], { cwd: project, home });
    assert.match(listed.stdout, /project uses pnpm workspaces and node tests/u);
    const memoryExportPath = path.join(root, "memory-export.json");
    await fs.writeFile(memoryExportPath, "previous\n");
    await fs.chmod(memoryExportPath, 0o644);
    const exportedMemory = await runCli(
      ["memory", "export", "--scope", "project", "--output", memoryExportPath],
      { cwd: project, home },
    );
    assert.match(exportedMemory.stdout, /memory-export\.json/u);
    const memoryExport = JSON.parse(
      await fs.readFile(memoryExportPath, "utf8"),
    );
    assert.equal(memoryExport.version, 1);
    assert.ok(memoryExport.redactions >= 1);
    assert.ok(memoryExport.records.length >= 2);
    assert.ok(
      memoryExport.records.every((record) => record.scope === "project"),
    );
    assert.ok(
      memoryExport.records.some((record) =>
        record.content.includes("project notes live under [HOME]"),
      ),
    );
    assert.ok(
      memoryExport.records.every(
        (record) => !record.content.includes("user prefers compact output"),
      ),
    );
    assert.ok(!JSON.stringify(memoryExport).includes(home));
    await assertPrivateFile(memoryExportPath);

    const archivedId = (
      await runCli(["memory", "add", "archive through the cli"], {
        cwd: project,
        home,
      })
    ).stdout.trim();
    const archived = await runCli(
      ["memory", "archive", archivedId, "--scope", "project"],
      { cwd: project, home },
    );
    assert.equal(archived.stdout.trim(), archivedId);
    const deletedId = (
      await runCli(["memory", "add", "delete through the cli"], {
        cwd: project,
        home,
      })
    ).stdout.trim();
    const deleted = await runCli(
      ["memory", "delete", deletedId, "--scope", "project"],
      { cwd: project, home },
    );
    assert.equal(deleted.stdout.trim(), deletedId);
    const afterMutation = await runCli(["memory", "list"], {
      cwd: project,
      home,
    });
    assert.doesNotMatch(afterMutation.stdout, /archive through the cli/u);
    assert.doesNotMatch(afterMutation.stdout, /delete through the cli/u);

    const projectDirectories = await fs.readdir(path.join(home, "projects"));
    assert.equal(projectDirectories.length, 1);
    const sessionDirectories = await fs.readdir(
      path.join(home, "projects", projectDirectories[0], "sessions"),
    );
    const pinnedSessionId = sessionDirectories[0];
    assert.ok(pinnedSessionId);
    const pinned = await runCli(["pin", pinnedSessionId], {
      cwd: project,
      home,
    });
    assert.match(pinned.stdout, new RegExp(`pinned ${pinnedSessionId}`));
    const unpinned = await runCli(["pin", pinnedSessionId, "--unpin"], {
      cwd: project,
      home,
    });
    assert.match(unpinned.stdout, new RegExp(`unpinned ${pinnedSessionId}`));
    const sessionMeta = JSON.parse(
      await fs.readFile(
        path.join(
          home,
          "projects",
          projectDirectories[0],
          "sessions",
          pinnedSessionId,
          "session-meta.json",
        ),
        "utf8",
      ),
    );
    assert.equal(sessionMeta.pinned, false);
    const sessionEvents = [];
    for (const sessionDirectory of sessionDirectories) {
      const log = await fs.readFile(
        path.join(
          home,
          "projects",
          projectDirectories[0],
          "sessions",
          sessionDirectory,
          "session.jsonl",
        ),
        "utf8",
      );
      for (const line of log.split("\n").filter(Boolean).slice(1)) {
        const event = JSON.parse(line);
        if (event.kind === "memory/write") {
          sessionEvents.push(event);
        }
      }
    }
    assert.deepEqual(
      [...new Set(sessionEvents.map((event) => event.data.action))].sort(),
      ["add", "archive", "delete", "edit"],
    );
    assert.equal(
      sessionEvents.every(
        (event) =>
          typeof event.data.content_sha256 === "string" ||
          event.data.content_sha256 === null,
      ),
      true,
    );
    assert.doesNotMatch(
      JSON.stringify(sessionEvents),
      /project uses pnpm workspaces|archive through the cli|delete through the cli/u,
    );

    await assert.rejects(
      () =>
        runCli(["memory", "add", `token = ${"sk-" + "4091994045dxivhoumfq"}`], {
          cwd: project,
          home,
        }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /secret_detected/u);
        return true;
      },
    );
    const exported = await runCli(["export"], { cwd: project, home });
    assert.match(exported.stdout, /Codepunk audit transcript/u);
    const transcriptPath = path.join(root, "audit.md");
    const toFile = await runCli(["export", "--output", transcriptPath], {
      cwd: project,
      home,
    });
    assert.match(toFile.stdout, /audit\.md/u);
    assert.match(toFile.stdout, /audit\.md\.manifest\.json/u);
    const manifest = JSON.parse(
      await fs.readFile(`${transcriptPath}.manifest.json`, "utf8"),
    );
    assert.match(exported.stdout, new RegExp(manifest.session_id, "u"));
    assert.ok(Array.isArray(manifest.records));
  });
});

test("sessions search can scan every project store", async () => {
  await withTempDirectory("codepunk-cli-cross-project-", async (root) => {
    const project = path.join(root, "project");
    const other = path.join(root, "other");
    const home = path.join(root, "home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(other, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    for (const [cwd, text] of [
      [project, "cross-project needlestack alpha"],
      [other, "cross-project needlestack beta"],
    ]) {
      const store = await core.SessionStore.create({
        rootDir: home,
        cwd,
        projectId: core.projectIdFor(cwd),
      });
      const writer = await store.acquireWriter();
      await store.append("user/input", {
        run_id: `${core.projectIdFor(cwd)}-run`,
        text,
      });
      await writer.release();
    }

    const result = await runCli(
      ["sessions", "search", "needlestack", "--all-projects", "--json"],
      { cwd: project, home },
    );
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.scanned_projects, 2);
    assert.equal(payload.matches.length, 2);
    assert.deepEqual(
      [...new Set(payload.matches.map((match) => match.project_id))].sort(),
      [core.projectIdFor(project), core.projectIdFor(other)].sort(),
    );

    const limited = await runCli(
      [
        "sessions",
        "search",
        "needlestack",
        "--all-projects",
        "--limit",
        "1",
        "--json",
      ],
      { cwd: project, home },
    );
    const limitedPayload = JSON.parse(limited.stdout);
    assert.equal(limitedPayload.matches.length, 1);
    assert.equal(limitedPayload.truncated, true);

    await assert.rejects(
      () => runCli(["sessions", "--all-projects"], { cwd: project, home }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--all-projects only applies/u);
        return true;
      },
    );
  });
});

test("sessions emit machine-readable lists and prune plans", async () => {
  await withTempDirectory("codepunk-cli-sessions-json-", async (root) => {
    const { project, home } = await makeProject(root);
    const empty = await runCli(["sessions", "--json"], { cwd: project, home });
    assert.deepEqual(JSON.parse(empty.stdout), []);

    await runCli(["memory", "add", "json session marker"], {
      cwd: project,
      home,
    });
    const listed = await runCli(["sessions", "--json"], {
      cwd: project,
      home,
    });
    const sessions = JSON.parse(listed.stdout);
    assert.equal(sessions.length, 1);
    assert.match(sessions[0].id, /^[A-Z0-9]{26}$/u);
    assert.equal(sessions[0].title, null);
    assert.equal(sessions[0].pinned, false);
    assert.ok(sessions[0].last_seq > 0);

    const realProject = await fs.realpath(project);
    const projectId = core.projectIdFor(realProject);
    const parent = await core.SessionStore.create({
      rootDir: home,
      cwd: realProject,
      projectRoot: realProject,
      projectId,
      heartbeatMs: 60_000,
    });
    const parentWriter = await parent.acquireWriter();
    const rootEntry = {
      id: "cli-root",
      parentId: null,
      timestamp: "2026-11-12T00:00:00.000Z",
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "cli root prompt" }],
      },
    };
    const activeEntry = {
      id: "cli-active",
      parentId: rootEntry.id,
      timestamp: "2026-11-12T00:00:01.000Z",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "cli active answer" }],
      },
    };
    const siblingEntry = {
      id: "cli-sibling",
      parentId: rootEntry.id,
      timestamp: "2026-11-12T00:00:02.000Z",
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "cli sibling prompt" }],
      },
    };
    await parent.append("user/input", {
      run_id: "cli-search-run",
      text: "search needle for sessions",
    });
    await parent.saveAgentState(
      {
        type: "session",
        id: "pi-cli-tree",
        cwd: realProject,
        timestamp: "2026-11-12T00:00:00.000Z",
      },
      [rootEntry, activeEntry],
      {
        entries: [rootEntry, activeEntry, siblingEntry],
        leafId: activeEntry.id,
      },
    );
    await parentWriter.release();
    const child = await core.SessionStore.create({
      rootDir: home,
      cwd: realProject,
      projectRoot: realProject,
      projectId,
      parentSessionId: parent.sessionId,
      forkEntryId: siblingEntry.id,
      heartbeatMs: 60_000,
    });

    const treeResult = await runCli(
      ["sessions", "tree", parent.sessionId, "--json"],
      { cwd: project, home },
    );
    const tree = JSON.parse(treeResult.stdout);
    assert.equal(tree.session_id, parent.sessionId);
    assert.equal(tree.leaf_id, activeEntry.id);
    assert.deepEqual(
      tree.entries.map((entry) => [entry.id, entry.active]),
      [
        [rootEntry.id, true],
        [activeEntry.id, true],
        [siblingEntry.id, false],
      ],
    );
    const treeText = await runCli(["sessions", "tree", parent.sessionId], {
      cwd: project,
      home,
    });
    assert.match(treeText.stdout, /cli active answer/u);

    const graphResult = await runCli(["sessions", "graph", "--json"], {
      cwd: project,
      home,
    });
    const graph = JSON.parse(graphResult.stdout);
    const parentGraph = graph.sessions.find(
      (session) => session.id === parent.sessionId,
    );
    const childGraph = graph.sessions.find(
      (session) => session.id === child.sessionId,
    );
    assert.equal(parentGraph.depth, 0);
    assert.equal(childGraph.depth, 1);
    assert.equal(childGraph.parent_session_id, parent.sessionId);
    assert.equal(childGraph.fork_entry_id, siblingEntry.id);

    const searchResult = await runCli(
      ["sessions", "search", "needle", "--json"],
      { cwd: project, home },
    );
    const search = JSON.parse(searchResult.stdout);
    assert.equal(search.query, "needle");
    assert.equal(search.truncated, false);
    assert.ok(
      search.matches.some(
        (match) =>
          match.session_id === parent.sessionId &&
          match.kind === "user/input" &&
          match.excerpt.includes("search needle"),
      ),
    );
    const searchText = await runCli(["sessions", "search", "needle"], {
      cwd: project,
      home,
    });
    assert.match(searchText.stdout, /Found 1 match\(es\)/u);

    const prune = await runCli(["sessions", "prune", "--json"], {
      cwd: project,
      home,
    });
    const plan = JSON.parse(prune.stdout);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.retainedCounts.sessions, 3);
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.warnings, []);
  });
});

test("retention command help and surfaces", async () => {
  const cli = await ensureBuilt();
  const help = await execFileAsync(process.execPath, [cli, "--help"]);
  assert.match(help.stdout, /codepunk gc \[--dry-run\|--apply\]/u);
  assert.match(help.stdout, /codepunk migrate \[--check\|--apply\]/u);
  assert.match(help.stdout, /codepunk backup create\|list\|restore <id>/u);
  assert.match(help.stdout, /sessions prune is dry-run only/u);

  for (const [args, pattern] of [
    [["gc", "--help"], /codepunk gc \[--dry-run\|--apply\]/u],
    [["migrate", "--help"], /codepunk migrate \[--check\|--apply\]/u],
    [["backup", "--help"], /codepunk backup create|list|restore <id>/u],
  ]) {
    const scoped = await execFileAsync(process.execPath, [cli, ...args]);
    assert.match(scoped.stdout, pattern);
    assert.doesNotMatch(scoped.stdout, /codepunk \[options\]/u);
  }
  const pruneHelp = await execFileAsync(process.execPath, [
    cli,
    "sessions",
    "prune",
    "--help",
  ]);
  assert.match(pruneHelp.stdout, /--apply is refused/u);

  await withTempDirectory("codepunk-cli-retention-", async (root) => {
    const { project, home } = await makeProject(root);
    const projectId = core.projectIdFor(await fs.realpath(project));
    const projectDir = path.join(home, "projects", projectId);
    const artifact = path.join(projectDir, "artifacts", "old.txt");
    const sessionFile = path.join(
      projectDir,
      "sessions",
      "S1",
      "session.jsonl",
    );
    const evidenceFile = path.join(projectDir, "evidence", "S1", "run.jsonl");
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.mkdir(path.dirname(evidenceFile), { recursive: true });
    await fs.writeFile(artifact, "artifact\n");
    const old = new Date("2020-01-01T00:00:00.000Z");
    await fs.utimes(artifact, old, old);
    await fs.writeFile(sessionFile, "session\n");
    await fs.writeFile(evidenceFile, "evidence\n");

    const dry = JSON.parse(
      (
        await runCli(["gc", "--dry-run", "--json"], {
          cwd: project,
          home,
        })
      ).stdout,
    );
    assert.equal(dry.dry_run, true);
    assert.equal(dry.candidates.length, 1);
    assert.equal(await fs.readFile(artifact, "utf8"), "artifact\n");

    const applied = JSON.parse(
      (
        await runCli(["gc", "--apply", "--json"], {
          cwd: project,
          home,
        })
      ).stdout,
    );
    assert.ok(applied.backup_id);
    await assert.rejects(fs.readFile(artifact), { code: "ENOENT" });
    assert.equal(await fs.readFile(sessionFile, "utf8"), "session\n");
    assert.equal(await fs.readFile(evidenceFile, "utf8"), "evidence\n");

    await runCli(["backup", "restore", applied.backup_id], {
      cwd: project,
      home,
    });
    assert.equal(await fs.readFile(artifact, "utf8"), "artifact\n");

    await assert.rejects(
      () => runCli(["sessions", "prune", "--apply"], { cwd: project, home }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /prune --apply is refused/u);
        return true;
      },
    );

    await assert.rejects(
      () => runCli(["migrate", "--check", "--json"], { cwd: project, home }),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(JSON.parse(error.stdout).required, true);
        return true;
      },
    );
    const migrated = JSON.parse(
      (
        await runCli(["migrate", "--apply", "--json"], {
          cwd: project,
          home,
        })
      ).stdout,
    );
    assert.ok(migrated.backup_id);
    assert.equal(
      await fs.readFile(path.join(home, "state-version.json"), "utf8"),
      '{\n  "version": 1\n}\n',
    );
    await runCli(["backup", "restore", migrated.backup_id], {
      cwd: project,
      home,
    });
    await assert.rejects(fs.access(path.join(home, "state-version.json")), {
      code: "ENOENT",
    });
  });
});

test("fresh homes initialize state version without reporting migration", async () => {
  const cli = await ensureBuilt();
  await withTempDirectory("codepunk-fresh-home-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const home = path.join(root, "home");

    const checked = JSON.parse(
      (await runCli(["migrate", "--check", "--json"], { cwd: project, home }))
        .stdout,
    );
    assert.deepEqual(checked, {
      current: core.STATE_VERSION,
      target: core.STATE_VERSION,
      required: false,
    });
    await assert.rejects(fs.access(home), { code: "ENOENT" });

    await runCli(["permissions"], { cwd: project, home });
    assertPrivateFile(path.join(home, "state-version.json"));
    assert.equal(
      await fs.readFile(path.join(home, "state-version.json"), "utf8"),
      '{\n  "version": 1\n}\n',
    );
    const rechecked = JSON.parse(
      (await runCli(["migrate", "--check", "--json"], { cwd: project, home }))
        .stdout,
    );
    assert.equal(rechecked.required, false);

    const emptyHome = path.join(root, "empty-home");
    await fs.mkdir(emptyHome);
    await runCli(["permissions"], { cwd: project, home: emptyHome });
    assertPrivateFile(path.join(emptyHome, "state-version.json"));
    assert.equal(
      await fs.readFile(path.join(emptyHome, "state-version.json"), "utf8"),
      '{\n  "version": 1\n}\n',
    );
    const emptyRechecked = JSON.parse(
      (
        await runCli(["migrate", "--check", "--json"], {
          cwd: project,
          home: emptyHome,
        })
      ).stdout,
    );
    assert.equal(emptyRechecked.required, false);
  });
});

test(
  "symlinked empty homes initialize state version",
  {
    skip: process.platform === "win32" ? "POSIX-only symlink home" : false,
  },
  async () => {
    const cli = await ensureBuilt();
    await withTempDirectory("codepunk-symlink-home-", async (root) => {
      const project = path.join(root, "project");
      await fs.mkdir(project);
      const homeTarget = path.join(root, "home-target");
      const home = path.join(root, "home");
      await fs.mkdir(homeTarget);
      await fs.symlink(homeTarget, home);

      await runCli(["permissions"], { cwd: project, home });
      assertPrivateFile(path.join(homeTarget, "state-version.json"));
      assert.equal(
        await fs.readFile(path.join(homeTarget, "state-version.json"), "utf8"),
        '{\n  "version": 1\n}\n',
      );
      const checked = JSON.parse(
        (await runCli(["migrate", "--check", "--json"], { cwd: project, home }))
          .stdout,
      );
      assert.equal(checked.required, false);
    });
  },
);

test("permission commands show effective modes, explain commands, and persist profiles", async () => {
  await withTempDirectory("codepunk-cli-permissions-", async (root) => {
    const { project, home } = await makeProject(root);
    const shown = await runCli(["permissions"], { cwd: project, home });
    assert.match(shown.stdout, /profile: custom/u);
    assert.match(
      shown.stdout,
      /codepunk permissions reviewer show\|off\|model \[provider\/model\]\|timeout <ms>/u,
    );
    assert.match(shown.stdout, /approvals: ask/u);
    assert.match(shown.stdout, /behavior: ask prompts/u);
    assert.match(shown.stdout, /autonomy: ask/u);
    assert.match(shown.stdout, /sandbox: uncovered/u);
    const shownJson = await runCli(["permissions", "--json"], {
      cwd: project,
      home,
    });
    const permissions = JSON.parse(shownJson.stdout);
    assert.equal(permissions.config_path, path.join(home, "config.toml"));
    assert.ok(Array.isArray(permissions.summary));
    assert.ok(permissions.summary.includes("approval: ask"));
    assert.ok(permissions.summary.includes("autonomy: ask"));
    assert.equal(permissions.workspace_trust.trusted, true);
    assert.deepEqual(permissions.additional_roots, []);
    const emptyRules = await runCli(["permissions", "--json", "rules"], {
      cwd: project,
      home,
    });
    assert.deepEqual(JSON.parse(emptyRules.stdout), []);

    const date = await runCli(
      ["--allow-unsandboxed-shell", "permissions", "why", "--", "date", "+%A"],
      { cwd: project, home },
    );
    assert.match(date.stdout, /decision: allow/u);
    assert.match(date.stdout, /rule: shell\.read\.date/u);
    assert.match(date.stdout, /requires approval: no/u);
    assert.match(date.stdout, /execution: available/u);
    assert.match(
      date.stdout,
      /replayed: policy, scoped_rules, approval_mode, shell_availability/u,
    );
    assert.match(
      date.stdout,
      /not replayed: approval_reviewer, human_response, agent_shell_environment/u,
    );

    const blocked = await runCli(["permissions", "why", "--", "date", "+%A"], {
      cwd: project,
      home,
    });
    assert.match(blocked.stdout, /decision: deny/u);
    assert.match(blocked.stdout, /policy decision: allow/u);
    assert.match(blocked.stdout, /rule: sandbox\.unavailable/u);
    assert.match(blocked.stdout, /policy rule: shell\.read\.date/u);
    assert.match(blocked.stdout, /execution: blocked/u);

    const touch = await runCli(
      [
        "--allow-unsandboxed-shell",
        "permissions",
        "why",
        "--",
        "touch",
        "probe.txt",
      ],
      { cwd: project, home },
    );
    assert.match(touch.stdout, /decision: ask/u);

    const effective = await runCli(["permissions", "--approval", "deny"], {
      cwd: project,
      home,
    });
    assert.match(effective.stdout, /approvals: deny/u);

    const profile = await runCli(["permissions", "profile", "auto-approve"], {
      cwd: project,
      home,
    });
    assert.match(profile.stdout, /permission profile set to auto-approve/u);
    const configPath = path.join(home, "config.toml");
    const trusted = await fs.readFile(configPath, "utf8");
    assert.match(trusted, /\[approval\]\nmode = "allow"/u);
    assert.match(trusted, /\[autonomy\]\nprofile = "ask"/u);
    assert.match(trusted, /\[sandbox\]\nmode = "required"/u);

    const trustedDecision = await runCli(
      [
        "--sandbox",
        "uncovered",
        "--allow-unsandboxed-shell",
        "permissions",
        "why",
        "--",
        "touch",
        "probe.txt",
      ],
      { cwd: project, home },
    );
    assert.match(trustedDecision.stdout, /decision: allow/u);
    assert.match(trustedDecision.stdout, /policy decision: ask/u);
    assert.match(trustedDecision.stdout, /approval mode: allow/u);
    assert.match(trustedDecision.stdout, /requires approval: no/u);
    const trustedJson = await runCli(
      [
        "--sandbox",
        "uncovered",
        "--allow-unsandboxed-shell",
        "permissions",
        "--json",
        "why",
        "--",
        "touch",
        "probe.txt",
      ],
      { cwd: project, home },
    );
    assert.deepEqual(
      {
        decision: JSON.parse(trustedJson.stdout).decision,
        policy_decision: JSON.parse(trustedJson.stdout).policy_decision,
        effective_decision: JSON.parse(trustedJson.stdout).effective_decision,
        requires_approval: JSON.parse(trustedJson.stdout).requires_approval,
        approval_mode: JSON.parse(trustedJson.stdout).approval_mode,
      },
      {
        decision: "allow",
        policy_decision: "ask",
        effective_decision: "allow",
        requires_approval: false,
        approval_mode: "allow",
      },
    );

    await runCli(["permissions", "approval", "deny"], {
      cwd: project,
      home,
    });
    const denied = await fs.readFile(configPath, "utf8");
    assert.match(denied, /\[approval\]\nmode = "deny"/u);
    assert.match(denied, /\[autonomy\]\nprofile = "ask"/u);
    const deniedDecision = await runCli(
      [
        "--sandbox",
        "uncovered",
        "--allow-unsandboxed-shell",
        "permissions",
        "why",
        "--",
        "touch",
        "probe.txt",
      ],
      { cwd: project, home },
    );
    assert.match(deniedDecision.stdout, /decision: deny/u);
    assert.match(deniedDecision.stdout, /policy decision: ask/u);
    assert.match(deniedDecision.stdout, /approval mode: deny/u);
    const uncovered = await runCli(["permissions", "sandbox", "uncovered"], {
      cwd: project,
      home,
    });
    assert.match(
      uncovered.stdout,
      /no shell unless started with --allow-unsandboxed-shell/u,
    );

    await assert.rejects(
      () => runCli(["permissions", "profile", "yolo"], { cwd: project, home }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(
          error.stderr,
          /permissions profile requires read-only, standard, auto, auto-approve, full-access/u,
        );
        return true;
      },
    );

    await assert.rejects(
      () =>
        runCli(["permissions", "profile", "trusted"], {
          cwd: project,
          home,
        }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /collides with workspace trust/u);
        return true;
      },
    );

    await assert.rejects(
      () =>
        runCli(
          [
            "--dangerously-bypass-approvals-and-sandbox",
            "--permission-mode",
            "read-only",
          ],
          { cwd: project, home },
        ),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(
          error.stderr,
          /can only be combined with --permission-mode full-access/u,
        );
        return true;
      },
    );

    await assert.rejects(
      () =>
        runCli(
          [
            "--dangerously-bypass-approvals-and-sandbox",
            "--autonomy",
            "read-only",
          ],
          { cwd: project, home },
        ),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /implies full-access autonomy=ask/u);
        return true;
      },
    );

    const network = await runCli(
      ["permissions", "sandbox", "network", "Registry.NPMJS.org"],
      { cwd: project, home },
    );
    assert.match(network.stdout, /network allow: registry\.npmjs\.org/u);
    const shownNetwork = await runCli(["permissions"], { cwd: project, home });
    assert.match(shownNetwork.stdout, /network allow: registry\.npmjs\.org/u);
    const networkWhy = await runCli(
      [
        "--allow-unsandboxed-shell",
        "permissions",
        "why",
        "--",
        "curl https://example.com",
      ],
      { cwd: project, home },
    );
    assert.match(networkWhy.stdout, /approval class: network/u);
    assert.match(networkWhy.stdout, /network allow: registry\.npmjs\.org/u);
    const networkConfig = await core.loadConfig(
      core.projectPaths(await core.findDeliveryRoot(project), home),
    );
    assert.deepEqual(networkConfig.config.sandbox.network_allow, [
      "registry.npmjs.org",
    ]);

    const reviewer = await runCli(["permissions", "reviewer"], {
      cwd: project,
      home,
    });
    assert.match(reviewer.stdout, /reviewer: off/u);
    assert.match(
      reviewer.stdout,
      /scope: network commands and headless argv exec/u,
    );
    const reviewerModel = await runCli(
      ["permissions", "reviewer", "model", "gateway/reviewer"],
      { cwd: project, home },
    );
    assert.match(reviewerModel.stdout, /approval reviewer set to model/u);
    assert.match(reviewerModel.stdout, /reviewer model: gateway\/reviewer/u);
    const reviewerTimeout = await runCli(
      ["permissions", "reviewer", "timeout", "5000"],
      { cwd: project, home },
    );
    assert.match(reviewerTimeout.stdout, /timeout set to 5000 ms/u);
    const reviewerConfig = await core.loadConfig(
      core.projectPaths(await core.findDeliveryRoot(project), home),
    );
    assert.equal(reviewerConfig.config.approval.reviewer, "model");
    assert.equal(
      reviewerConfig.config.approval.reviewer_model,
      "gateway/reviewer",
    );
    assert.equal(reviewerConfig.config.approval.reviewer_timeout_ms, 5000);
    const reviewerOff = await runCli(["permissions", "reviewer", "off"], {
      cwd: project,
      home,
    });
    assert.match(reviewerOff.stdout, /approval reviewer disabled/u);
    const reviewerOffConfig = await core.loadConfig(
      core.projectPaths(await core.findDeliveryRoot(project), home),
    );
    assert.equal(reviewerOffConfig.config.approval.reviewer, "off");
    assert.equal(reviewerOffConfig.config.approval.reviewer_model, null);

    const denyList = await runCli(
      ["permissions", "sandbox", "network", "deny", "Evil.Example.com"],
      { cwd: project, home },
    );
    assert.match(denyList.stdout, /network deny: evil\.example\.com/u);
    const deniedWhy = await runCli(
      [
        "--allow-unsandboxed-shell",
        "permissions",
        "why",
        "--",
        "curl https://example.com",
      ],
      { cwd: project, home },
    );
    assert.match(deniedWhy.stdout, /network deny: evil\.example\.com/u);
    await assert.rejects(
      () =>
        runCli(
          ["permissions", "sandbox", "network", "allow", "evil.example.com"],
          { cwd: project, home },
        ),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /cannot be both|also lists/u);
        return true;
      },
    );
    const clearedDeny = await runCli(
      ["permissions", "sandbox", "network", "clear", "deny"],
      { cwd: project, home },
    );
    assert.match(clearedDeny.stdout, /network deny: none/u);

    await assert.rejects(
      () =>
        runCli(["permissions", "sandbox", "network", "*.com"], {
          cwd: project,
          home,
        }),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /too broad/u);
        return true;
      },
    );
    const cleared = await runCli(
      ["permissions", "sandbox", "network", "clear"],
      {
        cwd: project,
        home,
      },
    );
    assert.match(cleared.stdout, /network allow: none \(deny by default\)/u);
    const clearedConfig = await core.loadConfig(
      core.projectPaths(await core.findDeliveryRoot(project), home),
    );
    assert.deepEqual(clearedConfig.config.sandbox.network_allow, []);

    const context = await core.findDeliveryRoot(project);
    const paths = core.projectPaths(context, home);
    const persisted = await core.persistScopedRule({
      paths,
      argv: [SCOPED_RULE_COMMAND, "approved-exact.txt"],
      cwd: project,
      filePath: path.join(home, "scoped-rules.toml"),
    });
    await core.writeUserPermissionSelection(paths, {
      autonomy: "scoped",
      scopedRules: persisted.path,
    });
    const rules = await runCli(["permissions", "rules"], {
      cwd: project,
      home,
    });
    assert.match(rules.stdout, /scoped rules: 1/u);
    assert.match(
      rules.stdout,
      new RegExp(`${SCOPED_RULE_COMMAND} approved-exact\\.txt`, "u"),
    );
    const scopedWhy = await runCli(
      [
        "--sandbox",
        "uncovered",
        "--allow-unsandboxed-shell",
        "permissions",
        "why",
        "--",
        SCOPED_RULE_COMMAND,
        "approved-exact.txt",
      ],
      { cwd: project, home },
    );
    assert.match(scopedWhy.stdout, /decision: allow/u);
    assert.match(scopedWhy.stdout, /policy decision: ask/u);
    assert.match(scopedWhy.stdout, /approval decision: allow/u);
    assert.match(
      scopedWhy.stdout,
      new RegExp(`rule: scoped\\.${persisted.rule.id}`, "u"),
    );
    assert.match(scopedWhy.stdout, /scoped rule: approval-/u);
    const rulesJson = await runCli(["permissions", "--json", "rules"], {
      cwd: project,
      home,
    });
    assert.equal(JSON.parse(rulesJson.stdout)[0].id, persisted.rule.id);
  });
});

test("scoped autonomy refuses to persist without a valid rules file", async () => {
  await withTempDirectory("codepunk-cli-scoped-guard-", async (root) => {
    const { project, home } = await makeProject(root);
    const configPath = path.join(home, "config.toml");
    const before = await fs.readFile(configPath, "utf8");

    await assert.rejects(
      () =>
        runCli(["permissions", "autonomy", "scoped"], {
          cwd: project,
          home,
        }),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(
          error.stderr,
          /scoped autonomy requires autonomy\.scoped_rules/u,
        );
        return true;
      },
    );
    assert.equal(await fs.readFile(configPath, "utf8"), before);
    const stillUsable = await runCli(["permissions"], { cwd: project, home });
    assert.match(stillUsable.stdout, /autonomy: ask/u);

    const context = await core.findDeliveryRoot(project);
    const paths = core.projectPaths(context, home);
    const persisted = await core.persistScopedRule({
      paths,
      argv: [SCOPED_RULE_COMMAND, "approved-exact.txt"],
      cwd: project,
      filePath: path.join(home, "scoped-rules.toml"),
    });
    await fs.writeFile(
      configPath,
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[autonomy]",
        'profile = "ask"',
        `scoped_rules = ${JSON.stringify(persisted.path)}`,
        "",
      ].join("\n"),
    );
    const enabled = await runCli(["permissions", "autonomy", "scoped"], {
      cwd: project,
      home,
    });
    assert.match(enabled.stdout, /permissions autonomy set to scoped/u);
    const shown = await runCli(["permissions"], { cwd: project, home });
    assert.match(shown.stdout, /autonomy: scoped/u);
  });
});

test("install refuses the unpublished placeholder version", async () => {
  await withTempDirectory("codepunk-cli-install-", async (root) => {
    const { project, home } = await makeProject(root);
    await assert.rejects(
      () =>
        runCli(["install", "--dry-run", "--package-version", "0.0.0"], {
          cwd: project,
          home,
        }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(
          error.stderr,
          /0\.0\.0 is the unpublished placeholder version/u,
        );
        assert.match(error.stderr, /--package-version <published-version>/u);
        return true;
      },
    );

    const ownVersion = await runCli(["install", "--dry-run"], {
      cwd: project,
      home,
    });
    assert.match(
      ownVersion.stdout,
      new RegExp(`codepunk-cli@${escapeRegExp(PRODUCT_VERSION)}`, "u"),
    );

    const dryRun = await runCli(
      ["install", "--dry-run", "--package-version", "9.9.9"],
      { cwd: project, home },
    );
    assert.match(dryRun.stdout, /npm install/u);
    assert.match(dryRun.stdout, /codepunk-cli@9\.9\.9/u);
  });
});

test("--add-dir extends file policy for permission inspection but not project resources", async () => {
  await withTempDirectory("codepunk-cli-add-dir-", async (root) => {
    const { project, home } = await makeProject(root);
    const extra = path.join(root, "extra");
    await fs.mkdir(path.join(extra, ".codepunk"), { recursive: true });
    await fs.writeFile(path.join(extra, "a.txt"), "needle\n");
    await fs.writeFile(
      path.join(extra, ".codepunk", "config.toml"),
      "[memory]\nmax_tokens = 99\n",
    );

    const shown = await runCli(["--add-dir", extra, "permissions"], {
      cwd: project,
      home,
    });
    assert.match(shown.stdout, /extra file roots: /u);
    assert.match(shown.stdout, new RegExp(escapeRegExp(extra), "u"));

    const denied = await runCli(
      [
        "--allow-unsandboxed-shell",
        "permissions",
        "why",
        "--",
        "cat",
        path.join(extra, "a.txt"),
      ],
      { cwd: project, home },
    );
    assert.match(denied.stdout, /decision: deny/u);
    assert.match(denied.stdout, /outside the workspace/u);

    const allowed = await runCli(
      [
        "--allow-unsandboxed-shell",
        "--add-dir",
        extra,
        "permissions",
        "why",
        "--",
        "cat",
        path.join(extra, "a.txt"),
      ],
      { cwd: project, home },
    );
    assert.match(allowed.stdout, /decision: allow/u);
    assert.match(allowed.stdout, /rule: shell\.read\.cat/u);

    const protectedConfig = await runCli(
      [
        "--allow-unsandboxed-shell",
        "--add-dir",
        extra,
        "permissions",
        "why",
        "--",
        "cat",
        path.join(extra, ".codepunk", "config.toml"),
      ],
      { cwd: project, home },
    );
    assert.match(protectedConfig.stdout, /decision: deny/u);
    assert.match(protectedConfig.stdout, /codepunk state/u);

    await assert.rejects(
      runCli(["--add-dir", os.homedir(), "permissions"], {
        cwd: project,
        home,
      }),
      /cannot contain the user home or Codepunk home/u,
    );
  });
});

test("models commands import, select, and report a local endpoint", async () => {
  await withTempDirectory("codepunk-cli-models-", async (root) => {
    const { project, home } = await makeProject(root);
    const empty = await runCli(["models", "list"], { cwd: project, home });
    assert.match(empty.stdout, /no models configured/u);
    await assert.rejects(
      () => runCli(["models", "test"], { cwd: project, home }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /no model configured/u);
        assert.match(error.stderr, /codepunk models import/u);
        return true;
      },
    );
    let failCompletions = false;
    const server = http.createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (request.method === "GET" && pathname === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            data: [
              {
                id: "local/chat",
                display_name: "Local Chat",
                reasoning: true,
                reasoning_levels: ["low", "high"],
                context_window: 128000,
                max_output_tokens: 8192,
              },
            ],
          }),
        );
        return;
      }
      if (request.method === "POST" && pathname === "/v1/chat/completions") {
        request.on("end", () => {
          if (failCompletions) {
            response.statusCode = 500;
            response.end("upstream failed\n");
            return;
          }
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          });
          const base = {
            id: "chatcmpl-codepunk-test",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "local/chat",
          };
          response.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "CODEPUNK_MODEL_OK" },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 3,
                completion_tokens: 2,
                total_tokens: 5,
              },
            })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
        });
        request.resume();
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const imported = await runCli(
        [
          "models",
          "import",
          `http://127.0.0.1:${address.port}/v1`,
          "--provider",
          "local",
          "--api",
          "openai-completions",
          "--api-key",
          "local",
        ],
        { cwd: project, home },
      );
      assert.match(imported.stdout, /imported 1 model/u);
      assert.match(imported.stdout, /codepunk models list/u);
      assert.match(imported.stdout, /codepunk models set local\/<model-id>/u);
      const explicitTest = await runCli(
        ["models", "test", "local/local/chat", "--json"],
        { cwd: project, home },
      );
      const explicitResult = JSON.parse(explicitTest.stdout);
      assert.equal(explicitResult.ok, true);
      assert.equal(explicitResult.provider, "local");
      assert.equal(explicitResult.id, "local/chat");
      assert.equal(explicitResult.stop_reason, "stop");
      assert.equal(explicitResult.text, "CODEPUNK_MODEL_OK");
      assert.ok(explicitResult.latency_ms >= 0);
      await assert.rejects(
        () =>
          runCli(["models", "test", "local/missing"], { cwd: project, home }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /local\/missing is not available/u);
          return true;
        },
      );
      const selected = await runCli(
        ["models", "set", "local/local/chat", "--thinking", "high"],
        { cwd: project, home },
      );
      assert.match(selected.stdout, /model set to local\/local\/chat/u);
      const defaultTest = await runCli(["models", "test"], {
        cwd: project,
        home,
      });
      assert.match(defaultTest.stdout, /model: local\/local\/chat/u);
      assert.match(defaultTest.stdout, /status: ok/u);
      assert.match(defaultTest.stdout, /stop: stop/u);
      assert.match(defaultTest.stdout, /CODEPUNK_MODEL_OK/u);
      const listed = await runCli(["models", "list"], {
        cwd: project,
        home,
      });
      assert.match(listed.stdout, /selected: local\/local\/chat/u);
      assert.match(listed.stdout, /\[auth, selected, custom, reasoning\]/u);
      // On Windows, doctor exits non-zero because srt is a blocking issue.
      // The model-health line is still the assertion under test here.
      const doctor = await runCli(["doctor"], { cwd: project, home }).catch(
        (error) => error,
      );
      assert.match(
        doctor.stdout,
        /\[ok\] model: model catalog and credential/u,
      );
      failCompletions = true;
      await assert.rejects(
        () =>
          runCli(["models", "test", "--json"], {
            cwd: project,
            home,
          }),
        (error) => {
          assert.equal(error.code, 1);
          const result = JSON.parse(error.stdout);
          assert.equal(result.ok, false);
          assert.equal(result.stop_reason, "error");
          assert.match(result.error, /500/u);
          return true;
        },
      );
      await assert.rejects(
        () => runCli(["models", "remove", "local"], { cwd: project, home }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /owns the selected model/u);
          return true;
        },
      );
      await fs.writeFile(
        path.join(home, "config.toml"),
        '[model]\nthinking = "high"\n',
      );
      const removed = await runCli(["models", "remove", "local"], {
        cwd: project,
        home,
      });
      assert.match(removed.stdout, /removed provider local/u);
      assert.match(removed.stdout, /no custom providers remain/u);
      const emptyAgain = await runCli(["models", "list"], {
        cwd: project,
        home,
      });
      assert.match(emptyAgain.stdout, /no models configured/u);
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

test("skills and plugins commands manage persisted capability state", async () => {
  await withTempDirectory("codepunk-cli-capabilities-", async (root) => {
    const { project, home } = await makeProject(root);
    const source = path.join(root, "source", "helper");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(
      path.join(source, "SKILL.md"),
      [
        "---",
        "name: helper",
        "description: Managed through the CLI",
        "---",
        "",
        "Use the helper.",
        "",
      ].join("\n"),
    );
    const pluginSource = path.join(root, "source", "hello.mjs");
    await fs.writeFile(pluginSource, "export default function () {}\n");

    const addedSkill = await runCli(
      ["skills", "add", source, "--scope", "user"],
      { cwd: project, home },
    );
    assert.match(addedSkill.stdout, /installed skill helper \(user\)/u);
    const skillList = await runCli(["skills", "list", "--json"], {
      cwd: project,
      home,
    });
    const skills = JSON.parse(skillList.stdout);
    assert.deepEqual(
      skills.skills.map((item) => [item.name, item.scope]),
      [["helper", "user"]],
    );
    await assert.rejects(
      () =>
        runCli(["skills", "add", source, "--scope", "user"], {
          cwd: project,
          home,
        }),
      /already exists/u,
    );

    const addedPlugin = await runCli(["plugins", "add", pluginSource], {
      cwd: project,
      home,
    });
    assert.match(addedPlugin.stdout, /installed plugin hello\.mjs/u);
    const disabled = await runCli(["plugins", "list", "--json"], {
      cwd: project,
      home,
    });
    assert.equal(JSON.parse(disabled.stdout).enabled, false);

    const enabled = await runCli(["plugins", "enable"], {
      cwd: project,
      home,
    });
    assert.match(enabled.stdout, /applies to the next Codepunk process/u);
    const capabilities = await runCli(["capabilities", "--json"], {
      cwd: project,
      home,
    });
    const snapshot = JSON.parse(capabilities.stdout);
    assert.equal(snapshot.plugins.enabled, true);
    assert.equal(snapshot.plugins.files.length, 1);

    await runCli(["plugins", "disable"], { cwd: project, home });
    await runCli(["plugins", "remove", "hello.mjs"], {
      cwd: project,
      home,
    });
    await runCli(["skills", "remove", "helper", "--scope", "user"], {
      cwd: project,
      home,
    });
    const empty = await runCli(["skills", "list", "--json"], {
      cwd: project,
      home,
    });
    assert.deepEqual(JSON.parse(empty.stdout).skills, []);
  });
});

async function createReleaseSmokeToolchain(root) {
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  const nodePath = path.join(bin, "node");
  await fs.writeFile(nodePath, "#!/bin/sh\nprintf 'v22.19.0\\n'\n");
  const npmPath = path.join(bin, "npm");
  await fs.writeFile(
    npmPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      "  printf '10.9.0\\n'",
      "  exit 0",
      "fi",
      'prefix=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--prefix" ]; then',
      '    prefix="$2"',
      "    shift 2",
      "    continue",
      "  fi",
      "  shift",
      "done",
      'mkdir -p "$prefix/bin"',
      "cat > \"$prefix/bin/codepunk\" <<'CODEPUNK'",
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      '  if [ "${FAKE_VERSION_MODE:-ok}" = "stale" ]; then',
      "    printf 'codepunk 0.1.0\\nentry: /tmp/codepunk\\nbuilt: 2026-11-18T00:00:00.000Z\\nsource: STALE (newest source 2026-11-18T00:00:00.000Z; run pnpm build)\\n'",
      "  else",
      "    printf 'codepunk 0.1.0\\nentry: /tmp/codepunk\\nbuilt: 2026-11-18T00:00:00.000Z\\nsource: not installed (cannot compare)\\n'",
      "  fi",
      "  exit 0",
      "fi",
      'if [ "$1" = "doctor" ]; then',
      "  printf '[ok] node: Node.js 22.19.0\\n'",
      "  printf '[ok] platform: linux x64\\n'",
      "  printf '[ok] distribution: package version 0.1.0\\n'",
      '  if [ "${FAKE_SRT_ERROR:-}" = "1" ]; then',
      "    printf '[error] srt: synthetic\\n'",
      "  else",
      "    printf '[ok] srt: srt sandbox is available\\n'",
      "  fi",
      "  printf '[error] model: no model configured\\n'",
      '  exit "${FAKE_DOCTOR_EXIT:-1}"',
      "fi",
      "exit 2",
      "CODEPUNK",
      'chmod +x "$prefix/bin/codepunk"',
      "exit 0",
      "",
    ].join("\n"),
  );
  await fs.chmod(nodePath, 0o755);
  await fs.chmod(npmPath, 0o755);
  return bin;
}

test(
  "release-smoke rejects a missing model, sandbox error, or stale build",
  {
    skip:
      process.platform === "win32" ? "release-smoke is a Unix workflow" : false,
  },
  async () => {
    await withTempDirectory("codepunk-release-smoke-", async (root) => {
      const bin = await createReleaseSmokeToolchain(root);
      const script = path.join(REPO_ROOT, "scripts/release-smoke.sh");
      const run = (environment = {}) =>
        execFileAsync("bash", [script, "0.1.0"], {
          cwd: root,
          env: {
            ...process.env,
            HOME: path.join(root, "home"),
            PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
            ...environment,
          },
        });

      const accepted = await run();
      assert.match(accepted.stdout, /release-smoke: doctor=1 errors=1/u);

      await assert.rejects(
        () => run({ FAKE_DOCTOR_EXIT: "0" }),
        (error) => {
          assert.match(error.stderr, /doctor exited 0, expected 1/u);
          return true;
        },
      );
      await assert.rejects(
        () => run({ FAKE_SRT_ERROR: "1" }),
        (error) => {
          assert.match(error.stderr, /doctor output is missing: \[ok\] srt:/u);
          return true;
        },
      );
      await assert.rejects(
        () => run({ FAKE_VERSION_MODE: "stale" }),
        (error) => {
          assert.match(error.stderr, /stale build/u);
          return true;
        },
      );
    });
  },
);
