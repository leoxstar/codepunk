import { promises as fs } from "node:fs";
import path from "node:path";
import { type SessionEvent, type SignOffRequest } from "@codepunk/protocol";
import type {
  AgentSession,
  AgentSessionServices,
  InlineExtension,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createPiHost, type PiHost } from "../adapters/pi/index.ts";
import { loadContext } from "../context/index.ts";
import {
  AutonomyController,
  isShellLauncher,
  type AutonomyRegistration,
  type ScopedRule,
} from "../autonomy/index.ts";
import {
  loadConfig,
  piSettings,
  type CodepunkConfig,
  type ConfigOverrides,
  type FilesystemMode,
  type LoadedConfig,
} from "../config/index.ts";
import {
  headlessLayer,
  loadHeadlessPolicy,
  loadPolicyFiles,
  type HeadlessPolicy,
  type PolicyFiles,
} from "../config/policy.ts";
import { loadScopedRules } from "../config/scoped.ts";
import { ApprovalBroker, type ApprovalChannel } from "../approval/index.ts";
import {
  type EvidenceAppendInput,
  EvidenceLedger,
  readEvidenceFile,
} from "../evidence/index.ts";
import {
  filesystemFullStartupIssue,
  shellUnavailableReason,
} from "../permissions/index.ts";
import {
  DeferredActionReviewer,
  resolveActionReviewer,
  type ActionReviewer,
} from "../reviewer/index.ts";
import {
  MemoryManager,
  type MemoryManager as MemoryManagerType,
} from "../memory/index.ts";
import {
  ensureProjectConfigDir,
  ensureProjectRegistration,
  ensureCodepunkHome,
  assertProjectConfigSafe,
  findDeliveryRoot,
  projectPaths,
  resolveAdditionalWorkspaceRoots,
  resolveCodepunkHome,
  type ProjectContext,
  type ProjectPaths,
} from "../platform/paths.ts";
import { createUlid, sha256Bytes, sha256Text } from "../platform/hash.ts";
import { normalizeAbsolute } from "../platform/path.ts";
import {
  ModelError,
  openModelRuntime,
  resolveConfiguredModel,
  resolveFallbackContextWindow,
  summarizeSessionModelUsage,
  type ConfiguredModel,
  type ModelUsageSummary,
} from "../model/index.ts";
import { isFallbackModel } from "../model/fallback.ts";
import { loadUserPlugins, type PluginSummary } from "../plugin/index.ts";
import {
  emptyMcpBundle,
  findProjectMcpConfigs,
  loadMcpTools,
  type McpBundle,
  type McpServerStart,
} from "../mcp/index.ts";
import { loadSkills, type SkillSource } from "../skills/index.ts";
import {
  SrtSandbox,
  UnsandboxedShell,
  type ShellProvider,
} from "../sandbox/index.ts";
import {
  SessionStore,
  type SessionStore as SessionStoreType,
} from "../session/index.ts";
import {
  resolveWorkspaceTrust,
  skippedProjectResources,
  type WorkspaceTrust,
  type WorkspaceTrustSource,
} from "../trust/index.ts";
import { listProjectSessions, resolveSession } from "../session/ops.ts";
import {
  appendEvidenceIndex,
  deriveAndWriteVerdict,
  evidenceRunPath,
  signRun,
} from "../verdict/store.ts";
import { prepareSignOff } from "../verdict/index.ts";

export interface RuntimeOptions {
  cwd: string;
  additionalDirs?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  configOverrides?: ConfigOverrides;
  model?: NonNullable<Parameters<typeof createPiHost>[0]["model"]>;
  sessionId?: string;
  sessionPath?: string;
  newSessionId?: string;
  parentSessionId?: string;
  continueSession?: boolean;
  newSession?: boolean;
  allowPlugins?: boolean;
  allowFullFilesystem?: boolean;
  headless?: boolean;
  headlessPolicyPath?: string;
  allowUnsandboxedShell?: boolean;
  projectTrusted?: boolean;
  projectTrustSource?: WorkspaceTrustSource;
  allowMissingModel?: boolean;
  disableMcp?: boolean;
  disableSkills?: boolean;
  disablePlugins?: boolean;
  bare?: boolean;
  approvalChannel?: ApprovalChannel | null;
  bindMode?: "print" | "tui";
  runId?: string;
  additionalExtensionFactories?: readonly InlineExtension[];
  now?: () => Date;
  timeZone?: string;
}

export interface RuntimeSignResult {
  verdict: import("@codepunk/protocol").Verdict;
  artifactPath: string;
  issues: string[];
}

export class RunLedger {
  private current: EvidenceLedger | null = null;
  private currentPath: string | null = null;
  private readonly paths: ProjectPaths;
  private readonly sessionId: string;
  private runId: string;

  constructor(paths: ProjectPaths, sessionId: string, runId: string) {
    this.paths = paths;
    this.sessionId = sessionId;
    this.runId = runId;
  }

  async prepare(runId: string): Promise<void> {
    this.runId = runId;
    this.currentPath = evidenceRunPath(this.paths, this.sessionId, runId);
    this.current = await EvidenceLedger.open(this.currentPath);
  }

  get filePath(): string {
    if (this.currentPath === null) {
      throw new Error("run ledger is not initialized");
    }
    return this.currentPath;
  }

  get all(): readonly import("@codepunk/protocol").EvidenceRecord[] {
    return this.current?.all ?? [];
  }

  get head(): string | null {
    return this.current?.head ?? null;
  }

  get hasTruncatedTail(): boolean {
    return this.current?.hasTruncatedTail ?? false;
  }

  async append(
    input: EvidenceAppendInput,
  ): Promise<import("@codepunk/protocol").EvidenceRecord> {
    if (this.current === null) {
      throw new Error("run ledger is not initialized");
    }
    return this.current.append(input);
  }

  get activeRunId(): string {
    return this.runId;
  }
}

export interface CodepunkRuntime {
  project: ProjectContext;
  paths: ProjectPaths;
  config: CodepunkConfig;
  loadedConfig: LoadedConfig;
  policy: PolicyFiles;
  plugins: PluginSummary;
  skills: readonly SkillSource[];
  isolation: {
    bare: boolean;
    context: boolean;
    skills: boolean;
    plugins: boolean;
    mcp: boolean;
    memory: boolean;
  };
  mcpServers: readonly string[];
  workspaceTrust: WorkspaceTrust;
  memory: MemoryManagerType;
  session: SessionStoreType;
  ledger: RunLedger;
  sandbox: ShellProvider | null;
  autonomy: AutonomyController;
  approval: ApprovalBroker;
  host: PiHost;
  primaryModel: ConfiguredModel | undefined;
  fallbackModels: readonly string[];
  runId: string;
  evidencePath: string;
  /**
   * Execution settings bound when this host started. Approval and ordinary
   * autonomy changes apply live; entering or leaving read-only with an active
   * srt shell requires a restart, and sandbox/filesystem/network changes are
   * next-session settings. Explanations must not read the mutated config
   * snapshot for these values.
   */
  permissionSnapshot: {
    filesystem: FilesystemMode;
    readOnly: boolean;
    networkAllow: readonly string[];
    networkDeny: readonly string[];
  };
  usage(): ModelUsageSummary;
  setApprovalMode(mode: "ask" | "deny" | "auto" | "allow"): void;
  signInProcess(
    verdict: "complete" | "incomplete",
    options?: { channel?: "tui" | "cli"; actor?: string; tty?: boolean },
  ): Promise<RuntimeSignResult>;
  recordMemoryWrite(input: {
    scope: "user" | "project";
    action: "add" | "edit" | "delete" | "archive" | "reject";
    memoryId: string | null;
    contentSha256: string | null;
    sourceRefs: readonly string[];
    reason: string | null;
  }): Promise<void>;
  dispose(): Promise<void>;
}

function executableHash(bytes: Buffer): string {
  return sha256Bytes(bytes);
}

function commandMatches(
  rule: HeadlessPolicy["commands"][number],
  argv: readonly string[],
  cwd: string,
): boolean {
  if (rule.argv.length !== argv.length) {
    return false;
  }
  if (normalizeAbsolute(rule.cwd) !== normalizeAbsolute(cwd)) {
    return false;
  }
  return rule.argv.every((value, index) => value === argv[index]);
}

async function verifyHeadlessExec(
  policy: HeadlessPolicy,
  argv: readonly string[],
  cwd: string,
): Promise<string | null> {
  const rule = policy.commands.find((candidate) =>
    commandMatches(candidate, argv, cwd),
  );
  if (rule === undefined) {
    return "argv is not approved by the headless policy";
  }
  const executable = normalizeAbsolute(
    path.isAbsolute(argv[0]!) ? argv[0]! : path.resolve(rule.cwd, argv[0]!),
  );
  let resolvedExecutable: string;
  try {
    resolvedExecutable = normalizeAbsolute(await fs.realpath(executable));
  } catch {
    return "approved executable cannot be resolved";
  }
  if (isShellLauncher([resolvedExecutable]) || isShellLauncher([executable])) {
    return "shell and interpreter launchers are not allowed by headless exec";
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(executable);
  } catch {
    return "approved executable cannot be read";
  }
  if (bytes.subarray(0, 2).toString("utf8") === "#!") {
    return "headless exec accepts native executables only";
  }
  if (executableHash(bytes) !== rule.executable_sha256) {
    return "approved executable digest changed";
  }
  if (rule.script_sha256 !== null) {
    const scriptArg = argv[1];
    if (scriptArg === undefined) {
      return "approved script argument is missing";
    }
    const script = normalizeAbsolute(
      path.isAbsolute(scriptArg)
        ? scriptArg
        : path.resolve(rule.cwd, scriptArg),
    );
    let scriptBytes: Buffer;
    try {
      scriptBytes = await fs.readFile(script);
    } catch {
      return "approved script cannot be read";
    }
    if (executableHash(scriptBytes) !== rule.script_sha256) {
      return "approved script digest changed";
    }
  }
  return null;
}

function effectiveTools(
  config: CodepunkConfig,
  sandbox: ShellProvider | null,
  memory: MemoryManagerType,
  headless: boolean,
  headlessPolicy: HeadlessPolicy | null = null,
): string[] {
  let requested = new Set(config.tools.enabled);
  if (headless) {
    // A one-shot print run has no interactive work-state lifecycle. Keep the
    // read-only surface small instead of exposing plan/todo writes that the
    // caller cannot observe or continue.
    requested.delete("plan");
    requested.delete("todo");
    if (headlessPolicy === null) {
      requested.delete("shell");
      requested.delete("bash");
      requested.delete("write");
      requested.delete("edit");
      requested.delete("exec");
    } else {
      const allowed = new Set(
        headlessPolicy.tools.map((tool) => (tool === "shell" ? "exec" : tool)),
      );
      requested = new Set(
        [...requested].filter((tool) =>
          allowed.has(tool === "shell" ? "exec" : tool),
        ),
      );
      if (allowed.has("exec")) {
        requested.add("exec");
      }
      requested.delete("shell");
      requested.delete("bash");
    }
  }
  if (!memory.enabled) {
    requested.delete("memory_search");
  }
  if (sandbox === null) {
    requested.delete("shell");
    requested.delete("bash");
    if (!headless) {
      requested.delete("exec");
    }
  }
  return [...requested].map((name) => (name === "shell" ? "bash" : name));
}

async function openSession(
  options: RuntimeOptions,
  paths: ProjectPaths,
  heartbeatMs: number,
  leaseMs: number,
): Promise<SessionStoreType> {
  if (
    options.newSessionId !== undefined &&
    (options.sessionId !== undefined || options.sessionPath !== undefined)
  ) {
    throw new Error(
      "newSessionId cannot be combined with an existing session selector",
    );
  }
  if (options.newSessionId !== undefined && options.continueSession === true) {
    throw new Error("newSessionId cannot be combined with --continue");
  }
  if (
    options.parentSessionId !== undefined &&
    options.newSession !== true &&
    options.newSessionId === undefined
  ) {
    throw new Error(
      "parentSessionId requires --new-session or --new-session-id",
    );
  }
  if (
    options.parentSessionId !== undefined &&
    (options.sessionId !== undefined ||
      options.sessionPath !== undefined ||
      options.continueSession === true)
  ) {
    throw new Error(
      "parentSessionId cannot be combined with an existing session selector",
    );
  }
  if (options.newSession === true) {
    return SessionStore.create({
      rootDir: paths.home,
      cwd: paths.cwd,
      projectRoot: paths.deliveryRoot,
      projectId: paths.projectId,
      ...(options.newSessionId !== undefined
        ? { sessionId: options.newSessionId }
        : {}),
      ...(options.parentSessionId !== undefined
        ? { parentSessionId: options.parentSessionId }
        : {}),
      heartbeatMs,
      leaseMs,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }
  if (options.sessionId === undefined && options.sessionPath === undefined) {
    if (!options.continueSession) {
      return SessionStore.create({
        rootDir: paths.home,
        cwd: paths.cwd,
        projectRoot: paths.deliveryRoot,
        projectId: paths.projectId,
        ...(options.newSessionId !== undefined
          ? { sessionId: options.newSessionId }
          : {}),
        ...(options.parentSessionId !== undefined
          ? { parentSessionId: options.parentSessionId }
          : {}),
        heartbeatMs,
        leaseMs,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
    }
    const sessions = await listProjectSessions(paths.home, paths.projectId);
    if (sessions.length === 0) {
      return SessionStore.create({
        rootDir: paths.home,
        cwd: paths.cwd,
        projectRoot: paths.deliveryRoot,
        projectId: paths.projectId,
        ...(options.newSessionId !== undefined
          ? { sessionId: options.newSessionId }
          : {}),
        ...(options.parentSessionId !== undefined
          ? { parentSessionId: options.parentSessionId }
          : {}),
        heartbeatMs,
        leaseMs,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
    }
  }
  return resolveSession({
    rootDir: paths.home,
    cwd: paths.cwd,
    projectRoot: paths.deliveryRoot,
    projectId: paths.projectId,
    ...(options.sessionId !== undefined
      ? { sessionId: options.sessionId }
      : {}),
    ...(options.sessionPath !== undefined
      ? { sessionPath: options.sessionPath }
      : {}),
    heartbeatMs,
    leaseMs,
  });
}

export async function createRuntime(
  options: RuntimeOptions,
): Promise<CodepunkRuntime> {
  const project = await findDeliveryRoot(options.cwd);
  const home = pathsHome(options.environment);
  const bare = options.bare === true;
  const disableSkills = bare || options.disableSkills === true;
  const disablePlugins = bare || options.disablePlugins === true;
  const disableMcp = bare || options.disableMcp === true;
  const additionalRoots = await resolveAdditionalWorkspaceRoots({
    cwd: project.cwd,
    primaryRoot: project.deliveryRoot,
    codepunkHome: home,
    directories: options.additionalDirs ?? [],
  });
  const paths = projectPaths(project, home, additionalRoots);
  const workspaceTrust = await resolveWorkspaceTrust({
    cwd: project.cwd,
    root: project.deliveryRoot,
    home: paths.home,
    includeSkills: !disableSkills,
    includeInstructions: !bare,
    ...(options.projectTrusted === undefined
      ? {}
      : {
          override: options.projectTrusted,
          source: options.projectTrustSource ?? ("flag" as const),
        }),
  });
  const projectConfigSafety = workspaceTrust.trusted
    ? await assertProjectConfigSafe(paths)
    : "workspace is not trusted";
  await ensureCodepunkHome(paths.home);
  await ensureProjectRegistration(project, paths);
  if (projectConfigSafety === null && workspaceTrust.trusted) {
    await ensureProjectConfigDir(paths);
  }
  const loadedConfig = await loadConfig(
    paths,
    options.environment ?? process.env,
    options.configOverrides ?? {},
    { projectTrusted: workspaceTrust.trusted },
  );
  const config = loadedConfig.config;
  const disableContext = bare;
  if (bare) {
    config.memory.enabled = false;
  }
  if (bare) {
    loadedConfig.warnings.push(
      "bare session: instruction files, skills, plugins, MCP servers, and memory are disabled",
    );
  } else {
    if (disableSkills) {
      loadedConfig.warnings.push(
        "skills are disabled for this session by --no-skills",
      );
    }
    if (disablePlugins) {
      loadedConfig.warnings.push(
        "user plugins are disabled for this session by --no-plugins",
      );
    }
  }
  if (
    options.allowUnsandboxedShell === true &&
    config.sandbox.mode !== "uncovered"
  ) {
    loadedConfig.warnings.push(
      "--allow-unsandboxed-shell has no effect because sandbox mode is required; pass --sandbox uncovered to use an explicitly unsandboxed shell",
    );
  }
  if (
    options.allowFullFilesystem === true &&
    config.autonomy.profile !== "ask"
  ) {
    throw new Error(
      `full access requires autonomy=ask; persisted autonomy=${config.autonomy.profile} cannot be combined with --dangerously-bypass-approvals-and-sandbox. Run codepunk permissions autonomy ask before starting full access.`,
    );
  }
  const filesystemIssue = filesystemFullStartupIssue(
    config.filesystem.mode,
    options.allowFullFilesystem === true,
  );
  if (filesystemIssue !== null) {
    throw new Error(filesystemIssue);
  }
  const policy = await loadPolicyFiles(paths, {
    projectTrusted: workspaceTrust.trusted,
  });
  loadedConfig.warnings.push(...policy.warnings);
  for (const projectMcpConfig of await findProjectMcpConfigs(paths)) {
    loadedConfig.warnings.push(
      `project MCP configuration ${path.relative(
        paths.deliveryRoot,
        projectMcpConfig,
      )} is ignored; MCP configuration is user-scope only`,
    );
  }
  if (!workspaceTrust.trusted && workspaceTrust.resources.length > 0) {
    loadedConfig.warnings.push(
      `workspace is untrusted; skipped ${skippedProjectResources(
        workspaceTrust,
      ).join(", ")}. Run codepunk trust grant to trust ${workspaceTrust.root}.`,
    );
  }
  let headlessPolicy: HeadlessPolicy | null = null;
  if (options.headlessPolicyPath !== undefined) {
    headlessPolicy = await loadHeadlessPolicy(
      options.headlessPolicyPath,
      paths,
    );
  }
  const memory = await MemoryManager.open({
    paths,
    enabled: config.memory.enabled,
    maxTokens: config.memory.max_tokens,
    defaultScope: config.memory.default_scope,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const readOnly = config.autonomy.profile === "read-only";
  if (disablePlugins && options.allowPlugins === true) {
    throw new Error(
      "plugins cannot be enabled when the session disables plugins",
    );
  }
  if (readOnly && options.allowPlugins === true) {
    throw new Error(
      "plugins cannot be enabled in read-only mode; choose standard or pass a different autonomy profile",
    );
  }
  const plugins = await loadUserPlugins({
    allowed:
      !disablePlugins &&
      !readOnly &&
      options.headless !== true &&
      (options.allowPlugins === true || config.plugins.enabled === true),
    extensionDir: path.join(paths.home, "extensions"),
  });
  if (readOnly && config.plugins.enabled) {
    loadedConfig.warnings.push(
      "read-only autonomy does not load user plugins because plugin code runs outside the tool policy",
    );
  }
  const skills = disableSkills
    ? { skills: [], block: "", warnings: [] }
    : await loadSkills({
        deliveryRoot: paths.deliveryRoot,
        codepunkHome: paths.home,
        projectTrusted: workspaceTrust.trusted,
      });
  const writeSet =
    headlessPolicy?.write ??
    (policy.writeSet.length > 0 ? policy.writeSet : [paths.cwd]);
  const writeSetWithAdditionalRoots = [
    ...new Set([...writeSet, ...paths.additionalRoots]),
  ];
  if (options.headless === true && config.autonomy.profile === "scoped") {
    throw new Error("scoped autonomy is not available in headless mode");
  }
  if (options.headless === true && options.allowUnsandboxedShell === true) {
    throw new Error("unsandboxed shell is never allowed in headless mode");
  }
  const autonomySource =
    options.configOverrides?.autonomy !== undefined ||
    options.configOverrides?.scopedRules !== undefined
      ? "cli"
      : config.autonomy.profile === "ask" &&
          config.autonomy.scoped_rules === null
        ? "default"
        : "user-config";
  let scopedRules: ScopedRule[] = [];
  let scopedRulesSha256: string | null = null;
  if (config.autonomy.profile === "scoped") {
    const loaded = await loadScopedRules(config.autonomy.scoped_rules!, paths);
    scopedRules = loaded.rules;
    scopedRulesSha256 = loaded.rulesSha256;
  }
  const autonomyRegistration: AutonomyRegistration = {
    profile: config.autonomy.profile,
    source: autonomySource,
    rules: scopedRules,
    rulesSha256: scopedRulesSha256,
  };
  const autonomy = new AutonomyController(autonomyRegistration);
  let sandbox: ShellProvider | null = null;
  if (config.sandbox.mode === "required") {
    try {
      sandbox = await SrtSandbox.create({
        cwd: paths.cwd,
        workspaceRoot: paths.deliveryRoot,
        deliveryRoot: paths.deliveryRoot,
        codepunkHome: paths.home,
        writeSet: writeSetWithAdditionalRoots,
        additionalRoots: paths.additionalRoots,
        networkAllow: config.sandbox.network_allow,
        networkDeny: config.sandbox.network_deny,
        readOnly: config.autonomy.profile === "read-only",
      });
    } catch {
      sandbox = null;
    }
  }
  if (
    sandbox === null &&
    config.sandbox.mode === "uncovered" &&
    options.allowUnsandboxedShell === true &&
    options.headless !== true
  ) {
    sandbox = new UnsandboxedShell();
  }
  if (sandbox === null) {
    loadedConfig.warnings.push(
      config.sandbox.mode === "uncovered"
        ? "sandbox mode is uncovered; shell tools are disabled unless this interactive process was started with --allow-unsandboxed-shell"
        : "sandbox required but srt is unavailable; shell tools are disabled; run codepunk doctor",
    );
  }
  const modelRuntime = await openModelRuntime(paths);
  let selectedModel = options.model;
  if (selectedModel === undefined) {
    try {
      selectedModel = await resolveConfiguredModel(paths, config, modelRuntime);
    } catch (error) {
      if (!(
        options.allowMissingModel === true && error instanceof ModelError
      )) {
        throw error;
      }
      loadedConfig.warnings.push(error.message);
    }
  }
  // Reviewer configuration is independent of the current approval snapshot.
  // A session may start in ask/deny and switch to auto at runtime; resolving
  // the concrete model now makes an optional reviewer a startup dependency.
  // Resolve it on first use instead, so a stale/offline reviewer cannot block
  // an ask/read-only session before an action ever needs it.
  const reviewerReference = config.approval.reviewer_model;
  const reviewerSeparator =
    reviewerReference === null ? -1 : reviewerReference.indexOf("/");
  const reviewerIdentity =
    reviewerSeparator > 0
      ? {
          provider: reviewerReference!.slice(0, reviewerSeparator),
          model: reviewerReference!.slice(reviewerSeparator + 1),
        }
      : selectedModel === undefined
        ? {}
        : { provider: selectedModel.provider, model: selectedModel.id };
  const reviewer: ActionReviewer | null =
    config.approval.reviewer === "model"
      ? new DeferredActionReviewer({
          ...reviewerIdentity,
          resolve: () =>
            resolveActionReviewer({
              mode: "model",
              runtime: modelRuntime,
              fallbackModel: selectedModel,
              modelReference: config.approval.reviewer_model,
              timeoutMs: config.approval.reviewer_timeout_ms,
            }),
        })
      : null;
  const session = await openSession(
    options,
    paths,
    config.session.heartbeat_seconds * 1_000,
    config.session.lease_seconds * 1_000,
  );
  if (selectedModel === undefined && config.model.fallback.length > 0) {
    loadedConfig.warnings.push(
      "model fallback is ignored until a primary model is configured",
    );
  }
  const mcpStarts: McpServerStart[] = [];
  let mcp: McpBundle;
  if (disableMcp) {
    mcp = emptyMcpBundle();
    if (
      await fs
        .access(path.join(paths.home, "mcp.toml"))
        .then(() => true)
        .catch(() => false)
    ) {
      loadedConfig.warnings.push(
        `MCP is disabled by ${bare ? "--bare" : "--no-mcp"}; user MCP servers are not started in this session`,
      );
    }
  } else if (selectedModel === undefined) {
    mcp = emptyMcpBundle();
    if (
      await fs
        .access(path.join(paths.home, "mcp.toml"))
        .then(() => true)
        .catch(() => false)
    ) {
      loadedConfig.warnings.push(
        "MCP servers are not started because no model is selected; select a model and restart the session to load MCP tools",
      );
    }
  } else if (readOnly) {
    // A read-only policy denies an MCP tool call, but a stdio server would
    // already have run arbitrary code at startup. Do not start an uncovered
    // process the session can never be allowed to use.
    mcp = emptyMcpBundle();
    if (
      await fs
        .access(path.join(paths.home, "mcp.toml"))
        .then(() => true)
        .catch(() => false)
    ) {
      loadedConfig.warnings.push(
        "read-only autonomy does not start MCP servers; their tools are unavailable in this session",
      );
    }
  } else {
    try {
      mcp = await loadMcpTools({
        paths,
        // A broken optional MCP server must not make the coding session
        // unusable. It is reported as a startup warning and omitted from the
        // tool registry; explicit `mcp test <name>` remains strict.
        strict: false,
        onServerStart: (start) => {
          mcpStarts.push(start);
        },
      });
    } catch (error) {
      throw new Error(
        `MCP startup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const failure of mcp.failures) {
    loadedConfig.warnings.push(
      `MCP server ${failure.server} skipped: ${failure.message}`,
    );
  }
  const settingsContextWindow =
    selectedModel === undefined
      ? undefined
      : config.model.fallback.length === 0
        ? selectedModel.contextWindow
        : await resolveFallbackContextWindow(
            paths,
            config,
            selectedModel,
            modelRuntime,
          );
  const configuredContext = await loadContext({
    cwd: paths.cwd,
    deliveryRoot: paths.deliveryRoot,
    codepunkHome: paths.home,
    disabled: disableContext,
    appendFiles: config.context.append_files.map((entry) => ({
      path: entry,
    })),
    appendText: config.context.append,
    replaceSystemPrompt: config.context.replace_system_prompt,
    systemPromptFile: config.context.system_prompt_file,
    projectTrusted: workspaceTrust.trusted,
  });
  let state = await session.readAgentState().catch((error: unknown) => {
    throw new Error(
      `cannot read session state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  if (state !== null) {
    const resumed = await session.resume().catch((error: unknown) => {
      throw new Error(
        `cannot resume session state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    if (resumed.uncommittedEvents.length > 0) {
      throw new Error(
        `session has ${resumed.uncommittedEvents.length} uncommitted event(s) after the last agent-state snapshot; refusing to resume with a stale model transcript. Export the session log and start a new session.`,
      );
    }
    state = resumed.state;
  } else if (session.allEvents.length > 0) {
    throw new Error(
      "session has events but no agent-state.json; refusing to resume empty",
    );
  }
  const initialRunId =
    options.runId ?? createUlid(options.now?.() ?? new Date());
  const ledger = new RunLedger(paths, session.sessionId, initialRunId);
  await ledger.prepare(initialRunId);
  const approval = new ApprovalBroker();
  const interactiveApprovalChannel = options.approvalChannel ?? null;
  if (config.approval.mode !== "deny" && interactiveApprovalChannel !== null) {
    approval.registerChannel(interactiveApprovalChannel);
  }
  const layers = [...policy.layers];
  if (headlessPolicy !== null) {
    layers.push(headlessLayer(headlessPolicy));
  }
  const tools = effectiveTools(
    config,
    sandbox,
    memory,
    options.headless === true,
    headlessPolicy,
  );
  // `/permissions sandbox` changes `config.sandbox.mode` for the next session
  // while this process keeps the shell provider it started with. Denial text
  // and evidence reasons must describe that provider, not the pending value.
  const sessionSandboxMode = config.sandbox.mode;
  const runEnded = async (runId: string): Promise<void> => {
    const evidence = await readEvidenceFile(
      evidenceRunPath(paths, session.sessionId, runId),
    );
    if (evidence.records.length > 0) {
      await appendEvidenceIndex(
        paths,
        session.sessionId,
        runId,
        evidence.records,
      );
    }
    if (evidence.records.length > 0) {
      await deriveAndWriteVerdict({
        paths,
        sessionId: session.sessionId,
        runId,
        evidencePath: evidenceRunPath(paths, session.sessionId, runId),
        events: session.allEvents,
        ...(options.now !== undefined ? { now: options.now() } : {}),
      });
    }
  };
  let host: PiHost;
  try {
    host = await createPiHost({
      cwd: paths.cwd,
      workspaceRoot: paths.deliveryRoot,
      additionalRoots: paths.additionalRoots,
      deliveryRoot: paths.deliveryRoot,
      codepunkHome: paths.home,
      sessionId: session.sessionId,
      runId: initialRunId,
      writeSet: writeSetWithAdditionalRoots,
      readableSkillFiles: skills.skills.map((skill) => skill.path),
      filesystem: config.filesystem.mode,
      userRules: [...policy.userRules, ...(headlessPolicy?.rules ?? [])],
      projectRules: policy.projectRules,
      layers,
      mode: options.headless === true ? "headless" : "interactive",
      approval,
      autonomy,
      ledger: ledger as unknown as EvidenceLedger,
      reviewer,
      sandbox,
      approvalMode: () => config.approval.mode,
      networkAllowedDomains: config.sandbox.network_allow,
      networkDeniedDomains: config.sandbox.network_deny,
      shellUnavailableReason: () => shellUnavailableReason(sessionSandboxMode),
      context: configuredContext,
      artifactsDir: paths.artifactsDir,
      artifactThresholdTokens: config.context.artifact_threshold_tokens,
      maxToolOutputTokens: config.context.max_tool_output_tokens,
      truncation: config.context.truncation,
      truncationThreshold: config.context.truncation_threshold,
      sessionStore: session,
      settings: piSettings(config, settingsContextWindow),
      enabledTools: tools,
      memory,
      autoMemorySummary: config.memory.auto_summary,
      disableUserBash: plugins.summary.enabled,
      extensionPaths: plugins.paths,
      ...(options.additionalExtensionFactories !== undefined
        ? { additionalExtensionFactories: options.additionalExtensionFactories }
        : {}),
      bindMode:
        options.bindMode ?? (options.headless === true ? "print" : "tui"),
      modelRuntime,
      ...(selectedModel !== undefined ? { model: selectedModel } : {}),
      ...(selectedModel !== undefined && config.model.fallback.length > 0
        ? {
            fallbackModels: config.model.fallback,
            fallbackAllowCrossProvider:
              config.model.fallback_allow_cross_provider,
          }
        : {}),
      ...(config.model.thinking !== undefined
        ? { thinkingLevel: config.model.thinking as never }
        : {}),
      ...(config.budget.max_tokens !== null ||
      config.budget.max_cost_usd !== null
        ? {
            budget: {
              ...(config.budget.max_tokens === null
                ? {}
                : { maxTokens: config.budget.max_tokens }),
              ...(config.budget.max_cost_usd === null
                ? {}
                : { maxCostUsd: config.budget.max_cost_usd }),
            },
          }
        : {}),
      ...(state !== null ? { restore: state } : {}),
      runtimeFacts: {
        now: () => options.now?.() ?? new Date(),
        ...(options.timeZone === undefined
          ? {}
          : { timeZone: options.timeZone }),
      },
      ...(headlessPolicy !== null
        ? {
            verifyExec: (argv: readonly string[], cwd: string) =>
              verifyHeadlessExec(headlessPolicy!, argv, cwd),
          }
        : {}),
      onRunStart: async (runId: string) => {
        await ledger.prepare(runId);
      },
      onRunEnd: runEnded,
      extraTools: [...mcp.tools, ...mcp.resourceTools],
      ...(skills.block.length > 0 ? { extraInstruction: skills.block } : {}),
    });
  } catch (error) {
    await mcp.close();
    throw error;
  }
  await host.recordEvent("autonomy/profile", {
    profile: autonomy.profile,
    source: autonomy.source,
    rules_sha256: autonomy.rulesSha256,
    rules: autonomy.rules.map((rule) => ({
      id: rule.id,
      argv: [...rule.argv],
      cwd: rule.cwd,
      executable_sha256: rule.executable_sha256,
      rule_sha256: rule.rule_sha256,
    })),
  });
  await host.recordEvent("trust/decision", {
    cwd: workspaceTrust.cwd,
    root: workspaceTrust.root,
    decision: workspaceTrust.trusted ? "trusted" : "untrusted",
    source: workspaceTrust.source,
    resources: [...workspaceTrust.resources],
    skipped: skippedProjectResources(workspaceTrust),
  });
  if (skills.skills.length > 0) {
    await host.recordEvent("skill/loaded", {
      skills: skills.skills.map((skill) => ({
        name: skill.name,
        scope: skill.scope,
        sha256: skill.sha256,
        bytes: skill.bytes,
      })),
      block_sha256: sha256Text(skills.block),
    });
  }
  for (const start of mcpStarts) {
    await host.recordEvent("mcp/server_start", start);
  }

  const runtime: CodepunkRuntime = {
    project,
    paths,
    config,
    loadedConfig,
    policy,
    plugins: plugins.summary,
    skills: skills.skills,
    isolation: {
      bare,
      context: disableContext,
      skills: disableSkills,
      plugins: disablePlugins,
      mcp: disableMcp,
      memory: bare,
    },
    mcpServers: mcp.servers,
    workspaceTrust,
    memory,
    session,
    ledger,
    sandbox,
    autonomy,
    approval,
    host,
    primaryModel:
      host.primaryModel ??
      (host.session.model !== undefined && !isFallbackModel(host.session.model)
        ? host.session.model
        : undefined),
    fallbackModels: host.fallbackModels,
    runId: host.currentRunId,
    evidencePath: ledger.filePath,
    permissionSnapshot: {
      filesystem: config.filesystem.mode,
      readOnly: config.autonomy.profile === "read-only",
      networkAllow: [...config.sandbox.network_allow],
      networkDeny: [...config.sandbox.network_deny],
    },
    usage() {
      const stats = host.session.getSessionStats();
      return summarizeSessionModelUsage(session.allEvents, {
        ...stats.tokens,
        cost: stats.cost,
      });
    },
    setApprovalMode(mode) {
      config.approval.mode = mode;
      if (mode === "allow" || mode === "deny") {
        approval.clearSessionGrants();
      }
      approval.replaceChannel(
        mode === "deny" ? null : interactiveApprovalChannel,
      );
    },
    async signInProcess(verdict, signOptions = {}) {
      const request: Omit<SignOffRequest, "run_id"> = {
        version: 1,
        evidence_head: ledger.head ?? "",
        signed_verdict: verdict,
        channel: signOptions.channel ?? "tui",
        actor: signOptions.actor ?? "local-user",
        is_tty: signOptions.tty ?? true,
        source: "human",
        previous_sign_off_id: latestSignOffId(
          session.allEvents,
          host.currentRunId,
        ),
      };
      const currentEvidence = await readEvidenceFile(ledger.filePath);
      const prepared = prepareSignOff({
        runId: host.currentRunId,
        records: currentEvidence.records,
        events: session.allEvents,
        request: { ...request, run_id: host.currentRunId },
        ...(options.now !== undefined ? { now: options.now() } : {}),
      });
      if (!prepared.ok) {
        throw new Error(`${prepared.code}: ${prepared.message}`);
      }
      await session.append("verdict/sign_off", prepared.prepared.data);
      const result = await deriveAndWriteVerdict({
        paths,
        sessionId: session.sessionId,
        runId: host.currentRunId,
        evidencePath: ledger.filePath,
        events: session.allEvents,
        ...(options.now !== undefined ? { now: options.now() } : {}),
      });
      return {
        verdict: result.derivation.verdict,
        artifactPath: result.path,
        issues: result.derivation.issues,
      };
    },
    async recordMemoryWrite(input) {
      await session.append("memory/write", {
        scope: input.scope,
        action: input.action,
        memory_id: input.memoryId,
        content_sha256: input.contentSha256,
        source_refs: [...input.sourceRefs],
        reason: input.reason,
      });
    },
    async dispose() {
      await mcp.close();
      autonomy.revoke();
      await host
        .recordEvent("autonomy/revoked", {
          profile: autonomy.profile,
          reason: "session_end",
        })
        .catch(() => undefined);
      await host.dispose();
    },
  };
  return runtime;
}

function pathsHome(environment: NodeJS.ProcessEnv | undefined): string {
  return normalizeAbsolute(resolveCodepunkHome(environment ?? process.env));
}

function latestSignOffId(
  events: readonly SessionEvent[],
  runId: string,
): string | null {
  const signOffs = events.filter(
    (event): event is Extract<SessionEvent, { kind: "verdict/sign_off" }> =>
      event.kind === "verdict/sign_off" && event.data.run_id === runId,
  );
  return signOffs.at(-1)?.data.sign_off_id ?? null;
}

export async function signStandalone(options: {
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  runId: string;
  verdict: "complete" | "incomplete";
  actor?: string;
  tty?: boolean;
  now?: () => Date;
}): Promise<RuntimeSignResult> {
  const project = await findDeliveryRoot(options.cwd);
  const paths = projectPaths(project, pathsHome(options.environment));
  return signRun({
    paths,
    cwd: paths.cwd,
    projectRoot: paths.deliveryRoot,
    runId: options.runId,
    request: {
      version: 1,
      evidence_head: "",
      signed_verdict: options.verdict,
      channel: "cli",
      actor: options.actor ?? "local-user",
      is_tty: options.tty !== false,
      source: "human",
      previous_sign_off_id: null,
    },
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

export type { AgentSession, AgentSessionServices, SessionManager };
