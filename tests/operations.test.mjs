import assert from "node:assert/strict";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import { makeProject, withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();

test("doctor reports each blocking dependency and formats a summary", async () => {
  await withTempDirectory("codepunk-operations-", async (root) => {
    const { paths } = await makeProject(root);
    const config = core.defaultConfig();
    const report = await core.runDoctor({
      paths,
      config,
      environment: { PATH: "" },
      sandboxProbe: async () => "srt is missing",
      modelProbe: async () => "no model selected",
    });
    assert.equal(report.ok, false);
    const byId = new Map(report.checks.map((check) => [check.id, check]));
    assert.equal(byId.get("srt").status, "error");
    assert.equal(byId.get("model").status, "error");
    assert.equal(byId.get("search-rg").status, "warn");
    assert.match(core.formatDoctor(report), /doctor: blocking issues remain/u);
    assert.doesNotMatch(core.formatDoctor(report), /\/Users\//u);
  });
});

test("doctor treats an unavailable model as a blocking issue", async () => {
  await withTempDirectory("codepunk-operations-", async (root) => {
    const { paths } = await makeProject(root);
    const report = await core.runDoctor({
      paths,
      config: core.defaultConfig(),
      environment: { PATH: "" },
      sandboxProbe: async () => null,
      modelProbe: async () => "no model configured",
    });
    assert.equal(report.ok, false);
    const model = report.checks.find((check) => check.id === "model");
    assert.equal(model?.status, "error");
    assert.match(core.formatDoctor(report), /\[error\] model:/u);
    assert.match(core.formatDoctor(report), /doctor: blocking issues remain/u);
  });
});

test("doctor passes with an injected healthy environment", async () => {
  await withTempDirectory("codepunk-operations-", async (root) => {
    const { paths } = await makeProject(root);
    const report = await core.runDoctor({
      paths,
      config: core.defaultConfig(),
      environment: { PATH: "" },
      sandboxProbe: async () => null,
      modelProbe: async () => null,
    });
    assert.equal(report.ok, true);
    assert.match(core.formatDoctor(report), /doctor: ready/u);
  });
});
