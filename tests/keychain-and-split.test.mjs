import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore, importSource } from "./support/core.mjs";
import { REPO_ROOT, withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();
const sandboxModule = await importSource("packages/core/src/sandbox/index.ts");
const mcpModule = await importSource("packages/core/src/mcp/index.ts");

test("OS Keychain credential store offloads secrets out of auth.json, migrates existing keys, and fails closed on errors", async () => {
  await withTempDirectory("codepunk-keychain-auth-", async (root) => {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(path.join(project, ".codepunk"), { recursive: true });
    const paths = core.projectPaths(await core.findDeliveryRoot(project), home);
    const driver = new core.InMemoryKeychainDriver(true);

    const testSecret = ["placeholder", "credential", "material", "42"].join(
      "-",
    );
    await core.setProviderAuthCredential(
      paths,
      "openai",
      { type: "api_key", key: testSecret },
      { credentialStore: "keychain", keychainDriver: driver },
    );

    const authPath = path.join(home, "auth.json");
    const onDisk = await fs.readFile(authPath, "utf8");
    assert.doesNotMatch(
      onDisk,
      new RegExp(testSecret, "u"),
      "auth.json must not contain secret material in keychain mode",
    );
    assert.deepEqual(JSON.parse(onDisk), {
      openai: { type: "api_key", storage: "keychain" },
    });

    const store = new core.LockedAuthStore(authPath, {
      mode: "keychain",
      keychainDriver: driver,
    });
    const hydrated = await store.read("openai");
    assert.deepEqual(hydrated, { type: "api_key", key: testSecret });
    assert.deepEqual(await store.list(), [
      { providerId: "openai", type: "api_key" },
    ]);

    // Migration from plaintext auth.json to keychain
    const plainSecret = ["legacy", "file", "credential", "99"].join("-");
    await fs.writeFile(
      authPath,
      `${JSON.stringify({ anthropic: { type: "api_key", key: plainSecret }, openai: { type: "api_key", storage: "keychain" } }, null, 2)}\n`,
      "utf8",
    );
    const migration = await core.migrateCredentialsToKeychain(paths, {
      keychainDriver: driver,
    });
    assert.deepEqual(migration.migratedProviders, ["anthropic"]);
    assert.deepEqual(migration.alreadyKeychainProviders, ["openai"]);
    const migratedDisk = await fs.readFile(authPath, "utf8");
    assert.doesNotMatch(migratedDisk, new RegExp(plainSecret, "u"));
    assert.deepEqual(await store.read("anthropic"), {
      type: "api_key",
      key: plainSecret,
    });

    // Negative control 1: unavailable keychain fails closed on write (no plaintext fallback in "keychain" mode) and on read
    driver.setAvailable(false);
    await assert.rejects(
      () => store.read("openai"),
      (err) => err instanceof core.ModelError && err.code === "auth_failed",
    );
    await assert.rejects(
      () =>
        core.setProviderAuthCredential(
          paths,
          "google",
          { type: "api_key", key: "never-write-me" },
          { credentialStore: "keychain", keychainDriver: driver },
        ),
      (err) => err instanceof core.ModelError && err.code === "auth_failed",
    );
    assert.doesNotMatch(await fs.readFile(authPath, "utf8"), /never-write-me/u);

    // Negative control 2: invalid account identifier rejected
    assert.throws(() => core.validateKeychainAccount("../bad"));
    assert.throws(() => core.validateKeychainAccount("bad account"));

    // Negative control 3: project .codepunk/config.toml cannot set model.credential_store
    await fs.writeFile(
      path.join(project, ".codepunk", "config.toml"),
      '[model]\ncredential_store = "file"\n',
      "utf8",
    );
    await assert.rejects(
      () =>
        core.loadConfig(
          paths,
          { CODEPUNK_HOME: home },
          {},
          { projectTrusted: true },
        ),
      /model\.credential_store is user\/CLI-only/u,
    );
  });
});

test("sandbox and mcp core monoliths stay split below 800 lines while preserving public exports", async () => {
  const sandboxLines = (
    await fs.readFile(
      path.join(REPO_ROOT, "packages/core/src/sandbox/index.ts"),
      "utf8",
    )
  ).split("\n").length;
  const mcpLines = (
    await fs.readFile(
      path.join(REPO_ROOT, "packages/core/src/mcp/index.ts"),
      "utf8",
    )
  ).split("\n").length;

  assert.ok(
    sandboxLines < 800,
    `expected sandbox/index.ts < 800 lines, got ${sandboxLines}`,
  );
  assert.ok(
    mcpLines < 800,
    `expected mcp/index.ts < 800 lines, got ${mcpLines}`,
  );

  for (const fn of [
    "SrtSandbox",
    "DeferredSandbox",
    "UnsandboxedShell",
    "srtProfile",
    "probeSrtSandbox",
    "decodeShellOutput",
    "resolveWindowsExecutable",
    "resolveWindowsShell",
    "probeWindowsShell",
    "protectWindowsCodepunkHome",
  ]) {
    assert.equal(typeof sandboxModule[fn], "function", `missing sandbox.${fn}`);
  }
  for (const fn of [
    "McpError",
    "loadMcpTools",
    "readMcpConfig",
    "writeMcpServer",
    "removeMcpServer",
    "findProjectMcpConfigs",
    "emptyMcpBundle",
  ]) {
    assert.equal(typeof mcpModule[fn], "function", `missing mcp.${fn}`);
  }
});
