import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import { withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();

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
    assert.equal((await fs.stat(file)).mode & 0o777, 0o755);
    assert.equal((await store.preview("redo")).entries.length, 1);

    await store.redo();
    assert.equal(await fs.readFile(file, "utf8"), "export const value = 2;\n");
    assert.equal((await store.preview("undo")).entries.length, 1);
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
