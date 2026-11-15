import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import {
  makeProject,
  withTempDirectory,
  writeFile,
} from "./support/helpers.mjs";
import { TEST_MODEL } from "./support/pi-model.mjs";

const core = await importCore();
const MCP_FIXTURE = path.join(
  import.meta.dirname,
  "support",
  "mcp-echo-server.mjs",
);

function skill(name, body) {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} test skill`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

async function makeRuntimeFixture(root) {
  const { projectRoot, paths } = await makeProject(root);
  await writeFile(
    path.join(paths.home, "config.toml"),
    '[sandbox]\nmode = "uncovered"\n\n[plugins]\nenabled = true\n',
  );
  await writeFile(path.join(projectRoot, "AGENTS.md"), "PROJECT_SENTINEL\n");
  await writeFile(
    path.join(paths.home, "skills", "probe", "SKILL.md"),
    skill("probe", "Skill body."),
  );
  return { projectRoot, paths };
}

test("--no-skills isolates skill discovery but keeps ordinary context", async () => {
  await withTempDirectory("codepunk-isolation-skills-", async (root) => {
    const { projectRoot, paths } = await makeRuntimeFixture(root);
    const runtime = await core.createRuntime({
      cwd: projectRoot,
      environment: { CODEPUNK_HOME: paths.home },
      model: TEST_MODEL,
      disableSkills: true,
    });
    try {
      assert.deepEqual(runtime.skills, []);
      assert.equal(runtime.isolation.skills, true);
      assert.equal(runtime.isolation.context, false);
      assert.equal(
        runtime.session.allEvents.some(
          (event) => event.kind === "skill/loaded",
        ),
        false,
      );
      const context = runtime.session.allEvents.find(
        (event) => event.kind === "context/loaded",
      );
      assert.ok(context);
      assert.ok(
        context.data.sources.some((source) =>
          String(source.source).endsWith("AGENTS.md"),
        ),
      );
      assert.match(
        runtime.loadedConfig.warnings.join("\n"),
        /skills are disabled for this session by --no-skills/u,
      );
    } finally {
      await runtime.dispose();
    }
  });
});

test("--no-plugins prevents user plugin code from loading", async () => {
  await withTempDirectory("codepunk-isolation-plugins-", async (root) => {
    const { projectRoot, paths } = await makeRuntimeFixture(root);
    const marker = path.join(root, "plugin-loaded.txt");
    await writeFile(
      path.join(paths.home, "extensions", "probe.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        "export default function () {",
        `  writeFileSync(${JSON.stringify(marker)}, "loaded");`,
        "}",
        "",
      ].join("\n"),
    );
    const runtime = await core.createRuntime({
      cwd: projectRoot,
      environment: { CODEPUNK_HOME: paths.home },
      model: TEST_MODEL,
      disablePlugins: true,
    });
    try {
      assert.equal(runtime.plugins.enabled, false);
      assert.deepEqual(runtime.plugins.paths, []);
      assert.equal(runtime.isolation.plugins, true);
      await assert.rejects(() => fs.access(marker));
      assert.match(
        runtime.loadedConfig.warnings.join("\n"),
        /user plugins are disabled for this session by --no-plugins/u,
      );
    } finally {
      await runtime.dispose();
    }
  });
});

test("--bare removes instructions, skills, plugins, MCP, and memory", async () => {
  await withTempDirectory("codepunk-isolation-bare-", async (root) => {
    const { projectRoot, paths } = await makeRuntimeFixture(root);
    const marker = path.join(root, "plugin-loaded.txt");
    await writeFile(
      path.join(paths.home, "extensions", "probe.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        "export default function () {",
        `  writeFileSync(${JSON.stringify(marker)}, "loaded");`,
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(paths.home, "mcp.toml"),
      [
        "[servers.echo]",
        'command = "node"',
        `args = [${JSON.stringify(MCP_FIXTURE)}]`,
        "",
      ].join("\n"),
    );
    const runtime = await core.createRuntime({
      cwd: projectRoot,
      environment: { CODEPUNK_HOME: paths.home },
      model: TEST_MODEL,
      bare: true,
    });
    try {
      assert.deepEqual(runtime.isolation, {
        bare: true,
        context: true,
        skills: true,
        plugins: true,
        mcp: true,
        memory: true,
      });
      assert.deepEqual(runtime.skills, []);
      assert.equal(runtime.plugins.enabled, false);
      assert.deepEqual(runtime.mcpServers, []);
      assert.equal(runtime.memory.enabled, false);
      assert.equal(runtime.config.memory.enabled, false);
      assert.equal(
        runtime.session.allEvents.some(
          (event) => event.kind === "skill/loaded",
        ),
        false,
      );
      assert.equal(
        runtime.session.allEvents.some(
          (event) => event.kind === "mcp/server_start",
        ),
        false,
      );
      const context = runtime.session.allEvents.find(
        (event) => event.kind === "context/loaded",
      );
      assert.ok(context);
      assert.deepEqual(context.data.sources, []);
      await assert.rejects(() => fs.access(marker));
      assert.match(
        runtime.loadedConfig.warnings.join("\n"),
        /bare session: instruction files, skills, plugins, MCP servers, and memory are disabled/u,
      );
    } finally {
      await runtime.dispose();
    }
  });
});
