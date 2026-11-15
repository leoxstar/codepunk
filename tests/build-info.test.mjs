import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { ensureBuilt, withTempDirectory } from "./support/helpers.mjs";

async function loadBuildInfoModule() {
  const entry = await ensureBuilt();
  return import(
    pathToFileURL(path.join(path.dirname(entry), "build-info.js")).href
  );
}

async function writeFixturePackage(root, name) {
  const packageRoot = path.join(root, "packages", name);
  await fs.mkdir(path.join(packageRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: `@codepunk/${name}`, version: "0.0.0" })}\n`,
  );
  await fs.writeFile(
    path.join(packageRoot, "src", "index.ts"),
    "export const value = 1;\n",
  );
  await fs.writeFile(
    path.join(packageRoot, "dist", "index.js"),
    "export const value = 1;\n",
  );
}

test("build inspection distinguishes current, stale, and installed packages", async () => {
  const { inspectCliBuild } = await loadBuildInfoModule();
  await withTempDirectory("codepunk-build-info-", async (root) => {
    for (const name of ["protocol", "core", "cli"]) {
      await writeFixturePackage(root, name);
    }
    const moduleUrl = pathToFileURL(
      path.join(root, "packages", "cli", "dist", "build-info.js"),
    ).href;
    const current = await inspectCliBuild(moduleUrl);
    assert.equal(current.version, "0.0.0");
    assert.equal(current.stale, false);

    const old = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-01-02T00:00:00.000Z");
    for (const name of ["protocol", "core", "cli"]) {
      const packageRoot = path.join(root, "packages", name);
      await fs.utimes(path.join(packageRoot, "dist", "index.js"), old, old);
      await fs.utimes(path.join(packageRoot, "src", "index.ts"), newer, newer);
    }
    const stale = await inspectCliBuild(moduleUrl);
    assert.equal(stale.stale, true);
    assert.match(stale.sourceNewest ?? "", /^2026-01-02/u);

    for (const name of ["protocol", "core", "cli"]) {
      await fs.rm(path.join(root, "packages", name, "src"), {
        recursive: true,
        force: true,
      });
    }
    const installed = await inspectCliBuild(moduleUrl);
    assert.equal(installed.stale, null);
  });
});
