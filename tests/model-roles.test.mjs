import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import { makeProject, withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();

function config(enabled = []) {
  return { model: { enabled } };
}

test("model roles and subagent pools resolve from user configuration", async () => {
  await withTempDirectory("codepunk-model-roles-", async (root) => {
    const { paths } = await makeProject(root);
    await fs.writeFile(
      path.join(paths.home, "roles.toml"),
      [
        "version = 1",
        "[roles]",
        'plan = "local/planner"',
        'smol = "local/small"',
        'slow = "local/large"',
        "",
        "[[pool]]",
        'name = "subagent"',
        'models = ["local/small", "local/large"]',
        "max = 2",
        "",
      ].join("\n"),
    );
    const bundle = await core.loadModelRoles(paths);
    assert.deepEqual(
      core.resolveModelRole(
        bundle,
        config(["local/planner"]),
        "plan",
        "local/default",
      ),
      { role: "plan", model: "local/planner", source: "user" },
    );
    assert.deepEqual(
      core.selectSubagentModels(
        bundle,
        config(["local/small", "local/large"]),
        "subagent",
        ["local/small"],
      ),
      ["local/small"],
    );
    const pools = new core.SubagentModelPoolManager({
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const firstLease = pools.acquire(
      bundle,
      config(["local/small", "local/large"]),
      "subagent",
      ["local/small"],
    );
    const secondLease = pools.acquire(
      bundle,
      config(["local/small", "local/large"]),
      "subagent",
      ["local/large"],
    );
    assert.equal(pools.activeCount("subagent"), 2);
    assert.throws(
      () =>
        pools.acquire(
          bundle,
          config(["local/small", "local/large"]),
          "subagent",
          ["local/small"],
        ),
      (error) => error.code === "roles.pool_exhausted",
    );
    assert.equal(
      pools.release(firstLease.lease_id)?.released_at !== null,
      true,
    );
    assert.equal(pools.activeCount("subagent"), 1);
    const thirdLease = pools.acquire(
      bundle,
      config(["local/small", "local/large"]),
      "subagent",
      ["local/small"],
    );
    assert.equal(pools.records().length, 3);
    assert.equal(secondLease.pool, "subagent");
    pools.release(secondLease.lease_id);
    pools.release(thirdLease.lease_id);
    assert.throws(
      () =>
        core.resolveModelRole(
          bundle,
          config(["local/other"]),
          "plan",
          "local/default",
        ),
      (error) => error.code === "roles.model_scope",
    );
    assert.throws(
      () =>
        core.selectSubagentModels(
          bundle,
          config(["local/small", "local/large"]),
          "subagent",
          ["local/small", "local/small"],
        ),
      (error) => error.code === "roles.pool_duplicate_request",
    );

    assert.throws(
      () =>
        core.selectSubagentModels(
          bundle,
          config(["local/small", "local/large"]),
          "subagent",
          ["local/small", "local/large", "local/small"],
        ),
      (error) => error.code === "roles.pool_limit",
    );
    await fs.mkdir(paths.projectConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(paths.projectConfigDir, "roles.toml"),
      'version = 1\n[roles]\nplan = "local/project"\n',
    );
    const ordered = await core.loadModelRoles(paths);
    assert.equal(ordered.roles.plan, "local/planner");
    assert.match(ordered.warnings.join("\n"), /inert/u);
    assert.throws(
      () =>
        core.selectSubagentModels(
          bundle,
          config(["local/small", "local/large"]),
          "subagent",
          ["local/small", "local/other"],
        ),
      (error) => error.code === "roles.pool_scope",
    );
  });
});

test("model roles and pools accept nested provider model ids and glob scope", async () => {
  await withTempDirectory("codepunk-model-roles-nested-", async (root) => {
    const { paths } = await makeProject(root);
    await fs.writeFile(
      path.join(paths.home, "roles.toml"),
      [
        "version = 1",
        "[roles]",
        'plan = "openrouter/anthropic/claude-sonnet-4.5"',
        "",
        "[[pool]]",
        'name = "subagent"',
        'models = ["openrouter/openai/gpt-6.1"]',
        "max = 1",
        "",
      ].join("\n"),
    );
    const bundle = await core.loadModelRoles(paths);
    const scoped = config(["openrouter/**"]);
    assert.deepEqual(
      core.resolveModelRole(
        bundle,
        scoped,
        "plan",
        "openrouter/google/gemini-3-pro",
      ),
      {
        role: "plan",
        model: "openrouter/anthropic/claude-sonnet-4.5",
        source: "user",
      },
    );
    assert.deepEqual(
      core.resolveModelRole(
        bundle,
        scoped,
        "slow",
        "openrouter/google/gemini-3-pro",
      ),
      {
        role: "slow",
        model: "openrouter/google/gemini-3-pro",
        source: "fallback",
      },
    );
    assert.deepEqual(
      core.selectSubagentModels(bundle, scoped, "subagent", [
        "openrouter/openai/gpt-6.1",
      ]),
      ["openrouter/openai/gpt-6.1"],
    );
    assert.throws(
      () =>
        core.resolveModelRole(
          bundle,
          config(["openrouter/google/**"]),
          "plan",
          "openrouter/default/model",
        ),
      (error) => error.code === "roles.model_scope",
    );
  });
});

test("model scope patterns preserve segment boundaries and exact references", () => {
  assert.equal(
    core.modelMatchesEnabledScope(
      { provider: "openrouter", id: "anthropic/claude-sonnet-4.5" },
      ["openrouter/**"],
    ),
    true,
  );
  assert.equal(
    core.modelMatchesEnabledScope(
      { provider: "openrouter", id: "anthropic/claude-sonnet-4.5" },
      ["openrouter/*"],
    ),
    false,
  );
  assert.equal(
    core.modelMatchesEnabledScope({ provider: "openrouter", id: "gpt/x" }, [
      "openrouter/gpt**",
    ]),
    false,
  );
  assert.equal(
    core.modelMatchesEnabledScope({ provider: "openrouter", id: "a/foo" }, [
      "openrouter/**foo",
    ]),
    false,
  );
  assert.equal(
    core.modelMatchesEnabledScope({ provider: "openrouter", id: "a/foo" }, [
      "openrouter/**/foo",
    ]),
    true,
  );
  assert.equal(
    core.modelMatchesEnabledScope({ provider: "gateway/team", id: "alpha" }, [
      "alpha",
    ]),
    true,
  );
  assert.equal(
    core.modelMatchesEnabledScope({ provider: "gateway/team", id: "alpha" }, [
      "team/alpha",
    ]),
    false,
  );
  assert.equal(
    core.modelMatchesEnabledScope({ provider: "gateway/team", id: "alpha" }, [
      "*/alpha",
    ]),
    false,
  );
  assert.equal(
    core.modelMatchesEnabledScope({ provider: "gateway", id: "model:high" }, [
      "gateway/model",
    ]),
    true,
  );
  assert.throws(
    () =>
      core.resolveModelRole(
        { roles: {}, pools: {}, warnings: [] },
        config(["team/alpha"]),
        "slow",
        "gateway/team/alpha",
      ),
    (error) => error.code === "roles.model_scope",
  );
});

test("invalid role files and unknown keys fail closed", async () => {
  await withTempDirectory("codepunk-model-roles-invalid-", async (root) => {
    const { paths } = await makeProject(root);
    await fs.writeFile(
      path.join(paths.home, "roles.toml"),
      'version = 1\n[roles]\nfast = "local/fast"\n',
    );
    await assert.rejects(
      core.loadModelRoles(paths),
      (error) => error.code === "roles.unknown_role",
    );
    await fs.writeFile(
      path.join(paths.home, "roles.toml"),
      'version = 1\n[[pool]]\nname = "p"\nmodels = ["local/a"]\nmax = 2\n',
    );
    await assert.rejects(
      core.loadModelRoles(paths),
      (error) => error.code === "roles.pool_max",
    );
    await fs.writeFile(
      path.join(paths.home, "roles.toml"),
      'version = 1\n[roles]\nplan = "not-a-model-reference"\n',
    );
    await assert.rejects(
      core.loadModelRoles(paths),
      (error) => error.code === "roles.model",
    );
  });
});

test("subagent tool masks cannot exceed the parent", () => {
  const parent = {
    read: true,
    search: true,
    write: false,
    edit: false,
    shell: false,
    memory_search: false,
  };
  assert.doesNotThrow(() =>
    core.assertSubagentToolCeiling(parent, { ...parent }),
  );
  assert.throws(
    () => core.assertSubagentToolCeiling(parent, { ...parent, write: true }),
    (error) => error.code === "roles.tool_ceiling",
  );
  assert.throws(
    () =>
      core.assertSubagentToolCeiling(
        { read: true },
        { read: true, write: true },
      ),
    (error) => error.code === "roles.tool_ceiling",
  );
});
