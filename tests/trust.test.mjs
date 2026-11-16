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
  writeFile,
} from "./support/helpers.mjs";

const core = await importCore();
const execFileAsync = promisify(execFile);

async function runCli(args, { cwd, home }) {
  return execFileAsync(process.execPath, [await ensureBuilt(), ...args], {
    cwd,
    env: {
      ...process.env,
      CODEPUNK_HOME: home,
      NO_COLOR: "1",
      PI_OFFLINE: "1",
    },
  });
}

async function setupProject(
  root,
  { trusted = false, projectConfig = true } = {},
) {
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: project });
  await writeFile(
    path.join(home, "config.toml"),
    '[sandbox]\nmode = "uncovered"\n',
  );
  if (projectConfig) {
    await writeFile(
      path.join(project, ".codepunk", "config.toml"),
      ["[memory]", "max_tokens = 400", ""].join("\n"),
    );
  }
  if (trusted) {
    await trustWorkspace(home, project);
  }
  return { project, home };
}

test("a bare .codepunk directory does not require trust", async () => {
  await withTempDirectory("codepunk-trust-resources-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(path.join(project, ".codepunk"), { recursive: true });
    assert.deepEqual(
      await core.findTrustRequiringProjectResources(project),
      [],
    );
    await writeFile(path.join(project, "AGENTS.md"), "PROJECT_RULE\n");
    assert.deepEqual(await core.findTrustRequiringProjectResources(project), [
      "AGENTS.md",
    ]);
    assert.deepEqual(
      await core.findTrustRequiringProjectResources(project, project, {
        includeInstructions: false,
      }),
      [],
    );
    await fs.rm(path.join(project, "AGENTS.md"));
    await writeFile(
      path.join(project, ".codepunk", "config.toml"),
      "[session]\nheartbeat_seconds = 7\n",
    );
    assert.deepEqual(await core.findTrustRequiringProjectResources(project), [
      ".codepunk/config.toml",
    ]);
    await fs.rm(path.join(project, ".codepunk", "config.toml"));
    await writeFile(
      path.join(project, ".codepunk", "skills", "probe", "SKILL.md"),
      "---\nname: probe\ndescription: probe\n---\nbody\n",
    );
    assert.deepEqual(await core.findTrustRequiringProjectResources(project), [
      ".codepunk/skills",
    ]);
    assert.deepEqual(
      await core.findTrustRequiringProjectResources(project, project, {
        includeSkills: false,
      }),
      [],
    );
  });
});

test("trust preview identifies resources without following symlinks", async () => {
  await withTempDirectory("codepunk-trust-preview-", async (root) => {
    const project = path.join(root, "project");
    const outside = path.join(root, "outside.toml");
    const configPath = path.join(project, ".codepunk", "config.toml");
    await writeFile(configPath, "[memory]\nmax_tokens = 400\n");
    await writeFile(path.join(project, "AGENTS.md"), "PROJECT_RULE\n");
    await writeFile(
      path.join(project, ".codepunk", "skills", "team", "SKILL.md"),
      "---\nname: team\ndescription: team\n---\nbody\n",
    );
    await writeFile(outside, "OUTSIDE_SECRET\n");
    await fs.symlink(outside, path.join(project, ".codepunk", "local.toml"));

    const previews = await core.previewWorkspaceTrustResources(project);
    const config = previews.find(
      (preview) => preview.path === ".codepunk/config.toml",
    );
    assert.equal(config?.kind, "config");
    assert.equal(config?.type, "file");
    assert.equal(
      config?.bytes,
      Buffer.byteLength("[memory]\nmax_tokens = 400\n"),
    );
    assert.match(config?.sha256 ?? "", /^sha256:[a-f0-9]{64}$/u);
    assert.equal(config?.truncated, false);

    const local = previews.find(
      (preview) => preview.path === ".codepunk/local.toml",
    );
    assert.equal(local?.type, "symlink");
    assert.equal(local?.bytes, null);
    assert.match(local?.sha256 ?? "", /^sha256:[a-f0-9]{64}$/u);

    const skills = previews.find(
      (preview) => preview.path === ".codepunk/skills",
    );
    assert.equal(skills?.kind, "skills");
    assert.equal(skills?.type, "directory");
    assert.ok((skills?.bytes ?? 0) > 0);
    const instructions = previews.find(
      (preview) => preview.path === "AGENTS.md",
    );
    assert.equal(instructions?.kind, "instructions");

    const formatted = core.formatWorkspaceTrust(
      {
        trusted: false,
        source: "default",
        cwd: project,
        root: project,
        resources: previews.map((preview) => preview.path),
        storePath: path.join(root, "home", "trust.json"),
        savedPath: null,
      },
      previews,
    );
    assert.match(formatted, /\[instructions\] AGENTS\.md/u);
    assert.match(formatted, /sha256:[a-f0-9]{64}/u);
    const compact = core.formatWorkspaceTrustResourcePreview(previews[0], {
      compactDigest: true,
    });
    assert.match(compact, /sha256:[a-f0-9]{12}\u2026/u);
    assert.doesNotMatch(compact, /sha256:[a-f0-9]{64}/u);

    const before = config?.sha256;
    await writeFile(configPath, "[memory]\nmax_tokens = 500\n");
    const changed = await core.previewWorkspaceTrustResources(project);
    assert.notEqual(
      changed.find((preview) => preview.path === ".codepunk/config.toml")
        ?.sha256,
      before,
    );
  });
});

test("every protected resource maps to an explicit skipped class", async () => {
  const trust = {
    trusted: false,
    source: "default",
    cwd: "/workspace",
    root: "/workspace",
    resources: [
      ".codepunk/config.toml",
      ".codepunk/local.toml",
      ".codepunk/policy.toml",
      ".codepunk/skills",
    ],
    storePath: "/home/trust.json",
    savedPath: null,
  };
  assert.deepEqual(core.skippedProjectResources(trust), [
    "project-config",
    "project-policy",
    "project-skills",
  ]);
  assert.match(
    core.formatWorkspaceTrust(trust),
    /not loaded \(untrusted workspace\): project-config, project-policy, project-skills/u,
  );
  const empty = {
    ...trust,
    resources: [],
    savedPath: "/tmp/project",
    source: "saved",
  };
  assert.doesNotMatch(core.formatWorkspaceTrust(empty), /untrusted workspace/u);
  assert.doesNotMatch(core.formatWorkspaceTrust(empty), /scope:/u);
  assert.match(
    core.formatWorkspaceTrust({
      ...trust,
      source: "prompt",
      savedPath: null,
    }),
    /scope: this session only/u,
  );
  assert.match(
    core.formatWorkspaceTrust({
      ...trust,
      source: "flag",
      savedPath: null,
    }),
    /scope: this run only/u,
  );
});

test("trust preview reports an unreadable resource instead of failing startup", async () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return;
  }
  await withTempDirectory("codepunk-trust-unreadable-", async (root) => {
    const project = path.join(root, "project");
    const locked = path.join(project, ".codepunk", "skills", "locked");
    await writeFile(
      path.join(locked, "SKILL.md"),
      "---\nname: locked\ndescription: locked\n---\nbody\n",
    );
    await fs.chmod(locked, 0o000);
    try {
      const resources = await core.findTrustRequiringProjectResources(project);
      assert.deepEqual(resources, [".codepunk/skills"]);

      const previews = await core.previewWorkspaceTrustResources(project);
      const skills = previews.find(
        (preview) => preview.path === ".codepunk/skills",
      );
      assert.equal(skills?.type, "directory");
      assert.equal(skills?.bytes, null);
      assert.equal(skills?.sha256, null);
      assert.equal(skills?.reason, "unreadable");
      assert.match(
        core.formatWorkspaceTrust(
          {
            trusted: false,
            source: "default",
            cwd: project,
            root: project,
            resources,
            storePath: path.join(root, "home", "trust.json"),
            savedPath: null,
          },
          previews,
        ),
        /\[skills\] \.codepunk\/skills \(directory\)\n    unreadable/u,
      );
    } finally {
      await fs.chmod(locked, 0o700);
    }
  });
});

test("trust preview does not read through a symlinked resource directory", async () => {
  await withTempDirectory("codepunk-trust-linked-dir-", async (root) => {
    const project = path.join(root, "project");
    const outside = path.join(root, "outside");
    await writeFile(
      path.join(outside, "config.toml"),
      "[memory]\nmax_tokens = 999\n",
    );
    await writeFile(
      path.join(outside, "skills", "team", "SKILL.md"),
      "---\nname: team\ndescription: team\n---\nbody\n",
    );
    await fs.mkdir(project, { recursive: true });
    await fs.symlink(outside, path.join(project, ".codepunk"));

    const previews = await core.previewWorkspaceTrustResources(project);
    assert.ok(previews.length > 0);
    for (const preview of previews) {
      assert.equal(preview.type, "symlink");
      assert.equal(preview.reason, "symlink-ancestor");
      // A linked resource must not leak the size or digest of outside data.
      assert.equal(preview.bytes, null);
    }
    const config = previews.find(
      (preview) => preview.path === ".codepunk/config.toml",
    );
    const formatted = core.formatWorkspaceTrustResourcePreview(config);
    assert.match(formatted, /\[config\] .* \(symlink\)/u);
    assert.match(formatted, /\n    sha256:[a-f0-9]{64}\n/u);
    assert.match(formatted, /\n    symlink-ancestor$/u);
  });
});

test("trust status names resources excluded by one-session isolation", () => {
  const trust = {
    trusted: true,
    source: "no-resources",
    cwd: "/workspace",
    root: "/workspace",
    resources: [],
    storePath: "/home/trust.json",
    savedPath: null,
  };
  assert.doesNotMatch(
    core.formatWorkspaceTrust(trust),
    /excluded from this session/u,
  );
  const isolated = core.formatWorkspaceTrust(trust, [], {
    excluded: ["project skills (--no-skills or --bare)"],
  });
  assert.match(isolated, /project resources: none/u);
  assert.match(
    isolated,
    /excluded from this session's trust check: project skills \(--no-skills or --bare\)/u,
  );
});

test("project MCP files stay inert and do not gate trust", async () => {
  await withTempDirectory("codepunk-trust-unsupported-", async (root) => {
    const project = path.join(root, "project");
    await writeFile(
      path.join(project, ".codepunk", "mcp.toml"),
      '[servers.probe]\ncommand = "probe"\n',
    );
    await writeFile(
      path.join(project, ".codepunk", "extensions", "probe.ts"),
      "export default () => undefined;\n",
    );
    await writeFile(
      path.join(project, ".codepunk", "hooks", "probe.sh"),
      "#!/bin/sh\n",
    );
    assert.deepEqual(
      await core.findTrustRequiringProjectResources(project),
      [],
    );
    await fs.rm(path.join(project, ".codepunk", "mcp.toml"));
    assert.deepEqual(
      await core.findTrustRequiringProjectResources(project),
      [],
    );
  });
});

test("a project MCP file alone does not require a trust decision", async () => {
  await withTempDirectory("codepunk-trust-mcp-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await writeFile(
      path.join(project, ".codepunk", "mcp.toml"),
      '[servers.probe]\ncommand = "probe"\n',
    );
    const trust = await core.resolveWorkspaceTrust({
      cwd: project,
      root: project,
      home,
    });
    assert.equal(trust.trusted, true);
    assert.equal(trust.source, "no-resources");
    assert.deepEqual(trust.resources, []);
    assert.deepEqual(core.skippedProjectResources(trust), []);
  });
});

test("project instruction files require the workspace decision", async () => {
  await withTempDirectory("codepunk-trust-instructions-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await writeFile(
      path.join(project, "AGENTS.md"),
      "project-rule: stay inside the workspace\n",
    );
    await writeFile(
      path.join(home, "AGENTS.md"),
      "user-rule: answer in Chinese\n",
    );

    assert.deepEqual(await core.findTrustRequiringProjectResources(project), [
      "AGENTS.md",
    ]);
    const trust = await core.resolveWorkspaceTrust({
      cwd: project,
      root: project,
      home,
    });
    assert.equal(trust.trusted, false);
    assert.equal(trust.source, "default");
    assert.deepEqual(core.skippedProjectResources(trust), [
      "project-instructions",
    ]);

    const skipped = await core.loadContext({
      cwd: project,
      deliveryRoot: project,
      codepunkHome: home,
      projectTrusted: false,
    });
    assert.doesNotMatch(skipped.instructionBlock, /project-rule/u);
    assert.match(skipped.instructionBlock, /user-rule/u);
    assert.ok(
      skipped.warnings.some(
        (warning) => warning.code === "context.untrusted_project_instruction",
      ),
    );

    const loaded = await core.loadContext({
      cwd: project,
      deliveryRoot: project,
      codepunkHome: home,
      projectTrusted: true,
    });
    assert.match(loaded.instructionBlock, /project-rule/u);

    const runtime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      approvalChannel: null,
    });
    try {
      assert.equal(runtime.workspaceTrust.trusted, false);
      assert.deepEqual(runtime.workspaceTrust.resources, ["AGENTS.md"]);
      assert.ok(
        runtime.loadedConfig.warnings.some((warning) =>
          /skipped project-instructions/u.test(warning),
        ),
      );
    } finally {
      await runtime.dispose();
    }

    await trustWorkspace(home, project);
    const trusted = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      approvalChannel: null,
    });
    try {
      assert.equal(trusted.workspaceTrust.trusted, true);
      assert.deepEqual(trusted.workspaceTrust.resources, ["AGENTS.md"]);
    } finally {
      await trusted.dispose();
    }
  });
});

test("a nested instruction file gates trust on the delivery root", async () => {
  await withTempDirectory("codepunk-trust-nested-", async (root) => {
    const project = path.join(root, "project");
    const source = path.join(project, "src");
    const home = path.join(root, "home");
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await writeFile(
      path.join(source, "AGENTS.md"),
      "nested-rule: only touch src\n",
    );

    /* Negative control: the old root-only walk returned no resources and
     * treated this workspace as trusted without a decision. */
    assert.deepEqual(
      await core.findTrustRequiringProjectResources(project, source),
      ["src/AGENTS.md"],
    );
    const trust = await core.resolveWorkspaceTrust({
      cwd: source,
      root: project,
      home,
    });
    assert.equal(trust.trusted, false);
    assert.equal(trust.source, "default");
    assert.deepEqual(trust.resources, ["src/AGENTS.md"]);
    assert.deepEqual(core.skippedProjectResources(trust), [
      "project-instructions",
    ]);

    const skipped = await core.loadContext({
      cwd: source,
      deliveryRoot: project,
      codepunkHome: home,
      projectTrusted: false,
    });
    assert.doesNotMatch(skipped.instructionBlock, /nested-rule/u);
    assert.ok(
      skipped.warnings.some(
        (warning) =>
          warning.code === "context.untrusted_project_instruction" &&
          warning.source === "project/src/AGENTS.md",
      ),
    );

    const loaded = await core.loadContext({
      cwd: source,
      deliveryRoot: project,
      codepunkHome: home,
      projectTrusted: true,
    });
    assert.match(loaded.instructionBlock, /nested-rule/u);

    const runtime = await core.createRuntime({
      cwd: source,
      environment: { CODEPUNK_HOME: home },
      approvalChannel: null,
    });
    try {
      assert.equal(runtime.workspaceTrust.trusted, false);
      assert.deepEqual(runtime.workspaceTrust.resources, ["src/AGENTS.md"]);
      assert.ok(
        runtime.loadedConfig.warnings.some((warning) =>
          /skipped project-instructions/u.test(warning),
        ),
      );
    } finally {
      await runtime.dispose();
    }
  });
});

test("a linked worktree is its own workspace and trust root", async () => {
  await withTempDirectory("codepunk-trust-worktree-", async (root) => {
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "worktree");
    const home = path.join(root, "home");
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd: repo });
    await execFileAsync(
      "git",
      ["config", "user.email", "probe@example.invalid"],
      {
        cwd: repo,
      },
    );
    await execFileAsync("git", ["config", "user.name", "probe"], {
      cwd: repo,
    });
    await writeFile(path.join(repo, "README.md"), "root\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repo });
    await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: repo });
    await execFileAsync(
      "git",
      ["worktree", "add", "-q", "-b", "feature", worktree],
      { cwd: repo },
    );
    await writeFile(path.join(worktree, "AGENTS.md"), "worktree rule\n");
    await writeFile(path.join(worktree, "probe.txt"), "probe\n");

    const project = await core.findDeliveryRoot(worktree);
    assert.equal(project.deliveryRoot, await fs.realpath(worktree));
    assert.notEqual(project.deliveryRoot, await fs.realpath(repo));

    const trust = await core.resolveWorkspaceTrust({
      cwd: worktree,
      root: project.deliveryRoot,
      home,
    });
    assert.deepEqual(trust.resources, ["AGENTS.md"]);
    assert.equal(trust.trusted, false);
    assert.deepEqual(core.skippedProjectResources(trust), [
      "project-instructions",
    ]);

    const decision = core.decidePolicy({
      tool: "read",
      args: { path: "probe.txt" },
      cwd: worktree,
      workspaceRoot: project.deliveryRoot,
      deliveryRoot: project.deliveryRoot,
      codepunkHome: home,
    });
    assert.equal(decision.decision, "allow");
  });
});

test("a saved parent decision does not trust a nested repository", async () => {
  await withTempDirectory("codepunk-trust-parent-", async (root) => {
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const nested = path.join(workspace, "packages", "app");
    await fs.mkdir(nested, { recursive: true });
    await writeFile(
      path.join(nested, ".codepunk", "config.toml"),
      '[context]\nappend = "nested instructions"\n',
    );
    const store = await core.saveWorkspaceTrust(home, workspace, true);
    assert.equal(store, path.join(home, "trust.json"));
    const trust = await core.resolveWorkspaceTrust({
      cwd: nested,
      root: nested,
      home,
    });
    const inspected = core.inspectSavedWorkspaceTrust(home, nested);
    assert.equal(inspected?.inherited, true);
    assert.equal(inspected?.entry.decision, true);
    assert.equal(inspected?.entry.path, await fs.realpath(workspace));
    assert.equal(trust.trusted, false);
    assert.equal(trust.source, "default");
    assert.equal(trust.savedPath, null);
    assert.deepEqual(trust.resources, [".codepunk/config.toml"]);
  });
});

test("untrusted runtimes skip project config, policy, and skills", async () => {
  await withTempDirectory("codepunk-trust-runtime-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await writeFile(
      path.join(project, ".codepunk", "config.toml"),
      ["[memory]", "max_tokens = 400", ""].join("\n"),
    );
    await writeFile(
      path.join(project, ".codepunk", "policy.toml"),
      ["version = 1", 'write_set = ["src/"]', ""].join("\n"),
    );
    await writeFile(
      path.join(project, ".codepunk", "skills", "team", "SKILL.md"),
      "---\nname: team\ndescription: team\n---\nbody\n",
    );

    const untrusted = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      approvalChannel: null,
    });
    try {
      assert.equal(untrusted.config.memory.max_tokens, 800);
      assert.equal(untrusted.workspaceTrust.trusted, false);
      assert.equal(untrusted.workspaceTrust.source, "default");
      assert.deepEqual(untrusted.workspaceTrust.resources, [
        ".codepunk/config.toml",
        ".codepunk/policy.toml",
        ".codepunk/skills",
      ]);
      assert.deepEqual(untrusted.policy.writeSet, []);
      assert.deepEqual(untrusted.skills, []);
      assert.ok(
        untrusted.loadedConfig.warnings.some((warning) =>
          /workspace is not trusted/u.test(warning),
        ),
      );
      const decision = untrusted.session.allEvents.find(
        (event) => event.kind === "trust/decision",
      );
      assert.equal(decision?.data.decision, "untrusted");
      assert.deepEqual(decision?.data.skipped, [
        "project-config",
        "project-policy",
        "project-skills",
      ]);
    } finally {
      await untrusted.dispose();
    }

    await trustWorkspace(home, project);
    const trusted = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      approvalChannel: null,
    });
    try {
      assert.equal(trusted.config.memory.max_tokens, 400);
      assert.equal(trusted.workspaceTrust.trusted, true);
      assert.equal(trusted.workspaceTrust.source, "saved");
      assert.equal(trusted.policy.writeSet.length, 1);
      assert.equal(trusted.skills.length, 1);
      const decision = trusted.session.allEvents.find(
        (event) => event.kind === "trust/decision",
      );
      assert.equal(decision?.data.decision, "trusted");
      assert.deepEqual(decision?.data.skipped, []);
    } finally {
      await trusted.dispose();
    }
  });
});

test("trust decisions use the canonical target behind a symlink", async () => {
  await withTempDirectory("codepunk-trust-symlink-", async (root) => {
    const project = path.join(root, "project");
    const link = path.join(root, "project-link");
    const home = path.join(root, "home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await writeFile(
      path.join(project, ".codepunk", "config.toml"),
      "[memory]\nmax_tokens = 400\n",
    );
    await fs.symlink(project, link, "dir");
    const saved = await core.saveWorkspaceTrust(home, link, true);
    assert.equal(saved, path.join(home, "trust.json"));
    const resolved = await core.resolveWorkspaceTrust({
      cwd: link,
      root: link,
      home,
    });
    assert.equal(resolved.trusted, true);
    assert.equal(resolved.source, "saved");
    assert.equal(resolved.root, await fs.realpath(project));
    assert.equal(resolved.savedPath, await fs.realpath(project));
    assert.deepEqual(resolved.resources, [".codepunk/config.toml"]);
  });
});

test("trust CLI reports, grants, and revokes a workspace decision", async () => {
  await withTempDirectory("codepunk-trust-cli-", async (root) => {
    const { project, home } = await setupProject(root);
    const status = await runCli(["trust", "status", "--json"], {
      cwd: project,
      home,
    });
    const before = JSON.parse(status.stdout);
    assert.equal(before.trusted, false);
    assert.equal(before.source, "default");
    assert.deepEqual(before.resources, [".codepunk/config.toml"]);
    assert.equal(before.resource_details.length, 1);
    assert.equal(before.resource_details[0].kind, "config");
    assert.equal(before.resource_details[0].type, "file");
    assert.match(before.resource_details[0].sha256, /^sha256:[a-f0-9]{64}$/u);
    const textStatus = await runCli(["trust", "status"], {
      cwd: project,
      home,
    });
    assert.match(
      textStatus.stdout,
      /\[config\] \.codepunk\/config\.toml \(file, \d+ B\)\n    sha256:[a-f0-9]{64}/u,
    );

    const granted = await runCli(["trust", "grant", "--json"], {
      cwd: project,
      home,
    });
    assert.equal(JSON.parse(granted.stdout).decision, "trusted");
    const after = JSON.parse(
      (
        await runCli(["trust", "status", "--json"], {
          cwd: project,
          home,
        })
      ).stdout,
    );
    assert.equal(after.trusted, true);
    assert.equal(after.source, "saved");
    assert.equal(after.saved_path, await fs.realpath(project));

    const permissions = await runCli(["permissions"], { cwd: project, home });
    assert.match(permissions.stdout, /trust: trusted \(saved\)/u);
    const forcedOff = await runCli(["--no-trust", "permissions"], {
      cwd: project,
      home,
    });
    assert.match(forcedOff.stdout, /trust: untrusted \(flag\)/u);

    const revoked = await runCli(["trust", "revoke", project, "--json"], {
      cwd: project,
      home,
    });
    assert.equal(JSON.parse(revoked.stdout).decision, "untrusted");
    const finalStatus = JSON.parse(
      (
        await runCli(["trust", "--json"], {
          cwd: project,
          home,
        })
      ).stdout,
    );
    assert.equal(finalStatus.trusted, false);
    assert.equal(finalStatus.source, "saved");
  });
});

test("permission presets write the documented axes and reject the old trust alias", async () => {
  await withTempDirectory("codepunk-trust-profiles-", async (root) => {
    const { project, home } = await setupProject(root, {
      projectConfig: false,
    });
    const auto = await runCli(["permissions", "profile", "auto"], {
      cwd: project,
      home,
    });
    assert.match(auto.stdout, /permission profile set to auto/u);
    let config = await fs.readFile(path.join(home, "config.toml"), "utf8");
    assert.match(config, /\[approval\]\nmode = "auto"/u);
    assert.match(config, /\[autonomy\]\nprofile = "ask"/u);
    assert.match(config, /\[sandbox\]\nmode = "required"/u);
    const shownAuto = await runCli(["permissions"], { cwd: project, home });
    assert.match(shownAuto.stdout, /profile: auto/u);

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

    const approve = await runCli(["permissions", "profile", "auto-approve"], {
      cwd: project,
      home,
    });
    assert.match(approve.stdout, /permission profile set to auto-approve/u);
    config = await fs.readFile(path.join(home, "config.toml"), "utf8");
    assert.match(config, /\[approval\]\nmode = "allow"/u);

    const full = await runCli(["permissions", "profile", "full-access"], {
      cwd: project,
      home,
    });
    assert.match(full.stdout, /dangerously-bypass-approvals-and-sandbox/u);
    config = await fs.readFile(path.join(home, "config.toml"), "utf8");
    assert.match(config, /\[sandbox\]\nmode = "uncovered"/u);
    assert.match(config, /\[filesystem\]\nmode = "full"/u);

    const shownOverride = await runCli(
      ["--permission-mode", "full-access", "permissions"],
      {
        cwd: project,
        home,
      },
    );
    assert.match(shownOverride.stdout, /profile: full-access/u);
    assert.match(shownOverride.stdout, /startup: blocked/u);

    const fullWhy = await runCli(
      ["--permission-mode", "full-access", "permissions", "why", "--", "ls"],
      {
        cwd: project,
        home,
      },
    );
    assert.match(fullWhy.stdout, /decision: deny/u);
    assert.match(fullWhy.stdout, /filesystem full requires/u);

    const shownFull = await runCli(["permissions"], { cwd: project, home });
    assert.match(shownFull.stdout, /profile: full-access/u);
    assert.match(shownFull.stdout, /approvals: allow/u);
    assert.match(shownFull.stdout, /sandbox: uncovered/u);
    assert.match(shownFull.stdout, /startup: blocked/u);

    await assert.rejects(
      () =>
        runCli(["--dangerously-bypass-approvals-and-sandbox", "permissions"], {
          cwd: project,
          home,
        }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /applies to interactive sessions only/u);
        return true;
      },
    );
  });
});

test("a corrupt trust store fails closed instead of becoming no decision", async () => {
  await withTempDirectory("codepunk-trust-corrupt-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await writeFile(path.join(project, "AGENTS.md"), "project rule\n");
    await writeFile(
      path.join(home, "trust.json"),
      "{ this is not valid json\n",
    );

    await assert.rejects(
      () =>
        core.resolveWorkspaceTrust({
          cwd: project,
          root: project,
          home,
        }),
      /workspace trust store .* could not be read/u,
    );
  });
});
