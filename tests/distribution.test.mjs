import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  classifyCommandFailure,
  describeInstallFailure,
  ensureBuilt,
  escapeRegExp,
  execFilePortable,
  PRODUCT_VERSION,
  REPO_ROOT,
  resolveBuildTimeoutMs,
  resolveInstallTimeoutMs,
  withTempDirectory,
} from "./support/helpers.mjs";

const execFileAsync = promisify(execFile);

test("packed tarballs exclude runtime state and install cleanly", async () => {
  await ensureBuilt();
  await withTempDirectory("codepunk-distribution-", async (root) => {
    const packed = [];
    for (const workspace of [
      "@codepunk/protocol",
      "@codepunk/core",
      "@codepunk/cli",
    ]) {
      const { stdout } = await execFilePortable(
        "pnpm",
        ["--filter", workspace, "pack", "--json", "--pack-destination", root],
        { cwd: REPO_ROOT },
      );
      const filename = JSON.parse(stdout).filename;
      const listing = await execFileAsync("tar", ["-tzf", filename]);
      const files = listing.stdout.split("\n").filter(Boolean);
      packed.push(filename);
      assert.equal(
        files.some((file) =>
          /^package\/(?:verify|tests|node_modules|\.codepunk|sessions|evidence|logs|artifacts|cache)\//u.test(
            file,
          ),
        ),
        false,
        `${workspace} tarball contains runtime or verification state`,
      );
      assert.equal(
        files.some((file) => file.endsWith(".jsonl")),
        false,
      );
    }
    const install = path.join(root, "install");
    await fs.mkdir(install);
    await fs.writeFile(
      path.join(install, "package.json"),
      `${JSON.stringify({ name: "codepunk-smoke", private: true })}\n`,
    );
    const installTimeoutMs = resolveInstallTimeoutMs();
    try {
      await execFilePortable(
        "npm",
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--no-package-lock",
          ...packed,
        ],
        { cwd: install, timeout: installTimeoutMs },
      );
    } catch (error) {
      assert.fail(describeInstallFailure(error, installTimeoutMs));
    }
    const version = await execFileAsync(
      process.execPath,
      [
        path.join(
          install,
          "node_modules",
          "@codepunk",
          "cli",
          "dist",
          "index.js",
        ),
        "--version",
      ],
      { cwd: install },
    );
    assert.match(
      version.stdout,
      new RegExp(
        `^codepunk ${escapeRegExp(PRODUCT_VERSION)}\\nentry: .+\\nbuilt: .+\\nsource: .+\\n$`,
        "u",
      ),
    );
    const installed = await fs.readdir(
      path.join(install, "node_modules", "@codepunk", "cli"),
    );
    assert.deepEqual(installed.sort(), [
      "LICENSE",
      "README.md",
      "dist",
      "package.json",
    ]);
  });
});

test("external command timeouts are configurable", () => {
  assert.equal(resolveInstallTimeoutMs({}), 120_000);
  assert.equal(
    resolveInstallTimeoutMs({ CODEPUNK_TEST_INSTALL_TIMEOUT_MS: "45000" }),
    45_000,
  );
  assert.equal(resolveBuildTimeoutMs({}), 600_000);
  assert.equal(
    resolveBuildTimeoutMs({ CODEPUNK_TEST_BUILD_TIMEOUT_MS: "900000" }),
    900_000,
  );
  for (const value of ["soon", "0", "-5", "1.5"]) {
    assert.throws(
      () =>
        resolveInstallTimeoutMs({ CODEPUNK_TEST_INSTALL_TIMEOUT_MS: value }),
      /positive integer/u,
      `${value} is not a positive integer timeout`,
    );
  }
});

test("install failures are classified as timeout, network, or assertion", () => {
  const timedOut = Object.assign(new Error("npm install killed"), {
    killed: true,
    signal: "SIGTERM",
  });
  assert.equal(classifyCommandFailure(timedOut), "timeout");

  const unreachable = Object.assign(
    new Error("getaddrinfo ENOTFOUND registry.npmjs.org"),
    { code: "ENOTFOUND" },
  );
  assert.equal(classifyCommandFailure(unreachable), "network");

  const forbidden = Object.assign(new Error("npm ERR! code E403"), {
    stderr: "npm ERR! code E403 Forbidden - GET https://registry.npmjs.org/a",
  });
  assert.equal(classifyCommandFailure(forbidden), "network");

  const wrongContent = Object.assign(new Error("npm ERR! missing tarball"), {
    code: "ELIFECYCLE",
  });
  assert.equal(classifyCommandFailure(wrongContent), "assertion");
  assert.equal(classifyCommandFailure(new Error("plain failure")), "assertion");

  assert.match(
    describeInstallFailure(timedOut, 120_000),
    /^distribution install failed \(timeout\):/u,
  );
  assert.match(
    describeInstallFailure(unreachable, 120_000),
    /^distribution install failed \(network\):/u,
  );
  assert.match(
    describeInstallFailure(wrongContent, 120_000),
    /^distribution install failed \(assertion\):/u,
  );
});
