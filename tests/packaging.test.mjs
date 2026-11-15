import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import {
  ensureBuilt,
  REPO_ROOT,
  withTempDirectory,
} from "./support/helpers.mjs";

const core = await importCore();
const execFileAsync = promisify(execFile);

test("package commands delegate to npm with exact prefixes", async () => {
  await withTempDirectory("codepunk-package-", async (root) => {
    const prefix = path.join(root, "prefix");
    const install = await core.installPackage({
      prefix,
      version: "1.2.3",
      dryRun: true,
    });
    assert.equal(install.command.command, "npm");
    assert.deepEqual(install.command.args, [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      "@codepunk/cli@1.2.3",
    ]);
    const uninstall = await core.uninstallPackage({ prefix, dryRun: true });
    assert.deepEqual(uninstall.command.args, [
      "uninstall",
      "--global",
      "--prefix",
      prefix,
      "@codepunk/cli",
    ]);
    await assert.rejects(
      () => core.installPackage({ prefix: "relative", dryRun: true }),
      /absolute path/u,
    );
  });
});

test("upgrade rolls back to the previous version when npm fails", async () => {
  const calls = [];
  const run = async (invocation) => {
    calls.push(invocation);
    if (invocation.args[0] === "list") {
      return {
        code: 0,
        stdout: JSON.stringify({
          dependencies: { "@codepunk/cli": { version: "0.0.0" } },
        }),
        stderr: "",
      };
    }
    if (
      invocation.args[0] === "install" &&
      invocation.args.at(-1) === "@codepunk/cli@latest"
    ) {
      return { code: 1, stdout: "", stderr: "registry unavailable" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    () =>
      core.upgradePackage({
        prefix: "/tmp/codepunk-prefix",
        run,
      }),
    (error) => {
      assert.equal(error.code, "package.upgrade_rolled_back");
      assert.match(error.message, /restored 0\.0\.0/u);
      return true;
    },
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[0].args[0], "list");
  assert.equal(calls[1].args.at(-1), "@codepunk/cli@latest");
  assert.equal(calls[2].args.at(-1), "@codepunk/cli@0.0.0");
});

test("packed CLI installs, runs, doctors, and uninstalls from a clean prefix", async () => {
  await ensureBuilt();
  await withTempDirectory("codepunk-clean-install-", async (root) => {
    const packed = [];
    for (const workspace of [
      "@codepunk/protocol",
      "@codepunk/core",
      "@codepunk/cli",
    ]) {
      const { stdout } = await execFileAsync(
        "pnpm",
        ["--filter", workspace, "pack", "--json", "--pack-destination", root],
        { cwd: REPO_ROOT, timeout: 120_000 },
      );
      packed.push(JSON.parse(stdout).filename);
    }
    const prefix = path.join(root, "prefix");
    await execFileAsync(
      "npm",
      [
        "install",
        "--global",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...packed,
      ],
      { timeout: 180_000 },
    );
    const bin = path.join(prefix, "bin", "codepunk");
    await fs.access(bin);
    const version = await execFileAsync(bin, ["--version"]);
    assert.equal(version.stdout.trim(), "codepunk 0.0.0");

    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    let doctor;
    try {
      doctor = await execFileAsync(bin, ["doctor"], {
        cwd: project,
        env: {
          ...process.env,
          CODEPUNK_HOME: home,
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          NO_COLOR: "1",
          PI_OFFLINE: "1",
        },
      });
    } catch (error) {
      doctor = error;
    }
    const output = `${doctor.stdout ?? ""}${doctor.stderr ?? ""}`;
    assert.match(output, /doctor:/u);

    await execFileAsync(
      "npm",
      [
        "uninstall",
        "--global",
        "--prefix",
        prefix,
        "--no-audit",
        "--no-fund",
        "@codepunk/cli",
      ],
      { timeout: 120_000 },
    );
    await assert.rejects(() => fs.access(bin), /ENOENT/u);
  });
});
