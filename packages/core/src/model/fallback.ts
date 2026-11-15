import type {
  ModelRoute,
  ModelRouteReason,
  ModelRouteRequest,
  ModelRuntime,
  VirtualModelDefinition,
} from "@earendil-works/pi-coding-agent";
import { VIRTUAL_MODEL_STATE_ENTRY } from "@earendil-works/pi-coding-agent";
import {
  getSupportedThinkingLevels,
  isContextOverflow,
} from "@earendil-works/pi-ai";

export const FALLBACK_PROVIDER = "codepunk";
export const FALLBACK_MODEL_ID = "auto";

/**
 * Router state persisted on the Pi session branch.
 *
 * `chain` pins the exact order and identities a session started with, and
 * `attempted` prevents a failed model from being retried by the same request
 * when every later member of the chain has already failed.
 */
export interface FallbackState {
  chain: string[];
  attempted: string[];
  switch: {
    from: string;
    to: string;
    reason: "error";
  } | null;
}

export interface FallbackChain {
  models: NonNullable<ReturnType<ModelRuntime["getModel"]>>[];
  requested: string[];
  missing: string[];
  ambiguous: string[];
}

export interface FallbackValidationOptions {
  allowCrossProvider: boolean;
  authenticated: (provider: string) => boolean | Promise<boolean>;
  /** Exact provider/model references allowed by model.enabled, when set. */
  enabledModels?: ReadonlySet<string>;
}

export interface FallbackAttempt {
  from: string;
  to: string | null;
  reason: "error";
  stopReason: string | null;
  attempted: string[];
  exhausted: boolean;
}

export interface FallbackRouteObservation {
  reason: ModelRouteReason;
  model: string;
}

export type FallbackModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

function reference(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

export function modelReference(model: {
  provider: string;
  id: string;
}): string {
  return reference(model);
}

export function fallbackChainReference(
  models: readonly { provider: string; id: string }[],
): string[] {
  return models.map(reference);
}

export function restoredFallbackChain(
  branch: readonly unknown[],
): string[] | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      record["type"] !== "custom" ||
      record["customType"] !== VIRTUAL_MODEL_STATE_ENTRY
    ) {
      continue;
    }
    const data = record["data"];
    if (data === null || typeof data !== "object") {
      continue;
    }
    const dataRecord = data as Record<string, unknown>;
    if (
      dataRecord["provider"] !== FALLBACK_PROVIDER ||
      dataRecord["modelId"] !== FALLBACK_MODEL_ID
    ) {
      continue;
    }
    const state = dataRecord["state"];
    if (state === null || typeof state !== "object") {
      continue;
    }
    const chain = (state as Record<string, unknown>)["chain"];
    if (
      Array.isArray(chain) &&
      chain.every((entry) => typeof entry === "string")
    ) {
      return [...chain];
    }
  }
  return undefined;
}

export function latestBranchModelSelection(
  branch: readonly unknown[],
): { provider: string; id: string } | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record["type"] !== "model_change") {
      continue;
    }
    const provider = record["provider"];
    const id = record["modelId"];
    if (typeof provider === "string" && typeof id === "string") {
      return { provider, id };
    }
  }
  return undefined;
}

export function resolveFallbackChain(
  runtime: Pick<ModelRuntime, "getModels">,
  references: readonly string[],
): FallbackChain {
  const models = runtime.getModels();
  const requested = references
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const selected = new Map<string, FallbackModel>();
  const missing: string[] = [];
  const ambiguous: string[] = [];
  for (const requestedReference of requested) {
    if (selected.has(requestedReference)) {
      continue;
    }
    const matches = models.filter(
      (candidate) => reference(candidate) === requestedReference,
    );
    if (matches.length === 0) {
      missing.push(requestedReference);
      continue;
    }
    if (matches.length > 1) {
      ambiguous.push(requestedReference);
      continue;
    }
    const match = matches[0]!;
    selected.set(reference(match), match);
  }
  return {
    models: [...selected.values()],
    requested,
    missing,
    ambiguous,
  };
}

/**
 * Reject fallback configurations that would defer a predictable failure to
 * the first request: duplicates, virtual models, missing credentials, models
 * outside the configured scope, or a silent cross-provider data boundary.
 */
export async function fallbackConfigurationErrors(
  primary: { provider: string; id: string },
  chain: FallbackChain,
  options: FallbackValidationOptions,
): Promise<string[]> {
  const errors: string[] = [];
  if (chain.models[0] === undefined || !sameModel(chain.models[0], primary)) {
    errors.push(
      `fallback chain must start with the primary model ${reference(primary)}`,
    );
  }
  if (chain.missing.length > 0) {
    errors.push(
      `unknown models: ${[...new Set(chain.missing)].sort().join(", ")}`,
    );
  }
  if (chain.ambiguous.length > 0) {
    errors.push(
      `ambiguous model references: ${[...new Set(chain.ambiguous)].sort().join(", ")}`,
    );
  }
  const counts = new Map<string, number>();
  for (const entry of chain.requested) {
    counts.set(entry, (counts.get(entry) ?? 0) + 1);
  }
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([entry]) => entry)
    .sort();
  if (duplicates.length > 0) {
    errors.push(`duplicate models: ${duplicates.join(", ")}`);
  }
  for (const model of chain.models) {
    if (isFallbackModel(model) || model.api === "pi-virtual") {
      errors.push(
        `virtual model cannot appear in a fallback chain: ${reference(model)}`,
      );
    }
  }
  const boundaries = new Set(chain.models.map(dataBoundary));
  if (!options.allowCrossProvider && boundaries.size > 1) {
    errors.push(
      "fallback crosses provider or endpoint boundaries; set model.fallback_allow_cross_provider=true to send context to another provider",
    );
  }
  const authenticated = new Map<string, boolean>();
  const failedChecks: Array<{ provider: string; message: string }> = [];
  await Promise.all(
    [...new Set(chain.models.map((model) => model.provider))].map(
      async (provider) => {
        try {
          authenticated.set(provider, await options.authenticated(provider));
        } catch (error) {
          authenticated.set(provider, false);
          failedChecks.push({
            provider,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    ),
  );
  const failedProviders = new Set(failedChecks.map((entry) => entry.provider));
  const unauthenticated = chain.models
    .filter(
      (model) =>
        !failedProviders.has(model.provider) &&
        authenticated.get(model.provider) !== true,
    )
    .map(reference);
  if (unauthenticated.length > 0) {
    errors.push(
      `models have no configured credential: ${[...new Set(unauthenticated)].sort().join(", ")}`,
    );
  }
  if (failedChecks.length > 0) {
    errors.push(
      `credential check failed for ${failedChecks
        .sort((left, right) => left.provider.localeCompare(right.provider))
        .map((entry) => `${entry.provider}: ${entry.message}`)
        .join(", ")}`,
    );
  }
  if (options.enabledModels !== undefined && options.enabledModels.size > 0) {
    const outside = chain.models
      .map(reference)
      .filter((entry) => !options.enabledModels!.has(entry));
    if (outside.length > 0) {
      errors.push(`models are outside model.enabled: ${outside.join(", ")}`);
    }
  }
  return errors;
}

function sameModel(
  left: { provider: string; id: string },
  right: { provider: string; id: string },
): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function dataBoundary(model: { provider: string; baseUrl?: string }): string {
  const raw = typeof model.baseUrl === "string" ? model.baseUrl.trim() : "";
  if (raw.length === 0) {
    return model.provider;
  }
  try {
    const url = new URL(raw);
    return `${model.provider}\n${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, "")}`.toLowerCase();
  } catch {
    return `${model.provider}\n${raw.replace(/\/+$/u, "")}`.toLowerCase();
  }
}

function usableModels(
  models: readonly NonNullable<ReturnType<ModelRuntime["getModel"]>>[],
  usable: (provider: string) => boolean,
): NonNullable<ReturnType<ModelRuntime["getModel"]>>[] {
  return models.filter((model) => usable(model.provider));
}

function firstUsable(
  models: readonly NonNullable<ReturnType<ModelRuntime["getModel"]>>[],
  usable: (provider: string) => boolean,
): NonNullable<ReturnType<ModelRuntime["getModel"]>> {
  const available = usableModels(models, usable);
  const model = available[0] ?? models[0];
  if (model === undefined) {
    throw new Error("model fallback chain has no usable model");
  }
  return model;
}

class FallbackExhaustedError extends Error {
  constructor(failed: string, attempted: readonly string[]) {
    super(
      `model fallback chain exhausted after ${failed}; attempted: ${attempted.join(", ")}`,
    );
    this.name = "FallbackExhaustedError";
  }
}

function nextAfter(
  models: readonly NonNullable<ReturnType<ModelRuntime["getModel"]>>[],
  failed: { provider: string; id: string },
  usable: (provider: string) => boolean,
  attempted: ReadonlySet<string>,
): NonNullable<ReturnType<ModelRuntime["getModel"]>> {
  const failedIndex = models.findIndex((model) => sameModel(model, failed));
  if (failedIndex < 0) {
    throw new Error(
      `failed model ${reference(failed)} is not part of the pinned fallback chain`,
    );
  }
  for (let index = failedIndex + 1; index < models.length; index += 1) {
    const candidate = models[index]!;
    if (usable(candidate.provider) && !attempted.has(reference(candidate))) {
      return candidate;
    }
  }
  throw new FallbackExhaustedError(reference(failed), [
    ...attempted,
    reference(failed),
  ]);
}

function stateFor(
  request: ModelRouteRequest<FallbackState>,
  chain: readonly FallbackModel[],
): FallbackState {
  return {
    chain: request.state?.chain ?? fallbackChainReference(chain),
    attempted: request.state?.attempted ?? [],
    switch: request.state?.switch ?? null,
  };
}

export function createFallbackRoute(
  chain: readonly FallbackModel[],
  usable: (provider: string) => boolean,
  onAttempt?: (event: FallbackAttempt) => Promise<void> | void,
  onRoute?: (event: FallbackRouteObservation) => void,
): (
  request: ModelRouteRequest<FallbackState>,
) => Promise<ModelRoute<FallbackState>> {
  const expected = fallbackChainReference(chain);
  return async (request) => {
    const state = stateFor(request, chain);
    const finish = (
      model: FallbackModel,
      thinkingLevel: ModelRoute<FallbackState>["thinkingLevel"],
      nextState: FallbackState | undefined,
    ): ModelRoute<FallbackState> => {
      onRoute?.({ reason: request.reason, model: reference(model) });
      return {
        model,
        thinkingLevel,
        ...(nextState === undefined ? {} : { state: nextState }),
      };
    };
    if (state.chain.join("\n") !== expected.join("\n")) {
      throw new Error(
        "model fallback chain changed since this session started; start a new session or select the model again",
      );
    }
    if (request.reason === "retry" && request.failed !== undefined) {
      const pinned = chain.find((model) =>
        sameModel(model, request.failed!.model),
      );
      if (isContextOverflow(request.failed.message, pinned?.contextWindow)) {
        if (pinned === undefined || !usable(pinned.provider)) {
          throw new Error(
            `context overflow retry cannot resume ${reference(request.failed.model)} because it is no longer a usable member of the pinned fallback chain`,
          );
        }
        return finish(
          pinned,
          request.failed.thinkingLevel ?? request.thinkingLevel,
          request.state,
        );
      }
      const failed = reference(request.failed.model);
      const attempted = new Set([...state.attempted, failed]);
      let model: FallbackModel;
      const baseAttempt = {
        from: failed,
        reason: "error" as const,
        stopReason: request.failed.message.stopReason ?? null,
        attempted: [...attempted],
      };
      try {
        model = nextAfter(chain, request.failed.model, usable, attempted);
      } catch (error) {
        await onAttempt?.({ ...baseAttempt, to: null, exhausted: true });
        throw error;
      }
      await onAttempt?.({
        ...baseAttempt,
        to: reference(model),
        exhausted: false,
      });
      return finish(
        model,
        request.failed.thinkingLevel ?? request.thinkingLevel,
        {
          ...state,
          attempted: [...attempted],
          switch: { from: failed, to: reference(model), reason: "error" },
        },
      );
    }
    const resume = (model: FallbackModel): ModelRoute<FallbackState> => {
      // pi persists this state only when the returned object differs from the
      // branch's stored state. A continuation without a saved entry must return
      // the freshly built chain to pin it; returning the stored object by
      // reference keeps later continuations from appending duplicates. A user
      // turn or retry resets the attempt set, which is a real state change.
      const reset = request.reason === "user" || request.reason === "retry";
      const nextState = reset
        ? { ...state, attempted: [], switch: null }
        : (request.state ?? state);
      return finish(model, request.thinkingLevel, nextState);
    };
    if (request.reason !== "user" && request.previous !== undefined) {
      const previous = chain.find((model) =>
        sameModel(model, request.previous!.model),
      );
      if (previous !== undefined && usable(previous.provider)) {
        return finish(
          previous,
          request.previous.thinkingLevel ?? request.thinkingLevel,
          request.state ?? state,
        );
      }
    }
    return resume(firstUsable(chain, usable));
  };
}

export function fallbackModelDefinition(
  chain: readonly FallbackModel[],
  usable: (provider: string) => boolean,
  thinkingLevels?: VirtualModelDefinition["thinkingLevels"],
  onAttempt?: (event: FallbackAttempt) => Promise<void> | void,
  onRoute?: (event: FallbackRouteObservation) => void,
): VirtualModelDefinition {
  const primary = chain[0];
  if (primary === undefined) {
    throw new Error("model fallback chain is empty");
  }
  const contextWindows = chain
    .map((model) => model.contextWindow)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const maxTokens = chain
    .map((model) => model.maxTokens)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const supportsImages = chain.every((model) => model.input.includes("image"));
  const supportedByModel = chain.map(
    (model) => new Set(getSupportedThinkingLevels(model)),
  );
  const supportedThinkingLevels = getSupportedThinkingLevels(primary).filter(
    (level) => supportedByModel.every((levels) => levels.has(level)),
  );
  return {
    provider: FALLBACK_PROVIDER,
    id: FALLBACK_MODEL_ID,
    name: `Auto (${chain.map((model) => reference(model)).join(" -> ")})`,
    thinkingLevels: thinkingLevels ?? supportedThinkingLevels,
    contextWindow:
      contextWindows.length > 0
        ? Math.min(...contextWindows)
        : primary.contextWindow,
    maxTokens:
      maxTokens.length > 0 ? Math.min(...maxTokens) : primary.maxTokens,
    input: supportsImages ? ["text", "image"] : ["text"],
    route: createFallbackRoute(chain, usable, onAttempt, onRoute),
  };
}

export function isFallbackModel(model: {
  provider: string;
  id: string;
}): boolean {
  return model.provider === FALLBACK_PROVIDER && model.id === FALLBACK_MODEL_ID;
}
