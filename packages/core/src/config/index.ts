import { promises as fs } from "node:fs";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AutonomyProfile, PolicyDecision } from "@codepunk/protocol";
import { atomicWriteFile } from "../platform/fs.ts";
import {
  assertProjectConfigFileSafe,
  assertProjectConfigSafe,
  type ProjectPaths,
} from "../platform/paths.ts";
import { flattenToml, parseToml, TomlError, type TomlValue } from "./toml.ts";

export class ConfigError extends Error {
  readonly key: string | null;

  constructor(message: string, key: string | null = null) {
    super(message);
    this.name = "ConfigError";
    this.key = key;
  }
}

export type ApprovalMode = "ask" | "deny" | "auto" | "allow";
export type ReviewerMode = "off" | "model";
export type FilesystemMode = "workspace" | "full";
export type SandboxMode = "required" | "uncovered";
export type TelemetryMode = "off" | "local" | "remote-opt-in";
export type ThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type CompactionMode = "auto" | "manual";

export interface CodepunkConfig {
  tui: {
    mode: "fullscreen" | "regular";
    theme: string;
    header: boolean;
    footer: boolean;
    status: boolean;
    widgets: boolean;
    output_pad: 0 | 1;
    quiet_startup: boolean | "header";
    hide_thinking: boolean;
    cache_notices: boolean;
    images: boolean;
    truecolor: boolean;
    hyperlinks: boolean;
    mermaid: "off" | "final" | "streaming";
  };
  context: {
    append: string;
    append_files: string[];
    replace_system_prompt: boolean;
    system_prompt_file: string | null;
    max_tool_output_tokens: number;
    artifact_threshold_tokens: number;
    truncation: "turn-boundary";
    compaction: CompactionMode;
    compaction_threshold: number;
    truncation_threshold: number;
    keep_recent_tokens: number;
  };
  model: {
    provider: string | null;
    id: string | null;
    thinking: ThinkingLevel;
    enabled: string[];
    fallback: string[];
    fallback_allow_cross_provider: boolean;
  };
  plugins: {
    enabled: boolean;
  };
  tools: {
    enabled: string[];
    shell: "auto" | "bash" | "pwsh";
    search: "auto";
  };
  approval: {
    mode: ApprovalMode;
    reviewer: ReviewerMode;
    reviewer_model: string | null;
    reviewer_timeout_ms: number;
  };
  autonomy: {
    profile: AutonomyProfile;
    scoped_rules: string | null;
  };
  sandbox: {
    mode: SandboxMode;
    network_allow: string[];
    network_deny: string[];
  };
  filesystem: {
    mode: FilesystemMode;
  };
  session: {
    retention_days: number;
    retention_count: number;
    heartbeat_seconds: number;
    lease_seconds: number;
  };
  evidence: {
    retention_days: number;
    retention_count: number;
  };
  budget: {
    max_tokens: number | null;
    max_cost_usd: number | null;
  };
  memory: {
    enabled: boolean;
    max_tokens: number;
    default_scope: "user" | "project";
    auto_summary: boolean;
  };
  telemetry: {
    mode: TelemetryMode;
  };
}

export interface ConfigOverrides {
  config?: string | null;
  model?: string | null;
  provider?: string | null;
  thinking?: ThinkingLevel | null;
  /** Exact tool allowlist for this process, used by guarded child hosts. */
  tools?: readonly string[] | null;
  /** Per-process fallback chain, used by guarded child hosts. */
  fallbackModels?: readonly string[] | null;
  fallbackAllowCrossProvider?: boolean | null;
  /** Additional system-prompt text appended after the configured layer. */
  appendSystemPrompt?: string | null;
  approval?: ApprovalMode | null;
  reviewer?: ReviewerMode | null;
  reviewerModel?: string | null;
  reviewerTimeoutMs?: number | null;
  autonomy?: AutonomyProfile | null;
  scopedRules?: string | null;
  sandbox?: SandboxMode | null;
  filesystem?: FilesystemMode | null;
  memory?: boolean | null;
}

export interface LoadedConfig {
  config: CodepunkConfig;
  userPath: string;
  projectPath: string;
  localPath: string;
  warnings: string[];
}

type PiSettings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

type KeyType =
  | "string"
  | "string-null"
  | "boolean"
  | "number"
  | "integer"
  | "boolean-or-header"
  | "string-array";

interface KeySpec {
  type: KeyType;
  allowed?: readonly string[];
  scope?: "user" | "any";
  minimum?: number;
}

const TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "shell",
  "search",
  "memory_search",
  "exec",
  "plan",
  "todo",
] as const;

const KEY_SPECS = new Map<string, KeySpec>([
  [
    "tui.mode",
    { type: "string", allowed: ["fullscreen", "regular"], scope: "any" },
  ],
  ["tui.theme", { type: "string", scope: "any" }],
  ["tui.header", { type: "boolean", scope: "any" }],
  ["tui.footer", { type: "boolean", scope: "any" }],
  ["tui.status", { type: "boolean", scope: "any" }],
  ["tui.widgets", { type: "boolean", scope: "any" }],
  ["tui.output_pad", { type: "integer", allowed: ["0", "1"], scope: "any" }],
  ["tui.quiet_startup", { type: "boolean-or-header", scope: "any" }],
  ["tui.hide_thinking", { type: "boolean", scope: "any" }],
  ["tui.cache_notices", { type: "boolean", scope: "any" }],
  ["tui.images", { type: "boolean", scope: "any" }],
  ["tui.truecolor", { type: "boolean", scope: "any" }],
  ["tui.hyperlinks", { type: "boolean", scope: "any" }],
  [
    "tui.mermaid",
    { type: "string", allowed: ["off", "final", "streaming"], scope: "any" },
  ],
  ["context.append", { type: "string", scope: "user" }],
  ["context.append_files", { type: "string-array", scope: "user" }],
  ["context.replace_system_prompt", { type: "boolean", scope: "user" }],
  ["context.system_prompt_file", { type: "string-null", scope: "user" }],
  [
    "context.max_tool_output_tokens",
    { type: "integer", minimum: 1, scope: "any" },
  ],
  [
    "context.artifact_threshold_tokens",
    { type: "integer", minimum: 1, scope: "any" },
  ],
  [
    "context.truncation",
    { type: "string", allowed: ["turn-boundary"], scope: "any" },
  ],
  [
    "context.compaction",
    { type: "string", allowed: ["auto", "manual"], scope: "any" },
  ],
  [
    "context.compaction_threshold",
    { type: "number", minimum: 0, scope: "any" },
  ],
  [
    "context.truncation_threshold",
    { type: "number", minimum: 0, scope: "any" },
  ],
  ["context.keep_recent_tokens", { type: "integer", minimum: 0, scope: "any" }],
  ["model.provider", { type: "string-null", scope: "user" }],
  ["model.id", { type: "string-null", scope: "user" }],
  [
    "model.thinking",
    {
      type: "string",
      allowed: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      scope: "any",
    },
  ],
  ["model.enabled", { type: "string-array", scope: "any" }],
  ["model.fallback", { type: "string-array", scope: "user" }],
  ["model.fallback_allow_cross_provider", { type: "boolean", scope: "user" }],
  ["plugins.enabled", { type: "boolean", scope: "user" }],
  ["tools.enabled", { type: "string-array", scope: "any" }],
  [
    "tools.shell",
    { type: "string", allowed: ["auto", "bash", "pwsh"], scope: "any" },
  ],
  ["tools.search", { type: "string", allowed: ["auto"], scope: "any" }],
  [
    "approval.mode",
    {
      type: "string",
      allowed: ["ask", "deny", "auto", "allow"],
      scope: "user",
    },
  ],
  [
    "approval.reviewer",
    {
      type: "string",
      allowed: ["off", "model"],
      scope: "user",
    },
  ],
  ["approval.reviewer_model", { type: "string-null", scope: "user" }],
  [
    "approval.reviewer_timeout_ms",
    { type: "integer", minimum: 1_000, scope: "user" },
  ],
  [
    "autonomy.profile",
    {
      type: "string",
      allowed: ["read-only", "ask", "scoped"],
      scope: "user",
    },
  ],
  ["autonomy.scoped_rules", { type: "string-null", scope: "user" }],
  [
    "sandbox.mode",
    { type: "string", allowed: ["required", "uncovered"], scope: "user" },
  ],
  ["sandbox.network_allow", { type: "string-array", scope: "user" }],
  ["sandbox.network_deny", { type: "string-array", scope: "user" }],
  [
    "filesystem.mode",
    {
      type: "string",
      allowed: ["workspace", "full"],
      scope: "user",
    },
  ],
  ["session.retention_days", { type: "integer", minimum: 0, scope: "any" }],
  ["session.retention_count", { type: "integer", minimum: 0, scope: "any" }],
  ["session.heartbeat_seconds", { type: "integer", minimum: 1, scope: "user" }],
  ["session.lease_seconds", { type: "integer", minimum: 1, scope: "user" }],
  ["evidence.retention_days", { type: "integer", minimum: 0, scope: "any" }],
  ["evidence.retention_count", { type: "integer", minimum: 0, scope: "any" }],
  ["budget.max_tokens", { type: "integer", minimum: 1, scope: "user" }],
  ["budget.max_cost_usd", { type: "number", minimum: 0, scope: "user" }],
  ["memory.enabled", { type: "boolean", scope: "any" }],
  ["memory.max_tokens", { type: "integer", minimum: 1, scope: "any" }],
  [
    "memory.default_scope",
    { type: "string", allowed: ["user", "project"], scope: "any" },
  ],
  ["memory.auto_summary", { type: "boolean", scope: "any" }],
  [
    "telemetry.mode",
    {
      type: "string",
      allowed: ["off", "local", "remote-opt-in"],
      scope: "any",
    },
  ],
]);

const TELEMETRY_RANK: Record<TelemetryMode, number> = {
  off: 0,
  local: 1,
  "remote-opt-in": 2,
};

export function defaultConfig(): CodepunkConfig {
  return {
    tui: {
      mode: "fullscreen",
      theme: "codepunk",
      header: true,
      footer: true,
      status: true,
      widgets: true,
      output_pad: 0,
      quiet_startup: true,
      hide_thinking: false,
      cache_notices: true,
      images: true,
      truecolor: true,
      hyperlinks: true,
      mermaid: "final",
    },
    context: {
      append: "",
      append_files: [],
      replace_system_prompt: false,
      system_prompt_file: null,
      max_tool_output_tokens: 8_000,
      artifact_threshold_tokens: 2_000,
      truncation: "turn-boundary",
      compaction: "auto",
      compaction_threshold: 0.8,
      truncation_threshold: 0.95,
      keep_recent_tokens: 8_000,
    },
    model: {
      provider: null,
      id: null,
      thinking: "medium",
      enabled: [],
      fallback: [],
      fallback_allow_cross_provider: false,
    },
    plugins: {
      enabled: false,
    },
    tools: {
      enabled: [
        "read",
        "write",
        "edit",
        "shell",
        "search",
        "memory_search",
        "plan",
        "todo",
      ],
      shell: "auto",
      search: "auto",
    },
    approval: {
      mode: "ask",
      reviewer: "off",
      reviewer_model: null,
      reviewer_timeout_ms: 20_000,
    },
    autonomy: {
      profile: "ask",
      scoped_rules: null,
    },
    sandbox: {
      mode: "required",
      network_allow: [],
      network_deny: [],
    },
    filesystem: {
      mode: "workspace",
    },
    session: {
      retention_days: 90,
      retention_count: 100,
      heartbeat_seconds: 5,
      lease_seconds: 30,
    },
    evidence: {
      retention_days: 180,
      retention_count: 500,
    },
    budget: {
      max_tokens: null,
      max_cost_usd: null,
    },
    memory: {
      enabled: true,
      max_tokens: 800,
      default_scope: "project",
      auto_summary: true,
    },
    telemetry: {
      mode: "off",
    },
  };
}

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

function parseLayer(
  content: string,
  source: "user" | "project" | "local",
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
  for (const [key, raw] of flat) {
    if (key === "policy.write_set") {
      throw new ConfigError(
        "policy.write_set belongs in project policy.toml",
        key,
      );
    }
    const spec = KEY_SPECS.get(key);
    if (spec === undefined) {
      throw new ConfigError(`unknown config key: ${key}`, key);
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
    output.set(key, validateValue(key, raw, spec));
  }
  return output;
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

function applyLayer(target: CodepunkConfig, layer: Map<string, unknown>): void {
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

function validateProjectFloor(
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

function applyEnvironment(
  target: CodepunkConfig,
  environment: NodeJS.ProcessEnv,
): void {
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
}

function applyCliOverrides(
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
  if (overrides.memory !== null && overrides.memory !== undefined) {
    target.memory.enabled = overrides.memory;
  }
}

export async function loadConfig(
  paths: ProjectPaths,
  environment: NodeJS.ProcessEnv = process.env,
  overrides: ConfigOverrides = {},
  options: { projectTrusted?: boolean } = {},
): Promise<LoadedConfig> {
  const config = defaultConfig();
  const userPath = path.join(paths.home, "config.toml");
  const projectPath = path.join(paths.projectConfigDir, "config.toml");
  const localPath = path.join(paths.projectConfigDir, "local.toml");
  const warnings: string[] = [];

  const userContent = await readOptional(userPath);
  if (userContent !== null) {
    applyLayer(config, parseLayer(userContent, "user"));
  }
  const userFloor = structuredClone(config);
  const projectSafety =
    options.projectTrusted === false
      ? "workspace is not trusted"
      : await assertProjectConfigSafe(paths);
  if (projectSafety !== null) {
    warnings.push(`project config ignored: ${projectSafety}`);
  }
  let projectContent: string | null = null;
  let localContent: string | null = null;
  if (projectSafety === null) {
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
    for (const [key, value] of parseLayer(projectContent, "project")) {
      projectLayer.set(key, value);
    }
  }
  if (localContent !== null) {
    for (const [key, value] of parseLayer(localContent, "local")) {
      if (projectLayer.has(key) && projectLayer.get(key) !== value) {
        warnings.push(`local.toml overrides ${key}`);
      }
      projectLayer.set(key, value);
    }
  }
  validateProjectFloor(userFloor, projectLayer);
  applyLayer(config, projectLayer);
  applyEnvironment(config, environment);
  applyCliOverrides(config, overrides);

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
  if (config.tools.shell === "pwsh") {
    throw new ConfigError(
      "tools.shell=pwsh requires Windows support, which is not implemented",
      "tools.shell",
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

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => tomlString(value)).join(", ")}]`;
}

function isSectionHeader(line: string): boolean {
  return /^\s*\[/u.test(line);
}

function isSectionHeaderNamed(line: string, section: string): boolean {
  const match = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line);
  return match?.[1] === section;
}

function upsertSectionValues(
  content: string,
  section: string,
  requested: ReadonlyMap<string, string>,
): string {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  const start = lines.findIndex((line) => isSectionHeaderNamed(line, section));
  if (start < 0) {
    if (lines.length > 0 && lines.at(-1) !== "") {
      lines.push("");
    }
    lines.push(`[${section}]`);
    for (const [key, value] of requested) {
      lines.push(`${key} = ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isSectionHeader(lines[index]!)) {
      end = index;
      break;
    }
  }
  const seen = new Set<string>();
  const kept: string[] = [];
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]!;
    const match = /^\s*([A-Za-z0-9_-]+)\s*=/u.exec(line);
    const key = match?.[1];
    if (key !== undefined && requested.has(key)) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      kept.push(`${key} = ${requested.get(key)}`);
      continue;
    }
    kept.push(line);
  }
  const missing = [...requested].filter(([key]) => !seen.has(key));
  if (missing.length > 0) {
    let insertion = kept.length;
    while (insertion > 0 && kept[insertion - 1]!.trim() === "") {
      insertion -= 1;
    }
    kept.splice(
      insertion,
      0,
      ...missing.map(([key, value]) => `${key} = ${value}`),
    );
  }
  const output = [...lines.slice(0, start + 1), ...kept, ...lines.slice(end)];
  return `${output.join("\n").replace(/\n+$/u, "")}\n`;
}

function upsertModelSection(
  content: string,
  values: { provider: string; id: string; thinking?: ThinkingLevel },
): string {
  const requested = new Map<string, string>([
    ["provider", tomlString(values.provider)],
    ["id", tomlString(values.id)],
  ]);
  if (values.thinking !== undefined) {
    requested.set("thinking", tomlString(values.thinking));
  }
  return upsertSectionValues(content, "model", requested);
}

export async function writeUserModelSelection(
  paths: ProjectPaths,
  provider: string,
  id: string,
  thinking?: ThinkingLevel,
): Promise<string> {
  const filePath = path.join(paths.home, "config.toml");
  let content = "";
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigError(
        `cannot read ${filePath}: ${(error as Error).message}`,
      );
    }
  }
  await atomicWriteFile(
    filePath,
    upsertModelSection(content, {
      provider,
      id,
      ...(thinking === undefined ? {} : { thinking }),
    }),
    0o600,
  );
  return filePath;
}

export async function writeUserThinkingSelection(
  paths: ProjectPaths,
  thinking: ThinkingLevel,
): Promise<string> {
  const levels: readonly ThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  if (!levels.includes(thinking)) {
    throw new ConfigError(
      `thinking must be one of ${levels.join(", ")}`,
      "model.thinking",
    );
  }
  const filePath = path.join(paths.home, "config.toml");
  let content = "";
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigError(
        `cannot read ${filePath}: ${(error as Error).message}`,
      );
    }
  }
  await atomicWriteFile(
    filePath,
    upsertSectionValues(
      content,
      "model",
      new Map([["thinking", tomlString(thinking)]]),
    ),
    0o600,
  );
  return filePath;
}

export interface PermissionConfigUpdate {
  approval?: ApprovalMode;
  reviewer?: ReviewerMode;
  reviewerModel?: string | null;
  reviewerTimeoutMs?: number;
  autonomy?: AutonomyProfile;
  scopedRules?: string;
  sandbox?: SandboxMode;
  filesystem?: FilesystemMode;
  /**
   * Egress hosts the sandbox may reach. An empty array clears the allowlist
   * and restores the deny-by-default network policy.
   */
  networkAllow?: string[];
  /**
   * Egress hosts the sandbox must never reach, even when a wildcard allow
   * entry would match. An empty array clears the deny list.
   */
  networkDeny?: string[];
}

export type PermissionProfile =
  "read-only" | "standard" | "auto" | "auto-approve" | "full-access";

export interface PermissionProfileSettings {
  approval: ApprovalMode;
  autonomy: AutonomyProfile;
  sandbox: SandboxMode;
  filesystem: FilesystemMode;
}

export const APPROVAL_MODE_NAMES = ["ask", "deny", "auto", "allow"] as const;

export const PERMISSION_PROFILE_NAMES = [
  "read-only",
  "standard",
  "auto",
  "auto-approve",
  "full-access",
] as const;

export const PERMISSION_PROFILES: Readonly<
  Record<PermissionProfile, PermissionProfileSettings>
> = {
  "read-only": {
    approval: "ask",
    autonomy: "read-only",
    sandbox: "required",
    filesystem: "workspace",
  },
  standard: {
    approval: "ask",
    autonomy: "ask",
    sandbox: "required",
    filesystem: "workspace",
  },
  auto: {
    approval: "auto",
    autonomy: "ask",
    sandbox: "required",
    filesystem: "workspace",
  },
  // Explicit blanket approval for sandbox-covered asks, with no reviewer.
  // Kept separate from `auto`; MCP still needs a human decision.
  "auto-approve": {
    approval: "allow",
    autonomy: "ask",
    sandbox: "required",
    filesystem: "workspace",
  },
  "full-access": {
    approval: "allow",
    autonomy: "ask",
    sandbox: "uncovered",
    filesystem: "full",
  },
};

const CANONICAL_PROFILE_ORDER: readonly PermissionProfile[] =
  PERMISSION_PROFILE_NAMES;

const APPROVAL_MODES: readonly ApprovalMode[] = APPROVAL_MODE_NAMES;
const AUTONOMY_PROFILES: readonly AutonomyProfile[] = [
  "read-only",
  "ask",
  "scoped",
];
const SANDBOX_MODES: readonly SandboxMode[] = ["required", "uncovered"];

export function isPermissionProfile(value: string): value is PermissionProfile {
  return Object.hasOwn(PERMISSION_PROFILES, value);
}

export function permissionProfileFor(
  config: Pick<
    CodepunkConfig,
    "approval" | "autonomy" | "sandbox" | "filesystem"
  >,
): PermissionProfile | "custom" {
  for (const name of CANONICAL_PROFILE_ORDER) {
    const settings = PERMISSION_PROFILES[name];
    if (
      config.approval.mode === settings.approval &&
      config.autonomy.profile === settings.autonomy &&
      config.sandbox.mode === settings.sandbox &&
      config.filesystem.mode === settings.filesystem
    ) {
      return name;
    }
  }
  return "custom";
}

export function permissionBehaviorSummary(
  config: Pick<
    CodepunkConfig,
    "approval" | "autonomy" | "sandbox" | "filesystem"
  >,
): string {
  const parts: string[] = [];
  if (config.autonomy.profile === "read-only") {
    parts.push(
      "read-only denies file mutations and ask-level actions; safe reads stay available",
    );
  } else if (config.approval.mode === "allow") {
    parts.push(
      "allow approves every non-MCP ask; MCP calls still need a human",
    );
  } else if (config.approval.mode === "auto") {
    parts.push(
      "auto approves routine and ordinary shell classes; destructive, network, dynamic, protected, sensitive, unknown, and MCP asks stay gated",
    );
  } else if (config.approval.mode === "deny") {
    parts.push("deny refuses ask-level actions");
  } else {
    parts.push("ask prompts for ask-level actions");
  }
  if (config.autonomy.profile === "scoped") {
    parts.push(
      "scoped autonomy is an exact-argv allowlist; unmatched actions never fall through to blanket approval",
    );
  }
  if (config.sandbox.mode === "required") {
    parts.push(
      config.sandbox.network_allow.length === 0
        ? "sandbox is required (srt); network egress is deny-by-default"
        : `sandbox is required (srt); network egress allows ${config.sandbox.network_allow.join(", ")}`,
    );
  } else {
    parts.push("sandbox is uncovered (shell follows host permissions)");
  }
  parts.push(
    config.filesystem.mode === "full"
      ? "filesystem is full and needs the dangerous start flag"
      : "filesystem is limited to the workspace",
  );
  return parts.join("; ");
}

export type ApprovalClass = NonNullable<PolicyDecision["approval_class"]>;

/**
 * The effective shell-approval behavior of a decision, given the configured
 * approval mode. `decidePolicy` reports the policy intent; with
 * `approval.mode = "allow"` every sandbox-covered `ask` decision runs without
 * a prompt, with `auto` only routine and shell classes do, and with `deny`
 * every `ask` is refused. Dynamic launchers/interpreters, network, destructive,
 * explicit-policy, protected, sensitive, MCP, and unknown classes still ask in
 * auto mode. `allow` covers every sandbox-covered action, but MCP stays at the
 * human gate because the server and its side effects run outside the shell
 * sandbox. Reporting the raw policy
 * decision alone would misdescribe that.
 */
export function effectiveApprovalDecision(
  decision: "allow" | "ask" | "deny",
  approvalMode: ApprovalMode,
  approvalClass: ApprovalClass = "unknown",
): { decision: "allow" | "ask" | "deny"; requiresApproval: boolean } {
  if (decision !== "ask") {
    return { decision, requiresApproval: false };
  }
  if (approvalMode === "allow" && approvalClass !== "mcp") {
    return { decision: "allow", requiresApproval: false };
  }
  if (
    approvalMode === "auto" &&
    (approvalClass === "routine" || approvalClass === "shell")
  ) {
    return { decision: "allow", requiresApproval: false };
  }
  if (approvalMode === "deny") {
    return { decision: "deny", requiresApproval: false };
  }
  return { decision: "ask", requiresApproval: true };
}

export async function writeUserPermissionProfile(
  paths: ProjectPaths,
  profile: PermissionProfile,
): Promise<string> {
  if (!isPermissionProfile(profile)) {
    throw new ConfigError(
      `permission profile must be one of ${PERMISSION_PROFILE_NAMES.join(", ")}; workspace trust is a separate /trust decision`,
      "permissions.profile",
    );
  }
  return writeUserPermissionSelection(paths, PERMISSION_PROFILES[profile]);
}

export async function writeUserPermissionSelection(
  paths: ProjectPaths,
  update: PermissionConfigUpdate,
): Promise<string> {
  if (
    update.approval !== undefined &&
    !APPROVAL_MODES.includes(update.approval)
  ) {
    throw new ConfigError("invalid approval mode", "approval.mode");
  }
  if (
    update.reviewer !== undefined &&
    update.reviewer !== "off" &&
    update.reviewer !== "model"
  ) {
    throw new ConfigError("invalid approval reviewer", "approval.reviewer");
  }
  if (update.reviewerModel !== undefined && update.reviewerModel !== null) {
    const separator = update.reviewerModel.indexOf("/");
    if (
      separator <= 0 ||
      separator === update.reviewerModel.length - 1 ||
      /\s/u.test(update.reviewerModel)
    ) {
      throw new ConfigError(
        "reviewer model must use provider/model",
        "approval.reviewer_model",
      );
    }
  }
  if (
    update.reviewerTimeoutMs !== undefined &&
    (!Number.isSafeInteger(update.reviewerTimeoutMs) ||
      update.reviewerTimeoutMs < 1_000)
  ) {
    throw new ConfigError(
      "reviewer timeout must be an integer of at least 1000 ms",
      "approval.reviewer_timeout_ms",
    );
  }
  if (
    update.autonomy !== undefined &&
    !AUTONOMY_PROFILES.includes(update.autonomy)
  ) {
    throw new ConfigError("invalid autonomy profile", "autonomy.profile");
  }
  if (
    update.scopedRules !== undefined &&
    (update.autonomy !== "scoped" || !path.isAbsolute(update.scopedRules))
  ) {
    throw new ConfigError(
      "scoped rules require the scoped autonomy profile and an absolute path",
      "autonomy.scoped_rules",
    );
  }
  if (update.sandbox !== undefined && !SANDBOX_MODES.includes(update.sandbox)) {
    throw new ConfigError("invalid sandbox mode", "sandbox.mode");
  }
  if (
    update.filesystem !== undefined &&
    update.filesystem !== "workspace" &&
    update.filesystem !== "full"
  ) {
    throw new ConfigError("invalid filesystem mode", "filesystem.mode");
  }
  const networkAllow =
    update.networkAllow === undefined
      ? undefined
      : normalizeNetworkAllow(update.networkAllow);
  const networkDeny =
    update.networkDeny === undefined
      ? undefined
      : normalizeNetworkDeny(update.networkDeny);
  const filePath = path.join(paths.home, "config.toml");
  let content = "";
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigError(
        `cannot read ${filePath}: ${(error as Error).message}`,
      );
    }
  }
  if (
    update.approval !== undefined ||
    update.reviewer !== undefined ||
    update.reviewerModel !== undefined ||
    update.reviewerTimeoutMs !== undefined
  ) {
    const approval = new Map<string, string>();
    if (update.approval !== undefined) {
      approval.set("mode", tomlString(update.approval));
    }
    if (update.reviewer !== undefined) {
      approval.set("reviewer", tomlString(update.reviewer));
      if (update.reviewer === "off" && update.reviewerModel === undefined) {
        // Leaving a model reference behind would make the next loadConfig
        // reject `reviewer = "off"` as an inconsistent configuration.
        approval.set("reviewer_model", tomlString("null"));
      }
    }
    if (update.reviewerModel !== undefined) {
      approval.set(
        "reviewer_model",
        update.reviewerModel === null
          ? tomlString("null")
          : tomlString(update.reviewerModel),
      );
    }
    if (update.reviewerTimeoutMs !== undefined) {
      approval.set("reviewer_timeout_ms", String(update.reviewerTimeoutMs));
    }
    content = upsertSectionValues(content, "approval", approval);
  }
  if (update.autonomy !== undefined) {
    const autonomy = new Map([["profile", tomlString(update.autonomy)]]);
    if (update.scopedRules !== undefined) {
      autonomy.set("scoped_rules", tomlString(update.scopedRules));
    }
    content = upsertSectionValues(content, "autonomy", autonomy);
  }
  if (update.sandbox !== undefined) {
    content = upsertSectionValues(
      content,
      "sandbox",
      new Map([["mode", tomlString(update.sandbox)]]),
    );
  }
  if (networkAllow !== undefined) {
    content = upsertSectionValues(
      content,
      "sandbox",
      new Map([["network_allow", tomlStringArray(networkAllow)]]),
    );
  }
  if (networkDeny !== undefined) {
    content = upsertSectionValues(
      content,
      "sandbox",
      new Map([["network_deny", tomlStringArray(networkDeny)]]),
    );
  }
  if (update.filesystem !== undefined) {
    content = upsertSectionValues(
      content,
      "filesystem",
      new Map([["mode", tomlString(update.filesystem)]]),
    );
  }
  await atomicWriteFile(filePath, content, 0o600);
  return filePath;
}

export async function writeUserPluginsEnabled(
  paths: ProjectPaths,
  enabled: boolean,
): Promise<string> {
  if (typeof enabled !== "boolean") {
    throw new ConfigError(
      "plugins.enabled must be a boolean",
      "plugins.enabled",
    );
  }
  const filePath = path.join(paths.home, "config.toml");
  let content = "";
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigError(
        `cannot read ${filePath}: ${(error as Error).message}`,
      );
    }
  }
  await atomicWriteFile(
    filePath,
    upsertSectionValues(
      content,
      "plugins",
      new Map([["enabled", enabled ? "true" : "false"]]),
    ),
    0o600,
  );
  return filePath;
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
    `plugins: ${config.plugins.enabled ? "enabled" : "disabled"}`,
    `telemetry: ${config.telemetry.mode}`,
    `retention: sessions ${config.session.retention_days}d/${config.session.retention_count}, evidence ${config.evidence.retention_days}d/${config.evidence.retention_count}`,
  ];
}
