import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import { withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();

async function fixture(root) {
  const project = path.join(root, "project");
  const extra = path.join(root, "extra");
  const home = path.join(root, "home");
  await fs.mkdir(path.join(project, ".git"), { recursive: true });
  await fs.mkdir(path.join(project, ".codepunk"), { recursive: true });
  await fs.mkdir(path.join(extra, ".codepunk"), { recursive: true });
  await fs.mkdir(path.join(extra, ".git"), { recursive: true });
  await fs.mkdir(home);
  await fs.writeFile(path.join(project, "AGENTS.md"), "project rule\n");
  await fs.writeFile(path.join(extra, "a.txt"), "needle\n");
  await fs.writeFile(
    path.join(extra, ".codepunk", "config.toml"),
    "[memory]\nmax_tokens = 99\n",
  );
  await fs.writeFile(
    path.join(extra, ".codepunk", "policy.toml"),
    "[policy]\n",
  );
  return { project, extra, home };
}

test("extra file roots are canonical and cannot redefine the workspace", async () => {
  await withTempDirectory("codepunk-workspace-roots-", async (root) => {
    const { project, extra, home } = await fixture(root);
    const resolved = await core.resolveAdditionalWorkspaceRoots({
      cwd: project,
      primaryRoot: project,
      codepunkHome: home,
      directories: [extra, extra],
    });
    assert.deepEqual(resolved, [await fs.realpath(extra)]);

    await assert.rejects(
      core.resolveAdditionalWorkspaceRoots({
        cwd: project,
        primaryRoot: project,
        codepunkHome: home,
        directories: [project],
      }),
      /already the workspace root/u,
    );
    await assert.rejects(
      core.resolveAdditionalWorkspaceRoots({
        cwd: project,
        primaryRoot: project,
        codepunkHome: home,
        directories: [path.join(project, ".git")],
      }),
      /inside the workspace/u,
    );
    await assert.rejects(
      core.resolveAdditionalWorkspaceRoots({
        cwd: project,
        primaryRoot: project,
        codepunkHome: home,
        directories: [root],
      }),
      /cannot contain the workspace root/u,
    );
    await assert.rejects(
      core.resolveAdditionalWorkspaceRoots({
        cwd: project,
        primaryRoot: project,
        codepunkHome: home,
        directories: [home],
      }),
      /cannot contain the user home or Codepunk home/u,
    );
    await assert.rejects(
      core.resolveAdditionalWorkspaceRoots({
        cwd: project,
        primaryRoot: project,
        codepunkHome: home,
        directories: [os.homedir()],
      }),
      /cannot contain the user home or Codepunk home/u,
    );
    await assert.rejects(
      core.resolveAdditionalWorkspaceRoots({
        cwd: project,
        primaryRoot: project,
        codepunkHome: home,
        directories: [path.join(root, "missing")],
      }),
      /not a directory/u,
    );

    const linkedProject = path.join(root, "linked-project");
    await fs.symlink(project, linkedProject, "dir");
    await assert.rejects(
      core.resolveAdditionalWorkspaceRoots({
        cwd: linkedProject,
        primaryRoot: linkedProject,
        codepunkHome: home,
        directories: [project],
      }),
      /already the workspace root/u,
    );

    const realHome = path.join(root, "real-home");
    const linkedHome = path.join(root, "linked-home");
    await fs.mkdir(realHome);
    await fs.symlink(realHome, linkedHome, "dir");
    await assert.rejects(
      core.resolveAdditionalWorkspaceRoots({
        cwd: project,
        primaryRoot: project,
        codepunkHome: linkedHome,
        directories: [realHome],
      }),
      /cannot contain the user home or Codepunk home/u,
    );
  });
});

test("extra roots extend path policy without exposing their .codepunk or .git", async () => {
  await withTempDirectory("codepunk-workspace-policy-", async (root) => {
    const { project, extra, home } = await fixture(root);
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(extra, "escape"), "dir");

    const base = {
      cwd: project,
      workspaceRoot: project,
      deliveryRoot: project,
      codepunkHome: home,
      additionalRoots: [extra],
      mode: "interactive",
    };
    const allowed = core.decidePolicy({
      ...base,
      tool: "read",
      args: { path: path.join(extra, "a.txt") },
    });
    assert.equal(allowed.decision, "allow");
    assert.equal(allowed.rule, "path.read.allow");

    const withoutRoot = core.decidePolicy({
      ...base,
      additionalRoots: [],
      tool: "read",
      args: { path: path.join(extra, "a.txt") },
    });
    assert.equal(withoutRoot.decision, "deny");
    assert.match(withoutRoot.reason, /outside the workspace/u);

    const protectedConfig = core.decidePolicy({
      ...base,
      tool: "read",
      args: { path: path.join(extra, ".codepunk", "config.toml") },
    });
    assert.equal(protectedConfig.decision, "deny");
    assert.match(protectedConfig.reason, /codepunk state/u);

    const protectedGit = core.decidePolicy({
      ...base,
      tool: "read",
      args: { path: path.join(extra, ".git", "config") },
    });
    assert.equal(protectedGit.decision, "ask");
    assert.match(protectedGit.reason, /git metadata/u);

    const symlinkEscape = core.decidePolicy({
      ...base,
      tool: "read",
      args: { path: path.join(extra, "escape", "secret.txt") },
    });
    assert.equal(symlinkEscape.decision, "deny");
    assert.match(symlinkEscape.reason, /symlink/u);

    const write = core.decidePolicy({
      ...base,
      tool: "write",
      args: { path: path.join(extra, "new.txt") },
      writeSet: [extra],
    });
    assert.equal(write.decision, "allow");

    const readOnly = core.decidePolicy({
      ...base,
      tool: "write",
      args: { path: path.join(extra, "new.txt") },
      writeSet: [extra],
      autonomy: "read-only",
    });
    assert.equal(readOnly.decision, "deny");
    assert.match(readOnly.reason, /read-only autonomy/u);
  });
});

test("extra roots work for search and project config is not loaded from them", async () => {
  await withTempDirectory("codepunk-workspace-search-", async (root) => {
    const { project, extra, home } = await fixture(root);
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await fs.writeFile(
      path.join(bin, "rg"),
      `#!/bin/sh\nprintf '${extra}/a.txt:1:needle\\n${extra}/.codepunk/config.toml:1:SECRET\\n'\n`,
      { mode: 0o755 },
    );

    const withoutRoot = core.createSearchTool({
      cwd: project,
      workspaceRoot: project,
      environment: { PATH: bin },
    });
    const denied = await withoutRoot.execute("call-denied", {
      mode: "ls",
      path: extra,
    });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /outside the workspace/u);

    const tool = core.createSearchTool({
      cwd: project,
      workspaceRoot: project,
      additionalRoots: [extra],
      environment: { PATH: bin },
    });
    const listed = await tool.execute("call-ls", {
      mode: "ls",
      path: extra,
      query: "a.txt",
    });
    assert.equal(listed.isError, undefined);
    assert.match(listed.content[0].text, /a\.txt/u);

    const searched = await tool.execute("call-grep", {
      mode: "grep",
      path: extra,
      query: "needle",
    });
    assert.equal(searched.isError, undefined);
    assert.match(searched.content[0].text, /a\.txt:1:needle/u);
    assert.doesNotMatch(searched.content[0].text, /SECRET|config\.toml/u);

    const runtime = await core.createRuntime({
      cwd: project,
      additionalDirs: [extra],
      environment: { CODEPUNK_HOME: home },
      approvalChannel: null,
      allowMissingModel: true,
    });
    try {
      assert.deepEqual(runtime.paths.additionalRoots, [extra]);
      assert.equal(
        runtime.config.memory.max_tokens,
        core.defaultConfig().memory.max_tokens,
      );
      assert.equal(
        runtime.workspaceTrust.resources.includes(".codepunk/config.toml"),
        false,
      );
    } finally {
      await runtime.dispose();
    }
  });
});

test("srt profiles protect every extra root and grant only the write set", async () => {
  await withTempDirectory("codepunk-workspace-srt-", async (root) => {
    const { project, extra, home } = await fixture(root);
    const profile = core.srtProfile({
      cwd: project,
      workspaceRoot: project,
      deliveryRoot: project,
      additionalRoots: [extra],
      codepunkHome: home,
      writeSet: [extra],
    });
    assert.deepEqual(profile.filesystem.allowWrite, [extra]);
    assert.ok(
      profile.filesystem.denyRead.includes(path.join(extra, ".codepunk")),
    );
    assert.ok(
      profile.filesystem.denyWrite.includes(path.join(extra, ".git", "config")),
    );
  });
});
