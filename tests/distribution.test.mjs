import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  classifyCommandFailure,
  DEFAULT_INSTALL_TIMEOUT_MS,
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

test("packed CLI tarball excludes runtime state, bundles internal packages and host-child, and installs standalone", async () => {
  await ensureBuilt();
  await withTempDirectory("codepunk-distribution-", async (root) => {
    const { stdout } = await execFilePortable(
      "pnpm",
      [
        "--filter",
        "codepunk-cli",
        "pack",
        "--json",
        "--pack-destination",
        root,
      ],
      { cwd: REPO_ROOT },
    );
    const filename = JSON.parse(stdout).filename;
    const listing = await execFileAsync("tar", ["-tzf", filename]);
    const files = listing.stdout.split("\n").filter(Boolean);
    assert.equal(
      files.some((file) =>
        /^package\/(?:verify|tests|node_modules|\.codepunk|sessions|evidence|logs|artifacts|cache)\//u.test(
          file,
        ),
      ),
      false,
      "codepunk-cli tarball contains runtime or verification state",
    );
    assert.equal(
      files.some((file) => file.endsWith(".jsonl")),
      false,
    );
    assert.equal(
      files.includes("package/dist/index.js"),
      true,
      "codepunk-cli tarball must include dist/index.js",
    );
    assert.equal(
      files.includes("package/dist/host-child.js"),
      true,
      "codepunk-cli tarball must include bundled dist/host-child.js for isolated plugins",
    );

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
          filename,
        ],
        { cwd: install, timeout: installTimeoutMs },
      );
    } catch (error) {
      assert.fail(describeInstallFailure(error, installTimeoutMs));
    }
    const version = await execFileAsync(
      process.execPath,
      [
        path.join(install, "node_modules", "codepunk-cli", "dist", "index.js"),
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
    for (const internalPkg of ["codepunk-core", "codepunk-protocol"]) {
      await assert.rejects(
        () => fs.access(path.join(install, "node_modules", internalPkg)),
        /ENOENT/u,
        `${internalPkg} must not be installed separately alongside codepunk-cli`,
      );
    }
    const hostChildPath = path.join(
      install,
      "node_modules",
      "codepunk-cli",
      "dist",
      "host-child.js",
    );
    await fs.access(hostChildPath);

    // Negative control: bundled host-child rejects mismatched launch credentials.
    const pluginDir = path.join(root, "isolated-plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    const pluginEntry = path.join(pluginDir, "index.mjs");
    await fs.writeFile(
      pluginEntry,
      [
        "export default function register(api) {",
        '  api.registerTool({ name: "hello_tarball", execute: async () => ({ ok: true }) });',
        "}",
        "",
      ].join("\n"),
    );
    const badChild = spawn(
      process.execPath,
      [hostChildPath, pluginDir, pluginEntry, "tarball-plugin"],
      { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] },
    );
    let badStderr = "";
    badChild.stderr.on("data", (chunk) => {
      badStderr += chunk.toString("utf8");
    });
    badChild.stdio[3].end("wrong-token\n");
    badChild.stdio[4].end("expected-token\n");
    const badCode = await new Promise((resolve) =>
      badChild.on("close", resolve),
    );
    assert.equal(badCode, 2);
    assert.match(badStderr, /launch credential does not match/u);

    // Positive proof: bundled host-child loads plugin and answers tools/list + shutdown.
    const goodChild = spawn(
      process.execPath,
      [hostChildPath, pluginDir, pluginEntry, "tarball-plugin"],
      { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] },
    );
    let goodStdout = "";
    goodChild.stdout.on("data", (chunk) => {
      goodStdout += chunk.toString("utf8");
    });
    goodChild.stdio[3].end("secret-token-123\n");
    goodChild.stdio[4].end("secret-token-123\n");
    goodChild.stdin.write(
      `${JSON.stringify({
        type: "codepunk/plugin-request",
        version: 1,
        call_id: "c1",
        plugin_id: "tarball-plugin",
        method: "tools/list",
        params: {},
      })}\n`,
    );
    goodChild.stdin.write(
      `${JSON.stringify({
        type: "codepunk/plugin-request",
        version: 1,
        call_id: "c2",
        plugin_id: "tarball-plugin",
        method: "shutdown",
        params: {},
      })}\n`,
    );
    const goodCode = await new Promise((resolve) =>
      goodChild.on("close", resolve),
    );
    assert.equal(goodCode, 0);
    const responses = goodStdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const listRes = responses.find((frame) => frame.call_id === "c1");
    assert.deepEqual(listRes?.result, ["hello_tarball"]);

    const installed = await fs.readdir(
      path.join(install, "node_modules", "codepunk-cli"),
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
  assert.equal(resolveInstallTimeoutMs({}), DEFAULT_INSTALL_TIMEOUT_MS);
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
