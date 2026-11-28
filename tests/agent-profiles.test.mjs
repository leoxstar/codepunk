import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import {
  createLinkedEntry,
  withTempDirectory,
  writeFile,
} from "./support/helpers.mjs";

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

test("agent profiles accept nested provider model ids", async () => {
  await withTempDirectory("codepunk-agent-nested-model-", async (root) => {
    const fixture = await pathsFor(root);
    await writeFile(
      path.join(fixture.home, "agents", "nested.md"),
      [
        "---",
        "name: nested",
        "description: nested provider model",
        "model: openrouter/anthropic/claude-sonnet-4.5",
        "fallback: openrouter/openai/gpt-6.1, openrouter/google/gemini-3-pro",
        "---",
        "Nested model profile.",
        "",
      ].join("\n"),
    );
    const bundle = await core.loadAgentProfiles(fixture.paths);
    const nested = bundle.profiles.find((entry) => entry.name === "nested");
    assert.equal(nested?.model, "openrouter/anthropic/claude-sonnet-4.5");
    assert.deepEqual(nested?.fallback, [
      "openrouter/openai/gpt-6.1",
      "openrouter/google/gemini-3-pro",
    ]);
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
    await createLinkedEntry(
      path.join(root, "outside.md"),
      path.join(userAgents, "linked.md"),
      path.join(root, "linked-target"),
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

test("shell profiles are rejected without an exact command allowlist", async () => {
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
    assert.match(bundle.warnings[0], /shell-allow/u);
  });
});

test("profiles parse a permission ceiling, exact shell argv, and network policy", async () => {
  await withTempDirectory("codepunk-agent-policy-", async (root) => {
    const fixture = await pathsFor(root);
    await writeFile(
      path.join(fixture.home, "agents", "runner.md"),
      [
        "---",
        "name: runner",
        "description: bounded shell profile",
        "tools: read, search, shell",
        "permission: standard",
        "shell-allow:",
        '  - ["printf", "profile-shell"]',
        '  - ["git", "status"]',
        "network-allow: api.example.com, *.example.org",
        "network-deny: metadata.example.com",
        "---",
        "Run only the declared commands.",
        "",
      ].join("\n"),
    );

    const bundle = await core.loadAgentProfiles(fixture.paths, {
      projectTrusted: true,
    });
    assert.deepEqual(bundle.warnings, []);
    assert.equal(bundle.profiles.length, 1);
    const runner = bundle.profiles[0];
    assert.equal(runner.permission, "standard");
    assert.equal(runner.tools.shell, true);
    assert.deepEqual(runner.shellAllow, [
      ["printf", "profile-shell"],
      ["git", "status"],
    ]);
    assert.deepEqual(runner.networkAllow, ["api.example.com", "*.example.org"]);
    assert.deepEqual(runner.networkDeny, ["metadata.example.com"]);
    assert.match(
      core.formatAgentProfiles(bundle.profiles),
      /standard: read,shell,search/u,
    );
    assert.match(
      core.formatAgentProfiles(bundle.profiles),
      /api\.example\.com/u,
    );
  });
});

test("profiles reject policy widening, dead network lists, and unsafe shell argv", async () => {
  await withTempDirectory("codepunk-agent-policy-invalid-", async (root) => {
    const fixture = await pathsFor(root);
    const agents = path.join(fixture.home, "agents");
    const cases = [
      [
        "read-only-write.md",
        ["tools: read, write", "permission: read-only"],
        /read-only agent profile/u,
      ],
      [
        "network-no-shell.md",
        ["tools: read, search", "network-allow: api.example.com"],
        /network lists require the shell tool/u,
      ],
      ["shell-no-rules.md", ["tools: read, shell"], /shell-allow/u],
      [
        "rules-no-shell.md",
        ["tools: read, search", "shell-allow:", '  - ["git", "status"]'],
        /shell-allow requires the shell tool/u,
      ],
      [
        "shell-launcher.md",
        [
          "tools: read, shell",
          "shell-allow:",
          '  - ["sh", "-c", "echo unsafe"]',
        ],
        /cannot launch a shell/u,
      ],
      [
        "network-overlap.md",
        [
          "tools: read, shell",
          "shell-allow:",
          '  - ["git", "status"]',
          "network-allow: api.example.com",
          "network-deny: api.example.com",
        ],
        /network allow and deny overlap/u,
      ],
    ];
    for (const [file, lines] of cases) {
      await writeFile(
        path.join(agents, file),
        [
          "---",
          `name: ${file.replace(/\.md$/u, "")}`,
          "description: invalid profile",
          ...lines,
          "---",
          "Invalid.",
          "",
        ].join("\n"),
      );
    }

    const bundle = await core.loadAgentProfiles(fixture.paths, {
      projectTrusted: true,
    });
    assert.deepEqual(bundle.profiles, []);
    assert.equal(bundle.warnings.length, cases.length);
    for (const [, , expected] of cases) {
      assert.ok(
        bundle.warnings.some((warning) => expected.test(warning)),
        `missing warning ${expected}`,
      );
    }
  });
});
