export const APP_NAME = "codepunk" as const;
export const CLI_PACKAGE_NAME = "codepunk-cli" as const;
export const CORE_PACKAGE_NAME = "codepunk-core" as const;
export const PROTOCOL_PACKAGE_NAME = "codepunk-protocol" as const;
export const PROJECT_CONFIG_DIR = ".codepunk" as const;

/**
 * Placeholder version reported when a package manifest cannot be read or a
 * checkout is unpublished. npm refuses to resolve 0.0.0 as a release.
 */
export const UNPUBLISHED_VERSION = "0.0.0" as const;

export const SCHEMA_VERSIONS = {
  protocol: 1,
  evidence: 1,
  sessionEvent: 1,
  agentState: 1,
  verdict: 1,
  daemon: 1,
  acp: 1,
  plugin: 1,
  stateHome: 1,
  checkpointIndex: 1,
  shadowGitIndex: 1,
  mcpAuth: 1,
  backgroundTask: 1,
  resourceTrust: 1,
  modelHistory: 1,
} as const;

export const ENV_VARS = {
  CODEPUNK_HOME: "CODEPUNK_HOME",
  NO_COLOR: "NO_COLOR",
  TERM: "TERM",
  PI_CODING_AGENT_DIR: "PI_CODING_AGENT_DIR",
  PI_CODING_AGENT_SESSION_DIR: "PI_CODING_AGENT_SESSION_DIR",
  WSL_DISTRO_NAME: "WSL_DISTRO_NAME",
  DBUS_SESSION_BUS_ADDRESS: "DBUS_SESSION_BUS_ADDRESS",
  GIT_OPTIONAL_LOCKS: "GIT_OPTIONAL_LOCKS",
  VISUAL: "VISUAL",
  EDITOR: "EDITOR",
} as const;

export const STATE_FILES = {
  CONFIG: "config.toml",
  MODELS: "models.json",
  AUTH: "auth.json",
  MCP_CONFIG: "mcp.toml",
  MCP_AUTH: "mcp-auth.json",
  SCOPED_RULES: "scoped-rules.toml",
  WORKSPACE_TRUST: "workspace-trust.json",
  STATE_VERSION: "state-version.json",
  PLUGIN_MANIFEST: "plugin.toml",
  AGENTS_MD: "AGENTS.md",
} as const;

export const EXIT_CODES = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  SIGINT: 130,
} as const;
