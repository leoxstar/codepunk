import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import { withTempDirectory, writeFile } from "./support/helpers.mjs";

const core = await importCore();

async function pathsFor(root, projectTrusted = true) {
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  await fs.mkdir(path.join(project, ".codepunk"), { recursive: true });
  await fs.mkdir(path.join(project, ".git"), { recursive: true });
  await fs.mkdir(home, { recursive: true });
  return {
    project,
    home,
    paths: core.projectPaths(
      {
        cwd: project,
        deliveryRoot: project,
        projectId: "agent-profile-test",
      },
      home,
    ),
    projectTrusted,
  };
}

function profile(name, body = "Do the task.") {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} profile`,
    "---",
    body,
    "",
  ].join("\n");
}

test("user profiles load and project profiles require trust", async () => {
  await withTempDirectory("codepunk-agent-profiles-", async (root) => {
    const fixture = await pathsFor(root);
    await writeFile(
      path.join(fixture.home, "agents", "scout.md"),
      profile("scout"),
    );
    await writeFile(
      path.join(fixture.project, ".codepunk", "agents", "reviewer.md"),
      profile("reviewer"),
    );

    const trusted = await core.loadAgentProfiles(fixture.paths, {
      projectTrusted: true,
    });
    assert.deepEqual(
      trusted.profiles.map((entry) => `${entry.name}:${entry.source}`),
      ["reviewer:project", "scout:user"],
    );
    assert.deepEqual(trusted.profiles[1].tools, {
      read: true,
      write: false,
      edit: false,
      shell: false,
      search: true,
      memory_search: false,
    });

    const untrusted = await core.loadAgentProfiles(fixture.paths, {
      projectTrusted: false,
    });
    assert.deepEqual(
      untrusted.profiles.map((entry) => `${entry.name}:${entry.source}`),
      ["scout:user"],
    );

    const defaults = await core.loadAgentProfiles(fixture.paths);
    assert.deepEqual(
      defaults.profiles.map((entry) => `${entry.name}:${entry.source}`),
      ["scout:user"],
    );
  });
});

test("project profiles override a user profile with the same name", async () => {
  await withTempDirectory("codepunk-agent-override-", async (root) => {
    const fixture = await pathsFor(root);
    await writeFile(
      path.join(fixture.home, "agents", "worker.md"),
      profile("worker", "User worker."),
    );
    await writeFile(
      path.join(fixture.project, ".codepunk", "agents", "worker.md"),
      [
        "---",
        "name: worker",
        "description: project worker",
        "tools: read, write",
        "model: local/primary",
        "fallback: local/secondary, local/tertiary",
        "thinking: high",
        "---",
        "Project worker.",
        "",
      ].join("\n"),
    );

    const bundle = await core.loadAgentProfiles(fixture.paths, {
      projectTrusted: true,
    });
    assert.equal(bundle.profiles.length, 1);
    const worker = bundle.profiles[0];
    assert.equal(worker.source, "project");
    assert.equal(worker.systemPrompt, "Project worker.");
    assert.equal(worker.model, "local/primary");
    assert.deepEqual(worker.fallback, ["local/secondary", "local/tertiary"]);
    assert.equal(worker.thinking, "high");
    assert.equal(worker.tools.write, true);
    assert.equal(worker.tools.shell, false);
    assert.match(worker.sha256, /^sha256:[a-f0-9]{64}$/u);
  });
});

test("invalid or linked profile files are ignored with warnings", async () => {
  await withTempDirectory("codepunk-agent-invalid-", async (root) => {
    const fixture = await pathsFor(root);
    const userAgents = path.join(fixture.home, "agents");
    await writeFile(
      path.join(userAgents, "bad-tool.md"),
      [
        "---",
        "name: bad-tool",
        "description: invalid",
        "tools: memory_search",
        "---",
        "Invalid.",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(userAgents, "bad-fallback.md"),
      [
        "---",
        "name: bad-fallback",
        "description: invalid",
        "fallback: local/other",
        "---",
        "Invalid.",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(root, "outside.md"), profile("linked"));
    await fs.symlink(
      path.join(root, "outside.md"),
      path.join(userAgents, "linked.md"),
    );

    const bundle = await core.loadAgentProfiles(fixture.paths, {
      projectTrusted: true,
    });
    assert.deepEqual(bundle.profiles, []);
    assert.equal(bundle.warnings.length, 3);
    assert.ok(bundle.warnings.some((entry) => entry.includes("memory_search")));
    assert.ok(bundle.warnings.some((entry) => entry.includes("bad-fallback")));
    assert.ok(bundle.warnings.some((entry) => entry.includes("linked.md")));
  });
});

test("shell profiles are rejected until an exact command allowlist exists", async () => {
  await withTempDirectory("codepunk-agent-shell-", async (root) => {
    const fixture = await pathsFor(root);
    await writeFile(
      path.join(fixture.home, "agents", "runner.md"),
      [
        "---",
        "name: runner",
        "description: shell profile",
        "tools: read, shell",
        "---",
        "Run commands.",
        "",
      ].join("\n"),
    );

    const bundle = await core.loadAgentProfiles(fixture.paths, {
      projectTrusted: true,
    });
    assert.deepEqual(bundle.profiles, []);
    assert.equal(bundle.warnings.length, 1);
    assert.match(bundle.warnings[0], /shell is not supported/u);
  });
});
