import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CLAIM_LOCK_STALE_MS,
  CLAIM_LOCK_TIMEOUT_MS,
  withClaimFileLock,
} from "../platform/file-lock.ts";
import { atomicWriteFile } from "../platform/fs.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import { ModelError } from "./auth-store.ts";

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

export function modelsPath(paths: ProjectPaths): string {
  return path.join(paths.home, "models.json");
}

async function withModelsConfigLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withClaimFileLock(
    {
      lockDir: `${filePath}.lock.d`,
      timeoutMs: CLAIM_LOCK_TIMEOUT_MS,
      staleMs: CLAIM_LOCK_STALE_MS,
      busyError: () =>
        new ModelError("config", "model config is locked by another process"),
    },
    operation,
  );
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

function scopeSegmentMatches(pattern: string, value: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      expression += ".*";
    } else if (character === "?") {
      expression += ".";
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) {
        expression += "\\[";
        continue;
      }
      let body = pattern.slice(index + 1, end);
      if (body.startsWith("!")) {
        body = `^${body.slice(1)}`;
      }
      expression += `[${body.replaceAll("\\", "\\\\")}]`;
      index = end;
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    }
  }
  try {
    return new RegExp(`${expression}$`, "iu").test(value);
  } catch {
    return false;
  }
}

function scopeGlobMatches(pattern: string, value: string): boolean {
  const patternParts = pattern.split("/");
  const valueParts = value.split("/");
  const visited = new Set<string>();
  const visit = (patternIndex: number, valueIndex: number): boolean => {
    const key = `${patternIndex}:${valueIndex}`;
    if (visited.has(key)) {
      return false;
    }
    visited.add(key);
    if (patternIndex === patternParts.length) {
      return valueIndex === valueParts.length;
    }
    const part = patternParts[patternIndex]!;
    if (part === "**") {
      for (let next = valueIndex; next <= valueParts.length; next += 1) {
        if (visit(patternIndex + 1, next)) {
          return true;
        }
      }
      return false;
    }
    if (valueIndex >= valueParts.length) {
      return false;
    }
    if (!scopeSegmentMatches(part, valueParts[valueIndex]!)) {
      return false;
    }
    return visit(patternIndex + 1, valueIndex + 1);
  };
  return visit(0, 0);
}

function stripThinkingSuffix(reference: string): string {
  return reference.replace(/:(off|minimal|low|medium|high|xhigh|max)$/iu, "");
}

/**
 * Match a concrete model reference against `model.enabled`.
 *
 * Pi's scope resolver only sees chat models, so image models need the same
 * pattern semantics applied directly. Globs match both `provider/id` and a
 * bare id, exact references match one of those forms, and `**` spans whole
 * path segments.
 */
export function modelMatchesEnabledScope(
  model: { provider: string; id: string },
  enabled: readonly string[],
): boolean {
  if (enabled.length === 0) {
    return true;
  }
  const modelId = stripThinkingSuffix(model.id);
  const full = `${model.provider}/${modelId}`;
  return enabled.some((pattern) => {
    const base = stripThinkingSuffix(pattern.trim());
    if (base.length === 0) {
      return false;
    }
    const hasGlob = /[*?[]/u.test(base);
    if (!hasGlob) {
      return base.includes("/")
        ? base.toLowerCase() === full.toLowerCase()
        : base.toLowerCase() === modelId.toLowerCase();
    }
    return scopeGlobMatches(base, full) || scopeGlobMatches(base, modelId);
  });
}

export function parseModelReference(reference: string): {
  provider: string;
  id: string;
} | null {
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) {
    return null;
  }
  return {
    provider: reference.slice(0, separator),
    id: reference.slice(separator + 1),
  };
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
  return withModelsConfigLock(filePath, async () => {
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
  });
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
  return withModelsConfigLock(filePath, async () => {
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
  });
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
