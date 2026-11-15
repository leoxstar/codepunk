import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CustomEditor,
  type ExtensionCommandContext,
  type ExtensionContext,
  type InlineExtension,
  getPackageDir,
} from "@earendil-works/pi-coding-agent";
import {
  ChildHostError,
  CheckpointConflictError,
  APPROVAL_MODE_NAMES,
  DEFAULT_PROTECTED_PATHS,
  PERMISSION_PROFILE_NAMES,
  PERMISSION_PROFILES,
  PI_INSTRUCTION_FILE_NAMES,
  autonomyRulesHash,
  collectCapabilities,
  createHandoff,
  createGitCommit,
  createTaskSpec,
  configSummary,
  decidePolicy,
  discardWorktree,
  explainPermission,
  exportSession,
  findDeliveryRoot,
  forkLiveSession,
  freezeWorktree,
  formatCapabilities,
  formatDoctor,
  formatAgentProfiles,
  formatPlan,
  formatPermissionExplanation,
  formatTodos,
  formatWorkspaceTrust,
  formatMcpServers,
  formatSessionList,
  isFallbackModel,
  isPermissionProfile,
  listUserPluginFiles,
  listProjectSessions,
  loadAgentProfiles,
  loadScopedRules,
  LOCK_LEASE_MS,
  loginMcpServer,
  McpAuthStore,
  mcpUsesAuthorizationHeader,
  normalizeNetworkAllow,
  normalizeNetworkDeny,
  oauthSettings,
  persistScopedRule,
  permissionBehaviorSummary,
  permissionProfileFor,
  previewWorkspaceTrustResources,
  readMcpConfig,
  removeMcpServer,
  readOnlyLiveWidenIssue,
  readOnlyLiveSwitchIssue,
  readLock,
  readWorkspaceCommitPreview,
  readWorkspaceDiff,
  readSkillInvocation,
  readWorkState,
  readSavedWorkspaceTrust,
  mergeHandoff,
  projectPaths,
  removeMergedWorktree,
  SessionStore,
  createUlid,
  runSubagentHost,
  runDoctor,
  resolveConfiguredModel,
  resolveModelSelection,
  saveWorkspaceTrust,
  signRun,
  staleLockReason,
  setConfiguredModel,
  writeHandoff,
  outputSha,
  recordHash,
  redactOutputPreview,
  sha256Text,
  writeMcpServer,
  writeUserPermissionProfile,
  writeUserPermissionSelection,
  writeUserThinkingSelection,
  type ApprovalChannel,
  type AgentProfile,
  type CheckpointPreview,
  type CodepunkRuntime,
  type FilesystemMode,
  type GitCommitStage,
  type GitCommitResult,
  type McpReloadResult,
  type McpServerConfig,
  type McpServerInput,
  type PermissionProfile,
  type PluginReloadResult,
  type SkillReloadResult,
  type SubagentHostResult,
  type SubagentStreamEvent,
  type WorkspaceCommitPreview,
  type WorkspaceDiff,
} from "@codepunk/core";
import type {
  ApprovalAnswer,
  ApprovalRequest,
  ApprovalScope,
  MergeRecord,
  TaskHandoff,
  Verdict,
} from "@codepunk/protocol";
import { appendBuildDoctorCheck, inspectCliBuild } from "./build-info.ts";

export interface TuiState {
  runtime: CodepunkRuntime | null;
  context: ExtensionContext | null;
  channel: TuiApprovalChannel;
  lastRunId: string | null;
  lastEvidence: number;
  warningsShown: boolean;
  modelSelected: boolean;
  modelOnboardingShown?: boolean;
  ready: boolean;
  childHostArgv: readonly string[];
  subagents?: Map<string, BackgroundSubagent>;
  /**
   * Slash command names the Pi host will accept in this session. Pi's builtin
   * table is not exported from the package root, and `pi.getCommands()` covers
   * only extensions, prompts, and skills, so the accepted set is loaded from
   * the installed host module at session start.
   */
  hostCommands: Set<string>;
  replaceRuntime?: (target: TuiSessionTarget) => Promise<TuiRuntimeReplacement>;
}

export interface TuiSessionTarget {
  sessionId?: string;
  newSession?: boolean;
}

export interface TuiRuntimeReplacement {
  runtime: CodepunkRuntime;
  context: ExtensionCommandContext;
}

interface PiBuiltinSlashCommand {
  name: string;
  description: string;
}

/**
 * Pi's root export intentionally omits the builtin slash table. Read the
 * installed package's real table instead of copying it; if a Pi upgrade moves
 * that module, the session start fails loudly rather than silently rejecting
 * a legal command.
 */
export async function loadPiBuiltinSlashCommands(): Promise<
  readonly PiBuiltinSlashCommand[]
> {
  const modulePath = path.join(
    getPackageDir(),
    "dist",
    "core",
    "slash-commands.js",
  );
  const moduleUrl = pathToFileURL(modulePath).href;
  const loaded = (await import(moduleUrl)) as {
    BUILTIN_SLASH_COMMANDS?: unknown;
  };
  if (
    !Array.isArray(loaded.BUILTIN_SLASH_COMMANDS) ||
    loaded.BUILTIN_SLASH_COMMANDS.some(
      (command) =>
        command === null ||
        typeof command !== "object" ||
        typeof (command as PiBuiltinSlashCommand).name !== "string" ||
        typeof (command as PiBuiltinSlashCommand).description !== "string",
    )
  ) {
    throw new Error(
      `Pi builtin slash commands are missing or malformed at ${modulePath}`,
    );
  }
  return loaded.BUILTIN_SLASH_COMMANDS as PiBuiltinSlashCommand[];
}

async function persistPiDefaultModel(
  runtime: CodepunkRuntime,
  notify?: (message: string, level: "info" | "warning") => void,
): Promise<boolean> {
  const settings = runtime.host.services.settingsManager;
  const provider = settings.getDefaultProvider();
  const id = settings.getDefaultModel();
  if (provider === undefined || id === undefined) {
    return false;
  }
  if (isFallbackModel({ provider, id })) {
    return false;
  }
  if (
    runtime.config.model.provider === provider &&
    runtime.config.model.id === id
  ) {
    return false;
  }
  try {
    await setConfiguredModel(runtime.paths, runtime.config, provider, id);
    notify?.(
      `model set to ${provider}/${id}\nconfig: ${runtime.paths.home}/config.toml`,
      "info",
    );
    return true;
  } catch (error) {
    notify?.(
      `model default ${provider}/${id} is active in Pi but was not saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "warning",
    );
    return false;
  }
}

function isSlashCommand(text: string, name: string): boolean {
  return text === name || text.startsWith(`${name} `);
}

export interface BackgroundSubagent {
  childSessionId: string;
  prompt: string;
  profile: string | null;
  isolation: "shared" | "worktree";
  startedAt: number;
  status: "running" | "completed" | "failed" | "stopped";
  result: SubagentHostResult | null;
  error: string | null;
  worktree: string | null;
  streamTail: string;
  lastTool: string | null;
  lastStreamUpdate: number;
  delivery: BackgroundSubagentDelivery | null;
  controller: AbortController;
  promise: Promise<void>;
}

interface BackgroundSubagentDelivery {
  state: "signed" | "signed-incomplete" | "merged" | "discarded";
  verdict: Verdict;
  handoff?: TaskHandoff;
  handoffPath?: string;
  merge?: MergeRecord;
  mergeRecordPath?: string;
}

interface Renderable {
  render(width: number): string[];
  invalidate(): void;
}

function component(text: () => string, visible: () => boolean): Renderable {
  return {
    render: () => (visible() ? text().split("\n") : []),
    invalidate: () => {},
  };
}

function setRuntimeStatus(
  state: TuiState,
  context: ExtensionContext,
  key: string,
  value: string | undefined,
): void {
  context.ui.setStatus(
    key,
    state.runtime?.config.tui.status === true ? value : undefined,
  );
}

function formatApproval(request: ApprovalRequest): string {
  const lines = [
    "Approval required",
    ...(request.tool === undefined ? [] : [`action: ${request.tool}`]),
    ...(request.command === undefined ? [] : [`command: ${request.command}`]),
    ...(request.argv === undefined
      ? []
      : [`exact argv: ${request.argv.join(" ")}`]),
    ...(request.cwd === undefined ? [] : [`cwd: ${request.cwd}`]),
    ...(request.path === undefined ? [] : [`path: ${request.path}`]),
    ...(request.reason === undefined ? [] : [`why: ${request.reason}`]),
    ...(request.args_preview === undefined
      ? []
      : ["arguments:", request.args_preview]),
    ...(request.coverage_preview === undefined
      ? []
      : [`coverage: ${request.coverage_preview}`]),
    ...(request.diff_preview === undefined
      ? []
      : ["proposed diff:", request.diff_preview]),
    `session: ${request.session_id}`,
    `worker: ${request.worker_id}`,
    `tool call: ${request.tool_call_id}`,
    `request: ${request.request_id}`,
    `expires: ${request.expires_at}`,
  ];
  return lines.join("\n");
}

const AUTONOMY_PROFILES = ["read-only", "ask", "scoped"] as const;
const SANDBOX_MODES = ["required", "uncovered"] as const;
const FILESYSTEM_MODES = ["workspace", "full"] as const;

function permissionUsage(): string {
  return [
    "usage:",
    `  /permissions profile ${PERMISSION_PROFILE_NAMES.join("|")}`,
    `  /permissions approval ${APPROVAL_MODE_NAMES.join("|")} · reviewer off|model`,
    "  /permissions autonomy read-only|ask|scoped",
    "  /permissions sandbox required|uncovered",
    "  /permissions sandbox network [allow|deny <domain>...|clear]",
    "  /permissions filesystem workspace|full",
    "  /permissions rules",
    "  /permissions why -- <shell command>",
    "  /trust [status|grant|revoke]",
  ].join("\n");
}

export function parsePermissionWhyCommand(argument: string): string | null {
  const trimmed = argument.trim();
  if (trimmed !== "why" && !trimmed.startsWith("why ")) {
    return null;
  }
  let command = trimmed.slice("why".length).trim();
  if (command === "--") {
    command = "";
  } else if (command.startsWith("-- ")) {
    command = command.slice(3).trim();
  }
  return command.length === 0 ? null : command;
}

export function codepunkHelp(): string {
  return [
    "Codepunk commands",
    "cp- marks a Codepunk command whose name would otherwise collide with a Pi builtin",
    "",
    "Models and providers",
    "  /model [query]             open Pi's fuzzy model picker",
    "                             Enter is session-only; Ctrl+S saves the default",
    "                             an exact provider/id or unique bare id saves immediately",
    "  /login, /logout            manage Pi provider credentials",
    "  /thinking                  choose the reasoning level; saved to config",
    "  /scoped-models             explain the file-backed model scope",
    "",
    "Permissions and work",
    "  /permissions               show or change profile, approval, autonomy, sandbox",
    "  /permissions reviewer [off|model [provider/model]|timeout <ms>]  configure auto-mode review",
    "  /permissions sandbox network [allow|deny <domain>...|clear]  set the sandbox egress lists",
    "  /permissions rules         list persisted exact-command rules",
    "  /permissions why -- <cmd>  explain a policy decision without running it",
    "  /trust [status|grant|revoke] show or save workspace trust for future sessions",
    "  !<command>                 run a shell command through the same policy gate",
    "  /subagent [--profile <name>] [--model <provider/model>] [--worktree|--shared] <task>",
    "                             start a child session from a discovered profile",
    "  /agents [profiles|result|wait|stop|review|sign|merge|discard <id>]",
    "                             list profiles or manage child sessions",
    "  /plan                      show the current plan",
    "  /todos                     show the current todo list",
    "",
    "Project",
    "  /init [--update]           create or update AGENTS.md from repository evidence",
    "  /diff                      show staged and unstaged working tree changes",
    "  /commit [message]          review and create a Git commit as a human action",
    "  /undo [count]              restore recent Codepunk write/edit changes",
    "  /redo [count]              reapply changes removed by /undo",
    "  /status                    show model, session, permissions, trust, and usage",
    "",
    "Sessions and evidence",
    "  /cp-sessions, /session     list sessions or show the current one",
    "  /resume [id|latest]        switch to another session in this TUI",
    "  /fork [entry-id], /clone   fork at the leaf or entry and switch to the child",
    "  /tree [entry-id]           list the session tree or move to an entry",
    "  /evidence, /budget         show evidence and model usage",
    "  /cp-export, /export        write a redacted transcript and manifest",
    "  /sign                      sign the current settled run",
    "  /new                       start a new session in this TUI",
    "",
    "Local capabilities",
    "  /skills, /plugins          list installed capabilities",
    "  /mcp [list|add [name]|remove [name]|login [name]|status [name]|logout [name]]",
    "                             manage user MCP servers",
    "  /capabilities              summarize skills, MCP servers, and plugins",
    "  /remember, /memory         write, search, archive, or delete memory",
    "  /doctor, /policy           run diagnostics or print effective policy",
    "  /compact                   ask Pi to compact the current context",
    "  /reload                    reload plugins, skills, and user MCP servers",
    "  /help                      show this command list",
    "  /quit                      exit",
    "",
    "Pi commands that would bypass the Codepunk session, evidence, or redaction boundary are intercepted with guidance.",
  ].join("\n");
}

const APPROVAL_CHOICES: ReadonlyArray<{
  label: string;
  decision: "allow" | "deny";
  scope: ApprovalScope;
  guidance?: boolean;
}> = [
  { label: "Allow once", decision: "allow", scope: "once" },
  {
    label: "Allow this exact command for the session",
    decision: "allow",
    scope: "session",
  },
  {
    label: "Always allow this exact command",
    decision: "allow",
    scope: "persistent",
  },
  { label: "Deny", decision: "deny", scope: "once" },
  {
    label: "Deny with guidance for the model",
    decision: "deny",
    scope: "once",
    guidance: true,
  },
];

const INTERCEPTED_PI_COMMANDS = new Set([
  "settings",
  "scoped-models",
  "import",
  "share",
  "bug",
]);

export function filterInterceptedAutocomplete<T extends { value: string }>(
  items: readonly T[],
): T[] {
  return items.filter((item) => !INTERCEPTED_PI_COMMANDS.has(item.value));
}

const PERSIST_APPROVAL = "Save exact rule and allow";
const PERSIST_BACK = "Back";

function persistentApprovalPreview(request: ApprovalRequest): string {
  const argv =
    request.argv === undefined || request.argv.length === 0
      ? "(missing; persistent approval is unavailable)"
      : JSON.stringify(request.argv);
  return [
    "Persistent rule preview",
    "This choice writes a scoped rule for later sessions.",
    `tool: ${request.tool ?? "(unknown)"}`,
    `exact argv: ${argv}`,
    `cwd: ${request.cwd ?? "(missing)"}`,
    "match: identical argv only, from this exact cwd",
    "storage: user scoped-rule file; inspect it with /permissions rules",
    "next session: autonomy switches to scoped so this exact rule can apply",
    "",
    "Save this exact rule?",
  ].join("\n");
}

export function currentShellStatus(
  runtime: Pick<CodepunkRuntime, "sandbox">,
): "srt" | "explicit-unsandboxed" | "disabled" {
  if (runtime.sandbox?.sandboxed === true) {
    return "srt";
  }
  return runtime.sandbox === null ? "disabled" : "explicit-unsandboxed";
}

function permissionSummary(runtime: CodepunkRuntime): string {
  const shell = currentShellStatus(runtime);
  const approval = {
    ask: "ask before actions outside safe read-only classes",
    deny: "deny actions that would otherwise ask",
    auto: "auto-approve routine and ordinary shell actions; destructive, explicit-policy, protected, sensitive, and MCP actions still ask",
    allow: "auto-approve sandbox-covered asks; MCP calls still require a human",
  }[runtime.config.approval.mode];
  const profile = permissionProfileFor(runtime.config);
  return [
    "Permissions",
    `profile: ${profile}`,
    `workspace trust: ${runtime.workspaceTrust.trusted ? "trusted" : "untrusted"} (${runtime.workspaceTrust.source})`,
    `trust root: ${runtime.workspaceTrust.root}`,
    `approvals: ${runtime.config.approval.mode} (${approval})`,
    ...(runtime.config.approval.reviewer === "off"
      ? []
      : [
          `approval reviewer: ${runtime.config.approval.reviewer} (${runtime.config.approval.reviewer_model ?? "session model"}, ${runtime.config.approval.reviewer_timeout_ms} ms)`,
        ]),
    `autonomy: ${runtime.autonomy.profile}`,
    `behavior: ${permissionBehaviorSummary(runtime.config)}`,
    `current shell: ${shell}`,
    `next session sandbox: ${runtime.config.sandbox.mode}`,
    `next session network: ${
      runtime.config.sandbox.network_allow.length === 0
        ? "deny by default"
        : runtime.config.sandbox.network_allow.join(", ")
    }`,
    ...(runtime.config.sandbox.network_deny.length === 0
      ? []
      : [
          `next session network deny: ${runtime.config.sandbox.network_deny.join(", ")}`,
        ]),
    `next session filesystem: ${runtime.config.filesystem.mode}`,
    ...(runtime.paths.additionalRoots.length === 0
      ? []
      : [`extra file roots: ${runtime.paths.additionalRoots.join(", ")}`]),
    "safe reads: date, identity, and workspace inspection run without approval",
    `config: ${runtime.paths.home}/config.toml`,
    "",
    "Profiles: read-only · standard · auto · auto-approve · full-access · custom",
    "",
    permissionUsage(),
  ].join("\n");
}

function formatMcpReload(result: McpReloadResult): string {
  if (result.error !== null) {
    return [
      "MCP reload did not complete.",
      `MCP reload failed: ${result.error}`,
      "The previous MCP server processes were kept; restart codepunk if the error mentions the Pi reload.",
    ].join("\n");
  }
  const lines = ["Reloaded Pi resources and MCP configuration."];
  if (result.skipped === "disabled") {
    lines.push("MCP is disabled for this session.");
  } else if (result.skipped === "read-only") {
    lines.push(
      "MCP is not started while autonomy is read-only. Leave read-only, then run /reload.",
    );
  } else if (result.skipped === "no-model") {
    lines.push(
      "MCP is not started because no model is selected. Select one with /model, then run /reload.",
    );
  } else if (result.servers.length === 0) {
    lines.push("No user-scope MCP servers are configured.");
  } else {
    lines.push(
      `MCP servers: ${result.servers
        .map((server) => `${server} (${result.toolCounts[server] ?? 0} tools)`)
        .join(", ")}`,
    );
    if (result.resourceServers.length > 0) {
      lines.push(`Resource servers: ${result.resourceServers.join(", ")}`);
    }
  }
  for (const failure of result.failures) {
    lines.push(
      `MCP server ${failure.server} skipped: ${failure.code}: ${failure.message}`,
    );
  }
  for (const warning of result.warnings) {
    lines.push(warning);
  }
  return lines.join("\n");
}

/**
 * Parse the command line used by `/mcp add` without invoking a shell. The
 * editor form accepts quoted arguments so a command such as
 * `npx -y "@scope/server" --root "path with spaces"` maps to exact argv.
 */
export function splitMcpArguments(input: string): string[] {
  const args: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (const character of input) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") {
        quote = null;
      } else {
        token += character;
        started = true;
      }
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null;
      } else if (character === "\\") {
        escaped = true;
      } else {
        token += character;
        started = true;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        args.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }
  if (quote !== null) {
    throw new Error("command line has an unterminated quote");
  }
  if (escaped) {
    token += "\\";
  }
  if (started) {
    args.push(token);
  }
  return args;
}

export function parseMcpHeader(
  input: string,
): { name: string; value: string } | null {
  if (/[\r\n]/u.test(input)) {
    return null;
  }
  const separator = input.indexOf(":");
  if (separator <= 0) {
    return null;
  }
  const name = input.slice(0, separator).trim();
  const value = input.slice(separator + 1).trim();
  if (name.length === 0) {
    return null;
  }
  return { name, value };
}

interface McpEditResult {
  message: string;
  level: "info" | "error";
}

async function addMcpServerInteractive(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  requestedName: string | undefined,
): Promise<McpEditResult | null> {
  let name = requestedName?.trim();
  if (name === undefined || name.length === 0) {
    name = (
      await context.ui.input(
        "MCP server name",
        "lowercase name, for example github",
      )
    )?.trim();
  }
  if (name === undefined || name.length === 0) {
    return null;
  }
  const configs = await readMcpConfig(runtime.paths);
  const existing = configs.find((config) => config.name === name);
  if (existing !== undefined) {
    const replace = await context.ui.select(
      `MCP server ${name} already exists`,
      ["Replace the existing server", "Cancel"],
    );
    if (replace !== "Replace the existing server") {
      return null;
    }
  }
  const transport = await context.ui.select("MCP transport", [
    "stdio - run a local command",
    "Streamable HTTP - connect to a URL",
  ]);
  if (transport === undefined) {
    return null;
  }
  let input: McpServerInput;
  if (transport.startsWith("Streamable HTTP")) {
    const url = (
      await context.ui.input("MCP server URL", "https://example.invalid/mcp")
    )?.trim();
    if (url === undefined || url.length === 0) {
      return null;
    }
    const headers: Record<string, string> = {};
    const headerLine = (
      await context.ui.input(
        "Optional HTTP header",
        "Authorization: Bearer ${MCP_TOKEN}",
      )
    )?.trim();
    if (headerLine !== undefined && headerLine.length > 0) {
      const header = parseMcpHeader(headerLine);
      if (header === null) {
        context.ui.notify(
          "HTTP header must use the form Name: value",
          "warning",
        );
        return null;
      }
      headers[header.name] = header.value;
    }
    input = { name, url, headers };
  } else {
    const commandLine = (
      await context.ui.input(
        "Command and arguments",
        'npx -y "@modelcontextprotocol/server-filesystem" .',
      )
    )?.trim();
    if (commandLine === undefined || commandLine.length === 0) {
      return null;
    }
    const argv = splitMcpArguments(commandLine);
    if (argv.length === 0) {
      context.ui.notify("command is required", "warning");
      return null;
    }
    const cwd = (
      await context.ui.input(
        "Working directory inside the project (optional)",
        ".",
      )
    )?.trim();
    input = {
      name,
      command: argv[0]!,
      args: argv.slice(1),
      ...(cwd === undefined || cwd.length === 0 ? {} : { cwd }),
    };
  }
  const configPath = await writeMcpServer(runtime.paths, input, {
    force: existing !== undefined,
  });
  const reload = await runtime.reloadMcp();
  return {
    message: [
      `MCP server ${name} saved to ${configPath}`,
      "Environment variables and extra headers remain available through `codepunk mcp add`.",
      formatMcpReload(reload),
    ].join("\n"),
    level: reload.error === null ? "info" : "error",
  };
}

async function removeMcpServerInteractive(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  requestedName: string | undefined,
): Promise<McpEditResult | null> {
  const configs = await readMcpConfig(runtime.paths);
  if (configs.length === 0) {
    await notify(context, "No user MCP servers configured.");
    return null;
  }
  let name = requestedName?.trim();
  if (name === undefined || name.length === 0) {
    name = await context.ui.select(
      "MCP server to remove",
      configs.map((config) => config.name),
    );
  }
  if (name === undefined || name.length === 0) {
    return null;
  }
  if (!configs.some((config) => config.name === name)) {
    context.ui.notify(`MCP server ${name} is not configured`, "warning");
    return null;
  }
  const confirmed = await context.ui.select(`Remove MCP server ${name}?`, [
    `Remove ${name}`,
    "Cancel",
  ]);
  if (confirmed !== `Remove ${name}`) {
    return null;
  }
  const configPath = await removeMcpServer(runtime.paths, name);
  const reload = await runtime.reloadMcp();
  return {
    message: [
      `MCP server ${name} removed from ${configPath}`,
      formatMcpReload(reload),
    ].join("\n"),
    level: reload.error === null ? "info" : "error",
  };
}

function formatSkillReload(result: SkillReloadResult): string {
  if (result.error !== null) {
    return `Skill reload failed: ${result.error}`;
  }
  if (result.skipped === "disabled") {
    return "Skills are disabled for this session.";
  }
  if (result.skills.length === 0) {
    return "Skills reloaded: none discovered.";
  }
  return `Skills reloaded: ${result.skills
    .map((skill) => `${skill.name} (${skill.scope})`)
    .join(", ")}`;
}

function formatPluginReload(result: PluginReloadResult): string {
  if (result.error !== null) {
    return `Plugin reload failed: ${result.error}\nThe previous plugin surface was kept.`;
  }
  if (result.skipped === "disabled") {
    return "Plugins are disabled for this session.";
  }
  if (result.skipped === "read-only") {
    return "Plugins are not loaded while autonomy is read-only.";
  }
  if (result.skipped === "headless") {
    return "Plugins are not loaded in headless sessions.";
  }
  if (result.plugins.paths.length === 0) {
    return "Plugins reloaded: none installed.";
  }
  return `Plugins reloaded: ${result.plugins.paths
    .map((file) => path.basename(file))
    .join(", ")}`;
}

function sessionSummary(runtime: CodepunkRuntime): string {
  const model = runtime.host.session.model;
  const usage = runtime.host.session.getContextUsage();
  return [
    `session: ${runtime.session.sessionId}`,
    `model: ${model === undefined ? "not selected" : `${model.provider}/${model.id}`}`,
    `thinking: ${runtime.host.session.thinkingLevel}`,
    `context: ${
      usage === undefined || usage.tokens === null
        ? "unknown"
        : `${usage.tokens}/${usage.contextWindow} tokens${
            usage.percent === null ? "" : ` (${usage.percent.toFixed(1)}%)`
          }`
    }`,
    `run: ${runtime.host.currentRunId}`,
    `evidence: ${evidenceCount(runtime)} record(s)`,
    `sessions: ${runtime.paths.sessionsDir}`,
  ].join("\n");
}

function formatStatusSummary(runtime: CodepunkRuntime): string {
  const model = physicalModel(runtime);
  const selected = selectedModel(runtime);
  const usage = runtime.host.session.getContextUsage();
  const totals = runtime.usage();
  const profile = permissionProfileFor(runtime.config);
  const trust = runtime.workspaceTrust;
  return [
    "codepunk status",
    `project: ${runtime.paths.deliveryRoot}`,
    `cwd: ${runtime.paths.cwd}`,
    `session: ${runtime.session.sessionId} (run ${runtime.host.currentRunId})`,
    `model: ${
      model === undefined ? "not selected" : `${model.provider}/${model.id}`
    }${
      selected !== undefined && isFallbackModel(selected)
        ? " (fallback route)"
        : ""
    }`,
    `thinking: ${runtime.host.session.thinkingLevel}`,
    `context: ${
      usage === undefined || usage.tokens === null
        ? "unknown"
        : `${usage.tokens}/${usage.contextWindow} tokens${
            usage.percent === null ? "" : ` (${usage.percent.toFixed(1)}%)`
          }`
    }`,
    `permissions: ${profile} · approval ${runtime.config.approval.mode} · autonomy ${runtime.config.autonomy.profile}`,
    `sandbox: ${runtime.config.sandbox.mode} · filesystem ${runtime.config.filesystem.mode}`,
    `trust: ${trust.trusted ? "trusted" : "untrusted"} (${trust.source}) · ${trust.storePath}`,
    `capabilities: ${runtime.skills.length} skill(s) · ${runtime.mcpServers.length} MCP server(s) · plugins ${runtime.plugins.enabled ? "enabled" : "disabled"}`,
    `evidence: ${evidenceCount(runtime)} record(s) · head ${runtime.ledger.head ?? "none"}`,
    `usage: ${totals.total_tokens} tokens · $${totals.cost_total.toFixed(6)} · ${totals.calls} call(s)`,
    `config: ${runtime.paths.home}/config.toml`,
    `sessions: ${runtime.paths.sessionsDir}`,
  ].join("\n");
}

async function findRootInstructionFile(root: string): Promise<string | null> {
  for (const name of PI_INSTRUCTION_FILE_NAMES) {
    const candidate = path.join(root, name);
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isFile() || stat.isSymbolicLink()) {
        return candidate;
      }
    } catch {
      // A missing candidate is the normal case; keep looking.
    }
  }
  return null;
}

export function buildInitPrompt(
  root: string,
  existingFile: string | null,
): string {
  const target = existingFile ?? path.join(root, "AGENTS.md");
  return [
    `${
      existingFile === null ? "Create" : "Update"
    } the repository guidance file at ${target}.`,
    "",
    "Work from repository evidence only. Inspect the README and any",
    "package/build/test configuration (for example package.json,",
    "pnpm-workspace.yaml, Makefile, pyproject.toml, Cargo.toml, go.mod), the",
    "top-level layout, and existing docs. Verify commands before writing them;",
    "omit anything you cannot verify.",
    "",
    "The file is for future coding agents. Include only information that is",
    "expensive to rediscover:",
    "- what the project is and its main runtime boundaries;",
    "- exact install, build, test, lint, and single-test commands that exist;",
    "- module or directory ownership and dependency direction when clear;",
    "- repository-specific conventions, generated files, and traps;",
    "- required environment or setup steps that are documented or evidenced.",
    "",
    "Do not include generic advice, marketing copy, secrets, absolute local",
    "paths, usernames, hostnames, or a file-by-file inventory. Do not modify",
    "any file other than the target. Keep it under 120 lines.",
    "",
    existingFile === null
      ? "If a nested AGENTS.md or CLAUDE.md contradicts the root file you write, report the conflict in your final reply instead of silently overriding it."
      : "Preserve accurate existing content and remove stale or generic text. If the target is a symlink, stop and report it instead of writing through it.",
    "",
    "When finished, reply with the target path, the sections you wrote, and",
    "any command you could not verify.",
  ].join("\n");
}

async function initializeProjectInstructions(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
  argument: string,
): Promise<void> {
  const option = argument.trim();
  if (option !== "" && option !== "--update") {
    context.ui.notify("usage: /init [--update]", "warning");
    return;
  }
  if (!runtime.workspaceTrust.trusted) {
    context.ui.notify(
      [
        "The workspace is not trusted, so a new AGENTS.md would not load.",
        "Run /trust grant, then restart codepunk and run /init again.",
        "/trust grant only changes future sessions.",
      ].join("\n"),
      "warning",
    );
    return;
  }
  if (runtime.config.autonomy.profile === "read-only") {
    context.ui.notify(
      "The current autonomy is read-only. Switch with /permissions profile standard before /init.",
      "warning",
    );
    return;
  }
  if (runtime.host.session.isStreaming || runtime.host.session.isCompacting) {
    context.ui.notify(
      "Wait for the current response or compaction to finish before /init.",
      "warning",
    );
    return;
  }
  const existingFile = await findRootInstructionFile(
    runtime.paths.deliveryRoot,
  );
  if (existingFile !== null) {
    let symlink = false;
    try {
      symlink = (await fs.lstat(existingFile)).isSymbolicLink();
    } catch {
      symlink = false;
    }
    if (symlink) {
      context.ui.notify(
        `${existingFile} is a symlink. /init does not write through instruction symlinks; replace it with a regular file first.`,
        "warning",
      );
      return;
    }
    if (option !== "--update") {
      context.ui.notify(
        [
          `${existingFile} already exists.`,
          "Use /init --update to let the agent revise that file in place.",
        ].join("\n"),
        "info",
      );
      return;
    }
  }
  if (physicalModel(runtime) === undefined) {
    context.ui.notify(
      modelOnboardingMessage(runtime) ??
        "No model selected. Use /model to choose one.",
      "warning",
    );
    return;
  }
  context.ui.notify(
    [
      `Starting project instruction initialization for ${
        existingFile ?? path.join(runtime.paths.deliveryRoot, "AGENTS.md")
      }.`,
      "The new file applies when the next session starts.",
    ].join("\n"),
    "info",
  );
  try {
    await runtime.host.session.prompt(
      buildInitPrompt(runtime.paths.deliveryRoot, existingFile),
    );
  } catch (error) {
    context.ui.notify(
      `/init could not start: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
}

interface TreeEntryView {
  id: string;
  type: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  summary?: string;
  customType?: string;
}

interface TreeNodeView {
  entry: TreeEntryView;
  children: TreeNodeView[];
  label?: string;
}

function previewText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => {
      if (
        part !== null &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join(" ");
}

function treeEntryPreview(entry: TreeEntryView): string {
  const raw =
    entry.type === "message"
      ? previewText(entry.message?.content)
      : entry.type === "compaction"
        ? (entry.summary ?? "")
        : entry.type === "custom_message"
          ? `[${entry.customType ?? "custom"}] ${previewText((entry as { content?: unknown }).content)}`
          : "";
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return "";
  }
  return collapsed.length <= 64 ? collapsed : `${collapsed.slice(0, 63)}…`;
}

function formatSessionTree(
  tree: readonly TreeNodeView[],
  leafId: string | null,
): string {
  if (tree.length === 0) {
    return "Session tree is empty.";
  }
  const lines = [
    `Session tree (leaf ${leafId ?? "none"})`,
    "  * marks the current leaf; use /tree <entry-id> to move there",
  ];
  const walk = (nodes: readonly TreeNodeView[], depth: number): void => {
    for (const node of nodes) {
      const marker = node.entry.id === leafId ? " *" : "  ";
      const label = node.label === undefined ? "" : `  [${node.label}]`;
      const preview = treeEntryPreview(node.entry);
      lines.push(
        `${"  ".repeat(depth)}${marker} ${node.entry.id}  ${node.entry.type}${label}${
          preview.length === 0 ? "" : `  ${preview}`
        }`,
      );
      walk(node.children, depth + 1);
    }
  };
  walk(tree, 1);
  return lines.join("\n");
}

function sessionChoiceLabel(
  entry: Awaited<ReturnType<typeof listProjectSessions>>[number],
  currentId: string,
): string {
  return `${entry.id === currentId ? "*" : " "} ${entry.id}  ${entry.updated_at}  ${
    entry.title ?? "(untitled)"
  }${entry.parent_session_id === null ? "" : `  from ${entry.parent_session_id}`}`;
}

function matchSessionChoice(
  entries: Awaited<ReturnType<typeof listProjectSessions>>,
  query: string,
): Awaited<ReturnType<typeof listProjectSessions>>[number] | null {
  const exact = entries.find((entry) => entry.id === query);
  if (exact !== undefined) {
    return exact;
  }
  const matches = entries.filter((entry) => entry.id.startsWith(query));
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Pi tears down the current host session before it builds the replacement.
 * A target that cannot be opened or locked therefore costs the live TUI
 * runtime, not just the switch. Check the durable store first so a live
 * writer, stale state, or corrupt session is reported before teardown.
 */
export async function sessionResumeIssue(
  runtime: Pick<CodepunkRuntime, "paths">,
  sessionId: string,
): Promise<string | null> {
  try {
    const store = await SessionStore.open({
      rootDir: runtime.paths.home,
      cwd: runtime.paths.cwd,
      projectRoot: runtime.paths.deliveryRoot,
      projectId: runtime.paths.projectId,
      sessionId,
    });
    const lock = await readLock(store.paths.lockPath);
    if (lock !== null) {
      const reason = staleLockReason(lock, new Date(), LOCK_LEASE_MS);
      if (reason !== null) {
        return `session ${sessionId} is not resumable now: ${reason}`;
      }
    }
    const state = await store.readAgentState();
    if (state === null) {
      return store.allEvents.length === 0
        ? null
        : `session ${sessionId} has events but no agent-state.json`;
    }
    const resumed = await store.resume();
    if (resumed.uncommittedEvents.length > 0) {
      return `session ${sessionId} has ${resumed.uncommittedEvents.length} uncommitted event(s) after the last agent-state snapshot`;
    }
    return null;
  } catch (error) {
    return `session ${sessionId} cannot be resumed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function resumeSession(
  state: TuiState,
  context: ExtensionContext,
  argument: string,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null || state.replaceRuntime === undefined) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  const entries = await listProjectSessions(
    runtime.paths.home,
    runtime.paths.projectId,
  );
  if (entries.length === 0) {
    context.ui.notify("No sessions in this project.", "warning");
    return;
  }
  let targetId: string | undefined;
  const query = argument.trim();
  if (query === "latest" || query === "--latest") {
    targetId = entries[0]!.id;
  } else if (query.length > 0) {
    const matched = matchSessionChoice(entries, query);
    if (matched === null) {
      context.ui.notify(
        `No unique session matches ${query}. Use /cp-sessions to list exact ids.`,
        "warning",
      );
      return;
    }
    targetId = matched.id;
  } else if (entries.length === 1) {
    targetId = entries[0]!.id;
  } else {
    const labels = entries
      .slice(0, 20)
      .map((entry) => sessionChoiceLabel(entry, runtime.session.sessionId));
    const selected = await context.ui.select("Resume session", labels);
    if (selected === undefined) {
      return;
    }
    targetId = entries[labels.indexOf(selected)]?.id;
  }
  if (targetId === undefined) {
    return;
  }
  if (targetId === runtime.session.sessionId) {
    context.ui.notify(`Already in session ${targetId}.`, "info");
    return;
  }
  if (runtime.host.session.isStreaming || runtime.host.session.isCompacting) {
    context.ui.notify(
      "Wait for the current run to settle before switching sessions.",
      "warning",
    );
    return;
  }
  const issue = await sessionResumeIssue(runtime, targetId);
  if (issue !== null) {
    context.ui.notify(issue, "error");
    return;
  }
  try {
    const replacement = await state.replaceRuntime({ sessionId: targetId });
    replacement.context.ui.notify(`resumed session ${targetId}`, "info");
  } catch (error) {
    context.ui.notify(
      `resume failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

async function forkCurrentSession(
  state: TuiState,
  context: ExtensionContext,
  argument: string,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null || state.replaceRuntime === undefined) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  const session = runtime.host.session;
  if (session.isStreaming || session.isCompacting) {
    context.ui.notify(
      "Wait for the current run to settle before forking.",
      "warning",
    );
    return;
  }
  const entryId = argument.trim();
  if (entryId.length > 0) {
    const entry = runtime.host.sessionManager.getEntry(entryId);
    if (entry === undefined) {
      context.ui.notify(`No session entry ${entryId}.`, "warning");
      return;
    }
  }
  const parentState = await runtime.host.saveAgentState();
  if (parentState === null) {
    context.ui.notify(
      "the current session has no agent state to fork",
      "error",
    );
    return;
  }
  const branch =
    entryId.length === 0
      ? parentState.branch
      : runtime.host.sessionManager.getBranch(entryId);
  try {
    const forked = await forkLiveSession({
      parent: runtime.session,
      parentState,
      rootDir: runtime.paths.home,
      cwd: runtime.paths.cwd,
      projectRoot: runtime.paths.deliveryRoot,
      projectId: runtime.paths.projectId,
      branch,
      ...(entryId.length === 0 ? {} : { forkEntryId: entryId }),
    });
    const replacement = await state.replaceRuntime({
      sessionId: forked.sessionId,
    });
    replacement.context.ui.notify(
      [
        `forked ${forked.parentSessionId} -> ${forked.sessionId}`,
        `entries: ${forked.forkEntries}; parent last seq: ${forked.parentLastSeq}`,
      ].join("\n"),
      "info",
    );
  } catch (error) {
    context.ui.notify(
      `fork failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

async function navigateSessionTree(
  state: TuiState,
  context: ExtensionContext,
  argument: string,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  const entryId = argument.trim();
  if (entryId.length === 0 || entryId === "list") {
    context.ui.notify(
      formatSessionTree(
        runtime.host.sessionManager.getTree() as TreeNodeView[],
        runtime.host.sessionManager.getLeafId(),
      ),
      "info",
    );
    return;
  }
  const session = runtime.host.session;
  if (session.isStreaming || session.isCompacting) {
    context.ui.notify(
      "Wait for the current run to settle before moving in the tree.",
      "warning",
    );
    return;
  }
  const target = runtime.host.sessionManager.getEntry(entryId);
  if (target === undefined) {
    context.ui.notify(`No session entry ${entryId}.`, "warning");
    return;
  }
  const from = runtime.host.sessionManager.getLeafId();
  if (from === target.id) {
    context.ui.notify(`${entryId} is already the current leaf.`, "info");
    return;
  }
  try {
    const result = await session.navigateTree(target.id, {
      summarize: false,
    });
    if (result.cancelled) {
      context.ui.notify("tree navigation was cancelled", "warning");
      return;
    }
    await runtime.host.recordEvent("session/tree", {
      action: "navigate",
      from_entry_id: from,
      to_entry_id: target.id,
      branch_entries: runtime.host.sessionManager.getBranch().length,
    });
    await runtime.host.saveAgentState();
    context.ui.notify(
      `moved to ${target.id}; the next prompt continues from this branch`,
      "info",
    );
  } catch (error) {
    context.ui.notify(
      `tree navigation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
}

async function startNewSession(
  state: TuiState,
  context: ExtensionContext,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null || state.replaceRuntime === undefined) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  if (runtime.host.session.isStreaming || runtime.host.session.isCompacting) {
    context.ui.notify(
      "Wait for the current run to settle before starting a new session.",
      "warning",
    );
    return;
  }
  const selected = await context.ui.select("Start a new codepunk session?", [
    "Start new session",
    "Cancel",
  ]);
  if (selected !== "Start new session") {
    return;
  }
  try {
    const replacement = await state.replaceRuntime({ newSession: true });
    replacement.context.ui.notify(
      `started session ${replacement.runtime.session.sessionId}`,
      "info",
    );
  } catch (error) {
    context.ui.notify(
      `new session failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

async function scopedRulesSummary(runtime: CodepunkRuntime): Promise<string> {
  const filePath = runtime.config.autonomy.scoped_rules;
  if (filePath === null) {
    return [
      "Scoped rules: none.",
      'Approval choices that say "Always allow this exact command" write here.',
    ].join("\n");
  }
  try {
    const loaded = await loadScopedRules(filePath, runtime.paths);
    return [
      `Scoped rules: ${loaded.rules.length} (profile ${runtime.autonomy.profile})`,
      `file: ${loaded.path}`,
      ...loaded.rules.map((rule) => `  ${rule.id}: ${rule.argv.join(" ")}`),
    ].join("\n");
  } catch (error) {
    return `Scoped rules could not be read: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function explainCommandPolicy(
  runtime: CodepunkRuntime,
  command: string,
): Promise<string> {
  const decision = decidePolicy({
    tool: "bash",
    command,
    cwd: runtime.paths.cwd,
    workspaceRoot: runtime.paths.deliveryRoot,
    additionalRoots: runtime.paths.additionalRoots,
    deliveryRoot: runtime.paths.deliveryRoot,
    codepunkHome: runtime.paths.home,
    autonomy: runtime.autonomy.profile,
    filesystem: runtime.permissionSnapshot.filesystem,
    writeSet: [
      ...new Set([
        ...(runtime.policy.writeSet.length > 0
          ? runtime.policy.writeSet
          : [runtime.paths.cwd]),
        ...runtime.paths.additionalRoots,
      ]),
    ],
    userRules: runtime.policy.userRules,
    projectRules: runtime.policy.projectRules,
    layers: runtime.policy.layers,
  });
  return formatPermissionExplanation(
    await explainPermission({
      policy: decision,
      autonomy: runtime.autonomy,
      approvalMode: runtime.config.approval.mode,
      tool: "bash",
      command,
      cwd: runtime.paths.cwd,
      networkAllow: runtime.permissionSnapshot.networkAllow,
      networkDeny: runtime.permissionSnapshot.networkDeny,
      execution:
        runtime.sandbox === null
          ? {
              status: "blocked",
              reason: "shell is disabled for this session",
            }
          : { status: "available", reason: null },
    }),
  );
}

async function configurePermissions(
  state: TuiState,
  context: ExtensionContext,
  argument: string,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  if (argument.length === 0) {
    context.ui.notify(permissionSummary(runtime), "info");
    return;
  }
  const trimmed = argument.trim();
  if (trimmed === "rules") {
    context.ui.notify(await scopedRulesSummary(runtime), "info");
    return;
  }
  if (trimmed === "why" || trimmed.startsWith("why ")) {
    const command = parsePermissionWhyCommand(trimmed);
    if (command === null) {
      context.ui.notify(permissionUsage(), "warning");
      return;
    }
    context.ui.notify(await explainCommandPolicy(runtime, command), "info");
    return;
  }
  const [group, value, ...rest] = trimmed.split(/\s+/u);
  if (group === "sandbox" && value === "network") {
    const formatNetwork = (): string =>
      [
        `network allow: ${
          runtime.config.sandbox.network_allow.length === 0
            ? "none (deny by default)"
            : runtime.config.sandbox.network_allow.join(", ")
        }`,
        `network deny: ${
          runtime.config.sandbox.network_deny.length === 0
            ? "none"
            : runtime.config.sandbox.network_deny.join(", ")
        }`,
      ].join("\n");
    if (rest.length === 0 || (rest.length === 1 && rest[0] === "show")) {
      context.ui.notify(formatNetwork(), "info");
      return;
    }
    if (rest[0] === "clear") {
      const which = rest[1];
      if (which !== undefined && which !== "allow" && which !== "deny") {
        context.ui.notify(
          "usage: /permissions sandbox network clear [allow|deny]",
          "warning",
        );
        return;
      }
      try {
        await writeUserPermissionSelection(runtime.paths, {
          ...(which === undefined || which === "allow"
            ? { networkAllow: [] }
            : {}),
          ...(which === undefined || which === "deny"
            ? { networkDeny: [] }
            : {}),
        });
      } catch (error) {
        context.ui.notify(
          `network lists were not saved: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
        return;
      }
      if (which === undefined || which === "allow") {
        runtime.config.sandbox.network_allow = [];
      }
      if (which === undefined || which === "deny") {
        runtime.config.sandbox.network_deny = [];
      }
      context.ui.notify(
        `${formatNetwork()}\napplies to the next session`,
        "info",
      );
      return;
    }
    const list = rest[0] === "allow" || rest[0] === "deny" ? rest[0] : "allow";
    const requested =
      rest[0] === "allow" || rest[0] === "deny" ? rest.slice(1) : rest;
    if (requested.length === 0) {
      context.ui.notify(
        `usage: /permissions sandbox network ${list} <domain>...`,
        "warning",
      );
      return;
    }
    let normalized: string[];
    try {
      normalized =
        list === "allow"
          ? normalizeNetworkAllow(requested)
          : normalizeNetworkDeny(requested);
    } catch (error) {
      context.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
      return;
    }
    const other =
      list === "allow"
        ? runtime.config.sandbox.network_deny
        : runtime.config.sandbox.network_allow;
    const overlap = normalized.filter((entry) => other.includes(entry));
    if (overlap.length > 0) {
      context.ui.notify(
        `sandbox.network_deny also lists ${overlap.join(", ")}; clear the other list first`,
        "error",
      );
      return;
    }
    try {
      await writeUserPermissionSelection(
        runtime.paths,
        list === "allow"
          ? { networkAllow: normalized }
          : { networkDeny: normalized },
      );
    } catch (error) {
      context.ui.notify(
        `network list was not saved: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
      return;
    }
    if (list === "allow") {
      runtime.config.sandbox.network_allow = normalized;
    } else {
      runtime.config.sandbox.network_deny = normalized;
    }
    context.ui.notify(
      `${formatNetwork()}\napplies to the next session; each network command still needs its own approval`,
      "info",
    );
    return;
  }
  if (group === "reviewer") {
    const formatReviewer = (): string =>
      [
        `reviewer: ${runtime.config.approval.reviewer}`,
        `reviewer model: ${runtime.config.approval.reviewer_model ?? "session model"}`,
        `reviewer timeout: ${runtime.config.approval.reviewer_timeout_ms} ms`,
        "scope: network commands and headless argv exec only; other asks stay human",
        "failure: ask a human interactively; deny when no channel is available",
      ].join("\n");
    const action = value ?? "show";
    if (action === "show") {
      context.ui.notify(formatReviewer(), "info");
      return;
    }
    if (action === "off") {
      try {
        await writeUserPermissionSelection(runtime.paths, { reviewer: "off" });
      } catch (error) {
        context.ui.notify(
          `reviewer was not saved: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
        return;
      }
      runtime.config.approval.reviewer = "off";
      runtime.config.approval.reviewer_model = null;
      context.ui.notify(
        `${formatReviewer()}\napplies to the next session`,
        "info",
      );
      return;
    }
    if (action === "timeout") {
      const timeout = Number(rest[0]);
      if (
        rest[0] === undefined ||
        !Number.isSafeInteger(timeout) ||
        timeout < 1_000
      ) {
        context.ui.notify(
          "usage: /permissions reviewer timeout <ms at least 1000>",
          "warning",
        );
        return;
      }
      try {
        await writeUserPermissionSelection(runtime.paths, {
          reviewerTimeoutMs: timeout,
        });
      } catch (error) {
        context.ui.notify(
          `reviewer timeout was not saved: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
        return;
      }
      runtime.config.approval.reviewer_timeout_ms = timeout;
      context.ui.notify(
        `${formatReviewer()}\napplies to the next session`,
        "info",
      );
      return;
    }
    if (action !== "model") {
      context.ui.notify(permissionUsage(), "warning");
      return;
    }
    const model = rest[0];
    if (model !== undefined && (!model.includes("/") || /\s/u.test(model))) {
      context.ui.notify(
        "usage: /permissions reviewer model [provider/model]",
        "warning",
      );
      return;
    }
    try {
      await writeUserPermissionSelection(runtime.paths, {
        reviewer: "model",
        ...(model === undefined ? {} : { reviewerModel: model }),
      });
    } catch (error) {
      context.ui.notify(
        `reviewer was not saved: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
      return;
    }
    runtime.config.approval.reviewer = "model";
    if (model !== undefined) {
      runtime.config.approval.reviewer_model = model;
    }
    context.ui.notify(
      [
        formatReviewer(),
        runtime.config.approval.mode === "auto"
          ? "applies to the next session"
          : "inactive until approval.mode is auto; use /permissions approval auto",
      ].join("\n"),
      "info",
    );
    return;
  }
  if (group === undefined || value === undefined || rest.length > 0) {
    context.ui.notify(permissionUsage(), "warning");
    return;
  }
  if (group === "profile") {
    if (!isPermissionProfile(value)) {
      if (value === "trusted") {
        context.ui.notify(
          [
            "permission profile trusted was removed because it collides with workspace trust.",
            "Use /permissions profile auto-approve for blanket approval.",
            "Use /trust grant to trust this workspace's project config, policy, and skills.",
          ].join("\n"),
          "warning",
        );
        return;
      }
      context.ui.notify(permissionUsage(), "warning");
      return;
    }
    const profile = value as PermissionProfile;
    if (profile === "full-access") {
      context.ui.notify(
        [
          "full-access cannot be enabled from a running session.",
          "Exit and restart with:",
          "  codepunk --permission-mode full-access --dangerously-bypass-approvals-and-sandbox",
          "Or persist it with `codepunk permissions profile full-access` and start the next session with the dangerous flag.",
        ].join("\n"),
        "warning",
      );
      return;
    }
    const settings = PERMISSION_PROFILES[profile];
    const previousApproval = runtime.config.approval.mode;
    const previousAutonomy = runtime.autonomy.profile;
    runtime.setApprovalMode(settings.approval);
    try {
      await setAutonomyProfile(runtime, settings.autonomy);
    } catch (error) {
      runtime.setApprovalMode(previousApproval);
      context.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
      return;
    }
    try {
      await writeUserPermissionProfile(runtime.paths, profile);
    } catch (error) {
      runtime.setApprovalMode(previousApproval);
      await setAutonomyProfile(runtime, previousAutonomy);
      context.ui.notify(
        `permission was not saved: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
      return;
    }
    runtime.config.sandbox.mode = settings.sandbox;
    runtime.config.filesystem.mode = settings.filesystem;
    runtime.config.approval.mode = settings.approval;
    runtime.config.autonomy.profile = settings.autonomy;
    context.ui.notify(
      [
        `permission profile set to ${profile}`,
        `approvals ${settings.approval} · autonomy ${settings.autonomy} · sandbox ${settings.sandbox} · filesystem ${settings.filesystem}`,
        "approvals and autonomy apply to this session; sandbox and filesystem apply to the next session",
        settings.sandbox === "required"
          ? "next session requests srt; run codepunk doctor if the sandbox is unavailable"
          : "next session has no shell unless started with --allow-unsandboxed-shell; executions are recorded as uncovered",
        `config: ${runtime.paths.home}/config.toml`,
      ].join("\n"),
      "info",
    );
  } else if (group === "approval") {
    if (!(APPROVAL_MODE_NAMES as readonly string[]).includes(value)) {
      context.ui.notify(permissionUsage(), "warning");
      return;
    }
    const previous = runtime.config.approval.mode;
    runtime.setApprovalMode(value as (typeof APPROVAL_MODE_NAMES)[number]);
    try {
      await writeUserPermissionSelection(runtime.paths, {
        approval: value as (typeof APPROVAL_MODE_NAMES)[number],
      });
    } catch (error) {
      runtime.setApprovalMode(previous);
      context.ui.notify(
        `permission was not saved: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
      return;
    }
    context.ui.notify(
      `approvals set to ${value}\nconfig: ${runtime.paths.home}/config.toml`,
      "info",
    );
  } else if (group === "autonomy") {
    if (!(AUTONOMY_PROFILES as readonly string[]).includes(value)) {
      context.ui.notify(permissionUsage(), "warning");
      return;
    }
    const previous = runtime.autonomy.profile;
    try {
      await setAutonomyProfile(
        runtime,
        value as (typeof AUTONOMY_PROFILES)[number],
      );
    } catch (error) {
      context.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
      return;
    }
    try {
      await writeUserPermissionSelection(runtime.paths, {
        autonomy: value as (typeof AUTONOMY_PROFILES)[number],
      });
    } catch (error) {
      await setAutonomyProfile(runtime, previous);
      context.ui.notify(
        `permission was not saved: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
      return;
    }
    runtime.config.autonomy.profile =
      value as (typeof AUTONOMY_PROFILES)[number];
    context.ui.notify(
      `autonomy set to ${value}\nconfig: ${runtime.paths.home}/config.toml`,
      "info",
    );
  } else if (group === "sandbox") {
    if (!(SANDBOX_MODES as readonly string[]).includes(value)) {
      context.ui.notify(permissionUsage(), "warning");
      return;
    }
    try {
      await writeUserPermissionSelection(runtime.paths, {
        sandbox: value as (typeof SANDBOX_MODES)[number],
      });
    } catch (error) {
      context.ui.notify(
        `permission was not saved: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
      return;
    }
    runtime.config.sandbox.mode = value as (typeof SANDBOX_MODES)[number];
    context.ui.notify(
      [
        `sandbox set to ${value} for the next session`,
        `current session: ${runtime.sandbox?.sandboxed === true ? "srt" : runtime.sandbox === null ? "no shell" : "explicit unsandboxed shell"}`,
        value === "required"
          ? "next session requests srt; run codepunk doctor if the sandbox is unavailable"
          : "next session has no shell unless started with --allow-unsandboxed-shell; executions are recorded as uncovered",
      ].join("\n"),
      "warning",
    );
  } else if (group === "filesystem") {
    if (!(FILESYSTEM_MODES as readonly string[]).includes(value)) {
      context.ui.notify(permissionUsage(), "warning");
      return;
    }
    try {
      await writeUserPermissionSelection(runtime.paths, {
        filesystem: value as FilesystemMode,
      });
    } catch (error) {
      context.ui.notify(
        `permission was not saved: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
      return;
    }
    runtime.config.filesystem.mode = value as FilesystemMode;
    context.ui.notify(
      [
        `filesystem set to ${value} for the next session`,
        value === "full"
          ? "next session removes the workspace boundary; start it with --dangerously-bypass-approvals-and-sandbox"
          : "next session is confined to the workspace and write set",
      ].join("\n"),
      "warning",
    );
  } else {
    context.ui.notify(permissionUsage(), "warning");
    return;
  }
  if (state.context !== null) {
    setupChrome(state, state.context);
  }
}

async function configureTrust(
  state: TuiState,
  context: ExtensionContext,
  argument: string,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  const tokens = argument.split(/\s+/u).filter(Boolean);
  if (tokens.length > 1) {
    context.ui.notify("usage: /trust [status|grant|revoke]", "warning");
    return;
  }
  const action = tokens[0] ?? "status";
  if (action === "grant" || action === "revoke") {
    try {
      const store = await saveWorkspaceTrust(
        runtime.paths.home,
        runtime.workspaceTrust.root,
        action === "grant",
      );
      context.ui.notify(
        [
          `workspace trust saved as ${action === "grant" ? "trusted" : "untrusted"}`,
          `root: ${runtime.workspaceTrust.root}`,
          `store: ${store}`,
          "the current session is unchanged; restart codepunk to load or skip project resources",
        ].join("\n"),
        action === "grant" ? "info" : "warning",
      );
    } catch (error) {
      context.ui.notify(
        `workspace trust was not saved: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
    }
    return;
  }
  if (action !== "status") {
    context.ui.notify("usage: /trust [status|grant|revoke]", "warning");
    return;
  }
  let saved = "none";
  try {
    const entry = readSavedWorkspaceTrust(
      runtime.paths.home,
      runtime.workspaceTrust.root,
    );
    if (entry !== null) {
      saved = `${entry.decision ? "trusted" : "untrusted"} (${entry.path})`;
    }
  } catch (error) {
    saved = `unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
  context.ui.notify(
    [
      formatWorkspaceTrust(
        runtime.workspaceTrust,
        await previewWorkspaceTrustResources(
          runtime.workspaceTrust.root,
          runtime.workspaceTrust.cwd,
          {
            includeSkills: !runtime.isolation.skills,
            includeInstructions: !runtime.isolation.context,
          },
        ),
        {
          excluded: [
            runtime.isolation.context ? "instruction files (--bare)" : null,
            runtime.isolation.skills
              ? "project skills (--no-skills or --bare)"
              : null,
          ].filter((entry): entry is string => entry !== null),
        },
      ),
      `saved decision: ${saved}`,
      "Use /trust grant or /trust revoke to change future sessions.",
    ].join("\n"),
    "info",
  );
}

async function setAutonomyProfile(
  runtime: CodepunkRuntime,
  profile: "read-only" | "ask" | "scoped",
): Promise<void> {
  if (profile === "read-only") {
    const issue = readOnlyLiveSwitchIssue({
      pluginsEnabled: runtime.plugins.enabled,
      mcpServers: runtime.mcpServers,
      sandboxStartedWritable:
        runtime.sandbox?.sandboxed === true &&
        !runtime.permissionSnapshot.readOnly,
    });
    if (issue !== null) {
      throw new Error(issue);
    }
  } else {
    const issue = readOnlyLiveWidenIssue({
      target: profile,
      sandboxStartedReadOnly:
        runtime.sandbox?.sandboxed === true &&
        runtime.permissionSnapshot.readOnly,
    });
    if (issue !== null) {
      throw new Error(issue);
    }
  }
  if (profile !== "scoped") {
    runtime.autonomy.setProfile(profile);
    return;
  }
  const filePath = runtime.config.autonomy.scoped_rules;
  if (filePath !== null && filePath.length > 0) {
    const loaded = await loadScopedRules(filePath, runtime.paths);
    runtime.autonomy.replaceRules(
      loaded.rules,
      autonomyRulesHash(loaded.rules),
    );
  }
  runtime.autonomy.setProfile("scoped");
}

export class TuiApprovalChannel implements ApprovalChannel {
  readonly id = "codepunk-tui";
  readonly kind = "tui" as const;
  readonly isTTY: boolean;
  private context: ExtensionContext | null = null;
  private persist: ((request: ApprovalRequest) => Promise<boolean>) | null =
    null;

  constructor(isTTY = process.stdin.isTTY === true) {
    this.isTTY = isTTY;
  }

  attach(context: ExtensionContext): void {
    this.context = context;
  }

  setPersistHandler(
    handler: (request: ApprovalRequest) => Promise<boolean>,
  ): void {
    this.persist = handler;
  }

  async ask(request: ApprovalRequest): Promise<ApprovalAnswer | null> {
    if (!this.isTTY || this.context === null) {
      return null;
    }
    const canReuseExact =
      request.argv !== undefined &&
      request.argv.length > 0 &&
      request.cwd !== undefined;
    const choices = APPROVAL_CHOICES.filter(
      (choice) => choice.scope === "once" || canReuseExact,
    );
    const options = choices.map((choice) => choice.label);
    while (true) {
      const selected = await this.context.ui.select(
        formatApproval(request),
        options,
      );
      const choice = choices.find((candidate) => candidate.label === selected);
      if (choice === undefined || choice.decision === "deny") {
        const guidance =
          choice?.guidance === true
            ? (
                await this.context.ui.input(
                  "Denial guidance (optional)",
                  "Tell the model what to do instead",
                )
              )?.trim()
            : undefined;
        return this.answer(
          request,
          "deny",
          "once",
          guidance === undefined || guidance.length === 0
            ? undefined
            : guidance,
        );
      }
      if (choice.scope === "persistent") {
        const confirmed = await this.context.ui.select(
          persistentApprovalPreview(request),
          [PERSIST_APPROVAL, PERSIST_BACK],
        );
        if (confirmed === PERSIST_BACK) {
          continue;
        }
        if (confirmed !== PERSIST_APPROVAL) {
          return this.answer(request, "deny", "once");
        }
        const stored = await this.persist?.(request);
        if (stored !== true) {
          this.context.ui.notify(
            "the exact rule was not stored; allowing this call only",
            "warning",
          );
          return this.answer(request, "allow", "once");
        }
      }
      return this.answer(request, "allow", choice.scope);
    }
  }

  private answer(
    request: ApprovalRequest,
    decision: "allow" | "deny",
    scope: ApprovalScope,
    guidance?: string,
  ): ApprovalAnswer {
    return {
      request_id: request.request_id,
      answer: decision,
      scope,
      ...(guidance === undefined ? {} : { guidance }),
      channel: this.kind,
      channel_id: request.channel_id,
      nonce_sha256: request.nonce_sha256,
      worker_id: request.worker_id,
      session_id: request.session_id,
      tool_call_id: request.tool_call_id,
      answered_at: new Date().toISOString(),
    };
  }
}

class InterceptingEditor extends CustomEditor {
  private readonly intercept: (text: string) => Promise<boolean> | boolean;

  constructor(
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    intercept: (text: string) => Promise<boolean> | boolean,
  ) {
    super(tui as never, theme as never, keybindings as never);
    this.intercept = intercept;
    let assigned: ((text: string) => Promise<void> | void) | undefined;
    Object.defineProperty(this, "onSubmit", {
      configurable: true,
      get:
        () =>
        async (text: string): Promise<void> => {
          if (await this.intercept(text)) {
            this.setText("");
            return;
          }
          await assigned?.(text);
        },
      set: (handler: ((text: string) => Promise<void> | void) | undefined) => {
        assigned = handler;
      },
    });
  }
}

class EditorBridge extends InterceptingEditor {
  constructor(
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    intercept: (text: string) => Promise<boolean> | boolean,
  ) {
    super(tui, theme, keybindings, intercept);
  }
}

function evidenceCount(runtime: CodepunkRuntime): number {
  return runtime.ledger.all.length;
}

function isUnknownModel(
  model: { provider: string; id: string } | undefined,
): boolean {
  return (
    model !== undefined &&
    model.provider === "unknown" &&
    model.id === "unknown"
  );
}

function selectedModel(
  runtime: CodepunkRuntime,
): CodepunkRuntime["host"]["session"]["model"] | undefined {
  const model = runtime.host.session.model;
  return isUnknownModel(model) ? undefined : model;
}

function lastRoutedModel(runtime: CodepunkRuntime): string | undefined {
  for (
    let index = runtime.host.session.messages.length - 1;
    index >= 0;
    index--
  ) {
    const message = runtime.host.session.messages[index]!;
    if (
      message.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted"
    ) {
      return `${message.provider}/${message.model}`;
    }
  }
  return undefined;
}

function physicalModel(
  runtime: CodepunkRuntime,
): CodepunkRuntime["host"]["session"]["model"] | undefined {
  if (!isUnknownModel(runtime.primaryModel)) {
    return runtime.primaryModel;
  }
  const selected = selectedModel(runtime);
  return selected !== undefined && !isFallbackModel(selected)
    ? selected
    : undefined;
}

function modelStatus(runtime: CodepunkRuntime): string {
  const selected = selectedModel(runtime);
  if (selected === undefined) {
    return `codepunk · ${runtime.config.model.provider ?? "auto"}/${runtime.config.model.id ?? "auto"}`;
  }
  if (isFallbackModel(selected)) {
    const primary = physicalModel(runtime);
    const primaryReference =
      primary === undefined ? "unrouted" : `${primary.provider}/${primary.id}`;
    const routed = lastRoutedModel(runtime);
    return `codepunk · auto -> ${primaryReference}${
      routed !== undefined && routed !== primaryReference
        ? ` (last ${routed})`
        : ""
    }`;
  }
  return `codepunk · ${selected.provider}/${selected.id}`;
}

function renderStatus(state: TuiState): string {
  const runtime = state.runtime;
  if (runtime === null) {
    return "codepunk · starting";
  }
  const profile = permissionProfileFor(runtime.config);
  const usage = runtime.usage();
  const tokenLimit =
    runtime.config.budget.max_tokens === null
      ? null
      : runtime.config.budget.max_tokens;
  return [
    modelStatus(runtime),
    `project ${runtime.paths.projectId} · session ${runtime.session.sessionId.slice(0, 12)}`,
    `permissions ${profile} · trust ${runtime.workspaceTrust.trusted ? "trusted" : "untrusted"} · shell ${currentShellStatus(runtime)} · next sandbox ${runtime.config.sandbox.mode} · fs ${runtime.config.filesystem.mode} · evidence ${evidenceCount(runtime)} · tokens ${usage.total_tokens}${tokenLimit === null ? "" : `/${tokenLimit}`}`,
  ].join("\n");
}

export function modelOnboardingMessage(
  runtime: CodepunkRuntime,
): string | undefined {
  const active = physicalModel(runtime);
  const configuredProvider = runtime.config.model.provider;
  const configuredId = runtime.config.model.id;
  if (active === undefined) {
    const configured =
      configuredProvider === null || configuredId === null
        ? null
        : `${configuredProvider}/${configuredId}`;
    return [
      configured === null
        ? "No model configured."
        : `Configured model ${configured} is not active.`,
      "Choose one with /model (type to search, Ctrl+S saves the default), or add a provider with /login.",
      "For a custom OpenAI-compatible endpoint:",
      "  codepunk models import <base-url> --provider <id> --api openai-responses",
      "  codepunk models set <id>/<model>",
    ].join("\n");
  }
  if (configuredProvider === null || configuredId === null) {
    return [
      "No default model configured.",
      `This session is using ${active.provider}/${active.id} (selected by the Pi host).`,
      "Run /model and type to search; Ctrl+S saves the highlighted model as default.",
      "Select an exact model and save it with:",
      `  /model ${active.provider}/${active.id}`,
    ].join("\n");
  }
  return undefined;
}

function noAuthenticatedModelsMessage(): string {
  return [
    "No authenticated models.",
    "Add a provider first:",
    "  /login                         sign in to a built-in provider",
    "  codepunk models import <base-url> --provider <id> --api openai-responses",
    "  codepunk models set <id>/<model>",
    "Then run /model to choose a model.",
  ].join("\n");
}

const DIFF_DISPLAY_LINES = 240;

export function formatWorkspaceDiff(diff: WorkspaceDiff): string {
  const status = diff.status.trimEnd();
  const lines = [`Working tree diff · ${diff.root}`];
  if (status.length === 0) {
    return [...lines, "", "No changes."].join("\n");
  }
  lines.push("", status);
  const stat = diff.stat.trimEnd();
  if (stat.length > 0) {
    lines.push("", stat);
  }
  const untracked = diff.untracked
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (untracked.length > 0) {
    lines.push(
      "",
      `untracked files (${untracked.length}; no patch until staged):`,
      ...untracked.slice(0, COMMIT_PREVIEW_FILES).map((file) => `  ${file}`),
    );
    if (untracked.length > COMMIT_PREVIEW_FILES) {
      lines.push(`  … ${untracked.length - COMMIT_PREVIEW_FILES} more`);
    }
  }
  const patch = [diff.staged.trimEnd(), diff.unstaged.trimEnd()]
    .filter((entry) => entry.length > 0)
    .join("\n\n");
  if (patch.length > 0) {
    const patchLines = patch.split("\n");
    lines.push("", ...patchLines.slice(0, DIFF_DISPLAY_LINES));
    if (patchLines.length > DIFF_DISPLAY_LINES || diff.truncated) {
      lines.push(
        "",
        `(diff truncated at ${DIFF_DISPLAY_LINES} lines; run git diff for the full patch)`,
      );
    }
  } else if (diff.truncated) {
    lines.push("", "(diff truncated; run git diff for the full patch)");
  }
  return lines.join("\n");
}

const COMMIT_PREVIEW_FILES = 30;

function commitFileSection(label: string, files: readonly string[]): string[] {
  if (files.length === 0) {
    return [];
  }
  const visible = files.slice(0, COMMIT_PREVIEW_FILES);
  const lines = [
    `${label} (${files.length})`,
    ...visible.map((file) => `  ${file}`),
  ];
  if (files.length > visible.length) {
    lines.push(`  … ${files.length - visible.length} more`);
  }
  return lines;
}

export function formatCommitPreview(preview: WorkspaceCommitPreview): string {
  const lines = [
    `Commit preview · ${preview.root}`,
    `branch: ${preview.branch ?? "(detached)"} · HEAD: ${
      preview.head === null ? "(unborn)" : preview.head.slice(0, 12)
    }`,
  ];
  lines.push(
    ...commitFileSection("staged", preview.staged),
    ...commitFileSection("unstaged tracked", preview.unstaged),
    ...commitFileSection("untracked", preview.untracked),
  );
  if (
    preview.staged.length === 0 &&
    preview.unstaged.length === 0 &&
    preview.untracked.length === 0
  ) {
    lines.push("No changes.");
  }
  if (preview.staged_stat.length > 0) {
    lines.push("", "staged stat:", preview.staged_stat);
  }
  if (preview.unstaged_stat.length > 0) {
    lines.push("", "unstaged stat:", preview.unstaged_stat);
  }
  return lines.join("\n");
}

async function chooseCommitStage(
  context: ExtensionContext,
  preview: WorkspaceCommitPreview,
): Promise<GitCommitStage | null> {
  const hasStaged = preview.staged.length > 0;
  const hasUnstaged = preview.unstaged.length > 0;
  const hasUntracked = preview.untracked.length > 0;
  const choices: Array<{ label: string; value: GitCommitStage }> = [];
  if (hasStaged) {
    choices.push({
      label: `Commit staged changes only (${preview.staged.length})`,
      value: "staged",
    });
  }
  if (hasUnstaged) {
    choices.push({
      label: `Stage tracked changes and commit (${preview.unstaged.length})`,
      value: "tracked",
    });
  }
  if (hasUntracked) {
    choices.push({
      label: `Stage all changes including untracked (${preview.untracked.length} untracked)`,
      value: "all",
    });
  }
  if (hasStaged && (hasUnstaged || hasUntracked)) {
    const total =
      preview.staged.length +
      preview.unstaged.length +
      preview.untracked.length;
    choices.push({
      label: `Stage everything and commit (${total})`,
      value: "all",
    });
  }
  if (choices.length === 0) {
    context.ui.notify("Nothing to commit.", "warning");
    return null;
  }
  const labels = [...choices.map((choice) => choice.label), "Cancel"];
  const selected = await context.ui.select("Commit scope", labels);
  if (selected === undefined || selected === "Cancel") {
    return null;
  }
  return choices.find((choice) => choice.label === selected)?.value ?? null;
}

function commitSummary(result: GitCommitResult): string {
  const subject = result.message.split(/\r?\n/u)[0] ?? result.message;
  const ignored =
    result.ignored.length === 0
      ? ""
      : `\nignored (not committed): ${result.ignored.length}`;
  return [
    `commit created: ${result.commit.slice(0, 12)}`,
    `subject: ${subject}`,
    `root: ${result.root}`,
    `files: ${result.files.length}`,
    `stage: ${result.stage}${ignored}`,
  ].join("\n");
}

function checkpointPreviewText(
  action: "undo" | "redo",
  preview: CheckpointPreview,
): string {
  if (preview.entries.length === 0) {
    return action === "undo"
      ? "No applied Codepunk file checkpoint is available."
      : "No undone Codepunk file checkpoint is available.";
  }
  return preview.entries
    .map(
      (entry) =>
        `${entry.tool} ${entry.display_target} (${entry.state} → ${action === "undo" ? "before" : "after"})`,
    )
    .join("\n");
}

async function restoreCheckpoint(
  state: TuiState,
  context: ExtensionCommandContext,
  action: "undo" | "redo",
  argument: string,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  if (runtime.host.session.isStreaming || runtime.host.session.isCompacting) {
    context.ui.notify(
      `Wait for the current ${runtime.host.session.isStreaming ? "response" : "compaction"} to finish before /${action}.`,
      "warning",
    );
    return;
  }
  const raw = argument.trim();
  const count = raw.length === 0 ? 1 : Number(raw);
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    context.ui.notify(`usage: /${action} [count]`, "warning");
    return;
  }
  let preview: CheckpointPreview;
  try {
    preview = await runtime.checkpoints.preview(action, count);
  } catch (error) {
    const message =
      error instanceof CheckpointConflictError
        ? error.message
        : `checkpoint preview failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
    context.ui.notify(message, "error");
    return;
  }
  if (preview.entries.length === 0) {
    context.ui.notify(checkpointPreviewText(action, preview), "info");
    return;
  }
  const confirmed = await context.ui.confirm(
    action === "undo" ? "Undo file changes?" : "Redo file changes?",
    `${checkpointPreviewText(action, preview)}\n\nOnly files whose current digest matches the checkpoint will be changed.`,
  );
  if (!confirmed) {
    context.ui.notify(`${action} cancelled.`, "info");
    return;
  }
  let result;
  try {
    result =
      action === "undo"
        ? await runtime.checkpoints.undo(count)
        : await runtime.checkpoints.redo(count);
  } catch (error) {
    const message =
      error instanceof CheckpointConflictError
        ? error.message
        : `${action} failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
    context.ui.notify(message, "error");
    return;
  }
  for (const entry of result.entries) {
    const from = action === "undo" ? entry.after.sha256 : entry.before.sha256;
    const to = action === "undo" ? entry.before.sha256 : entry.after.sha256;
    try {
      await runtime.host.recordEvent("checkpoint/restore", {
        action,
        checkpoint_id: entry.id,
        tool_call_id: entry.tool_call_id,
        target: entry.target,
        from_sha256: from,
        to_sha256: to,
      });
    } catch {
      context.ui.notify(
        `${action} restored files, but its session event could not be recorded.`,
        "warning",
      );
    }
  }
  context.ui.notify(
    `${action}: ${result.entries.length} file checkpoint(s) restored.`,
    "info",
  );
}

async function configureCommit(
  state: TuiState,
  context: ExtensionCommandContext,
  argument: string,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  let message = argument.trim();
  if (message.length === 0) {
    message =
      (
        await context.ui.input(
          "Commit message",
          "Subject line; Enter to continue, Escape to cancel",
        )
      )?.trim() ?? "";
  }
  if (message.length === 0) {
    context.ui.notify("Commit cancelled: a message is required.", "warning");
    return;
  }
  let preview: WorkspaceCommitPreview;
  try {
    preview = await readWorkspaceCommitPreview({
      root: runtime.paths.deliveryRoot,
    });
  } catch (error) {
    context.ui.notify(
      `/commit failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  if (
    preview.staged.length === 0 &&
    preview.unstaged.length === 0 &&
    preview.untracked.length === 0
  ) {
    context.ui.notify("Nothing to commit.", "warning");
    return;
  }
  await notify(context, formatCommitPreview(preview));
  const stage = await chooseCommitStage(context, preview);
  if (stage === null) {
    return;
  }
  const confirmed = await context.ui.confirm(
    "Create this commit?",
    `${message.split(/\r?\n/u)[0]}\n\n${formatCommitPreview(preview)}`,
  );
  if (!confirmed) {
    context.ui.notify("Commit cancelled.", "info");
    return;
  }

  const started = Date.now();
  let result: GitCommitResult;
  try {
    result = await createGitCommit({
      root: runtime.paths.deliveryRoot,
      message,
      stage,
    });
  } catch (error) {
    context.ui.notify(
      `Commit failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  const summary = commitSummary(result);
  let evidenceHead: string | null = null;
  try {
    const rule = "product.commit";
    const ruleSha256 = recordHash({ rule });
    await runtime.ledger.append({
      task_id: null,
      run_id: runtime.ledger.activeRunId,
      session_id: runtime.session.sessionId,
      source: "tool",
      tool: "commit",
      tool_call_id: `commit:${result.commit}`,
      decision: "allow",
      outcome: "completed",
      rule,
      rule_sha256: ruleSha256,
      policy_layers: [
        {
          layer: "user",
          source: "product:/commit",
          sha256: sha256Text("product:/commit"),
          rule_sha256: ruleSha256,
        },
      ],
      approval: null,
      command: "git commit",
      command_argv: ["git", "commit", "-m", "<redacted>"],
      cwd: runtime.paths.cwd,
      workspace_root: runtime.paths.deliveryRoot,
      path_check: { performed: false, target: null },
      sandbox: { backend: "none", version: null, profile_sha256: null },
      effects: { fs: "write", shell: false, network: false },
      coverage: "uncovered",
      coverage_basis: ["product-action", "git"],
      exit_code: 0,
      duration_ms: Date.now() - started,
      before_sha256: null,
      after_sha256: null,
      diff_sha256: null,
      output_ref: null,
      output_sha256: outputSha(summary),
      output_preview: redactOutputPreview(summary, runtime.paths.home).slice(
        0,
        4_096,
      ),
      empty_result: false,
      executor: "codepunk-commit",
      vcs: {
        commit: result.commit,
        tree: result.tree,
        base_commit: result.previous_commit,
      },
      memory: {
        ids: [],
        action: "none",
        query_sha256: null,
        cap: 0,
        truncated: false,
      },
    });
    evidenceHead = runtime.ledger.head;
  } catch (error) {
    context.ui.notify(
      `${summary}\n\ncommit created, but evidence recording failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "warning",
    );
    return;
  }
  try {
    await runtime.host.recordEvent("commit/created", {
      run_id: runtime.ledger.activeRunId,
      commit: result.commit,
      previous_commit: result.previous_commit,
      tree: result.tree,
      message_sha256: sha256Text(result.message),
      message_bytes: Buffer.byteLength(result.message, "utf8"),
      files: result.files,
      stage: result.stage,
      root: result.root,
      evidence_head: evidenceHead,
    });
  } catch (error) {
    context.ui.notify(
      `${summary}\n\ncommit and evidence created, but the session event failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "warning",
    );
    return;
  }
  context.ui.notify(summary, "info");
}

export function resolveMcpLoginTarget(
  configs: readonly McpServerConfig[],
  requested: string | undefined,
): Extract<McpServerConfig, { transport: "http" }> {
  const oauthCandidates = configs.filter(
    (config) =>
      config.transport === "http" && !mcpUsesAuthorizationHeader(config),
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
        : `mcp login requires a server name; candidates: ${oauthCandidates
            .map((config) => config.name)
            .join(", ")}`,
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
  return target;
}

function modelLabel(model: {
  provider: string;
  id: string;
  name?: string;
}): string {
  const name =
    model.name === undefined ||
    model.name.length === 0 ||
    model.name === model.id
      ? ""
      : ` — ${model.name}`;
  return `${model.provider}/${model.id}${name}`;
}

function customEndpointMessage(): string {
  return [
    "Add a custom OpenAI-compatible endpoint:",
    "  codepunk models import <base-url> --provider <id> --api openai-responses",
    "  codepunk models set <id>/<model>",
    "Then run /model to choose it.",
  ].join("\n");
}

/**
 * First-run setup belongs in the interactive surface, not a warning that
 * blocks the first prompt. Other coding agents open a provider/model chooser
 * at this point; Codepunk keeps the same host picker and login command behind
 * one small arrow-key menu.
 */
async function promptForMissingModel(
  state: TuiState,
  context: ExtensionContext,
): Promise<boolean> {
  const runtime = state.runtime;
  if (runtime === null) {
    return false;
  }
  if (state.modelOnboardingShown === true) {
    context.ui.notify(
      modelOnboardingMessage(runtime) ??
        "No model selected. Use /model to choose one.",
      "warning",
    );
    return true;
  }
  state.modelOnboardingShown = true;

  const models = await availableModels(runtime).catch(() => []);
  if (models.length > 0) {
    const visible = models.slice(0, 20);
    const labels = visible.map(modelLabel);
    const selected = await context.ui.select(
      "No model configured. Choose a model for this session:",
      [...labels, "Set up a provider instead", "Cancel"],
    );
    if (selected === undefined || selected === "Cancel") {
      return true;
    }
    if (selected === "Set up a provider instead") {
      return await showProviderSetup(state, context);
    }
    const model = visible[labels.indexOf(selected)];
    if (model !== undefined) {
      await selectModelReference(
        state,
        context,
        `${model.provider}/${model.id}`,
      );
      return true;
    }
    return true;
  }

  return await showProviderSetup(state, context);
}

async function showProviderSetup(
  state: TuiState,
  context: ExtensionContext,
): Promise<boolean> {
  const runtime = state.runtime;
  if (runtime === null) {
    return false;
  }
  const selected = await context.ui.select("No model configured", [
    "Sign in to a provider",
    "Add an OpenAI-compatible endpoint",
    "Show setup commands",
    "Cancel",
  ]);
  if (selected === undefined || selected === "Cancel") {
    return true;
  }
  if (selected === "Sign in to a provider") {
    context.ui.setEditorText("/login");
    context.ui.notify(
      "Press Enter to open Pi's provider sign-in; Esc closes it.",
      "info",
    );
    return true;
  }
  context.ui.notify(
    selected === "Add an OpenAI-compatible endpoint"
      ? customEndpointMessage()
      : (modelOnboardingMessage(runtime) ?? customEndpointMessage()),
    "info",
  );
  return true;
}

async function availableModels(runtime: CodepunkRuntime) {
  const modelRuntime = runtime.host.services.modelRuntime;
  const cached = modelRuntime.getAvailableSnapshot();
  if (cached.length > 0) {
    return [...cached];
  }
  return modelRuntime.getAvailable();
}

async function selectModelReference(
  state: TuiState,
  context: ExtensionContext,
  reference: string,
): Promise<boolean> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return true;
  }
  if (reference.length === 0) {
    context.ui.notify(
      "usage: /model <provider/model>; omit the argument to search interactively",
      "warning",
    );
    return true;
  }
  const modelRuntime = runtime.host.services.modelRuntime;
  const resolution = resolveModelSelection(modelRuntime, reference);
  if (resolution.status !== "resolved") {
    context.ui.notify(resolution.error, "warning");
    return true;
  }
  const model = resolution.model;
  try {
    await resolveConfiguredModel(
      runtime.paths,
      {
        ...runtime.config,
        model: {
          ...runtime.config.model,
          provider: model.provider,
          id: model.id,
        },
      },
      modelRuntime,
    );
    await runtime.host.session.setModel(model);
    if (resolution.thinkingLevel !== undefined) {
      runtime.host.session.setThinkingLevel(resolution.thinkingLevel);
    }
  } catch (error) {
    context.ui.notify(
      `model could not be selected: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
    return true;
  }
  runtime.primaryModel = model;
  try {
    await setConfiguredModel(
      runtime.paths,
      runtime.config,
      model.provider,
      model.id,
      resolution.thinkingLevel,
    );
    context.ui.notify(
      `model set to ${model.provider}/${model.id}\nconfig: ${runtime.paths.home}/config.toml`,
      "info",
    );
  } catch (error) {
    context.ui.notify(
      `model selected for this session; config was not saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "warning",
    );
  }
  state.modelSelected = true;
  setupChrome(state, context);
  return true;
}

async function notify(
  context: ExtensionCommandContext,
  message: string,
): Promise<void> {
  context.ui.notify(message, "info");
}

interface SubagentInvocation {
  task: string;
  profileName?: string;
  model?: string;
  worktree: boolean;
  shared: boolean;
}

function parseSubagentInvocation(args: string): SubagentInvocation {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  let profileName: string | undefined;
  let model: string | undefined;
  let worktree = false;
  let shared = false;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("--")) {
      break;
    }
    if (token === "--worktree") {
      worktree = true;
      index += 1;
      continue;
    }
    if (token === "--shared") {
      shared = true;
      index += 1;
      continue;
    }
    if (token !== "--profile" && token !== "--model") {
      throw new Error(
        "usage: /subagent [--profile <name>] [--model <provider/model>] [--worktree|--shared] <task>",
      );
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`/subagent ${token} requires a value`);
    }
    if (token === "--profile") {
      profileName = value;
    } else {
      model = value;
    }
    index += 2;
  }
  const task = tokens.slice(index).join(" ").trim();
  if (task.length === 0) {
    throw new Error(
      "usage: /subagent [--profile <name>] [--model <provider/model>] [--worktree|--shared] <task>",
    );
  }
  if (worktree && shared) {
    throw new Error("--worktree and --shared are mutually exclusive");
  }
  return {
    task,
    ...(profileName !== undefined ? { profileName } : {}),
    ...(model !== undefined ? { model } : {}),
    worktree,
    shared,
  };
}

function profilePool(profile: AgentProfile): string[] {
  return profile.model === null
    ? []
    : [
        profile.model,
        ...profile.fallback.filter((entry) => entry !== profile.model),
      ];
}

function profileTools(profile: AgentProfile | undefined): string[] {
  if (profile === undefined) {
    return ["read", "search"];
  }
  return Object.entries(profile.tools)
    .filter(([name, enabled]) => name !== "memory_search" && enabled)
    .map(([name]) => name);
}

async function runSubagent(
  state: TuiState,
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  args: string,
): Promise<void> {
  let invocation: SubagentInvocation;
  try {
    invocation = parseSubagentInvocation(args);
  } catch (error) {
    context.ui.notify(
      error instanceof Error ? error.message : String(error),
      "warning",
    );
    return;
  }
  if (state.childHostArgv.length === 0) {
    context.ui.notify(
      "subagent host is not available in this invocation",
      "error",
    );
    return;
  }
  const bundle = await loadAgentProfiles(runtime.paths, {
    projectTrusted: runtime.workspaceTrust.trusted,
  });
  if (bundle.warnings.length > 0) {
    context.ui.notify(bundle.warnings.join("\n"), "warning");
  }
  const profile =
    invocation.profileName === undefined
      ? undefined
      : bundle.profiles.find(
          (candidate) => candidate.name === invocation.profileName,
        );
  if (invocation.profileName !== undefined && profile === undefined) {
    context.ui.notify(
      `agent profile ${invocation.profileName} was not found${
        bundle.profiles.length === 0
          ? ""
          : `; available: ${bundle.profiles.map((entry) => entry.name).join(", ")}`
      }`,
      "error",
    );
    return;
  }
  const pool = profile === undefined ? [] : profilePool(profile);
  if (invocation.model !== undefined && pool.length > 0) {
    if (!pool.includes(invocation.model)) {
      context.ui.notify(
        `model ${invocation.model} is outside profile ${profile!.name}'s pool: ${pool.join(", ")}`,
        "error",
      );
      return;
    }
  }
  const mutating =
    profile !== undefined &&
    (profile.tools.write || profile.tools.edit || profile.tools.shell);
  if (invocation.shared && mutating) {
    context.ui.notify(
      `profile ${profile!.name} can mutate files and requires a worktree; remove --shared`,
      "error",
    );
    return;
  }
  const isolation: "shared" | "worktree" =
    mutating || invocation.worktree ? "worktree" : "shared";
  const registry = (state.subagents ??= new Map());
  const running = [...registry.values()].filter(
    (record) => record.status === "running",
  );
  if (running.length >= 4) {
    context.ui.notify(
      "four background subagents are already running; stop one with /agents stop <id>",
      "warning",
    );
    return;
  }
  const parentSessionId = runtime.session.sessionId;
  const parentRunId = runtime.host.currentRunId;
  const childSessionId = createUlid();
  const activeModel = physicalModel(runtime);
  const configuredModel =
    activeModel !== undefined
      ? `${activeModel.provider}/${activeModel.id}`
      : runtime.config.model.provider !== null &&
          runtime.config.model.id !== null
        ? `${runtime.config.model.provider}/${runtime.config.model.id}`
        : undefined;
  const primaryModel =
    invocation.model ?? profile?.model ?? configuredModel ?? undefined;
  const profileFallbacks =
    pool.length === 0
      ? []
      : [
          ...new Set(
            pool.filter((entry) => entry !== (primaryModel ?? undefined)),
          ),
        ];
  const fallbackModels =
    profileFallbacks.length === 0 ? undefined : profileFallbacks;
  const activeThinking = runtime.host.session.thinkingLevel;
  const thinking = profile?.thinking ?? activeThinking;
  const workspaceTrustOverride =
    isolation === "worktree"
      ? runtime.workspaceTrust.trusted
        ? ("trust" as const)
        : ("no-trust" as const)
      : runtime.workspaceTrust.source === "saved" ||
          runtime.workspaceTrust.source === "no-resources"
        ? undefined
        : runtime.workspaceTrust.trusted
          ? ("trust" as const)
          : ("no-trust" as const);
  const controller = new AbortController();
  const record: BackgroundSubagent = {
    childSessionId,
    prompt: invocation.task,
    profile: profile?.name ?? null,
    isolation,
    startedAt: Date.now(),
    status: "running",
    result: null,
    error: null,
    worktree: null,
    streamTail: "",
    lastTool: null,
    lastStreamUpdate: 0,
    delivery: null,
    controller,
    promise: Promise.resolve(),
  };
  registry.set(childSessionId, record);
  updateSubagentStatus(state);
  context.ui.notify(
    [
      `subagent started: ${childSessionId}`,
      `profile: ${profile === undefined ? "built-in read-only" : `${profile.name} (${profile.source})`}`,
      `isolation: ${isolation}`,
      `tools: ${profileTools(profile).join(", ")}`,
      `model: ${
        primaryModel === undefined
          ? "inherited"
          : `${primaryModel}${
              fallbackModels === undefined || fallbackModels.length === 0
                ? ""
                : ` (+${fallbackModels.join(",")})`
            }`
      }`,
      "background: use /agents, /agents result <id>, or /agents stop <id>",
    ].join("\n"),
    "info",
  );
  record.promise = (async () => {
    let stopped = false;
    let failureWorktree: string | null = null;
    try {
      record.result = await runSubagentHost({
        hostArgv: state.childHostArgv,
        cwd: runtime.paths.cwd,
        ...(runtime.paths.additionalRoots.length === 0
          ? {}
          : { additionalDirs: runtime.paths.additionalRoots }),
        parentSessionId,
        childSessionId,
        prompt: invocation.task,
        isolation,
        ...(profile === undefined
          ? {}
          : {
              profile: {
                name: profile.name,
                sha256: profile.sha256,
                tools: profile.tools,
                systemPrompt: profile.systemPrompt,
                model: profile.model,
                fallback: profile.fallback,
                thinking: profile.thinking,
              },
            }),
        ...(workspaceTrustOverride === undefined
          ? {}
          : { workspaceTrustOverride }),
        ...(primaryModel !== undefined ? { model: primaryModel } : {}),
        ...(fallbackModels !== undefined
          ? {
              fallbackModels,
              fallbackAllowCrossProvider: true,
            }
          : {}),
        thinking,
        bare: runtime.isolation.bare,
        noSkills: runtime.isolation.skills,
        onEvent: (event) => observeSubagentEvent(state, record, event),
        signal: controller.signal,
      });
      record.status = "completed";
      record.worktree = record.result?.worktree ?? null;
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      if (error instanceof ChildHostError && error.worktree !== null) {
        failureWorktree = error.worktree;
      }
      record.worktree = failureWorktree;
      stopped =
        error instanceof ChildHostError && error.code === "subagent.stopped";
      record.status = stopped ? "stopped" : "failed";
    }
    const eventData = {
      run_id: parentRunId,
      parent_session_id: parentSessionId,
      child_session_id: childSessionId,
      depth: 1,
      isolation: record.result?.isolation ?? isolation,
      model: record.result?.model ?? primaryModel ?? null,
      status: record.status,
      summary: record.result?.summary ?? "",
      evidence_head: record.result?.evidence_head ?? null,
      child_run_id: record.result?.child_run_id ?? null,
      exit_code: record.result?.exit_code ?? null,
      error: record.error,
      profile: record.result?.profile ?? profile?.name ?? null,
      profile_sha256: record.result?.profile_sha256 ?? profile?.sha256 ?? null,
      worktree: record.result?.worktree ?? failureWorktree,
      base_commit: record.result?.base_commit ?? null,
      changed_files: record.result?.changed_files ?? null,
    };
    try {
      await runtime.host.recordEvent("subagent/result", eventData);
    } catch (error) {
      state.context?.ui.notify(
        `subagent result could not be recorded: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
    }
    updateSubagentStatus(state);
    if (record.status === "completed") {
      state.context?.ui.notify(
        [
          `subagent ${childSessionId} completed; use /agents result ${childSessionId}`,
          ...(record.result?.worktree === null ||
          record.result?.worktree === undefined
            ? []
            : [
                `worktree: ${record.result.worktree}`,
                `next: /agents review ${childSessionId} → /agents sign ${childSessionId} → /agents merge ${childSessionId}`,
                `discard: /agents discard ${childSessionId}`,
              ]),
        ].join("\n"),
        "info",
      );
    } else {
      const worktreeNotice =
        failureWorktree === null || record.error?.includes(failureWorktree)
          ? ""
          : `\nworktree: ${failureWorktree}`;
      state.context?.ui.notify(
        `subagent ${childSessionId} ${record.status}${
          record.error === null ? "" : `: ${record.error}`
        }${worktreeNotice}`,
        record.status === "stopped" ? "warning" : "error",
      );
    }
  })();
}

function formatSubagents(state: TuiState): string {
  const records = [...(state.subagents?.values() ?? [])];
  if (records.length === 0) {
    return "No subagents. Start one with /subagent [--profile <name>] <task>.";
  }
  return records
    .map((record) => {
      const elapsed = Math.max(
        0,
        Math.floor((Date.now() - record.startedAt) / 1_000),
      );
      const prompt = record.prompt.replace(/\s+/gu, " ").slice(0, 100);
      const delivery =
        record.delivery === null ? "" : `  ${record.delivery.state}`;
      const worktree = record.worktree === null ? "" : "  worktree";
      return `${record.childSessionId}  ${record.status}  ${elapsed}s  ${
        record.profile ?? "built-in"
      }  ${record.isolation}${delivery}${worktree}  ${prompt}`;
    })
    .join("\n");
}

function boundedSubagentText(value: string, limit = 12_000): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n[truncated]`;
}

function isCodepunkReviewPath(filePath: string): boolean {
  const normalized = filePath.split("\\").join("/");
  return normalized === ".codepunk/.gitignore";
}

async function subagentReviewText(record: BackgroundSubagent): Promise<string> {
  const worktree = record.worktree ?? record.result?.worktree ?? null;
  if (worktree === null) {
    return `subagent ${record.childSessionId} has no worktree to review`;
  }
  const [diff, preview] = await Promise.all([
    readWorkspaceDiff({ root: worktree, maxBytes: 48 * 1024 }),
    readWorkspaceCommitPreview({ root: worktree }),
  ]);
  const files = [
    ...preview.staged,
    ...preview.unstaged,
    ...preview.untracked,
  ].filter((entry) => !isCodepunkReviewPath(entry));
  const frozenPaths = record.delivery?.handoff?.changed_paths ?? [];
  const untracked = diff.untracked
    .split("\n")
    .filter((entry) => entry.length > 0 && !isCodepunkReviewPath(entry));
  const fileLines =
    files.length > 0
      ? [...new Set(files)].map((entry) => `  ${entry}`).join("\n")
      : frozenPaths.length > 0
        ? frozenPaths.map((entry) => `  ${entry} (frozen)`).join("\n")
        : "  (no files)";
  const patch = [diff.staged, diff.unstaged]
    .filter((entry) => entry.length > 0)
    .join("\n");
  return boundedSubagentText(
    [
      `subagent ${record.childSessionId} · ${record.status}${
        record.delivery === null ? "" : ` · ${record.delivery.state}`
      }`,
      `profile: ${record.profile ?? "built-in"} · isolation: ${record.isolation}`,
      `worktree: ${worktree}`,
      `files: ${files.length > 0 ? files.length : frozenPaths.length}`,
      fileLines,
      ...(preview.staged_stat.length === 0 ? [] : [preview.staged_stat]),
      ...(preview.unstaged_stat.length === 0 ? [] : [preview.unstaged_stat]),
      ...(untracked.length === 0
        ? []
        : [`untracked:\n${untracked.join("\n")}`]),
      ...(patch.length === 0 ? [] : ["patch:", patch]),
      ...(diff.truncated ? ["[patch truncated]"] : []),
      `summary: ${record.result?.summary ?? record.error ?? record.status}`,
    ].join("\n\n"),
  );
}

async function childProjectPaths(
  runtime: CodepunkRuntime,
  record: BackgroundSubagent,
): Promise<{
  paths: ReturnType<typeof projectPaths>;
  cwd: string;
  projectRoot: string;
}> {
  const worktree = record.worktree ?? record.result?.worktree ?? null;
  const context = await findDeliveryRoot(worktree ?? runtime.paths.cwd);
  return {
    paths: projectPaths(context, runtime.paths.home),
    cwd: worktree ?? runtime.paths.cwd,
    projectRoot: context.deliveryRoot,
  };
}

async function reviewSubagent(
  context: ExtensionCommandContext,
  record: BackgroundSubagent,
): Promise<void> {
  try {
    context.ui.notify(await subagentReviewText(record), "info");
  } catch (error) {
    context.ui.notify(
      `subagent review failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
}

async function signSubagent(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  record: BackgroundSubagent,
): Promise<void> {
  const result = record.result;
  if (
    record.status !== "completed" ||
    result === null ||
    record.worktree === null
  ) {
    context.ui.notify(
      `subagent ${record.childSessionId} has no completed worktree to sign`,
      "warning",
    );
    return;
  }
  if (
    result.child_run_id === null ||
    result.child_evidence_path === null ||
    result.evidence_head === null
  ) {
    context.ui.notify(
      `subagent ${record.childSessionId} has no child evidence to sign`,
      "warning",
    );
    return;
  }
  await reviewSubagent(context, record);
  const selected = await context.ui.select(
    `Sign subagent ${record.childSessionId}`,
    ["Sign as complete", "Sign as incomplete", "Cancel"],
  );
  if (selected === undefined || selected === "Cancel") {
    return;
  }
  const signed = selected === "Sign as complete" ? "complete" : "incomplete";
  try {
    const child = await childProjectPaths(runtime, record);
    const signedResult = await signRun({
      paths: child.paths,
      cwd: child.cwd,
      projectRoot: child.projectRoot,
      runId: result.child_run_id,
      request: {
        version: 1,
        evidence_head: result.evidence_head,
        signed_verdict: signed,
        channel: "tui",
        actor: "local-user",
        is_tty: true,
        source: "human",
        previous_sign_off_id: record.delivery?.verdict.sign_off_id ?? null,
      },
    });
    record.delivery = {
      state: signed === "complete" ? "signed" : "signed-incomplete",
      verdict: signedResult.verdict,
    };
    context.ui.notify(
      [
        `subagent ${record.childSessionId} signed ${signed}`,
        `verdict: ${signedResult.verdict.verdict}`,
        ...(signedResult.verdict.verdict === "complete"
          ? [
              `next: /agents merge ${record.childSessionId}`,
              `discard: /agents discard ${record.childSessionId}`,
            ]
          : [`the child run remains incomplete; merge is blocked`]),
      ].join("\n"),
      signedResult.verdict.verdict === "complete" ? "info" : "warning",
    );
  } catch (error) {
    context.ui.notify(
      `subagent sign failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
}

async function mergeSubagent(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  record: BackgroundSubagent,
): Promise<void> {
  const result = record.result;
  if (
    record.status !== "completed" ||
    result === null ||
    record.worktree === null ||
    result.base_commit === null
  ) {
    context.ui.notify(
      `subagent ${record.childSessionId} has no completed worktree to merge`,
      "warning",
    );
    return;
  }
  if (
    record.delivery?.state === "merged" ||
    record.delivery?.state === "discarded"
  ) {
    context.ui.notify(
      `subagent ${record.childSessionId} is already ${record.delivery.state}`,
      "warning",
    );
    return;
  }
  if (
    record.delivery?.verdict.verdict !== "complete" ||
    record.delivery.verdict.sign_off_id === null
  ) {
    context.ui.notify(
      `subagent ${record.childSessionId} is not signed complete; use /agents sign ${record.childSessionId}`,
      "warning",
    );
    return;
  }
  if (
    result.child_run_id === null ||
    result.child_evidence_path === null ||
    result.evidence_head === null
  ) {
    context.ui.notify(
      `subagent ${record.childSessionId} has no child evidence to merge`,
      "warning",
    );
    return;
  }
  const target = await readWorkspaceCommitPreview({
    root: runtime.paths.deliveryRoot,
  });
  if (target.head !== result.base_commit) {
    context.ui.notify(
      `cannot merge: parent HEAD ${target.head ?? "none"} is not the child base ${result.base_commit}`,
      "error",
    );
    return;
  }
  const targetChanges = [
    ...target.staged,
    ...target.unstaged,
    ...target.untracked,
  ].filter((entry) => entry !== ".codepunk" && !entry.startsWith(".codepunk/"));
  if (targetChanges.length > 0) {
    context.ui.notify(
      `cannot merge: the parent working tree is dirty (${targetChanges.join(
        ", ",
      )}); commit or stash its changes first`,
      "error",
    );
    return;
  }
  await reviewSubagent(context, record);
  const confirmed = await context.ui.select(
    `Merge subagent ${record.childSessionId}?`,
    ["Merge the signed child commit", "Cancel"],
  );
  if (confirmed !== "Merge the signed child commit") {
    return;
  }
  try {
    const summaryLine =
      (result.summary.split(/\r?\n/u)[0] ?? "")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 160) || `subagent ${record.childSessionId}`;
    const spec = createTaskSpec({
      taskId: `subagent-${record.childSessionId}`,
      title: `Subagent ${record.profile ?? "built-in"}`,
      objective: record.prompt,
      baseCommit: result.base_commit,
      writeSet: ["."],
      acceptance: ["human review and signed child run"],
      isolation: "worktree",
    });
    const frozen = await freezeWorktree({
      repoRoot: runtime.paths.deliveryRoot,
      worktree: record.worktree,
      baseCommit: result.base_commit,
      protectedPaths: DEFAULT_PROTECTED_PATHS,
      message: `subagent: ${summaryLine}`,
    });
    const handoff = await createHandoff({
      spec,
      worktree: record.worktree,
      workerId: record.childSessionId,
      runId: result.child_run_id,
      evidencePath: result.child_evidence_path,
      verdict: {
        verdict: "complete",
        sign_off_id: record.delivery.verdict.sign_off_id,
        evidence_head: result.evidence_head,
      },
    });
    const handoffPath = await writeHandoff(runtime.paths, handoff);
    const merge = await mergeHandoff({
      paths: runtime.paths,
      repoRoot: runtime.paths.deliveryRoot,
      sourceWorktree: record.worktree,
      spec,
      handoff,
      evidencePath: result.child_evidence_path,
      actor: "local-user",
      human: true,
      taskState: "review_passed",
    });
    const mergeRecordPath = path.join(
      runtime.paths.projectDir,
      "merges",
      spec.task_id,
      `${merge.merge_id}.json`,
    );
    let cleanupError: string | null = null;
    try {
      await removeMergedWorktree({
        repoRoot: runtime.paths.deliveryRoot,
        worktree: record.worktree,
        mergeCommit: merge.merge_commit,
      });
      record.worktree = null;
      result.worktree = null;
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }
    record.delivery = {
      state: "merged",
      verdict: record.delivery.verdict,
      handoff,
      handoffPath,
      merge,
      mergeRecordPath,
    };
    context.ui.notify(
      [
        `subagent ${record.childSessionId} merged`,
        `child commit: ${frozen.headCommit}`,
        `merge commit: ${merge.merge_commit}`,
        `handoff: ${handoffPath}`,
        `merge record: ${mergeRecordPath}`,
        ...(cleanupError === null
          ? ["worktree removed"]
          : [`worktree cleanup failed: ${cleanupError}`]),
      ].join("\n"),
      cleanupError === null ? "info" : "warning",
    );
  } catch (error) {
    context.ui.notify(
      `subagent merge failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
}

async function discardSubagent(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  record: BackgroundSubagent,
): Promise<void> {
  const worktree = record.worktree ?? record.result?.worktree ?? null;
  if (worktree === null) {
    context.ui.notify(
      `subagent ${record.childSessionId} has no worktree to discard`,
      "warning",
    );
    return;
  }
  const confirmed = await context.ui.select(
    `Discard subagent ${record.childSessionId} worktree?`,
    ["Discard unmerged worktree", "Cancel"],
  );
  if (confirmed !== "Discard unmerged worktree") {
    return;
  }
  try {
    await discardWorktree({
      repoRoot: runtime.paths.deliveryRoot,
      worktree,
    });
    record.worktree = null;
    if (record.result !== null) {
      record.result.worktree = null;
    }
    if (record.delivery !== null) {
      record.delivery = {
        ...record.delivery,
        state: "discarded",
      };
    }
    context.ui.notify(
      `subagent ${record.childSessionId} worktree discarded`,
      "info",
    );
  } catch (error) {
    context.ui.notify(
      `subagent discard failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
}

const SUBAGENT_STREAM_LIMIT = 1_200;
const SUBAGENT_WIDGET_LINES = 6;
const SUBAGENT_WIDGET_INTERVAL_MS = 120;

function appendSubagentStream(previous: string, text: string): string {
  const combined = `${previous}${text}`.replace(/\r/gu, "");
  return combined.length <= SUBAGENT_STREAM_LIMIT
    ? combined
    : combined.slice(-SUBAGENT_STREAM_LIMIT);
}

function subagentWidgetLines(record: BackgroundSubagent): string[] {
  const preview = record.streamTail
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-2)
    .map((line) => (line.length > 160 ? line.slice(-160) : line));
  if (preview.length === 0) {
    return [];
  }
  return [
    `${record.childSessionId.slice(0, 10)} ${record.profile ?? "built-in"}${
      record.lastTool === null ? "" : ` · ${record.lastTool}`
    }`,
    ...preview.map((line) => `  ${line}`),
  ];
}

function applySubagentWidget(state: TuiState): void {
  if (state.context === null) {
    return;
  }
  const lines = [...(state.subagents?.values() ?? [])]
    .filter((record) => record.status === "running")
    .flatMap(subagentWidgetLines)
    .slice(-SUBAGENT_WIDGET_LINES);
  state.context.ui.setWidget(
    "subagents",
    lines.length === 0 ? undefined : lines,
    { placement: "aboveEditor" },
  );
}

function observeSubagentEvent(
  state: TuiState,
  record: BackgroundSubagent,
  event: SubagentStreamEvent,
): void {
  if (record.status !== "running") {
    return;
  }
  if (event.type === "assistant_delta") {
    record.streamTail = appendSubagentStream(record.streamTail, event.text);
  } else {
    record.lastTool = event.tool;
  }
  const now = Date.now();
  if (now - record.lastStreamUpdate < SUBAGENT_WIDGET_INTERVAL_MS) {
    return;
  }
  record.lastStreamUpdate = now;
  applySubagentWidget(state);
}

function updateSubagentStatus(state: TuiState): void {
  if (state.context === null) {
    return;
  }
  const records = [...(state.subagents?.values() ?? [])];
  const running = records.filter(
    (record) => record.status === "running",
  ).length;
  setRuntimeStatus(
    state,
    state.context,
    "agents",
    records.length === 0
      ? "none"
      : `${running} running / ${records.length} total`,
  );
  applySubagentWidget(state);
}

async function manageSubagents(
  state: TuiState,
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const [action, childSessionId] = args.split(/\s+/u);
  if (action === undefined || action.length === 0) {
    context.ui.notify(formatSubagents(state), "info");
    return;
  }
  if (action === "profiles") {
    const bundle = await loadAgentProfiles(runtime.paths, {
      projectTrusted: runtime.workspaceTrust.trusted,
    });
    context.ui.notify(
      [formatAgentProfiles(bundle.profiles), ...bundle.warnings].join("\n"),
      bundle.warnings.length > 0 ? "warning" : "info",
    );
    return;
  }
  if (
    action !== "result" &&
    action !== "wait" &&
    action !== "stop" &&
    action !== "review" &&
    action !== "sign" &&
    action !== "merge" &&
    action !== "discard"
  ) {
    context.ui.notify(
      "usage: /agents [profiles|result|wait|stop|review|sign|merge|discard] [child-session-id]",
      "warning",
    );
    return;
  }
  if (childSessionId === undefined) {
    context.ui.notify(
      "usage: /agents [profiles|result|wait|stop|review|sign|merge|discard] [id]",
      "warning",
    );
    return;
  }
  const record = state.subagents?.get(childSessionId);
  if (record === undefined) {
    context.ui.notify(`subagent ${childSessionId} is not registered`, "error");
    return;
  }
  if (action === "review") {
    await reviewSubagent(context, record);
    return;
  }
  if (action === "sign") {
    await signSubagent(runtime, context, record);
    return;
  }
  if (action === "merge") {
    await mergeSubagent(runtime, context, record);
    return;
  }
  if (action === "discard") {
    await discardSubagent(runtime, context, record);
    return;
  }
  if (action === "stop") {
    if (record.status !== "running") {
      context.ui.notify(
        `subagent ${childSessionId} is already ${record.status}`,
        "warning",
      );
      return;
    }
    record.controller.abort();
    updateSubagentStatus(state);
    context.ui.notify(`stopping subagent ${childSessionId}`, "warning");
    return;
  }
  if (action === "wait") {
    context.ui.notify(`waiting for subagent ${childSessionId}`, "info");
    await record.promise;
  }
  if (record.status === "completed" && record.result !== null) {
    const summary =
      record.result.summary.length > 4_000
        ? `${record.result.summary.slice(0, 4_000)}\n[summary truncated]`
        : record.result.summary;
    context.ui.notify(
      [
        `subagent ${childSessionId} completed`,
        `evidence: ${
          record.result.evidence_head ?? "none (the child made no tool calls)"
        }`,
        ...(record.worktree === null
          ? []
          : [
              `worktree: ${record.worktree}`,
              `delivery: ${record.delivery?.state ?? "unreviewed"}`,
              `next: /agents review ${childSessionId}`,
            ]),
        summary,
      ].join("\n"),
      "info",
    );
    return;
  }
  context.ui.notify(
    `subagent ${childSessionId} is ${record.status}${
      record.error === null ? "" : `: ${record.error}`
    }${record.worktree === null ? "" : `\nworktree: ${record.worktree}`}`,
    record.status === "failed" ? "error" : "warning",
  );
}

function commandContext(
  state: TuiState,
  handler: (
    runtime: CodepunkRuntime,
    context: ExtensionCommandContext,
    args: string,
  ) => Promise<void>,
): (args: string, context: ExtensionCommandContext) => Promise<void> {
  return async (args, context) => {
    state.context = context;
    state.channel.attach(context);
    const runtime = state.runtime;
    if (runtime === null) {
      context.ui.notify("codepunk runtime is not ready", "error");
      return;
    }
    await handler(runtime, context, args.trim());
  };
}

function setupChrome(state: TuiState, context: ExtensionContext): void {
  const runtime = state.runtime;
  if (runtime === null) {
    return;
  }
  const tui = runtime.config.tui;
  const title = ["codepunk", `session ${runtime.session.sessionId}`];
  context.ui.setTitle(title.join(" · "));
  context.ui.setHeader(
    () =>
      component(
        () => renderStatus(state),
        () => tui.header,
      ) as never,
  );
  context.ui.setFooter(
    () =>
      component(
        () => `${renderStatus(state)}\n${runtime.paths.cwd}`,
        () => tui.footer,
      ) as never,
  );
  context.ui.setWidget(
    "model-onboarding",
    selectedModel(runtime) === undefined
      ? [
          "No model configured. The first message opens setup; run /model or /login to configure now.",
        ]
      : undefined,
  );
  const statuses: Array<[string, string]> = [
    [
      "permissions",
      `approvals:${runtime.config.approval.mode},autonomy:${runtime.autonomy.profile}`,
    ],
    ["thinking", runtime.host.session.thinkingLevel],
    ["shell", currentShellStatus(runtime)],
    ["next-sandbox", runtime.config.sandbox.mode],
    ["evidence", String(evidenceCount(runtime))],
    ["run", state.lastRunId ?? "ready"],
  ];
  for (const [key, value] of statuses) {
    setRuntimeStatus(state, context, key, value);
  }
  if (!tui.widgets) {
    context.ui.setWidget("codepunk", undefined);
  }
  context.ui.setEditorComponent(
    (tui, theme, keybindings) =>
      new EditorBridge(tui, theme, keybindings, async (text) => {
        const trimmed = text.trim();
        const command = trimmed.split(/\s+/u)[0] ?? "";
        if (trimmed.startsWith("!")) {
          if (trimmed === "!" || trimmed === "!!") {
            context.ui.notify("usage: !<command> or !!<command>", "warning");
            return true;
          }
          context.ui.setStatus("shell", `editor:${command.slice(0, 24)}`);
          if (runtime.plugins.enabled) {
            context.ui.notify(
              "! is disabled while Pi plugins are enabled",
              "warning",
            );
            return true;
          }
          // Pi's user_bash handler remains the execution backstop after the
          // editor has classified and displayed this input.
          return false;
        }
        if (command.startsWith("/skill:")) {
          const name = command.slice("/skill:".length);
          const skill = runtime.skills.find((entry) => entry.name === name);
          if (skill === undefined) {
            context.ui.notify(`skill ${name} is not loaded`, "warning");
            return true;
          }
          try {
            const invocation = await readSkillInvocation(skill, {
              arguments: trimmed.slice(command.length).trim(),
            });
            await runtime.host.recordEvent("skill/invoked", {
              name: invocation.name,
              scope: invocation.scope,
              sha256: invocation.sha256,
              bytes: invocation.bytes,
            });
            await runtime.host.session.prompt(invocation.prompt);
          } catch (error) {
            context.ui.notify(
              `skill ${name} could not be invoked: ${
                error instanceof Error ? error.message : String(error)
              }`,
              "error",
            );
          }
          return true;
        }
        if (trimmed === "/resume" || trimmed.startsWith("/resume ")) {
          await resumeSession(
            state,
            context,
            trimmed.slice("/resume".length).trim(),
          );
          return true;
        }
        if (trimmed === "/export" || trimmed.startsWith("/export ")) {
          await runtime.host.session.prompt("/cp-export");
          return true;
        }
        if (trimmed === "/session") {
          context.ui.notify(sessionSummary(runtime), "info");
          return true;
        }
        if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
          return false;
        }
        if (
          trimmed === "/remember" ||
          trimmed.startsWith("/remember ") ||
          trimmed === "/memory" ||
          trimmed.startsWith("/memory ")
        ) {
          return false;
        }
        if (trimmed === "/new" || trimmed.startsWith("/new ")) {
          await startNewSession(state, context);
          return true;
        }
        if (trimmed === "/model" || trimmed.startsWith("/model ")) {
          if (!state.ready) {
            context.ui.notify(
              [
                "The model selector is still starting.",
                "Wait for the current turn to settle, then use /model <provider/model>.",
              ].join("\n"),
              "warning",
            );
            return true;
          }
          let models: Awaited<ReturnType<typeof availableModels>>;
          try {
            models = await availableModels(runtime);
          } catch (error) {
            context.ui.notify(
              `No authenticated models.\n${
                error instanceof Error ? error.message : String(error)
              }`,
              "warning",
            );
            return true;
          }
          if (models.length === 0) {
            context.ui.notify(noAuthenticatedModelsMessage(), "warning");
            return true;
          }
          const reference = trimmed.slice("/model".length).trim();
          if (reference.length > 0 && !/\s/u.test(reference)) {
            const resolution = resolveModelSelection(
              runtime.host.services.modelRuntime,
              reference,
            );
            if (resolution.status === "resolved") {
              return selectModelReference(state, context, reference);
            }
          }
          // Pi owns fuzzy search, the selector, and catalog refresh.
          return false;
        }
        if (isSlashCommand(trimmed, "/help")) {
          context.ui.notify(codepunkHelp(), "info");
          return true;
        }
        if (isSlashCommand(trimmed, "/settings")) {
          context.ui.notify(
            [
              "codepunk settings are file-backed.",
              `config: ${runtime.paths.home}/config.toml`,
              "Use /permissions for approval, autonomy, and sandbox; /model for the model.",
            ].join("\n"),
            "info",
          );
          return true;
        }
        if (isSlashCommand(trimmed, "/scoped-models")) {
          context.ui.notify(
            [
              "Model scope is file-backed in codepunk.",
              `Set model.enabled in ${runtime.paths.home}/config.toml, for example:`,
              '  enabled = ["gateway/primary-model", "openai/gpt-5"]',
              "Pi's selector only changes in-memory host state in this build, so codepunk does not open it.",
            ].join("\n"),
            "info",
          );
          return true;
        }
        if (isSlashCommand(trimmed, "/trust")) {
          const argument = trimmed.slice("/trust".length).trim();
          await configureTrust(state, context, argument);
          return true;
        }
        if (
          trimmed === "/permissions" ||
          trimmed.startsWith("/permissions ") ||
          trimmed === "/permission" ||
          trimmed.startsWith("/permission ")
        ) {
          const slash = trimmed.indexOf(" ");
          await configurePermissions(
            state,
            context,
            slash < 0 ? "" : trimmed.slice(slash + 1).trim(),
          );
          return true;
        }
        if (isSlashCommand(trimmed, "/import")) {
          context.ui.notify(
            [
              "Pi session import is not supported in codepunk.",
              "Codepunk sessions keep their own evidence chain; use /cp-sessions or `codepunk --session <id>`.",
              "For a model endpoint, use `codepunk models import <base-url> --provider <id>` in a shell.",
            ].join("\n"),
            "info",
          );
          return true;
        }
        if (isSlashCommand(trimmed, "/share")) {
          context.ui.notify(
            [
              "Codepunk does not upload sessions to an external share service.",
              "Use /cp-export to write a redacted transcript and manifest locally.",
            ].join("\n"),
            "info",
          );
          return true;
        }
        if (isSlashCommand(trimmed, "/bug")) {
          context.ui.notify(
            [
              "Pi's /bug flow can upload a session transcript to the Pi developers.",
              "Codepunk keeps session data local; use /cp-export for a redacted transcript.",
              "Attach that export manually if you need to report a Codepunk defect.",
            ].join("\n"),
            "warning",
          );
          return true;
        }
        if (isSlashCommand(trimmed, "/reload")) {
          if (trimmed !== "/reload") {
            context.ui.notify("usage: /reload", "warning");
            return true;
          }
          try {
            const plugins = await runtime.reloadPlugins();
            const skills = await runtime.reloadSkills();
            const result = await runtime.reloadMcp();
            state.context?.ui.notify(
              `${formatPluginReload(plugins)}\n${formatSkillReload(skills)}\n${formatMcpReload(result)}`,
              result.error === null &&
                skills.error === null &&
                plugins.error === null
                ? "info"
                : "error",
            );
          } catch (error) {
            context.ui.notify(
              `Reload failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              "error",
            );
          }
          return true;
        }
        if (
          isSlashCommand(trimmed, "/fork") ||
          isSlashCommand(trimmed, "/clone")
        ) {
          await forkCurrentSession(
            state,
            context,
            trimmed.split(/\s+/u).slice(1).join(" ").trim(),
          );
          return true;
        }
        if (isSlashCommand(trimmed, "/tree")) {
          await navigateSessionTree(
            state,
            context,
            trimmed.slice("/tree".length).trim(),
          );
          return true;
        }
        if (trimmed.startsWith("/")) {
          const commandName = trimmed.slice(1).split(/\s+/u)[0] ?? "";
          if (!state.hostCommands.has(commandName)) {
            context.ui.notify(
              [
                `Unknown command /${commandName}.`,
                "Type /help for the available Codepunk and Pi commands.",
              ].join("\n"),
              "warning",
            );
            return true;
          }
        }
        if (
          !trimmed.startsWith("/") &&
          state.runtime !== null &&
          !state.modelSelected
        ) {
          await promptForMissingModel(state, context);
          return true;
        }
        return false;
      }),
  );
}

export function createTuiExtension(
  state: TuiState,
  channel: TuiApprovalChannel,
): InlineExtension {
  state.channel = channel;
  return {
    name: "codepunk-tui",
    hidden: true,
    factory: (pi) => {
      pi.on("session_start", async (_event, context) => {
        state.context = context;
        state.ready = true;
        state.hostCommands = new Set([
          ...(await loadPiBuiltinSlashCommands()).map(
            (command) => command.name,
          ),
          ...pi.getCommands().map((command) => command.name),
        ]);
        channel.attach(context);
        context.ui.addAutocompleteProvider((current) => ({
          ...(current.triggerCharacters === undefined
            ? {}
            : { triggerCharacters: current.triggerCharacters }),
          async getSuggestions(lines, cursorLine, cursorCol, options) {
            const suggestions = await current.getSuggestions(
              lines,
              cursorLine,
              cursorCol,
              options,
            );
            if (suggestions === null) {
              return null;
            }
            const items = filterInterceptedAutocomplete(suggestions.items);
            return items.length === 0 ? null : { ...suggestions, items };
          },
          applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
            return current.applyCompletion(
              lines,
              cursorLine,
              cursorCol,
              item,
              prefix,
            );
          },
          shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
            return (
              current.shouldTriggerFileCompletion?.(
                lines,
                cursorLine,
                cursorCol,
              ) ?? false
            );
          },
        }));
        setupChrome(state, context);
        if (state.runtime !== null && !state.warningsShown) {
          state.warningsShown = true;
          for (const warning of state.runtime.loadedConfig.warnings) {
            context.ui.notify(`codepunk warning: ${warning}`, "warning");
          }
          if (state.runtime.plugins.enabled) {
            context.ui.notify(
              "Plugins are trusted in-process code; they can bypass policy, approval, sandbox, and evidence.",
              "warning",
            );
          }
        }
      });
      pi.on("model_select", async (event, context) => {
        state.modelSelected = true;
        const runtime = state.runtime;
        if (runtime === null) {
          return;
        }
        if (isFallbackModel(event.model)) {
          const primary = physicalModel(runtime);
          const settings = runtime.host.services.settingsManager;
          if (
            primary !== undefined &&
            settings.getDefaultProvider() === event.model.provider &&
            settings.getDefaultModel() === event.model.id
          ) {
            settings.setDefaultModelAndProvider(primary.provider, primary.id);
          }
          context.ui.notify(
            "codepunk/auto is the active fallback route; choose a physical model to change the default.",
            "info",
          );
          setupChrome(state, context);
          return;
        }
        runtime.primaryModel = event.model;
        const settings = runtime.host.services.settingsManager;
        const persistedDefault =
          settings.getDefaultProvider() === event.model.provider &&
          settings.getDefaultModel() === event.model.id;
        if (event.source !== "set" || !persistedDefault) {
          setupChrome(state, context);
          return;
        }
        const saved = await persistPiDefaultModel(runtime, (message, level) =>
          context.ui.notify(message, level),
        );
        setRuntimeStatus(
          state,
          context,
          "model",
          saved ? `${event.model.provider}/${event.model.id}` : "not saved",
        );
        setupChrome(state, context);
      });
      pi.on("thinking_level_select", async (event, context) => {
        const runtime = state.runtime;
        if (runtime === null) {
          return;
        }
        runtime.config.model.thinking = event.level;
        try {
          await writeUserThinkingSelection(runtime.paths, event.level);
          setRuntimeStatus(state, context, "thinking", event.level);
        } catch (error) {
          context.ui.notify(
            `thinking changed for this session; config was not saved: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "warning",
          );
        }
      });
      pi.on("agent_start", async (_event, context) => {
        state.lastRunId = state.runtime?.host.currentRunId ?? null;
        context.ui.setTitle(
          `codepunk · session ${state.runtime?.session.sessionId ?? "starting"}`,
        );
        setRuntimeStatus(state, context, "run", state.lastRunId ?? "running");
      });
      pi.on("agent_settled", async (_event, context) => {
        context.ui.setTitle(
          `codepunk · session ${state.runtime?.session.sessionId ?? "starting"}`,
        );
        state.lastEvidence =
          state.runtime?.ledger.all.length ?? state.lastEvidence;
        setRuntimeStatus(
          state,
          context,
          "evidence",
          String(state.lastEvidence),
        );
        setRuntimeStatus(state, context, "run", "settled");
      });
      pi.on("session_shutdown", async (event) => {
        if (event.reason === "quit" && state.runtime !== null) {
          await persistPiDefaultModel(state.runtime);
          // Pi's /quit path can terminate the process without returning to the
          // caller's finally block. Release the session writer here so the
          // next codepunk process can resume immediately instead of waiting
          // for the lock lease to expire.
          await state.runtime.dispose().catch(() => undefined);
        }
      });
      pi.registerCommand("help", {
        description: "Show the Codepunk command list",
        handler: commandContext(state, async (_runtime, context) => {
          await notify(context, codepunkHelp());
        }),
      });
      pi.registerCommand("init", {
        description: "Create or update AGENTS.md from repository evidence",
        handler: commandContext(state, async (runtime, context, args) => {
          await initializeProjectInstructions(runtime, context, args);
        }),
      });
      pi.registerCommand("diff", {
        description: "Show staged and unstaged working tree changes",
        handler: commandContext(state, async (runtime, context, args) => {
          if (args.trim().length > 0) {
            context.ui.notify("usage: /diff", "warning");
            return;
          }
          try {
            await notify(
              context,
              formatWorkspaceDiff(
                await readWorkspaceDiff({
                  root: runtime.paths.deliveryRoot,
                }),
              ),
            );
          } catch (error) {
            context.ui.notify(
              `/diff failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              "error",
            );
          }
        }),
      });
      pi.registerCommand("undo", {
        description: "Restore recent Codepunk write/edit changes",
        handler: commandContext(state, async (_runtime, context, args) => {
          await restoreCheckpoint(state, context, "undo", args);
        }),
      });
      pi.registerCommand("redo", {
        description: "Reapply changes removed by /undo",
        handler: commandContext(state, async (_runtime, context, args) => {
          await restoreCheckpoint(state, context, "redo", args);
        }),
      });
      pi.registerCommand("commit", {
        description: "Review and create a Git commit as a human action",
        handler: commandContext(state, async (_runtime, context, args) => {
          await configureCommit(state, context, args);
        }),
      });
      pi.registerCommand("status", {
        description: "Show model, session, permission, trust, and usage status",
        handler: commandContext(state, async (runtime, context) => {
          await notify(context, formatStatusSummary(runtime));
        }),
      });
      pi.registerCommand("cp-sessions", {
        description: "List codepunk sessions",
        handler: commandContext(state, async (runtime, context) => {
          const sessions = await listProjectSessions(
            runtime.paths.home,
            runtime.paths.projectId,
          );
          await notify(context, formatSessionList(sessions));
        }),
      });
      pi.registerCommand("plan", {
        description: "Show the current plan",
        handler: commandContext(state, async (runtime, context) => {
          const work = readWorkState(runtime.session.allEvents);
          await notify(context, formatPlan(work.plan));
        }),
      });
      pi.registerCommand("todos", {
        description: "Show the current todo list",
        handler: commandContext(state, async (runtime, context) => {
          const work = readWorkState(runtime.session.allEvents);
          await notify(context, formatTodos(work.todos));
        }),
      });
      pi.registerCommand("evidence", {
        description: "Show current run evidence count",
        handler: commandContext(state, async (runtime, context) => {
          const records = runtime.ledger.all;
          await notify(
            context,
            records.length === 0
              ? "No evidence in the current run."
              : `${records.length} evidence record(s); head ${runtime.ledger.head ?? "none"}`,
          );
        }),
      });
      pi.registerCommand("budget", {
        description: "Show model token and cost usage against the budget",
        handler: commandContext(state, async (runtime, context) => {
          const usage = runtime.usage();
          const maxTokens = runtime.config.budget.max_tokens;
          const maxCost = runtime.config.budget.max_cost_usd;
          await notify(
            context,
            [
              `tokens: ${usage.total_tokens}${maxTokens === null ? "" : ` / ${maxTokens}`}`,
              `cost: $${usage.cost_total.toFixed(6)}${maxCost === null ? "" : ` / $${maxCost}`}`,
              `calls: ${usage.calls}`,
              maxTokens === null && maxCost === null
                ? "budget: off"
                : "budget: enforced from recorded model usage; exceeding it aborts the run",
            ].join("\n"),
          );
        }),
      });
      pi.registerCommand("doctor", {
        description: "Run codepunk doctor",
        handler: commandContext(state, async (runtime, context) => {
          const build = await inspectCliBuild();
          const report = appendBuildDoctorCheck(
            await runDoctor({
              paths: runtime.paths,
              config: runtime.config,
              pluginEnabled: runtime.plugins.enabled,
              packageVersion: build.version,
            }),
            build,
          );
          await notify(context, formatDoctor(report));
        }),
      });
      pi.registerCommand("policy", {
        description: "Show effective codepunk policy",
        handler: commandContext(state, async (runtime, context) => {
          await notify(
            context,
            [
              ...configSummary(runtime.config, runtime.policy.writeSet),
              `policy layers: ${runtime.policy.layers.map((layer) => layer.layer).join(", ") || "default"}`,
              `plugins: ${runtime.plugins.enabled ? "enabled" : "disabled"}`,
              `isolation: ${
                [
                  runtime.isolation.context ? "context" : null,
                  runtime.isolation.skills ? "skills" : null,
                  runtime.isolation.plugins ? "plugins" : null,
                  runtime.isolation.mcp ? "mcp" : null,
                  runtime.isolation.memory ? "memory" : null,
                ]
                  .filter((entry): entry is string => entry !== null)
                  .join(", ") || "none"
              }`,
            ].join("\n"),
          );
        }),
      });
      pi.registerCommand("capabilities", {
        description: "List MCP servers, skills, and plugins",
        handler: commandContext(state, async (runtime, context) => {
          const snapshot = await collectCapabilities(runtime.paths, {
            pluginEnabled: runtime.plugins.enabled,
            skills: runtime.skills,
            ...(runtime.plugins.paths.length > 0
              ? { pluginFiles: runtime.plugins.paths }
              : {}),
          });
          await notify(context, formatCapabilities(snapshot));
        }),
      });
      pi.registerCommand("skills", {
        description: "List loaded skills and management commands",
        handler: commandContext(state, async (runtime, context) => {
          const lines = [
            runtime.isolation.skills
              ? "Skills (disabled for this session)"
              : `Skills (${runtime.skills.length})`,
          ];
          if (runtime.isolation.skills) {
            lines.push(
              "  restart without --no-skills or --bare to load installed skills",
            );
            await notify(context, lines.join("\n"));
            return;
          }
          if (runtime.skills.length === 0) {
            lines.push("  none");
          } else {
            for (const skill of runtime.skills) {
              lines.push(
                `  ${skill.scope.padEnd(7)} ${skill.name}  ${skill.bytes} B${skill.disable_model_invocation ? `  manual-only (/skill:${skill.name})` : ""}`,
              );
              lines.push(`          ${skill.path}`);
            }
          }
          lines.push(
            "",
            "add:    codepunk skills add <dir> [--scope user|project]",
            "remove: codepunk skills remove <name> [--scope user|project]",
            "run /reload after changing skills",
          );
          await notify(context, lines.join("\n"));
        }),
      });
      pi.registerCommand("plugins", {
        description: "List plugin files and management commands",
        handler: commandContext(state, async (runtime, context) => {
          const directory = path.join(runtime.paths.home, "extensions");
          const files = await listUserPluginFiles(directory);
          await notify(
            context,
            [
              `Plugins (${runtime.plugins.enabled ? "enabled" : runtime.isolation.plugins ? "disabled for this session" : "disabled"}, ${files.length} file${files.length === 1 ? "" : "s"})`,
              `directory: ${directory}`,
              ...(files.length === 0
                ? ["  none"]
                : files.map((file) => `  ${file}`)),
              "",
              "enable:  codepunk plugins enable",
              "disable: codepunk plugins disable",
              "add:     codepunk plugins add <file> [--force]",
              "remove:  codepunk plugins remove <file>",
              "run /reload after changes; plugin tools are rejected",
            ].join("\n"),
          );
        }),
      });
      pi.registerCommand("mcp", {
        description: "List, sign in to, or inspect user MCP servers",
        handler: commandContext(state, async (runtime, context, args) => {
          const parts = args
            .trim()
            .split(/\s+/u)
            .filter((part) => part.length > 0);
          const action = parts[0] ?? "list";
          if (action === "list") {
            const snapshot = await collectCapabilities(runtime.paths, {
              pluginEnabled: runtime.plugins.enabled,
              skills: runtime.skills,
              ...(runtime.plugins.paths.length > 0
                ? { pluginFiles: runtime.plugins.paths }
                : {}),
            });
            await notify(
              context,
              [
                ...formatMcpServers(snapshot.mcp),
                "",
                "usage: /mcp [list|add [name]|remove [name]|login [name]|status [name]|logout [name]]",
                "check:  codepunk mcp test [name]",
                "run /reload after changing MCP configuration",
              ].join("\n"),
            );
            return;
          }
          if (action === "add") {
            const result = await addMcpServerInteractive(
              runtime,
              context,
              parts[1],
            );
            if (result !== null) {
              (state.context ?? context).ui.notify(
                result.message,
                result.level,
              );
            }
            return;
          }
          if (action === "remove") {
            const result = await removeMcpServerInteractive(
              runtime,
              context,
              parts[1],
            );
            if (result !== null) {
              (state.context ?? context).ui.notify(
                result.message,
                result.level,
              );
            }
            return;
          }
          if (action === "status" || action === "logout") {
            let name = parts[1];
            const configs = await readMcpConfig(runtime.paths);
            if (name === undefined && action === "logout") {
              const candidates = configs.filter(
                (config) =>
                  config.transport === "http" &&
                  !mcpUsesAuthorizationHeader(config),
              );
              if (candidates.length === 0) {
                await notify(
                  context,
                  "No user MCP servers with OAuth credentials are configured.",
                );
                return;
              }
              if (candidates.length === 1) {
                name = candidates[0]!.name;
              } else {
                const selected = await context.ui.select(
                  "MCP server to sign out",
                  candidates.map((config) => config.name),
                );
                if (selected === undefined) {
                  return;
                }
                name = selected;
              }
            }
            const selected =
              name === undefined
                ? configs
                : configs.filter((config) => config.name === name);
            if (name !== undefined && selected.length === 0) {
              context.ui.notify(
                `MCP server ${name} is not configured`,
                "warning",
              );
              return;
            }
            if (selected.length === 0) {
              await notify(context, "no user MCP servers configured");
              return;
            }
            const store = new McpAuthStore(runtime.paths.home);
            const lines: string[] = [];
            for (const config of selected) {
              if (config.transport !== "http") {
                lines.push(`${config.name}: stdio (no OAuth)`);
                continue;
              }
              if (mcpUsesAuthorizationHeader(config)) {
                lines.push(`${config.name}: Authorization header`);
                continue;
              }
              if (action === "logout") {
                const removed = await store.remove(config.name, config.url);
                lines.push(
                  `${config.name}: ${
                    removed ? "signed out" : "no stored credentials"
                  }`,
                );
                continue;
              }
              const status = await store.status(config.name, config.url);
              lines.push(
                `${config.name}: ${status.signed_in ? "signed in" : "signed out"}${
                  status.expires_at === null
                    ? ""
                    : ` · expires ${status.expires_at}`
                }`,
              );
            }
            await notify(context, lines.join("\n"));
            return;
          }
          if (action === "login") {
            const controller = new AbortController();
            try {
              const configs = await readMcpConfig(runtime.paths);
              let requested = parts[1];
              if (requested === undefined) {
                const candidates = configs.filter(
                  (config) =>
                    config.transport === "http" &&
                    !mcpUsesAuthorizationHeader(config),
                );
                if (candidates.length > 1) {
                  const selected = await context.ui.select(
                    "MCP server to sign in",
                    candidates.map((config) => config.name),
                  );
                  if (selected === undefined) {
                    return;
                  }
                  requested = selected;
                }
              }
              const target = resolveMcpLoginTarget(configs, requested);
              const store = new McpAuthStore(runtime.paths.home);
              await notify(
                context,
                `Starting MCP sign-in for ${target.name}...`,
              );
              const result = await loginMcpServer({
                server: target.name,
                serverUrl: target.url,
                store,
                settings: oauthSettings(target.oauth, target.name),
                signal: controller.signal,
                onAuthorizationUrl: (url) => {
                  context.ui.notify(
                    [
                      `MCP server ${target.name} requires authorization.`,
                      "Open this URL in a browser:",
                      url.href,
                      "Then paste the full redirect URL when prompted.",
                    ].join("\n"),
                    "info",
                  );
                },
                promptForRedirectUrl: async () => {
                  const value = await context.ui.input(
                    "MCP redirect URL",
                    "Paste the full redirect URL, or leave empty to cancel",
                  );
                  const trimmed = value?.trim() ?? "";
                  if (trimmed.length === 0) {
                    controller.abort();
                  }
                  return trimmed.length === 0 ? undefined : trimmed;
                },
              });
              const status = await store.status(target.name, target.url);
              await notify(
                context,
                [
                  result.already_authorized
                    ? `MCP server ${target.name} already had usable credentials`
                    : `signed in to MCP server ${target.name}`,
                  `signed in: ${status.signed_in ? "yes" : "no"}`,
                  `expires: ${status.expires_at ?? "not reported"}`,
                  `scope: ${status.scope ?? "not reported"}`,
                  "run /reload to start this server",
                ].join("\n"),
              );
            } catch (error) {
              context.ui.notify(
                controller.signal.aborted
                  ? "MCP sign-in cancelled"
                  : `MCP sign-in failed: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                "error",
              );
            }
            return;
          }
          context.ui.notify(
            "usage: /mcp [list|add [name]|remove [name]|login [name]|status [name]|logout [name]]",
            "warning",
          );
        }),
      });
      const permissionsCommand = {
        description: "Show or change approval, autonomy, and sandbox modes",
        handler: commandContext(state, async (_runtime, context, args) => {
          await configurePermissions(state, context, args);
        }),
      };
      pi.registerCommand("permissions", permissionsCommand);
      pi.registerCommand("permission", permissionsCommand);
      pi.registerCommand("cp-export", {
        description: "Export a redacted audit transcript",
        handler: commandContext(state, async (runtime, context) => {
          const exported = await exportSession(runtime.session);
          const target = path.join(
            runtime.paths.artifactsDir,
            `${runtime.session.sessionId}.md`,
          );
          const manifestTarget = path.join(
            runtime.paths.artifactsDir,
            `${runtime.session.sessionId}.manifest.json`,
          );
          await fs.mkdir(path.dirname(target), {
            recursive: true,
            mode: 0o700,
          });
          await fs.writeFile(target, exported.transcript, { mode: 0o600 });
          await fs.writeFile(
            manifestTarget,
            `${JSON.stringify(exported.manifest, null, 2)}\n`,
            { mode: 0o600 },
          );
          await notify(
            context,
            `Exported redacted transcript: ${target}\nManifest: ${manifestTarget}`,
          );
        }),
      });
      pi.registerCommand("subagent", {
        description: "Start a background child Pi session",
        handler: commandContext(state, async (runtime, context, args) => {
          await runSubagent(state, runtime, context, args);
        }),
      });
      pi.registerCommand("agents", {
        description: "Review, sign, merge, or discard background subagents",
        handler: commandContext(state, async (runtime, context, args) => {
          await manageSubagents(state, runtime, context, args);
        }),
      });
      pi.registerCommand("sign", {
        description: "Sign the current settled run",
        handler: commandContext(state, async (runtime, context, args) => {
          if (process.stdin.isTTY !== true) {
            context.ui.notify("sign requires a top-level TTY", "error");
            return;
          }
          const requested = args.trim();
          if (
            requested !== "" &&
            requested !== "complete" &&
            requested !== "incomplete"
          ) {
            context.ui.notify("usage: /sign [complete|incomplete]", "warning");
            return;
          }
          const runId = state.lastRunId ?? runtime.host.currentRunId;
          const ended = runtime.session.allEvents.some(
            (event) => event.kind === "run/end" && event.data.run_id === runId,
          );
          if (!ended) {
            context.ui.notify(
              "the current run has no durable run/end",
              "error",
            );
            return;
          }
          const verdict =
            requested === "complete" || requested === "incomplete"
              ? requested
              : await context.ui.select(`Sign ${runId}`, [
                  "Sign as complete",
                  "Sign as incomplete",
                  "Cancel",
                ]);
          if (verdict === undefined || verdict === "Cancel") {
            return;
          }
          const resolvedVerdict: "complete" | "incomplete" =
            verdict === "Sign as incomplete" || verdict === "incomplete"
              ? "incomplete"
              : "complete";
          try {
            const result = await runtime.signInProcess(resolvedVerdict, {
              channel: "tui",
              tty: true,
            });
            await notify(
              context,
              `verdict ${result.verdict.verdict} · ${result.artifactPath}`,
            );
          } catch (error) {
            context.ui.notify(
              error instanceof Error ? error.message : String(error),
              "error",
            );
          }
        }),
      });
      pi.registerCommand("remember", {
        description: "Remember a user or project fact",
        handler: commandContext(state, async (runtime, context, args) => {
          const scopeMatch = /(?:^|\s)--scope\s+(user|project)\s*$/u.exec(args);
          const scope =
            scopeMatch?.[1] === "user" || scopeMatch?.[1] === "project"
              ? scopeMatch[1]
              : "project";
          const content =
            scopeMatch === null ? args : args.slice(0, scopeMatch.index).trim();
          if (content.length === 0) {
            context.ui.notify(
              "usage: /remember <text> [--scope user|project]",
              "warning",
            );
            return;
          }
          const result = await runtime.memory.add({
            scope,
            content,
            source: "user",
            source_refs: [`session:${runtime.session.sessionId}`],
          });
          await runtime.recordMemoryWrite({
            scope,
            action: result.ok ? "add" : "reject",
            memoryId: result.record?.id ?? null,
            contentSha256: result.record?.content_sha256 ?? null,
            sourceRefs: [`session:${runtime.session.sessionId}`],
            reason: result.ok ? null : result.reason,
          });
          context.ui.notify(
            result.ok
              ? `remembered ${result.record?.id}`
              : `memory rejected: ${result.reason}`,
            result.ok ? "info" : "warning",
          );
        }),
      });
      pi.registerCommand("memory", {
        description: "List, search, delete, or archive memory",
        handler: commandContext(state, async (runtime, context, args) => {
          const tokens = args.split(/\s+/u).filter(Boolean);
          const subcommand = tokens[0];
          const argument = tokens.slice(1).join(" ");
          if (subcommand === "delete" || subcommand === "archive") {
            if (argument.length === 0) {
              context.ui.notify(
                `usage: /memory ${subcommand} <memory-id>`,
                "warning",
              );
              return;
            }
            for (const scope of ["user", "project"] as const) {
              const store = runtime.memory.storeFor(scope);
              const record = store.records.find(
                (candidate) => candidate.id === argument,
              );
              if (record === undefined) {
                continue;
              }
              const changed =
                subcommand === "delete"
                  ? await store.delete(argument)
                  : await store.archive(argument);
              await runtime.recordMemoryWrite({
                scope,
                action: subcommand,
                memoryId: argument,
                contentSha256: record.content_sha256,
                sourceRefs: [`session:${runtime.session.sessionId}`],
                reason: changed ? null : "not_found",
              });
              context.ui.notify(
                changed
                  ? `${subcommand === "delete" ? "deleted" : "archived"} ${argument}`
                  : `memory record was not found: ${argument}`,
                changed ? "info" : "warning",
              );
              return;
            }
            context.ui.notify(
              `memory record was not found: ${argument}`,
              "warning",
            );
            return;
          }
          if (subcommand === "search" && argument.length === 0) {
            context.ui.notify("usage: /memory search <query>", "warning");
            return;
          }
          if (
            subcommand !== undefined &&
            subcommand !== "list" &&
            subcommand !== "search"
          ) {
            context.ui.notify(
              "usage: /memory [list|search <query>|delete <memory-id>|archive <memory-id>]",
              "warning",
            );
            return;
          }
          const query = subcommand === "search" ? argument : "";
          const result = await runtime.memory.search(query, "all", 8);
          await notify(
            context,
            result.records.length === 0
              ? "No memory records matched."
              : result.records
                  .map(
                    (record) =>
                      `${record.id} [${record.scope}] ${record.content}`,
                  )
                  .join("\n"),
          );
        }),
      });
    },
  };
}

export function setTuiRuntime(state: TuiState, runtime: CodepunkRuntime): void {
  state.runtime = runtime;
  state.modelOnboardingShown = false;
  if (typeof state.channel.setPersistHandler === "function") {
    state.channel.setPersistHandler(async (request) => {
      if (
        request.argv === undefined ||
        request.argv.length === 0 ||
        request.cwd === undefined
      ) {
        return false;
      }
      try {
        const persisted = await persistScopedRule({
          paths: runtime.paths,
          argv: request.argv,
          cwd: request.cwd,
          filePath:
            runtime.config.autonomy.scoped_rules ??
            path.join(runtime.paths.home, "scoped-rules.toml"),
        });
        await writeUserPermissionSelection(runtime.paths, {
          autonomy: "scoped",
          scopedRules: persisted.path,
        });
        runtime.config.autonomy.scoped_rules = persisted.path;
        state.context?.ui.notify(
          [
            `saved exact rule ${persisted.rule.id} for the next session`,
            `argv: ${persisted.rule.argv.join(" ")}`,
            `cwd: ${persisted.rule.cwd}`,
            `file: ${persisted.path}`,
          ].join("\n"),
          "info",
        );
        return true;
      } catch (error) {
        state.context?.ui.notify(
          `exact rule was not saved: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
        return false;
      }
    });
  }
  state.modelSelected = selectedModel(runtime) !== undefined;
  if (state.context !== null) {
    setupChrome(state, state.context);
  }
}

export function applyReplacedRuntime(
  state: TuiState,
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
): void {
  state.context = context;
  state.channel.attach(context);
  context.ui.setWidget("subagents", undefined);
  state.ready = true;
  state.lastRunId = runtime.host.currentRunId;
  state.lastEvidence = runtime.ledger.all.length;
  setTuiRuntime(state, runtime);
}
