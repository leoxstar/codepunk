import type { AutonomyProfile } from "codepunk-protocol";
import { flattenToml, parseToml, TomlError, type TomlValue } from "./toml.ts";
import {
  ConfigError,
  DEPRECATED_CONFIG_KEYS,
  KEYMAP_ACTIONS,
  KEY_BINDING,
  KEY_SPECS,
  STATUSLINE_SEGMENTS,
  THEME_NAME,
  TOOL_NAMES,
  type ApprovalMode,
  type CodepunkConfig,
  type ConfigOverrides,
  type DeprecatedConfigKey,
  type FilesystemMode,
  type KeySpec,
  type KeymapAction,
  type SandboxMode,
  type TelemetryMode,
} from "./types.ts";

const TELEMETRY_RANK: Record<TelemetryMode, number> = {
  off: 0,
  local: 1,
  "remote-opt-in": 2,
};

function nestedValue(
  config: CodepunkConfig,
  dotted: string,
): string | number | boolean | string[] | null {
  let current: unknown = config;
  for (const segment of dotted.split(".")) {
    if (current === null || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current as string | number | boolean | string[] | null;
}

function assignNested(
  target: CodepunkConfig,
  dotted: string,
  value: unknown,
): void {
  const segments = dotted.split(".");
  let current = target as unknown as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
}

function valueError(key: string, expected: string): ConfigError {
  return new ConfigError(`${key} must be ${expected}`, key);
}

const NETWORK_DOMAIN_ENTRY =
  /^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?::\d{1,5})?$/u;

/**
 * `srt` refuses overly broad wildcards and protocol/path forms. Validate
 * here so a bad entry is a config error at startup instead of an
 * initialization failure that silently disables the shell.
 */
function normalizeNetworkDomains(
  entries: readonly string[],
  key: "sandbox.network_allow" | "sandbox.network_deny",
): string[] {
  const normalized: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    if (entry.length === 0 || !NETWORK_DOMAIN_ENTRY.test(entry)) {
      throw new ConfigError(
        `${key} entry ${JSON.stringify(raw)} must be a hostname, *.hostname, or hostname:port`,
        key,
      );
    }
    const withoutPort = entry.replace(/:\d+$/u, "");
    if (withoutPort.startsWith("*.") && !withoutPort.slice(2).includes(".")) {
      throw new ConfigError(
        `${key} entry ${JSON.stringify(raw)} is too broad; use a registrable domain such as *.example.com`,
        key,
      );
    }
    const port = /:(\d+)$/u.exec(entry)?.[1];
    if (port !== undefined) {
      const value = Number.parseInt(port, 10);
      if (value < 1 || value > 65_535) {
        throw new ConfigError(
          `${key} entry ${JSON.stringify(raw)} has an invalid port`,
          key,
        );
      }
    }
    normalized.push(entry);
  }
  return [...new Set(normalized)];
}

export function normalizeNetworkAllow(entries: readonly string[]): string[] {
  return normalizeNetworkDomains(entries, "sandbox.network_allow");
}

export function normalizeNetworkDeny(entries: readonly string[]): string[] {
  return normalizeNetworkDomains(entries, "sandbox.network_deny");
}

function validateValue(key: string, raw: TomlValue, spec: KeySpec): unknown {
  if (spec.type === "string") {
    if (typeof raw !== "string") {
      throw valueError(key, "a string");
    }
    if (spec.allowed && !spec.allowed.includes(raw)) {
      throw valueError(key, `one of ${spec.allowed.join(", ")}`);
    }
    return raw;
  }
  if (spec.type === "string-null") {
    if (raw === null || raw === "null") {
      return null;
    }
    if (typeof raw !== "string") {
      throw valueError(key, "a string or null");
    }
    return raw;
  }
  if (spec.type === "boolean") {
    if (typeof raw !== "boolean") {
      throw valueError(key, "a boolean");
    }
    return raw;
  }
  if (spec.type === "boolean-or-header") {
    if (raw !== true && raw !== false && raw !== "header") {
      throw valueError(key, 'true, false, or "header"');
    }
    return raw;
  }
  if (spec.type === "integer-or-null") {
    if (raw === null || raw === "null") {
      return null;
    }
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      throw valueError(key, "an integer or null");
    }
    if (spec.minimum !== undefined && raw < spec.minimum) {
      throw valueError(key, `at least ${spec.minimum}`);
    }
    return raw;
  }
  if (spec.type === "number" || spec.type === "integer") {
    if (
      typeof raw !== "number" ||
      !Number.isFinite(raw) ||
      (spec.type === "integer" && !Number.isInteger(raw))
    ) {
      throw valueError(
        key,
        spec.type === "integer" ? "an integer" : "a number",
      );
    }
    if (spec.minimum !== undefined && raw < spec.minimum) {
      throw valueError(key, `at least ${spec.minimum}`);
    }
    if (spec.allowed && !spec.allowed.includes(String(raw))) {
      throw valueError(key, `one of ${spec.allowed.join(", ")}`);
    }
    return raw;
  }
  if (spec.type === "string-array") {
    if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string")) {
      throw valueError(key, "an array of strings");
    }
    return [...raw];
  }
  throw valueError(key, "a supported value");
}

function deprecatedKeyNotice(entry: DeprecatedConfigKey): string {
  const tail =
    entry.action === "renamed"
      ? `use ${entry.replacement ?? "its replacement"}`
      : "ignoring it";
  return `${entry.key} is deprecated since ${entry.deprecatedSince} and may be removed in ${entry.removableIn}; ${tail}`;
}

/**
 * Stores one key after checking its spec. Returns false when the key has no
 * spec, which lets the caller try the deprecation table before refusing it.
 */
function storeConfigValue(
  key: string,
  raw: TomlValue,
  source: "user" | "project" | "local",
  output: Map<string, unknown>,
): boolean {
  const spec = KEY_SPECS.get(key);
  if (spec === undefined) {
    return false;
  }
  if (spec.scope === "user" && source === "project") {
    throw new ConfigError(
      `${key} is user/CLI-only and cannot appear in project config`,
      key,
    );
  }
  if (spec.scope === "user" && source === "local") {
    throw new ConfigError(
      `${key} is user/CLI-only and cannot appear in .codepunk/local.toml; use the user config or an explicit CLI flag`,
      key,
    );
  }
  const value = validateValue(key, raw, spec);
  if (key === "tui.theme") {
    if (typeof value !== "string" || !THEME_NAME.test(value)) {
      throw new ConfigError(
        "tui.theme must be a non-empty theme name",
        "tui.theme",
      );
    }
  }
  if (key === "tui.statusline") {
    const segments = value as string[];
    if (segments.length === 0 || segments.length > 8) {
      throw new ConfigError(
        "tui.statusline must contain 1-8 segments",
        "tui.statusline",
      );
    }
    if (new Set(segments).size !== segments.length) {
      throw new ConfigError(
        "tui.statusline contains a duplicate segment",
        "tui.statusline",
      );
    }
    for (const segment of segments) {
      if (!(STATUSLINE_SEGMENTS as readonly string[]).includes(segment)) {
        throw new ConfigError(
          `tui.statusline has unknown segment ${segment}`,
          "tui.statusline",
        );
      }
    }
  }
  output.set(key, value);
  return true;
}

/**
 * Applies a deprecated key: warns once per load and either maps the value onto
 * its replacement or drops it. Returns false when the key is not deprecated.
 */
function storeDeprecatedConfigValue(
  key: string,
  raw: TomlValue,
  source: "user" | "project" | "local",
  output: Map<string, unknown>,
  warnings: string[],
): boolean {
  const entry = DEPRECATED_CONFIG_KEYS.find((item) => item.key === key);
  if (entry === undefined) {
    return false;
  }
  const notice = deprecatedKeyNotice(entry);
  if (!warnings.includes(notice)) {
    warnings.push(notice);
  }
  if (entry.action === "removed") {
    return true;
  }
  if (entry.replacement === null) {
    throw new ConfigError(
      `deprecated config key ${key} has no replacement`,
      key,
    );
  }
  if (!storeConfigValue(entry.replacement, raw, source, output)) {
    throw new ConfigError(
      `deprecated config key ${key} maps to unknown key ${entry.replacement}`,
      key,
    );
  }
  return true;
}

export function parseLayer(
  content: string,
  source: "user" | "project" | "local",
  warnings: string[],
): Map<string, unknown> {
  let parsed;
  try {
    parsed = parseToml(content);
  } catch (error) {
    if (error instanceof TomlError) {
      throw new ConfigError(`${source} config: ${error.message}`);
    }
    throw error;
  }
  const flat = flattenToml(parsed);
  const output = new Map<string, unknown>();
  const keymap = new Map<KeymapAction, string>();
  for (const [key, raw] of flat) {
    if (key === "policy.write_set") {
      throw new ConfigError(
        "policy.write_set belongs in project policy.toml",
        key,
      );
    }
    if (key.startsWith("tui.keymap.")) {
      const action = key.slice("tui.keymap.".length);
      if (!(KEYMAP_ACTIONS as readonly string[]).includes(action)) {
        throw new ConfigError(`unknown config key: ${key}`, key);
      }
      if (typeof raw !== "string" || !KEY_BINDING.test(raw)) {
        throw new ConfigError(
          `${key} must be off, f1-f12, ctrl+<key>, or alt+<key>`,
          key,
        );
      }
      keymap.set(action as KeymapAction, raw);
      output.set(key, raw);
      continue;
    }
    if (storeConfigValue(key, raw, source, output)) {
      continue;
    }
    if (storeDeprecatedConfigValue(key, raw, source, output, warnings)) {
      continue;
    }
    throw new ConfigError(`unknown config key: ${key}`, key);
  }
  const boundKeys = new Map<string, KeymapAction>();
  for (const [action, binding] of keymap) {
    if (binding === "off") {
      continue;
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
  return output;
}

export function applyLayer(
  target: CodepunkConfig,
  layer: Map<string, unknown>,
): void {
  for (const [key, value] of layer) {
    assignNested(target, key, value);
  }
}

function subset(left: readonly string[], right: readonly string[]): boolean {
  return left.every((entry) => right.includes(entry));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function globMatches(pattern: string, value: string): boolean {
  const expression = escapeRegExp(pattern)
    .replaceAll("\\*", ".*")
    .replaceAll("\\?", ".");
  return new RegExp(`^${expression}$`, "u").test(value);
}

function literalPrefix(pattern: string): string {
  const wildcard = pattern.search(/[*?[\]]/u);
  return wildcard < 0 ? pattern : pattern.slice(0, wildcard);
}

function literalSuffix(pattern: string): string {
  const wildcard = pattern.search(/[*?[\]]/u);
  if (wildcard < 0) {
    return "";
  }
  const lastWildcard = Math.max(
    pattern.lastIndexOf("*"),
    pattern.lastIndexOf("?"),
    pattern.lastIndexOf("["),
    pattern.lastIndexOf("]"),
  );
  return pattern.slice(lastWildcard + 1);
}

function minimumGlobLength(pattern: string): number {
  let length = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      continue;
    }
    if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end < 0) {
        return Number.POSITIVE_INFINITY;
      }
      length += 1;
      index = end;
      continue;
    }
    length += 1;
  }
  return length;
}

function modelPatternCovered(
  projectPattern: string,
  userPattern: string,
): boolean {
  if (projectPattern === userPattern) {
    return true;
  }
  const projectHasGlob = /[*?[\]]/u.test(projectPattern);
  if (!projectHasGlob) {
    return globMatches(userPattern, projectPattern);
  }
  const userWildcards = userPattern.match(/[*?[\]]/gu) ?? [];
  if (userWildcards.length !== 1 || userWildcards[0] !== "*") {
    return false;
  }
  const star = userPattern.indexOf("*");
  const userPrefix = userPattern.slice(0, star);
  const userSuffix = userPattern.slice(star + 1);
  if (
    !literalPrefix(projectPattern).startsWith(userPrefix) ||
    !literalSuffix(projectPattern).endsWith(userSuffix)
  ) {
    return false;
  }
  return (
    userPrefix.length + userSuffix.length <= minimumGlobLength(projectPattern)
  );
}

export function validateProjectFloor(
  user: CodepunkConfig,
  projectLayer: Map<string, unknown>,
): void {
  if (projectLayer.has("tools.enabled")) {
    const projectTools = projectLayer.get("tools.enabled") as string[];
    if (!subset(projectTools, user.tools.enabled)) {
      throw new ConfigError(
        "project tools.enabled cannot add tools outside the user floor",
        "tools.enabled",
      );
    }
    if (projectTools.some((tool) => !TOOL_NAMES.includes(tool as never))) {
      throw new ConfigError(
        "tools.enabled contains an unknown tool",
        "tools.enabled",
      );
    }
  }
  for (const key of [
    "memory.enabled",
    "memory.max_tokens",
    "memory.auto_summary",
    "memory.default_scope",
  ]) {
    if (!projectLayer.has(key)) {
      continue;
    }
    const value = projectLayer.get(key);
    const floor = nestedValue(user, key);
    if (key === "memory.enabled" && value === true && floor !== true) {
      throw new ConfigError(
        "project memory.enabled cannot enable memory over the user floor",
        key,
      );
    }
    if (key === "memory.auto_summary" && value === true && floor !== true) {
      throw new ConfigError(
        "project memory.auto_summary cannot enable summaries over the user floor",
        key,
      );
    }
    if (
      key === "memory.max_tokens" &&
      typeof value === "number" &&
      typeof floor === "number" &&
      value > floor
    ) {
      throw new ConfigError(
        "project memory.max_tokens cannot raise the user cap",
        key,
      );
    }
    if (key === "memory.default_scope" && value !== floor) {
      throw new ConfigError(
        "project memory.default_scope cannot switch the user scope",
        key,
      );
    }
  }
  if (projectLayer.has("telemetry.mode")) {
    const value = projectLayer.get("telemetry.mode") as TelemetryMode;
    if (TELEMETRY_RANK[value] > TELEMETRY_RANK[user.telemetry.mode]) {
      throw new ConfigError(
        "project telemetry.mode cannot raise the user telemetry floor",
        "telemetry.mode",
      );
    }
  }
  if (projectLayer.has("model.enabled")) {
    const projectModels = projectLayer.get("model.enabled") as string[];
    if (
      user.model.enabled.length > 0 &&
      !projectModels.every((projectModel) =>
        user.model.enabled.some((userModel) =>
          modelPatternCovered(projectModel, userModel),
        ),
      )
    ) {
      throw new ConfigError(
        "project model.enabled cannot widen the user model set",
        "model.enabled",
      );
    }
  }
}

const APPROVAL_LOOSENESS: Record<ApprovalMode, number> = {
  deny: 0,
  ask: 1,
  auto: 2,
  allow: 3,
};

const AUTONOMY_LOOSENESS: Record<AutonomyProfile, number> = {
  "read-only": 0,
  ask: 1,
  scoped: 2,
};

const FILESYSTEM_LOOSENESS: Record<FilesystemMode, number> = {
  workspace: 0,
  full: 1,
};

const SANDBOX_LOOSENESS: Record<SandboxMode, number> = {
  required: 0,
  uncovered: 1,
};

export function applyEnvironment(
  target: CodepunkConfig,
  environment: NodeJS.ProcessEnv,
  warnings: string[],
): void {
  const fileLayers = {
    approval: target.approval.mode,
    autonomy: target.autonomy.profile,
    filesystem: target.filesystem.mode,
    sandbox: target.sandbox.mode,
  };
  const mappings: Array<[string, string, (value: string) => unknown]> = [
    ["CODEPUNK_MODEL_PROVIDER", "model.provider", (value) => value],
    ["CODEPUNK_MODEL_ID", "model.id", (value) => value],
    [
      "CODEPUNK_MODEL_THINKING",
      "model.thinking",
      (value) => {
        const spec = KEY_SPECS.get("model.thinking")!;
        return validateValue("model.thinking", value, spec);
      },
    ],
    [
      "CODEPUNK_TUI_MODE",
      "tui.mode",
      (value) => validateValue("tui.mode", value, KEY_SPECS.get("tui.mode")!),
    ],
    [
      "CODEPUNK_APPROVAL_MODE",
      "approval.mode",
      (value) =>
        validateValue("approval.mode", value, KEY_SPECS.get("approval.mode")!),
    ],
    [
      "CODEPUNK_APPROVAL_REVIEWER",
      "approval.reviewer",
      (value) =>
        validateValue(
          "approval.reviewer",
          value,
          KEY_SPECS.get("approval.reviewer")!,
        ),
    ],
    [
      "CODEPUNK_APPROVAL_REVIEWER_MODEL",
      "approval.reviewer_model",
      (value) =>
        validateValue(
          "approval.reviewer_model",
          value,
          KEY_SPECS.get("approval.reviewer_model")!,
        ),
    ],
    [
      "CODEPUNK_APPROVAL_REVIEWER_TIMEOUT_MS",
      "approval.reviewer_timeout_ms",
      (value) =>
        validateValue(
          "approval.reviewer_timeout_ms",
          Number(value),
          KEY_SPECS.get("approval.reviewer_timeout_ms")!,
        ),
    ],
    [
      "CODEPUNK_SANDBOX_MODE",
      "sandbox.mode",
      (value) =>
        validateValue("sandbox.mode", value, KEY_SPECS.get("sandbox.mode")!),
    ],
    [
      "CODEPUNK_NETWORK_MAX_REQUESTS",
      "sandbox.network_max_requests",
      (value) =>
        validateValue(
          "sandbox.network_max_requests",
          value === "null" ? "null" : Number(value),
          KEY_SPECS.get("sandbox.network_max_requests")!,
        ),
    ],
    [
      "CODEPUNK_NETWORK_MAX_BYTES",
      "sandbox.network_max_bytes",
      (value) =>
        validateValue(
          "sandbox.network_max_bytes",
          value === "null" ? "null" : Number(value),
          KEY_SPECS.get("sandbox.network_max_bytes")!,
        ),
    ],
    [
      "CODEPUNK_FILESYSTEM_MODE",
      "filesystem.mode",
      (value) =>
        validateValue(
          "filesystem.mode",
          value,
          KEY_SPECS.get("filesystem.mode")!,
        ),
    ],
    [
      "CODEPUNK_AUTONOMY",
      "autonomy.profile",
      (value) =>
        validateValue(
          "autonomy.profile",
          value,
          KEY_SPECS.get("autonomy.profile")!,
        ),
    ],
    [
      "CODEPUNK_SCOPED_RULES",
      "autonomy.scoped_rules",
      (value) =>
        validateValue(
          "autonomy.scoped_rules",
          value,
          KEY_SPECS.get("autonomy.scoped_rules")!,
        ),
    ],
    [
      "CODEPUNK_MEMORY_ENABLED",
      "memory.enabled",
      (value) => {
        if (value !== "true" && value !== "false") {
          throw new ConfigError(
            "CODEPUNK_MEMORY_ENABLED must be true or false",
            "memory.enabled",
          );
        }
        return value === "true";
      },
    ],
    [
      "CODEPUNK_BUDGET_MAX_TOKENS",
      "budget.max_tokens",
      (value) =>
        validateValue(
          "budget.max_tokens",
          Number(value),
          KEY_SPECS.get("budget.max_tokens")!,
        ),
    ],
    [
      "CODEPUNK_BUDGET_MAX_COST_USD",
      "budget.max_cost_usd",
      (value) =>
        validateValue(
          "budget.max_cost_usd",
          Number(value),
          KEY_SPECS.get("budget.max_cost_usd")!,
        ),
    ],
    [
      "CODEPUNK_BUDGET_MAX_TOOL_CALLS",
      "budget.max_tool_calls",
      (value) =>
        validateValue(
          "budget.max_tool_calls",
          Number(value),
          KEY_SPECS.get("budget.max_tool_calls")!,
        ),
    ],
    [
      "CODEPUNK_BUDGET_MAX_WALL_MS",
      "budget.max_wall_ms",
      (value) =>
        validateValue(
          "budget.max_wall_ms",
          Number(value),
          KEY_SPECS.get("budget.max_wall_ms")!,
        ),
    ],
    [
      "CODEPUNK_MEMORY_MAX_TOKENS",
      "memory.max_tokens",
      (value) => {
        const number = Number(value);
        return validateValue(
          "memory.max_tokens",
          number,
          KEY_SPECS.get("memory.max_tokens")!,
        );
      },
    ],
    [
      "CODEPUNK_TELEMETRY_MODE",
      "telemetry.mode",
      (value) =>
        validateValue(
          "telemetry.mode",
          value,
          KEY_SPECS.get("telemetry.mode")!,
        ),
    ],
  ];
  for (const [name, key, transform] of mappings) {
    const value = environment[name];
    if (value !== undefined) {
      assignNested(target, key, transform(value));
    }
  }

  // An environment variable is the one layer a project file cannot set. It may
  // still only tighten a trust axis silently; a loosening relative to the file
  // layers is reported so `codepunk config` and the startup warnings show it.
  const loosened: Array<[string, string, string]> = [];
  if (
    environment["CODEPUNK_APPROVAL_MODE"] !== undefined &&
    APPROVAL_LOOSENESS[target.approval.mode] >
      APPROVAL_LOOSENESS[fileLayers.approval]
  ) {
    loosened.push([
      "CODEPUNK_APPROVAL_MODE",
      "approval.mode",
      `${fileLayers.approval} -> ${target.approval.mode}`,
    ]);
  }
  if (
    environment["CODEPUNK_AUTONOMY"] !== undefined &&
    AUTONOMY_LOOSENESS[target.autonomy.profile] >
      AUTONOMY_LOOSENESS[fileLayers.autonomy]
  ) {
    loosened.push([
      "CODEPUNK_AUTONOMY",
      "autonomy.profile",
      `${fileLayers.autonomy} -> ${target.autonomy.profile}`,
    ]);
  }
  if (
    environment["CODEPUNK_FILESYSTEM_MODE"] !== undefined &&
    FILESYSTEM_LOOSENESS[target.filesystem.mode] >
      FILESYSTEM_LOOSENESS[fileLayers.filesystem]
  ) {
    loosened.push([
      "CODEPUNK_FILESYSTEM_MODE",
      "filesystem.mode",
      `${fileLayers.filesystem} -> ${target.filesystem.mode}`,
    ]);
  }
  if (
    environment["CODEPUNK_SANDBOX_MODE"] !== undefined &&
    SANDBOX_LOOSENESS[target.sandbox.mode] >
      SANDBOX_LOOSENESS[fileLayers.sandbox]
  ) {
    loosened.push([
      "CODEPUNK_SANDBOX_MODE",
      "sandbox.mode",
      `${fileLayers.sandbox} -> ${target.sandbox.mode}`,
    ]);
  }
  for (const [variable, key, change] of loosened) {
    warnings.push(
      `environment override ${variable} loosens ${key} (${change})`,
    );
  }
}

export function applyCliOverrides(
  target: CodepunkConfig,
  overrides: ConfigOverrides,
): void {
  if (overrides.model !== null && overrides.model !== undefined) {
    if (overrides.provider !== null && overrides.provider !== undefined) {
      if (overrides.model.length === 0) {
        throw new ConfigError("--model cannot be empty", "model.id");
      }
      target.model.provider = overrides.provider;
      target.model.id = overrides.model;
    } else {
      const separator = overrides.model.indexOf("/");
      if (separator <= 0 || separator === overrides.model.length - 1) {
        throw new ConfigError("--model must use provider/model", "model.id");
      }
      target.model.provider = overrides.model.slice(0, separator);
      target.model.id = overrides.model.slice(separator + 1);
    }
  }
  if (overrides.provider !== null && overrides.provider !== undefined) {
    target.model.provider = overrides.provider;
  }
  if (overrides.thinking !== null && overrides.thinking !== undefined) {
    const levels = KEY_SPECS.get("model.thinking")!.allowed!;
    if (!levels.includes(overrides.thinking)) {
      throw new ConfigError(
        `--thinking ${JSON.stringify(overrides.thinking)} is invalid; must be one of ${levels.join(", ")}`,
        "model.thinking",
      );
    }
    target.model.thinking = overrides.thinking;
  }
  if (overrides.tools !== null && overrides.tools !== undefined) {
    const tools = [
      ...new Set(overrides.tools.map((tool) => tool.trim())),
    ].filter((tool) => tool.length > 0);
    for (const tool of tools) {
      if (!TOOL_NAMES.includes(tool as never)) {
        throw new ConfigError(
          `--tools contains unknown tool ${tool}`,
          "tools.enabled",
        );
      }
    }
    target.tools.enabled = tools;
  }
  if (
    overrides.fallbackModels !== null &&
    overrides.fallbackModels !== undefined
  ) {
    target.model.fallback = overrides.fallbackModels.map((entry) =>
      entry.trim(),
    );
  }
  if (
    overrides.fallbackAllowCrossProvider !== null &&
    overrides.fallbackAllowCrossProvider !== undefined
  ) {
    target.model.fallback_allow_cross_provider =
      overrides.fallbackAllowCrossProvider;
  }
  if (
    overrides.appendSystemPrompt !== null &&
    overrides.appendSystemPrompt !== undefined &&
    overrides.appendSystemPrompt.length > 0
  ) {
    target.context.append = [
      target.context.append,
      overrides.appendSystemPrompt,
    ]
      .filter((entry) => entry.length > 0)
      .join("\n\n");
  }
  if (overrides.approval !== null && overrides.approval !== undefined) {
    target.approval.mode = overrides.approval;
  }
  if (overrides.reviewer !== null && overrides.reviewer !== undefined) {
    target.approval.reviewer = overrides.reviewer;
  }
  if (
    overrides.reviewerModel !== null &&
    overrides.reviewerModel !== undefined
  ) {
    target.approval.reviewer_model = overrides.reviewerModel;
  }
  if (
    overrides.reviewerTimeoutMs !== null &&
    overrides.reviewerTimeoutMs !== undefined
  ) {
    target.approval.reviewer_timeout_ms = overrides.reviewerTimeoutMs;
  }
  if (overrides.autonomy !== null && overrides.autonomy !== undefined) {
    target.autonomy.profile = overrides.autonomy;
  }
  if (overrides.scopedRules !== null && overrides.scopedRules !== undefined) {
    target.autonomy.scoped_rules = overrides.scopedRules;
  }
  if (overrides.sandbox !== null && overrides.sandbox !== undefined) {
    target.sandbox.mode = overrides.sandbox;
  }
  if (overrides.filesystem !== null && overrides.filesystem !== undefined) {
    target.filesystem.mode = overrides.filesystem;
  }
  if (overrides.networkAllow !== null && overrides.networkAllow !== undefined) {
    target.sandbox.network_allow = [...overrides.networkAllow];
  }
  if (overrides.networkDeny !== null && overrides.networkDeny !== undefined) {
    target.sandbox.network_deny = [...overrides.networkDeny];
  }
  if (overrides.memory !== null && overrides.memory !== undefined) {
    target.memory.enabled = overrides.memory;
  }
}
