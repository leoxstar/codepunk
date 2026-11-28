import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { importCore } from "./support/core.mjs";
import { makeProject, withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();
const execFileAsync = promisify(execFile);

test("doctor reports each blocking dependency and formats a summary", async () => {
  await withTempDirectory("codepunk-operations-", async (root) => {
    const { paths } = await makeProject(root);
    const config = core.defaultConfig();
    const report = await core.runDoctor({
      paths,
      config,
      environment: { PATH: "" },
      sandboxProbe: async () => "srt is missing",
      modelProbe: async () => "no model selected",
    });
    assert.equal(report.ok, false);
    const byId = new Map(report.checks.map((check) => [check.id, check]));
    assert.equal(byId.get("srt").status, "error");
    assert.equal(byId.get("model").status, "error");
    assert.equal(byId.get("search-rg").status, "warn");
    assert.match(core.formatDoctor(report), /doctor: blocking issues remain/u);
    assert.doesNotMatch(core.formatDoctor(report), /\/Users\//u);
  });
});

test("doctor treats an unavailable model as a blocking issue", async () => {
  await withTempDirectory("codepunk-operations-", async (root) => {
    const { paths } = await makeProject(root);
    const report = await core.runDoctor({
      paths,
      config: core.defaultConfig(),
      environment: { PATH: "" },
      sandboxProbe: async () => null,
      modelProbe: async () => "no model configured",
    });
    assert.equal(report.ok, false);
    const model = report.checks.find((check) => check.id === "model");
    assert.equal(model?.status, "error");
    assert.match(core.formatDoctor(report), /\[error\] model:/u);
    assert.match(core.formatDoctor(report), /doctor: blocking issues remain/u);
  });
});

test("doctor gives the Windows sandbox provisioning command", async () => {
  await withTempDirectory("codepunk-operations-windows-", async (root) => {
    const { paths } = await makeProject(root);
    const report = await core.runDoctor({
      paths,
      config: core.defaultConfig(),
      environment: { PATH: "" },
      sandboxProbe: async () =>
        "srt initialization failed: Sandbox dependencies not available: Windows sandbox user is not provisioned",
      modelProbe: async () => null,
    });
    const srt = report.checks.find((check) => check.id === "srt");
    assert.equal(srt?.status, "error");
    assert.match(
      srt?.hint ?? "",
      /npx --yes @anthropic-ai\/sandbox-runtime@0\.0\.82 windows-install/u,
    );
  });
});

test("doctor passes with an injected healthy environment", async () => {
  await withTempDirectory("codepunk-operations-", async (root) => {
    const { paths } = await makeProject(root);
    const report = await core.runDoctor({
      paths,
      config: core.defaultConfig(),
      platform: "darwin",
      environment: { PATH: "" },
      sandboxProbe: async () => null,
      modelProbe: async () => null,
    });
    assert.equal(report.ok, true);
    assert.match(core.formatDoctor(report), /doctor: ready/u);
  });
});

test("doctor does not report ready on an unsupported platform", async () => {
  await withTempDirectory("codepunk-operations-platform-", async (root) => {
    const { paths } = await makeProject(root);
    const report = await core.runDoctor({
      paths,
      config: core.defaultConfig(),
      platform: "freebsd",
      environment: { PATH: "" },
      sandboxProbe: async () => null,
      modelProbe: async () => null,
    });
    assert.equal(report.ok, false);
    const platform = report.checks.find((check) => check.id === "platform");
    assert.equal(platform?.status, "error");
    assert.match(platform?.message ?? "", /freebsd/u);
    assert.match(core.formatDoctor(report), /doctor: blocking issues remain/u);
  });
});

test("doctor accepts Windows 10 19045+ and Windows 11 x64 and refuses older Windows", async () => {
  await withTempDirectory("codepunk-operations-windows-gate-", async (root) => {
    const { paths } = await makeProject(root);
    for (const platformVersion of ["10.0.19045", "10.0.26100"]) {
      const supported = await core.runDoctor({
        paths,
        config: core.defaultConfig(),
        platform: "win32",
        platformVersion,
        arch: "x64",
        environment: { PATH: "" },
        sandboxProbe: async () => null,
        modelProbe: async () => null,
        shellProbe: async () => null,
      });
      assert.equal(supported.ok, true, platformVersion);
      const platform = supported.checks.find(
        (check) => check.id === "platform",
      );
      assert.equal(platform?.status, "ok", platformVersion);
      assert.equal(platform?.message, "win32 x64", platformVersion);
      assert.match(
        core.formatDoctor(supported),
        /\[ok\] platform: win32 x64/u,
        platformVersion,
      );
      assert.match(
        core.formatDoctor(supported),
        /doctor: ready/u,
        platformVersion,
      );
    }

    for (const blocked of [
      { platformVersion: "10.0.19044", arch: "x64" },
      { platformVersion: "10.0.26100", arch: "arm64" },
    ]) {
      const report = await core.runDoctor({
        paths,
        config: core.defaultConfig(),
        platform: "win32",
        platformVersion: blocked.platformVersion,
        arch: blocked.arch,
        environment: { PATH: "" },
        sandboxProbe: async () => null,
        modelProbe: async () => null,
        shellProbe: async () => null,
      });
      assert.equal(report.ok, false);
      const platformCheck = report.checks.find(
        (check) => check.id === "platform",
      );
      assert.equal(platformCheck?.status, "error");
      assert.match(
        platformCheck?.hint ?? "",
        /Windows 10 x64 \(build 19045 or newer\) or Windows 11 x64/u,
      );
      assert.match(
        core.formatDoctor(report),
        /doctor: blocking issues remain/u,
      );
    }
  });
});

test("doctor reports a missing Windows shell without failing the run", async () => {
  await withTempDirectory("codepunk-operations-shell-", async (root) => {
    const { paths } = await makeProject(root);
    const report = await core.runDoctor({
      paths,
      config: core.defaultConfig(),
      platform: "win32",
      platformVersion: "10.0.26100",
      arch: "x64",
      environment: { PATH: "" },
      sandboxProbe: async () => null,
      modelProbe: async () => null,
      shellProbe: async () =>
        "tools.shell=pwsh requires pwsh.exe or powershell.exe on PATH",
    });
    assert.equal(report.ok, false);
    const shell = report.checks.find((check) => check.id === "tools.shell");
    assert.equal(shell?.status, "error");
    assert.match(core.formatDoctor(report), /\[error\] tools\.shell:/u);
  });
});

test("doctor requires Node 22.19, not just major 22", async () => {
  await withTempDirectory("codepunk-operations-node-", async (root) => {
    const { paths } = await makeProject(root);
    const base = {
      paths,
      config: core.defaultConfig(),
      environment: { PATH: "" },
      sandboxProbe: async () => null,
      modelProbe: async () => null,
    };
    const old = await core.runDoctor({ ...base, nodeVersion: "22.18.0" });
    const oldNode = old.checks.find((check) => check.id === "node");
    assert.equal(old.ok, false);
    assert.equal(oldNode?.status, "error");
    assert.match(oldNode?.hint ?? "", /22\.19\.0/u);

    const minimum = await core.runDoctor({
      ...base,
      nodeVersion: "22.19.0",
    });
    const minimumNode = minimum.checks.find((check) => check.id === "node");
    assert.equal(minimum.ok, true);
    assert.equal(minimumNode?.status, "ok");
    assert.equal(minimumNode?.hint, null);
  });
});

test("doctor reports an unpublished 0.0.0 package instead of claiming npm is ready", async () => {
  await withTempDirectory("codepunk-operations-package-", async (root) => {
    const { paths } = await makeProject(root);
    const base = {
      paths,
      config: core.defaultConfig(),
      environment: { PATH: "" },
      sandboxProbe: async () => null,
      modelProbe: async () => null,
    };
    const unpublished = await core.runDoctor({
      ...base,
      packageVersion: "0.0.0",
    });
    const distribution = unpublished.checks.find(
      (check) => check.id === "distribution",
    );
    assert.equal(distribution?.status, "warn");
    assert.match(distribution?.message ?? "", /not published/u);

    const published = await core.runDoctor({
      ...base,
      packageVersion: "0.1.0",
    });
    assert.equal(
      published.checks.find((check) => check.id === "distribution")?.status,
      "ok",
    );
  });
});

test("doctor checks policy v2 self-proof, warns on legacy v1, and errors on invalid fixtures", async () => {
  await withTempDirectory("codepunk-operations-policy-", async (root) => {
    const { paths } = await makeProject(root);
    const base = {
      paths,
      config: core.defaultConfig(),
      platform: "darwin",
      environment: { PATH: "" },
      sandboxProbe: async () => null,
      modelProbe: async () => null,
      packageVersion: "0.1.0",
    };

    // Legacy v1 policy: doctor stays ready (ok: true) with a migration warning
    await fs.writeFile(
      path.join(paths.home, "policy.toml"),
      [
        "version = 1",
        "",
        "[rules.legacy_echo]",
        'tool = "exec"',
        'decision = "allow"',
        'command = "echo"',
        "",
      ].join("\n"),
      "utf8",
    );
    const legacyReport = await core.runDoctor(base);
    assert.equal(legacyReport.ok, true);
    const legacyPolicy = legacyReport.checks.find(
      (check) => check.id === "policy",
    );
    assert.equal(legacyPolicy?.status, "warn");
    assert.match(legacyPolicy?.message ?? "", /legacy version 1/u);
    assert.match(legacyPolicy?.message ?? "", /policy\.migrate_hint/u);
    assert.doesNotMatch(core.formatDoctor(legacyReport), /\/Users\//u);

    // Positive v2 policy: doctor reports ok
    await fs.writeFile(
      path.join(paths.home, "policy.toml"),
      [
        "version = 2",
        "",
        "[rules.allow_echo]",
        'tool = "exec"',
        'decision = "allow"',
        'command = "/bin/echo"',
        'justification = "exact echo only"',
        "",
        "[[rules.allow_echo.match]]",
        'tool = "exec"',
        'command = "/bin/echo"',
        'argv = ["/bin/echo", "ok"]',
        'cwd = "."',
        "",
        "[[rules.allow_echo.not_match]]",
        'tool = "exec"',
        'command = "/bin/echo"',
        'argv = ["/bin/echo", "nope"]',
        'cwd = "."',
        "",
      ].join("\n"),
      "utf8",
    );
    const v2Report = await core.runDoctor(base);
    assert.equal(v2Report.ok, true);
    const v2Policy = v2Report.checks.find((check) => check.id === "policy");
    assert.equal(v2Policy?.status, "ok");
    assert.match(
      v2Policy?.message ?? "",
      /1 version 2 policy rule\(s\) verified/u,
    );

    // Negative control: broken v2 not_match fixture causes doctor error (ok: false)
    await fs.writeFile(
      path.join(paths.home, "policy.toml"),
      [
        "version = 2",
        "",
        "[rules.allow_echo]",
        'tool = "exec"',
        'decision = "allow"',
        'command = "/bin/echo"',
        'justification = "broken negative example"',
        "",
        "[[rules.allow_echo.match]]",
        'tool = "exec"',
        'command = "/bin/echo"',
        'argv = ["/bin/echo", "ok"]',
        'cwd = "."',
        "",
        "[[rules.allow_echo.not_match]]",
        'tool = "exec"',
        'command = "/bin/echo"',
        'argv = ["/bin/echo", "ok"]',
        'cwd = "."',
        "",
      ].join("\n"),
      "utf8",
    );
    const brokenReport = await core.runDoctor(base);
    assert.equal(brokenReport.ok, false);
    const brokenPolicy = brokenReport.checks.find(
      (check) => check.id === "policy",
    );
    assert.equal(brokenPolicy?.status, "error");
    assert.match(
      brokenPolicy?.message ?? "",
      /rules\.allow_echo\.not_match\[0\]/u,
    );
    assert.doesNotMatch(core.formatDoctor(brokenReport), /\/Users\//u);
  });
});

test("workspace diff separates staged and unstaged changes", async () => {
  await withTempDirectory("codepunk-diff-", async (root) => {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await fs.writeFile(path.join(root, "tracked.txt"), "one\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-q", "-m", "initial"], {
      cwd: root,
    });

    await fs.writeFile(path.join(root, "tracked.txt"), "two\n", "utf8");
    await fs.writeFile(path.join(root, "new.txt"), "new\n", "utf8");
    await execFileAsync("git", ["add", "new.txt"], { cwd: root });

    const diff = await core.readWorkspaceDiff({ root });
    assert.match(diff.status, /M tracked\.txt/u);
    assert.match(diff.status, /A  new\.txt/u);
    assert.match(diff.unstaged, /-one/u);
    assert.match(diff.unstaged, /\+two/u);
    assert.match(diff.staged, /\+new/u);
    assert.equal(diff.untracked, "");
    assert.match(diff.stat, /### staged/u);
    assert.match(diff.stat, /### unstaged/u);
    assert.equal(diff.truncated, false);
  });
});

test("workspace diff reports a bounded patch", async () => {
  await withTempDirectory("codepunk-diff-bound-", async (root) => {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await fs.writeFile(path.join(root, "large.txt"), `${"x".repeat(4096)}\n`);
    await execFileAsync("git", ["add", "large.txt"], { cwd: root });
    const diff = await core.readWorkspaceDiff({ root, maxBytes: 128 });
    assert.equal(diff.truncated, true);
    assert.ok(diff.unstaged.length <= 128);
  });
});

test("workspace diff names a directory outside a Git worktree", async () => {
  await withTempDirectory("codepunk-diff-nongit-", async (root) => {
    await assert.rejects(
      core.readWorkspaceDiff({ root }),
      (error) =>
        error instanceof core.NotAGitWorktreeError &&
        /not a Git worktree/u.test(error.message),
    );
  });
});

test("commit preview separates staged, unstaged, and untracked files", async () => {
  await withTempDirectory("codepunk-commit-preview-", async (root) => {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await fs.writeFile(path.join(root, "tracked.txt"), "one\n", "utf8");
    await fs.writeFile(path.join(root, "staged.txt"), "one\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-q", "-m", "initial"], {
      cwd: root,
    });
    await fs.writeFile(path.join(root, "tracked.txt"), "two\n", "utf8");
    await fs.writeFile(path.join(root, "staged.txt"), "two\n", "utf8");
    await execFileAsync("git", ["add", "staged.txt"], { cwd: root });
    await fs.writeFile(path.join(root, "untracked.txt"), "new\n", "utf8");

    const preview = await core.readWorkspaceCommitPreview({ root });
    assert.ok(preview.head);
    assert.ok(preview.branch === "main" || preview.branch === "master");
    assert.deepEqual(preview.staged, ["staged.txt"]);
    assert.deepEqual(preview.unstaged, ["tracked.txt"]);
    assert.deepEqual(preview.untracked, ["untracked.txt"]);
    assert.match(preview.staged_stat, /staged\.txt/u);
    assert.match(preview.unstaged_stat, /tracked\.txt/u);
  });
});

test("createGitCommit can commit only tracked changes", async () => {
  await withTempDirectory("codepunk-commit-tracked-", async (root) => {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await fs.writeFile(path.join(root, "tracked.txt"), "one\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-q", "-m", "initial"], {
      cwd: root,
    });
    const initial = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim();
    await fs.writeFile(path.join(root, "tracked.txt"), "two\n", "utf8");
    await fs.writeFile(path.join(root, "untracked.txt"), "new\n", "utf8");

    const result = await core.createGitCommit({
      root,
      message: "update tracked file",
      stage: "tracked",
    });
    assert.equal(result.previous_commit, initial);
    assert.deepEqual(result.files, ["tracked.txt"]);
    assert.equal(result.stage, "tracked");
    assert.match(result.commit, /^[0-9a-f]{40,64}$/u);
    assert.match(result.tree, /^[0-9a-f]{40,64}$/u);
    const log = await execFileAsync("git", ["log", "-1", "--pretty=%s"], {
      cwd: root,
    });
    assert.equal(log.stdout.trim(), "update tracked file");
    const status = await execFileAsync("git", ["status", "--short"], {
      cwd: root,
    });
    assert.match(status.stdout, /^\?\? untracked\.txt$/mu);
  });
});

test("createGitCommit can include untracked files when asked", async () => {
  await withTempDirectory("codepunk-commit-all-", async (root) => {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await fs.writeFile(path.join(root, "untracked.txt"), "new\n", "utf8");

    const result = await core.createGitCommit({
      root,
      message: "add first file",
      stage: "all",
    });
    assert.equal(result.previous_commit, null);
    assert.deepEqual(result.files, ["untracked.txt"]);
    assert.equal(result.stage, "all");
  });
});

test("createGitCommit rejects an empty message and nothing staged", async () => {
  await withTempDirectory("codepunk-commit-errors-", async (root) => {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await fs.writeFile(path.join(root, "file.txt"), "one\n", "utf8");
    await assert.rejects(
      core.createGitCommit({ root, message: "   ", stage: "all" }),
      (error) =>
        error instanceof core.GitCommitError &&
        error.code === "git.empty_message",
    );
    await assert.rejects(
      core.createGitCommit({ root, message: "nothing", stage: "staged" }),
      (error) =>
        error instanceof core.GitCommitError &&
        error.code === "git.nothing_staged",
    );
  });
});
