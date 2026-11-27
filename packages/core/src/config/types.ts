import type { AutonomyProfile, PolicyDecision } from "codepunk-protocol";

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

export const STATUSLINE_SEGMENTS = [
  "model",
  "session",
  "sandbox",
  "filesystem",
  "policy",
  "budget",
] as const;
export type StatuslineSegment = (typeof STATUSLINE_SEGMENTS)[number];

export const DEFAULT_STATUSLINE_SEGMENTS: readonly StatuslineSegment[] = [
  "policy",
  "budget",
];

export const KEYMAP_ACTIONS = ["model_cycle", "background"] as const;
export type KeymapAction = (typeof KEYMAP_ACTIONS)[number];
export type KeymapBinding = Record<KeymapAction, string>;

export const KEY_BINDING =
  /^(?:off|f(?:[1-9]|1[0-2])|(?:ctrl|alt)\+[a-z0-9])$/u;
export const THEME_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export const CONFIG_FILE_NAME = "config.toml";

export type DeprecatedConfigKeyAction = "renamed" | "removed";

/**
 * A config key that still loads but is scheduled for removal. `renamed` keys
 * map onto `replacement`; `removed` keys are read, warned about, and ignored.
 * Keeping an entry past `removableIn` is a bug: the key may only disappear
 * together with the entry.
 */
export interface DeprecatedConfigKey {
  key: string;
  action: DeprecatedConfigKeyAction;
  replacement: string | null;
  deprecatedSince: string;
  removableIn: string;
}

/**
 * Empty until the first key is renamed or dropped. Every entry must name both
 * the release that started warning and the earliest release that may delete
 * it, so an old config keeps starting instead of failing on an unknown key.
 */
export const DEPRECATED_CONFIG_KEYS: DeprecatedConfigKey[] = [];

export interface CodepunkConfig {
  tui: {
    mode: "fullscreen" | "regular";
    theme: string;
    statusline: StatuslineSegment[];
    keymap: KeymapBinding;
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
    user_bash: "sandboxed" | "uncovered";
    network_allow: string[];
    network_deny: string[];
    network_max_requests: number | null;
    network_max_bytes: number | null;
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
    max_tool_calls: number;
    max_wall_ms: number;
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
  /** Per-process egress allowlist, used by guarded child hosts. */
  networkAllow?: readonly string[] | null;
  /** Per-process egress deny list, used by guarded child hosts. */
  networkDeny?: readonly string[] | null;
  memory?: boolean | null;
}

export interface LoadedConfig {
  config: CodepunkConfig;
  userPath: string;
  projectPath: string;
  localPath: string;
  warnings: string[];
}

export interface TuiPreferencesUpdate {
  theme?: string;
  hideThinking?: boolean;
  header?: boolean;
  status?: boolean;
  widgets?: boolean;
  compaction?: CompactionMode;
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

export type ApprovalClass = NonNullable<PolicyDecision["approval_class"]>;

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

export type KeyType =
  | "string"
  | "string-null"
  | "boolean"
  | "number"
  | "integer"
  | "integer-or-null"
  | "boolean-or-header"
  | "string-array";

export interface KeySpec {
  type: KeyType;
  allowed?: readonly string[];
  scope?: "user" | "any";
  minimum?: number;
}

export const TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "shell",
  "search",
  "memory_search",
  "exec",
  "web_fetch",
  "web_search",
  "ask_user",
  "subagent",
  "plan",
  "todo",
] as const;

export const KEY_SPECS = new Map<string, KeySpec>([
  [
    "tui.mode",
    { type: "string", allowed: ["fullscreen", "regular"], scope: "any" },
  ],
  ["tui.theme", { type: "string", scope: "any" }],
  ["tui.statusline", { type: "string-array", scope: "any" }],
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
  [
    "sandbox.user_bash",
    { type: "string", allowed: ["sandboxed", "uncovered"], scope: "user" },
  ],
  ["sandbox.network_allow", { type: "string-array", scope: "user" }],
  ["sandbox.network_deny", { type: "string-array", scope: "user" }],
  [
    "sandbox.network_max_requests",
    { type: "integer-or-null", minimum: 0, scope: "user" },
  ],
  [
    "sandbox.network_max_bytes",
    { type: "integer-or-null", minimum: 0, scope: "user" },
  ],
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
  ["budget.max_tool_calls", { type: "integer", minimum: 1, scope: "user" }],
  ["budget.max_wall_ms", { type: "integer", minimum: 1, scope: "user" }],
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

export function defaultConfig(): CodepunkConfig {
  return {
    tui: {
      mode: "fullscreen",
      theme: "codepunk",
      statusline: [...DEFAULT_STATUSLINE_SEGMENTS],
      keymap: { model_cycle: "f2", background: "off" },
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
        "web_fetch",
        "web_search",
        "ask_user",
        "subagent",
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
      user_bash: "sandboxed",
      network_allow: [],
      network_deny: [],
      network_max_requests: null,
      network_max_bytes: null,
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
      max_tool_calls: 200,
      max_wall_ms: 30 * 60 * 1_000,
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
