import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import { ensureBuilt, withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();

async function runCli(args, { cwd, home }) {
  const cli = await ensureBuilt();
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: {
      ...process.env,
      CODEPUNK_HOME: home,
      NO_COLOR: "1",
      PI_OFFLINE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test("config path reports config locations without creating state", async () => {
  await withTempDirectory("codepunk-config-path-", async (root) => {
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
    const files = core.configFilePaths(paths);

    const json = await runCli(["config", "path", "--json"], {
      cwd: project,
      home,
    });
    assert.equal(json.code, 0, json.stderr);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.user, files.user);
    assert.equal(payload.project, files.project);
    assert.equal(payload.local, files.local);
    await assert.rejects(
      () => fs.access(path.join(project, ".codepunk")),
      /ENOENT/u,
    );
    await assert.rejects(
      () => fs.access(path.join(home, "projects")),
      /ENOENT/u,
    );

    const text = await runCli(["config", "path"], { cwd: project, home });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /user config:/u);
    assert.match(text.stdout, /project config:/u);
  });
});

test("config shows user layers while unresolved project layers stay skipped", async () => {
  await withTempDirectory("codepunk-config-show-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(path.join(project, ".git"), { recursive: true });
    await fs.mkdir(path.join(project, ".codepunk"), { recursive: true });
    await fs.mkdir(home);
    await fs.writeFile(path.join(project, "AGENTS.md"), "# project\n");
    const paths = core.projectPaths(
      {
        cwd: project,
        deliveryRoot: project,
        projectId: core.projectIdFor(project),
      },
      home,
    );
    const files = core.configFilePaths(paths);
    await fs.writeFile(files.user, '[tools]\nenabled = ["read", "search"]\n');
    await fs.writeFile(files.project, '[tools]\nenabled = ["read"]\n');

    const untrusted = await runCli(["config", "--json"], {
      cwd: project,
      home,
    });
    assert.equal(untrusted.code, 0, untrusted.stderr);
    const skipped = JSON.parse(untrusted.stdout);
    assert.equal(skipped.trust.mode, "none");
    assert.equal(skipped.trust.source, "default");
    assert.deepEqual(skipped.config.tools.enabled, ["read", "search"]);
    assert.ok(
      skipped.warnings.some((warning) =>
        warning.includes("project config ignored"),
      ),
    );

    const trusted = await runCli(["config", "--trust", "--json"], {
      cwd: project,
      home,
    });
    assert.equal(trusted.code, 0, trusted.stderr);
    const loaded = JSON.parse(trusted.stdout);
    assert.equal(loaded.trust.mode, "all");
    assert.deepEqual(loaded.config.tools.enabled, ["read"]);

    const text = await runCli(["config"], { cwd: project, home });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /codepunk configuration/u);
    assert.match(text.stdout, /project config: .* \(not loaded\)/u);
    assert.match(text.stdout, /next: codepunk trust grant/u);
  });
});

test("config rejects an unknown subject", async () => {
  await withTempDirectory("codepunk-config-invalid-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    const result = await runCli(["config", "nope"], { cwd: project, home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown config command/u);
  });
});
