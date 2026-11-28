#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TESTS_DIR = path.join(REPO_ROOT, "tests");

const PTY_TEST_FILES = new Set([
  "pi-upgrade-drill.test.mjs",
  "session-replacement.test.mjs",
  "terminal.test.mjs",
  "tui-pty-core.test.mjs",
  "tui-pty-trust.test.mjs",
  "tui-pty-workflow.test.mjs",
  "verdict-signoff.test.mjs",
]);

const tier = process.argv[2] ?? "all";
const allTests = readdirSync(TESTS_DIR)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();

let selected;
if (tier === "unit") {
  selected = allTests.filter((name) => !PTY_TEST_FILES.has(name));
} else if (tier === "pty") {
  selected = allTests.filter((name) => PTY_TEST_FILES.has(name));
} else if (tier === "all") {
  selected = allTests;
} else {
  process.stderr.write(`usage: node scripts/run-tests.mjs [all|unit|pty]\n`);
  process.exit(2);
}

const args = [
  "--test",
  "--test-timeout=300000",
  ...selected.map((name) => path.join("tests", name)),
];

const result = spawnSync(process.execPath, args, {
  cwd: REPO_ROOT,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
