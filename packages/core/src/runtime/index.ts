import { promises as fs } from "node:fs";
import path from "node:path";
import { type HookEvidence } from "codepunk-protocol";
import { createPiHost, type PiHost } from "../adapters/pi/index.ts";
import { ApprovalBroker } from "../approval/index.ts";
import {
  AutonomyController,
  type AutonomyRegistration,
  type ScopedRule,
} from "../autonomy/index.ts";
import { HookRunner } from "../capabilities/hooks.ts";
import { CheckpointStore, ShadowGitStore } from "../checkpoints/index.ts";
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
import {
  loadIsolatedPluginBundle,
  type IsolatedPluginBundle,
} from "../plugin/runtime-bridge.ts";
import { initializeStateVersion } from "../retention/lifecycle.ts";
import {
  DeferredActionReviewer,
  resolveActionReviewer,
  type ActionReviewer,
} from "../reviewer/index.ts";
import { resolveWindowsShell } from "../sandbox/index.ts";
import { isBenignTailEventKind } from "../session/index.ts";
import { loadSkills, type SkillBundle } from "../skills/index.ts";
import {
  resolveWorkspaceTrust,
  skippedProjectResources,
} from "../trust/index.ts";
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
  closePendingSandboxForStartupFailure,
  effectiveTools,
  openSession,
  pathsHome,
  sessionSelectorIssue,
  signStandalone,
  verifyHeadlessExec,
} from "./helpers.ts";
import { createRuntimeReloaders } from "./reloaders.ts";
import { initializeRuntimeSandbox } from "./sandbox-setup.ts";
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
  const startupCleanup: { current: (() => Promise<void>) | null } = {
    current: null,
  };
  const resourceCleanups: Array<() => Promise<void>> = [];
  try {
    return await createRuntimeInner(options, startupCleanup, resourceCleanups);
  } catch (error) {
    for (const cleanup of [...resourceCleanups].reverse()) {
      await cleanup().catch(() => undefined);
    }
    await closePendingSandboxForStartupFailure(startupCleanup);
    throw error;
  }
}

async function createRuntimeInner(
  options: RuntimeOptions,
  startupCleanup: { current: (() => Promise<void>) | null },
  resourceCleanups: Array<() => Promise<void>>,
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
  await initializeStateVersion(paths.home);
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
  const projectMcpFiles = await findProjectMcpConfigs(paths);
  if (!workspaceTrust.grants.config) {
    for (const projectMcpConfig of projectMcpFiles) {
      loadedConfig.warnings.push(
        `project MCP configuration ${relativeDisplayPath(
          paths.deliveryRoot,
          projectMcpConfig,
        )} skipped because workspace config is not trusted`,
      );
    }
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
  const plugins = await loadIsolatedPluginBundle({
    allowed: pluginsAllowed,
    extensionDir: path.join(paths.home, "extensions"),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const pluginState: { current: IsolatedPluginBundle } = { current: plugins };
  resourceCleanups.push(async () => {
    await pluginState.current.close();
  });
  for (const warning of plugins.summary.warnings) {
    loadedConfig.warnings.push(warning);
  }
  for (const error of plugins.summary.errors) {
    loadedConfig.warnings.push(`plugin skipped: ${error}`);
  }
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

  const initialRunId =
    options.runId ?? createUlid(options.now?.() ?? new Date());
  const hostRef: { current: PiHost | null } = { current: null };
  const appendHookEvidence = async (evidence: HookEvidence): Promise<void> => {
    if (hostRef.current === null) {
      throw new Error("hook evidence cannot be written before the host exists");
    }
    await hostRef.current.recordEvent("hook/result", evidence);
  };

  const sandboxSetup = initializeRuntimeSandbox({
    options,
    paths,
    config,
    loadedConfig,
    windowsShell,
    writeSetWithAdditionalRoots,
    hostRef,
    getInitialRunId: () => initialRunId,
    startupCleanup,
  });

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
        await pluginState.current.close().catch(() => undefined);
        throw error;
      }
      loadedConfig.warnings.push(error.message);
    }
  }
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
              mode: config.approval.reviewer,
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
  const shadowGit = new ShadowGitStore({
    sessionDir: session.paths.sessionDir,
    workspaceRoot: paths.deliveryRoot,
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
  const userMcpExists = await fs
    .access(path.join(paths.home, "mcp.toml"))
    .then(() => true)
    .catch(() => false);
  const hasMcpConfig =
    userMcpExists ||
    (workspaceTrust.grants.config && projectMcpFiles.length > 0);
  const projectMcpTrusted = workspaceTrust.grants.config;
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
        projectTrusted: projectMcpTrusted,
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
    resourceCleanups.push(async () => {
      await mcp.close();
    });
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
    sandboxSetup.getSandbox(),
    memory,
    options.headless === true,
    headlessPolicy,
  );
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
      sandbox: () => {
        if (sandboxSetup.getShellPreflightIssue() !== null) {
          return null;
        }
        if (
          sandboxSetup.isDegradedUnsandboxedFallback() &&
          !sandboxSetup.canFallbackToHumanApprovedShell()
        ) {
          return null;
        }
        return sandboxSetup.pendingSandboxProvider();
      },
      forceShellApproval: () => sandboxSetup.isDegradedUnsandboxedFallback(),
      userBashUnsandboxed: () =>
        options.headless !== true && config.sandbox.user_bash === "uncovered",
      closeSandbox: false,
      approvalMode: () => config.approval.mode,
      planMode: () => readPlanModeState(session.allEvents),
      currentPlan: () => readWorkState(session.allEvents).plan,
      networkAllowedDomains: config.sandbox.network_allow,
      networkDeniedDomains: config.sandbox.network_deny,
      shellUnavailableReason: () => {
        const issue = sandboxSetup.getShellPreflightIssue();
        return issue === null
          ? shellUnavailableReason(sessionSandboxMode)
          : `${shellUnavailableReason(sessionSandboxMode)} (${issue})`;
      },
      context: configuredContext,
      artifactsDir: paths.artifactsDir,
      checkpoints,
      shadowGit,
      projectTrusted: () => workspaceTrust.grants.config,
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
      extensionPaths: plugins.legacyExtensionPaths,
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
      extraTools: [...mcp.tools, ...mcp.resourceTools, ...plugins.tools],
      ...(options.questionChannel !== undefined
        ? { questionChannel: options.questionChannel }
        : {}),
      ...(options.subagentExecutor !== undefined
        ? { subagentExecutor: options.subagentExecutor }
        : {}),
      ...(skills.block.length > 0 ? { extraInstruction: skills.block } : {}),
    });
    resourceCleanups.push(async () => {
      await host.dispose();
    });
  } catch (error) {
    throw error;
  }

  hostRef.current = host;
  const wirePluginBundle = async (
    bundle: IsolatedPluginBundle,
  ): Promise<void> => {
    bundle.bindProductToolExecutor((input) =>
      host.executeProductToolAsPlugin(input),
    );
    await bundle.flushLifecycleEvents(async (kind, data) => {
      await host.recordEvent(kind, data).catch(() => undefined);
    });
  };
  await wirePluginBundle(pluginState.current);

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
    await pluginState.current.close().catch(() => undefined);
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
          projectTrusted: projectMcpTrusted,
          strict: false,
          onServerStart: (start) => {
            deferredStarts.push(start);
          },
        });
        if (runtimeDisposed) {
          await next.close().catch(() => undefined);
          return;
        }
        const hasNewTools =
          next.tools.length > 0 || next.resourceTools.length > 0;
        if (hasNewTools) {
          const executeReload = async (): Promise<void> => {
            if (runtimeDisposed) {
              return;
            }
            if (host.session.isStreaming || host.session.isCompacting) {
              await host.session.waitForIdle().catch(() => undefined);
            }
            if (runtimeDisposed) {
              return;
            }
            await host.replaceExtraTools([
              ...next.tools,
              ...next.resourceTools,
              ...pluginState.current.tools,
            ]);
            await host.session.reload();
          };
          if (options.runDeferredMcpReload !== undefined) {
            await options.runDeferredMcpReload(executeReload);
          } else {
            await executeReload();
          }
        }
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
    const activeSandbox = sandboxSetup.getSandbox();
    if (next.profile === "read-only") {
      const issue = readOnlyLiveSwitchIssue({
        pluginsEnabled: pluginState.current.summary.enabled,
        mcpServers: mcp.servers,
        sandboxStartedWritable: activeSandbox?.sandboxed === true && !readOnly,
      });
      if (issue !== null) {
        throw new Error(issue);
      }
    } else if (autonomy.profile === "read-only") {
      const issue = readOnlyLiveWidenIssue({
        target: next.profile,
        sandboxStartedReadOnly: activeSandbox?.sandboxed === true && readOnly,
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
      const readOnlyTools = host.session
        .getAllTools()
        .map((tool) => tool.name)
        .filter(isPlanModeReadOnlyTool);
      host.session.setActiveToolsByName(readOnlyTools);
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
    const planState = {
      mode,
      plan_sha256: planSha256,
      updated_at: (options.now?.() ?? new Date()).toISOString(),
    };
    await session.append("plan_mode/update", planState);
    applyPlanModeToolSurface(mode);
    return planState;
  };
  const currentPlanMode = readPlanModeState(session.allEvents);
  if (currentPlanMode?.mode === "planning") {
    applyPlanModeToolSurface("planning");
  }

  const primaryModel =
    host.primaryModel ??
    (host.session.model !== undefined && !isFallbackModel(host.session.model)
      ? host.session.model
      : undefined);

  const reloaders = createRuntimeReloaders({
    options,
    paths,
    environment,
    config,
    configOverrides,
    workspaceTrust,
    host,
    session,
    ledger,
    autonomy,
    disableSkills,
    disablePlugins,
    disableMcp,
    projectMcpTrusted,
    readableSkillFiles,
    skillState,
    pluginState,
    getMcp: () => mcp,
    setMcp: (next) => {
      mcp = next;
    },
    getPrimaryModel: () => primaryModel,
    applyApprovalMode,
    applyAutonomy,
    wirePluginBundle,
  });

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
    shadowGit,
    ledger,
    get sandbox() {
      return sandboxSetup.getSandbox();
    },
    sandboxReady: sandboxSetup.runtimeSandboxReady,
    async shellPreflightSettled() {
      await sandboxSetup.shellPreflightSettled;
    },
    get shellPreflightIssue() {
      return sandboxSetup.getShellPreflightIssue();
    },
    autonomy,
    approval,
    host,
    primaryModel,
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
    ...reloaders,
    async dispose() {
      runtimeDisposed = true;
      let hookFailure: unknown = null;
      const sandboxClosed = sandboxSetup.closePendingSandbox();
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
      await pluginState.current.close().catch(() => undefined);
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
