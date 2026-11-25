import assert from "node:assert/strict";
import test from "node:test";
import { importSource } from "./support/core.mjs";

const { renderStatusline } = await importSource(
  "packages/cli/src/statusline.ts",
);

const values = {
  model: "local/model",
  session: "session s",
  sandbox: "sandbox required",
  filesystem: "fs workspace",
  policy: "permissions standard · trust trusted",
  budget: "budget off",
};

test("the default statusline stays on one compact line", () => {
  assert.equal(
    renderStatusline(["policy"], values),
    "permissions standard · trust trusted",
  );
  assert.equal(
    renderStatusline(["model", "policy"], values),
    "local/model · permissions standard · trust trusted",
  );
  assert.equal(
    renderStatusline(
      ["model", "session", "sandbox", "filesystem", "policy", "budget"],
      values,
    ),
    [
      "local/model",
      "session s",
      "sandbox required",
      "fs workspace",
      "permissions standard · trust trusted",
      "budget off",
    ].join(" · "),
  );
});

test("statusline segments follow configured order and omission", () => {
  assert.equal(
    renderStatusline(["budget", "model", "filesystem"], values),
    "budget off · local/model · fs workspace",
  );
  assert.equal(
    renderStatusline(["policy", "budget"], values),
    "permissions standard · trust trusted · budget off",
  );
  assert.equal(renderStatusline(["sandbox"], values), "sandbox required");
  assert.equal(
    renderStatusline(["model", "budget"], { ...values, budget: "" }),
    "local/model",
  );
});
