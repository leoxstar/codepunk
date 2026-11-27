import { promises as fs } from "node:fs";
import path from "node:path";
import { type HookEvidence, type SignOffRequest } from "codepunk-protocol";
import { createPiHost, type PiHost } from "../adapters/pi/index.ts";
import { ApprovalBroker } from "../approval/index.ts";
import {
  AutonomyController,
  type AutonomyRegistration,
  type ScopedRule,
} from "../autonomy/index.ts";
import { HookRunner } from "../capabilities/hooks.ts";
import { CheckpointStore } from "../checkpoints/index.ts";
import {
  ConfigError,
  loadConfig,
  piSettings,
  type CodepunkConfig,
} from "../config/index.ts";
import {
  headlessLayer,
  loadHeadlessPolicy,
  loadPolicyFiles,
  type HeadlessPolicy,
} from "../config/policy.ts";
import { loadScopedRules } from "../config/scoped.ts";
import { loadContext } from "../context/index.ts";
import { readEvidenceFile } from "../evidence/index.ts";
import {
  emptyMcpBundle,
  findProjectMcpConfigs,
  loadMcpTools,
  type McpBundle,
  type McpServerStart,
} from "../mcp/index.ts";
import { MemoryManager } from "../memory/index.ts";
import { isFallbackModel } from "../model/fallback.ts";
import {
  ModelError,
  openModelRuntime,
  resolveConfiguredModel,
  resolveFallbackContextWindow,
  summarizeSessionModelUsage,
} from "../model/index.ts";
import {
  filesystemFullStartupIssue,
  readOnlyLiveSwitchIssue,
  readOnlyLiveWidenIssue,
  shellUnavailableReason,
} from "../permissions/index.ts";
import { createUlid, sha256Text } from "../platform/hash.ts";
import { relativeDisplayPath } from "../platform/path.ts";
import {
  assertProjectConfigSafe,
  ensureCodepunkHome,
  ensureProjectConfigDir,
  ensureProjectRegistration,
  findDeliveryRoot,
  projectPaths,
  resolveAdditionalWorkspaceRoots,
} from "../platform/paths.ts";
import { loadUserPlugins, type PluginLoadResult } from "../plugin/index.ts";
import {
  DeferredActionReviewer,
  resolveActionReviewer,
  type ActionReviewer,
} from "../reviewer/index.ts";
import {
  DeferredSandbox,
  SandboxManager,
  SrtSandbox,
  UnsandboxedShell,
  probeWindowsShell,
  resolveWindowsShell,
  type ShellProvider,
} from "../sandbox/index.ts";
import { isBenignTailEventKind } from "../session/index.ts";
import { loadSkills, type SkillBundle } from "../skills/index.ts";
import {
  resolveWorkspaceTrust,
  skippedProjectResources,
} from "../trust/index.ts";
import { prepareSignOff } from "../verdict/index.ts";
import {
  appendEvidenceIndex,
  deriveAndWriteVerdict,
  evidenceRunPath,
} from "../verdict/store.ts";
import {
  isPlanModeReadOnlyTool,
  planContentHash,
  readPlanModeState,
  readWorkState,
  type PlanModeState,
} from "../work/index.ts";
import {
  CONFIG_SECTIONS,
  closePendingSandboxForStartupFailure,
  configValuesEqual,
  effectiveTools,
  latestSignOffId,
  openSession,
  pathsHome,
  sessionSelectorIssue,
  signStandalone,
  verifyHeadlessExec,
} from "./helpers.ts";
import {
  RunLedger,
  type AgentSession,
  type AgentSessionServices,
  type CodepunkRuntime,
  type ConfigReloadResult,
  type McpReloadResult,
  type McpReloadSkip,
  type PluginReloadResult,
  type RuntimeOptions,
  type RuntimeSignResult,
  type SessionManager,
  type SkillReloadResult,
} from "./types.ts";

export {
  RunLedger,
  signStandalone,
  type AgentSession,
  type AgentSessionServices,
  type CodepunkRuntime,
  type ConfigReloadResult,
  type McpReloadResult,
  type McpReloadSkip,
  type PluginReloadResult,
  type RuntimeOptions,
  type RuntimeSignResult,
  type SessionManager,
  type SkillReloadResult,
};

export async function createRuntime(
  options: RuntimeOptions,
): Promise<CodepunkRuntime> {
  // The srt sandbox starts a long-lived proxy process. If startup fails
  // before the runtime is returned, cancel the pending initialization;
  // otherwise a resolving provider would keep the event loop alive and the
  // CLI would print its error and then hang instead of exiting.
  const startupCleanup: { current: (() => Promise<void>) | null } = {
    current: null,
  };
  try {
    return await createRuntimeInner(options, startupCleanup);
  } catch (error) {
    await closePendingSandboxForStartupFailure(startupCleanup);
    throw error;
  }
}

async function createRuntimeInner(
  options: RuntimeOptions,
  startupCleanup: { current: (() => Promise<void>) | null },
): Promise<CodepunkRuntime> {
  const selectorIssue = sessionSelectorIssue(options);
  if (selectorIssue !== null) {
    throw new Error(selectorIssue);
  }
  const environment = options.environment ?? process.env;
  const configOverrides = { ...(options.configOverrides ?? {}) };
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
    ...(options.projectTrust === undefined
      ? {}
      : {
          override: options.projectTrust,
          source: options.projectTrustSource ?? ("flag" as const),
          savedPath: options.projectTrustSavedPath ?? null,
        }),
  });
  const hooks = new HookRunner({
    deliveryRoot: paths.deliveryRoot,
    userHome: paths.home,
    cwd: paths.cwd,
    projectTrusted: workspaceTrust.grants.config,
  });
  const projectResourceRequested =
    workspaceTrust.grants.config || workspaceTrust.grants.policy;
  const projectConfigSafety = projectResourceRequested
    ? await assertProjectConfigSafe(paths)
    : "project config and policy are not trusted";
  await ensureCodepunkHome(paths.home);
  await ensureProjectRegistration(project, paths);
  if (projectConfigSafety === null && projectResourceRequested) {
    await ensureProjectConfigDir(paths);
  }
  const loadedConfig = await loadConfig(paths, environment, configOverrides, {
    projectTrusted: workspaceTrust.grants.config,
  });
  const config = loadedConfig.config;
  const windowsShell = await resolveWindowsShell(
    config.tools.shell,
    environment,
  );
  if (
    process.platform === "win32" &&
    windowsShell.kind !== "auto" &&
    config.sandbox.mode !== "required"
  ) {
    throw new ConfigError(
      `tools.shell=${windowsShell.kind} requires sandbox.mode=required on Windows`,
      "tools.shell",
    );
  }
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
    projectTrusted: workspaceTrust.grants.policy,
  });
  loadedConfig.warnings.push(...policy.warnings);
  for (const projectMcpConfig of await findProjectMcpConfigs(paths)) {
    loadedConfig.warnings.push(
      `project MCP configuration ${relativeDisplayPath(
        paths.deliveryRoot,
        projectMcpConfig,
      )} is ignored; MCP configuration is user-scope only`,
    );
  }
  const skippedTrustResources = skippedProjectResources(workspaceTrust);
  if (skippedTrustResources.length > 0) {
    loadedConfig.warnings.push(
      workspaceTrust.mode === "none"
        ? `workspace is not trusted; skipped ${skippedTrustResources.join(
            ", ",
          )}. Run codepunk trust grant to trust ${workspaceTrust.root}.`
        : `workspace trust is custom; skipped ${skippedTrustResources.join(
            ", ",
          )}. Run codepunk trust grant --resources <kinds> to change ${
            workspaceTrust.root
          }.`,
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
  const pluginsAllowed =
    !disablePlugins &&
    !readOnly &&
    options.headless !== true &&
    (options.allowPlugins === true || config.plugins.enabled === true);
  const plugins = await loadUserPlugins({
    allowed: pluginsAllowed,
    extensionDir: path.join(paths.home, "extensions"),
  });
  const pluginState: { current: PluginLoadResult } = { current: plugins };
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
        projectTrusted: workspaceTrust.grants.skills,
      });
  const readableSkillFiles = skills.skills.map((skill) => skill.path);
  const skillState: { current: SkillBundle } = { current: skills };
  const writeSet =
    headlessPolicy?.write ??
    (policy.writeSet.length > 0 ? policy.writeSet : [paths.cwd]);
  const writeSetWithAdditionalRoots = [
    ...new Set([...writeSet, ...paths.additionalRoots]),
  ];
  if (
    options.headless === true &&
    config.autonomy.profile === "scoped" &&
    config.approval.mode !== "deny"
  ) {
    throw new Error(
      "scoped autonomy in headless mode requires approval=deny; unmatched commands fail closed",
    );
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
  let sandboxReady: Promise<ShellProvider | null> = Promise.resolve(null);
  let sandboxUnavailableReason: string | null = null;
  let shellPreflightIssue: string | null = null;
  let closePendingSandbox: () => Promise<void> = () => Promise.resolve();
  let pendingSandboxProvider: () => ShellProvider | null = () => sandbox;
  let resolveShellPreflight: () => void = () => undefined;
  const shellPreflightSettled = new Promise<void>((resolve) => {
    resolveShellPreflight = resolve;
  });
  if (process.platform !== "win32" || windowsShell.kind === "auto") {
    resolveShellPreflight();
  }
  // The sandbox starts before the Pi host exists. The ref is filled in once
  // the host is created, so the sandbox's network events reach the session
  // log through the host's own append chain.
  const hostRef: { current: PiHost | null } = { current: null };
  const appendHookEvidence = async (evidence: HookEvidence): Promise<void> => {
    if (hostRef.current === null) {
      throw new Error("hook evidence cannot be written before the host exists");
    }
    await hostRef.current.recordEvent("hook/result", evidence);
  };
  if (config.sandbox.mode === "required") {
    const createPromise = SrtSandbox.create(
      {
        cwd: paths.cwd,
        workspaceRoot: paths.deliveryRoot,
        deliveryRoot: paths.deliveryRoot,
        codepunkHome: paths.home,
        writeSet: writeSetWithAdditionalRoots,
        additionalRoots: paths.additionalRoots,
        networkAllow: config.sandbox.network_allow,
        networkDeny: config.sandbox.network_deny,
        networkMaxRequests: config.sandbox.network_max_requests,
        networkMaxBytes: config.sandbox.network_max_bytes,
        readOnly: config.autonomy.profile === "read-only",
        ...(windowsShell.binShell === null
          ? {}
          : { windowsBinShell: windowsShell.binShell }),
      },
      {
        // The sandbox starts before the session writer lock is acquired, so
        // the run id and the sink are resolved lazily. The callback is only
        // invoked for events after the host has acquired the writer.
        runId: () => hostRef.current?.currentRunId ?? initialRunId,
        onNetworkEvent: async (kind, data) => {
          await hostRef.current?.recordEvent(kind, data);
        },
      },
    );
    sandboxReady = createPromise
      .then((createdSandbox) => {
        sandbox = createdSandbox;
        return createdSandbox;
      })
      .catch((error: unknown) => {
        sandboxUnavailableReason =
          error instanceof Error ? error.message : String(error);
        sandbox = null;
        return null;
      });
    const pendingSandbox = new DeferredSandbox(sandboxReady, {
      cancelPendingInitialization: () => {
        // On Linux srt's initialize() spawns a socat bridge. A reset() that
        // lands while that bridge is being created is not visible to the
        // library's cleanup, so the bridge survives and keeps the process
        // alive. Let initialization settle and close the provider through
        // DeferredSandbox's late-close path instead.
        if (process.platform !== "linux") {
          void SandboxManager.reset();
        }
      },
    });
    sandbox = pendingSandbox;
    pendingSandboxProvider = () => pendingSandbox;
    closePendingSandbox = async () => {
      if (startupCleanup.current === closePendingSandbox) {
        startupCleanup.current = null;
      }
      await pendingSandbox.close();
    };
  }
  const runtimeSandboxReady: Promise<ShellProvider | null> = sandboxReady;
  if (config.sandbox.mode === "required") {
    startupCleanup.current = closePendingSandbox;
  }
  if (process.platform === "win32" && windowsShell.kind !== "auto") {
    void runtimeSandboxReady
      .then(async (resolved) => {
        if (resolved === null) {
          throw new ConfigError(
            `tools.shell=${windowsShell.kind} requires the srt sandbox on Windows; shell tools stay disabled until srt is available`,
            "tools.shell",
          );
        }
        await probeWindowsShell(resolved, windowsShell, paths.cwd);
      })
      .catch(async (error: unknown) => {
        shellPreflightIssue =
          error instanceof Error ? error.message : String(error);
        sandbox = null;
        sandboxUnavailableReason = shellPreflightIssue;
      })
      .finally(() => {
        resolveShellPreflight?.();
      });
  } else {
    resolveShellPreflight?.();
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
        : `sandbox required but srt is unavailable; shell tools are disabled${
            sandboxUnavailableReason === null
              ? ""
              : `: ${sandboxUnavailableReason}`
          }; run codepunk doctor`,
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
        await closePendingSandboxForStartupFailure(startupCleanup);
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
  const checkpoints = new CheckpointStore({
    sessionDir: session.paths.sessionDir,
    workspaceRoot: paths.deliveryRoot,
    additionalRoots: paths.additionalRoots,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  if (selectedModel === undefined && config.model.fallback.length > 0) {
    loadedConfig.warnings.push(
      "model fallback is ignored until a primary model is configured",
    );
  }
  const mcpStarts: McpServerStart[] = [];
  let mcp: McpBundle;
  let mcpStatus: CodepunkRuntime["mcpStatus"] = "ready";
  let mcpReady: Promise<void> = Promise.resolve();
  let startDeferredMcp = false;
  const mcpStartupWarnings: string[] = [];
  const hasMcpConfig = await fs
    .access(path.join(paths.home, "mcp.toml"))
    .then(() => true)
    .catch(() => false);
  if (disableMcp) {
    mcp = emptyMcpBundle();
    mcpStatus = "skipped";
    if (hasMcpConfig) {
      loadedConfig.warnings.push(
        `MCP is disabled by ${bare ? "--bare" : "--no-mcp"}; user MCP servers are not started in this session`,
      );
    }
  } else if (selectedModel === undefined) {
    mcp = emptyMcpBundle();
    mcpStatus = "skipped";
    if (hasMcpConfig) {
      loadedConfig.warnings.push(
        "MCP servers are not started because no model is selected; select a model with /model and run /reload in the TUI (or restart) to load MCP tools",
      );
    }
  } else if (readOnly) {
    // A read-only policy denies an MCP tool call, but a stdio server would
    // already have run arbitrary code at startup. Do not start an uncovered
    // process the session can never be allowed to use.
    mcp = emptyMcpBundle();
    mcpStatus = "skipped";
    if (hasMcpConfig) {
      loadedConfig.warnings.push(
        "read-only autonomy does not start MCP servers; leave read-only and run /reload in the TUI (or restart) to start them",
      );
    }
  } else if (options.deferMcp === true && hasMcpConfig) {
    mcp = emptyMcpBundle();
    mcpStatus = "connecting";
    startDeferredMcp = true;
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
    projectTrusted: workspaceTrust.grants.instructions,
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
    if (
      resumed.uncommittedEvents.some(
        (event) => !isBenignTailEventKind(event.kind),
      )
    ) {
      throw new Error(
        `session has ${resumed.uncommittedEvents.length} uncommitted event(s) after the last agent-state snapshot; refusing to resume with a stale model transcript. Export the session log and start a new session.`,
      );
    }
    if (
      resumed.uncommittedEvents.length > 0 &&
      (resumed.state.entries === undefined ||
        resumed.state.leaf_id === undefined)
    ) {
      throw new Error(
        "session has benign uncommitted events but the agent-state entry tree is incomplete; refusing to resume without a complete Pi transcript",
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
  const approval = new ApprovalBroker({
    workspaceTrusted: workspaceTrust.trusted,
  });
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
      readableSkillFiles,
      filesystem: config.filesystem.mode,
      userRules: [...policy.userRules, ...(headlessPolicy?.rules ?? [])],
      projectRules: policy.projectRules,
      layers,
      mode: options.headless === true ? "headless" : "interactive",
      approval,
      autonomy,
      ledger,
      reviewer,
      sandbox: () =>
        shellPreflightIssue === null ? pendingSandboxProvider() : null,
      closeSandbox: false,
      approvalMode: () => config.approval.mode,
      planMode: () => readPlanModeState(session.allEvents),
      currentPlan: () => readWorkState(session.allEvents).plan,
      networkAllowedDomains: config.sandbox.network_allow,
      networkDeniedDomains: config.sandbox.network_deny,
      shellUnavailableReason: () =>
        shellPreflightIssue === null
          ? shellUnavailableReason(sessionSandboxMode)
          : `${shellUnavailableReason(sessionSandboxMode)} (${shellPreflightIssue})`,
      context: configuredContext,
      artifactsDir: paths.artifactsDir,
      checkpoints,
      artifactThresholdTokens: config.context.artifact_threshold_tokens,
      maxToolOutputTokens: config.context.max_tool_output_tokens,
      truncation: config.context.truncation,
      truncationThreshold: config.context.truncation_threshold,
      beforeToolHook: async (input) => {
        await hooks.run("before_tool", input, appendHookEvidence);
      },
      afterToolHook: async (input) => {
        await hooks.run("after_tool", input, appendHookEvidence);
      },
      beforeStopHook: async (input) => {
        await hooks.run("before_stop", input, appendHookEvidence);
      },
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
      budget: {
        ...(config.budget.max_tokens === null
          ? {}
          : { maxTokens: config.budget.max_tokens }),
        ...(config.budget.max_cost_usd === null
          ? {}
          : { maxCostUsd: config.budget.max_cost_usd }),
        maxToolCalls: config.budget.max_tool_calls,
        maxWallMs: config.budget.max_wall_ms,
      },
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
      ...(options.questionChannel !== undefined
        ? { questionChannel: options.questionChannel }
        : {}),
      ...(options.subagentExecutor !== undefined
        ? { subagentExecutor: options.subagentExecutor }
        : {}),
      ...(skills.block.length > 0 ? { extraInstruction: skills.block } : {}),
    });
  } catch (error) {
    await closePendingSandboxForStartupFailure(startupCleanup);
    await mcp.close();
    throw error;
  }
  hostRef.current = host;
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
    mode: workspaceTrust.mode,
    source: workspaceTrust.source,
    resources: [...workspaceTrust.resources],
    skipped: skippedProjectResources(workspaceTrust),
    grants: { ...workspaceTrust.grants },
    available: [...workspaceTrust.available],
  });
  try {
    await hooks.run(
      "session_start",
      {
        session_id: session.sessionId,
        cwd: paths.cwd,
        project_id: paths.projectId,
      },
      appendHookEvidence,
    );
  } catch (error) {
    await closePendingSandboxForStartupFailure(startupCleanup);
    await host.dispose().catch(() => undefined);
    throw error;
  }
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
  let runtimeDisposed = false;
  if (startDeferredMcp) {
    mcpReady = (async () => {
      const deferredStarts: McpServerStart[] = [];
      try {
        const next = await loadMcpTools({
          paths,
          strict: false,
          onServerStart: (start) => {
            deferredStarts.push(start);
          },
        });
        if (runtimeDisposed) {
          await next.close().catch(() => undefined);
          return;
        }
        await host.replaceExtraTools([...next.tools, ...next.resourceTools]);
        await host.session.reload();
        if (runtimeDisposed) {
          await next.close().catch(() => undefined);
          return;
        }
        const previous = mcp;
        mcp = next;
        await previous.close().catch(() => undefined);
        for (const start of deferredStarts) {
          await host
            .recordEvent("mcp/server_start", start)
            .catch(() => undefined);
        }
        for (const failure of next.failures) {
          mcpStartupWarnings.push(
            `MCP server ${failure.server} skipped: ${failure.message}`,
          );
        }
        mcpStatus =
          next.failures.length > 0 && next.servers.length === 0
            ? "failed"
            : "ready";
      } catch (error) {
        mcpStatus = "failed";
        mcpStartupWarnings.push(
          `MCP startup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  }

  const applyApprovalMode = (
    mode: CodepunkConfig["approval"]["mode"],
  ): void => {
    config.approval.mode = mode;
    if (mode === "allow" || mode === "deny") {
      approval.clearSessionGrants();
    }
    approval.replaceChannel(
      mode === "deny" ? null : interactiveApprovalChannel,
    );
  };

  const applyAutonomy = async (
    next: CodepunkConfig["autonomy"],
  ): Promise<void> => {
    if (next.profile === "read-only") {
      const issue = readOnlyLiveSwitchIssue({
        pluginsEnabled: pluginState.current.summary.enabled,
        mcpServers: mcp.servers,
        sandboxStartedWritable: sandbox?.sandboxed === true && !readOnly,
      });
      if (issue !== null) {
        throw new Error(issue);
      }
    } else if (autonomy.profile === "read-only") {
      const issue = readOnlyLiveWidenIssue({
        target: next.profile,
        sandboxStartedReadOnly: sandbox?.sandboxed === true && readOnly,
      });
      if (issue !== null) {
        throw new Error(issue);
      }
    }

    let rules: readonly ScopedRule[] = autonomy.rules;
    let rulesSha256 = autonomy.rulesSha256;
    if (next.profile === "scoped") {
      const loaded = await loadScopedRules(next.scoped_rules!, paths);
      rules = loaded.rules;
      rulesSha256 = loaded.rulesSha256;
    }

    const previousProfile = autonomy.profile;
    const previousRules = autonomy.rules;
    const previousRulesSha256 = autonomy.rulesSha256;
    try {
      if (next.profile === "scoped") {
        autonomy.replaceRules(rules, rulesSha256);
      }
      autonomy.setProfile(next.profile);
    } catch (error) {
      autonomy.replaceRules(previousRules, previousRulesSha256);
      autonomy.setProfile(previousProfile);
      throw error;
    }
    config.autonomy = structuredClone(next);
  };

  let toolNamesBeforePlanMode: string[] | null = null;
  const applyPlanModeToolSurface = (mode: PlanModeState["mode"]): void => {
    if (mode === "planning") {
      if (toolNamesBeforePlanMode === null) {
        toolNamesBeforePlanMode = host.session.getActiveToolNames();
      }
      const readOnly = host.session
        .getAllTools()
        .map((tool) => tool.name)
        .filter(isPlanModeReadOnlyTool);
      host.session.setActiveToolsByName(readOnly);
      return;
    }
    if (toolNamesBeforePlanMode !== null) {
      host.session.setActiveToolsByName(toolNamesBeforePlanMode);
      toolNamesBeforePlanMode = null;
    }
  };
  const appendPlanMode = async (
    mode: PlanModeState["mode"],
    planSha256: string | null,
  ): Promise<PlanModeState> => {
    const state = {
      mode,
      plan_sha256: planSha256,
      updated_at: (options.now?.() ?? new Date()).toISOString(),
    };
    await session.append("plan_mode/update", state);
    applyPlanModeToolSurface(mode);
    return state;
  };
  const currentPlanMode = readPlanModeState(session.allEvents);
  if (currentPlanMode?.mode === "planning") {
    applyPlanModeToolSurface("planning");
  }

  const runtime: CodepunkRuntime = {
    project,
    paths,
    config,
    configOverrides,
    loadedConfig,
    policy,
    get plugins() {
      return pluginState.current.summary;
    },
    get skills() {
      return skillState.current.skills;
    },
    isolation: {
      bare,
      context: disableContext,
      skills: disableSkills,
      plugins: disablePlugins,
      mcp: disableMcp,
      memory: bare,
    },
    get mcpServers() {
      return mcp.servers;
    },
    get mcpStatus() {
      return mcpStatus;
    },
    get mcpReady() {
      return mcpReady;
    },
    get mcpStartupWarnings() {
      return mcpStartupWarnings;
    },
    workspaceTrust,
    memory,
    session,
    checkpoints,
    ledger,
    get sandbox() {
      return sandbox;
    },
    sandboxReady: runtimeSandboxReady,
    async shellPreflightSettled() {
      await shellPreflightSettled;
    },
    get shellPreflightIssue() {
      return shellPreflightIssue;
    },
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
    setApprovalMode: applyApprovalMode,
    planMode: {
      state() {
        return readPlanModeState(session.allEvents);
      },
      async enter() {
        const current = readPlanModeState(session.allEvents);
        if (current?.mode === "planning") {
          return current;
        }
        return appendPlanMode("planning", null);
      },
      async approve() {
        const plan = readWorkState(session.allEvents).plan;
        const hash = planContentHash(plan);
        if (hash === null) {
          throw new Error(
            "No plan to approve. Record a plan with the plan tool first.",
          );
        }
        const current = readPlanModeState(session.allEvents);
        if (current?.mode === "executing" && current.plan_sha256 === hash) {
          return current;
        }
        return appendPlanMode("executing", hash);
      },
      async exit() {
        const current = readPlanModeState(session.allEvents);
        if (current?.mode === "off") {
          return current;
        }
        return appendPlanMode("off", null);
      },
    },
    async reloadConfig() {
      if (host.session.isStreaming) {
        throw new Error(
          "Wait for the current response to finish before reloading.",
        );
      }
      if (host.session.isCompacting) {
        throw new Error("Wait for compaction to finish before reloading.");
      }
      const loaded = await loadConfig(paths, environment, configOverrides, {
        projectTrusted: workspaceTrust.grants.config,
      });
      const next = loaded.config;
      const changedSections = CONFIG_SECTIONS.filter(
        (section) => !configValuesEqual(config[section], next[section]),
      );
      if (changedSections.length === 0) {
        return {
          changed: false,
          changedSections: [],
          applied: [],
          nextSession: [],
          blocked: [],
          warnings: [...loaded.warnings],
          pluginsChanged: false,
        };
      }

      const applied: string[] = [];
      const nextSession: string[] = [];
      const blocked: string[] = [];
      let autonomyBlocked = false;
      if (config.approval.mode !== next.approval.mode) {
        applyApprovalMode(next.approval.mode);
        applied.push(`approval.mode=${next.approval.mode}`);
      }

      if (!configValuesEqual(config.autonomy, next.autonomy)) {
        try {
          await applyAutonomy(next.autonomy);
          applied.push(`autonomy=${next.autonomy.profile}`);
        } catch (error) {
          autonomyBlocked = true;
          blocked.push(
            `autonomy: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      const reviewerChanged =
        config.approval.reviewer !== next.approval.reviewer ||
        config.approval.reviewer_model !== next.approval.reviewer_model ||
        config.approval.reviewer_timeout_ms !==
          next.approval.reviewer_timeout_ms;

      const pluginsChanged = !configValuesEqual(config.plugins, next.plugins);
      if (pluginsChanged) {
        config.plugins.enabled = next.plugins.enabled;
        applied.push(`plugins.enabled=${next.plugins.enabled}`);
      }

      if (!configValuesEqual(config.sandbox, next.sandbox)) {
        config.sandbox = structuredClone(next.sandbox);
      }
      if (!configValuesEqual(config.filesystem, next.filesystem)) {
        config.filesystem = structuredClone(next.filesystem);
      }

      for (const section of changedSections) {
        if (section === "approval") {
          if (reviewerChanged) {
            nextSession.push("approval.reviewer");
          }
          continue;
        }
        if (section === "autonomy") {
          if (autonomyBlocked) {
            nextSession.push("autonomy");
          }
          continue;
        }
        if (section === "plugins") {
          continue;
        }
        nextSession.push(section);
      }

      return {
        changed: true,
        changedSections,
        applied,
        nextSession,
        blocked,
        warnings: [...loaded.warnings],
        pluginsChanged,
      };
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
    async reloadSkills() {
      if (host.session.isStreaming) {
        throw new Error(
          "Wait for the current response to finish before reloading.",
        );
      }
      if (host.session.isCompacting) {
        throw new Error("Wait for compaction to finish before reloading.");
      }
      const previous = skillState.current;
      let next: SkillBundle;
      try {
        next = disableSkills
          ? { skills: [], block: "", warnings: [] }
          : await loadSkills({
              deliveryRoot: paths.deliveryRoot,
              codepunkHome: paths.home,
              projectTrusted: workspaceTrust.grants.skills,
            });
      } catch (error) {
        return {
          skipped: disableSkills ? ("disabled" as const) : null,
          skills: previous.skills,
          blockSha256: sha256Text(previous.block),
          warnings: previous.warnings,
          error: `skill discovery failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      const previousReadable = [...readableSkillFiles];
      try {
        host.replaceExtraInstruction(next.block);
        readableSkillFiles.splice(
          0,
          readableSkillFiles.length,
          ...next.skills.map((skill) => skill.path),
        );
        await host.session.reload();
      } catch (error) {
        host.replaceExtraInstruction(previous.block);
        readableSkillFiles.splice(
          0,
          readableSkillFiles.length,
          ...previousReadable,
        );
        await host.session.reload().catch(() => undefined);
        return {
          skipped: disableSkills ? ("disabled" as const) : null,
          skills: previous.skills,
          blockSha256: sha256Text(previous.block),
          warnings: previous.warnings,
          error: `Pi skill reload failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      skillState.current = next;
      const blockSha256 = sha256Text(next.block);
      let error: string | null = null;
      try {
        await host.recordEvent("skill/loaded", {
          skills: next.skills.map((skill) => ({
            name: skill.name,
            scope: skill.scope,
            sha256: skill.sha256,
            bytes: skill.bytes,
          })),
          block_sha256: blockSha256,
        });
      } catch (recordError) {
        error = `skill/loaded event failed: ${
          recordError instanceof Error
            ? recordError.message
            : String(recordError)
        }`;
      }
      return {
        skipped: disableSkills ? ("disabled" as const) : null,
        skills: next.skills,
        blockSha256,
        warnings: next.warnings,
        error,
      };
    },
    async reloadPlugins() {
      if (host.session.isStreaming) {
        throw new Error(
          "Wait for the current response to finish before reloading.",
        );
      }
      if (host.session.isCompacting) {
        throw new Error("Wait for compaction to finish before reloading.");
      }
      const skipped: PluginReloadResult["skipped"] = disablePlugins
        ? "disabled"
        : autonomy.profile === "read-only"
          ? "read-only"
          : options.headless === true
            ? "headless"
            : !(options.allowPlugins === true || config.plugins.enabled)
              ? "disabled"
              : null;
      if (skipped !== null) {
        const disabled = await loadUserPlugins({
          allowed: false,
          extensionDir: path.join(paths.home, "extensions"),
        });
        pluginState.current = disabled;
        host.replaceExtensionPaths([]);
        await host.session.reload();
        host.validateToolRegistry();
        return { skipped, plugins: disabled.summary, error: null };
      }

      const previous = pluginState.current;
      let next: PluginLoadResult;
      try {
        next = await loadUserPlugins({
          allowed: true,
          extensionDir: path.join(paths.home, "extensions"),
        });
        host.replaceExtensionPaths(next.paths);
        await host.session.reload();
        host.validateToolRegistry();
      } catch (error) {
        host.replaceExtensionPaths(previous.paths);
        await host.session.reload().catch(() => undefined);
        try {
          host.validateToolRegistry();
        } catch {
          // Preserve the reload error; the next model turn will fail closed if
          // the previous registry could not be restored.
        }
        return {
          skipped: null,
          plugins: previous.summary,
          error: `plugin reload failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }

      pluginState.current = next;
      const error =
        next.summary.errors.length === 0
          ? null
          : next.summary.errors.join("; ");
      return { skipped: null, plugins: next.summary, error };
    },
    async reloadMcp() {
      if (host.session.isStreaming) {
        throw new Error(
          "Wait for the current response to finish before reloading.",
        );
      }
      if (host.session.isCompacting) {
        throw new Error("Wait for compaction to finish before reloading.");
      }
      const previous = mcp;
      const previousTools = [...previous.tools, ...previous.resourceTools];
      const sessionModel = host.session.model;
      const hasModel =
        runtime.primaryModel !== undefined ||
        (sessionModel !== undefined && !isFallbackModel(sessionModel));
      const skipped: McpReloadSkip | null = disableMcp
        ? "disabled"
        : !hasModel
          ? "no-model"
          : autonomy.profile === "read-only"
            ? "read-only"
            : null;
      const warnings: string[] = [];
      const starts: McpServerStart[] = [];
      let next: McpBundle | null = null;
      let error: string | null = null;

      if (skipped !== null) {
        next = emptyMcpBundle();
      } else {
        try {
          next = await loadMcpTools({
            paths,
            strict: false,
            onServerStart: (start) => {
              starts.push(start);
            },
          });
        } catch (loadError) {
          error = `MCP configuration could not be loaded: ${
            loadError instanceof Error ? loadError.message : String(loadError)
          }`;
        }
      }

      let applied = false;
      if (next !== null) {
        try {
          await host.replaceExtraTools([...next.tools, ...next.resourceTools]);
          applied = true;
        } catch (replaceError) {
          error = `MCP tools could not be registered: ${
            replaceError instanceof Error
              ? replaceError.message
              : String(replaceError)
          }`;
          await next.close().catch(() => undefined);
          next = null;
        }
      }

      try {
        await host.session.reload();
      } catch (reloadError) {
        const message =
          reloadError instanceof Error
            ? reloadError.message
            : String(reloadError);
        error =
          error === null
            ? `Pi reload failed: ${message}`
            : `${error}; Pi reload failed: ${message}`;
        if (applied && next !== null) {
          try {
            await host.replaceExtraTools(previousTools);
          } catch {
            // The Pi registry may already have been rebuilt. Keep the
            // original error; the caller is told to restart the process.
          }
          applied = false;
        }
      }

      if (next === null || !applied) {
        if (next !== null) {
          await next.close().catch(() => undefined);
        }
        return {
          skipped: null,
          servers: [...previous.servers],
          toolCounts: { ...previous.toolCounts },
          resourceServers: [...previous.resourceServers],
          failures: [...previous.failures],
          warnings,
          error: error ?? "MCP reload did not apply",
        };
      }

      mcp = next;
      try {
        await previous.close();
      } catch (closeError) {
        warnings.push(
          `previous MCP servers could not be closed: ${
            closeError instanceof Error
              ? closeError.message
              : String(closeError)
          }`,
        );
      }
      for (const start of starts) {
        await host.recordEvent("mcp/server_start", start);
      }
      return {
        skipped,
        servers: [...next.servers],
        toolCounts: { ...next.toolCounts },
        resourceServers: [...next.resourceServers],
        failures: [...next.failures],
        warnings,
        error,
      };
    },
    async dispose() {
      runtimeDisposed = true;
      let hookFailure: unknown = null;
      const sandboxClosed = closePendingSandbox();
      try {
        await hooks.run(
          "session_end",
          {
            session_id: session.sessionId,
            cwd: paths.cwd,
            project_id: paths.projectId,
          },
          appendHookEvidence,
        );
      } catch (error) {
        hookFailure = error;
      }
      await mcp.close();
      autonomy.revoke();
      await host
        .recordEvent("autonomy/revoked", {
          profile: autonomy.profile,
          reason: "session_end",
        })
        .catch(() => undefined);
      await host.dispose();
      await sandboxClosed;
      if (hookFailure !== null) {
        throw hookFailure;
      }
    },
  };
  return runtime;
}
