import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import {
  assistantMessage,
  errorStream,
  installScriptedStream,
  TEST_MODEL,
  textStream,
} from "./support/pi-model.mjs";
import { makeProject, withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();

function configuredConfig(provider, id) {
  const config = core.defaultConfig();
  config.model.provider = provider;
  config.model.id = id;
  return config;
}

async function setupHost(root, overrides = {}) {
  const project = path.join(root, "host-project");
  const home = path.join(root, "host-home");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  const ledger = await core.EvidenceLedger.open(
    path.join(root, "host-evidence.jsonl"),
  );
  const store = await core.SessionStore.create({
    rootDir: home,
    cwd: project,
    sessionId: "session-model",
    heartbeatMs: 60_000,
  });
  const host = await core.createPiHost({
    cwd: project,
    workspaceRoot: project,
    deliveryRoot: project,
    codepunkHome: home,
    sessionId: store.sessionId,
    runId: "run-model",
    writeSet: [project],
    mode: "interactive",
    approval: null,
    ledger,
    sandbox: null,
    sessionStore: store,
    model: TEST_MODEL,
    settings: {
      retry: {
        enabled: true,
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
      compaction: { enabled: false },
    },
    ...overrides,
  });
  return { host, store, ledger, project, home };
}

function fakeModel(provider, id) {
  return { provider, id };
}

function routeRequest(model, overrides = {}) {
  return {
    model,
    thinkingLevel: "medium",
    reason: "user",
    messages: [],
    ...overrides,
  };
}

async function scanForSecret(root, marker) {
  const matches = [];
  const entries = await fs.readdir(root, { recursive: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry);
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile() !== true) {
      continue;
    }
    const content = await fs.readFile(candidate);
    if (content.includes(marker)) {
      matches.push(candidate);
    }
  }
  return matches;
}

test("catalog and auth status fail visibly", async () => {
  await withTempDirectory("codepunk-model-", async (root) => {
    const { paths } = await makeProject(root);
    const valid = configuredConfig("openai", "chat-latest");
    await fs.writeFile(
      path.join(paths.home, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "sk-valid-model" } }),
      { mode: 0o600 },
    );
    assert.equal(await core.probeConfiguredModel(paths, valid), null);
    const model = await core.resolveConfiguredModel(paths, valid);
    assert.ok(model);
    assert.equal(model.provider, "openai");
    assert.equal(model.id, "chat-latest");

    const disabled = configuredConfig("openai", "chat-latest");
    disabled.model.enabled = ["anthropic/*"];
    assert.match(
      await core.probeConfiguredModel(paths, disabled),
      /excluded by model\.enabled/u,
    );
    await assert.rejects(
      () => core.resolveConfiguredModel(paths, disabled),
      (error) => {
        assert.equal(error.code, "not_enabled");
        assert.match(error.message, /excluded by model\.enabled/u);
        return true;
      },
    );
    const enabled = configuredConfig("openai", "chat-latest");
    enabled.model.enabled = ["openai/chat-*"];
    assert.ok(await core.resolveConfiguredModel(paths, enabled));
    assert.deepEqual(core.piSettings(enabled).enabledModels, ["openai/chat-*"]);

    const missing = configuredConfig("openai", "not-a-real-model");
    assert.match(
      await core.probeConfiguredModel(paths, missing),
      /not available/u,
    );
    await assert.rejects(
      () => core.resolveConfiguredModel(paths, missing),
      (error) => {
        assert.equal(error.code, "not_found");
        assert.match(error.message, /not available/u);
        return true;
      },
    );

    const badFallback = configuredConfig("openai", "chat-latest");
    badFallback.model.fallback = ["openai/not-a-real-model"];
    assert.match(
      await core.probeConfiguredModel(paths, badFallback),
      /model fallback is invalid: unknown models: openai\/not-a-real-model/u,
    );

    await fs.rm(path.join(paths.home, "auth.json"));
    assert.match(
      await core.probeConfiguredModel(paths, valid),
      /No API key found/u,
    );
    await assert.rejects(
      () => core.resolveConfiguredModel(paths, valid),
      (error) => {
        assert.equal(error.code, "no_auth");
        assert.match(error.message, /No API key found/u);
        return true;
      },
    );

    await fs.writeFile(
      path.join(paths.home, "auth.json"),
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "expired-access",
          refresh: "expired-refresh",
          expires: 1,
        },
      }),
      { mode: 0o600 },
    );
    const previousFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      throw new Error("network disabled by test");
    };
    try {
      const expired = await core.probeConfiguredModel(paths, valid);
      assert.match(expired, /credential|OAuth refresh failed/u);
      assert.equal(fetches, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("model catalog distinguishes a selected default from setup guidance", () => {
  const selected = core.formatModelCatalog({
    selected: "gateway/primary-model",
    modelsPath: "/tmp/models.json",
    error: null,
    entries: [
      {
        provider: "gateway",
        id: "primary-model",
        name: "Primary",
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 8192,
        custom: true,
        authenticated: true,
        selected: true,
      },
    ],
  });
  assert.match(selected, /^selected: gateway\/primary-model$/mu);
  assert.match(
    selected,
    /^default: gateway\/primary-model; change it with codepunk models set/mu,
  );

  const empty = core.formatModelCatalog({
    selected: null,
    modelsPath: "/tmp/models.json",
    error: null,
    entries: [],
  });
  assert.match(empty, /^selected: none$/mu);
  assert.match(empty, /^no models configured$/mu);
  assert.match(empty, /^ {2}choose: codepunk models set/mu);
  assert.doesNotMatch(empty, /^default:/mu);
});

test("exact model selection uses Pi without accepting fuzzy names", async () => {
  await withTempDirectory("codepunk-model-select-", async (root) => {
    const { paths } = await makeProject(root);
    await fs.writeFile(
      path.join(paths.home, "models.json"),
      JSON.stringify({
        providers: {
          "gateway/team": {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-responses",
            apiKey: "local",
            models: [{ id: "alpha" }, { id: "beta" }],
          },
          other: {
            baseUrl: "http://127.0.0.1:2/v1",
            api: "openai-responses",
            apiKey: "other",
            models: [{ id: "alpha" }],
          },
        },
      }),
      { mode: 0o600 },
    );
    const runtime = await core.openModelRuntime(paths);

    const providerWithSlash = core.resolveModelSelection(
      runtime,
      "gateway/team/alpha",
    );
    assert.equal(providerWithSlash.status, "resolved");
    assert.equal(providerWithSlash.model.provider, "gateway/team");
    assert.equal(providerWithSlash.model.id, "alpha");

    const fuzzy = core.resolveModelSelection(runtime, "alph");
    assert.equal(fuzzy.status, "not_found");
    assert.match(fuzzy.error, /not an exact catalog entry/u);

    const ambiguous = core.resolveModelSelection(runtime, "alpha");
    assert.equal(ambiguous.status, "ambiguous");
    assert.match(ambiguous.error, /ambiguous across providers/u);

    const withThinking = core.resolveModelSelection(
      runtime,
      "gateway/team/beta:high",
    );
    assert.equal(withThinking.status, "resolved");
    assert.equal(withThinking.model.id, "beta");
    assert.equal(withThinking.thinkingLevel, "high");
  });
});

test("removing a custom provider leaves the others in models.json", async () => {
  await withTempDirectory("codepunk-model-remove-", async (root) => {
    const { paths } = await makeProject(root);
    const provider = (id) => ({
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-responses",
      apiKey: "local",
      models: [{ id }],
    });
    await core.writeModelsProvider(paths, "first", provider("alpha"));
    await core.writeModelsProvider(paths, "second", provider("beta"));

    const removed = await core.removeModelsProvider(paths, "first");
    assert.deepEqual(removed.remaining, ["second"]);
    assert.equal(removed.path, path.join(paths.home, "models.json"));
    const config = await core.readModelsConfig(paths);
    assert.equal(config.providers.first, undefined);
    assert.equal(config.providers.second.models[0].id, "beta");

    await assert.rejects(
      () => core.removeModelsProvider(paths, "first"),
      /provider first is not configured/u,
    );
    await assert.rejects(
      () => core.removeModelsProvider(paths, "bad/id"),
      /provider id must use/u,
    );
  });
});

test("fallback routes by request reason and preserves context overflow", async () => {
  const primary = fakeModel("test", "primary");
  const secondary = fakeModel("test", "secondary");
  const chain = [primary, secondary];
  const route = core.createFallbackRoute(chain, () => true);

  assert.equal(
    (await route(routeRequest(primary, { previous: { model: secondary } })))
      .model,
    primary,
  );
  assert.equal(
    (
      await route(
        routeRequest(primary, {
          reason: "continuation",
          previous: { model: secondary, thinkingLevel: "high" },
        }),
      )
    ).model,
    secondary,
  );
  assert.equal(
    (
      await route(
        routeRequest(primary, {
          reason: "retry",
          failed: {
            model: primary,
            thinkingLevel: "low",
            message: {
              stopReason: "error",
              errorMessage: "upstream overloaded",
            },
          },
        }),
      )
    ).model,
    secondary,
  );
  assert.equal(
    (
      await route(
        routeRequest(primary, {
          reason: "retry",
          previous: { model: secondary },
          failed: {
            model: primary,
            message: {
              stopReason: "error",
              errorMessage: "prompt is too long for this context window",
            },
          },
        }),
      )
    ).model,
    primary,
  );
  assert.equal(
    (
      await route(
        routeRequest(primary, {
          reason: "retry",
          failed: {
            model: primary,
            message: {
              stopReason: "error",
              errorMessage: "context_length_exceeded",
            },
          },
        }),
      )
    ).model,
    primary,
  );
  const preserved = {
    chain: ["test/primary", "test/secondary"],
    attempted: ["test/primary", "test/secondary"],
    switch: {
      from: "test/primary",
      to: "test/secondary",
      reason: "error",
    },
  };
  const overflow = await route(
    routeRequest(primary, {
      reason: "retry",
      state: preserved,
      failed: {
        model: secondary,
        thinkingLevel: "high",
        message: {
          stopReason: "error",
          errorMessage: "prompt is too long for this context window",
        },
      },
    }),
  );
  assert.equal(overflow.model, secondary);
  assert.equal(overflow.thinkingLevel, "high");
  assert.equal(overflow.state, preserved);
});

test("fallback keeps silent and length overflows on the failed model", async () => {
  const primary = { ...fakeModel("test", "primary"), contextWindow: 1_000 };
  const secondary = { ...fakeModel("test", "secondary"), contextWindow: 1_000 };
  const route = core.createFallbackRoute([primary, secondary], () => true);
  const state = {
    chain: ["test/primary", "test/secondary"],
    attempted: ["test/primary"],
    switch: null,
  };
  const usage = (input, output) => ({
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { total: 0 },
  });
  for (const message of [
    {
      stopReason: "stop",
      usage: usage(1_001, 1),
    },
    {
      stopReason: "length",
      usage: usage(1_000, 0),
    },
  ]) {
    const routed = await route(
      routeRequest(primary, {
        reason: "retry",
        state,
        failed: {
          model: primary,
          message,
        },
      }),
    );
    assert.equal(routed.model, primary);
    assert.deepEqual(routed.state, state);
  }
});

test("fallback stops when every model has failed and pins the chain", async () => {
  const primary = fakeModel("test", "primary");
  const secondary = fakeModel("test", "secondary");
  const route = core.createFallbackRoute([primary, secondary], () => true);
  const state = {
    chain: ["test/primary", "test/secondary"],
    attempted: ["test/primary"],
    switch: null,
  };
  await assert.rejects(
    () =>
      route(
        routeRequest(primary, {
          reason: "retry",
          state,
          failed: {
            model: secondary,
            message: {
              stopReason: "error",
              errorMessage: "provider unavailable",
            },
          },
        }),
      ),
    /fallback chain exhausted after test\/secondary/u,
  );
  await assert.rejects(
    () =>
      route(
        routeRequest(primary, {
          reason: "continuation",
          state: {
            ...state,
            chain: ["test/primary", "test/replacement"],
          },
          previous: { model: primary },
        }),
      ),
    /chain changed since this session started/u,
  );
});

test("restored fallback state exposes the pinned chain", () => {
  const entry = (chain) => ({
    type: "custom",
    customType: "pi.virtual-model-state",
    data: {
      provider: core.FALLBACK_PROVIDER,
      modelId: core.FALLBACK_MODEL_ID,
      state: { chain, attempted: [], switch: null },
    },
  });
  assert.deepEqual(
    core.restoredFallbackChain([
      entry(["test/old-primary", "test/old-secondary"]),
      entry(["test/primary", "test/secondary"]),
    ]),
    ["test/primary", "test/secondary"],
  );
  assert.equal(
    core.restoredFallbackChain([
      {
        type: "custom",
        customType: "pi.virtual-model-state",
        data: {
          provider: "other-router",
          modelId: "auto",
          state: { chain: ["anthropic/x"] },
        },
      },
    ]),
    undefined,
  );
  assert.equal(core.restoredFallbackChain([]), undefined);
});

test("a continuation pins the fallback chain before any switch", async () => {
  const primary = fakeModel("test", "primary");
  const secondary = fakeModel("test", "secondary");
  const route = core.createFallbackRoute([primary, secondary], () => true);

  const pinned = await route(routeRequest(primary, { reason: "continuation" }));
  assert.equal(pinned.model.id, "primary");
  assert.deepEqual(pinned.state.chain, ["test/primary", "test/secondary"]);
  assert.deepEqual(pinned.state.attempted, []);
  assert.equal(pinned.state.switch, null);

  // pi appends a virtual-model entry only when the returned state differs from
  // the branch, so a settled continuation must reuse the stored object.
  const again = await route(
    routeRequest(primary, {
      reason: "continuation",
      state: pinned.state,
    }),
  );
  assert.equal(again.state, pinned.state);

  // The pinned chain still makes a resume with a changed config fail closed.
  await assert.rejects(
    () =>
      route(
        routeRequest(primary, {
          reason: "continuation",
          state: { ...pinned.state, chain: ["test/primary"] },
        }),
      ),
    /chain changed since this session started/u,
  );
});

test("fallback preflight rejects unsafe or unusable chains", async () => {
  const primary = fakeModel("test", "primary");
  const secondary = fakeModel("other", "secondary");
  const resolved = core.resolveFallbackChain(
    { getModels: () => [primary, secondary] },
    ["test/primary", "other/secondary", "other/secondary"],
  );
  assert.deepEqual(resolved.requested, [
    "test/primary",
    "other/secondary",
    "other/secondary",
  ]);
  assert.deepEqual(
    resolved.models.map((model) => `${model.provider}/${model.id}`),
    ["test/primary", "other/secondary"],
  );
  const collision = core.resolveFallbackChain(
    {
      getModels: () => [
        fakeModel("gateway", "team/beta"),
        fakeModel("gateway/team", "beta"),
      ],
    },
    ["gateway/team/beta"],
  );
  assert.deepEqual(collision.models, []);
  assert.deepEqual(collision.ambiguous, ["gateway/team/beta"]);
  assert.ok(
    (
      await core.fallbackConfigurationErrors(primary, collision, {
        allowCrossProvider: true,
        authenticated: () => true,
      })
    ).some((error) => /ambiguous model references/u.test(error)),
  );
  const chain = {
    models: [primary, secondary],
    requested: ["test/primary", "other/secondary", "other/secondary"],
    missing: ["missing/model"],
    ambiguous: [],
  };
  const errors = await core.fallbackConfigurationErrors(primary, chain, {
    allowCrossProvider: false,
    authenticated: (provider) => provider !== "other",
    enabledModels: new Set(["test/primary"]),
  });
  assert.ok(errors.some((error) => /unknown models/u.test(error)));
  assert.ok(errors.some((error) => /duplicate models/u.test(error)));
  assert.ok(
    errors.some((error) => /crosses provider or endpoint/u.test(error)),
  );
  assert.ok(errors.some((error) => /no configured credential/u.test(error)));
  assert.ok(errors.some((error) => /outside model\.enabled/u.test(error)));
  const credentialErrors = await core.fallbackConfigurationErrors(
    primary,
    chain,
    {
      allowCrossProvider: true,
      authenticated: async (provider) => {
        if (provider === "test") {
          return true;
        }
        throw new Error("expired credential");
      },
    },
  );
  assert.ok(
    credentialErrors.some((error) =>
      /credential check failed for other: expired credential/u.test(error),
    ),
  );
  assert.deepEqual(
    await core.fallbackConfigurationErrors(primary, chain, {
      allowCrossProvider: true,
      authenticated: () => true,
    }),
    ["unknown models: missing/model", "duplicate models: other/secondary"],
  );
  const sameProvider = {
    models: [
      { ...primary, baseUrl: "https://vendor-a.example/v1" },
      { ...secondary, baseUrl: "https://vendor-b.example/v1" },
    ],
    requested: ["test/primary", "other/secondary"],
    missing: [],
    ambiguous: [],
  };
  assert.ok(
    (
      await core.fallbackConfigurationErrors(primary, sameProvider, {
        allowCrossProvider: false,
        authenticated: () => true,
      })
    ).some((error) => /crosses provider or endpoint/u.test(error)),
  );
  const virtual = {
    models: [
      primary,
      { provider: "test", id: "other-auto", api: "pi-virtual" },
    ],
    requested: ["test/primary", "test/other-auto"],
    missing: [],
    ambiguous: [],
  };
  assert.ok(
    (
      await core.fallbackConfigurationErrors(primary, virtual, {
        allowCrossProvider: true,
        authenticated: () => true,
      })
    ).some((error) => /virtual model cannot appear/u.test(error)),
  );
});

test("fallback virtual model advertises the conservative chain limits", () => {
  const primary = {
    provider: "test",
    id: "primary",
    contextWindow: 1_000,
    maxTokens: 100,
    input: ["text", "image"],
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  };
  const secondary = {
    provider: "test",
    id: "secondary",
    contextWindow: 2_000,
    maxTokens: 50,
    input: ["text"],
    reasoning: true,
    thinkingLevelMap: { xhigh: null, max: null },
  };
  const definition = core.fallbackModelDefinition(
    [primary, secondary],
    () => true,
  );
  assert.equal(definition.contextWindow, 1_000);
  assert.equal(definition.maxTokens, 50);
  assert.deepEqual(definition.input, ["text"]);
  assert.deepEqual(definition.thinkingLevels, [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
});

test("fallback virtual model is not selectable as a default", async () => {
  await withTempDirectory("codepunk-model-virtual-", async (root) => {
    const { paths } = await makeProject(root);
    const runtime = await core.openModelRuntime(paths);
    runtime.registerVirtualModel({
      provider: core.FALLBACK_PROVIDER,
      id: core.FALLBACK_MODEL_ID,
      name: "Auto",
      route: () => ({ model: runtime.getModels()[0], thinkingLevel: "medium" }),
    });
    const resolution = core.resolveModelSelection(runtime, "codepunk/auto");
    assert.equal(resolution.status, "not_found");
    assert.match(resolution.error, /runtime fallback route/u);
  });
});

test("direct requests keep the latest successful physical model", async () => {
  const primary = fakeModel("test", "primary");
  const secondary = fakeModel("test", "secondary");
  const route = core.createFallbackRoute([primary, secondary], () => true);
  assert.equal(
    (
      await route(
        routeRequest(primary, {
          reason: "direct",
          previous: { model: secondary },
        }),
      )
    ).model,
    secondary,
  );
});

test("fallback registration retries on the next authenticated model", async () => {
  await withTempDirectory("codepunk-model-fallback-", async (root) => {
    const project = path.join(root, "fallback-project");
    const home = path.join(root, "fallback-home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "test-openai" } }),
      { mode: 0o600 },
    );
    const projectContext = await core.findDeliveryRoot(project);
    const paths = core.projectPaths(projectContext, home);
    const available = await core.openModelRuntime(paths);
    const openai = available
      .getModels("openai")
      .filter((model) => model.id !== TEST_MODEL.id);
    assert.ok(openai.length >= 2, "test catalog needs two OpenAI models");
    const primary = openai[0];
    const secondary = openai[1];

    const ledger = await core.EvidenceLedger.open(
      path.join(root, "fallback-evidence.jsonl"),
    );
    const store = await core.SessionStore.create({
      rootDir: home,
      cwd: project,
      sessionId: "session-fallback",
      heartbeatMs: 60_000,
    });
    const host = await core.createPiHost({
      cwd: project,
      workspaceRoot: project,
      deliveryRoot: project,
      codepunkHome: home,
      sessionId: store.sessionId,
      runId: "run-fallback",
      writeSet: [project],
      mode: "interactive",
      approval: null,
      ledger,
      sandbox: null,
      sessionStore: store,
      model: primary,
      fallbackModels: [`${secondary.provider}/${secondary.id}`],
      settings: {
        retry: {
          enabled: true,
          maxRetries: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
        },
        compaction: { enabled: false },
      },
    });
    try {
      assert.equal(host.session.model.provider, core.FALLBACK_PROVIDER);
      assert.equal(host.session.model.id, core.FALLBACK_MODEL_ID);
      assert.deepEqual(host.fallbackModels, [
        `${primary.provider}/${primary.id}`,
        `${secondary.provider}/${secondary.id}`,
      ]);

      const observed = [];
      host.session.agent.streamFunction = (model) => {
        observed.push(`${model.provider}/${model.id}`);
        return observed.length === 1
          ? errorStream(model, "connection error: transient upstream failure")
          : textStream(model, "fallback recovered");
      };
      await host.session.prompt("exercise fallback");
      assert.deepEqual(observed.slice(0, 2), [
        `${primary.provider}/${primary.id}`,
        `${secondary.provider}/${secondary.id}`,
      ]);
      const final = host.session.messages
        .filter((message) => message.role === "assistant")
        .at(-1);
      assert.ok(final);
      assert.equal(final.model, secondary.id);
      assert.equal(final.stopReason, "stop");
      const fallbackEvents = store.allEvents.filter(
        (event) => event.kind === "model/fallback",
      );
      assert.equal(fallbackEvents.length, 1);
      assert.equal(
        fallbackEvents[0].data.from,
        `${primary.provider}/${primary.id}`,
      );
      assert.equal(
        fallbackEvents[0].data.to,
        `${secondary.provider}/${secondary.id}`,
      );
      assert.equal(fallbackEvents[0].data.exhausted, false);
      assert.match(
        fallbackEvents[0].data.chain_sha256,
        /^sha256:[a-f0-9]{64}$/u,
      );
    } finally {
      await host.dispose();
    }
  });
});

test("restore keeps a later physical selection instead of reinstating fallback", async () => {
  await withTempDirectory("codepunk-model-restore-", async (root) => {
    const project = path.join(root, "restore-project");
    const home = path.join(root, "restore-home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "test-openai" } }),
      { mode: 0o600 },
    );
    const projectContext = await core.findDeliveryRoot(project);
    const paths = core.projectPaths(projectContext, home);
    const catalog = await core.openModelRuntime(paths);
    const openai = catalog
      .getModels("openai")
      .filter((model) => model.id !== TEST_MODEL.id);
    assert.ok(openai.length >= 2, "test catalog needs two OpenAI models");
    const primary = openai[0];
    const secondary = openai[1];
    const ledger = await core.EvidenceLedger.open(
      path.join(root, "restore-evidence.jsonl"),
    );
    const store = await core.SessionStore.create({
      rootDir: home,
      cwd: project,
      sessionId: "session-restore-selection",
      heartbeatMs: 60_000,
    });
    const options = {
      cwd: project,
      workspaceRoot: project,
      deliveryRoot: project,
      codepunkHome: home,
      sessionId: store.sessionId,
      runId: "run-restore-selection",
      writeSet: [project],
      mode: "interactive",
      approval: null,
      ledger,
      sandbox: null,
      sessionStore: store,
      model: primary,
      fallbackModels: [`${secondary.provider}/${secondary.id}`],
    };
    const first = await core.createPiHost(options);
    let saved;
    try {
      assert.equal(first.session.model.provider, core.FALLBACK_PROVIDER);
      await first.session.setModel(secondary);
      saved = await first.saveAgentState();
    } finally {
      await first.dispose();
    }
    assert.ok(saved);
    const second = await core.createPiHost({
      ...options,
      runId: "run-restore-selection-2",
      restore: saved,
    });
    try {
      assert.equal(second.session.model.provider, secondary.provider);
      assert.equal(second.session.model.id, secondary.id);
      assert.equal(second.primaryModel.provider, secondary.provider);
      assert.equal(second.primaryModel.id, secondary.id);
    } finally {
      await second.dispose();
    }
  });
});

test("fallback compaction evidence names the physical summary model", async () => {
  await withTempDirectory("codepunk-model-compact-", async (root) => {
    const project = path.join(root, "compact-project");
    const home = path.join(root, "compact-home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "test-openai" } }),
      { mode: 0o600 },
    );
    const projectContext = await core.findDeliveryRoot(project);
    const paths = core.projectPaths(projectContext, home);
    const catalog = await core.openModelRuntime(paths);
    const openai = catalog
      .getModels("openai")
      .filter((model) => model.id !== TEST_MODEL.id);
    assert.ok(openai.length >= 2);
    const primary = openai[0];
    const secondary = openai[1];
    const ledger = await core.EvidenceLedger.open(
      path.join(root, "compact-evidence.jsonl"),
    );
    const store = await core.SessionStore.create({
      rootDir: home,
      cwd: project,
      sessionId: "session-compact-fallback",
      heartbeatMs: 60_000,
    });
    const host = await core.createPiHost({
      cwd: project,
      workspaceRoot: project,
      deliveryRoot: project,
      codepunkHome: home,
      sessionId: store.sessionId,
      runId: "run-compact-fallback",
      writeSet: [project],
      mode: "interactive",
      approval: null,
      ledger,
      sandbox: null,
      sessionStore: store,
      model: primary,
      fallbackModels: [`${secondary.provider}/${secondary.id}`],
      settings: {
        compaction: {
          enabled: true,
          reserveTokens: 1,
          keepRecentTokens: 1,
        },
      },
    });
    try {
      installScriptedStream(host.session, () => ({
        type: "text",
        text: "fallback compact summary",
      }));
      const now = Date.now();
      for (let index = 0; index < 3; index += 1) {
        host.sessionManager.appendMessage({
          role: "user",
          content: [{ type: "text", text: `question ${index}` }],
          timestamp: now + index * 2,
        });
        host.sessionManager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: `answer ${index}` }],
          api: primary.api,
          provider: primary.provider,
          model: primary.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: now + index * 2 + 1,
        });
      }
      await host.session.compact();
      const decision = store.allEvents.find(
        (event) => event.kind === "compaction/decision",
      );
      assert.ok(decision);
      assert.equal(
        decision.data.checkpoint.model,
        `${primary.provider}/${primary.id}`,
      );
      assert.notEqual(decision.data.checkpoint.model, "codepunk/auto");
      const compactionEntry = host.sessionManager
        .getBranch()
        .find((entry) => entry.type === "compaction");
      assert.ok(compactionEntry?.usage);
      assert.deepEqual(decision.data.checkpoint.usage, {
        input_tokens: compactionEntry.usage.input,
        output_tokens: compactionEntry.usage.output,
        cache_read_tokens: compactionEntry.usage.cacheRead,
        cache_write_tokens: compactionEntry.usage.cacheWrite,
        total_tokens: compactionEntry.usage.totalTokens,
        cost_total: compactionEntry.usage.cost.total,
      });
      assert.ok(decision.data.checkpoint.usage.total_tokens > 0);
    } finally {
      await host.dispose();
    }
  });
});

test("runtime wires the configured fallback chain into Pi", async () => {
  await withTempDirectory("codepunk-model-runtime-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    await fs.writeFile(
      path.join(paths.home, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "test-openai" } }),
      { mode: 0o600 },
    );
    const catalog = await core.openModelRuntime(paths);
    const openai = catalog.getModels("openai");
    assert.ok(openai.length >= 2, "test catalog needs two OpenAI models");
    const primary = openai[0];
    const secondary = openai[1];
    await fs.writeFile(
      path.join(paths.home, "config.toml"),
      [
        "[model]",
        `provider = "${primary.provider}"`,
        `id = "${primary.id}"`,
        `fallback = ["${secondary.provider}/${secondary.id}"]`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const runtime = await core.createRuntime({
      cwd: projectRoot,
      environment: { CODEPUNK_HOME: paths.home },
      approvalChannel: null,
    });
    try {
      assert.equal(runtime.primaryModel?.id, primary.id);
      assert.deepEqual(runtime.fallbackModels, [
        `${primary.provider}/${primary.id}`,
        `${secondary.provider}/${secondary.id}`,
      ]);
      assert.equal(runtime.host.session.model.provider, core.FALLBACK_PROVIDER);
      assert.equal(runtime.host.session.model.id, core.FALLBACK_MODEL_ID);
    } finally {
      await runtime.dispose();
    }
  });
});

test("fallback compaction reserve uses the smallest chain context window", async () => {
  await withTempDirectory("codepunk-model-reserve-", async (root) => {
    const { paths } = await makeProject(root);
    await fs.writeFile(
      path.join(paths.home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-responses",
            apiKey: "local",
            models: [
              { id: "large", contextWindow: 200_000, maxTokens: 10_000 },
              { id: "small", contextWindow: 32_000, maxTokens: 10_000 },
            ],
          },
        },
      }),
      { mode: 0o600 },
    );
    const runtime = await core.openModelRuntime(paths);
    const large = runtime
      .getModels("local")
      .find((model) => model.id === "large");
    assert.ok(large);
    const config = configuredConfig("local", "large");
    config.model.fallback = ["local/small"];
    assert.equal(
      await core.resolveFallbackContextWindow(paths, config, large),
      32_000,
    );
    config.context.compaction_threshold = 0.5;
    assert.equal(
      core.piSettings(
        config,
        await core.resolveFallbackContextWindow(paths, config, large),
      ).compaction.reserveTokens,
      16_000,
    );
  });
});

test("host requires an explicit opt-in for cross-provider fallback", async () => {
  await withTempDirectory("codepunk-model-cross-provider-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          alpha: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-responses",
            apiKey: "alpha",
            models: [{ id: "primary" }],
          },
          beta: {
            baseUrl: "http://127.0.0.1:2/v1",
            api: "openai-responses",
            apiKey: "beta",
            models: [{ id: "secondary" }],
          },
        },
      }),
    );
    const projectContext = await core.findDeliveryRoot(project);
    const paths = core.projectPaths(projectContext, home);
    const runtime = await core.openModelRuntime(paths);
    const primary = runtime
      .getModels("alpha")
      .find((model) => model.id === "primary");
    const secondary = runtime
      .getModels("beta")
      .find((model) => model.id === "secondary");
    assert.ok(primary);
    assert.ok(secondary);

    const ledger = await core.EvidenceLedger.open(
      path.join(root, "evidence.jsonl"),
    );
    const store = await core.SessionStore.create({
      rootDir: home,
      cwd: project,
      sessionId: "session-cross-provider",
      heartbeatMs: 60_000,
    });
    const baseOptions = {
      cwd: project,
      workspaceRoot: project,
      deliveryRoot: project,
      codepunkHome: home,
      sessionId: store.sessionId,
      runId: "run-cross-provider",
      writeSet: [project],
      mode: "interactive",
      approval: null,
      ledger,
      sandbox: null,
      sessionStore: store,
      model: primary,
      fallbackModels: [`${secondary.provider}/${secondary.id}`],
    };
    await assert.rejects(
      () => core.createPiHost(baseOptions),
      /fallback crosses provider or endpoint/u,
    );
    const host = await core.createPiHost({
      ...baseOptions,
      fallbackAllowCrossProvider: true,
    });
    try {
      assert.equal(host.session.model.provider, core.FALLBACK_PROVIDER);
      assert.equal(host.session.model.id, core.FALLBACK_MODEL_ID);
    } finally {
      await host.dispose();
    }
  });
});

test("retry and usage are recorded without plaintext secrets", async () => {
  await withTempDirectory("codepunk-model-", async (root) => {
    const { host, store, ledger } = await setupHost(root);
    const sentinel = "codepunk-test-secret-sentinel";
    const retrySecret = "retry-error-secret-value-1234";
    try {
      await host.services.modelRuntime.setRuntimeApiKey("openai", sentinel);
      const retryError = `connection error: api_key=${retrySecret}`;
      const calls = installScriptedStream(host.session, (index) => {
        if (index === 0) {
          return {
            type: "error",
            text: retryError,
          };
        }
        return { type: "text", text: "recovered after retry" };
      });
      const events = [];
      host.session.subscribe((event) => {
        events.push(event.type);
      });

      await host.session.prompt("retry the request");

      assert.ok(calls.length >= 2);
      assert.ok(events.includes("auto_retry_start"));
      assert.ok(events.includes("auto_retry_end"));
      const finalAssistant = host.session.messages
        .filter((message) => message.role === "assistant")
        .at(-1);
      assert.ok(finalAssistant);
      assert.match(
        finalAssistant.content.map((part) => part.text ?? "").join("\n"),
        /recovered after retry/u,
      );
      const usageEvents = store.allEvents.filter(
        (event) => event.kind === "model/usage",
      );
      assert.equal(usageEvents.length, 2);
      assert.deepEqual(
        usageEvents.map((event) => event.data.total_tokens),
        [2, 2],
      );
      const retryStarts = store.allEvents.filter(
        (event) => event.kind === "model/retry_start",
      );
      const retryEnds = store.allEvents.filter(
        (event) => event.kind === "model/retry_end",
      );
      assert.equal(retryStarts.length, 1);
      assert.equal(retryEnds.length, 1);
      assert.deepEqual(
        {
          run_id: retryStarts[0].data.run_id,
          model: retryStarts[0].data.model,
          attempt: retryStarts[0].data.attempt,
          max_attempts: retryStarts[0].data.max_attempts,
          delay_ms: retryStarts[0].data.delay_ms,
        },
        {
          run_id: "run-model",
          model: `openai/${TEST_MODEL.id}`,
          attempt: 1,
          max_attempts: 1,
          delay_ms: 0,
        },
      );
      assert.equal(
        retryStarts[0].data.error_sha256,
        core.sha256Text(retryError),
      );
      assert.equal(
        retryStarts[0].data.error_preview,
        "connection error: api_key=[REDACTED_SECRET]",
      );
      assert.equal(
        JSON.stringify(store.allEvents).includes(retrySecret),
        false,
        "retry evidence must not contain a plaintext secret",
      );
      assert.deepEqual(
        {
          run_id: retryEnds[0].data.run_id,
          attempt: retryEnds[0].data.attempt,
          success: retryEnds[0].data.success,
          final_error_sha256: retryEnds[0].data.final_error_sha256,
          final_error_preview: retryEnds[0].data.final_error_preview,
        },
        {
          run_id: "run-model",
          attempt: 1,
          success: true,
          final_error_sha256: null,
          final_error_preview: null,
        },
      );
      const summary = core.summarizeModelUsage(store.allEvents);
      assert.deepEqual(summary, {
        calls: 2,
        input_tokens: 2,
        output_tokens: 2,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 4,
        cost_total: 0,
      });
      const end = store.allEvents.find(
        (event) =>
          event.kind === "run/end" && event.data.run_id === "run-model",
      );
      assert.ok(end);
      assert.equal(end.data.state, "settled");

      const catalogModel = host.services.modelRuntime
        .getModels("openai")
        .find((candidate) => candidate.id !== TEST_MODEL.id);
      assert.ok(catalogModel);
      await host.session.setModel(catalogModel);
      const change = store.allEvents.find(
        (event) => event.kind === "model/change",
      );
      assert.ok(change);
      assert.equal(change.data.model, `openai/${catalogModel.id}`);

      const evidenceSecret = await fs
        .readFile(ledger.filePath, "utf8")
        .then((content) => content.includes(sentinel))
        .catch(() => false);
      const scanned = [
        ...(await scanForSecret(path.join(root, "host-home"), sentinel)),
        ...(await scanForSecret(path.join(root, "host-project"), sentinel)),
        ...(evidenceSecret ? [ledger.filePath] : []),
      ];
      assert.deepEqual(scanned, []);
      assert.equal(
        JSON.stringify(store.allEvents).includes(sentinel),
        false,
        "session events must not contain a plaintext credential",
      );

      const planted = path.join(root, "planted-secret.txt");
      await fs.writeFile(planted, sentinel);
      assert.deepEqual(await scanForSecret(root, sentinel), [planted]);
    } finally {
      await host.dispose();
    }
  });
});

test("exhausted automatic retries record a redacted final error", async () => {
  await withTempDirectory("codepunk-model-retry-", async (root) => {
    const { host, store } = await setupHost(root);
    const sentinel = "codepunk-exhausted-retry-secret";
    const retryError = `connection error: upstream failed password=${sentinel}`;
    try {
      await host.services.modelRuntime.setRuntimeApiKey(
        "openai",
        "retry-test-key",
      );
      installScriptedStream(host.session, () => ({
        type: "error",
        text: retryError,
      }));

      await host.session.prompt("fail twice");
      await host.session.waitForIdle();

      const starts = store.allEvents.filter(
        (event) => event.kind === "model/retry_start",
      );
      const ends = store.allEvents.filter(
        (event) => event.kind === "model/retry_end",
      );
      assert.equal(starts.length, 1);
      assert.equal(ends.length, 1);
      assert.equal(starts[0].data.attempt, 1);
      assert.equal(starts[0].data.max_attempts, 1);
      assert.equal(starts[0].data.error_sha256, core.sha256Text(retryError));
      assert.equal(
        starts[0].data.error_preview,
        "connection error: upstream failed password=[REDACTED_SECRET]",
      );
      assert.equal(ends[0].data.success, false);
      assert.equal(ends[0].data.attempt, 1);
      assert.equal(
        ends[0].data.final_error_sha256,
        core.sha256Text(retryError),
      );
      assert.equal(
        ends[0].data.final_error_preview,
        "connection error: upstream failed password=[REDACTED_SECRET]",
      );
      assert.equal(
        JSON.stringify(store.allEvents).includes(sentinel),
        false,
        "retry evidence must not contain a plaintext secret",
      );
    } finally {
      await host.dispose();
    }
  });
});

test("a hard token budget aborts the run and refuses another prompt", async () => {
  await withTempDirectory("codepunk-model-budget-", async (root) => {
    const { host, store } = await setupHost(root, {
      budget: { maxTokens: 1 },
    });
    try {
      await host.services.modelRuntime.setRuntimeApiKey("openai", "test-key");
      const calls = installScriptedStream(host.session, () => ({
        type: "text",
        text: "over budget",
      }));

      await host.session.prompt("first request");
      await host.session.waitForIdle();

      const exceeded = store.allEvents.filter(
        (event) => event.kind === "budget/exceeded",
      );
      assert.equal(exceeded.length, 1);
      assert.equal(exceeded[0].data.max_tokens, 1);
      assert.equal(exceeded[0].data.used_tokens, 2);
      assert.equal(exceeded[0].data.action, "abort_run");
      const end = store.allEvents.find(
        (event) =>
          event.kind === "run/end" && event.data.run_id === "run-model",
      );
      assert.ok(end);
      assert.equal(end.data.state, "aborted");

      const callsBefore = calls.length;
      await host.session.prompt("second request");
      await host.session.waitForIdle();
      assert.equal(calls.length, callsBefore);
    } finally {
      await host.dispose();
    }
  });
});

test("expired auth is visible and the run ends failed", async () => {
  await withTempDirectory("codepunk-model-", async (root) => {
    const project = path.join(root, "expired-project");
    const home = path.join(root, "expired-home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "expired-access",
          refresh: "expired-refresh",
          expires: 1,
        },
      }),
      { mode: 0o600 },
    );
    const ledger = await core.EvidenceLedger.open(
      path.join(root, "expired-evidence.jsonl"),
    );
    const store = await core.SessionStore.create({
      rootDir: home,
      cwd: project,
      sessionId: "session-expired",
      heartbeatMs: 60_000,
    });
    const host = await core.createPiHost({
      cwd: project,
      workspaceRoot: project,
      deliveryRoot: project,
      codepunkHome: home,
      sessionId: store.sessionId,
      runId: "run-expired",
      writeSet: [project],
      mode: "interactive",
      approval: null,
      ledger,
      sandbox: null,
      sessionStore: store,
      model: TEST_MODEL,
      settings: { retry: { enabled: false } },
    });
    try {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        throw new Error("network disabled by test");
      };
      try {
        await host.session.prompt("this must not silently fall back");
      } finally {
        globalThis.fetch = previousFetch;
      }
      const assistant = host.session.messages
        .filter((message) => message.role === "assistant")
        .at(-1);
      assert.ok(assistant);
      assert.equal(assistant.stopReason, "error");
      assert.match(
        assistant.errorMessage ?? "",
        /OAuth refresh failed|credential|expired/u,
      );
      const end = store.allEvents.find(
        (event) =>
          event.kind === "run/end" && event.data.run_id === "run-expired",
      );
      assert.ok(end);
      assert.equal(end.data.state, "failed");
    } finally {
      await host.dispose();
    }
  });
});

test("model selection is written without rewriting unrelated config", async () => {
  await withTempDirectory("codepunk-model-config-", async (root) => {
    const { paths } = await makeProject(root);
    const configPath = path.join(paths.home, "config.toml");
    await fs.writeFile(
      configPath,
      [
        "# keep this comment",
        "[model]",
        'provider = "old"',
        'id = "old"',
        "",
        "[memory]",
        "max_tokens = 900",
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(paths.home, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }),
      { mode: 0o600 },
    );
    const config = configuredConfig("openai", "chat-latest");
    await core.setConfiguredModel(
      paths,
      config,
      "openai",
      "chat-latest",
      "high",
    );
    const content = await fs.readFile(configPath, "utf8");
    assert.match(content, /# keep this comment/u);
    assert.match(content, /\[memory\]\nmax_tokens = 900/u);
    assert.doesNotMatch(content, /provider = "old"/u);
    const loaded = await core.loadConfig(paths);
    assert.equal(loaded.config.model.provider, "openai");
    assert.equal(loaded.config.model.id, "chat-latest");
    assert.equal(loaded.config.model.thinking, "high");
    assert.equal(loaded.config.memory.max_tokens, 900);

    const before = await fs.readFile(configPath, "utf8");
    await assert.rejects(
      () =>
        core.setConfiguredModel(paths, config, "openai", "not-a-real-model"),
      (error) => {
        assert.equal(error.code, "not_found");
        return true;
      },
    );
    assert.equal(await fs.readFile(configPath, "utf8"), before);
  });
});

test("provider import discovers models and resolves auth without a key", async () => {
  await withTempDirectory("codepunk-model-import-", async (root) => {
    const { paths } = await makeProject(root);
    const server = http.createServer((request, response) => {
      if (request.url !== "/v1/models") {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: [
            {
              id: "alpha",
              display_name: "Alpha",
              reasoning: true,
              reasoning_levels: ["low", "high", "max"],
              context_window: 200000,
              max_output_tokens: 32000,
              modalities: { input: ["text", "image"] },
            },
            {
              id: "beta",
              display_name: "Beta",
              reasoning: false,
              context_length: 64000,
              max_tokens: 8000,
            },
          ],
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const result = await core.importProviderModels(paths, {
        baseUrl,
        providerId: "local",
        api: "openai-responses",
        apiKey: ["local", "placeholder"].join("-"),
      });
      assert.equal(result.models.length, 2);
      assert.equal(result.models[0].id, "alpha");
      assert.deepEqual(result.models[0].input, ["text", "image"]);
      assert.deepEqual(result.models[0].thinkingLevelMap, {
        off: null,
        minimal: null,
        low: "low",
        medium: "high",
        high: "high",
        xhigh: "max",
        max: "max",
      });
      const modelsPath = path.join(paths.home, "models.json");
      const stat = await fs.stat(modelsPath);
      assert.equal(stat.mode & 0o777, 0o600);
      const saved = JSON.parse(await fs.readFile(modelsPath, "utf8"));
      assert.equal(
        saved.providers.local.apiKey,
        ["local", "placeholder"].join("-"),
      );
      assert.equal(saved.providers.local.authHeader, false);

      const config = core.defaultConfig();
      const catalog = await core.listModelCatalog(paths, config);
      assert.ok(
        catalog.entries.some(
          (entry) =>
            entry.provider === "local" &&
            entry.id === "alpha" &&
            entry.authenticated,
        ),
      );
      await core.setConfiguredModel(paths, config, "local", "alpha", "high");
      assert.equal(await core.probeConfiguredModel(paths, config), null);
      const loaded = await core.loadConfig(paths);
      assert.equal(loaded.config.model.provider, "local");
      assert.equal(loaded.config.model.id, "alpha");
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

test("provider import failures leave the catalog unchanged", async () => {
  await withTempDirectory("codepunk-model-import-fail-", async (root) => {
    const { paths } = await makeProject(root);
    const modelsPath = path.join(paths.home, "models.json");
    const original = JSON.stringify({
      providers: {
        keep: {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "keep",
          models: [{ id: "kept" }],
        },
      },
    });
    await fs.writeFile(modelsPath, original, { mode: 0o600 });
    const server = http.createServer((_request, response) => {
      response.statusCode = 401;
      response.end("unauthorized");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      await assert.rejects(
        () =>
          core.importProviderModels(paths, {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            providerId: "local",
            api: "openai-responses",
            apiKey: "local",
          }),
        /HTTP 401/u,
      );
      assert.equal(await fs.readFile(modelsPath, "utf8"), original);
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    await fs.writeFile(modelsPath, "{not json", { mode: 0o600 });
    const config = core.defaultConfig();
    const catalog = await core.listModelCatalog(paths, config);
    assert.match(catalog.error ?? "", /cannot parse/u);
    await assert.rejects(
      () =>
        core.writeModelsProvider(paths, "local", {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-responses",
          models: [{ id: "kept" }],
        }),
      /cannot parse/u,
    );
    assert.equal(await fs.readFile(modelsPath, "utf8"), "{not json");
  });
});

test("models.json accepts comments and trailing commas like the host", async () => {
  await withTempDirectory("codepunk-model-jsonc-", async (root) => {
    const { paths } = await makeProject(root);
    await fs.writeFile(
      path.join(paths.home, "models.json"),
      [
        "{",
        "  // local gateway",
        '  "providers": {',
        '    "local": {',
        '      "baseUrl": "http://127.0.0.1:1/v1",',
        '      "api": "openai-responses",',
        '      "apiKey": "local",',
        '      "models": [{ "id": "alpha" },],',
        "    },",
        "  },",
        "}",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const config = core.defaultConfig();
    const catalog = await core.listModelCatalog(paths, config);
    assert.equal(catalog.error, null);
    assert.ok(
      catalog.entries.some(
        (entry) => entry.provider === "local" && entry.id === "alpha",
      ),
    );

    await fs.writeFile(
      path.join(paths.home, "models.json"),
      '{ /* block comments are not Pi JSONC */ "providers": {} }\n',
      { mode: 0o600 },
    );
    const blockComment = await core.listModelCatalog(paths, config);
    assert.match(blockComment.error ?? "", /cannot parse/u);
  });
});

test("fallback auto memory summarizes with the routed physical model", async () => {
  await withTempDirectory("codepunk-fallback-memory-", async (root) => {
    const project = path.join(root, "host-project");
    const home = path.join(root, "host-home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "test-openai" } }),
      { mode: 0o600 },
    );
    const projectContext = await core.findDeliveryRoot(project);
    const paths = core.projectPaths(projectContext, home);
    const available = await core.openModelRuntime(paths);
    const openai = available
      .getModels("openai")
      .filter((model) => model.id !== TEST_MODEL.id);
    assert.ok(openai.length >= 2, "test catalog needs two OpenAI models");
    const [primary, secondary] = openai;
    const memory = await core.MemoryManager.open({
      paths,
      enabled: true,
      maxTokens: 200,
      defaultScope: "project",
    });
    const { host, store } = await setupHost(root, {
      model: primary,
      fallbackModels: [`${secondary.provider}/${secondary.id}`],
      memory,
      autoMemorySummary: true,
      settings: { compaction: { enabled: false } },
    });
    try {
      installScriptedStream(host.session, (index) =>
        index === 0
          ? {
              type: "error",
              text: "connection error: transient upstream failure",
            }
          : { type: "text", text: "fallback answer" },
      );
      const summaryCalls = [];
      host.session.modelRuntime.completeSimple = async (model) => {
        summaryCalls.push(model);
        return assistantMessage(
          model,
          [{ type: "text", text: "durable fallback summary" }],
          "stop",
        );
      };
      await host.session.prompt("summarize the fallback session");
      assert.equal(summaryCalls.length, 1);
      assert.equal(summaryCalls[0].provider, secondary.provider);
      assert.equal(summaryCalls[0].id, secondary.id);
      assert.ok(
        store.allEvents.filter((event) => event.kind === "model/usage")
          .length >= 3,
      );
    } finally {
      await host.dispose();
    }
  });
});

test("summarizeModelUsage includes compaction checkpoint usage", () => {
  const summary = core.summarizeModelUsage([
    {
      kind: "compaction/decision",
      data: {
        checkpoint: {
          usage: {
            input_tokens: 7,
            output_tokens: 3,
            cache_read_tokens: 2,
            cache_write_tokens: 1,
            total_tokens: 13,
            cost_total: 0.000004,
          },
        },
      },
    },
  ]);
  assert.deepEqual(summary, {
    calls: 1,
    input_tokens: 7,
    output_tokens: 3,
    cache_read_tokens: 2,
    cache_write_tokens: 1,
    total_tokens: 13,
    cost_total: 0.000004,
  });
});

test("summary usage survives larger Pi session counters", () => {
  const usage = (source, total) => ({
    kind: "model/usage",
    data: {
      run_id: "run-usage",
      provider: "openai",
      model: "chat-latest",
      input_tokens: total - 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: total,
      cost_total: source === "summary" ? 0.000009 : 0,
      stop_reason: "stop",
      source,
    },
  });
  const summary = core.summarizeSessionModelUsage(
    [usage("assistant", 50), usage("summary", 9)],
    {
      input: 70,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      total: 80,
      cost: 0,
    },
  );
  assert.deepEqual(summary, {
    calls: 2,
    input_tokens: 78,
    output_tokens: 11,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 89,
    cost_total: 0.000009,
  });
});
