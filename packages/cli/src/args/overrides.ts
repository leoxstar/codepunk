import {
  ConfigError,
  PERMISSION_PROFILES,
  isThinkingLevel,
  openModelRuntime,
  projectPaths,
  resolveModelSelection,
  type ConfigOverrides,
} from "codepunk-core";
import type { CliOptions } from "./options.ts";

function checkedThinkingLevel(value: string) {
  if (!isThinkingLevel(value)) {
    throw new ConfigError(
      `--thinking ${JSON.stringify(value)} is invalid; must be one of off, minimal, low, medium, high, xhigh, max`,
      "model.thinking",
    );
  }
  return value;
}

export function configOverrides(options: CliOptions): ConfigOverrides {
  const profile =
    options.permissionMode === undefined
      ? undefined
      : PERMISSION_PROFILES[options.permissionMode];
  const approval = options.dangerouslyBypass
    ? "allow"
    : (profile?.approval ?? options.approval);
  const autonomy = profile?.autonomy ?? options.autonomy;
  const sandbox = options.dangerouslyBypass
    ? "uncovered"
    : (profile?.sandbox ?? options.sandbox);
  const filesystem = options.dangerouslyBypass
    ? "full"
    : (profile?.filesystem ?? options.filesystem);
  return {
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.thinking !== undefined
      ? { thinking: checkedThinkingLevel(options.thinking) }
      : {}),
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
    ...(options.modelFallback !== undefined
      ? { fallbackModels: options.modelFallback }
      : {}),
    ...(options.fallbackAllowCrossProvider
      ? { fallbackAllowCrossProvider: true }
      : {}),
    ...(options.appendSystemPrompt !== undefined
      ? { appendSystemPrompt: options.appendSystemPrompt }
      : {}),
    ...(approval !== undefined ? { approval } : {}),
    ...(options.reviewer !== undefined ? { reviewer: options.reviewer } : {}),
    ...(options.reviewerModel !== undefined
      ? { reviewerModel: options.reviewerModel }
      : {}),
    ...(options.reviewerTimeoutMs !== undefined
      ? { reviewerTimeoutMs: options.reviewerTimeoutMs }
      : {}),
    ...(autonomy !== undefined ? { autonomy } : {}),
    ...(options.scopedRules !== undefined
      ? { scopedRules: options.scopedRules }
      : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(filesystem !== undefined ? { filesystem } : {}),
    ...(options.networkAllow !== undefined
      ? { networkAllow: options.networkAllow }
      : {}),
    ...(options.networkDeny !== undefined
      ? { networkDeny: options.networkDeny }
      : {}),
    ...(options.bare
      ? { memory: false }
      : options.memory !== undefined
        ? { memory: options.memory }
        : {}),
  };
}

export async function preparedConfigOverrides(
  options: CliOptions,
  paths: ReturnType<typeof projectPaths>,
): Promise<ConfigOverrides> {
  const overrides = configOverrides(options);
  if (options.model === undefined || options.provider !== undefined) {
    return overrides;
  }
  const runtime = await openModelRuntime(paths);
  const resolution = resolveModelSelection(runtime, options.model);
  if (resolution.status !== "resolved" || !resolution.exact) {
    throw new Error(
      resolution.status === "resolved"
        ? `--model ${options.model} is not an exact catalog entry`
        : resolution.error,
    );
  }
  return {
    ...overrides,
    provider: resolution.model.provider,
    model: resolution.model.id,
    ...(resolution.thinkingLevel !== undefined && options.thinking === undefined
      ? { thinking: resolution.thinkingLevel }
      : {}),
  };
}
