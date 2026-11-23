#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { enableCompileCache } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

// Cache compiled bytecode across runs; session startup loads hundreds of
// dependency modules, and recompiling them on every launch dominates it.
try {
  enableCompileCache();
} catch {
  // Best effort only; startup must not fail because the cache is unusable.
}
import { DAEMON_SCOPES, type DaemonScope } from "codepunk-protocol";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  AutonomyController,
  APPROVAL_MODE_NAMES,
  ConfigError,
  PERMISSION_PROFILE_NAMES,
  PERMISSION_PROFILES,
  DaemonClient,
  DaemonClientError,
  DaemonServer,
  AcpServer,
  RuntimeControlBackend,
  allWorkspaceTrustGrants,
  appendRetentionOperation,
  applyGc,
  applyMigration,
  applyWorkspaceTrustGrantChanges,
  MemoryManager,
  collectCapabilities,
  configFilePaths,
  configSummary,
  checkMigration,
  createBackup,
  createRuntime,
  daemonSocketPath,
  decidePolicy,
  ensureProjectConfigDir,
  ensureProjectRegistration,
  explainPermission,
  exportSession,
  exportMemoryRecords,
  filesystemFullStartupIssue,
  findDeliveryRoot,
  forkSession,
  formatWorkspaceTrustResourcePreview,
  formatWorkspaceTrust,
  formatCapabilities,
  formatMcpServers,
  formatModelCatalog,
  formatDoctor,
  formatPermissionExplanation,
  formatSessionGraph,
  formatSessionList,
  formatSessionSearch,
  formatSessionTree,
  importProviderModels,
  importSession,
  inspectSavedWorkspaceTrust,
  initializeStateVersion,
  installSkill,
  installPackage,
  installUserPlugin,
  isPermissionProfile,
  isThinkingLevel,
  listUserPluginFiles,
  listBackups,
  listModelCatalog,
  listProjectSessions,
  loadConfig,
  loadMcpTools,
  mcpUsesAuthorizationHeader,
  loginMcpServer,
  McpAuthStore,
  oauthSettings,
  loadPolicyFiles,
  loadScopedRules,
  loadSkills,
  normalizeNetworkAllow,
  normalizeNetworkDeny,
  openModelRuntime,
  permissionBehaviorSummary,
  permissionProfileFor,
  pinSession,
  planRetention,
  previewWorkspaceTrustResources,
  probeConfiguredModel,
  projectPaths,
  probeSrtSandbox,
  restoreBackup,
  renameSession,
  archiveSession,
  deleteSession,
  createSessionBundle,
  removeMcpServer,
  readMcpConfig,
  readSavedWorkspaceTrustGrants,
  removeModelsProvider,
  removeSkill,
  removeUserPlugin,
  resolveCodepunkHome,
  resolveAdditionalWorkspaceRoots,
  resolveModelSelection,
  resolveWorkspaceTrust,
  saveWorkspaceTrustGrants,
  SessionStore,
  resolveSession,
  readSessionGraph,
  readSessionTree,
  searchAllProjectSessions,
  searchProjectSessions,
  runDoctor,
  setConfiguredModel,
  signStandalone,
  shellUnavailableReason,
  SrtSandbox,
  testConfiguredModel,
  uninstallPackage,
  upgradePackage,
  verifyGuardedHostLaunch,
  writeMcpServer,
  writeUserPermissionProfile,
  writeUserPermissionSelection,
  writeUserPluginsEnabled,
  type CodepunkConfig,
  type CodepunkRuntime,
  type ConfigOverrides,
  type FilesystemMode,
  type PermissionConfigUpdate,
  type PermissionExecution,
  type PermissionProfile,
  type ScopedRule,
  type SkillBundle,
  type WorkspaceTrust,
  type WorkspaceTrustGrants,
  type WorkspaceTrustResourceKind,
  type WorkspaceTrustSource,
  WORKSPACE_TRUST_RESOURCE_KINDS,
  workspaceTrustGrantsFromKinds,
  workspaceTrustMode,
} from "codepunk-core";
import type {
  DaemonSessionListResult,
  DaemonSessionReadResult,
} from "codepunk-protocol";
import type {
  TuiRuntimeReplacement,
  TuiSessionTarget,
  TuiState,
} from "./tui.ts";
import { CodepunkTerminal } from "./branded-terminal.ts";
import {
  COMPLETION_SHELLS,
  completionScript,
  isCompletionShell,
} from "./completion.ts";
import {
  appendBuildDoctorCheck,
  formatBuildIdentity,
  formatBuildLabel,
  inspectCliBuild,
  readCliVersion,
  UNPUBLISHED_VERSION,
} from "./build-info.ts";

interface CliOptions {
  print: boolean;
  mode: "text" | "json";
  continueSession: boolean;
  session: string | undefined;
  fork: string | undefined;
  newSessionId: string | undefined;
  parentSessionId: string | undefined;
  newSession: boolean;
  model: string | undefined;
  provider: string | undefined;
  thinking: string | undefined;
  tools: string[] | undefined;
  modelFallback: string[] | undefined;
  fallbackAllowCrossProvider: boolean;
  appendSystemPrompt: string | undefined;
  permissionMode: PermissionProfile | undefined;
  approval: "ask" | "deny" | "auto" | "allow" | undefined;
  reviewer: "off" | "model" | undefined;
  reviewerModel: string | undefined;
  reviewerTimeoutMs: number | undefined;
  autonomy: "read-only" | "ask" | "scoped" | undefined;
  scopedRules: string | undefined;
  allowUnsandboxedShell: boolean;
  dangerouslyBypass: boolean;
  sandbox: "required" | "uncovered" | undefined;
  filesystem: FilesystemMode | undefined;
  networkAllow: string[] | undefined;
  networkDeny: string[] | undefined;
  trust: "trusted" | "untrusted" | undefined;
  trustResources: WorkspaceTrustResourceKind[] | undefined;
  resources: WorkspaceTrustResourceKind[] | undefined;
  memory: boolean | undefined;
  allowPlugins: boolean;
  noMcp: boolean;
  noSkills: boolean;
  noPlugins: boolean;
  bare: boolean;
  headlessPolicy: string | undefined;
  apply: boolean;
  check: boolean;
  unpin: boolean;
  allProjects: boolean;
  includeArchived: boolean;
  confirm: boolean;
  verdict: "complete" | "incomplete" | undefined;
  actor: string | undefined;
  output: string | undefined;
  scope: "user" | "project" | undefined;
  prefix: string | undefined;
  packageVersion: string | undefined;
  baseUrl: string | undefined;
  api: string | undefined;
  apiKey: string | undefined;
  authHeader: boolean;
  dryRun: boolean;
  json: boolean;
  socket: string | undefined;
  scopes: DaemonScope[] | undefined;
  limit: number | undefined;
  env: string[];
  url: string | undefined;
  headers: string[];
  cwd: string | undefined;
  additionalDirs: string[];
  force: boolean;
  guardedHostLaunch: boolean;
  help: boolean;
  version: boolean;
  positionals: string[];
}

function usage(): string {
  return [
    "codepunk [options] [prompt]",
    "",
    "Surfaces:",
    "  codepunk                 interactive TUI when stdin is a TTY",
    "  codepunk -p <prompt>     print mode; read-only by default",
    "  codepunk --mode json -p  JSON event stream",
    "  --new-session-id <id>  create a new session with an explicit id",
    "  --parent-session-id <id>  record the parent of a new child session",
    "",
    "Session commands:",
    "  codepunk sessions [--include-archived]",
    "  codepunk sessions [prune] [--apply]",
    "      sessions prune is dry-run only; --apply is refused, use codepunk gc --apply",
    "  codepunk sessions tree [session-id] [--json]",
    "  codepunk sessions graph [--json]",
    "  codepunk sessions search <query> [--limit n] [--all-projects] [--json]",
    "  codepunk sessions rename <session-id> <title>",
    "  codepunk sessions archive|unarchive <session-id>",
    "  codepunk sessions delete <session-id> --confirm",
    "  codepunk sessions export <session-id> [--output path]",
    "  codepunk sessions import <bundle.json>",
    "  codepunk export [session-id] [--output path]",
    "  codepunk pin <session-id>",
    "  codepunk pin <session-id> --unpin",
    "  codepunk sign <run-id> --verdict complete|incomplete",
    "  codepunk daemon [--socket path] [--scopes daemon:read,...]",
    "  codepunk view [session-id] [--json] [--socket path]",
    "  codepunk acp",
    "",
    "Retention commands:",
    "  codepunk gc [--dry-run|--apply]",
    "      dry-run lists artifact candidates; apply backs up before deleting",
    "  codepunk migrate [--check|--apply]",
    "      check reports the state version; apply backs up before migrating",
    "  codepunk backup create|list|restore <id>",
    "      create snapshots projects, config, and state version without credentials",
    "",
    "Memory commands:",
    "  codepunk memory list [--scope user|project]",
    "  codepunk memory search <query> [--scope user|project]",
    "  codepunk memory add <text> [--scope user|project]",
    "  codepunk memory edit <id> <text> [--scope user|project]",
    "  codepunk memory delete <id> [--scope user|project]",
    "  codepunk memory archive <id> [--scope user|project]",
    "  codepunk memory export [--scope user|project] [--output path]",
    "",
    "Model commands:",
    "  codepunk models [list]",
    "  codepunk models test [provider/id]",
    "  codepunk models set <provider/id> [--thinking <level>]",
    "  codepunk models remove <provider>",
    "  codepunk models import <base-url> --provider <id>",
    "      [--api openai-responses|openai-completions] [--api-key <key>]",
    "      [--auth-header] [--model <ids>]",
    "",
    "Permission commands:",
    "  codepunk permissions",
    `  codepunk permissions profile ${PERMISSION_PROFILE_NAMES.join("|")}`,
    `  codepunk permissions approval ${APPROVAL_MODE_NAMES.join("|")}`,
    "  codepunk permissions reviewer show|off|model [provider/model]|timeout <ms>",
    "  codepunk permissions autonomy read-only|ask|scoped",
    "  codepunk permissions sandbox required|uncovered",
    "  codepunk permissions sandbox network [allow|deny <domain>...|clear]",
    "  codepunk permissions filesystem workspace|full",
    "  codepunk permissions rules [--json]",
    "  codepunk permissions why -- <shell command>",
    "  codepunk trust [status|grant|revoke] [path] [--resources config,policy,skills,instructions] [--json]",
    "",
    "Capability commands:",
    "  codepunk capabilities [--json]",
    "      list user MCP servers, skills, and opt-in plugins",
    "  codepunk mcp [list] [--json]",
    "  codepunk mcp add <name> [--cwd <dir>] [--env KEY=VALUE] [--force]",
    "      -- <command> [args...]",
    "  codepunk mcp add <name> --url <url> [--header 'Name: value'] [--force]",
    "  codepunk mcp remove <name>",
    "  codepunk mcp test [name]",
    "  codepunk mcp login [name]",
    "  codepunk mcp logout <name>",
    "  codepunk mcp status [name] [--json]",
    "      connect, list tools, and exit non-zero on failure",
    "  codepunk skills [list] [--json]",
    "  codepunk skills add <dir> [--scope user|project] [--force]",
    "  codepunk skills remove <name> [--scope user|project]",
    "  codepunk plugins [list] [--json]",
    "  codepunk plugins enable|disable",
    "  codepunk plugins add <file> [--force]",
    "  codepunk plugins remove <file>",
    "",
    "Configuration:",
    "  codepunk config [show] [--json] [--trust|--no-trust]",
    "  codepunk config path [--json]",
    "",
    "Operations:",
    "  codepunk doctor",
    "  codepunk completion <bash|zsh|fish>",
    "  codepunk install|upgrade|uninstall",
    "  codepunk install [--prefix <dir>] [--package-version <v>] [--dry-run]",
    "",
    "Options:",
    "  -p, --print              single-shot print mode",
    "      --mode text|json     print output mode",
    "      --continue           resume the latest project session",
    "      --session <id>       resume a session by id",
    "      --fork <id>          clone a session into a new child session",
    "      --new-session        force a new session",
    "      --model <provider/id>",
    "      --provider <id>",
    "      --thinking <level>",
    "      --tools <read,search,write,edit,shell>",
    "      --model-fallback <provider/id,...>",
    "      --fallback-allow-cross-provider",
    `      --permission-mode ${PERMISSION_PROFILE_NAMES.join("|")}`,
    `      --approval ${APPROVAL_MODE_NAMES.join("|")}`,
    "      --approval-reviewer off|model   model review for auto-mode asks",
    "      --reviewer-model <provider/id>  default: the session model",
    "      --reviewer-timeout-ms <ms>      default: 20000",
    "      --autonomy read-only|ask|scoped",
    "      --scoped-rules <path>   exact argv allowlist for scoped autonomy",
    "      --sandbox required|uncovered",
    "      --filesystem workspace|full   full requires the dangerous flag",
    "      --network-allow <domains>     per-process egress allowlist for child hosts",
    "      --network-deny <domains>      per-process egress deny list for child hosts",
    "      --add-dir <dir>      extra file root; never loads its project config",
    "      --allow-unsandboxed-shell  interactive only; requires --sandbox uncovered",
    "      --dangerously-bypass-approvals-and-sandbox",
    "                           approval=allow, sandbox=uncovered, filesystem=full",
    "      --trust / --no-trust one-run workspace trust decision",
    "      --trust-resources <kinds>  load only config,policy,skills,instructions for this run",
    "      --memory <true|false>",
    "      --allow-plugins",
    "      --bare               disable instructions, skills, plugins, MCP, memory for this session",
    "      --no-skills          do not load skills for this session",
    "      --no-plugins         do not load user plugins for this session",
    "      --no-mcp             do not start user MCP servers in this session",
    "      --headless-policy <path>",
    "      --verdict complete|incomplete",
    "      --actor <name>       sign-off label (default: local-user)",
    "      --prefix <dir>       npm global prefix for package commands",
    "      --package-version <v>",
    "      --base-url <url>     model endpoint for models import",
    "      --api <name>         provider API for models import",
    "      --api-key <value>    literal, $ENV, or !command key",
    "      --auth-header        send the key as Authorization: Bearer",
    "      --dry-run            print the package command without running it",
    "      --json               emit machine-readable command output",
    "      --limit <n>          search result limit (1-100, default 20)",
    "      --all-projects       search every project under CODEPUNK_HOME",
    "      --socket <path>      daemon socket under CODEPUNK_HOME",
    "      --scopes <list>      daemon scopes, comma separated",
    "  -h, --help",
    "  -v, --version",
  ].join("\n");
}

function subcommandUsage(command: string | undefined): string | undefined {
  const lines = (() => {
    switch (command) {
      case "sessions":
      case "prune":
        return [
          "usage:",
          "  codepunk sessions [--include-archived]",
          "  codepunk sessions prune [--apply]",
          "      prune is dry-run only; --apply is refused, use codepunk gc --apply",
          "  codepunk sessions tree [session-id] [--json]",
          "  codepunk sessions graph [--json]",
          "  codepunk sessions search <query> [--limit n] [--all-projects] [--json]",
          "  codepunk sessions rename <session-id> <title>",
          "  codepunk sessions archive|unarchive <session-id>",
          "  codepunk sessions delete <session-id> --confirm",
          "  codepunk sessions export <session-id> [--output path]",
          "  codepunk sessions import <bundle.json>",
          "  codepunk export [session-id] [--output path]",
          "  codepunk pin <session-id>",
          "  codepunk pin <session-id> --unpin",
          "  codepunk sign <run-id> --verdict complete|incomplete",
          "  codepunk daemon [--socket path]",
          "  codepunk view [session-id] [--json] [--socket path]",
        ];
      case "gc":
        return [
          "usage:",
          "  codepunk gc [--dry-run|--apply]",
          "      dry-run is the default; --apply backs up candidates before deleting",
          "      only artifacts are deleted; sessions, evidence, verdicts, and checkpoints stay",
        ];
      case "migrate":
        return [
          "usage:",
          "  codepunk migrate [--check|--apply]",
          "      --check is the default and exits 1 when a migration is required",
          "      --apply backs up state-version.json and restores it on failure",
        ];
      case "backup":
        return [
          "usage:",
          "  codepunk backup create",
          "  codepunk backup list [--json]",
          "  codepunk backup restore <id>",
          "      backups include projects, config.toml, and state-version.json",
          "      auth.json and models.json are never included",
        ];
      case "export":
        return ["usage:", "  codepunk export [session-id] [--output path]"];
      case "pin":
        return ["usage:", "  codepunk pin <session-id> [--unpin]"];
      case "sign":
        return [
          "usage:",
          "  codepunk sign <run-id> --verdict complete|incomplete [--actor <name>]",
        ];
      case "daemon":
        return [
          "usage:",
          "  codepunk daemon [--socket path] [--scopes daemon:read,...]",
          `      default: daemon:read,sessions:read,sessions:write`,
          `      available: ${DAEMON_SCOPES.join(",")}`,
        ];
      case "acp":
        return ["usage:", "  codepunk acp"];
      case "view":
        return [
          "usage:",
          "  codepunk view [session-id] [--json] [--socket path]",
        ];
      case "completion":
        return [
          "usage:",
          `  codepunk completion ${COMPLETION_SHELLS.join("|")}`,
        ];
      case "memory":
        return [
          "usage:",
          "  codepunk memory list [--scope user|project]",
          "  codepunk memory search <query> [--scope user|project]",
          "  codepunk memory add <text> [--scope user|project]",
          "  codepunk memory edit <id> <text> [--scope user|project]",
          "  codepunk memory delete <id> [--scope user|project]",
          "  codepunk memory archive <id> [--scope user|project]",
          "  codepunk memory export [--scope user|project] [--output path]",
        ];
      case "models":
        return [
          "usage:",
          "  codepunk models [list]",
          "  codepunk models test [provider/id]",
          "  codepunk models set <provider/id> [--thinking <level>]",
          "  codepunk models remove <provider>",
          "  codepunk models import <base-url> --provider <id>",
          "      [--api openai-responses|openai-completions] [--api-key <key>]",
          "      [--auth-header] [--model <ids>]",
        ];
      case "permissions":
      case "permission":
        return [
          "usage:",
          "  codepunk permissions",
          `  codepunk permissions profile ${PERMISSION_PROFILE_NAMES.join("|")}`,
          `  codepunk permissions approval ${APPROVAL_MODE_NAMES.join("|")}`,
          "  codepunk permissions reviewer show|off|model [provider/model]|timeout <ms>",
          "  codepunk permissions autonomy read-only|ask|scoped",
          "  codepunk permissions sandbox required|uncovered",
          "  codepunk permissions sandbox network [allow|deny <domain>...|clear]",
          "  codepunk permissions filesystem workspace|full",
          "  codepunk permissions rules [--json]",
          "  codepunk permissions why -- <shell command>",
        ];
      case "trust":
        return [
          "usage:",
          "  codepunk trust [status|grant|revoke] [path] [--resources config,policy,skills,instructions] [--json]",
          "  status is the default; grant and revoke save a decision for future sessions",
        ];
      case "capabilities":
        return [
          "usage:",
          "  codepunk capabilities [--json]",
          "      list user MCP servers, skills, and opt-in plugins",
        ];
      case "mcp":
        return [
          "usage:",
          "  codepunk mcp [list] [--json]",
          "  codepunk mcp add <name> [--cwd <dir>] [--env KEY=VALUE] [--force]",
          "      -- <command> [args...]",
          "  codepunk mcp add <name> --url <url> [--header 'Name: value'] [--force]",
          "  codepunk mcp remove <name>",
          "  codepunk mcp test [name]",
          "  codepunk mcp login [name]",
          "  codepunk mcp logout <name>",
          "  codepunk mcp status [name] [--json]",
        ];
      case "skills":
        return [
          "usage:",
          "  codepunk skills [list] [--json]",
          "  codepunk skills add <dir> [--scope user|project] [--force]",
          "  codepunk skills remove <name> [--scope user|project]",
        ];
      case "plugins":
        return [
          "usage:",
          "  codepunk plugins [list] [--json]",
          "  codepunk plugins enable|disable",
          "  codepunk plugins add <file> [--force]",
          "  codepunk plugins remove <file>",
        ];
      case "config":
        return [
          "usage:",
          "  codepunk config [show] [--json] [--trust|--no-trust]",
          "  codepunk config path [--json]",
        ];
      case "doctor":
        return ["usage:", "  codepunk doctor"];
      case "install":
      case "upgrade":
      case "uninstall":
        return [
          "usage:",
          "  codepunk install [--prefix <dir>] [--package-version <v>] [--dry-run]",
          "  codepunk upgrade [--prefix <dir>] [--dry-run]",
          "  codepunk uninstall [--prefix <dir>] [--dry-run]",
        ];
      default:
        return undefined;
    }
  })();
  return lines === undefined ? undefined : `${lines.join("\n")}\n`;
}

function parseCli(argv: string[]): CliOptions {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      print: { type: "boolean", short: "p" },
      mode: { type: "string" },
      continue: { type: "boolean" },
      session: { type: "string" },
      fork: { type: "string" },
      "new-session-id": { type: "string" },
      "parent-session-id": { type: "string" },
      "new-session": { type: "boolean" },
      model: { type: "string" },
      provider: { type: "string" },
      thinking: { type: "string" },
      tools: { type: "string" },
      "model-fallback": { type: "string" },
      "fallback-allow-cross-provider": { type: "boolean" },
      "append-system-prompt": { type: "string" },
      "permission-mode": { type: "string" },
      approval: { type: "string" },
      "approval-reviewer": { type: "string" },
      "reviewer-model": { type: "string" },
      "reviewer-timeout-ms": { type: "string" },
      autonomy: { type: "string" },
      "scoped-rules": { type: "string" },
      "allow-unsandboxed-shell": { type: "boolean" },
      "dangerously-bypass-approvals-and-sandbox": { type: "boolean" },
      sandbox: { type: "string" },
      filesystem: { type: "string" },
      "network-allow": { type: "string" },
      "network-deny": { type: "string" },
      trust: { type: "boolean" },
      "no-trust": { type: "boolean" },
      "trust-resources": { type: "string" },
      resources: { type: "string" },
      memory: { type: "string" },
      "allow-plugins": { type: "boolean" },
      bare: { type: "boolean" },
      "no-skills": { type: "boolean" },
      "no-plugins": { type: "boolean" },
      "no-mcp": { type: "boolean" },
      "headless-policy": { type: "string" },
      apply: { type: "boolean" },
      check: { type: "boolean" },
      unpin: { type: "boolean" },
      "all-projects": { type: "boolean" },
      "include-archived": { type: "boolean" },
      confirm: { type: "boolean" },
      verdict: { type: "string" },
      actor: { type: "string" },
      output: { type: "string" },
      scope: { type: "string" },
      prefix: { type: "string" },
      "package-version": { type: "string" },
      "base-url": { type: "string" },
      api: { type: "string" },
      "api-key": { type: "string" },
      "auth-header": { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      socket: { type: "string" },
      scopes: { type: "string" },
      limit: { type: "string" },
      env: { type: "string", multiple: true },
      url: { type: "string" },
      header: { type: "string", multiple: true },
      cwd: { type: "string" },
      "add-dir": { type: "string", multiple: true },
      force: { type: "boolean" },
      "guarded-host-launch": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const values = parsed.values;
  const mode = values.mode ?? "text";
  if (mode !== "text" && mode !== "json") {
    throw new Error("--mode must be text or json");
  }
  const approval = values.approval as
    (typeof APPROVAL_MODE_NAMES)[number] | undefined;
  if (
    approval !== undefined &&
    !(APPROVAL_MODE_NAMES as readonly string[]).includes(approval)
  ) {
    throw new Error(`--approval must be ${APPROVAL_MODE_NAMES.join(", ")}`);
  }
  const reviewer = values["approval-reviewer"];
  if (reviewer !== undefined && reviewer !== "off" && reviewer !== "model") {
    throw new Error("--approval-reviewer must be off or model");
  }
  const reviewerModel = values["reviewer-model"];
  if (
    reviewerModel !== undefined &&
    (!reviewerModel.includes("/") || /\s/u.test(reviewerModel))
  ) {
    throw new Error("--reviewer-model must use provider/model");
  }
  const reviewerTimeoutMs =
    values["reviewer-timeout-ms"] === undefined
      ? undefined
      : Number(values["reviewer-timeout-ms"]);
  if (
    reviewerTimeoutMs !== undefined &&
    (!Number.isSafeInteger(reviewerTimeoutMs) || reviewerTimeoutMs < 1_000)
  ) {
    throw new Error(
      "--reviewer-timeout-ms must be an integer of at least 1000",
    );
  }
  const sandbox = values.sandbox;
  const filesystem = values.filesystem;
  if (
    filesystem !== undefined &&
    filesystem !== "workspace" &&
    filesystem !== "full"
  ) {
    throw new Error("--filesystem must be workspace or full");
  }
  const domainList = (
    value: string | undefined,
    flag: string,
  ): string[] | undefined => {
    if (value === undefined) {
      return undefined;
    }
    const entries = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (value.trim().length > 0 && entries.length === 0) {
      throw new Error(`${flag} needs at least one domain`);
    }
    return entries;
  };
  const networkAllow = domainList(values["network-allow"], "--network-allow");
  const networkDeny = domainList(values["network-deny"], "--network-deny");
  const autonomy = values.autonomy;
  if (
    autonomy !== undefined &&
    autonomy !== "read-only" &&
    autonomy !== "ask" &&
    autonomy !== "scoped"
  ) {
    throw new Error("--autonomy must be read-only, ask, or scoped");
  }
  if (values["scoped-rules"] !== undefined && autonomy !== "scoped") {
    throw new Error("--scoped-rules requires --autonomy scoped");
  }
  if (autonomy === "scoped" && values["scoped-rules"] === undefined) {
    throw new Error("--autonomy scoped requires --scoped-rules <path>");
  }
  if (
    values.fork !== undefined &&
    (values.session !== undefined ||
      values.continue === true ||
      values["new-session"] === true ||
      values["new-session-id"] !== undefined)
  ) {
    throw new Error(
      "--fork cannot be combined with --session, --continue, --new-session, or --new-session-id",
    );
  }
  if (
    values["parent-session-id"] !== undefined &&
    values["new-session"] !== true &&
    values["new-session-id"] === undefined
  ) {
    throw new Error(
      "--parent-session-id requires --new-session or --new-session-id",
    );
  }
  if (
    values["parent-session-id"] !== undefined &&
    (values.session !== undefined ||
      values.continue === true ||
      values.fork !== undefined)
  ) {
    throw new Error(
      "--parent-session-id cannot be combined with --session, --continue, or --fork",
    );
  }
  if (
    sandbox !== undefined &&
    sandbox !== "required" &&
    sandbox !== "uncovered"
  ) {
    throw new Error("--sandbox must be required or uncovered");
  }
  const permissionModeValue = values["permission-mode"];
  if (
    permissionModeValue !== undefined &&
    !isPermissionProfile(permissionModeValue)
  ) {
    throw new Error(
      `--permission-mode must be ${PERMISSION_PROFILE_NAMES.join(", ")}`,
    );
  }
  const permissionMode = permissionModeValue as PermissionProfile | undefined;
  if (
    permissionMode !== undefined &&
    (approval !== undefined ||
      autonomy !== undefined ||
      sandbox !== undefined ||
      filesystem !== undefined ||
      values["scoped-rules"] !== undefined)
  ) {
    throw new Error(
      "--permission-mode cannot be combined with --approval, --autonomy, --sandbox, --filesystem, or --scoped-rules",
    );
  }
  const dangerouslyBypass =
    values["dangerously-bypass-approvals-and-sandbox"] === true;
  if (
    dangerouslyBypass &&
    permissionMode !== undefined &&
    permissionMode !== "full-access"
  ) {
    throw new Error(
      "--dangerously-bypass-approvals-and-sandbox can only be combined with --permission-mode full-access",
    );
  }
  if (dangerouslyBypass && autonomy !== undefined && autonomy !== "ask") {
    throw new Error(
      "--dangerously-bypass-approvals-and-sandbox implies full-access autonomy=ask; do not combine it with --autonomy read-only or --autonomy scoped",
    );
  }
  if (dangerouslyBypass) {
    if (filesystem !== undefined && filesystem !== "full") {
      throw new Error(
        "--dangerously-bypass-approvals-and-sandbox implies --filesystem full",
      );
    }
    if (sandbox !== undefined && sandbox !== "uncovered") {
      throw new Error(
        "--dangerously-bypass-approvals-and-sandbox implies --sandbox uncovered",
      );
    }
    if (approval !== undefined && approval !== "allow") {
      throw new Error(
        "--dangerously-bypass-approvals-and-sandbox implies --approval allow",
      );
    }
  }
  const permissionIntrospection =
    (parsed.positionals[0] === "permissions" ||
      parsed.positionals[0] === "permission") &&
    (parsed.positionals[1] === undefined ||
      parsed.positionals[1] === "show" ||
      parsed.positionals[1] === "why");
  if (
    permissionMode === "full-access" &&
    !dangerouslyBypass &&
    !permissionIntrospection
  ) {
    throw new Error(
      "--permission-mode full-access requires --dangerously-bypass-approvals-and-sandbox and is interactive only",
    );
  }
  if (values.trust === true && values["no-trust"] === true) {
    throw new Error("--trust and --no-trust are mutually exclusive");
  }
  if (
    values["trust-resources"] !== undefined &&
    (values.trust === true || values["no-trust"] === true)
  ) {
    throw new Error(
      "--trust-resources cannot be combined with --trust or --no-trust",
    );
  }
  const tools =
    values.tools === undefined
      ? undefined
      : values.tools
          .split(",")
          .map((tool) => tool.trim())
          .filter((tool) => tool.length > 0);
  if (tools !== undefined && tools.length === 0) {
    throw new Error("--tools must contain at least one tool name");
  }
  const modelFallback =
    values["model-fallback"] === undefined
      ? undefined
      : values["model-fallback"]
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
  if (modelFallback !== undefined && modelFallback.length === 0) {
    throw new Error(
      "--model-fallback must contain at least one provider/model",
    );
  }
  const trust =
    values.trust === true
      ? ("trusted" as const)
      : values["no-trust"] === true
        ? ("untrusted" as const)
        : undefined;
  const trustResources =
    values["trust-resources"] === undefined
      ? undefined
      : [
          ...new Set(
            values["trust-resources"]
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
          ),
        ];
  if (trustResources !== undefined) {
    if (trustResources.length === 0) {
      throw new Error("--trust-resources must contain at least one kind");
    }
    for (const kind of trustResources) {
      if (
        !(WORKSPACE_TRUST_RESOURCE_KINDS as readonly string[]).includes(kind)
      ) {
        throw new Error(
          `--trust-resources has unknown kind ${kind}; use ${WORKSPACE_TRUST_RESOURCE_KINDS.join(
            ",",
          )}`,
        );
      }
    }
  }
  const resources =
    values.resources === undefined
      ? undefined
      : [
          ...new Set(
            values.resources
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
          ),
        ];
  if (resources !== undefined) {
    if (resources.length === 0) {
      throw new Error("--resources must contain at least one kind");
    }
    for (const kind of resources) {
      if (
        !(WORKSPACE_TRUST_RESOURCE_KINDS as readonly string[]).includes(kind)
      ) {
        throw new Error(
          `--resources has unknown kind ${kind}; use ${WORKSPACE_TRUST_RESOURCE_KINDS.join(
            ",",
          )}`,
        );
      }
    }
  }
  let memory: boolean | undefined;
  if (values.memory !== undefined) {
    if (values.memory !== "true" && values.memory !== "false") {
      throw new Error("--memory must be true or false");
    }
    memory = values.memory === "true";
  }
  const bare = values.bare === true;
  const noSkills = bare || values["no-skills"] === true;
  const noPlugins = bare || values["no-plugins"] === true;
  if (bare && memory === true) {
    throw new Error("--bare cannot be combined with --memory true");
  }
  if ((bare || noPlugins) && values["allow-plugins"] === true) {
    throw new Error(
      "--allow-plugins cannot be combined with --bare or --no-plugins",
    );
  }
  const scope = values.scope;
  if (scope !== undefined && scope !== "user" && scope !== "project") {
    throw new Error("--scope must be user or project");
  }
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
  ) {
    throw new Error("--limit must be an integer from 1 to 100");
  }
  const scopes =
    values.scopes === undefined
      ? undefined
      : [
          ...new Set(
            values.scopes
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
          ),
        ];
  if (scopes !== undefined) {
    if (scopes.length === 0) {
      throw new Error("--scopes must contain at least one daemon scope");
    }
    for (const scope of scopes) {
      if (!(DAEMON_SCOPES as readonly string[]).includes(scope)) {
        throw new Error(
          `--scopes has unknown scope ${scope}; use ${DAEMON_SCOPES.join(",")}`,
        );
      }
    }
  }
  const verdict = values.verdict;
  if (
    verdict !== undefined &&
    verdict !== "complete" &&
    verdict !== "incomplete"
  ) {
    throw new Error("--verdict must be complete or incomplete");
  }
  return {
    print: values.print === true,
    mode,
    continueSession: values.continue === true,
    session: values.session,
    fork: values.fork,
    newSessionId: values["new-session-id"],
    parentSessionId: values["parent-session-id"],
    newSession: values["new-session"] === true,
    model: values.model,
    provider: values.provider,
    thinking: values.thinking,
    tools,
    modelFallback,
    fallbackAllowCrossProvider:
      values["fallback-allow-cross-provider"] === true,
    appendSystemPrompt: values["append-system-prompt"],
    permissionMode,
    approval,
    reviewer,
    reviewerModel,
    reviewerTimeoutMs,
    autonomy,
    scopedRules: values["scoped-rules"],
    allowUnsandboxedShell: values["allow-unsandboxed-shell"] === true,
    dangerouslyBypass,
    sandbox,
    filesystem,
    networkAllow,
    networkDeny,
    trust,
    trustResources: trustResources?.filter(
      (kind): kind is WorkspaceTrustResourceKind =>
        (WORKSPACE_TRUST_RESOURCE_KINDS as readonly string[]).includes(kind),
    ),
    resources: resources?.filter((kind): kind is WorkspaceTrustResourceKind =>
      (WORKSPACE_TRUST_RESOURCE_KINDS as readonly string[]).includes(kind),
    ),
    memory,
    allowPlugins: values["allow-plugins"] === true,
    noMcp: bare || values["no-mcp"] === true,
    noSkills,
    noPlugins,
    bare,
    headlessPolicy: values["headless-policy"],
    apply: values.apply === true,
    check: values.check === true,
    unpin: values.unpin === true,
    allProjects: values["all-projects"] === true,
    includeArchived: values["include-archived"] === true,
    confirm: values.confirm === true,
    verdict,
    actor: values.actor,
    output: values.output,
    scope,
    prefix: values.prefix,
    packageVersion: values["package-version"],
    baseUrl: values["base-url"],
    api: values.api,
    apiKey: values["api-key"],
    authHeader: values["auth-header"] === true,
    dryRun: values["dry-run"] === true,
    json: values.json === true,
    socket: values.socket,
    scopes: scopes as DaemonScope[] | undefined,
    limit,
    env: values.env ?? [],
    url: values.url,
    headers: values.header ?? [],
    cwd: values.cwd,
    additionalDirs: values["add-dir"] ?? [],
    force: values.force === true,
    guardedHostLaunch: values["guarded-host-launch"] === true,
    help: values.help === true,
    version: values.version === true,
    positionals: parsed.positionals,
  };
}

function configOverrides(options: CliOptions): ConfigOverrides {
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
      ? { thinking: options.thinking as never }
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

async function preparedConfigOverrides(
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

async function resolveProject(options: CliOptions): Promise<{
  paths: ReturnType<typeof projectPaths>;
  config: CodepunkConfig;
  workspaceTrust: WorkspaceTrust;
}> {
  if (options.dangerouslyBypass) {
    throw new Error(
      "--dangerously-bypass-approvals-and-sandbox applies to interactive sessions only",
    );
  }
  const project = await findDeliveryRoot(process.cwd());
  const initialPaths = projectPaths(project);
  const additionalRoots = await resolveAdditionalWorkspaceRoots({
    cwd: project.cwd,
    primaryRoot: project.deliveryRoot,
    codepunkHome: initialPaths.home,
    directories: options.additionalDirs,
  });
  const paths = projectPaths(project, initialPaths.home, additionalRoots);
  await initializeStateVersion(paths.home);
  await ensureProjectRegistration(project, paths);
  const workspaceTrust = await resolveWorkspaceTrust({
    cwd: project.cwd,
    root: project.deliveryRoot,
    home: paths.home,
    ...workspaceTrustOverride(options),
  });
  if (workspaceTrust.grants.config || workspaceTrust.grants.policy) {
    await ensureProjectConfigDir(paths);
  }
  const loaded = await loadConfig(
    paths,
    process.env,
    await preparedConfigOverrides(options, paths),
    { projectTrusted: workspaceTrust.grants.config },
  );
  return { paths, config: loaded.config, workspaceTrust };
}

async function prepareFork(options: CliOptions): Promise<string | undefined> {
  if (options.fork === undefined) {
    return undefined;
  }
  const project = await findDeliveryRoot(process.cwd());
  const paths = projectPaths(project);
  const workspaceTrust = await resolveWorkspaceTrust({
    cwd: project.cwd,
    root: project.deliveryRoot,
    home: paths.home,
    ...workspaceTrustOverride(options),
  });
  const loaded = await loadConfig(
    paths,
    process.env,
    {},
    {
      projectTrusted: workspaceTrust.grants.config,
    },
  );
  const result = await forkSession({
    rootDir: paths.home,
    cwd: paths.cwd,
    projectRoot: paths.deliveryRoot,
    projectId: paths.projectId,
    parentSessionId: options.fork,
    heartbeatMs: loaded.config.session.heartbeat_seconds * 1_000,
    leaseMs: loaded.config.session.lease_seconds * 1_000,
  });
  process.stderr.write(
    `codepunk: forked ${result.parentSessionId} -> ${result.sessionId}\n`,
  );
  return result.sessionId;
}

async function resolveDaemonProject(): Promise<
  ReturnType<typeof projectPaths>
> {
  const project = await findDeliveryRoot(process.cwd());
  return projectPaths(project);
}

async function readPrompt(positionals: string[]): Promise<string | null> {
  if (positionals.length > 0) {
    return positionals.join(" ");
  }
  if (process.stdin.isTTY === true) {
    return null;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  return value.length > 0 ? value : null;
}

function trustWithGrants(
  trust: WorkspaceTrust,
  grants: WorkspaceTrustGrants,
  source: WorkspaceTrustSource,
  savedPath: string | null = trust.savedPath,
): WorkspaceTrust {
  return {
    ...trust,
    grants,
    mode: workspaceTrustMode(grants),
    trusted: trust.available.every((kind) => grants[kind]),
    source,
    savedPath,
  };
}

function workspaceTrustOverride(options: CliOptions): {
  override?: boolean | WorkspaceTrustGrants;
  source?: WorkspaceTrustSource;
} {
  if (options.trust !== undefined) {
    return {
      override: options.trust === "trusted",
      source: "flag",
    };
  }
  if (options.trustResources !== undefined) {
    return {
      override: workspaceTrustGrantsFromKinds(options.trustResources),
      source: "flag",
    };
  }
  return {};
}

async function resolveRunWorkspaceTrust(
  options: CliOptions,
  project: Awaited<ReturnType<typeof findDeliveryRoot>>,
  interactive: boolean,
): Promise<WorkspaceTrust> {
  const paths = projectPaths(project);
  const resourceOptions = {
    includeSkills: !options.noSkills,
    includeInstructions: !options.bare,
  };
  if (options.trust !== undefined) {
    return resolveWorkspaceTrust({
      cwd: project.cwd,
      root: project.deliveryRoot,
      home: paths.home,
      override: options.trust === "trusted",
      source: "flag",
      ...resourceOptions,
    });
  }
  if (options.trustResources !== undefined) {
    return resolveWorkspaceTrust({
      cwd: project.cwd,
      root: project.deliveryRoot,
      home: paths.home,
      override: workspaceTrustGrantsFromKinds(options.trustResources),
      source: "flag",
      ...resourceOptions,
    });
  }
  const resolved = await resolveWorkspaceTrust({
    cwd: project.cwd,
    root: project.deliveryRoot,
    home: paths.home,
    ...resourceOptions,
  });
  if (resolved.source !== "default" || resolved.resources.length === 0) {
    return resolved;
  }
  if (!interactive) {
    // A one-shot process cannot prompt. Refusing here is the same posture as
    // Gemini CLI's headless trust failure: proceeding on defaults would run
    // without the project's own config while still reading its files. The
    // two flags are an explicit one-run choice, so they keep working.
    throw new Error(
      `workspace trust is unresolved for ${resolved.root} (project resources: ${resolved.resources.join(", ")}); print mode cannot prompt. Run codepunk trust grant ${resolved.root} for future sessions, or pass --trust / --no-trust for this run`,
    );
  }
  const previews = await previewWorkspaceTrustResources(
    project.deliveryRoot,
    project.cwd,
    resourceOptions,
  );
  const savedDecision = (() => {
    try {
      const saved = inspectSavedWorkspaceTrust(paths.home, resolved.root);
      if (saved === null) {
        return "none for this checkout or an ancestor";
      }
      const label = saved.entry.decision ? "trusted" : "untrusted";
      return saved.inherited
        ? `${label} for parent ${saved.entry.path}; this checkout needs its own decision`
        : `${label} for this checkout (${saved.entry.path})`;
    } catch (error) {
      return `unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  })();
  const excluded = [
    options.bare ? "project instructions and skills (--bare)" : null,
    options.noSkills ? "project skills (--no-skills)" : null,
  ].filter((entry): entry is string => entry !== null);
  process.stderr.write(
    [
      "",
      "Workspace trust",
      `  cwd: ${project.cwd}`,
      `  checkout root: ${resolved.root}`,
      "",
      "This workspace contains project resources that can change Codepunk's instructions or tools:",
      ...previews.map((preview) =>
        formatWorkspaceTrustResourcePreview(preview, {
          compactDigest: true,
        }),
      ),
      ...(excluded.length === 0
        ? []
        : [`excluded for this run: ${excluded.join(", ")}`]),
      "",
      "Trust only controls project config, policy, skills, and instruction files.",
      "It does not change approval, sandbox, or filesystem permissions.",
      "",
    ].join("\n"),
  );
  const build = await inspectCliBuild();
  if (build.stale === true) {
    process.stderr.write(
      `codepunk: warning: the running dist is older than the package sources; run pnpm build (entry: ${build.entryPath})\n`,
    );
  }
  const kindCopy: Record<
    WorkspaceTrustResourceKind,
    { label: string; detail: string }
  > = {
    config: {
      label: "Project configuration",
      detail: "config.toml, local.toml, and project agent profiles",
    },
    policy: {
      label: "Project policy",
      detail: "policy.toml rules and write set",
    },
    skills: {
      label: "Project skills",
      detail: ".codepunk/skills",
    },
    instructions: {
      label: "Project instructions",
      detail: "AGENTS.md and CLAUDE.md files",
    },
  };
  const discoveredKinds = WORKSPACE_TRUST_RESOURCE_KINDS.filter((kind) =>
    previews.some((preview) => preview.kind === kind),
  );
  const customChoices = discoveredKinds.map((kind) => ({
    label: kindCopy[kind].label,
    value: kind,
    checked: true,
    description: `${kindCopy[kind].detail} — ${previews
      .filter((preview) => preview.kind === kind)
      .map((preview) => preview.path)
      .join(", ")}`,
  }));
  type TrustChoice =
    "always" | "session" | "custom" | "never" | "never-session";
  const promptContext = {
    contextLines: [
      `cwd: ${project.cwd}`,
      `checkout root: ${resolved.root}`,
      `saved decision: ${savedDecision}`,
      ...(excluded.length === 0
        ? []
        : [`excluded for this run: ${excluded.join(", ")}`]),
    ],
    ...(build.stale === true || build.rebuiltAfterStart
      ? { footerNote: formatBuildLabel(build) }
      : {}),
  };
  let decision: Exclude<TrustChoice, "custom"> | null = null;
  // Loaded on demand: only the interactive prompt needs the terminal picker,
  // and its module graph pulls in the TUI stack.
  const {
    selectTerminalCheckboxes,
    selectTerminalChoice,
    TerminalSelectCancelledError,
  } = await import("./terminal-select.ts");
  while (decision === null) {
    let choice: TrustChoice;
    try {
      choice = await selectTerminalChoice<TrustChoice>(
        "Project trust",
        [
          {
            label: "Trust this workspace and remember",
            value: "always",
            description: "Load all resources · remember",
          },
          {
            label: "Trust for this session only",
            value: "session",
            description: "Load all now · ask again next start",
          },
          ...(customChoices.length > 1
            ? [
                {
                  label: "Customize resources…",
                  value: "custom" as const,
                  description: "Pick which groups load",
                },
              ]
            : []),
          {
            label: "Do not trust and remember this decision",
            value: "never",
            description: "Skip all resources · remember",
          },
          {
            label: "Do not trust for this session only",
            value: "never-session",
            description: "Skip all now · ask again next start",
          },
        ],
        promptContext,
      );
    } catch (error) {
      if (error instanceof TerminalSelectCancelledError) {
        throw new Error(
          "workspace trust was not decided; choose an option or pass --trust / --no-trust",
        );
      }
      throw error;
    }
    if (choice !== "custom") {
      decision = choice;
      break;
    }
    const selectedKinds =
      await selectTerminalCheckboxes<WorkspaceTrustResourceKind>(
        "Load project resources",
        customChoices,
        {
          contextLines: [
            `cwd: ${project.cwd}`,
            `checkout root: ${resolved.root}`,
            "Space toggles one resource group; empty selection loads none.",
          ],
        },
      );
    if (selectedKinds === null) {
      continue;
    }
    let scope: "session" | "remember" | "back";
    try {
      scope = await selectTerminalChoice<"session" | "remember" | "back">(
        "Apply custom trust",
        [
          {
            label: "Apply to this session",
            value: "session",
            description: "Use now · ask again next start",
          },
          {
            label: "Apply and remember",
            value: "remember",
            description: "Use now and for future sessions",
          },
          {
            label: "Back",
            value: "back",
            description: "Return to the trust menu",
          },
        ],
        {
          contextLines: [
            `selected: ${
              selectedKinds.length === 0 ? "none" : selectedKinds.join(", ")
            }`,
          ],
        },
      );
    } catch (error) {
      if (error instanceof TerminalSelectCancelledError) {
        continue;
      }
      throw error;
    }
    if (scope === "back") {
      continue;
    }
    const grants = workspaceTrustGrantsFromKinds(selectedKinds);
    if (scope === "session") {
      return trustWithGrants(resolved, grants, "prompt");
    }
    const saved = await saveWorkspaceTrustGrants(
      paths.home,
      resolved.root,
      grants,
      "prompt",
    );
    return {
      ...trustWithGrants(resolved, grants, "prompt", resolved.root),
      storePath: saved.storePath,
      resourceStorePath: saved.resourceStorePath,
    };
  }
  if (decision === "session") {
    return trustWithGrants(resolved, allWorkspaceTrustGrants(true), "prompt");
  }
  if (decision === "never-session") {
    return trustWithGrants(resolved, allWorkspaceTrustGrants(false), "prompt");
  }
  const grants = allWorkspaceTrustGrants(decision === "always");
  const saved = await saveWorkspaceTrustGrants(
    paths.home,
    resolved.root,
    grants,
    "prompt",
  );
  return {
    ...trustWithGrants(resolved, grants, "prompt", resolved.root),
    storePath: saved.storePath,
    resourceStorePath: saved.resourceStorePath,
  };
}

function trustRuntimeOptions(trust: WorkspaceTrust): {
  projectTrust: WorkspaceTrustGrants;
  projectTrustSource: WorkspaceTrustSource;
} {
  return {
    projectTrust: trust.grants,
    projectTrustSource: trust.source,
  };
}

function sessionSelector(value: string | undefined): {
  sessionId?: string;
  sessionPath?: string;
} {
  if (value === undefined) {
    return {};
  }
  return value.includes("/") || value.includes("\\")
    ? { sessionPath: value }
    : { sessionId: value };
}

async function makeSessionRuntime(
  runtime: CodepunkRuntime,
  options?: {
    switchState: { target: TuiSessionTarget | null };
    disposeCurrent: () => Promise<void>;
    createRuntime: (target: TuiSessionTarget) => Promise<CodepunkRuntime>;
  },
) {
  const { createAgentSessionRuntime } =
    await import("@earendil-works/pi-coding-agent");
  const initialCwd = runtime.paths.cwd;
  const initialAgentDir = runtime.paths.home;
  const initialSessionManager = runtime.host.sessionManager;
  return createAgentSessionRuntime(
    async (target) => {
      if (target.sessionManager === initialSessionManager) {
        return {
          session: runtime.host.session,
          services: runtime.host.services,
          diagnostics: runtime.host.services.diagnostics,
          extensionsResult:
            runtime.host.services.resourceLoader.getExtensions() as never,
        };
      }
      if (options === undefined) {
        throw new Error("Pi session replacement is not supported in this mode");
      }
      const requested = options.switchState.target;
      if (requested === null) {
        throw new Error(
          "Pi requested a session replacement without a Codepunk target",
        );
      }
      options.switchState.target = null;
      await options.disposeCurrent();
      const next = await options.createRuntime(requested);
      return {
        session: next.host.session,
        services: next.host.services,
        diagnostics: next.host.services.diagnostics,
        extensionsResult:
          next.host.services.resourceLoader.getExtensions() as never,
      };
    },
    {
      cwd: initialCwd,
      agentDir: initialAgentDir,
      sessionManager: initialSessionManager,
    },
  );
}

function writeRuntimeWarnings(runtime: CodepunkRuntime): void {
  for (const warning of runtime.loadedConfig.warnings) {
    process.stderr.write(`codepunk: warning: ${warning}\n`);
  }
}

function exhaustedBudgetMessage(runtime: CodepunkRuntime): string | null {
  const maxTokens = runtime.config.budget.max_tokens;
  const maxCostUsd = runtime.config.budget.max_cost_usd;
  const usage = runtime.usage();
  const tokensExhausted = maxTokens !== null && usage.total_tokens >= maxTokens;
  const costExhausted = maxCostUsd !== null && usage.cost_total >= maxCostUsd;
  if (!tokensExhausted && !costExhausted) {
    return null;
  }
  const limits: string[] = [];
  if (maxTokens !== null) {
    limits.push(`${usage.total_tokens}/${maxTokens} tokens`);
  }
  if (maxCostUsd !== null) {
    limits.push(`$${usage.cost_total}/$${maxCostUsd}`);
  }
  return `session budget exhausted (${limits.join(", ")}); start a new session to continue`;
}

async function runPrint(options: CliOptions, prompt: string): Promise<number> {
  if (options.allowUnsandboxedShell) {
    throw new Error("--allow-unsandboxed-shell is interactive only");
  }
  if (options.dangerouslyBypass) {
    throw new Error(
      "--dangerously-bypass-approvals-and-sandbox is interactive only",
    );
  }
  if (options.allowPlugins) {
    throw new Error("--allow-plugins is interactive only");
  }
  if (
    options.permissionMode !== undefined &&
    options.permissionMode !== "read-only" &&
    options.headlessPolicy === undefined
  ) {
    throw new Error(
      `print mode exposes read-only tools unless --headless-policy grants write or shell; --permission-mode ${options.permissionMode} would not take effect`,
    );
  }
  const forkedSessionId = await prepareFork(options);
  const selector =
    forkedSessionId === undefined
      ? sessionSelector(options.session)
      : { sessionId: forkedSessionId };
  const project = await findDeliveryRoot(process.cwd());
  const workspaceTrust = await resolveRunWorkspaceTrust(
    options,
    project,
    false,
  );
  const overrides = await preparedConfigOverrides(
    options,
    projectPaths(project),
  );
  const runtime = await createRuntime({
    cwd: process.cwd(),
    additionalDirs: options.additionalDirs,
    environment: process.env,
    configOverrides: overrides,
    headless: true,
    continueSession: forkedSessionId === undefined && options.continueSession,
    newSession: forkedSessionId === undefined && options.newSession,
    ...(options.newSessionId !== undefined
      ? { newSessionId: options.newSessionId }
      : {}),
    ...(options.parentSessionId !== undefined
      ? { parentSessionId: options.parentSessionId }
      : {}),
    ...selector,
    ...(options.headlessPolicy !== undefined
      ? { headlessPolicyPath: options.headlessPolicy }
      : {}),
    bindMode: "print",
    allowUnsandboxedShell: false,
    disableMcp: options.noMcp,
    disableSkills: options.noSkills,
    disablePlugins: options.noPlugins,
    bare: options.bare,
    ...trustRuntimeOptions(workspaceTrust),
  });
  writeRuntimeWarnings(runtime);
  try {
    const modelIssue = await probeConfiguredModel(
      runtime.paths,
      runtime.config,
    );
    if (modelIssue !== null) {
      throw new Error(modelIssue);
    }
    const budgetIssue = exhaustedBudgetMessage(runtime);
    if (budgetIssue !== null) {
      throw new Error(budgetIssue);
    }
    const sessionRuntime = await makeSessionRuntime(runtime);
    const { runPrintMode } = await import("@earendil-works/pi-coding-agent");
    return await runPrintMode(sessionRuntime, {
      mode: options.mode,
      initialMessage: prompt,
    });
  } finally {
    await runtime.dispose();
  }
}

async function runTui(options: CliOptions): Promise<number> {
  // The interactive stack is heavy; load it only when a TUI actually starts.
  const [
    { ProcessTerminal },
    {
      applyReplacedRuntime,
      createTuiExtension,
      modelOnboardingMessage,
      setTuiRuntime,
      TuiApprovalChannel,
    },
    { BrandedInteractiveMode },
  ] = await Promise.all([
    import("@earendil-works/pi-tui"),
    import("./tui.ts"),
    import("./branded-interactive.ts"),
  ]);
  const forkedSessionId = await prepareFork(options);
  const selector =
    forkedSessionId === undefined
      ? sessionSelector(options.session)
      : { sessionId: forkedSessionId };
  const channel = new TuiApprovalChannel();
  const state: TuiState = {
    runtime: null,
    context: null,
    channel,
    lastRunId: null,
    lastEvidence: 0,
    warningsShown: false,
    modelSelected: false,
    ready: false,
    shuttingDown: false,
    hostCommands: new Set(),
    childHostArgv: [process.execPath, fileURLToPath(import.meta.url)],
  };
  const extension = createTuiExtension(state, channel);
  const project = await findDeliveryRoot(process.cwd());
  const workspaceTrust = await resolveRunWorkspaceTrust(options, project, true);
  const overrides = await preparedConfigOverrides(
    options,
    projectPaths(project),
  );
  const buildTuiRuntime = async (selection: {
    sessionId?: string;
    sessionPath?: string;
    newSession?: boolean;
    continueSession?: boolean;
    newSessionId?: string;
    parentSessionId?: string;
  }) =>
    createRuntime({
      cwd: process.cwd(),
      additionalDirs: options.additionalDirs,
      environment: process.env,
      configOverrides: overrides,
      ...(selection.continueSession === undefined
        ? {}
        : { continueSession: selection.continueSession }),
      ...(selection.newSession === undefined
        ? {}
        : { newSession: selection.newSession }),
      ...(selection.newSessionId !== undefined
        ? { newSessionId: selection.newSessionId }
        : {}),
      ...(selection.parentSessionId !== undefined
        ? { parentSessionId: selection.parentSessionId }
        : {}),
      ...(selection.sessionId !== undefined
        ? { sessionId: selection.sessionId }
        : {}),
      ...(selection.sessionPath !== undefined
        ? { sessionPath: selection.sessionPath }
        : {}),
      ...(options.headlessPolicy !== undefined
        ? { headlessPolicyPath: options.headlessPolicy }
        : {}),
      approvalChannel: channel,
      allowUnsandboxedShell:
        options.allowUnsandboxedShell || options.dangerouslyBypass,
      allowFullFilesystem: options.dangerouslyBypass,
      allowMissingModel: true,
      bindMode: "tui",
      allowPlugins: options.allowPlugins,
      disableMcp: options.noMcp,
      disableSkills: options.noSkills,
      disablePlugins: options.noPlugins,
      bare: options.bare,
      additionalExtensionFactories: [extension],
      ...trustRuntimeOptions(workspaceTrust),
    });
  const runtime = await buildTuiRuntime({
    continueSession: forkedSessionId === undefined && options.continueSession,
    newSession: forkedSessionId === undefined && options.newSession,
    ...(options.newSessionId !== undefined
      ? { newSessionId: options.newSessionId }
      : {}),
    ...(options.parentSessionId !== undefined
      ? { parentSessionId: options.parentSessionId }
      : {}),
    ...selector,
  });
  setTuiRuntime(state, runtime);
  let currentRuntime: CodepunkRuntime | null = runtime;
  const switchState: { target: TuiSessionTarget | null } = { target: null };
  let buildWatch: NodeJS.Timeout | undefined;
  try {
    const sessionRuntime = await makeSessionRuntime(runtime, {
      switchState,
      async disposeCurrent() {
        const current = currentRuntime;
        currentRuntime = null;
        if (current !== null) {
          await current.dispose();
        }
      },
      async createRuntime(target) {
        const next = await buildTuiRuntime(target);
        currentRuntime = next;
        state.runtime = next;
        return next;
      },
    });
    state.replaceRuntime = async (target) => {
      const previousRuntime = state.runtime;
      const previousContext = state.context;
      if (previousRuntime === null) {
        throw new Error("codepunk runtime is not ready");
      }
      state.runtime = null;
      state.context = null;
      switchState.target = target;
      let replacementContext: ExtensionCommandContext | null = null;
      try {
        const result = await sessionRuntime.newSession({
          withSession: async (context) => {
            replacementContext = context;
          },
        });
        if (result.cancelled) {
          throw new Error("session switch was cancelled");
        }
        if (replacementContext === null || currentRuntime === null) {
          throw new Error("session switch did not produce a runtime");
        }
        const replacement: TuiRuntimeReplacement = {
          runtime: currentRuntime,
          context: replacementContext,
        };
        applyReplacedRuntime(state, replacement.runtime, replacement.context);
        return replacement;
      } catch (error) {
        switchState.target = null;
        if (currentRuntime !== null) {
          state.runtime = previousRuntime;
          state.context = previousContext;
        }
        throw error;
      }
    };
    const modelFallbackMessage =
      modelOnboardingMessage(runtime) ?? sessionRuntime.modelFallbackMessage;
    const build = await inspectCliBuild();
    const startupDiagnostics = [
      ...runtime.host.services.diagnostics,
      ...(build.stale === true || build.rebuiltAfterStart
        ? [
            {
              type: "warning" as const,
              message: `codepunk build: ${formatBuildLabel(build)}. Run pnpm build if the source changed, then restart codepunk; a running process keeps the old UI in memory.`,
            },
          ]
        : []),
    ];
    const interactive = new BrandedInteractiveMode(sessionRuntime, {
      terminal: new CodepunkTerminal(new ProcessTerminal()),
      startupDiagnostics,
      ...(modelFallbackMessage === undefined ? {} : { modelFallbackMessage }),
    });
    await interactive.init();
    const applyTitle = () => {
      if (state.shuttingDown) {
        return;
      }
      try {
        state.context?.ui.setTitle(
          `codepunk · session ${state.runtime?.session.sessionId ?? "starting"}`,
        );
      } catch {
        // The delayed title refresh races session teardown; the title is
        // cosmetic, so a stale extension context must not crash the process.
      }
    };
    applyTitle();
    buildWatch = setInterval(() => {
      void (async () => {
        const context = state.context;
        if (context === null || state.shuttingDown) {
          return;
        }
        const current = await inspectCliBuild();
        if (
          !current.rebuiltAfterStart ||
          state.shuttingDown ||
          state.context !== context
        ) {
          return;
        }
        if (buildWatch !== undefined) {
          clearInterval(buildWatch);
          buildWatch = undefined;
          state.buildWatch = undefined;
        }
        try {
          context.ui.notify(
            `codepunk: dist was rebuilt after this process started (${formatBuildLabel(
              current,
            )}). Restart codepunk to load the new UI; this session keeps the old modules in memory.`,
            "warning",
          );
        } catch {
          // The session can be replaced while the build check is in flight.
        }
      })().catch(() => undefined);
    }, 30_000);
    buildWatch.unref();
    state.buildWatch = buildWatch;
    state.titleTimers = [
      setTimeout(applyTitle, 250),
      setTimeout(applyTitle, 1_000),
    ];
    for (const timer of state.titleTimers) {
      timer.unref();
    }
    await interactive.run();
    return 0;
  } finally {
    state.shuttingDown = true;
    for (const timer of state.titleTimers ?? []) {
      clearTimeout(timer);
    }
    state.titleTimers = [];
    if (buildWatch !== undefined) {
      clearInterval(buildWatch);
      buildWatch = undefined;
      state.buildWatch = undefined;
    }
    const running = [...(state.subagents?.values() ?? [])].filter(
      (record) => record.status === "running",
    );
    for (const record of running) {
      record.controller.abort();
    }
    await Promise.race([
      Promise.allSettled(running.map((record) => record.promise)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    await currentRuntime?.dispose();
  }
}

async function commandSessions(options: CliOptions): Promise<number> {
  const { paths, config } = await resolveProject(options);
  if (options.positionals.includes("prune")) {
    if (options.apply) {
      throw new Error(
        "sessions prune --apply is refused because it bypasses the backup boundary; use codepunk gc --apply for artifact cleanup",
      );
    }
    const plan = await planRetention(
      paths,
      {
        sessionDays: config.session.retention_days,
        sessionCount: config.session.retention_count,
        evidenceDays: config.evidence.retention_days,
        evidenceCount: config.evidence.retention_count,
        logDays: 14,
        leaseMs: config.session.lease_seconds * 1_000,
      },
      { dryRun: !options.apply },
    );
    process.stdout.write(
      options.json
        ? `${JSON.stringify(plan)}\n`
        : `${plan.dryRun ? "DRY RUN" : "APPLIED"}: ${plan.actions.length} action(s)\n`,
    );
    if (!options.json) {
      for (const action of plan.actions) {
        process.stdout.write(
          `${action.kind} ${action.id} ${action.blocked === null ? "" : `[blocked: ${action.blocked}]`}\n`,
        );
      }
    }
    return 0;
  }
  const subcommand = options.positionals[1];
  if (options.allProjects && subcommand !== "search") {
    throw new Error("--all-projects only applies to sessions search");
  }
  const sessionOptions = (sessionId: string) => ({
    rootDir: paths.home,
    cwd: paths.cwd,
    projectRoot: paths.deliveryRoot,
    projectId: paths.projectId,
    sessionId,
  });
  if (
    subcommand === "rename" ||
    subcommand === "archive" ||
    subcommand === "unarchive" ||
    subcommand === "delete" ||
    subcommand === "export" ||
    subcommand === "import"
  ) {
    const requested = options.positionals[2];
    if (requested === undefined) {
      throw new Error(`sessions ${subcommand} requires a session id`);
    }
    if (subcommand === "rename") {
      const title = options.positionals.slice(3).join(" ").trim();
      if (title.length === 0) {
        throw new Error("sessions rename requires a title");
      }
      const renamed = await renameSession(sessionOptions(requested), title);
      process.stdout.write(
        options.json
          ? `${JSON.stringify({ session_id: requested, title: renamed })}\n`
          : `renamed ${requested} -> ${renamed}\n`,
      );
      return 0;
    }
    if (subcommand === "archive" || subcommand === "unarchive") {
      await archiveSession(sessionOptions(requested), subcommand === "archive");
      process.stdout.write(
        options.json
          ? `${JSON.stringify({ session_id: requested, archived: subcommand === "archive" })}\n`
          : `${subcommand === "archive" ? "archived" : "unarchived"} ${requested}\n`,
      );
      return 0;
    }
    if (subcommand === "delete") {
      if (!options.confirm) {
        throw new Error("sessions delete requires --confirm");
      }
      const deleted = await deleteSession({
        ...sessionOptions(requested),
        confirmed: true,
      });
      process.stdout.write(
        options.json
          ? `${JSON.stringify(deleted)}\n`
          : `deleted ${deleted.session_id} (backup ${deleted.backup_id}, ${deleted.deleted_files} file(s))\n`,
      );
      return 0;
    }
    if (subcommand === "export") {
      const store = await resolveSession(sessionOptions(requested));
      const bundle = await createSessionBundle(store);
      const target =
        options.output ??
        path.join(paths.artifactsDir, `${store.sessionId}.session.json`);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, `${JSON.stringify(bundle)}\n`, {
        mode: 0o600,
      });
      process.stdout.write(
        options.json
          ? `${JSON.stringify({ session_id: store.sessionId, output: target, events: bundle.meta.log_seq })}\n`
          : `exported ${store.sessionId} -> ${target} (${bundle.meta.log_seq} event(s))\n`,
      );
      return 0;
    }
    const bundlePath = path.resolve(requested);
    const stat = await fs.lstat(bundlePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("session bundle must be a regular file");
    }
    if (stat.size > 64 * 1024 * 1024) {
      throw new Error("session bundle exceeds 64 MiB");
    }
    let bundle: unknown;
    try {
      bundle = JSON.parse(await fs.readFile(bundlePath, "utf8"));
    } catch {
      throw new Error("session bundle is not valid JSON");
    }
    const imported = await importSession({
      home: paths.home,
      projectId: paths.projectId,
      bundle: bundle as never,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(imported)}\n`
        : `imported ${imported.session_id} -> ${imported.path} (${imported.events} event(s))\n`,
    );
    return 0;
  }
  if (subcommand === "search") {
    const query = options.positionals[2];
    if (query === undefined) {
      throw new Error("sessions search requires a query");
    }
    const result = options.allProjects
      ? await searchAllProjectSessions({
          rootDir: paths.home,
          query,
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        })
      : await searchProjectSessions({
          rootDir: paths.home,
          projectId: paths.projectId,
          query,
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result)}\n`
        : `${formatSessionSearch(result)}\n`,
    );
    return 0;
  }
  if (subcommand === "tree") {
    const requested = options.positionals[2];
    const store = await resolveSession({
      rootDir: paths.home,
      cwd: paths.cwd,
      projectRoot: paths.deliveryRoot,
      projectId: paths.projectId,
      ...(requested !== undefined ? { sessionId: requested } : {}),
    });
    const tree = await readSessionTree(store);
    if (tree === null) {
      throw new Error(
        `session ${store.sessionId} has no saved agent state; run a turn before inspecting its tree`,
      );
    }
    process.stdout.write(
      options.json
        ? `${JSON.stringify(tree)}\n`
        : `${formatSessionTree(tree)}\n`,
    );
    return 0;
  }
  if (subcommand === "graph") {
    const graph = await readSessionGraph(paths.home, paths.projectId);
    process.stdout.write(
      options.json
        ? `${JSON.stringify(graph)}\n`
        : `${formatSessionGraph(graph)}\n`,
    );
    return 0;
  }
  const sessions = await listProjectSessions(paths.home, paths.projectId, {
    includeArchived: options.includeArchived,
  });
  process.stdout.write(
    options.json
      ? `${JSON.stringify(sessions)}\n`
      : `${formatSessionList(sessions)}\n`,
  );
  return 0;
}

function formatByteCount(bytes: number): string {
  return `${bytes} byte${bytes === 1 ? "" : "s"}`;
}

async function commandGc(options: CliOptions): Promise<number> {
  const { paths, config } = await resolveProject(options);
  if (options.apply && (options.dryRun || options.check)) {
    throw new Error("gc accepts --dry-run or --apply, not both");
  }
  const result = await applyGc(paths.home, {
    dryRun: !options.apply,
    olderThanMs: config.evidence.retention_days * 86_400_000,
    now: new Date(),
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.skipped.length === 0 ? 0 : 1;
  }
  const lines = [
    `${result.dry_run ? "GC DRY RUN" : "GC APPLIED"}: ${result.candidates.length} candidate(s)`,
  ];
  for (const candidate of result.candidates) {
    lines.push(
      `  ${candidate.path}  ${formatByteCount(candidate.bytes)}  ${candidate.reason}`,
    );
  }
  if (!result.dry_run) {
    lines.push(
      `backup: ${result.backup_id ?? "(none; nothing to delete)"}`,
      `deleted: ${result.deleted.length}`,
    );
  }
  for (const skipped of result.skipped) {
    lines.push(`skipped: ${skipped.path}  ${skipped.reason}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return result.skipped.length === 0 ? 0 : 1;
}

async function commandMigrate(options: CliOptions): Promise<number> {
  const home = resolveCodepunkHome(process.env);
  if (options.apply && options.check) {
    throw new Error("migrate accepts --check or --apply, not both");
  }
  if (options.apply) {
    const result = await applyMigration(home);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(
        [
          `migrate: ${result.status.current} -> ${result.status.target}`,
          `backup: ${result.backup_id ?? "(none; already current)"}`,
        ].join("\n") + "\n",
      );
    }
    return 0;
  }
  const status = await checkMigration(home);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
  } else {
    process.stdout.write(
      [
        `current: ${status.current}`,
        `target: ${status.target}`,
        `migration required: ${status.required ? "yes" : "no"}`,
      ].join("\n") + "\n",
    );
  }
  return status.required ? 1 : 0;
}

async function commandBackup(options: CliOptions): Promise<number> {
  const { paths } = await resolveProject(options);
  const action = options.positionals[1] ?? "list";
  if (action === "create") {
    const manifest = await createBackup(paths.home, {
      roots: ["projects"],
      include: ["config.toml", "state-version.json"],
      waitForWritersMs: 5_000,
    });
    await appendRetentionOperation(paths.home, {
      at: manifest.created_at,
      action: "backup.create",
      mode: "apply",
      paths: manifest.files.map((file) => ({
        path: file.path,
        before_sha256: null,
        after_sha256: file.sha256,
        bytes: file.bytes,
      })),
      backup_id: manifest.id,
      exit_code: 0,
      failure: null,
    });
    const totalBytes = manifest.files.reduce(
      (sum, file) => sum + file.bytes,
      0,
    );
    if (options.json) {
      process.stdout.write(`${JSON.stringify(manifest)}\n`);
    } else {
      process.stdout.write(
        [
          `created backup ${manifest.id}`,
          `files: ${manifest.files.length}`,
          `bytes: ${totalBytes}`,
          `path: ${path.join(paths.home, "backups", manifest.id)}`,
        ].join("\n") + "\n",
      );
    }
    return 0;
  }
  if (action === "list") {
    const backups = await listBackups(paths.home);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(backups)}\n`);
    } else if (backups.length === 0) {
      process.stdout.write("No backups.\n");
    } else {
      process.stdout.write(
        backups
          .map(
            (backup) =>
              `${backup.id}  ${backup.created_at}  ${backup.files.length} file(s)`,
          )
          .join("\n") + "\n",
      );
    }
    return 0;
  }
  if (action === "restore") {
    const id = options.positionals[2];
    if (id === undefined) {
      throw new Error("backup restore requires a backup id");
    }
    const manifest = await restoreBackup(paths.home, id);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(manifest)}\n`);
    } else {
      process.stdout.write(
        `restored backup ${manifest.id} (${manifest.files.length} file(s))\n`,
      );
    }
    return 0;
  }
  throw new Error(`unknown backup command: ${action}`);
}

function formatDaemonList(result: DaemonSessionListResult): string {
  if (result.sessions.length === 0) {
    return "No sessions.";
  }
  return result.sessions
    .map((session) => {
      const title =
        session.title === null || session.title.length === 0
          ? "(untitled)"
          : session.title;
      const pin = session.pinned ? " pinned" : "";
      return `${session.id}  ${session.updated_at}  seq=${session.last_seq}${pin}  ${title}\n  ${session.cwd}`;
    })
    .join("\n");
}

function formatDaemonSession(result: DaemonSessionReadResult): string {
  const lines = [
    `Session: ${result.header.id}`,
    `Project: ${result.header.project_id}`,
    `Created: ${result.header.created_at}`,
    `Updated: ${result.metadata.updated_at}`,
    `CWD: ${result.header.cwd}`,
    `Events: ${result.events.length} (through seq ${result.next_seq})`,
    "",
  ];
  for (const event of result.events) {
    const data = JSON.stringify(event.data);
    const preview = data.length > 500 ? `${data.slice(0, 497)}...` : data;
    lines.push(`#${event.seq} ${event.at} ${event.kind} ${preview}`);
  }
  return lines.join("\n");
}

async function commandDaemon(options: CliOptions): Promise<number> {
  if (process.platform === "win32") {
    throw new Error(
      "codepunk daemon is not supported on Windows: the daemon requires a Unix socket and Windows named pipes are not implemented",
    );
  }
  const paths = await resolveDaemonProject();
  const server = await DaemonServer.start({
    paths,
    ...(options.socket !== undefined ? { socketPath: options.socket } : {}),
    ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
  });
  try {
    const client = new DaemonClient({ socketPath: server.socketPath });
    const hello = await client.hello();
    const stop = () => {
      void server.close().catch(() => {});
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          socket: server.socketPath,
          project_id: server.projectId,
          ...hello,
        })}\n`,
      );
    } else {
      process.stdout.write(
        `codepunk daemon ${server.socketPath}\nprotocol v1: ${hello.methods.join(", ")}; Ctrl-C to stop\n`,
      );
    }
    try {
      await server.wait();
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return 0;
  } finally {
    await server.close();
  }
}

async function commandAcp(): Promise<number> {
  const backend = new RuntimeControlBackend({
    cwd: process.cwd(),
    createRuntime: () =>
      createRuntime({
        cwd: process.cwd(),
        environment: process.env,
        headless: true,
        newSession: true,
        bindMode: "print",
        allowMissingModel: true,
        allowUnsandboxedShell: false,
      }),
  });
  const server = new AcpServer({
    backend,
    input: process.stdin,
    output: process.stdout,
  });
  await server.run();
  return 0;
}

async function commandView(options: CliOptions): Promise<number> {
  if (process.platform === "win32") {
    throw new Error(
      "codepunk view is not supported on Windows: the daemon requires a Unix socket and Windows named pipes are not implemented",
    );
  }
  const paths = await resolveDaemonProject();
  const client = new DaemonClient({
    socketPath: daemonSocketPath(paths, options.socket),
  });
  const requested = options.positionals[1];
  if (requested === undefined) {
    const result = await client.listSessions();
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result)}\n`
        : `${formatDaemonList(result)}\n`,
    );
    return 0;
  }
  const result = await client.readAllSession(requested);
  process.stdout.write(
    options.json
      ? `${JSON.stringify(result)}\n`
      : `${formatDaemonSession(result)}\n`,
  );
  return 0;
}

async function commandCompletion(options: CliOptions): Promise<number> {
  const shell = options.positionals[1];
  if (shell === undefined || !isCompletionShell(shell)) {
    throw new Error(
      `completion requires one shell: ${COMPLETION_SHELLS.join(", ")}`,
    );
  }
  process.stdout.write(completionScript(shell));
  return 0;
}

async function commandExport(options: CliOptions): Promise<number> {
  const { paths } = await resolveProject(options);
  const requested = options.positionals[1];
  const store = await resolveSession({
    rootDir: paths.home,
    cwd: paths.cwd,
    projectRoot: paths.deliveryRoot,
    projectId: paths.projectId,
    ...(requested !== undefined ? { sessionId: requested } : {}),
  });
  const exported = await exportSession(store);
  if (options.output !== undefined) {
    const target = path.resolve(options.output);
    const manifestTarget = `${target}.manifest.json`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, exported.transcript, { mode: 0o600 });
    await fs.writeFile(
      manifestTarget,
      `${JSON.stringify(exported.manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    process.stdout.write(`${target}\n${manifestTarget}\n`);
  } else {
    process.stdout.write(exported.transcript);
  }
  return 0;
}

async function commandPin(options: CliOptions): Promise<number> {
  const { paths } = await resolveProject(options);
  const sessionId = options.positionals[1];
  if (sessionId === undefined) {
    throw new Error("pin requires a session id");
  }
  const pinned = !options.unpin;
  // Prefer the daemon so a running server stays the only writer for this
  // project; fall back to the direct store write when no daemon is listening,
  // which is the normal case for a one-shot CLI call.
  // Windows cannot host the Unix-socket daemon at all, so it always takes the
  // direct store path. Asking for the socket path there would throw before
  // the fallback could run.
  let client: DaemonClient | null = null;
  if (process.platform === "darwin" || process.platform === "linux") {
    client = new DaemonClient({
      socketPath: daemonSocketPath(paths, options.socket),
    });
  }
  let handled = false;
  if (client !== null) {
    try {
      await client.pinSession(sessionId, pinned);
      handled = true;
    } catch (error) {
      if (
        !(error instanceof DaemonClientError) ||
        error.code !== "daemon.unavailable"
      ) {
        throw error;
      }
    }
  }
  if (!handled) {
    await pinSession(
      {
        rootDir: paths.home,
        cwd: paths.cwd,
        projectRoot: paths.deliveryRoot,
        projectId: paths.projectId,
        sessionId,
      },
      pinned,
    );
  }
  process.stdout.write(
    `${options.unpin ? "unpinned" : "pinned"} ${sessionId}\n`,
  );
  return 0;
}

async function commandSign(options: CliOptions): Promise<number> {
  const runId = options.positionals[1];
  if (runId === undefined || options.verdict === undefined) {
    throw new Error("sign requires <run-id> --verdict complete|incomplete");
  }
  if (process.stdin.isTTY !== true) {
    throw new Error("sign requires a top-level TTY");
  }
  const result = await signStandalone({
    cwd: process.cwd(),
    runId,
    verdict: options.verdict,
    ...(options.actor !== undefined ? { actor: options.actor } : {}),
    tty: true,
  });
  process.stdout.write(
    `${result.verdict.verdict} ${result.artifactPath}\n${result.issues.join("\n")}\n`,
  );
  return 0;
}

async function appendMemoryEvent(
  paths: ReturnType<typeof projectPaths>,
  input: {
    scope: "user" | "project";
    action: "add" | "edit" | "delete" | "archive" | "reject";
    memoryId: string | null;
    contentSha256: string | null;
    sourceRefs: string[];
    reason: string | null;
  },
): Promise<void> {
  const sessions = await listProjectSessions(paths.home, paths.projectId);
  const store =
    sessions.length > 0
      ? await resolveSession({
          rootDir: paths.home,
          cwd: paths.cwd,
          projectRoot: paths.deliveryRoot,
          projectId: paths.projectId,
          sessionId: sessions[0]!.id,
        })
      : await SessionStore.create({
          rootDir: paths.home,
          cwd: paths.cwd,
          projectRoot: paths.deliveryRoot,
          projectId: paths.projectId,
        });
  const writer = await store.acquireWriter();
  try {
    await store.append("memory/write", {
      scope: input.scope,
      action: input.action,
      memory_id: input.memoryId,
      content_sha256: input.contentSha256,
      source_refs: input.sourceRefs,
      reason: input.reason,
    });
  } finally {
    await writer.release();
  }
}

async function commandMemory(options: CliOptions): Promise<number> {
  const { paths, config } = await resolveProject(options);
  const memory = await MemoryManager.open({
    paths,
    enabled: config.memory.enabled,
    maxTokens: config.memory.max_tokens,
    defaultScope: config.memory.default_scope,
  });
  const command = options.positionals[1] ?? "list";
  const scope = options.scope ?? config.memory.default_scope;
  if (command === "export") {
    const exported = exportMemoryRecords(memory, {
      scope,
      home: paths.home,
    });
    const serialized = `${JSON.stringify(exported, null, 2)}\n`;
    if (options.output !== undefined) {
      const target = path.resolve(options.output);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const handle = await fs.open(target, "w", 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      process.stdout.write(`${target}\n`);
    } else {
      process.stdout.write(serialized);
    }
    return 0;
  }
  if (command === "list" || command === "search") {
    const query =
      command === "search" ? options.positionals.slice(2).join(" ") : "";
    const result = await memory.search(query, scope, 20);
    for (const record of result.records) {
      process.stdout.write(
        `${record.id}\t${record.scope}\t${record.kind}\t${record.content}\n`,
      );
    }
    return 0;
  }
  if (command === "add") {
    const content = options.positionals.slice(2).join(" ").trim();
    if (content.length === 0) {
      throw new Error("memory add requires text");
    }
    const result = await memory.add({
      scope,
      content,
      source: "user",
      source_refs: ["cli:memory-add"],
    });
    if (!result.ok) {
      await appendMemoryEvent(paths, {
        scope,
        action: "reject",
        memoryId: result.record?.id ?? null,
        contentSha256: result.record?.content_sha256 ?? null,
        sourceRefs: ["cli:memory-add"],
        reason: result.reason,
      });
      throw new Error(`memory add rejected: ${result.reason}`);
    }
    await appendMemoryEvent(paths, {
      scope,
      action: "add",
      memoryId: result.record?.id ?? null,
      contentSha256: result.record?.content_sha256 ?? null,
      sourceRefs: ["cli:memory-add"],
      reason: null,
    });
    process.stdout.write(`${result.record?.id}\n`);
    return 0;
  }
  const id = options.positionals[2];
  if (id === undefined) {
    throw new Error(`memory ${command} requires an id`);
  }
  const store = memory.storeFor(scope);
  if (command === "edit") {
    const content = options.positionals.slice(3).join(" ").trim();
    if (content.length === 0) {
      throw new Error("memory edit requires text");
    }
    const result = await store.edit(id, content);
    if (!result.ok) {
      await appendMemoryEvent(paths, {
        scope,
        action: "reject",
        memoryId: id,
        contentSha256: null,
        sourceRefs: ["cli:memory-edit"],
        reason: result.reason,
      });
      throw new Error(`memory edit rejected: ${result.reason}`);
    }
    await appendMemoryEvent(paths, {
      scope,
      action: "edit",
      memoryId: id,
      contentSha256: result.record?.content_sha256 ?? null,
      sourceRefs: ["cli:memory-edit"],
      reason: null,
    });
    process.stdout.write(`${id}\n`);
    return 0;
  }
  if (command === "delete") {
    const existing = store.records.find((record) => record.id === id);
    if (!(await store.delete(id))) {
      await appendMemoryEvent(paths, {
        scope,
        action: "reject",
        memoryId: id,
        contentSha256: null,
        sourceRefs: ["cli:memory-delete"],
        reason: "not_found",
      });
      throw new Error("memory record was not found");
    }
    await appendMemoryEvent(paths, {
      scope,
      action: "delete",
      memoryId: id,
      contentSha256: existing?.content_sha256 ?? null,
      sourceRefs: ["cli:memory-delete"],
      reason: null,
    });
    process.stdout.write(`${id}\n`);
    return 0;
  }
  if (command === "archive") {
    const existing = store.records.find((record) => record.id === id);
    if (!(await store.archive(id))) {
      await appendMemoryEvent(paths, {
        scope,
        action: "reject",
        memoryId: id,
        contentSha256: null,
        sourceRefs: ["cli:memory-archive"],
        reason: "not_found",
      });
      throw new Error("memory record was not found");
    }
    await appendMemoryEvent(paths, {
      scope,
      action: "archive",
      memoryId: id,
      contentSha256: existing?.content_sha256 ?? null,
      sourceRefs: ["cli:memory-archive"],
      reason: null,
    });
    process.stdout.write(`${id}\n`);
    return 0;
  }
  throw new Error(`unknown memory command: ${command}`);
}

async function commandDoctor(options: CliOptions): Promise<number> {
  const { paths, config, workspaceTrust } = await resolveProject(options);
  const build = await inspectCliBuild();
  const report = appendBuildDoctorCheck(
    await runDoctor({
      paths,
      config,
      projectTrusted: workspaceTrust.grants.skills,
      pluginEnabled: options.allowPlugins,
      packageVersion: build.version,
    }),
    build,
  );
  process.stdout.write(
    options.json ? `${JSON.stringify(report)}\n` : `${formatDoctor(report)}\n`,
  );
  return report.ok ? 0 : 1;
}

function configLayerSuffix(loaded: boolean): string {
  return loaded ? "" : " (not loaded)";
}

async function commandConfig(options: CliOptions): Promise<number> {
  const subject = options.positionals[1] ?? "show";
  if (subject !== "show" && subject !== "path") {
    throw new Error(
      `unknown config command ${subject}; use config [show] or config path`,
    );
  }
  const project = await findDeliveryRoot(process.cwd());
  const paths = projectPaths(project);
  const files = configFilePaths(paths);
  const configPaths = {
    home: paths.home,
    user: files.user,
    project: files.project,
    local: files.local,
    project_dir: paths.projectConfigDir,
  };
  if (subject === "path") {
    const payload = {
      cwd: project.cwd,
      root: project.deliveryRoot,
      project_id: paths.projectId,
      ...configPaths,
    };
    process.stdout.write(
      options.json
        ? `${JSON.stringify(payload, null, 2)}\n`
        : `${[
            `cwd: ${payload.cwd}`,
            `checkout root: ${payload.root}`,
            `project id: ${payload.project_id}`,
            `home: ${payload.home}`,
            `user config: ${payload.user}`,
            `project config: ${payload.project}`,
            `local config: ${payload.local}`,
            `project config dir: ${payload.project_dir}`,
          ].join("\n")}\n`,
    );
    return 0;
  }

  let trust: WorkspaceTrust | null = null;
  let trustError: string | null = null;
  try {
    trust = await resolveWorkspaceTrust({
      cwd: project.cwd,
      root: project.deliveryRoot,
      home: paths.home,
      includeSkills: !options.noSkills,
      includeInstructions: !options.bare,
      ...workspaceTrustOverride(options),
    });
  } catch (error) {
    trustError = error instanceof Error ? error.message : String(error);
  }
  const loaded = await loadConfig(
    paths,
    process.env,
    {},
    { projectTrusted: trust?.grants.config === true },
  );
  let writeSet: string[] | null = null;
  const warnings = [...loaded.warnings];
  if (trust?.grants.policy === true) {
    const policy = await loadPolicyFiles(paths, { projectTrusted: true });
    writeSet = policy.writeSet;
    warnings.push(...policy.warnings);
  }
  if (trustError !== null) {
    warnings.unshift(trustError);
  }
  const summary = configSummary(
    loaded.config,
    writeSet ?? ["(policy not loaded)"],
  );
  const trustPayload =
    trust === null
      ? { error: trustError }
      : {
          mode: trust.mode,
          source: trust.source,
          trusted: trust.trusted,
          grants: trust.grants,
          available: trust.available,
          resources: trust.resources,
          cwd: trust.cwd,
          root: trust.root,
          store: trust.storePath,
          resource_store: trust.resourceStorePath,
          saved_path: trust.savedPath,
        };
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          cwd: project.cwd,
          root: project.deliveryRoot,
          project_id: paths.projectId,
          paths: configPaths,
          trust: trustPayload,
          config: loaded.config,
          write_set: writeSet,
          summary,
          warnings,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const lines = [
    "codepunk configuration",
    `cwd: ${project.cwd}`,
    `checkout root: ${project.deliveryRoot}`,
    `project id: ${paths.projectId}`,
    `home: ${configPaths.home}`,
    `user config: ${configPaths.user}`,
    `project config: ${configPaths.project}${configLayerSuffix(
      trust?.grants.config === true,
    )}`,
    `local config: ${configPaths.local}${configLayerSuffix(
      trust?.grants.config === true,
    )}`,
    "",
    "Trust",
  ];
  if (trust !== null) {
    lines.push(...formatWorkspaceTrust(trust).split("\n"));
    if (trust.source === "default" && trust.resources.length > 0) {
      lines.push(`next: codepunk trust grant ${trust.root}`);
    }
  } else {
    lines.push(`trust: unreadable (${trustError ?? "unknown error"})`);
    lines.push("project layers were skipped");
  }
  lines.push("", "Effective configuration", ...summary);
  if (warnings.length > 0) {
    lines.push("", "Warnings", ...warnings.map((warning) => `- ${warning}`));
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function commandCapabilities(options: CliOptions): Promise<number> {
  const project = await findDeliveryRoot(process.cwd());
  const paths = projectPaths(project);
  const workspaceTrust = await resolveWorkspaceTrust({
    cwd: project.cwd,
    root: project.deliveryRoot,
    home: paths.home,
    ...workspaceTrustOverride(options),
  });
  const { config } = await loadConfig(
    paths,
    process.env,
    {},
    {
      projectTrusted: workspaceTrust.grants.config,
    },
  );
  const snapshot = await collectCapabilities(paths, {
    pluginEnabled: options.allowPlugins || config.plugins.enabled,
    projectTrusted: workspaceTrust.grants.skills,
  });
  process.stdout.write(
    options.json
      ? `${JSON.stringify(snapshot, null, 2)}\n`
      : `${formatCapabilities(snapshot)}\n`,
  );
  return snapshot.mcp.error === null ? 0 : 1;
}

function parseMcpEnvironment(
  values: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of values) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new Error("--env must use KEY=VALUE");
    }
    const key = entry.slice(0, separator);
    if (Object.hasOwn(env, key)) {
      throw new Error(`duplicate --env key: ${key}`);
    }
    env[key] = entry.slice(separator + 1);
  }
  return env;
}

function parseMcpHeaders(values: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of values) {
    const separator = entry.indexOf(":");
    if (separator <= 0) {
      throw new Error("--header must use Name: value");
    }
    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (name.length === 0) {
      throw new Error("--header requires a header name");
    }
    const key = name.toLowerCase();
    if (Object.hasOwn(headers, key)) {
      throw new Error(`duplicate --header name: ${name}`);
    }
    headers[name] = value;
  }
  return headers;
}

async function promptForMcpRedirectUrl(
  signal: AbortSignal,
): Promise<string | undefined> {
  if (process.stdin.isTTY !== true) {
    return undefined;
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await readline.question(
      "If the browser cannot reach this machine, paste the full redirect URL (Enter cancels): ",
      { signal },
    );
    const trimmed = answer.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  } catch {
    return undefined;
  } finally {
    readline.close();
  }
}

async function commandMcp(options: CliOptions): Promise<number> {
  const paths = await resolveDaemonProject();
  const workspaceTrust = await resolveWorkspaceTrust({
    cwd: paths.cwd,
    root: paths.deliveryRoot,
    home: paths.home,
    ...workspaceTrustOverride(options),
  });
  const projectTrusted = workspaceTrust.grants.skills;
  const action = options.positionals[1] ?? "list";
  if (action === "list") {
    const snapshot = await collectCapabilities(paths, {
      skills: [],
      pluginFiles: [],
      projectTrusted,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(snapshot.mcp, null, 2)}\n`
        : `${formatMcpServers(snapshot.mcp).join("\n").trimStart()}\n`,
    );
    return snapshot.mcp.error === null ? 0 : 1;
  }
  if (action === "login") {
    const requested = options.positionals[2];
    const configs = await readMcpConfig(paths);
    const oauthCandidates = configs.filter(
      (config) => !mcpUsesAuthorizationHeader(config),
    );
    const target =
      requested === undefined
        ? oauthCandidates.length === 1
          ? oauthCandidates[0]
          : undefined
        : configs.find((config) => config.name === requested);
    if (requested === undefined && target === undefined) {
      throw new Error(
        oauthCandidates.length === 0
          ? "mcp login requires an HTTP server without an Authorization header; none is configured"
          : `mcp login requires a server name; candidates: ${oauthCandidates.map((config) => config.name).join(", ")}`,
      );
    }
    if (target === undefined) {
      throw new Error(`MCP server ${requested} is not configured`);
    }
    if (target.transport !== "http") {
      throw new Error(
        `MCP server ${target.name} uses stdio and does not use OAuth`,
      );
    }
    if (mcpUsesAuthorizationHeader(target)) {
      throw new Error(
        `MCP server ${target.name} uses an Authorization header; remove it to use OAuth`,
      );
    }
    const store = new McpAuthStore(paths.home);
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    try {
      const result = await loginMcpServer({
        server: target.name,
        serverUrl: target.url,
        store,
        settings: oauthSettings(target.oauth, target.name),
        signal: controller.signal,
        onAuthorizationUrl: (url) => {
          const output = options.json ? process.stderr : process.stdout;
          output.write(
            [
              `MCP server ${target.name} requires authorization.`,
              "Open this URL in a browser:",
              url.href,
              "",
            ].join("\n"),
          );
        },
        ...(process.stdin.isTTY === true
          ? { promptForRedirectUrl: promptForMcpRedirectUrl }
          : {}),
      });
      const status = await store.status(target.name, target.url);
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              server: target.name,
              url: target.url,
              signed_in: status.signed_in,
              already_authorized: result.already_authorized,
              expires_at: status.expires_at,
              scope: status.scope,
              credentials: store.path,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        process.stdout.write(
          [
            result.already_authorized
              ? `MCP server ${target.name} already had usable credentials`
              : `signed in to MCP server ${target.name}`,
            `signed in: ${status.signed_in ? "yes" : "no"}`,
            `expires: ${status.expires_at ?? "not reported"}`,
            `scope: ${status.scope ?? "not reported"}`,
            `credentials: ${store.path}`,
          ].join("\n") + "\n",
        );
      }
      return 0;
    } catch (error) {
      if (controller.signal.aborted) {
        process.stderr.write("MCP sign-in cancelled\n");
        return 130;
      }
      throw error;
    } finally {
      process.removeListener("SIGINT", abort);
    }
  }
  if (action === "logout") {
    const name = options.positionals[2];
    if (name === undefined) {
      throw new Error("usage: codepunk mcp logout <name>");
    }
    const configs = await readMcpConfig(paths);
    const target = configs.find((config) => config.name === name);
    if (target === undefined) {
      throw new Error(`MCP server ${name} is not configured`);
    }
    if (target.transport !== "http") {
      throw new Error(
        `MCP server ${name} uses stdio and has no OAuth credentials`,
      );
    }
    const removed = await new McpAuthStore(paths.home).remove(
      target.name,
      target.url,
    );
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ server: name, removed })}\n`
        : `${removed ? "removed" : "no stored"} OAuth credentials for MCP server ${name}\n`,
    );
    return 0;
  }
  if (action === "status") {
    const name = options.positionals[2];
    const configs = await readMcpConfig(paths);
    const selected =
      name === undefined
        ? configs
        : configs.filter((config) => config.name === name);
    if (name !== undefined && selected.length === 0) {
      throw new Error(`MCP server ${name} is not configured`);
    }
    const store = new McpAuthStore(paths.home);
    const rows = await Promise.all(
      selected.map(async (config) => {
        if (config.transport !== "http") {
          return {
            server: config.name,
            transport: "stdio",
            auth: "none",
            signed_in: false,
            expires_at: null,
            scope: null,
          };
        }
        const status = mcpUsesAuthorizationHeader(config)
          ? { signed_in: false, expires_at: null, scope: null }
          : await store.status(config.name, config.url);
        return {
          server: config.name,
          transport: "http",
          auth: mcpUsesAuthorizationHeader(config) ? "header" : "oauth",
          ...status,
        };
      }),
    );
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ servers: rows, credentials: store.path }, null, 2)}\n`,
      );
    } else if (rows.length === 0) {
      process.stdout.write("No MCP servers configured.\n");
    } else {
      const lines = ["MCP authentication status:"];
      for (const row of rows) {
        lines.push(
          `  ${row.server}: ${row.auth}${
            row.auth === "oauth"
              ? row.signed_in
                ? " · signed in"
                : " · not signed in"
              : ""
          }`,
        );
        if (row.expires_at !== null) {
          lines.push(`    expires: ${row.expires_at}`);
        }
        if (row.scope !== null) {
          lines.push(`    scope: ${row.scope}`);
        }
      }
      lines.push(`credentials: ${store.path}`);
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    return 0;
  }
  if (action === "add") {
    const name = options.positionals[2];
    const command = options.positionals[3];
    if (name === undefined) {
      throw new Error(
        "usage: codepunk mcp add <name> [options] -- <command> [args...], or codepunk mcp add <name> --url <url>",
      );
    }
    if (options.url !== undefined) {
      if (
        command !== undefined ||
        options.env.length > 0 ||
        options.cwd !== undefined
      ) {
        throw new Error(
          "--url cannot be combined with a command, --env, or --cwd",
        );
      }
      const configPath = await writeMcpServer(
        paths,
        {
          name,
          url: options.url,
          headers: parseMcpHeaders(options.headers),
        },
        { force: options.force },
      );
      process.stdout.write(
        `added HTTP MCP server ${name}\nconfig: ${configPath}\ncheck: codepunk mcp test ${name}\n`,
      );
      return 0;
    }
    if (command === undefined) {
      throw new Error(
        "usage: codepunk mcp add <name> [options] -- <command> [args...], or codepunk mcp add <name> --url <url>",
      );
    }
    if (options.headers.length > 0) {
      throw new Error("--header is only valid with --url");
    }
    const configPath = await writeMcpServer(
      paths,
      {
        name,
        command,
        args: options.positionals.slice(4),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: parseMcpEnvironment(options.env),
      },
      { force: options.force },
    );
    process.stdout.write(
      `added MCP server ${name}\nconfig: ${configPath}\ncheck: codepunk mcp test ${name}\n`,
    );
    return 0;
  }
  if (action === "remove") {
    const name = options.positionals[2];
    if (name === undefined) {
      throw new Error("usage: codepunk mcp remove <name>");
    }
    const configPath = await removeMcpServer(paths, name);
    process.stdout.write(`removed MCP server ${name}\nconfig: ${configPath}\n`);
    return 0;
  }
  if (action === "test") {
    const name = options.positionals[2];
    const bundle = await loadMcpTools({
      paths,
      strict: false,
      ...(name === undefined ? {} : { only: [name] }),
    });
    try {
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              servers: bundle.servers,
              tool_counts: bundle.toolCounts,
              tools: bundle.tools.map((tool) => tool.name),
              resource_servers: bundle.resourceServers,
              resource_tools: bundle.resourceTools.map((tool) => tool.name),
              failures: bundle.failures,
            },
            null,
            2,
          )}\n`,
        );
      } else if (bundle.servers.length === 0 && bundle.failures.length === 0) {
        process.stdout.write("No MCP servers configured.\n");
      } else {
        const lines = ["MCP connection check:"];
        for (const server of bundle.servers) {
          const count = bundle.toolCounts[server] ?? 0;
          const resources = bundle.resourceServers.includes(server)
            ? ", resources available"
            : "";
          lines.push(
            `  ${server}: ok, ${count} tool${count === 1 ? "" : "s"}${resources}`,
          );
        }
        for (const failure of bundle.failures) {
          lines.push(`  ${failure.server}: failed, ${failure.message}`);
        }
        process.stdout.write(`${lines.join("\n")}\n`);
      }
      if (bundle.failures.length > 0) {
        process.stderr.write(
          `${bundle.failures.map((failure) => failure.message).join("\n")}\n`,
        );
        process.exitCode = 1;
      }
    } finally {
      await bundle.close();
    }
    return bundle.failures.length > 0 ? 1 : 0;
  }
  throw new Error(`unknown mcp command: ${action}`);
}

function formatSkillInventory(bundle: SkillBundle): string {
  const lines = [`Skills (${bundle.skills.length})`];
  if (bundle.skills.length === 0) {
    lines.push("  none");
  } else {
    for (const skill of bundle.skills) {
      lines.push(
        `  ${skill.scope.padEnd(7)} ${skill.name}  ${skill.bytes} B  ${skill.sha256.slice(0, 19)}`,
      );
      if (skill.description !== null && skill.description.length > 0) {
        lines.push(`          ${skill.description}`);
      }
      lines.push(`          ${skill.path}`);
    }
  }
  for (const warning of bundle.warnings) {
    lines.push(`  warning: ${warning}`);
  }
  lines.push(
    "",
    "add:    codepunk skills add <dir> [--scope user|project]",
    "remove: codepunk skills remove <name> [--scope user|project]",
    "skill changes take effect on the next Codepunk process",
  );
  return lines.join("\n");
}

async function commandSkills(options: CliOptions): Promise<number> {
  const project = await findDeliveryRoot(process.cwd());
  const paths = projectPaths(project);
  const action = options.positionals[1] ?? "list";
  if (action === "list") {
    const workspaceTrust = await resolveWorkspaceTrust({
      cwd: project.cwd,
      root: project.deliveryRoot,
      home: paths.home,
      ...workspaceTrustOverride(options),
    });
    const bundle = await loadSkills({
      deliveryRoot: paths.deliveryRoot,
      codepunkHome: paths.home,
      projectTrusted: workspaceTrust.grants.skills,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(
            { skills: bundle.skills, warnings: bundle.warnings },
            null,
            2,
          )}\n`
        : `${formatSkillInventory(bundle)}\n`,
    );
    return 0;
  }
  const scope = options.scope ?? "user";
  if (action === "add") {
    const source = options.positionals[2];
    if (source === undefined) {
      throw new Error(
        "usage: codepunk skills add <dir> [--scope user|project] [--force]",
      );
    }
    const result = await installSkill({
      paths,
      source,
      scope,
      force: options.force,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `installed skill ${result.skill.name} (${scope})`,
          `path: ${result.target}`,
          "applies to the next Codepunk process",
        ].join("\n") + "\n",
      );
    }
    return 0;
  }
  if (action === "remove") {
    const name = options.positionals[2];
    if (name === undefined) {
      throw new Error(
        "usage: codepunk skills remove <name> [--scope user|project]",
      );
    }
    const target = await removeSkill({ paths, name, scope });
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ scope, name, target }, null, 2)}\n`
        : `removed skill ${name} (${scope})\npath: ${target}\n`,
    );
    return 0;
  }
  throw new Error(`unknown skills command: ${action}`);
}

async function commandPlugins(options: CliOptions): Promise<number> {
  const { paths, config } = await resolveProject(options);
  const extensionDir = path.join(paths.home, "extensions");
  const action = options.positionals[1] ?? "list";
  if (action === "list") {
    const files = await listUserPluginFiles(extensionDir);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            enabled: config.plugins.enabled,
            directory: extensionDir,
            files,
            applies: "next-process",
          },
          null,
          2,
        )}\n`,
      );
    } else {
      const lines = [
        `Plugins (${config.plugins.enabled ? "enabled" : "disabled"}, ${files.length} file${
          files.length === 1 ? "" : "s"
        })`,
        `directory: ${extensionDir}`,
        ...(files.length === 0 ? ["  none"] : files.map((file) => `  ${file}`)),
        "",
        "add:     codepunk plugins add <file> [--force]",
        "remove:  codepunk plugins remove <file>",
        "enable:  codepunk plugins enable",
        "disable: codepunk plugins disable",
        "plugin state takes effect on the next Codepunk process",
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    return 0;
  }
  if (action === "enable" || action === "disable") {
    const enabled = action === "enable";
    const configPath = await writeUserPluginsEnabled(paths, enabled);
    process.stdout.write(
      options.json
        ? `${JSON.stringify(
            { enabled, config: configPath, applies: "next-process" },
            null,
            2,
          )}\n`
        : [
            `plugins ${enabled ? "enabled" : "disabled"}`,
            `config: ${configPath}`,
            "applies to the next Codepunk process; the current process is unchanged",
          ].join("\n") + "\n",
    );
    return 0;
  }
  if (action === "add") {
    const source = options.positionals[2];
    if (source === undefined) {
      throw new Error("usage: codepunk plugins add <file> [--force]");
    }
    const target = await installUserPlugin({
      extensionDir,
      source,
      force: options.force,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ target, applies: "next-process" }, null, 2)}\n`
        : [
            `installed plugin ${path.basename(target)}`,
            `path: ${target}`,
            "load with `codepunk plugins enable`, or `--allow-plugins` for one TUI run",
            "plugin effects are uncovered and plugin tools are rejected",
          ].join("\n") + "\n",
    );
    return 0;
  }
  if (action === "remove") {
    const name = options.positionals[2];
    if (name === undefined) {
      throw new Error("usage: codepunk plugins remove <file>");
    }
    const target = await removeUserPlugin({
      extensionDir,
      name: path.basename(name),
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ target }, null, 2)}\n`
        : `removed plugin ${path.basename(target)}\npath: ${target}\n`,
    );
    return 0;
  }
  throw new Error(`unknown plugins command: ${action}`);
}

function formatPermissions(
  config: CodepunkConfig,
  configPath: string,
  workspaceTrust: WorkspaceTrust,
  additionalRoots: readonly string[] = [],
): string {
  const profile = permissionProfileFor(config);
  const trustWord =
    workspaceTrust.mode === "all"
      ? "trusted"
      : workspaceTrust.mode === "none"
        ? "untrusted"
        : "custom";
  return [
    `profile: ${profile}`,
    `trust: ${trustWord} (${workspaceTrust.source})`,
    ...(workspaceTrust.available.length === 0
      ? []
      : [
          `trust resources: ${workspaceTrust.available
            .map(
              (kind) =>
                `${kind}=${
                  workspaceTrust.grants[kind] ? "allowed" : "skipped"
                }`,
            )
            .join(", ")}`,
        ]),
    `approvals: ${config.approval.mode}`,
    `approval reviewer: ${config.approval.reviewer}${
      config.approval.reviewer === "off"
        ? ""
        : ` (${config.approval.reviewer_model ?? "session model"}, ${config.approval.reviewer_timeout_ms} ms)`
    }`,
    `autonomy: ${config.autonomy.profile}`,
    `behavior: ${permissionBehaviorSummary(config)}`,
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
    ...(additionalRoots.length === 0
      ? []
      : [`extra file roots: ${additionalRoots.join(", ")}`]),
    ...(config.filesystem.mode === "full"
      ? [
          "startup: blocked until --dangerously-bypass-approvals-and-sandbox is supplied; this view is not the current execution state",
        ]
      : []),
    config.sandbox.mode === "required"
      ? "shell: srt when available; run codepunk doctor if unavailable"
      : "shell: disabled unless started with --allow-unsandboxed-shell; uncovered executions are recorded",
    "safe reads: date, identity, and workspace inspection need no approval",
    `config: ${configPath}`,
    `trust store: ${workspaceTrust.storePath}`,
    "",
    "usage:",
    `  codepunk permissions profile ${PERMISSION_PROFILE_NAMES.join("|")}`,
    `  codepunk permissions approval ${APPROVAL_MODE_NAMES.join("|")}`,
    "  codepunk permissions reviewer show|off|model [provider/model]|timeout <ms>",
    "  codepunk permissions autonomy read-only|ask|scoped",
    "  codepunk permissions sandbox required|uncovered",
    "  codepunk permissions sandbox network [allow|deny <domain>...|clear]",
    "  codepunk permissions filesystem workspace|full",
    "  codepunk permissions rules",
    "  codepunk permissions why -- <shell command>",
    "  codepunk trust [status|grant|revoke] [path] [--resources <kinds>]",
  ].join("\n");
}

async function permissionExecutionForWhy(
  options: CliOptions,
  paths: ReturnType<typeof projectPaths>,
  config: CodepunkConfig,
  writeSet: readonly string[],
  additionalRoots: readonly string[],
): Promise<PermissionExecution> {
  const filesystemIssue = filesystemFullStartupIssue(
    config.filesystem.mode,
    false,
  );
  if (filesystemIssue !== null) {
    return {
      status: "blocked",
      reason: filesystemIssue,
    };
  }
  if (config.sandbox.mode === "uncovered") {
    return options.allowUnsandboxedShell
      ? { status: "available", reason: null }
      : {
          status: "blocked",
          reason: shellUnavailableReason("uncovered"),
        };
  }
  if (process.platform === "win32") {
    const issue = await probeSrtSandbox({
      cwd: paths.cwd,
      workspaceRoot: paths.deliveryRoot,
      deliveryRoot: paths.deliveryRoot,
      additionalRoots,
      codepunkHome: paths.home,
      writeSet,
    });
    return issue === null
      ? { status: "available", reason: null }
      : {
          status: "blocked",
          reason: `${shellUnavailableReason("required")} (${issue})`,
        };
  }
  try {
    const sandbox = await SrtSandbox.create({
      cwd: paths.cwd,
      workspaceRoot: paths.deliveryRoot,
      deliveryRoot: paths.deliveryRoot,
      additionalRoots,
      codepunkHome: paths.home,
      writeSet,
    });
    await sandbox.close();
    return { status: "available", reason: null };
  } catch (error) {
    return {
      status: "blocked",
      reason: `${shellUnavailableReason("required")} (${
        error instanceof Error ? error.message : String(error)
      })`,
    };
  }
}

async function commandTrust(options: CliOptions): Promise<number> {
  const actions = new Set(["status", "grant", "revoke"]);
  let action = options.positionals[1] ?? "status";
  let targetArgument = options.positionals[2];
  if (!actions.has(action)) {
    targetArgument = action;
    action = "status";
  }
  const consumed = targetArgument === undefined ? 2 : 3;
  if (options.positionals.length > consumed) {
    throw new Error(
      "usage: codepunk trust [status|grant|revoke] [path] [--resources <kinds>]",
    );
  }
  if (options.resources !== undefined && action === "status") {
    throw new Error("--resources only applies to trust grant or trust revoke");
  }
  const target = path.resolve(targetArgument ?? process.cwd());
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new Error(`trust path does not exist: ${target}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`trust path is not a directory: ${target}`);
  }
  const project = await findDeliveryRoot(target);
  const paths = projectPaths(project);
  if (action === "grant" || action === "revoke") {
    const trusted = action === "grant";
    const grants =
      options.resources === undefined
        ? allWorkspaceTrustGrants(trusted)
        : applyWorkspaceTrustGrantChanges(
            await readSavedWorkspaceTrustGrants(
              paths.home,
              project.deliveryRoot,
            ),
            options.resources,
            trusted,
          );
    const saved = await saveWorkspaceTrustGrants(
      paths.home,
      project.deliveryRoot,
      grants,
      "cli",
    );
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          action,
          root: project.deliveryRoot,
          decision: trusted ? "trusted" : "untrusted",
          grants,
          store: saved.storePath,
          resource_store: saved.resourceStorePath,
          applies: "future-sessions",
        })}\n`,
      );
    } else {
      process.stdout.write(
        [
          `trust decision saved: ${trusted ? "trusted" : "untrusted"}`,
          `root: ${project.deliveryRoot}`,
          `resources: ${WORKSPACE_TRUST_RESOURCE_KINDS.map(
            (kind) => `${kind}=${grants[kind] ? "allowed" : "skipped"}`,
          ).join(", ")}`,
          `store: ${saved.storePath}`,
          `resource store: ${saved.resourceStorePath}`,
          "applies to future sessions; restart Codepunk to load or skip project resources",
        ].join("\n") + "\n",
      );
    }
    return 0;
  }
  const workspaceTrust = await resolveWorkspaceTrust({
    cwd: project.cwd,
    root: project.deliveryRoot,
    home: paths.home,
  });
  const previews = await previewWorkspaceTrustResources(
    project.deliveryRoot,
    project.cwd,
  );
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        trusted: workspaceTrust.trusted,
        mode: workspaceTrust.mode,
        grants: workspaceTrust.grants,
        available: workspaceTrust.available,
        source: workspaceTrust.source,
        cwd: workspaceTrust.cwd,
        root: workspaceTrust.root,
        saved_path: workspaceTrust.savedPath,
        resources: workspaceTrust.resources,
        resource_details: previews,
        store: workspaceTrust.storePath,
        resource_store: workspaceTrust.resourceStorePath,
      })}\n`,
    );
  } else {
    process.stdout.write(
      `${formatWorkspaceTrust(workspaceTrust, previews)}\n` +
        "Use codepunk trust grant|revoke [--resources <kinds>] to save a decision; --trust, --no-trust, and --trust-resources apply to one run.\n",
    );
  }
  return 0;
}

async function commandPermissions(options: CliOptions): Promise<number> {
  if (options.positionals.length < 2 || options.positionals[1] === "show") {
    const { paths, config, workspaceTrust } = await resolveProject(options);
    const text = formatPermissions(
      config,
      path.join(paths.home, "config.toml"),
      workspaceTrust,
      paths.additionalRoots,
    );
    process.stdout.write(
      options.json
        ? `${JSON.stringify({
            summary: configSummary(config, paths.additionalRoots),
            config_path: path.join(paths.home, "config.toml"),
            workspace_trust: workspaceTrust,
            additional_roots: paths.additionalRoots,
          })}\n`
        : `${text}\n`,
    );
    return 0;
  }
  const group = options.positionals[1];
  const value = options.positionals[2];
  if (group === "rules") {
    const { paths, config } = await resolveProject(options);
    if (config.autonomy.scoped_rules === null) {
      if (options.json) {
        process.stdout.write("[]\n");
        return 0;
      }
      process.stdout.write(
        'scoped rules: none; choose "Always allow this exact command" in an approval, or pass --scoped-rules <path>\n',
      );
      return 0;
    }
    const loaded = await loadScopedRules(config.autonomy.scoped_rules, paths);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(loaded.rules)}\n`);
      return 0;
    }
    process.stdout.write(
      [
        `scoped rules: ${loaded.rules.length}`,
        `file: ${loaded.path}`,
        ...loaded.rules.map(
          (rule) => `  ${rule.id}: ${rule.argv.join(" ")} (cwd ${rule.cwd})`,
        ),
      ].join("\n") + "\n",
    );
    return 0;
  }
  if (group === "why") {
    const command = options.positionals.slice(2).join(" ").trim();
    if (command.length === 0) {
      throw new Error("permissions why requires a shell command");
    }
    const { paths, config, workspaceTrust } = await resolveProject(options);
    const policy = await loadPolicyFiles(paths, {
      projectTrusted: workspaceTrust.grants.policy,
    });
    const writeSet = [
      ...new Set([
        ...(policy.writeSet.length > 0 ? policy.writeSet : [paths.cwd]),
        ...paths.additionalRoots,
      ]),
    ];
    const decision = decidePolicy({
      tool: "bash",
      command,
      cwd: paths.cwd,
      workspaceRoot: paths.deliveryRoot,
      additionalRoots: paths.additionalRoots,
      deliveryRoot: paths.deliveryRoot,
      codepunkHome: paths.home,
      autonomy: config.autonomy.profile,
      filesystem: config.filesystem.mode,
      writeSet,
      userRules: policy.userRules,
      projectRules: policy.projectRules,
      layers: policy.layers,
    });
    let scopedRules: ScopedRule[] = [];
    let scopedRulesSha256: string | null = null;
    if (config.autonomy.profile === "scoped") {
      const loaded = await loadScopedRules(
        config.autonomy.scoped_rules!,
        paths,
      );
      scopedRules = loaded.rules;
      scopedRulesSha256 = loaded.rulesSha256;
    }
    const autonomy = new AutonomyController({
      profile: config.autonomy.profile,
      source: "user-config",
      rules: scopedRules,
      rulesSha256: scopedRulesSha256,
    });
    const explanation = await explainPermission({
      policy: decision,
      autonomy,
      approvalMode: config.approval.mode,
      tool: "bash",
      command,
      cwd: paths.cwd,
      networkAllow: config.sandbox.network_allow,
      networkDeny: config.sandbox.network_deny,
      execution: await permissionExecutionForWhy(
        options,
        paths,
        config,
        writeSet,
        paths.additionalRoots,
      ),
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(explanation)}\n`);
      return 0;
    }
    process.stdout.write(`${formatPermissionExplanation(explanation)}\n`);
    return 0;
  }
  if (group === "reviewer") {
    const { paths, config } = await resolveProject(options);
    const action = value ?? "show";
    const formatReviewer = (): string[] => [
      `reviewer: ${config.approval.reviewer}`,
      `reviewer model: ${config.approval.reviewer_model ?? "session model"}`,
      `reviewer timeout: ${config.approval.reviewer_timeout_ms} ms`,
      "scope: network commands and headless argv exec only; other asks stay human",
      "failure: ask a human interactively; deny when no channel is available",
      `config: ${path.join(paths.home, "config.toml")}`,
    ];
    if (action === "show") {
      process.stdout.write(`${formatReviewer().join("\n")}\n`);
      return 0;
    }
    if (action === "off") {
      await writeUserPermissionSelection(paths, { reviewer: "off" });
      process.stdout.write(
        [
          "approval reviewer disabled",
          "applies to the next session",
          `config: ${path.join(paths.home, "config.toml")}`,
        ].join("\n") + "\n",
      );
      return 0;
    }
    if (action === "timeout") {
      const timeout = Number(options.positionals[3]);
      if (
        options.positionals[3] === undefined ||
        !Number.isSafeInteger(timeout) ||
        timeout < 1_000
      ) {
        throw new Error(
          "permissions reviewer timeout requires an integer of at least 1000 ms",
        );
      }
      await writeUserPermissionSelection(paths, {
        reviewerTimeoutMs: timeout,
      });
      process.stdout.write(
        [
          `approval reviewer timeout set to ${timeout} ms`,
          "applies to the next session",
          `config: ${path.join(paths.home, "config.toml")}`,
        ].join("\n") + "\n",
      );
      return 0;
    }
    if (action !== "model") {
      throw new Error(
        "permissions reviewer requires show, off, model, or timeout",
      );
    }
    const model = options.positionals[3];
    if (model !== undefined && (!model.includes("/") || /\s/u.test(model))) {
      throw new Error(
        "permissions reviewer model requires provider/model or no argument",
      );
    }
    await writeUserPermissionSelection(paths, {
      reviewer: "model",
      ...(model === undefined ? {} : { reviewerModel: model }),
    });
    process.stdout.write(
      [
        "approval reviewer set to model",
        `reviewer model: ${model ?? config.approval.reviewer_model ?? "session model"}`,
        config.approval.mode === "auto"
          ? "applies to the next session"
          : "inactive until approval.mode is auto; set it with codepunk permissions approval auto",
        `config: ${path.join(paths.home, "config.toml")}`,
      ].join("\n") + "\n",
    );
    return 0;
  }
  if (group === "profile") {
    if (value === undefined || !isPermissionProfile(value)) {
      if (value === "trusted") {
        throw new Error(
          "permission profile trusted was removed because it collides with workspace trust; use auto-approve for blanket approval or codepunk trust grant for the workspace",
        );
      }
      throw new Error(
        `permissions profile requires ${PERMISSION_PROFILE_NAMES.join(", ")}`,
      );
    }
    const { paths } = await resolveProject(options);
    await writeUserPermissionProfile(paths, value as PermissionProfile);
    const settings = PERMISSION_PROFILES[value as PermissionProfile];
    process.stdout.write(
      [
        `permission profile set to ${value}`,
        `approvals ${settings.approval} · autonomy ${settings.autonomy} · sandbox ${settings.sandbox} · filesystem ${settings.filesystem}`,
        value === "full-access"
          ? "applies to the next session; it will not start without --dangerously-bypass-approvals-and-sandbox"
          : settings.sandbox === "required"
            ? "applies to the next session; run codepunk doctor if srt is unavailable"
            : "applies to the next session; no shell unless started with --allow-unsandboxed-shell",
        `config: ${path.join(paths.home, "config.toml")}`,
      ].join("\n") + "\n",
    );
    return 0;
  }
  if (
    group !== "approval" &&
    group !== "autonomy" &&
    group !== "sandbox" &&
    group !== "filesystem"
  ) {
    throw new Error(
      "permissions requires profile, approval, reviewer, autonomy, sandbox, filesystem, or why",
    );
  }
  if (value === undefined) {
    throw new Error(`permissions ${group} requires a value`);
  }
  if (group === "sandbox" && value === "network") {
    const args = options.positionals.slice(3);
    const { paths, config } = await resolveProject(options);
    const formatNetwork = (
      allow: readonly string[],
      deny: readonly string[],
    ): string[] => [
      `network allow: ${
        allow.length === 0 ? "none (deny by default)" : allow.join(", ")
      }`,
      `network deny: ${deny.length === 0 ? "none" : deny.join(", ")}`,
    ];
    if (args.length === 0 || (args.length === 1 && args[0] === "show")) {
      process.stdout.write(
        [
          ...formatNetwork(
            config.sandbox.network_allow,
            config.sandbox.network_deny,
          ),
          `config: ${path.join(paths.home, "config.toml")}`,
        ].join("\n") + "\n",
      );
      return 0;
    }
    if (args[0] === "clear") {
      const which = args[1];
      if (which !== undefined && which !== "allow" && which !== "deny") {
        throw new Error(
          "permissions sandbox network clear requires allow, deny, or no argument",
        );
      }
      await writeUserPermissionSelection(paths, {
        ...(which === undefined || which === "allow"
          ? { networkAllow: [] }
          : {}),
        ...(which === undefined || which === "deny" ? { networkDeny: [] } : {}),
      });
      const nextAllow = which === "deny" ? config.sandbox.network_allow : [];
      const nextDeny = which === "allow" ? config.sandbox.network_deny : [];
      process.stdout.write(
        [
          ...formatNetwork(nextAllow, nextDeny),
          "applies to the next session",
          `config: ${path.join(paths.home, "config.toml")}`,
        ].join("\n") + "\n",
      );
      return 0;
    }
    const list = args[0] === "allow" || args[0] === "deny" ? args[0] : "allow";
    const requested =
      args[0] === "allow" || args[0] === "deny" ? args.slice(1) : args;
    if (requested.length === 0) {
      throw new Error(
        `permissions sandbox network ${list} requires at least one domain`,
      );
    }
    const normalized =
      list === "allow"
        ? normalizeNetworkAllow(requested)
        : normalizeNetworkDeny(requested);
    const overlap = normalized.filter((entry) =>
      (list === "allow"
        ? config.sandbox.network_deny
        : config.sandbox.network_allow
      ).includes(entry),
    );
    if (overlap.length > 0) {
      throw new Error(
        `sandbox.network_deny also lists ${overlap.join(", ")}; remove it with \`codepunk permissions sandbox network clear ${list === "allow" ? "deny" : "allow"}\` first`,
      );
    }
    await writeUserPermissionSelection(
      paths,
      list === "allow"
        ? { networkAllow: normalized }
        : { networkDeny: normalized },
    );
    const nextAllow =
      list === "allow" ? normalized : config.sandbox.network_allow;
    const nextDeny = list === "deny" ? normalized : config.sandbox.network_deny;
    process.stdout.write(
      [
        ...formatNetwork(nextAllow, nextDeny),
        "applies to the next session; each approved network command still needs its own approval",
        `config: ${path.join(paths.home, "config.toml")}`,
      ].join("\n") + "\n",
    );
    return 0;
  }
  let update: PermissionConfigUpdate;
  if (group === "approval") {
    if (!(APPROVAL_MODE_NAMES as readonly string[]).includes(value)) {
      throw new Error(
        `permissions approval requires ${APPROVAL_MODE_NAMES.join(", ")}`,
      );
    }
    update = {
      approval: value as NonNullable<PermissionConfigUpdate["approval"]>,
    };
  } else if (group === "autonomy") {
    if (!["read-only", "ask", "scoped"].includes(value)) {
      throw new Error(
        "permissions autonomy requires read-only, ask, or scoped",
      );
    }
    update = {
      autonomy: value as NonNullable<PermissionConfigUpdate["autonomy"]>,
    };
  } else if (group === "sandbox") {
    if (!["required", "uncovered"].includes(value)) {
      throw new Error("permissions sandbox requires required or uncovered");
    }
    update = {
      sandbox: value as NonNullable<PermissionConfigUpdate["sandbox"]>,
    };
  } else {
    if (value !== "workspace" && value !== "full") {
      throw new Error("permissions filesystem requires workspace or full");
    }
    update = {
      filesystem: value as FilesystemMode,
    };
  }
  const { paths } = await resolveProject(options);
  await writeUserPermissionSelection(paths, update);
  process.stdout.write(
    [
      `permissions ${group} set to ${value}`,
      group === "sandbox"
        ? value === "required"
          ? "shell applies to the next session; run codepunk doctor if srt is unavailable"
          : "next session has no shell unless started with --allow-unsandboxed-shell; executions are recorded as uncovered"
        : "applies to the next session",
      `config: ${path.join(paths.home, "config.toml")}`,
    ].join("\n") + "\n",
  );
  return 0;
}

async function commandModels(options: CliOptions): Promise<number> {
  const { paths, config } = await resolveProject(options);
  const subcommand = options.positionals[1] ?? "list";
  if (subcommand === "list") {
    const catalog = await listModelCatalog(paths, config);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(catalog)}\n`);
    } else {
      process.stdout.write(`${formatModelCatalog(catalog)}\n`);
    }
    return catalog.error === null ? 0 : 1;
  }
  if (subcommand === "set") {
    const reference = options.positionals[2] ?? options.model;
    if (reference === undefined) {
      throw new Error("models set requires <provider/id>");
    }
    const runtime = await openModelRuntime(paths);
    const resolution = resolveModelSelection(runtime, reference);
    if (resolution.status !== "resolved" || !resolution.exact) {
      throw new Error(
        resolution.status === "resolved"
          ? `models set requires an exact <provider/id>; run codepunk models list`
          : resolution.error,
      );
    }
    const provider = resolution.model.provider;
    const id = resolution.model.id;
    let thinking;
    if (options.thinking !== undefined) {
      if (!isThinkingLevel(options.thinking)) {
        throw new Error(
          "--thinking must be off, minimal, low, medium, high, xhigh, or max",
        );
      }
      thinking = options.thinking;
    }
    await setConfiguredModel(paths, config, provider, id, thinking);
    process.stdout.write(
      `model set to ${provider}/${id}\nconfig: ${paths.home}/config.toml\n`,
    );
    return 0;
  }
  if (subcommand === "test") {
    const reference = options.positionals[2] ?? options.model;
    const result = await testConfiguredModel(paths, config, reference);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(
        [
          `model: ${result.provider}/${result.id}`,
          `status: ${result.ok ? "ok" : "failed"}`,
          `stop: ${result.stop_reason}`,
          `latency: ${result.latency_ms} ms`,
          `tokens: input ${result.input_tokens}, output ${result.output_tokens}, total ${result.total_tokens}`,
          ...(result.text.length === 0 ? [] : [`text: ${result.text}`]),
          ...(result.error === null ? [] : [`error: ${result.error}`]),
        ].join("\n") + "\n",
      );
    }
    return result.ok ? 0 : 1;
  }
  if (subcommand === "remove") {
    const providerId = options.positionals[2];
    if (providerId === undefined || providerId.length === 0) {
      throw new Error("models remove requires <provider>");
    }
    if (config.model.provider === providerId) {
      throw new Error(
        `provider ${providerId} owns the selected model; choose another default with codepunk models set before removing it`,
      );
    }
    const referenced = config.model.fallback.filter((reference) =>
      reference.startsWith(`${providerId}/`),
    );
    if (referenced.length > 0) {
      throw new Error(
        `provider ${providerId} is still referenced by model.fallback: ${referenced.join(", ")}; update the fallback chain first`,
      );
    }
    const result = await removeModelsProvider(paths, providerId);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    process.stdout.write(
      [
        `removed provider ${result.providerId} from ${result.path}`,
        result.remaining.length === 0
          ? "no custom providers remain"
          : `remaining providers: ${result.remaining.join(", ")}`,
      ].join("\n") + "\n",
    );
    return 0;
  }
  if (subcommand === "import") {
    const baseUrl = options.baseUrl ?? options.positionals[2];
    if (baseUrl === undefined) {
      throw new Error("models import requires <base-url>");
    }
    const provider = options.provider;
    if (provider === undefined || provider.length === 0) {
      throw new Error("models import requires --provider <id>");
    }
    const api = options.api ?? "openai-responses";
    if (api !== "openai-responses" && api !== "openai-completions") {
      throw new Error(
        "--api must be openai-responses or openai-completions for model discovery",
      );
    }
    const filters =
      options.model === undefined
        ? undefined
        : options.model
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
    const result = await importProviderModels(paths, {
      baseUrl,
      providerId: provider,
      api,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      authHeader: options.authHeader,
      ...(filters === undefined ? {} : { models: filters }),
    });
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          provider: result.providerId,
          baseUrl: result.baseUrl,
          api: result.api,
          modelCount: result.models.length,
          models: result.models.map((model) => model.id),
          path: result.path,
        })}\n`,
      );
      return 0;
    }
    process.stdout.write(
      [
        `imported ${result.models.length} model(s) into ${result.path}`,
        `provider: ${result.providerId} · ${result.baseUrl} · ${result.api}${
          options.authHeader ? " · bearer auth" : ""
        }`,
        "next: codepunk models list",
        `      codepunk models set ${result.providerId}/<model-id>`,
      ].join("\n") + "\n",
    );
    return 0;
  }
  throw new Error(`unknown models command: ${subcommand}`);
}

async function commandPackage(
  options: CliOptions,
  verb: "install" | "upgrade" | "uninstall",
): Promise<number> {
  const targetVersion = options.packageVersion ?? (await readCliVersion());
  if (verb === "install" && targetVersion === UNPUBLISHED_VERSION) {
    throw new Error(
      "0.0.0 is the unpublished placeholder version and codepunk-cli is not published at it; install from the repository checkout or pass --package-version <published-version>",
    );
  }
  const base = {
    prefix: options.prefix ?? null,
    cwd: process.cwd(),
    dryRun: options.dryRun,
  };
  const result =
    verb === "install"
      ? await installPackage({
          ...base,
          version: targetVersion,
        })
      : verb === "upgrade"
        ? await upgradePackage(base)
        : await uninstallPackage(base);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  const command = `${result.command.command} ${result.command.args.join(" ")}`;
  if (result.dryRun) {
    process.stdout.write(`${command}\n`);
    return 0;
  }
  if (verb === "install") {
    process.stdout.write(
      `installed ${result.packageName}@${result.version ?? "latest"}${result.prefix === null ? " globally" : ` at ${result.prefix}`}\n`,
    );
  } else if (verb === "upgrade") {
    process.stdout.write(
      `upgraded ${result.packageName} from ${result.previousVersion ?? "(not installed)"} to ${result.version ?? "latest"}\n`,
    );
  } else {
    process.stdout.write(`uninstalled ${result.packageName}\n`);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const options = parseCli(argv);
  const command = options.positionals[0];
  if (options.guardedHostLaunch) {
    verifyGuardedHostLaunch();
  }
  if (options.version) {
    process.stdout.write(`${formatBuildIdentity(await inspectCliBuild())}\n`);
    return 0;
  }
  if (options.help) {
    const scoped = subcommandUsage(command);
    if (scoped !== undefined) {
      process.stdout.write(scoped);
      return 0;
    }
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (command === "gc") {
    return commandGc(options);
  }
  if (command === "migrate") {
    return commandMigrate(options);
  }
  if (command === "backup") {
    return commandBackup(options);
  }
  if (command === "sessions" || command === "prune") {
    return commandSessions(options);
  }
  if (command === "export") {
    return commandExport(options);
  }
  if (command === "pin") {
    return commandPin(options);
  }
  if (command === "sign") {
    return commandSign(options);
  }
  if (command === "memory") {
    return commandMemory(options);
  }
  if (command === "models") {
    return commandModels(options);
  }
  if (command === "doctor") {
    return commandDoctor(options);
  }
  if (command === "config") {
    return commandConfig(options);
  }
  if (command === "permissions" || command === "permission") {
    return commandPermissions(options);
  }
  if (command === "trust") {
    return commandTrust(options);
  }
  if (command === "capabilities") {
    return commandCapabilities(options);
  }
  if (command === "mcp") {
    return commandMcp(options);
  }
  if (command === "skills") {
    return commandSkills(options);
  }
  if (command === "plugins") {
    return commandPlugins(options);
  }
  if (command === "daemon") {
    return commandDaemon(options);
  }
  if (command === "view") {
    return commandView(options);
  }
  if (command === "acp") {
    return commandAcp();
  }
  if (command === "completion") {
    return commandCompletion(options);
  }
  if (
    command === "install" ||
    command === "upgrade" ||
    command === "uninstall"
  ) {
    return commandPackage(options, command);
  }
  const prompt = await readPrompt(options.positionals);
  const usePrint = options.print || process.stdin.isTTY !== true;
  if (usePrint) {
    if (prompt === null) {
      throw new Error("print mode requires a prompt or piped stdin");
    }
    return runPrint(options, prompt);
  }
  return runTui(options);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `codepunk: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = error instanceof ConfigError ? 2 : 1;
  });
