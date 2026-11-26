import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { importCore, importSource } from "./support/core.mjs";
import {
  describeInstallFailure,
  ensureBuilt,
  escapeRegExp,
  execFilePortable,
  PRODUCT_VERSION,
  REPO_ROOT,
  resolveInstallTimeoutMs,
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
      "codepunk-cli@1.2.3",
    ]);
    const uninstall = await core.uninstallPackage({ prefix, dryRun: true });
    assert.deepEqual(uninstall.command.args, [
      "uninstall",
      "--global",
      "--prefix",
      prefix,
      "codepunk-cli",
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
          dependencies: { "codepunk-cli": { version: "0.0.0" } },
        }),
        stderr: "",
      };
    }
    if (
      invocation.args[0] === "install" &&
      invocation.args.at(-1) === "codepunk-cli@latest"
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
  assert.equal(calls[1].args.at(-1), "codepunk-cli@latest");
  assert.equal(calls[2].args.at(-1), "codepunk-cli@0.0.0");
});

test(
  "Windows npm execution uses the Node entry point without a shell",
  { skip: process.platform !== "win32" ? "Windows-only npm shim" : false },
  async () => {
    const packageModule = await importSource(
      "packages/core/src/ops/package.ts",
    );
    const native = packageModule.nativeNpmInvocation(
      { command: "npm", args: ["--version"] },
      process.env,
      "win32",
    );
    assert.equal(native.command, process.execPath);
    assert.match(native.args[0], /npm-cli\.js$/u);
    assert.deepEqual(native.args.slice(1), ["--version"]);

    await withTempDirectory("codepunk-npm-runner-", async (root) => {
      const prefix = path.join(root, "prefix with spaces");
      const result = await packageModule.runNpmInvocation(
        {
          command: "npm",
          args: [
            "list",
            "--global",
            "--prefix",
            prefix,
            "--json",
            "--depth=0",
            "codepunk-cli",
          ],
        },
        { cwd: root, env: process.env },
      );
      const output = `${result.stdout}${result.stderr}`;
      assert.doesNotMatch(output, /EINVAL|DEP0190/u);
      assert.doesNotMatch(output, /\.cmd/u);
    });
  },
);

test("packed CLI installs, runs, doctors, and uninstalls from a clean prefix", async () => {
  await ensureBuilt();
  await withTempDirectory("codepunk-clean-install-", async (root) => {
    const packed = [];
    for (const workspace of [
      "codepunk-protocol",
      "codepunk-core",
      "codepunk-cli",
    ]) {
      const { stdout } = await execFilePortable(
        "pnpm",
        ["--filter", workspace, "pack", "--json", "--pack-destination", root],
        { cwd: REPO_ROOT, timeout: 120_000 },
      );
      packed.push(JSON.parse(stdout).filename);
    }
    const prefix = path.join(root, "prefix");
    const installTimeoutMs = resolveInstallTimeoutMs();
    try {
      await execFilePortable(
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
        { timeout: installTimeoutMs },
      );
    } catch (error) {
      assert.fail(describeInstallFailure(error, installTimeoutMs));
    }
    const bin =
      process.platform === "win32"
        ? path.join(prefix, "codepunk.cmd")
        : path.join(prefix, "bin", "codepunk");
    await fs.access(bin);
    const version = await execFilePortable(bin, ["--version"]);
    assert.match(
      version.stdout,
      new RegExp(
        `^codepunk ${escapeRegExp(PRODUCT_VERSION)}\\nentry: .+\\nbuilt: .+\\nsource: .+\\n$`,
        "u",
      ),
    );

    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    let doctor;
    try {
      doctor = await execFilePortable(bin, ["doctor"], {
        cwd: project,
        env: {
          ...process.env,
          CODEPUNK_HOME: home,
          PATH:
            process.platform === "win32"
              ? [
                  path.dirname(process.execPath),
                  path.join(
                    process.env["SystemRoot"] ?? "C:\\Windows",
                    "System32",
                  ),
                ].join(path.delimiter)
              : `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          NO_COLOR: "1",
          PI_OFFLINE: "1",
        },
      });
    } catch (error) {
      doctor = error;
    }
    const output = `${doctor.stdout ?? ""}${doctor.stderr ?? ""}`;
    assert.match(output, /doctor:/u);

    await execFilePortable(
      "npm",
      [
        "uninstall",
        "--global",
        "--prefix",
        prefix,
        "--no-audit",
        "--no-fund",
        "codepunk-cli",
      ],
      { timeout: 120_000 },
    );
    await assert.rejects(() => fs.access(bin), /ENOENT/u);
  });
});
