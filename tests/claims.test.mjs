import assert from "node:assert/strict";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import { makeProject, withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();

function clock(start) {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advance(milliseconds) {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

test("claims persist a monotonic fence and reject live duplicates", async () => {
  await withTempDirectory("codepunk-claims-", async (root) => {
    const { paths } = await makeProject(root);
    const time = clock("2026-11-13T02:00:00.000Z");
    const store = new core.ClaimStore({
      paths,
      leaseMs: 1_000,
      now: time.now,
    });
    const first = await store.acquire("TASK-1", "worker-a");
    assert.equal(first.fence, 1);
    await assert.rejects(
      () => store.acquire("TASK-1", "worker-b"),
      /already claimed/u,
    );
    await assert.rejects(
      () => store.renew({ ...first, owner: "worker-b" }),
      /stale/u,
    );

    time.advance(1_500);
    assert.equal(await store.inspect("TASK-1"), null);
    const replacement = await store.acquire("TASK-1", "worker-b");
    assert.equal(replacement.fence, 2);
    await assert.rejects(() => store.renew(first), /stale/u);

    const reopened = new core.ClaimStore({
      paths,
      leaseMs: 1_000,
      now: time.now,
    });
    assert.equal(await reopened.nextFence(), 2);
    const replacement2 = await reopened.acquire("TASK-2", "worker-c");
    assert.equal(replacement2.fence, 3);
  });
});

test("release and live assertion never authorize a stale claim", async () => {
  await withTempDirectory("codepunk-claim-live-", async (root) => {
    const { paths } = await makeProject(root);
    const time = clock("2026-11-13T03:00:00.000Z");
    const store = new core.ClaimStore({
      paths,
      leaseMs: 1_000,
      now: time.now,
    });
    const claim = await store.acquire("TASK-1", "worker-a");
    await core.ClaimStore.prototype.assertLive.call(store, claim);
    time.advance(1_500);
    await assert.rejects(
      () => core.ClaimStore.prototype.assertLive.call(store, claim),
      /stale/u,
    );
    await store.release(claim);
    assert.equal(await store.inspect("TASK-1"), null);
    const next = await store.acquire("TASK-1", "worker-b");
    assert.equal(next.fence, 2);
  });
});
