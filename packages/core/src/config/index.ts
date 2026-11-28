import { promises as fs } from "node:fs";
import path from "node:path";
import { type SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  assertProjectConfigFileSafe,
  assertProjectConfigSafe,
  type ProjectPaths,
} from "../platform/paths.ts";
import {
  APPROVAL_MODE_NAMES,
  CONFIG_FILE_NAME,
  ConfigError,
  DEPRECATED_CONFIG_KEYS,
  KEYMAP_ACTIONS,
  KEY_BINDING,
  PERMISSION_PROFILES,
  PERMISSION_PROFILE_NAMES,
  STATUSLINE_SEGMENTS,
  defaultConfig,
  type ApprovalClass,
  type ApprovalMode,
  type CodepunkConfig,
  type CompactionMode,
  type ConfigOverrides,
  type CredentialStoreMode,
  type DeprecatedConfigKey,
  type DeprecatedConfigKeyAction,
  type FilesystemMode,
  type KeymapAction,
  type KeymapBinding,
  type LoadedConfig,
  type PermissionConfigUpdate,
  type PermissionProfile,
  type PermissionProfileSettings,
  type ReviewerMode,
  type SandboxMode,
  type StatuslineSegment,
  type TelemetryMode,
  type ThinkingLevel,
  type TuiPreferencesUpdate,
} from "./types.ts";
import {
  applyCliOverrides,
  applyEnvironment,
  applyLayer,
  normalizeNetworkAllow,
  normalizeNetworkDeny,
  parseLayer,
  validateProjectFloor,
} from "./validate.ts";
import {
  effectiveApprovalDecision,
  isPermissionProfile,
  permissionBehaviorSummary,
  permissionProfileFor,
  writeUserModelSelection,
  writeUserCredentialStoreSelection,
  writeUserPermissionProfile,
  writeUserPermissionSelection,
  writeUserPluginsEnabled,
  writeUserThinkingSelection,
  writeUserTuiPreferences,
} from "./writers.ts";

export {
  APPROVAL_MODE_NAMES,
  CONFIG_FILE_NAME,
  ConfigError,
  DEPRECATED_CONFIG_KEYS,
  KEYMAP_ACTIONS,
  PERMISSION_PROFILES,
  PERMISSION_PROFILE_NAMES,
  STATUSLINE_SEGMENTS,
  defaultConfig,
  effectiveApprovalDecision,
  isPermissionProfile,
  normalizeNetworkAllow,
  normalizeNetworkDeny,
  permissionBehaviorSummary,
  permissionProfileFor,
  writeUserModelSelection,
  writeUserCredentialStoreSelection,
  writeUserPermissionProfile,
  writeUserPermissionSelection,
  writeUserPluginsEnabled,
  writeUserThinkingSelection,
  writeUserTuiPreferences,
  type ApprovalClass,
  type ApprovalMode,
  type CodepunkConfig,
  type CompactionMode,
  type ConfigOverrides,
  type CredentialStoreMode,
  type DeprecatedConfigKey,
  type DeprecatedConfigKeyAction,
  type FilesystemMode,
  type KeymapAction,
  type KeymapBinding,
  type LoadedConfig,
  type PermissionConfigUpdate,
  type PermissionProfile,
  type PermissionProfileSettings,
  type ReviewerMode,
  type SandboxMode,
  type StatuslineSegment,
  type TelemetryMode,
  type ThinkingLevel,
  type TuiPreferencesUpdate,
};

type PiSettings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

export function configFilePaths(paths: ProjectPaths): {
  user: string;
  project: string;
  local: string;
} {
  return {
    user: path.join(paths.home, CONFIG_FILE_NAME),
    project: path.join(paths.projectConfigDir, CONFIG_FILE_NAME),
    local: path.join(paths.projectConfigDir, "local.toml"),
  };
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new ConfigError(
      `cannot read ${filePath}: ${(error as Error).message}`,
    );
  }
}

export async function loadConfig(
  paths: ProjectPaths,
  environment: NodeJS.ProcessEnv = process.env,
  overrides: ConfigOverrides = {},
  options: { projectTrusted?: boolean } = {},
): Promise<LoadedConfig> {
  const config = defaultConfig();
  const {
    user: userPath,
    project: projectPath,
    local: localPath,
  } = configFilePaths(paths);
  const warnings: string[] = [];
  // A workspace rooted at the user's home resolves its project config to the
  // same file as the user config. Reading it twice rejects user-only keys.
  const projectSharesUserConfig =
    path.resolve(projectPath) === path.resolve(userPath);

  const userContent = await readOptional(userPath);
  if (userContent !== null) {
    applyLayer(config, parseLayer(userContent, "user", warnings));
  }
  const userFloor = structuredClone(config);
  const projectSafety = projectSharesUserConfig
    ? null
    : options.projectTrusted === false
      ? "project config resource is not trusted"
      : await assertProjectConfigSafe(paths);
  if (projectSafety !== null) {
    warnings.push(`project config ignored: ${projectSafety}`);
  }
  let projectContent: string | null = null;
  let localContent: string | null = null;
  if (!projectSharesUserConfig && projectSafety === null) {
    const projectFileSafety = await assertProjectConfigFileSafe(projectPath);
    if (projectFileSafety !== null) {
      warnings.push(`project config ignored: ${projectFileSafety}`);
    } else {
      projectContent = await readOptional(projectPath);
    }
    const localFileSafety = await assertProjectConfigFileSafe(localPath);
    if (localFileSafety !== null) {
      warnings.push(`project local config ignored: ${localFileSafety}`);
    } else {
      localContent = await readOptional(localPath);
    }
  }
  const projectLayer = new Map<string, unknown>();
  if (projectContent !== null) {
    for (const [key, value] of parseLayer(
      projectContent,
      "project",
      warnings,
    )) {
      projectLayer.set(key, value);
    }
  }
  if (localContent !== null) {
    for (const [key, value] of parseLayer(localContent, "local", warnings)) {
      if (projectLayer.has(key) && projectLayer.get(key) !== value) {
        warnings.push(`local.toml overrides ${key}`);
      }
      projectLayer.set(key, value);
    }
  }
  validateProjectFloor(userFloor, projectLayer);
  applyLayer(config, projectLayer);
  applyEnvironment(config, environment, warnings);
  applyCliOverrides(config, overrides);

  const boundKeys = new Map<string, KeymapAction>();
  for (const action of KEYMAP_ACTIONS) {
    const binding = config.tui.keymap[action];
    if (binding === "off") {
      continue;
    }
    if (!KEY_BINDING.test(binding)) {
      throw new ConfigError(
        `tui.keymap.${action} must be off, f1-f12, ctrl+<key>, or alt+<key>`,
        `tui.keymap.${action}`,
      );
    }
    const previous = boundKeys.get(binding);
    if (previous !== undefined) {
      throw new ConfigError(
        `key ${binding} is assigned to both ${previous} and ${action}`,
        `tui.keymap.${action}`,
      );
    }
    boundKeys.set(binding, action);
  }
  if (config.session.lease_seconds < config.session.heartbeat_seconds) {
    throw new ConfigError(
      "session.lease_seconds must be at least session.heartbeat_seconds",
      "session.lease_seconds",
    );
  }
  if (
    config.context.artifact_threshold_tokens >
    config.context.max_tool_output_tokens
  ) {
    throw new ConfigError(
      "artifact threshold cannot exceed the tool output budget",
      "context.artifact_threshold_tokens",
    );
  }
  if (
    config.context.replace_system_prompt &&
    config.context.system_prompt_file === null
  ) {
    throw new ConfigError(
      "context.replace_system_prompt requires context.system_prompt_file",
      "context.system_prompt_file",
    );
  }
  if (
    !config.context.replace_system_prompt &&
    config.context.system_prompt_file !== null
  ) {
    throw new ConfigError(
      "context.system_prompt_file requires context.replace_system_prompt",
      "context.replace_system_prompt",
    );
  }
  if (config.approval.reviewer === "model") {
    if (config.approval.mode !== "auto") {
      warnings.push(
        "approval.reviewer is inactive unless approval.mode is auto",
      );
    }
    if (config.approval.reviewer_model !== null) {
      const reference = config.approval.reviewer_model.trim();
      const separator = reference.indexOf("/");
      if (
        separator <= 0 ||
        separator === reference.length - 1 ||
        reference.startsWith("/") ||
        reference.endsWith("/") ||
        /\s/u.test(reference)
      ) {
        throw new ConfigError(
          "approval.reviewer_model must use provider/model",
          "approval.reviewer_model",
        );
      }
      config.approval.reviewer_model = reference;
    }
  } else if (config.approval.reviewer_model !== null) {
    throw new ConfigError(
      "approval.reviewer_model requires approval.reviewer=model",
      "approval.reviewer_model",
    );
  }
  config.model.fallback = [
    ...new Set(config.model.fallback.map((entry) => entry.trim())),
  ].filter((entry) => entry.length > 0);
  for (const fallback of config.model.fallback) {
    if (
      !fallback.includes("/") ||
      fallback.startsWith("/") ||
      fallback.endsWith("/") ||
      /\s/u.test(fallback)
    ) {
      throw new ConfigError(
        "model.fallback entries must use provider/model",
        "model.fallback",
      );
    }
  }
  if (config.telemetry.mode !== "off") {
    throw new ConfigError(
      "telemetry.mode must remain off because telemetry is not implemented",
      "telemetry.mode",
    );
  }
  if (config.autonomy.profile === "scoped") {
    if (
      config.autonomy.scoped_rules === null ||
      config.autonomy.scoped_rules.length === 0
    ) {
      throw new ConfigError(
        "scoped autonomy requires an explicit rules file",
        "autonomy.scoped_rules",
      );
    }
    config.autonomy.scoped_rules = path.resolve(
      paths.cwd,
      config.autonomy.scoped_rules,
    );
  } else if (
    config.autonomy.scoped_rules !== null &&
    config.autonomy.scoped_rules.length > 0
  ) {
    warnings.push(
      "autonomy.scoped_rules is inactive unless autonomy.profile is scoped",
    );
    config.autonomy.scoped_rules = path.resolve(
      paths.cwd,
      config.autonomy.scoped_rules,
    );
  }
  config.sandbox.network_allow = normalizeNetworkAllow(
    config.sandbox.network_allow,
  );
  config.sandbox.network_deny = normalizeNetworkDeny(
    config.sandbox.network_deny,
  );
  const conflicting = config.sandbox.network_allow.filter((entry) =>
    config.sandbox.network_deny.includes(entry),
  );
  if (conflicting.length > 0) {
    throw new ConfigError(
      `sandbox.network_deny also lists ${conflicting.join(", ")}; an entry cannot be both allowed and denied`,
      "sandbox.network_deny",
    );
  }
  return { config, userPath, projectPath, localPath, warnings };
}

export function piSettings(
  config: CodepunkConfig,
  contextWindow?: number,
): PiSettings {
  const reserveTokens =
    contextWindow !== undefined &&
    Number.isSafeInteger(contextWindow) &&
    contextWindow > 0
      ? Math.max(
          0,
          Math.ceil(contextWindow * (1 - config.context.compaction_threshold)),
        )
      : undefined;
  const settings: PiSettings = {
    tuiMode: config.tui.mode,
    quietStartup: config.tui.quiet_startup,
    outputPad: config.tui.output_pad,
    hideThinkingBlock: config.tui.hide_thinking,
    showCacheMissNotices: config.tui.cache_notices,
    terminal: {
      showImages: config.tui.images,
      images: config.tui.images ? "auto" : false,
      trueColor: config.tui.truecolor,
      hyperlinks: config.tui.hyperlinks,
    },
    markdown: {
      mermaid: config.tui.mermaid,
    },
    compaction: {
      enabled: config.context.compaction === "auto",
      keepRecentTokens: config.context.keep_recent_tokens,
      ...(reserveTokens === undefined ? {} : { reserveTokens }),
    },
  };
  if (config.model.enabled.length > 0) {
    settings.enabledModels = [...config.model.enabled];
  }
  if (config.tui.theme !== "codepunk") {
    settings.theme = config.tui.theme;
  }
  return settings;
}

export function configSummary(
  config: CodepunkConfig,
  writeSet: readonly string[] = [],
): string[] {
  return [
    `model: ${config.model.provider ?? "auto"}/${config.model.id ?? "auto"} (${config.model.thinking})`,
    ...(config.model.fallback.length === 0
      ? []
      : [`model fallback: ${config.model.fallback.join(" -> ")}`]),
    ...(config.model.fallback.length > 0 &&
    config.model.fallback_allow_cross_provider
      ? ["model fallback may cross providers"]
      : []),
    `approval: ${config.approval.mode}`,
    ...(config.approval.reviewer === "off"
      ? []
      : [
          `approval reviewer: ${config.approval.reviewer}${
            config.approval.reviewer_model === null
              ? " (session model)"
              : ` (${config.approval.reviewer_model})`
          }`,
        ]),
    `autonomy: ${config.autonomy.profile}`,
    `sandbox: ${config.sandbox.mode}`,
    `network allow: ${
      config.sandbox.network_allow.length === 0
        ? "none (deny by default)"
        : config.sandbox.network_allow.join(", ")
    }`,
    ...(config.sandbox.network_deny.length === 0
      ? []
      : [`network deny: ${config.sandbox.network_deny.join(", ")}`]),
    `network limit: ${
      config.sandbox.network_max_requests === null &&
      config.sandbox.network_max_bytes === null
        ? "off"
        : [
            config.sandbox.network_max_requests === null
              ? null
              : `${config.sandbox.network_max_requests} requests/domain`,
            config.sandbox.network_max_bytes === null
              ? null
              : `${config.sandbox.network_max_bytes} bytes/domain`,
          ]
            .filter((entry): entry is string => entry !== null)
            .join(" / ")
    }`,
    `filesystem: ${config.filesystem.mode}`,
    `tools: ${config.tools.enabled.join(", ")}`,
    `write set: ${writeSet.length === 0 ? "(empty)" : writeSet.join(", ")}`,
    `budget: ${
      config.budget.max_tokens === null && config.budget.max_cost_usd === null
        ? "off"
        : [
            config.budget.max_tokens === null
              ? null
              : `${config.budget.max_tokens} tokens`,
            config.budget.max_cost_usd === null
              ? null
              : `$${config.budget.max_cost_usd}`,
          ]
            .filter((entry): entry is string => entry !== null)
            .join(" / ")
    }`,
    `memory: ${config.memory.enabled ? `on, ${config.memory.max_tokens} tokens, ${config.memory.default_scope}` : "off"}`,
    `tui: theme ${config.tui.theme}, statusline ${config.tui.statusline.join(" > ")}, keymap ${KEYMAP_ACTIONS.map((action) => `${action}=${config.tui.keymap[action]}`).join(", ")}`,
    `plugins: ${config.plugins.enabled ? "enabled" : "disabled"}`,
    `telemetry: ${config.telemetry.mode}`,
    `retention: sessions ${config.session.retention_days}d/${config.session.retention_count}, evidence ${config.evidence.retention_days}d/${config.evidence.retention_count}`,
  ];
}
