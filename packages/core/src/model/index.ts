import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ModelRuntime,
  resolveCliModel,
  resolveModelScopeWithDiagnostics,
  type MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { SessionEvent } from "@codepunk/protocol";
import {
  writeUserModelSelection,
  type CodepunkConfig,
  type ThinkingLevel,
} from "../config/index.ts";
import {
  fallbackConfigurationErrors,
  isFallbackModel,
  resolveFallbackChain,
} from "./fallback.ts";
import { atomicWriteFile } from "../platform/fs.ts";
import type { ProjectPaths } from "../platform/paths.ts";

export type ConfiguredModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export type ModelErrorCode =
  | "not_selected"
  | "not_found"
  | "not_enabled"
  | "no_auth"
  | "auth_failed"
  | "config"
  | "network";

export class ModelError extends Error {
  readonly code: ModelErrorCode;

  constructor(code: ModelErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelError";
    this.code = code;
  }
}

export interface ModelUsageRecord {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_total: number;
  stop_reason: string;
}

export interface ModelUsageSummary {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_total: number;
}

/**
 * Token counters reported by Pi for persisted session entries.
 *
 * Pi counts assistant messages and compaction entries. It cannot see calls
 * Codepunk makes directly through the model runtime, such as the durable
 * memory summary.
 */
export interface SessionUsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface ModelsProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  authHeader?: boolean;
  models?: Array<Record<string, unknown> & { id: string }>;
  [key: string]: unknown;
}

export interface ModelsConfig {
  $schema?: string;
  providers?: Record<string, ModelsProviderConfig>;
  [key: string]: unknown;
}

export interface ProviderModelImport {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
}

export interface ProviderImportOptions {
  baseUrl: string;
  providerId: string;
  api: string;
  apiKey?: string;
  authHeader?: boolean;
  models?: readonly string[];
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface ProviderImportResult {
  providerId: string;
  baseUrl: string;
  api: string;
  models: ProviderModelImport[];
  path: string;
  provider: ModelsProviderConfig;
}

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

function modelsPath(paths: ProjectPaths): string {
  return path.join(paths.home, "models.json");
}

export function modelSetupHint(): string {
  return [
    "no model configured",
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

export async function readModelsConfig(
  paths: ProjectPaths,
): Promise<ModelsConfig | null> {
  const filePath = modelsPath(paths);
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new ModelError(
      "config",
      `cannot read ${filePath}: ${(error as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(content.replace(/^\uFEFF/u, "")));
  } catch (error) {
    throw new ModelError(
      "config",
      `cannot parse ${filePath}: ${(error as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelError(
      "config",
      `${filePath} must contain a JSON object with a providers map`,
    );
  }
  const config = parsed as ModelsConfig;
  if (
    config.providers !== undefined &&
    (config.providers === null ||
      typeof config.providers !== "object" ||
      Array.isArray(config.providers))
  ) {
    throw new ModelError(
      "config",
      `${filePath} providers must be a JSON object`,
    );
  }
  return config;
}

function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/gu, (match) =>
      match.startsWith('"') ? match : "",
    )
    .replace(
      /"(?:\\.|[^"\\])*"|,(\s*[}\]])/gu,
      (match, tail: string | undefined) =>
        tail ?? (match.startsWith('"') ? match : ""),
    );
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

function secretForDiscovery(value: string): string {
  if (value.startsWith("!")) {
    throw new ModelError(
      "config",
      "apiKey commands cannot be used for model discovery; pass a literal value or $ENV",
    );
  }
  if (value.startsWith("${") && value.endsWith("}")) {
    return process.env[value.slice(2, -1)] ?? "";
  }
  if (value.startsWith("$")) {
    return process.env[value.slice(1)] ?? "";
  }
  return value;
}

function positiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.trunc(value);
    }
  }
  return undefined;
}

function reasoningLevels(record: Record<string, unknown>): string[] {
  const direct = record["reasoning_levels"];
  if (Array.isArray(direct)) {
    return direct.filter((value): value is string => typeof value === "string");
  }
  const supported = record["supported_reasoning_levels"];
  if (Array.isArray(supported)) {
    return supported
      .map((value) => {
        if (typeof value === "string") {
          return value;
        }
        if (value !== null && typeof value === "object") {
          const effort = (value as Record<string, unknown>)["effort"];
          return typeof effort === "string" ? effort : null;
        }
        return null;
      })
      .filter((value): value is string => value !== null);
  }
  const thinking = record["thinking_levels"];
  if (Array.isArray(thinking)) {
    return thinking.filter(
      (value): value is string => typeof value === "string",
    );
  }
  return [];
}

function thinkingLevelMap(
  levels: readonly string[],
): Record<string, string | null> | undefined {
  if (levels.length === 0) {
    return undefined;
  }
  const available = new Set(levels);
  const pick = (...candidates: string[]): string | null =>
    candidates.find((candidate) => available.has(candidate)) ?? null;
  return {
    off: pick("none", "off"),
    minimal: pick("minimal"),
    low: pick("low"),
    medium: pick("medium", "high"),
    high: pick("high", "medium"),
    xhigh: pick("xhigh", "max", "ultra"),
    max: pick("max", "xhigh", "ultra"),
  };
}

function inputModalities(
  record: Record<string, unknown>,
): Array<"text" | "image"> {
  const modalities =
    record["modalities"] !== null && typeof record["modalities"] === "object"
      ? (record["modalities"] as Record<string, unknown>)["input"]
      : undefined;
  const declared = Array.isArray(modalities)
    ? modalities
    : Array.isArray(record["input"])
      ? record["input"]
      : [];
  return declared.includes("image") ? ["text", "image"] : ["text"];
}

function globMatches(pattern: string, value: string): boolean {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("\\*", ".*")
    .replaceAll("\\?", ".");
  return new RegExp(`^${expression}$`, "u").test(value);
}

function selectedByFilter(id: string, filters: readonly string[]): boolean {
  if (filters.length === 0) {
    return true;
  }
  return filters.some((filter) => filter === id || globMatches(filter, id));
}

function providerEntry(
  options: ProviderImportOptions,
  models: readonly ProviderModelImport[],
): ModelsProviderConfig {
  return {
    name: options.providerId,
    baseUrl: options.baseUrl.replace(/\/+$/u, ""),
    api: options.api,
    apiKey: options.apiKey ?? options.providerId,
    authHeader: options.authHeader === true,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      ...(model.thinkingLevelMap === undefined
        ? {}
        : { thinkingLevelMap: model.thinkingLevelMap }),
    })),
  };
}

export async function fetchProviderModels(
  options: ProviderImportOptions,
): Promise<ProviderModelImport[]> {
  if (options.authHeader === true && options.apiKey === undefined) {
    throw new ModelError(
      "config",
      "authHeader requires apiKey so requests can send a bearer token",
    );
  }
  const endpoint = `${options.baseUrl.replace(/\/+$/u, "")}/models`;
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(options.headers ?? {}),
  };
  if (options.authHeader === true && options.apiKey !== undefined) {
    const discoveredKey = secretForDiscovery(options.apiKey);
    if (discoveredKey.length === 0) {
      throw new ModelError(
        "config",
        `apiKey ${options.apiKey} resolved to an empty value`,
      );
    }
    headers["authorization"] = `Bearer ${discoveredKey}`;
  }
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (error) {
    throw new ModelError(
      "network",
      `cannot reach ${endpoint}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) {
    throw new ModelError(
      "network",
      `${endpoint} returned HTTP ${response.status}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ModelError(
      "network",
      `${endpoint} did not return JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const list: unknown[] | null = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === "object"
      ? Array.isArray((payload as Record<string, unknown>)["data"])
        ? ((payload as Record<string, unknown>)["data"] as unknown[])
        : Array.isArray((payload as Record<string, unknown>)["models"])
          ? ((payload as Record<string, unknown>)["models"] as unknown[])
          : null
      : null;
  if (list === null) {
    throw new ModelError(
      "network",
      `${endpoint} did not return an OpenAI-style data or models array`,
    );
  }
  const filters = (options.models ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const models = new Map<string, ProviderModelImport>();
  for (const raw of list) {
    if (raw === null || typeof raw !== "object") {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const id =
      typeof record["id"] === "string"
        ? record["id"]
        : typeof record["name"] === "string"
          ? record["name"]
          : null;
    if (id === null || id.length === 0 || !selectedByFilter(id, filters)) {
      continue;
    }
    const levels = reasoningLevels(record);
    const name =
      typeof record["display_name"] === "string"
        ? record["display_name"]
        : typeof record["name"] === "string"
          ? record["name"]
          : id;
    const levelMap = thinkingLevelMap(levels);
    models.set(id, {
      id,
      name,
      reasoning: record["reasoning"] === true || levels.length > 0,
      ...(levelMap === undefined ? {} : { thinkingLevelMap: levelMap }),
      input: inputModalities(record),
      contextWindow:
        positiveNumber(
          record["context_window"],
          record["context_length"],
          record["max_input_tokens"],
        ) ?? 128_000,
      maxTokens:
        positiveNumber(record["max_output_tokens"], record["max_tokens"]) ??
        16_384,
    });
  }
  if (models.size === 0) {
    throw new ModelError(
      "network",
      `${endpoint} returned no usable chat models`,
    );
  }
  return [...models.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

export async function writeModelsProvider(
  paths: ProjectPaths,
  providerId: string,
  provider: ModelsProviderConfig,
): Promise<string> {
  if (!/^[A-Za-z0-9._:-]+$/u.test(providerId)) {
    throw new ModelError(
      "config",
      "provider id must use letters, digits, dot, underscore, colon, or hyphen",
    );
  }
  const filePath = modelsPath(paths);
  const config =
    (await readModelsConfig(paths)) ??
    ({
      $schema: "https://pi.dev/schemas/models.schema.json",
      providers: {},
    } satisfies ModelsConfig);
  const providers = config.providers ?? {};
  providers[providerId] = provider;
  config.providers = providers;
  await atomicWriteFile(
    filePath,
    `${JSON.stringify(config, null, 2)}\n`,
    0o600,
  );
  return filePath;
}

export async function removeModelsProvider(
  paths: ProjectPaths,
  providerId: string,
): Promise<{ path: string; providerId: string; remaining: string[] }> {
  if (!/^[A-Za-z0-9._:-]+$/u.test(providerId)) {
    throw new ModelError(
      "config",
      "provider id must use letters, digits, dot, underscore, colon, or hyphen",
    );
  }
  const filePath = modelsPath(paths);
  const config = await readModelsConfig(paths);
  if (
    config === null ||
    config.providers === undefined ||
    config.providers[providerId] === undefined
  ) {
    throw new ModelError(
      "not_found",
      `provider ${providerId} is not configured in ${filePath}`,
    );
  }
  delete config.providers[providerId];
  await atomicWriteFile(
    filePath,
    `${JSON.stringify(config, null, 2)}\n`,
    0o600,
  );
  return {
    path: filePath,
    providerId,
    remaining: Object.keys(config.providers).sort(),
  };
}

export async function importProviderModels(
  paths: ProjectPaths,
  options: ProviderImportOptions,
): Promise<ProviderImportResult> {
  const models = await fetchProviderModels(options);
  const provider = providerEntry(options, models);
  const filePath = await writeModelsProvider(
    paths,
    options.providerId,
    provider,
  );
  return {
    providerId: options.providerId,
    baseUrl: options.baseUrl,
    api: options.api,
    models,
    path: filePath,
    provider,
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function cost(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

export async function openModelRuntime(
  paths: ProjectPaths,
): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: path.join(paths.home, "auth.json"),
    modelsPath: path.join(paths.home, "models.json"),
    allowModelNetwork: false,
  });
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
      input_tokens: count(message.usage.input),
      output_tokens: count(message.usage.output),
      total_tokens: count(message.usage.totalTokens),
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

export function modelUsageFromMessage(
  event: MessageEndEvent,
): ModelUsageRecord | null {
  const message = event.message;
  if (message.role !== "assistant") {
    return null;
  }
  const usage = message.usage;
  if (usage === undefined || usage === null) {
    return null;
  }
  return {
    provider: message.provider,
    model: message.model,
    input_tokens: count(usage.input),
    output_tokens: count(usage.output),
    cache_read_tokens: count(usage.cacheRead),
    cache_write_tokens: count(usage.cacheWrite),
    total_tokens: count(usage.totalTokens),
    cost_total: cost(usage.cost?.total),
    stop_reason: message.stopReason,
  };
}

export function summarizeModelUsage(
  events: readonly SessionEvent[],
): ModelUsageSummary {
  const summary: ModelUsageSummary = {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
    cost_total: 0,
  };
  for (const event of events) {
    if (event.kind === "compaction/decision") {
      const usage = event.data.checkpoint?.usage;
      if (usage === undefined) {
        continue;
      }
      summary.calls += 1;
      summary.input_tokens += usage.input_tokens;
      summary.output_tokens += usage.output_tokens;
      summary.cache_read_tokens += usage.cache_read_tokens;
      summary.cache_write_tokens += usage.cache_write_tokens;
      summary.total_tokens += usage.total_tokens;
      summary.cost_total += usage.cost_total;
      continue;
    }
    if (event.kind !== "model/usage") {
      continue;
    }
    summary.calls += 1;
    summary.input_tokens += event.data.input_tokens;
    summary.output_tokens += event.data.output_tokens;
    summary.cache_read_tokens += event.data.cache_read_tokens;
    summary.cache_write_tokens += event.data.cache_write_tokens;
    summary.total_tokens += event.data.total_tokens;
    summary.cost_total += event.data.cost_total;
  }
  summary.cost_total = Math.round(summary.cost_total * 1_000_000) / 1_000_000;
  return summary;
}

export function summarizeModelUsageBySource(
  events: readonly SessionEvent[],
  source: "assistant" | "summary",
): ModelUsageSummary {
  const summary: ModelUsageSummary = {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
    cost_total: 0,
  };
  for (const event of events) {
    if (event.kind !== "model/usage" || event.data.source !== source) {
      continue;
    }
    summary.calls += 1;
    summary.input_tokens += event.data.input_tokens;
    summary.output_tokens += event.data.output_tokens;
    summary.cache_read_tokens += event.data.cache_read_tokens;
    summary.cache_write_tokens += event.data.cache_write_tokens;
    summary.total_tokens += event.data.total_tokens;
    summary.cost_total += event.data.cost_total;
  }
  summary.cost_total = Math.round(summary.cost_total * 1_000_000) / 1_000_000;
  return summary;
}

/**
 * Combine Pi session statistics with supplemental model calls.
 *
 * Session totals and recorded events describe overlapping sets, so take the
 * larger of the two, then add direct-call usage that Pi never persisted.
 * A plain `Math.max(recorded, sessionStats)` hides summary calls as soon as
 * either side grows past the sum that previously included them.
 */
export function summarizeSessionModelUsage(
  events: readonly SessionEvent[],
  stats: SessionUsageStats,
): ModelUsageSummary {
  const recorded = summarizeModelUsage(events);
  const direct = summarizeModelUsageBySource(events, "summary");
  const sessionTotals = {
    input_tokens: Math.max(0, recorded.input_tokens - direct.input_tokens),
    output_tokens: Math.max(0, recorded.output_tokens - direct.output_tokens),
    cache_read_tokens: Math.max(
      0,
      recorded.cache_read_tokens - direct.cache_read_tokens,
    ),
    cache_write_tokens: Math.max(
      0,
      recorded.cache_write_tokens - direct.cache_write_tokens,
    ),
    total_tokens: Math.max(0, recorded.total_tokens - direct.total_tokens),
    cost_total: Math.max(0, recorded.cost_total - direct.cost_total),
  };
  return {
    calls: recorded.calls,
    input_tokens:
      Math.max(sessionTotals.input_tokens, stats.input) + direct.input_tokens,
    output_tokens:
      Math.max(sessionTotals.output_tokens, stats.output) +
      direct.output_tokens,
    cache_read_tokens:
      Math.max(sessionTotals.cache_read_tokens, stats.cacheRead) +
      direct.cache_read_tokens,
    cache_write_tokens:
      Math.max(sessionTotals.cache_write_tokens, stats.cacheWrite) +
      direct.cache_write_tokens,
    total_tokens:
      Math.max(sessionTotals.total_tokens, stats.total) + direct.total_tokens,
    cost_total:
      Math.round(
        (Math.max(sessionTotals.cost_total, stats.cost) + direct.cost_total) *
          1_000_000,
      ) / 1_000_000,
  };
}
