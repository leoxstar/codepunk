import {
  resolveModelScopeWithDiagnostics,
  type AgentSessionServices,
  type createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import {
  FALLBACK_MODEL_ID,
  FALLBACK_PROVIDER,
  fallbackChainReference,
  fallbackConfigurationErrors,
  fallbackModelDefinition,
  latestBranchModelSelection,
  modelReference,
  resolveFallbackChain,
  restoredFallbackChain,
  type FallbackModel,
} from "../../model/fallback.ts";
import { sha256Text } from "../../platform/hash.ts";
import type { SessionStore } from "../../session/index.ts";
import { HostIsolationError, type CreatePiHostOptions } from "./types.ts";

export interface HostModelSelectionResult {
  sessionModel:
    | NonNullable<Parameters<typeof createAgentSessionFromServices>[0]["model"]>
    | undefined;
  fallbackModels: string[];
  selectableFallbackModels: FallbackModel[];
}

export async function configureHostModelSelection(input: {
  options: CreatePiHostOptions;
  services: AgentSessionServices;
  appendEvent: (
    kind: Parameters<SessionStore["append"]>[0],
    data: unknown,
  ) => Promise<void>;
  onObservation: (observation: { model: string; reason: string }) => void;
}): Promise<HostModelSelectionResult> {
  const { options, services } = input;
  let sessionModel = options.model;
  const fallbackModels: string[] = [];
  let selectableFallbackModels: FallbackModel[] = [];
  const restoredChain =
    options.restore === undefined || options.restore === null
      ? undefined
      : restoredFallbackChain(options.restore.branch);
  const restoredSelection =
    options.restore === undefined || options.restore === null
      ? undefined
      : latestBranchModelSelection(options.restore.branch);
  const selectionIsFallback =
    restoredSelection !== undefined &&
    restoredSelection.provider === FALLBACK_PROVIDER &&
    restoredSelection.id === FALLBACK_MODEL_ID;
  const keepRestoredSelection =
    restoredSelection !== undefined && !selectionIsFallback;
  const configuredFallbackModels = options.fallbackModels ?? [];
  const wantsFallback =
    configuredFallbackModels.length > 0 && !keepRestoredSelection;

  if (selectionIsFallback && configuredFallbackModels.length === 0) {
    throw new HostIsolationError(
      "this session used a model fallback chain but model.fallback is no longer configured; restore the chain or start a new session",
    );
  }

  if (wantsFallback) {
    if (options.model === undefined) {
      throw new HostIsolationError(
        "model fallback requires a selected primary model",
      );
    }
    const chain = resolveFallbackChain(services.modelRuntime, [
      `${options.model.provider}/${options.model.id}`,
      ...configuredFallbackModels,
    ]);
    if (chain.missing.length > 0) {
      throw new HostIsolationError(
        `model fallback references unknown models: ${chain.missing.join(", ")}`,
      );
    }
    const enabledPatterns = services.settingsManager.getEnabledModels() ?? [];
    const scoped =
      enabledPatterns.length === 0
        ? null
        : await resolveModelScopeWithDiagnostics(
            enabledPatterns,
            services.modelRuntime,
          );
    const enabledModels =
      scoped === null
        ? undefined
        : new Set(
            scoped.scopedModels.map((entry) => modelReference(entry.model)),
          );
    const errors = await fallbackConfigurationErrors(options.model, chain, {
      allowCrossProvider: options.fallbackAllowCrossProvider === true,
      authenticated: async (provider) =>
        (await services.modelRuntime.checkAuth(provider)) !== undefined,
      ...(enabledModels === undefined ? {} : { enabledModels }),
    });
    if (errors.length > 0) {
      throw new HostIsolationError(
        `invalid model fallback: ${errors.join("; ")}`,
      );
    }
    if (
      restoredChain !== undefined &&
      restoredChain.join("\n") !==
        fallbackChainReference(chain.models).join("\n")
    ) {
      throw new HostIsolationError(
        "model fallback chain changed since this session started; restore the previous chain or start a new session",
      );
    }
    if (chain.models.length > 1) {
      selectableFallbackModels = [...chain.models];
      const fallbackChainSha = sha256Text(
        fallbackChainReference(chain.models).join("\n"),
      );
      services.modelRuntime.registerVirtualModel(
        fallbackModelDefinition(
          chain.models,
          (provider) => services.modelRuntime.hasConfiguredAuth(provider),
          undefined,
          async (attempt) => {
            await input.appendEvent("model/fallback", {
              from: attempt.from,
              to: attempt.to,
              reason: attempt.reason,
              stop_reason: attempt.stopReason,
              attempted: attempt.attempted,
              exhausted: attempt.exhausted,
              chain_sha256: fallbackChainSha,
            });
          },
          input.onObservation,
        ),
      );
      sessionModel = services.modelRuntime.getModel(
        FALLBACK_PROVIDER,
        FALLBACK_MODEL_ID,
      );
      if (sessionModel === undefined) {
        throw new HostIsolationError(
          "model fallback virtual model was not registered",
        );
      }
      fallbackModels.push(...chain.models.map(modelReference));
    }
  }

  if (keepRestoredSelection) {
    const selected = services.modelRuntime.getPhysicalModel(
      restoredSelection.provider,
      restoredSelection.id,
    );
    if (selected === undefined) {
      throw new HostIsolationError(
        `restored model ${restoredSelection.provider}/${restoredSelection.id} is not in the current catalog`,
      );
    }
    sessionModel = selected;
  }

  return {
    sessionModel,
    fallbackModels,
    selectableFallbackModels,
  };
}
