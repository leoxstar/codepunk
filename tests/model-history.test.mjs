import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { assertPrivateFile, withTempDirectory } from "./support/helpers.mjs";
import { importSource } from "./support/core.mjs";

const historyModule = await importSource("packages/cli/src/model-history.ts");

test("model history starts empty and rejects malformed references", async () => {
  await withTempDirectory("codepunk-model-history-", async (root) => {
    const empty = await historyModule.readModelHistory(root);
    assert.deepEqual(empty, { recent: [], favorites: [], warning: null });
    await assert.rejects(
      historyModule.recordRecentModel(root, "not-a-reference"),
      /invalid model reference/u,
    );
    await assert.rejects(
      historyModule.recordRecentModel(root, "local/chat extra"),
      /invalid model reference/u,
    );
  });
});

test("recent models are unique, newest first, and capped", async () => {
  await withTempDirectory("codepunk-model-history-", async (root) => {
    for (let index = 0; index < 12; index += 1) {
      await historyModule.recordRecentModel(root, `local/model-${index}`);
    }
    await historyModule.recordRecentModel(root, "local/model-5");
    const history = await historyModule.readModelHistory(root);
    assert.equal(history.recent.length, historyModule.RECENT_MODEL_LIMIT);
    assert.equal(history.recent[0], "local/model-5");
    assert.equal(new Set(history.recent).size, history.recent.length);
    assert.equal(history.recent.includes("local/model-0"), false);
    assert.equal(history.recent.includes("local/model-1"), false);
  });
});

test("favorites toggle without disturbing recent models", async () => {
  await withTempDirectory("codepunk-model-history-", async (root) => {
    await historyModule.recordRecentModel(root, "local/chat");
    const added = await historyModule.toggleFavoriteModel(root, "local/chat");
    assert.equal(added.favorite, true);
    assert.deepEqual(added.history.favorites, ["local/chat"]);
    assert.deepEqual(added.history.recent, ["local/chat"]);

    const reloaded = await historyModule.readModelHistory(root);
    assert.deepEqual(reloaded.favorites, ["local/chat"]);
    assert.deepEqual(reloaded.recent, ["local/chat"]);

    const removed = await historyModule.toggleFavoriteModel(root, "local/chat");
    assert.equal(removed.favorite, false);
    assert.deepEqual(removed.history.favorites, []);
    assert.deepEqual(removed.history.recent, ["local/chat"]);
  });
});

test("model history stays private and reports unreadable state", async () => {
  await withTempDirectory("codepunk-model-history-", async (root) => {
    await historyModule.recordRecentModel(root, "local/chat");
    const file = historyModule.modelHistoryPath(root);
    await assertPrivateFile(file);

    await fs.writeFile(file, "{not json\n");
    const corrupt = await historyModule.readModelHistory(root);
    assert.deepEqual(corrupt.recent, []);
    assert.deepEqual(corrupt.favorites, []);
    assert.match(corrupt.warning, /not valid JSON/u);

    await fs.writeFile(
      file,
      JSON.stringify({ version: 2, recent: ["local/chat"], favorites: [] }),
    );
    const newer = await historyModule.readModelHistory(root);
    assert.deepEqual(newer.recent, []);
    assert.match(newer.warning, /unsupported shape/u);
  });
});

test("nextRecentModel cycles only through available models", async () => {
  const available = new Set(["local/a", "local/b"]);
  assert.equal(
    historyModule.nextRecentModel(
      ["local/a", "local/stale", "local/b"],
      "local/a",
      available,
    ),
    "local/b",
  );
  assert.equal(
    historyModule.nextRecentModel(
      ["local/a", "local/stale", "local/b"],
      "local/b",
      available,
    ),
    "local/a",
  );
  assert.equal(
    historyModule.nextRecentModel(["local/stale"], "local/a", available),
    null,
  );
  assert.equal(
    historyModule.nextRecentModel(
      ["local/stale", "local/b"],
      "local/a",
      available,
    ),
    "local/b",
  );
});
