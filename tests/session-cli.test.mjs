import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import {
  ensureBuilt,
  trustWorkspace,
  withTempDirectory,
  withoutAmbientProviderEnv,
} from "./support/helpers.mjs";

const execFileAsync = promisify(execFile);
const core = await importCore();
const BASE_ENV = withoutAmbientProviderEnv();

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

test("session CLI renames, archives, exports, deletes, and imports", async () => {
  await withTempDirectory("codepunk-session-cli-", async (root) => {
    const projectRoot = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await trustWorkspace(home, projectRoot);

    const project = await core.findDeliveryRoot(projectRoot);
    const paths = core.projectPaths(project, home);
    const sessionId = "session-cli";
    const store = await core.SessionStore.create({
      rootDir: paths.home,
      cwd: projectRoot,
      projectRoot,
      projectId: project.projectId,
      sessionId,
      now: () => new Date("2026-11-20T00:00:00.000Z"),
      heartbeatMs: 60_000,
    });
    const writer = await store.acquireWriter();
    try {
      await store.append("user/input", {
        run_id: "run-cli",
        text: "hello from the cli test",
      });
    } finally {
      await writer.release();
    }

    const renamed = await runCli(
      ["sessions", "rename", sessionId, "Renamed", "session"],
      { cwd: projectRoot, home },
    );
    assert.match(renamed.stdout, /renamed session-cli -> Renamed session/u);
    const reopened = await core.SessionStore.open({
      rootDir: paths.home,
      cwd: projectRoot,
      projectId: project.projectId,
      sessionId,
    });
    assert.equal(reopened.metadata.title, "Renamed session");

    await runCli(["sessions", "archive", sessionId], {
      cwd: projectRoot,
      home,
    });
    const hidden = await runCli(["sessions", "--json"], {
      cwd: projectRoot,
      home,
    });
    assert.deepEqual(JSON.parse(hidden.stdout), []);
    const visible = await runCli(["sessions", "--include-archived", "--json"], {
      cwd: projectRoot,
      home,
    });
    const listed = JSON.parse(visible.stdout);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].archived, true);

    const bundlePath = path.join(root, "session-cli.json");
    const exported = await runCli(
      ["sessions", "export", sessionId, "--output", bundlePath],
      { cwd: projectRoot, home },
    );
    assert.match(exported.stdout, /1 event\(s\)/u);
    const bundle = JSON.parse(await fs.readFile(bundlePath, "utf8"));
    assert.equal(bundle.format, "codepunk/session-bundle");

    await assert.rejects(
      () =>
        runCli(["sessions", "delete", sessionId], { cwd: projectRoot, home }),
      (error) => {
        assert.match(error.stderr, /requires --confirm/u);
        return true;
      },
    );
    const deleted = await runCli(
      ["sessions", "delete", sessionId, "--confirm"],
      { cwd: projectRoot, home },
    );
    assert.match(deleted.stdout, /deleted session-cli \(backup /u);

    const imported = await runCli(["sessions", "import", bundlePath], {
      cwd: projectRoot,
      home,
    });
    assert.match(imported.stdout, /imported session-cli/u);
    const restored = await core.SessionStore.open({
      rootDir: paths.home,
      cwd: projectRoot,
      projectId: project.projectId,
      sessionId,
    });
    assert.equal(restored.allEvents.length, 1);
    assert.equal(restored.allEvents[0].data.text, "hello from the cli test");
  });
});
