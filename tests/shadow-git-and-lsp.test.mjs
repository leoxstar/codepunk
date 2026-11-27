import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { importCore } from "./support/core.mjs";
import { withTempDirectory, writeFile } from "./support/helpers.mjs";
import { TEST_MODEL } from "./support/pi-model.mjs";

const core = await importCore();
const execFileAsync = promisify(execFile);

async function makeCommittedRepo(root) {
  const project = path.join(root, "project");
  await fs.mkdir(project, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: project });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: project });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: project,
  });
  await writeFile(
    path.join(project, "src", "app.ts"),
    "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n",
  );
  await writeFile(
    path.join(project, "src", "legacy.ts"),
    "export const OLD = 1;\n",
  );
  await execFileAsync("git", ["add", "."], { cwd: project });
  await execFileAsync("git", ["commit", "-q", "-m", "initial"], {
    cwd: project,
  });
  return project;
}

test("ShadowGitStore atomically rewinds multi-file bash mutations (modified, deleted, and newly generated files) without touching workspace .git", async () => {
  await withTempDirectory("codepunk-shadow-git-", async (root) => {
    const project = await makeCommittedRepo(root);
    const home = path.join(root, "home");
    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n[approval]\nmode = "allow"\n',
    );

    const headBefore = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: project })
    ).stdout.trim();
    const indexStatBefore = await fs.stat(path.join(project, ".git", "index"));

    const runtime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      model: TEST_MODEL,
      allowUnsandboxedShell: true,
    });
    try {
      const bashDef = runtime.host.session.getToolDefinition("bash");
      assert.ok(bashDef);

      // Mutate 3 ways inside a single bash script: modify app.ts, delete legacy.ts, create generated.ts
      const script = [
        "const fs = require('node:fs');",
        "fs.writeFileSync('src/app.ts', 'export function greet(name: string): string { return \"v2\"; }\\n');",
        "fs.unlinkSync('src/legacy.ts');",
        "fs.writeFileSync('src/generated.ts', 'export const GEN = true;\\n');",
      ].join(" ");
      const res = await bashDef.execute(
        "bash-multi-mutate",
        {
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
        },
        undefined,
        undefined,
        {},
      );
      assert.notEqual(res.isError, true);

      assert.match(
        await fs.readFile(path.join(project, "src", "app.ts"), "utf8"),
        /v2/u,
      );
      await assert.rejects(() =>
        fs.access(path.join(project, "src", "legacy.ts")),
      );
      await fs.access(path.join(project, "src", "generated.ts"));

      // Workspace .git HEAD and index mtime must remain untouched by ShadowGitStore
      const headAfterBash = (
        await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: project })
      ).stdout.trim();
      const indexStatAfterBash = await fs.stat(
        path.join(project, ".git", "index"),
      );
      assert.equal(headAfterBash, headBefore);
      assert.equal(indexStatAfterBash.mtimeMs, indexStatBefore.mtimeMs);

      const snapshots = await runtime.shadowGit.list();
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0].tool, "bash");

      // Negative control: out-of-range stepsBack fails cleanly without mutating files
      await assert.rejects(
        () => runtime.shadowGit.rewindSteps(5),
        /only 1 shadow snapshot/u,
      );

      // Rewind 1 step -> restores app.ts to v1, brings back legacy.ts, deletes generated.ts!
      const rewound = await runtime.shadowGit.rewindSteps(1);
      assert.ok(rewound.restoredFiles.includes("src/app.ts"));
      assert.ok(rewound.restoredFiles.includes("src/legacy.ts"));
      assert.ok(rewound.removedAddedFiles.includes("src/generated.ts"));

      assert.match(
        await fs.readFile(path.join(project, "src", "app.ts"), "utf8"),
        /hello \$\{name\}/u,
      );
      assert.equal(
        await fs.readFile(path.join(project, "src", "legacy.ts"), "utf8"),
        "export const OLD = 1;\n",
      );
      await assert.rejects(
        () => fs.access(path.join(project, "src", "generated.ts")),
        "newly generated file from bash must be removed on rewind",
      );
    } finally {
      await runtime.dispose();
    }
  });
});

test("lsp_query finds symbols, definitions, and references in plan mode while blocking untrusted tsc trojans and outside paths", async () => {
  await withTempDirectory("codepunk-lsp-query-", async (root) => {
    const project = await makeCommittedRepo(root);
    const home = path.join(root, "home");
    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await writeFile(
      path.join(project, "src", "caller.ts"),
      'import { greet } from "./app.ts";\nexport function runCaller(): string {\n  return greet("world");\n}\n',
    );
    await writeFile(
      path.join(project, "tsconfig.json"),
      '{"compilerOptions":{"strict":true}}\n',
    );

    // Plant a fake node_modules/.bin/tsc trojan in an UNTRUSTED workspace!
    const trojanMarker = path.join(root, "trojan-ran.txt");
    if (process.platform !== "win32") {
      const binDir = path.join(project, "node_modules", ".bin");
      await fs.mkdir(binDir, { recursive: true });
      const trojanPath = path.join(binDir, "tsc");
      await fs.writeFile(
        trojanPath,
        `#!/bin/sh\necho pwned > ${JSON.stringify(trojanMarker)}\nexit 1\n`,
        { mode: 0o755 },
      );
    }

    const runtime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      model: TEST_MODEL,
      projectTrust: {
        config: false,
        policy: false,
        skills: false,
        instructions: false,
      },
    });
    try {
      await runtime.planMode.enter();
      const lspDef = runtime.host.session.getToolDefinition("lsp_query");
      assert.ok(lspDef, "lsp_query is active even in read-only plan mode");

      const defs = await lspDef.execute(
        "lsp-def-1",
        { action: "definition", symbol: "greet" },
        undefined,
        undefined,
        {},
      );
      assert.notEqual(defs.isError, true);
      assert.match(
        defs.content[0].text,
        /src\/app\.ts:1 \[function · export\]/u,
      );

      const refs = await lspDef.execute(
        "lsp-ref-1",
        { action: "references", symbol: "greet" },
        undefined,
        undefined,
        {},
      );
      assert.notEqual(refs.isError, true);
      assert.equal(refs.structuredContent.count, 3);

      // Untrusted workspace diagnostics: MUST NOT execute node_modules/.bin/tsc!
      await writeFile(
        path.join(project, "src", "broken.ts"),
        "export function oops( {\n  return 1;\n",
      );
      const diag = await lspDef.execute(
        "lsp-diag-untrusted",
        { action: "diagnostics" },
        undefined,
        undefined,
        {},
      );
      assert.notEqual(diag.isError, true);
      assert.equal(diag.structuredContent.ran_tsc, false);
      assert.ok(
        diag.structuredContent.diagnostics.some(
          (d) => d.file === "src/broken.ts",
        ),
        "safe lexical syntax check still catches broken.ts",
      );
      await assert.rejects(
        () => fs.access(trojanMarker),
        "untrusted workspace node_modules/.bin/tsc must NEVER be executed",
      );

      // Negative control: outside path is denied by policy!
      const outside = await lspDef.execute(
        "lsp-outside",
        { action: "symbols", path: "../outside.ts" },
        undefined,
        undefined,
        {},
      );
      assert.equal(outside.isError, true);
      assert.equal(runtime.ledger.all.at(-1)?.decision, "deny");
    } finally {
      await runtime.dispose();
    }

    // Pure parser check for real tsc --noEmit --pretty false output
    const parsed = core.parseTscDiagnosticsOutput(
      "src/caller.ts(3,10): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.\n",
      project,
    );
    assert.deepEqual(parsed, [
      {
        file: "src/caller.ts",
        line: 3,
        column: 10,
        code: "TS2345",
        message:
          "Argument of type 'number' is not assignable to parameter of type 'string'.",
        source: "tsc",
      },
    ]);
  });
});
