import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  ensureBuilt,
  REPO_ROOT,
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
      const { stdout } = await execFileAsync(
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
    await execFileAsync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        ...packed,
      ],
      { cwd: install, timeout: 120_000 },
    );
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
    assert.equal(version.stdout.trim(), "codepunk 0.0.0");
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
