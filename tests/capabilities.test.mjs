import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import {
  ensureBuilt,
  trustWorkspace,
  withTempDirectory,
} from "./support/helpers.mjs";

const core = await importCore();

async function writeSkill(root, name, description) {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
      "",
      `# ${name}`,
      "",
      "Reference text.",
      "",
    ].join("\n"),
  );
}

async function writeFixture(project, home) {
  await fs.mkdir(path.join(home, "extensions"), { recursive: true });
  await fs.writeFile(
    path.join(home, "mcp.toml"),
    [
      "[servers.github]",
      'command = "npx"',
      'args = ["-y", "server-github", "--token", "ghp_abcdefghijklmnopqrst"]',
      'cwd = "."',
      "",
      "[servers.github.env]",
      'GITHUB_TOKEN = "ghp_abcdefghijklmnopqrst"',
      "",
    ].join("\n"),
  );
  await writeSkill(path.join(home, "skills"), "user-helper", "User notes");
  await writeSkill(
    path.join(project, ".codepunk", "skills"),
    "project-helper",
    "Project notes",
  );
  await fs.writeFile(
    path.join(home, "extensions", "audit.js"),
    "export default function () {}\n",
  );
}

function projectPathsFor(project, home) {
  return core.projectPaths(
    {
      cwd: project,
      deliveryRoot: project,
      projectId: core.projectIdFor(project),
    },
    home,
  );
}

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

test("capability inventory covers MCP, skills, and plugins without secrets", async () => {
  await withTempDirectory("codepunk-capabilities-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await writeFixture(project, home);
    await trustWorkspace(home, project);
    const paths = projectPathsFor(project, home);
    const snapshot = await core.collectCapabilities(paths);

    assert.equal(snapshot.mcp.error, null);
    assert.equal(snapshot.mcp.servers.length, 1);
    const server = snapshot.mcp.servers[0];
    assert.equal(server.name, "github");
    assert.equal(server.command, "npx");
    assert.deepEqual(server.env_keys, ["GITHUB_TOKEN"]);
    assert.ok(server.args.includes("[REDACTED_TOKEN]"));
    assert.equal(
      JSON.stringify(snapshot).includes("ghp_abcdefghijklmnopqrst"),
      false,
    );

    assert.deepEqual(
      snapshot.skills.items.map((skill) => ({
        name: skill.name,
        scope: skill.scope,
        description: skill.description,
      })),
      [
        {
          name: "project-helper",
          scope: "project",
          description: "Project notes",
        },
        {
          name: "user-helper",
          scope: "user",
          description: "User notes",
        },
      ],
    );
    assert.equal(snapshot.plugins.enabled, false);
    assert.equal(snapshot.plugins.files.length, 1);

    const text = core.formatCapabilities(snapshot);
    assert.match(text, /codepunk capabilities/u);
    assert.match(text, /MCP servers \(user scope\)/u);
    assert.match(text, /github/u);
    assert.match(text, /GITHUB_TOKEN/u);
    assert.match(text, /project-helper/u);
    assert.match(text, /Plugins \(opt-in, 1 file\)/u);
    assert.doesNotMatch(text, /ghp_abcdefghijklmnopqrst/u);
  });
});

test("project MCP configuration is inert in the capability snapshot", async () => {
  await withTempDirectory("codepunk-capabilities-mcp-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(path.join(project, ".codepunk"), { recursive: true });
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(project, ".codepunk", "mcp.toml"),
      '[servers.github]\ncommand = "npx"\n',
    );
    const snapshot = await core.collectCapabilities(
      projectPathsFor(project, home),
    );
    assert.equal(snapshot.mcp.error, null);
    assert.equal(snapshot.mcp.servers.length, 0);
  });
});

test("codepunk capabilities emits text and JSON", async () => {
  await withTempDirectory("codepunk-capabilities-cli-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await writeFixture(project, home);
    await trustWorkspace(home, project);

    const json = await runCli(["capabilities", "--json"], {
      cwd: project,
      home,
    });
    assert.equal(json.code, 0, json.stderr);
    const snapshot = JSON.parse(json.stdout);
    assert.equal(snapshot.mcp.servers[0].name, "github");
    assert.equal(snapshot.skills.items.length, 2);
    assert.equal(snapshot.plugins.files.length, 1);
    assert.equal(json.stdout.includes("ghp_abcdefghijklmnopqrst"), false);

    const text = await runCli(["capabilities"], { cwd: project, home });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /codepunk capabilities/u);
    assert.match(text.stdout, /Skills \(2\)/u);
    assert.match(text.stdout, /Plugins \(opt-in, 1 file\)/u);
  });
});

test("an untrusted broken project MCP config is skipped without failing", async () => {
  await withTempDirectory("codepunk-capabilities-exit-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(path.join(project, ".codepunk"), { recursive: true });
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(project, ".codepunk", "mcp.toml"),
      '[servers.github]\ncommand = "npx"\n',
    );
    const result = await runCli(["capabilities", "--json"], {
      cwd: project,
      home,
    });
    assert.equal(result.code, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.mcp.error, null);
    assert.equal(snapshot.mcp.servers.length, 0);
  });
});

test("a project MCP config is inert in the capability inventory", async () => {
  await withTempDirectory("codepunk-capabilities-exit-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(path.join(project, ".codepunk"), { recursive: true });
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(project, ".codepunk", "mcp.toml"),
      '[servers.github]\ncommand = "npx"\n',
    );
    await trustWorkspace(home, project);
    const result = await runCli(["capabilities", "--json"], {
      cwd: project,
      home,
    });
    assert.equal(result.code, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.mcp.error, null);
    assert.equal(snapshot.mcp.servers.length, 0);
  });
});

test("capabilities does not create project or home state", async () => {
  await withTempDirectory("codepunk-capabilities-readonly-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    const result = await runCli(["capabilities"], { cwd: project, home });
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(
      () => fs.access(path.join(project, ".codepunk")),
      /ENOENT/u,
    );
    await assert.rejects(
      () => fs.access(path.join(home, "projects")),
      /ENOENT/u,
    );
  });
});
