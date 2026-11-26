// CLI surface snapshot for spec 0014 (CLI module split, behavior unchanged).
//
// The snapshot records what a user can see without a model: root and scoped
// help, shell completion, the TUI help text, and the exact order of commands,
// shortcuts, and event handlers the TUI extension registers with Pi. The split
// must leave every file byte-identical.
//
// Snapshots are written only on request, on the commit before the split:
//
//   CODEPUNK_UPDATE_CLI_SURFACE=1 node --test tests/cli-surface.test.mjs
//
// Update mode refuses to run under CI. Without it, a missing, extra, or changed
// snapshot file fails the test.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { importSource } from "./support/core.mjs";
import {
  ensureBuilt,
  REPO_ROOT,
  withTempDirectory,
  withoutAmbientProviderEnv,
} from "./support/helpers.mjs";

const execFileAsync = promisify(execFile);
const BASE_ENV = withoutAmbientProviderEnv();
const SNAPSHOT_ROOT = path.join(REPO_ROOT, "tests", "fixtures", "cli-surface");
const UPDATE = process.env["CODEPUNK_UPDATE_CLI_SURFACE"] === "1";
const UPDATE_COMMAND =
  "CODEPUNK_UPDATE_CLI_SURFACE=1 node --test tests/cli-surface.test.mjs";

// Every subcommand with its own `--help` text, including aliases. Reviewed by
// hand: a subcommand dropped from this list must be dropped on purpose.
const SUBCOMMANDS = [
  "resume",
  "sessions",
  "prune",
  "gc",
  "migrate",
  "backup",
  "export",
  "pin",
  "sign",
  "daemon",
  "acp",
  "view",
  "completion",
  "memory",
  "setup",
  "models",
  "permissions",
  "permission",
  "trust",
  "capabilities",
  "mcp",
  "skills",
  "plugins",
  "config",
  "doctor",
  "install",
  "upgrade",
  "uninstall",
];
const SHELLS = ["bash", "zsh", "fish"];
const CLI_CONCURRENCY = 4;

async function mapLimited(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, lane),
  );
  return results;
}

function firstDifference(expected, actual) {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const length = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < length; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return [
        `line ${index + 1}`,
        `    expected: ${JSON.stringify(expectedLines[index] ?? "<end of file>")}`,
        `    actual:   ${JSON.stringify(actualLines[index] ?? "<end of file>")}`,
      ].join("\n");
    }
  }
  return "identical";
}

async function compareOrUpdate(group, files) {
  const directory = path.join(SNAPSHOT_ROOT, group);
  if (UPDATE) {
    assert.equal(
      process.env["CI"],
      undefined,
      "CLI surface snapshots must not be regenerated in CI",
    );
    await fs.rm(directory, { recursive: true, force: true });
    await fs.mkdir(directory, { recursive: true });
    for (const [name, content] of files) {
      await fs.writeFile(path.join(directory, name), content, "utf8");
    }
    return;
  }
  let existing;
  try {
    existing = (await fs.readdir(directory)).sort();
  } catch (error) {
    if (error?.code === "ENOENT") {
      assert.fail(
        `no ${group} surface snapshot at tests/fixtures/cli-surface/${group}; ` +
          `on the commit before the split run: ${UPDATE_COMMAND}`,
      );
    }
    throw error;
  }
  const produced = new Map(files);
  const problems = [];
  for (const name of existing) {
    if (!produced.has(name)) {
      problems.push(`${group}/${name}: snapshot has no matching output`);
    }
  }
  for (const [name, actual] of produced) {
    if (!existing.includes(name)) {
      problems.push(`${group}/${name}: output has no snapshot`);
      continue;
    }
    const expected = await fs.readFile(path.join(directory, name), "utf8");
    if (expected !== actual) {
      problems.push(`${group}/${name}: ${firstDifference(expected, actual)}`);
    }
  }
  if (problems.length > 0) {
    assert.fail(
      [
        `${problems.length} CLI surface difference(s):`,
        ...problems.slice(0, 20),
        problems.length > 20 ? `... and ${problems.length - 20} more` : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    );
  }
}

function describeCall(method, args) {
  const [first, second] = args;
  const key = typeof first === "string" ? ` ${first}` : "";
  const description =
    second !== null &&
    typeof second === "object" &&
    typeof second.description === "string"
      ? `\t${second.description}`
      : "";
  return `${method}${key}${description}`;
}

test(
  "the CLI help and completion surface matches the snapshot",
  { timeout: 300_000 },
  async () => {
    const cli = await ensureBuilt();
    await withTempDirectory("codepunk-cli-surface-", async (root) => {
      const cwd = path.join(root, "project");
      const home = path.join(root, "home");
      await fs.mkdir(cwd, { recursive: true });
      await fs.mkdir(home, { recursive: true });
      const invocations = [
        ["help.txt", ["--help"]],
        ...SUBCOMMANDS.map((command) => [
          `help-${command}.txt`,
          [command, "--help"],
        ]),
        ...SHELLS.map((shell) => [
          `completion-${shell}.txt`,
          ["completion", shell],
        ]),
      ];
      const outputs = await mapLimited(
        invocations,
        CLI_CONCURRENCY,
        async ([name, args]) => {
          const { stdout } = await execFileAsync(
            process.execPath,
            [cli, ...args],
            {
              cwd,
              env: { ...BASE_ENV, CODEPUNK_HOME: home, NO_COLOR: "1" },
              maxBuffer: 8 * 1024 * 1024,
            },
          );
          return [name, stdout];
        },
      );
      const rootHelp = outputs[0][1];
      for (const [name, stdout] of outputs.slice(1, SUBCOMMANDS.length + 1)) {
        assert.notEqual(
          stdout,
          rootHelp,
          `${name} fell back to the root help; the subcommand lost its scoped usage`,
        );
      }
      await compareOrUpdate("cli", outputs);
    });
  },
);

test("the TUI command registration matches the snapshot", async () => {
  const { createTuiExtension, codepunkHelp } = await importSource(
    "packages/cli/src/tui.ts",
  );
  const calls = [];
  const pi = new Proxy(
    {},
    {
      get(_target, method) {
        if (typeof method !== "string" || method === "then") {
          return undefined;
        }
        return (...args) => {
          calls.push(describeCall(method, args));
          if (method === "getCommands") {
            return [];
          }
          if (method === "on") {
            return () => {};
          }
          return undefined;
        };
      },
    },
  );
  // No runtime: registration must not depend on a live session. With no
  // runtime the keymap falls back to its defaults.
  const state = {
    runtime: null,
    context: null,
    channel: { attach() {} },
    lastRunId: null,
    lastEvidence: 0,
    warningsShown: false,
    modelSelected: false,
    ready: false,
    shuttingDown: false,
    hostCommands: new Set(),
    childHostArgv: [],
  };
  const extension = createTuiExtension(state, { attach() {} });
  await extension.factory(pi);

  const commandNames = calls
    .filter((call) => call.startsWith("registerCommand "))
    .map((call) => call.split("\t")[0]);
  assert.equal(
    new Set(commandNames).size,
    commandNames.length,
    "a slash command is registered twice",
  );
  assert.ok(commandNames.length > 0, "no slash command was registered");

  await compareOrUpdate("tui", [
    [
      "registration.txt",
      [
        `extension ${extension.name} hidden=${extension.hidden === true}`,
        ...calls,
        "",
      ].join("\n"),
    ],
    ["help.txt", `${codepunkHelp().replace(/\n+$/u, "")}\n`],
  ]);
});
