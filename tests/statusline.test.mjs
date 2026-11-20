import assert from "node:assert/strict";
import test from "node:test";
import { importSource } from "./support/core.mjs";

const { renderStatusline } = await importSource(
  "packages/cli/src/statusline.ts",
);

const values = {
  model: "codepunk · local/model",
  session: "project p · session s",
  sandbox: "next sandbox required",
  filesystem: "fs workspace",
  policy: "permissions standard · trust trusted",
  budget: "budget off",
};

test("the default statusline keeps the established three groups", () => {
  assert.equal(
    renderStatusline(
      ["model", "session", "sandbox", "filesystem", "policy", "budget"],
      values,
    ),
    [
      "codepunk · local/model",
      "project p · session s · next sandbox required · fs workspace",
      "permissions standard · trust trusted · budget off",
    ].join("\n"),
  );
});

test("statusline segments follow configured order and omission", () => {
  assert.equal(
    renderStatusline(["budget", "model", "filesystem"], values),
    ["budget off", "codepunk · local/model", "fs workspace"].join("\n"),
  );
  assert.equal(
    renderStatusline(["policy", "budget"], values),
    "permissions standard · trust trusted · budget off",
  );
  assert.equal(renderStatusline(["sandbox"], values), "next sandbox required");
});
