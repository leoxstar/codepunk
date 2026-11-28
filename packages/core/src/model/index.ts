import {
  type ModelRuntime,
  resolveCliModel,
  resolveModelScopeWithDiagnostics,
} from "@earendil-works/pi-coding-agent";
import {
  writeUserModelSelection,
  type CodepunkConfig,
  type ThinkingLevel,
} from "../config/index.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import {
  LockedAuthStore,
  ModelError,
  inspectCredentialStorage,
  migrateCredentialsToKeychain,
  openModelRuntime,
  setProviderAuthCredential,
  type CredentialKeychainMigrationResult,
  type CredentialStorageProviderStatus,
  type CredentialStorageStatus,
  type LockedAuthStoreOptions,
  type ModelErrorCode,
} from "./auth-store.ts";
import {
  InMemoryKeychainDriver,
  KEYCHAIN_SERVICE_NAME,
  createNativeKeychainDriver,
  validateKeychainAccount,
  type KeychainDriver,
} from "./keychain.ts";
import {
  fallbackConfigurationErrors,
  isFallbackModel,
  resolveFallbackChain,
} from "./fallback.ts";
import {
  fetchProviderModels,
  importProviderModels,
  modelMatchesEnabledScope,
  modelsPath,
  parseModelReference,
  readModelsConfig,
  removeModelsProvider,
  writeModelsProvider,
  type ModelsConfig,
  type ModelsProviderConfig,
  type ProviderImportOptions,
  type ProviderImportResult,
  type ProviderModelImport,
} from "./import.ts";
import {
  modelUsageFromMessage,
  summarizeModelUsage,
  summarizeModelUsageBySource,
  summarizeSessionModelUsage,
  usageCount,
  type ModelUsageRecord,
  type ModelUsageSummary,
  type SessionUsageStats,
} from "./usage.ts";

export type ConfiguredModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export {
  InMemoryKeychainDriver,
  KEYCHAIN_SERVICE_NAME,
  LockedAuthStore,
  ModelError,
  createNativeKeychainDriver,
  inspectCredentialStorage,
  migrateCredentialsToKeychain,
  openModelRuntime,
  setProviderAuthCredential,
  validateKeychainAccount,
  type CredentialKeychainMigrationResult,
  type CredentialStorageProviderStatus,
  type CredentialStorageStatus,
  type KeychainDriver,
  type LockedAuthStoreOptions,
  type ModelErrorCode,
};
export {
  fetchProviderModels,
  importProviderModels,
  modelMatchesEnabledScope,
  parseModelReference,
  readModelsConfig,
  removeModelsProvider,
  writeModelsProvider,
  type ModelsConfig,
  type ModelsProviderConfig,
  type ProviderImportOptions,
  type ProviderImportResult,
  type ProviderModelImport,
};
export {
  modelUsageFromMessage,
  summarizeModelUsage,
  summarizeModelUsageBySource,
  summarizeSessionModelUsage,
  type ModelUsageRecord,
  type ModelUsageSummary,
  type SessionUsageStats,
};

export interface ModelCatalogEntry {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  custom: boolean;
  authenticated: boolean;
  selected: boolean;
}

export interface ModelCatalog {
  selected: string | null;
  modelsPath: string;
  error: string | null;
  entries: ModelCatalogEntry[];
}

export interface ModelTestResult {
  provider: string;
  id: string;
  ok: boolean;
  latency_ms: number;
  stop_reason: string;
  text: string;
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export type ModelSelectionResolution =
  | {
      status: "resolved";
      model: ConfiguredModel;
      thinkingLevel?: ThinkingLevel;
      warning?: string;
      exact: boolean;
    }
  | {
      status: "ambiguous";
      error: string;
    }
  | {
      status: "not_found";
      error: string;
    };

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export const RECOMMENDED_SETUP_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "openrouter",
  "moonshotai",
  "xai",
  "groq",
  "mistral",
] as const;

export interface DetectedDefaultModel {
  readonly model: ConfiguredModel;
  readonly totalAvailable: number;
}

export async function detectAvailableDefaultModel(
  paths: ProjectPaths,
  config: CodepunkConfig,
  runtime?: ModelRuntime,
): Promise<DetectedDefaultModel | null> {
  const resolvedRuntime = runtime ?? (await openModelRuntime(paths));
  const available = (await resolvedRuntime.getAvailable()).filter(
    (model) =>
      !isFallbackModel(model) &&
      modelMatchesEnabledScope(model, config.model.enabled),
  );
  if (available.length === 0) {
    return null;
  }
  const rank = (provider: string): number => {
    const idx = (RECOMMENDED_SETUP_PROVIDERS as readonly string[]).indexOf(
      provider,
    );
    return idx === -1 ? RECOMMENDED_SETUP_PROVIDERS.length : idx;
  };
  const sorted = [...available].sort((left, right) => {
    const providerDiff = rank(left.provider) - rank(right.provider);
    if (providerDiff !== 0) {
      return providerDiff;
    }
    if (left.reasoning !== right.reasoning) {
      return left.reasoning ? -1 : 1;
    }
    return right.contextWindow - left.contextWindow;
  });
  return {
    model: sorted[0]!,
    totalAvailable: available.length,
  };
}

export function modelSetupHint(): string {
  return [
    "no model configured",
    "  setup:  codepunk setup",
    "  list:   codepunk models list",
    "  add:    codepunk models import <base-url> --provider <id> --api openai-responses",
    "  choose: codepunk models set <provider/model>",
    "  login:  run codepunk and use /login for a built-in provider",
    "  or:     codepunk --model <provider/model>",
  ].join("\n");
}

function thinkingSuffix(
  reference: string,
): { base: string; thinkingLevel: ThinkingLevel } | null {
  const separator = reference.lastIndexOf(":");
  if (separator <= 0) {
    return null;
  }
  const suffix = reference.slice(separator + 1);
  if (!isThinkingLevel(suffix)) {
    return null;
  }
  return {
    base: reference.slice(0, separator),
    thinkingLevel: suffix,
  };
}

/**
 * Resolve an exact model reference with Pi's resolver.
 *
 * Pi also owns fuzzy matching and synthesized custom model IDs. This wrapper
 * accepts only a real catalog entry named by provider/model or a unique bare
 * model ID, so a typo cannot silently become a new model.
 */
export function resolveModelSelection(
  runtime: ModelRuntime,
  reference: string,
): ModelSelectionResolution {
  const requested = reference.trim();
  if (requested.length === 0) {
    return {
      status: "not_found",
      error: "model reference is empty",
    };
  }
  const parsedSuffix = thinkingSuffix(requested);
  const base = parsedSuffix?.base ?? requested;
  const allModels = runtime.getModels();
  const virtual = allModels.find(
    (candidate) =>
      isFallbackModel(candidate) &&
      (`${candidate.provider}/${candidate.id}` === base ||
        (!base.includes("/") && candidate.id === base)),
  );
  if (virtual !== undefined) {
    return {
      status: "not_found",
      error:
        "codepunk/auto is a runtime fallback route, not a selectable default; choose a provider/model",
    };
  }
  const fullMatches = allModels.filter(
    (candidate) => `${candidate.provider}/${candidate.id}` === base,
  );
  const exactMatches =
    fullMatches.length > 0
      ? fullMatches
      : base.includes("/")
        ? []
        : allModels.filter((candidate) => candidate.id === base);
  if (exactMatches.length > 1) {
    return {
      status: "ambiguous",
      error: `model "${base}" is ambiguous across providers: ${exactMatches
        .map((candidate) => `${candidate.provider}/${candidate.id}`)
        .sort()
        .join(", ")}. Use provider/model.`,
    };
  }
  const resolved = resolveCliModel({
    cliModel: requested,
    modelRuntime: runtime,
  });
  if (resolved.error !== undefined) {
    const exact = exactMatches[0];
    if (exact !== undefined) {
      return {
        status: "resolved",
        model: exact,
        exact: true,
        ...(parsedSuffix === null
          ? {}
          : { thinkingLevel: parsedSuffix.thinkingLevel }),
      };
    }
    return {
      status: "not_found",
      error: `model ${requested} is not an exact catalog entry; run /model to search`,
    };
  }
  const model = resolved.model;
  if (model === undefined) {
    return {
      status: "not_found",
      error: `model ${requested} is not available; run codepunk models list`,
    };
  }
  const key = `${model.provider}/${model.id}`;
  const exactFull = key === base;
  const exactBare = !base.includes("/") && model.id === base;
  if (!exactFull && !exactBare) {
    const exact = exactMatches[0];
    if (exact !== undefined) {
      return {
        status: "resolved",
        model: exact,
        exact: true,
        ...(parsedSuffix === null
          ? {}
          : { thinkingLevel: parsedSuffix.thinkingLevel }),
      };
    }
    return {
      status: "not_found",
      error: `model ${requested} is not an exact catalog entry; run /model to search`,
    };
  }
  const thinkingLevel =
    parsedSuffix?.thinkingLevel ??
    (resolved.thinkingLevel as ThinkingLevel | undefined);
  const exact = exactMatches.some(
    (candidate) =>
      candidate.provider === model.provider && candidate.id === model.id,
  );
  return {
    status: "resolved",
    model,
    exact,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(resolved.warning === undefined ? {} : { warning: resolved.warning }),
  };
}

export function modelReferenceParts(model: ConfiguredModel): {
  provider: string;
  id: string;
} {
  return { provider: model.provider, id: model.id };
}

export async function listModelCatalog(
  paths: ProjectPaths,
  config: CodepunkConfig,
): Promise<ModelCatalog> {
  const runtime = await openModelRuntime(paths);
  let error = runtime.getError() ?? null;
  const selected =
    config.model.provider === null || config.model.id === null
      ? null
      : `${config.model.provider}/${config.model.id}`;
  let modelsConfig: ModelsConfig | null = null;
  try {
    modelsConfig = await readModelsConfig(paths);
  } catch (readError) {
    error = readError instanceof Error ? readError.message : String(readError);
  }
  const customProviders = new Set(Object.keys(modelsConfig?.providers ?? {}));
  const available = new Set<string>();
  try {
    for (const model of await runtime.getAvailable()) {
      available.add(`${model.provider}/${model.id}`);
    }
  } catch (availabilityError) {
    error =
      error ??
      (availabilityError instanceof Error
        ? availabilityError.message
        : String(availabilityError));
  }
  const entries = runtime
    .getModels()
    .filter((model) => {
      if (isFallbackModel(model)) {
        return false;
      }
      const key = `${model.provider}/${model.id}`;
      return (
        customProviders.has(model.provider) ||
        available.has(key) ||
        key === selected
      );
    })
    .map((model): ModelCatalogEntry => {
      const key = `${model.provider}/${model.id}`;
      return {
        provider: model.provider,
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        custom: customProviders.has(model.provider),
        authenticated: available.has(key),
        selected: key === selected,
      };
    })
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.id.localeCompare(right.id),
    );
  return {
    selected,
    modelsPath: modelsPath(paths),
    error,
    entries,
  };
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(tokens);
}

export function formatModelCatalog(catalog: ModelCatalog): string {
  const lines = [
    `selected: ${catalog.selected ?? "none"}`,
    ...(catalog.error === null ? [] : [`catalog error: ${catalog.error}`]),
  ];
  if (catalog.entries.length === 0) {
    lines.push("");
    lines.push("no models configured");
    lines.push(
      "  add:    codepunk models import <base-url> --provider <id> --api openai-responses",
    );
    lines.push("  choose: codepunk models set <provider/model>");
    lines.push(`  edit:   ${catalog.modelsPath}`);
    return lines.join("\n");
  }
  lines.push("models:");
  let currentProvider = "";
  for (const entry of catalog.entries) {
    if (entry.provider !== currentProvider) {
      currentProvider = entry.provider;
      lines.push(`  ${currentProvider}:`);
    }
    const flags = [
      entry.authenticated ? "auth" : "no-auth",
      entry.selected ? "selected" : null,
      entry.custom ? "custom" : null,
      entry.reasoning ? "reasoning" : null,
    ].filter((flag): flag is string => flag !== null);
    const name = entry.name === entry.id ? "" : `  ${entry.name}`;
    lines.push(
      `    ${entry.id}${name}  [${flags.join(", ")}]  ctx ${formatContextWindow(
        entry.contextWindow,
      )}`,
    );
  }
  lines.push("");
  lines.push(
    catalog.selected === null
      ? "default: none; set one with codepunk models set <provider/model>"
      : `default: ${catalog.selected}; change it with codepunk models set <provider/model>`,
  );
  return lines.join("\n");
}

export async function setConfiguredModel(
  paths: ProjectPaths,
  config: CodepunkConfig,
  provider: string,
  id: string,
  thinking?: ThinkingLevel,
): Promise<ConfiguredModel> {
  if (thinking !== undefined && !isThinkingLevel(thinking)) {
    throw new ModelError(
      "config",
      `thinking must be one of ${THINKING_LEVELS.join(", ")}`,
    );
  }
  const runtime = await openModelRuntime(paths);
  const model = runtime.getModel(provider, id);
  if (model === undefined) {
    throw new ModelError(
      "not_found",
      `model ${provider}/${id} is not available; run codepunk models list`,
    );
  }
  if (isFallbackModel(model)) {
    throw new ModelError(
      "config",
      "codepunk/auto is a runtime fallback route and cannot be saved as the default model; choose a provider/model",
    );
  }
  if (config.model.enabled.length > 0) {
    const scoped = await resolveModelScopeWithDiagnostics(
      config.model.enabled,
      runtime,
    );
    if (
      !scoped.scopedModels.some(
        (entry) => entry.model.provider === provider && entry.model.id === id,
      )
    ) {
      throw new ModelError(
        "not_enabled",
        `model ${provider}/${id} is excluded by model.enabled`,
      );
    }
  }
  if (!(await runtime.checkAuth(provider))) {
    throw new ModelError(
      "no_auth",
      `No API key found for ${provider}/${id}; add credentials to ${paths.home}/auth.json or set apiKey in ${paths.home}/models.json`,
    );
  }
  await writeUserModelSelection(paths, provider, id, thinking);
  config.model.provider = provider;
  config.model.id = id;
  if (thinking !== undefined) {
    config.model.thinking = thinking;
  }
  return model;
}

export async function resolveConfiguredModel(
  paths: ProjectPaths,
  config: CodepunkConfig,
  runtime?: ModelRuntime,
): Promise<ConfiguredModel | undefined> {
  const provider = config.model.provider;
  const id = config.model.id;
  if (provider === null || id === null) {
    return undefined;
  }
  const resolvedRuntime = runtime ?? (await openModelRuntime(paths));
  const model = resolvedRuntime.getModel(provider, id);
  if (model === undefined) {
    const error = resolvedRuntime.getError();
    throw new ModelError(
      "not_found",
      `selected model ${provider}/${id} is not available${
        error === undefined ? "" : `: ${error}`
      }`,
    );
  }
  if (config.model.enabled.length > 0) {
    const scoped = await resolveModelScopeWithDiagnostics(
      config.model.enabled,
      resolvedRuntime,
    );
    if (
      !scoped.scopedModels.some(
        (entry) => entry.model.provider === provider && entry.model.id === id,
      )
    ) {
      throw new ModelError(
        "not_enabled",
        `selected model ${provider}/${id} is excluded by model.enabled`,
      );
    }
  }
  const auth = await resolvedRuntime.checkAuth(provider);
  if (auth === undefined) {
    throw new ModelError("no_auth", `No API key found for ${provider}/${id}`);
  }
  return model;
}

export async function probeConfiguredModel(
  paths: ProjectPaths,
  config: CodepunkConfig,
): Promise<string | null> {
  if (config.model.provider === null || config.model.id === null) {
    const detected = await detectAvailableDefaultModel(paths, config).catch(
      () => null,
    );
    if (detected !== null) {
      const ref = `${detected.model.provider}/${detected.model.id}`;
      return [
        `no model configured (detected ${detected.totalAvailable} ready model(s), e.g. ${ref})`,
        `  quick:  codepunk models set ${ref}`,
        ...modelSetupHint().split("\n").slice(1),
      ].join("\n");
    }
    return modelSetupHint();
  }
  const provider = config.model.provider;
  const id = config.model.id;
  let runtime: ModelRuntime;
  try {
    runtime = await openModelRuntime(paths);
  } catch (error) {
    return `model catalog cannot be loaded: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  const model = runtime.getModel(provider, id);
  if (model === undefined) {
    return (
      runtime.getError() ??
      `selected model ${provider}/${id} is not available; run codepunk models list`
    );
  }
  if (config.model.enabled.length > 0) {
    const scoped = await resolveModelScopeWithDiagnostics(
      config.model.enabled,
      runtime,
    );
    if (
      !scoped.scopedModels.some(
        (entry) => entry.model.provider === provider && entry.model.id === id,
      )
    ) {
      return `selected model ${provider}/${id} is excluded by model.enabled`;
    }
  }
  if (!(await runtime.checkAuth(provider))) {
    return `No API key found for ${provider}/${id}; add credentials to ${paths.home}/auth.json or set apiKey in ${paths.home}/models.json`;
  }
  try {
    const auth = await runtime.getAuth(model);
    if (auth === undefined) {
      return `No API key found for ${provider}/${id}; add credentials to ${paths.home}/auth.json or set apiKey in ${paths.home}/models.json`;
    }
  } catch (error) {
    return `model credential for ${provider}/${id} could not be resolved: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  if (config.model.fallback.length > 0) {
    const chain = resolveFallbackChain(runtime, [
      `${provider}/${id}`,
      ...config.model.fallback,
    ]);
    const scoped =
      config.model.enabled.length === 0
        ? null
        : await resolveModelScopeWithDiagnostics(config.model.enabled, runtime);
    const errors = await fallbackConfigurationErrors(model, chain, {
      allowCrossProvider: config.model.fallback_allow_cross_provider,
      authenticated: async (fallbackProvider) =>
        (await runtime.checkAuth(fallbackProvider)) !== undefined,
      ...(scoped === null
        ? {}
        : {
            enabledModels: new Set(
              scoped.scopedModels.map(
                (entry) => `${entry.model.provider}/${entry.model.id}`,
              ),
            ),
          }),
    });
    if (errors.length > 0) {
      return `model fallback is invalid: ${errors.join("; ")}`;
    }
  }
  return null;
}

export async function resolveFallbackContextWindow(
  paths: ProjectPaths,
  config: CodepunkConfig,
  primary: ConfiguredModel,
  runtime?: ModelRuntime,
): Promise<number | undefined> {
  if (config.model.fallback.length === 0) {
    return primary.contextWindow;
  }
  const resolvedRuntime = runtime ?? (await openModelRuntime(paths));
  const chain = resolveFallbackChain(resolvedRuntime, [
    `${primary.provider}/${primary.id}`,
    ...config.model.fallback,
  ]);
  const windows = chain.models
    .map((model) => model.contextWindow)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return windows.length > 0 ? Math.min(...windows) : primary.contextWindow;
}

export async function testConfiguredModel(
  paths: ProjectPaths,
  config: CodepunkConfig,
  reference?: string,
  options?: { timeoutMs?: number; prompt?: string },
): Promise<ModelTestResult> {
  const runtime = await openModelRuntime(paths);
  let provider: string;
  let id: string;
  if (reference === undefined) {
    if (config.model.provider === null || config.model.id === null) {
      throw new ModelError("not_selected", modelSetupHint());
    }
    provider = config.model.provider;
    id = config.model.id;
  } else {
    const resolution = resolveModelSelection(runtime, reference);
    if (resolution.status !== "resolved" || !resolution.exact) {
      throw new ModelError(
        "not_found",
        resolution.status === "resolved"
          ? `model ${reference} is not available; run codepunk models list`
          : reference.includes("/")
            ? `model ${reference} is not available; run codepunk models list`
            : resolution.error,
      );
    }
    provider = resolution.model.provider;
    id = resolution.model.id;
  }
  const model = runtime.getModel(provider, id);
  if (model === undefined) {
    throw new ModelError(
      "not_found",
      `model ${provider}/${id} is not available; run codepunk models list`,
    );
  }
  if (config.model.enabled.length > 0) {
    const scoped = await resolveModelScopeWithDiagnostics(
      config.model.enabled,
      runtime,
    );
    if (
      !scoped.scopedModels.some(
        (entry) => entry.model.provider === provider && entry.model.id === id,
      )
    ) {
      throw new ModelError(
        "not_enabled",
        `model ${provider}/${id} is excluded by model.enabled`,
      );
    }
  }
  if (!(await runtime.checkAuth(provider))) {
    throw new ModelError(
      "no_auth",
      `No API key found for ${provider}/${id}; add credentials to ${paths.home}/auth.json or set apiKey in ${paths.home}/models.json`,
    );
  }
  const started = performance.now();
  try {
    const message = await runtime.completeSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: options?.prompt ?? "Reply with exactly: CODEPUNK_MODEL_OK",
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: 256,
        signal: AbortSignal.timeout(options?.timeoutMs ?? 60_000),
      },
    );
    const error =
      message.stopReason === "error"
        ? (message.errorMessage ?? "upstream model returned an error")
        : null;
    return {
      provider,
      id,
      ok: error === null,
      latency_ms: Math.round(performance.now() - started),
      stop_reason: message.stopReason,
      text: message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim(),
      error,
      input_tokens: usageCount(message.usage.input),
      output_tokens: usageCount(message.usage.output),
      total_tokens: usageCount(message.usage.totalTokens),
    };
  } catch (error) {
    return {
      provider,
      id,
      ok: false,
      latency_ms: Math.round(performance.now() - started),
      stop_reason: "error",
      text: "",
      error: error instanceof Error ? error.message : String(error),
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };
  }
}
