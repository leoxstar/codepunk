import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { importCore } from "./support/core.mjs";
import { privateFileStatus, withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();
const execFileAsync = promisify(execFile);

async function snapshot(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    const bytes = await fs.readFile(filePath);
    return {
      exists: true,
      bytes,
      sha256: core.sha256Bytes(bytes),
      mode: stat.mode & 0o7777,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        exists: false,
        bytes: Buffer.alloc(0),
        sha256: core.sha256Bytes(Buffer.alloc(0)),
        mode: null,
      };
    }
    throw error;
  }
}

function makeStore(root, options = {}) {
  return new core.CheckpointStore({
    sessionDir: path.join(root, "session"),
    workspaceRoot: path.join(root, "project"),
    ...options,
  });
}

test("checkpoints restore the exact before image and redo the after image", async () => {
  await withTempDirectory("codepunk-checkpoints-", async (root) => {
    const project = path.join(root, "project");
    const file = path.join(project, "src", "main.ts");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "export const value = 1;\n", { mode: 0o755 });
    const store = makeStore(root);
    const before = await snapshot(file);
    await fs.writeFile(file, "export const value = 2;\n");
    const after = await snapshot(file);

    const entry = await store.record({
      tool: "write",
      toolCallId: "call-1",
      target: file,
      before,
      after,
    });
    assert.ok(entry);
    assert.equal(entry.display_target, "src/main.ts");
    assert.equal((await store.preview("undo")).entries.length, 1);
    assert.equal(await fs.readFile(file, "utf8"), "export const value = 2;\n");

    await store.undo();
    assert.equal(await fs.readFile(file, "utf8"), "export const value = 1;\n");
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(file)).mode & 0o777, 0o755);
    }
    assert.equal((await store.preview("redo")).entries.length, 1);

    await store.redo();
    assert.equal(await fs.readFile(file, "utf8"), "export const value = 2;\n");
    assert.equal((await store.preview("undo")).entries.length, 1);
  });
});

test("checkpoint undo redo and conflict", async () => {
  await withTempDirectory("codepunk-checkpoints-contract-", async (root) => {
    const project = path.join(root, "project");
    const file = path.join(project, "file.txt");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(file, "before\n");
    const store = makeStore(root);
    const before = await snapshot(file);
    await fs.writeFile(file, "after\n");
    const after = await snapshot(file);
    await store.record({
      tool: "write",
      toolCallId: "call-1",
      target: file,
      before,
      after,
    });

    await store.undo();
    assert.equal(await fs.readFile(file, "utf8"), "before\n");
    await store.redo();
    assert.equal(await fs.readFile(file, "utf8"), "after\n");

    await fs.writeFile(file, "external\n");
    await assert.rejects(
      store.undo(),
      (error) => error instanceof core.CheckpointConflictError,
    );
    assert.equal(await fs.readFile(file, "utf8"), "external\n");
  });
});

test("checkpoints accept provider tool call ids with separators", async () => {
  await withTempDirectory("codepunk-checkpoints-tool-id-", async (root) => {
    const project = path.join(root, "project");
    const file = path.join(project, "file.txt");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(file, "before\n");
    const store = makeStore(root);
    const before = await snapshot(file);
    await fs.writeFile(file, "after\n");
    const after = await snapshot(file);

    const toolCallId = "call_00_abc123|01282db4-1565-3334-941f-e0fe2da3bebe";
    const entry = await store.record({
      tool: "write",
      toolCallId,
      target: file,
      before,
      after,
    });
    assert.ok(entry);
    assert.equal(entry.tool_call_id, toolCallId);

    const reloaded = makeStore(root);
    assert.equal((await reloaded.preview("undo")).entries.length, 1);
    await reloaded.undo();
    assert.equal(await fs.readFile(file, "utf8"), "before\n");
    await reloaded.redo();
    assert.equal(await fs.readFile(file, "utf8"), "after\n");
  });
});

test("checkpoints skip tool call ids with control characters", async () => {
  await withTempDirectory("codepunk-checkpoints-tool-id-bad-", async (root) => {
    const project = path.join(root, "project");
    const file = path.join(project, "file.txt");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(file, "before\n");
    const store = makeStore(root);
    const before = await snapshot(file);
    await fs.writeFile(file, "after\n");
    const after = await snapshot(file);

    assert.equal(
      await store.record({
        tool: "write",
        toolCallId: "call\ninjected",
        target: file,
        before,
        after,
      }),
      null,
    );
    assert.equal((await store.preview("undo")).entries.length, 0);
  });
});

test("checkpoints can undo and redo multiple changes in order", async () => {
  await withTempDirectory("codepunk-checkpoints-multi-", async (root) => {
    const project = path.join(root, "project");
    const file = path.join(project, "notes.txt");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(file, "zero\n");
    const store = makeStore(root);

    for (const [index, value] of ["one\n", "two\n"].entries()) {
      const before = await snapshot(file);
      await fs.writeFile(file, value);
      const after = await snapshot(file);
      assert.ok(
        await store.record({
          tool: "write",
          toolCallId: `call-${index}`,
          target: file,
          before,
          after,
        }),
      );
    }

    const undone = await store.undo(2);
    assert.equal(undone.entries.length, 2);
    assert.equal(await fs.readFile(file, "utf8"), "zero\n");
    const redone = await store.redo(2);
    assert.equal(redone.entries.length, 2);
    assert.equal(await fs.readFile(file, "utf8"), "two\n");
  });
});

test(
  "checkpoint restore leaves the workspace directory ACL unchanged",
  { skip: process.platform !== "win32" ? "Windows-only ACLs" : false },
  async () => {
    await withTempDirectory("codepunk-checkpoints-acl-", async (root) => {
      const project = path.join(root, "project");
      const file = path.join(project, "file.txt");
      await fs.mkdir(project, { recursive: true });
      await execFileAsync("icacls.exe", [
        project,
        "/grant",
        "*S-1-1-0:(OI)(CI)R",
      ]);
      await fs.writeFile(file, "before\n");
      const store = makeStore(root);
      const before = await snapshot(file);
      await fs.writeFile(file, "after\n");
      const after = await snapshot(file);
      assert.ok(
        await store.record({
          tool: "write",
          toolCallId: "call-acl",
          target: file,
          before,
          after,
        }),
      );

      await store.undo();
      await store.redo();

      const status = await privateFileStatus(project);
      assert.equal(
        status.ok,
        false,
        `checkpoint restore stamped the workspace private (${status.detail})`,
      );
      assert.equal(await fs.readFile(file, "utf8"), "after\n");
    });
  },
);

test("checkpoints refuse to overwrite an externally changed file", async () => {
  await withTempDirectory("codepunk-checkpoints-conflict-", async (root) => {
    const project = path.join(root, "project");
    const file = path.join(project, "file.txt");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(file, "before\n");
    const store = makeStore(root);
    const before = await snapshot(file);
    await fs.writeFile(file, "after\n");
    const after = await snapshot(file);
    await store.record({
      tool: "write",
      toolCallId: "call-1",
      target: file,
      before,
      after,
    });

    await fs.writeFile(file, "external\n");
    await assert.rejects(
      store.undo(),
      (error) => error instanceof core.CheckpointConflictError,
    );
    assert.equal(await fs.readFile(file, "utf8"), "external\n");
  });
});

test("checkpoints can delete a newly created file and restore it on redo", async () => {
  await withTempDirectory("codepunk-checkpoints-new-", async (root) => {
    const project = path.join(root, "project");
    const file = path.join(project, "new.txt");
    await fs.mkdir(project, { recursive: true });
    const store = makeStore(root);
    const before = await snapshot(file);
    await fs.writeFile(file, "created\n");
    const after = await snapshot(file);
    await store.record({
      tool: "write",
      toolCallId: "call-1",
      target: file,
      before,
      after,
    });

    await store.undo();
    await assert.rejects(fs.readFile(file, "utf8"), /ENOENT/u);
    await store.redo();
    assert.equal(await fs.readFile(file, "utf8"), "created\n");
  });
});

test("oversized checkpoints are skipped instead of failing the mutation", async () => {
  await withTempDirectory("codepunk-checkpoints-limit-", async (root) => {
    const project = path.join(root, "project");
    const file = path.join(project, "large.txt");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(file, "small\n");
    const store = makeStore(root, { maxFileBytes: 4 });
    const before = await snapshot(file);
    await fs.writeFile(file, "still small\n");
    const after = await snapshot(file);
    assert.equal(
      await store.record({
        tool: "write",
        toolCallId: "call-1",
        target: file,
        before,
        after,
      }),
      null,
    );
    assert.equal((await store.list()).length, 0);
  });
});
