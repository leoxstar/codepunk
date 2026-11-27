import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRepository } from "../scripts/check-repo.mjs";
import { importCore } from "./support/core.mjs";
import { withTempDirectory } from "./support/helpers.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function listCoreTsFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listCoreTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results.sort();
}

test("every packages/core/src TypeScript file stays within 1500 lines and preserves core exports", async () => {
  const core = await importCore();
  assert.equal(typeof core.createPiHost, "function");
  assert.equal(typeof core.createRuntime, "function");
  assert.equal(typeof core.loadIsolatedPluginBundle, "function");
  assert.equal(typeof core.PluginHost?.start, "function");

  const coreSrc = path.join(REPO_ROOT, "packages", "core", "src");
  const files = await listCoreTsFiles(coreSrc);
  assert.ok(files.length > 40);
  for (const file of files) {
    const content = await fs.readFile(file, "utf8");
    const lines = content.endsWith("\n")
      ? content.slice(0, -1).split("\n").length
      : content.split("\n").length;
    assert.ok(
      lines <= 1500,
      `${path.relative(REPO_ROOT, file)} has ${lines} lines (limit 1500)`,
    );
  }
});

test("checkRepository core.size negative control rejects >1500-line core source files", async () => {
  await withTempDirectory("codepunk-core-size-gate-", async (tempRoot) => {
    const coreDir = path.join(tempRoot, "packages", "core", "src");
    await fs.mkdir(coreDir, { recursive: true });
    const oversizedLines = Array.from(
      { length: 1505 },
      (_, idx) => `export const v${idx} = ${idx};`,
    ).join("\n");
    await fs.writeFile(
      path.join(coreDir, "oversized.ts"),
      `${oversizedLines}\n`,
      "utf8",
    );

    const result = await checkRepository({ root: tempRoot });
    const coreSizeFinding = result.errors.find(
      (err) =>
        err.rule === "core.size" &&
        err.path === "packages/core/src/oversized.ts",
    );
    assert.ok(
      coreSizeFinding,
      `expected core.size finding, got: ${JSON.stringify(result.errors)}`,
    );
    assert.match(coreSizeFinding.message, /1505 lines; limit is 1500/u);
  });
});
