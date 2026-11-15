import assert from "node:assert/strict";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import { withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();

function reviewer(id, perspective, mutate = false) {
  return {
    id,
    perspective,
    tools: mutate ? ["read", "write"] : ["read", "search"],
    async review() {
      return {
        perspective,
        options: [`${perspective} option`],
        assumptions: [`${perspective} assumption`],
        disagreements: perspective === "security" ? ["needs review"] : [],
      };
    },
  };
}

test("3-4 read-only perspectives feed a human chair", async () => {
  await withTempDirectory("codepunk-requirement-team-", async (root) => {
    const baseCommit = "a".repeat(40);
    const result = await core.runRequirementTeam({
      request: "Add a bounded local cache.",
      reviewers: [
        reviewer("product-review", "product"),
        reviewer("engineering-review", "engineering"),
        reviewer("security-review", "security"),
        reviewer("cost-review", "cost"),
      ],
      chair: {
        actor: "local-user",
        human: true,
        tty: true,
        async decide(reviews) {
          return {
            confirmed: true,
            summary: reviews.map((review) => review.perspective).join(","),
            task: {
              taskId: "CACHE-1",
              title: "Bounded cache",
              objective: "Implement a bounded local cache.",
              baseCommit,
              writeSet: ["src/cache/"],
              acceptance: ["cache is bounded"],
            },
          };
        },
      },
      now: () => new Date("2026-11-13T01:00:00.000Z"),
    });
    assert.equal(result.reviews.length, 4);
    assert.equal(result.chair, "local-user");
    assert.equal(result.task_spec.task_id, "CACHE-1");
    assert.match(result.task_spec.spec_sha256, /^sha256:/u);
    assert.equal(result.summary, "product,engineering,security,cost");
  });
});

test("reviewer count, self-approval, mutating reviewers, duplicates, and unconfirmed chairs fail", async () => {
  await withTempDirectory("codepunk-requirement-team-negative-", async () => {
    const request = "Change the API.";
    const baseCommit = "b".repeat(40);
    const task = {
      taskId: "API-1",
      title: "API",
      objective: request,
      baseCommit,
      writeSet: ["src/"],
      acceptance: ["api changes"],
    };
    const chair = (human) => ({
      actor: "local-user",
      human,
      tty: true,
      async decide() {
        return { confirmed: true, summary: "confirmed", task };
      },
    });
    for (const reviewers of [
      [reviewer("p", "product"), reviewer("e", "engineering")],
      [
        reviewer("p", "product"),
        reviewer("e", "engineering"),
        reviewer("s", "security"),
        reviewer("c", "cost"),
        reviewer("p2", "product"),
      ],
    ]) {
      await assert.rejects(
        () =>
          core.runRequirementTeam({ request, reviewers, chair: chair(true) }),
        /requires 3 to 4 reviewers/u,
      );
    }
    await assert.rejects(
      () =>
        core.runRequirementTeam({
          request,
          reviewers: [
            reviewer("p", "product"),
            reviewer("e", "engineering"),
            reviewer("s", "security", true),
          ],
          chair: chair(true),
        }),
      /mutating tool/u,
    );
    await assert.rejects(
      () =>
        core.runRequirementTeam({
          request,
          reviewers: [
            reviewer("p", "product"),
            reviewer("e", "engineering"),
            reviewer("s", "security"),
          ],
          chair: chair(false),
        }),
      /human TTY/u,
    );
    await assert.rejects(
      () =>
        core.runRequirementTeam({
          request,
          reviewers: [
            reviewer("p", "product"),
            reviewer("e", "engineering"),
            reviewer("e2", "engineering"),
          ],
          chair: chair(true),
        }),
      /duplicate reviewer perspective/u,
    );
    await assert.rejects(
      () =>
        core.runRequirementTeam({
          request,
          reviewers: [
            reviewer("p", "product"),
            reviewer("e", "engineering"),
            reviewer("s", "security"),
          ],
          chair: {
            actor: "local-user",
            human: true,
            tty: true,
            async decide() {
              return { confirmed: false, summary: "not confirmed", task };
            },
          },
        }),
      /did not confirm/u,
    );
  });
});
