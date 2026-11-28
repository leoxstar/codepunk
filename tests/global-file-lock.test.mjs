import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore, importSource } from "./support/core.mjs";
import {
  assertPrivateFile,
  makeProject,
  trustWorkspace,
  withTempDirectory,
  writeFile,
} from "./support/helpers.mjs";

const lockModule = await importSource(
  "packages/core/src/platform/file-lock.ts",
);
const modelModule = await importSource("packages/core/src/model/index.ts");
const core = await importCore();

function concurrentWrites(operation, count = 2) {
  return Promise.allSettled(
    Array.from({ length: count }, (_, index) => operation(index + 1)),
  );
}

function assertAllFulfilled(results, label) {
  for (const [index, result] of results.entries()) {
    assert.equal(
      result.status,
      "fulfilled",
      `${label} writer ${index + 1} failed: ${result.reason}`,
    );
  }
}

async function assertLockFailClosed(operation, message) {
  const lockDir = lockPath;
  let release;
  let signalHolderAcquired;
  const holderAcquired = new Promise((resolve) => {
    signalHolderAcquired = resolve;
  });
  const holderPromise = lockModule.withClaimFileLock(
    {
      lockDir,
      timeoutMs: 250,
      staleMs: 60_000,
      busyError: () => new Error("holder lock must not time out"),
    },
    async () => {
      signalHolderAcquired();
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  );
  await holderAcquired;
  let operationError;
  try {
    await assert.rejects(
      () => operation(),
      (error) => {
        assert.match(error.message, message);
        return true;
      },
    );
  } catch (error) {
    operationError = error;
  } finally {
    release?.();
    await holderPromise;
    assert.deepEqual(await fs.readdir(lockDir), []);
  }
  if (operationError !== undefined) {
    throw operationError;
  }
}

let root;
let paths;
let home;
let lockPath;

test("user config writers serialize concurrent read-modify-write updates", async () => {
  await withTempDirectory("codepunk-config-file-lock-", async (tempRoot) => {
    root = tempRoot;
    ({ paths } = await makeProject(root));
    home = paths.home;
    lockPath = path.join(home, "config.toml.lock.d");
    const configPath = path.join(home, "config.toml");
    await writeFile(
      configPath,
      ["# keep", "[memory]", "max_tokens = 100", ""].join("\n"),
    );

    const results = await concurrentWrites((index) =>
      core.writeUserPermissionSelection(paths, {
        ...(index === 1 ? { approval: "auto" } : { filesystem: "workspace" }),
      }),
    );
    assertAllFulfilled(results, "config");
    const content = await fs.readFile(configPath, "utf8");
    assert.match(content, /# keep/u);
    assert.match(content, /max_tokens = 100/u);
    assert.match(content, /mode = "auto"/u);
    assert.match(content, /mode = "workspace"/u);
    await assertPrivateFile(configPath);

    await assertLockFailClosed(
      () => core.writeUserThinkingSelection(paths, "max"),
      /user config is locked by another process/u,
    );
  });
});

test("legacy and per-resource trust writers serialize concurrent updates", async () => {
  await withTempDirectory("codepunk-trust-file-lock-", async (tempRoot) => {
    root = tempRoot;
    ({ paths } = await makeProject(root));
    home = paths.home;
    lockPath = path.join(home, "trust.json.lock.d");
    const workspace = (index) => path.join(root, `project-${index}`);
    await Promise.all(
      [0, 1, 2].map((index) =>
        fs
          .mkdir(workspace(index), { recursive: true })
          .then(() =>
            writeFile(
              path.join(workspace(index), "AGENTS.md"),
              `rule-${index}\n`,
            ),
          ),
      ),
    );
    await trustWorkspace(home, workspace(0));

    const results = await concurrentWrites((index) =>
      core.saveWorkspaceTrustGrants(home, workspace(index), {
        config: true,
        policy: false,
        skills: false,
        instructions: index === 1,
      }),
    );
    assertAllFulfilled(results, "trust grants");
    const saved = JSON.parse(
      await fs.readFile(path.join(home, "trust.json"), "utf8"),
    );
    const expectedPaths = await Promise.all(
      [0, 1, 2].map((index) => fs.realpath(workspace(index))),
    );
    expectedPaths.push(await fs.realpath(path.join(root, "project")));
    assert.deepEqual(Object.keys(saved).sort(), expectedPaths.sort());
    assert.equal(saved[await fs.realpath(workspace(0))], true);
    await assertPrivateFile(path.join(home, "trust.json"));

    await assertLockFailClosed(
      () => core.saveWorkspaceTrust(home, workspace(3), false),
      /workspace trust store is locked by another process/u,
    );
  });
});

test("model provider writers serialize concurrent read-modify-write updates", async () => {
  await withTempDirectory("codepunk-model-file-lock-", async (tempRoot) => {
    root = tempRoot;
    ({ paths } = await makeProject(root));
    home = paths.home;
    lockPath = path.join(home, "models.json.lock.d");
    const provider = (id) => ({
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-responses",
      apiKey: "local",
      models: [{ id }],
    });

    const results = await concurrentWrites((index) =>
      core.writeModelsProvider(paths, `writer-${index}`, provider(`m${index}`)),
    );
    assertAllFulfilled(results, "models");
    const config = JSON.parse(
      await fs.readFile(path.join(home, "models.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(config.providers).sort(), [
      "writer-1",
      "writer-2",
    ]);
    await assertPrivateFile(path.join(home, "models.json"));

    await assertLockFailClosed(
      () => core.removeModelsProvider(paths, "writer-1"),
      /model config is locked by another process/u,
    );
  });
});

test("model auth updates serialize concurrent read-modify-write updates", async () => {
  await withTempDirectory("codepunk-auth-file-lock-", async (tempRoot) => {
    root = tempRoot;
    ({ paths } = await makeProject(root));
    home = paths.home;
    lockPath = path.join(home, "auth.json.lock.d");

    const results = await concurrentWrites((index) =>
      modelModule.setProviderAuthCredential(paths, `provider-${index}`, {
        type: "api_key",
        key: `key-${index}`,
      }),
    );
    assertAllFulfilled(results, "auth");
    const credentials = JSON.parse(
      await fs.readFile(path.join(home, "auth.json"), "utf8"),
    );
    assert.equal(credentials["provider-1"].key, "key-1");
    assert.equal(credentials["provider-2"].key, "key-2");
    await assertPrivateFile(path.join(home, "auth.json"));

    await assertLockFailClosed(
      () =>
        modelModule.setProviderAuthCredential(paths, "provider-3", {
          type: "api_key",
          key: "key-3",
        }),
      /model auth store is locked by another process/u,
    );
  });
});

test("MCP auth updates serialize concurrent read-modify-write updates", async () => {
  await withTempDirectory("codepunk-mcp-auth-lock-", async (tempRoot) => {
    root = tempRoot;
    ({ paths } = await makeProject(root));
    home = paths.home;
    lockPath = path.join(home, "mcp-auth.json.lock.d");
    const store = new core.McpAuthStore(home);
    const key = (index) =>
      store.forServer(`server-${index}`, `https://server-${index}.test/mcp`);

    const results = await concurrentWrites((index) =>
      key(index).save({
        serverUrl: `https://server-${index}.test/mcp`,
        tokens: {
          access_token: `access-${index}`,
          refresh_token: `refresh-${index}`,
          scope: "mcp.read",
        },
      }),
    );
    assertAllFulfilled(results, "MCP auth");
    const document = JSON.parse(await fs.readFile(store.path, "utf8"));
    assert.deepEqual(Object.keys(document.servers).sort(), [
      "server-1|https://server-1.test/mcp",
      "server-2|https://server-2.test/mcp",
    ]);
    await assertPrivateFile(store.path);

    await assertLockFailClosed(
      () =>
        key(3).save({
          serverUrl: "https://server-3.test/mcp",
          tokens: {
            access_token: "access-3",
            refresh_token: "refresh-3",
            scope: "mcp.read",
          },
        }),
      /MCP auth store is locked by another process/u,
    );
  });
});
