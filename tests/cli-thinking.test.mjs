import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { importCore, importSource } from "./support/core.mjs";
import {
  ensureBuilt,
  trustWorkspace,
  withTempDirectory,
  withoutAmbientProviderEnv,
} from "./support/helpers.mjs";

const execFileAsync = promisify(execFile);
const core = await importCore();
const { configOverrides } = await importSource(
  "packages/cli/src/args/overrides.ts",
);
const BASE_ENV = withoutAmbientProviderEnv();
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

async function runCli(args, { cwd, home }) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [await ensureBuilt(), ...args],
      {
        cwd,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          NO_COLOR: "1",
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function snapshotTree(root) {
  const entries = await fs.readdir(root, { recursive: true });
  const snapshot = [];
  for (const entry of entries.sort()) {
    const filePath = path.join(root, entry);
    const stat = await fs.lstat(filePath);
    if (stat.isDirectory()) {
      snapshot.push(`${entry}/`);
    } else if (stat.isFile()) {
      const digest = createHash("sha256")
        .update(await fs.readFile(filePath))
        .digest("hex");
      snapshot.push(`${entry} ${digest}`);
    } else {
      snapshot.push(`${entry} other`);
    }
  }
  return snapshot.join("\n");
}

async function makeProject(root) {
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: project });
  await fs.writeFile(
    path.join(home, "config.toml"),
    '[sandbox]\nmode = "uncovered"\n\n[model]\nthinking = "medium"\n',
  );
  await trustWorkspace(home, project);
  const realProject = await fs.realpath(project);
  const paths = core.projectPaths(
    {
      cwd: realProject,
      deliveryRoot: realProject,
      projectId: core.projectIdFor(realProject),
    },
    home,
  );
  await fs.mkdir(paths.sessionsDir, { recursive: true });
  await fs.mkdir(paths.evidenceDir, { recursive: true });
  await fs.writeFile(
    path.join(paths.sessionsDir, "sentinel.jsonl"),
    '{"type":"sentinel"}\n',
  );
  await fs.writeFile(
    path.join(paths.evidenceDir, "sentinel.jsonl"),
    '{"type":"sentinel"}\n',
  );
  return { project, home, paths };
}

function assertInvalidThinking(error) {
  assert.ok(error instanceof core.ConfigError);
  assert.equal(error.key, "model.thinking");
  assert.match(error.message, /BOGUS/u);
  for (const level of THINKING_LEVELS) {
    assert.ok(error.message.includes(level), `missing level ${level}`);
  }
  return true;
}

test("valid thinking overrides reach the effective config summary", async () => {
  await withTempDirectory("codepunk-thinking-valid-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    const paths = core.projectPaths(
      {
        cwd: project,
        deliveryRoot: project,
        projectId: core.projectIdFor(project),
      },
      home,
    );

    for (const level of THINKING_LEVELS) {
      const overrides = configOverrides({ thinking: level });
      assert.deepEqual(overrides, { thinking: level });
      const loaded = await core.loadConfig(paths, {}, overrides);
      assert.equal(loaded.config.model.thinking, level);
      assert.ok(
        core
          .configSummary(loaded.config)
          .includes(`model: auto/auto (${level})`),
      );
    }
  });
});

test("config rejects a direct invalid thinking override", async () => {
  await withTempDirectory("codepunk-thinking-core-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    const paths = core.projectPaths(
      {
        cwd: project,
        deliveryRoot: project,
        projectId: core.projectIdFor(project),
      },
      home,
    );

    await assert.rejects(
      () => core.loadConfig(paths, {}, { thinking: "BOGUS" }),
      assertInvalidThinking,
    );
    assert.throws(
      () => configOverrides({ thinking: "BOGUS" }),
      assertInvalidThinking,
    );
  });
});

test("invalid --thinking exits 2 without changing state", async () => {
  await withTempDirectory("codepunk-thinking-invalid-", async (root) => {
    const { project, home } = await makeProject(root);
    await ensureBuilt();
    const before = await snapshotTree(home);

    for (const extraArgs of [
      [],
      ["--model", "ghost/model"],
      ["--provider", "ghost"],
      ["--continue"],
    ]) {
      const result = await runCli(
        ["--thinking", "BOGUS", "-p", "hello", ...extraArgs],
        { cwd: project, home },
      );
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /^codepunk: /u);
      assert.match(result.stderr, /BOGUS/u);
      for (const level of THINKING_LEVELS) {
        assert.ok(
          result.stderr.includes(level),
          `missing suggested level ${level}`,
        );
      }
    }

    assert.equal(await snapshotTree(home), before);
  });
});
