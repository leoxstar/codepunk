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

test("doctor passes with an injected healthy environment", async () => {
  await withTempDirectory("codepunk-operations-", async (root) => {
    const { paths } = await makeProject(root);
    const report = await core.runDoctor({
      paths,
      config: core.defaultConfig(),
      environment: { PATH: "" },
      sandboxProbe: async () => null,
      modelProbe: async () => null,
    });
    assert.equal(report.ok, true);
    assert.match(core.formatDoctor(report), /doctor: ready/u);
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
