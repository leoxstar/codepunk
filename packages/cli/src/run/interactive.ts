import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createRuntime,
  findDeliveryRoot,
  projectPaths,
  type CodepunkRuntime,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { preparedConfigOverrides } from "../args/overrides.ts";
import { formatBuildLabel, inspectCliBuild } from "../build-info.ts";
import { registerFatalCleanup } from "../crash-guard.ts";
import { CodepunkTerminal } from "../branded-terminal.ts";
import { ResumeHint } from "../exit-hint.ts";
import type {
  TuiRuntimeReplacement,
  TuiSessionTarget,
  TuiState,
} from "../tui/state.ts";
import { prepareFork, sessionSelector } from "./project.ts";
import {
  resolveRunWorkspaceTrust,
  trustRuntimeOptions,
} from "./trust-prompt.ts";

type RuntimeOptions = Parameters<typeof createRuntime>[0];
type ExtensionFactory = NonNullable<
  RuntimeOptions["additionalExtensionFactories"]
>[number];
type ApprovalChannel = NonNullable<RuntimeOptions["approvalChannel"]>;
type QuestionChannel = NonNullable<RuntimeOptions["questionChannel"]>;
type SubagentExecutor = NonNullable<RuntimeOptions["subagentExecutor"]>;
type WorkspaceTrust = Awaited<ReturnType<typeof resolveRunWorkspaceTrust>>;
type ConfigOverrides = NonNullable<RuntimeOptions["configOverrides"]>;

export async function makeSessionRuntime(
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
            runtime.host.services.resourceLoader.getExtensions(),
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
        extensionsResult: next.host.services.resourceLoader.getExtensions(),
      };
    },
    {
      cwd: initialCwd,
      agentDir: initialAgentDir,
      sessionManager: initialSessionManager,
    },
  );
}

async function loadTuiModules() {
  return await Promise.all([
    import("@earendil-works/pi-tui"),
    import("../tui.ts"),
    import("../branded-interactive.ts"),
  ]);
}

type TuiModule = Awaited<ReturnType<typeof loadTuiModules>>[1];

interface TuiRuntimeBuilderContext {
  options: CliOptions;
  extension: ExtensionFactory;
  channel: ApprovalChannel;
  questionChannel: QuestionChannel;
  subagentExecutor: SubagentExecutor;
  workspaceTrust: WorkspaceTrust;
  overrides: ConfigOverrides;
}

interface TuiRuntimeSelection {
  sessionId?: string;
  sessionPath?: string;
  newSession?: boolean;
  continueSession?: boolean;
  newSessionId?: string;
  parentSessionId?: string;
}

function createRuntimeBuilder(
  context: TuiRuntimeBuilderContext,
): (selection: TuiRuntimeSelection) => Promise<CodepunkRuntime> {
  const {
    options,
    extension,
    channel,
    questionChannel,
    subagentExecutor,
    workspaceTrust,
    overrides,
  } = context;
  return async (selection) =>
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
      questionChannel,
      subagentExecutor,
      allowUnsandboxedShell:
        options.allowUnsandboxedShell || options.dangerouslyBypass,
      allowFullFilesystem: options.dangerouslyBypass,
      allowMissingModel: true,
      bindMode: "tui",
      allowPlugins: options.allowPlugins,
      disableMcp: options.noMcp,
      deferMcp: true,
      disableSkills: options.noSkills,
      disablePlugins: options.noPlugins,
      bare: options.bare,
      additionalExtensionFactories: [extension],
      ...trustRuntimeOptions(workspaceTrust),
    });
}

function installRuntimeReplacement(
  state: TuiState,
  sessionRuntime: Awaited<ReturnType<typeof makeSessionRuntime>>,
  slot: { current: CodepunkRuntime | null },
  switchState: { target: TuiSessionTarget | null },
  applyReplacedRuntime: (
    state: TuiState,
    runtime: CodepunkRuntime,
    context: ExtensionCommandContext,
  ) => void,
): void {
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
      if (replacementContext === null || slot.current === null) {
        throw new Error("session switch did not produce a runtime");
      }
      const replacement: TuiRuntimeReplacement = {
        runtime: slot.current,
        context: replacementContext,
      };
      applyReplacedRuntime(state, replacement.runtime, replacement.context);
      return replacement;
    } catch (error) {
      switchState.target = null;
      if (slot.current !== null) {
        state.runtime = previousRuntime;
        state.context = previousContext;
      }
      throw error;
    }
  };
}

function watchSandboxStatus(
  state: TuiState,
  runtime: CodepunkRuntime,
  tui: TuiModule,
): void {
  void (async () => {
    await runtime.sandboxReady;
    await runtime.shellPreflightSettled();
    const context = state.context;
    if (state.shuttingDown || state.runtime !== runtime || context === null) {
      return;
    }
    if (runtime.config.tui.widgets) {
      context.ui.setWidget("sandbox-status", tui.sandboxStatusLines(runtime), {
        placement: "aboveEditor",
      });
    }
    tui.refreshStatus(state, context);
    if (runtime.shellPreflightIssue !== null) {
      state.sandboxNoticeShown = true;
      context.ui.notify(
        `srt shell unavailable: ${runtime.shellPreflightIssue}. Shell tools are disabled.`,
        "warning",
      );
      return;
    }
    if (state.sandboxNoticeShown) {
      return;
    }
    const lines = tui.sandboxStatusLines(runtime);
    if (lines !== undefined) {
      state.sandboxNoticeShown = true;
      context.ui.notify(`${lines.join(". ")}.`, "warning");
    }
  })();
  void (async () => {
    await runtime.mcpReady;
    const context = state.context;
    if (state.shuttingDown || state.runtime !== runtime || context === null) {
      return;
    }
    tui.refreshStatus(state, context);
    for (const warning of runtime.mcpStartupWarnings) {
      context.ui.notify(`codepunk warning: ${warning}`, "warning");
    }
  })();
}

function startTitleAndBuildWatch(state: TuiState): () => void {
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
  let buildWatch: NodeJS.Timeout | undefined = setInterval(() => {
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
  return () => {
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
  };
}

export async function runTui(
  options: CliOptions,
  initialPrompt?: string,
): Promise<number> {
  // The interactive stack is heavy; load it only when a TUI actually starts.
  const [{ ProcessTerminal }, tui, { BrandedInteractiveMode }] =
    await loadTuiModules();
  const forkedSessionId = await prepareFork(options);
  const selector =
    forkedSessionId === undefined
      ? sessionSelector(options.session)
      : { sessionId: forkedSessionId };
  const channel = new tui.TuiApprovalChannel();
  const questionChannel = new tui.TuiQuestionChannel();
  const state: TuiState = {
    runtime: null,
    context: null,
    channel,
    questionChannel,
    lastRunId: null,
    lastEvidence: 0,
    warningsShown: false,
    sandboxNoticeShown: false,
    modelSelected: false,
    ready: false,
    shuttingDown: false,
    hostCommands: new Set(),
    childHostArgv: [process.execPath, fileURLToPath(import.meta.url)],
    resumeHint: new ResumeHint(),
  };
  const subagentExecutor = tui.createTuiSubagentExecutor(state);
  // Pi's quit path ends in process.exit, so the hint is written from an exit
  // listener once the shutdown handler has armed it.
  state.resumeHint?.installOnExit();
  const extension = tui.createTuiExtension(state, channel);
  const project = await findDeliveryRoot(process.cwd());
  const workspaceTrust = await resolveRunWorkspaceTrust(options, project, true);
  const overrides = await preparedConfigOverrides(
    options,
    projectPaths(project),
  );
  const buildTuiRuntime = createRuntimeBuilder({
    options,
    extension,
    channel,
    questionChannel,
    subagentExecutor,
    workspaceTrust,
    overrides,
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
  tui.setTuiRuntime(state, runtime);
  const slot: { current: CodepunkRuntime | null } = { current: runtime };
  const switchState: { target: TuiSessionTarget | null } = { target: null };
  let stopWatch = () => {
    state.shuttingDown = true;
  };
  const unregisterCrashCleanup = registerFatalCleanup(async () => {
    stopWatch();
    await tui.stopRunningSubagents(state).catch(() => undefined);
    await slot.current?.dispose().catch(() => undefined);
  });
  try {
    const sessionRuntime = await makeSessionRuntime(runtime, {
      switchState,
      async disposeCurrent() {
        const current = slot.current;
        slot.current = null;
        if (current !== null) {
          await current.dispose();
        }
      },
      async createRuntime(target) {
        const next = await buildTuiRuntime(target);
        slot.current = next;
        state.runtime = next;
        return next;
      },
    });
    installRuntimeReplacement(
      state,
      sessionRuntime,
      slot,
      switchState,
      (replacedState, replacedRuntime, replacedContext) => {
        tui.applyReplacedRuntime(
          replacedState,
          replacedRuntime,
          replacedContext,
        );
        watchSandboxStatus(replacedState, replacedRuntime, tui);
      },
    );
    const modelFallbackMessage =
      tui.modelOnboardingMessage(runtime) ??
      sessionRuntime.modelFallbackMessage;
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
    const trimmedInitialPrompt = initialPrompt?.trim();
    const hasConfiguredModel = state.modelSelected;
    if (
      trimmedInitialPrompt !== undefined &&
      trimmedInitialPrompt.length > 0 &&
      !hasConfiguredModel
    ) {
      state.pendingInitialPrompt = trimmedInitialPrompt;
    }
    const interactive = new BrandedInteractiveMode(sessionRuntime, {
      terminal: new CodepunkTerminal(new ProcessTerminal()),
      startupDiagnostics,
      ...(modelFallbackMessage === undefined ? {} : { modelFallbackMessage }),
      ...(trimmedInitialPrompt !== undefined &&
      trimmedInitialPrompt.length > 0 &&
      hasConfiguredModel
        ? { initialMessage: trimmedInitialPrompt }
        : {}),
    });
    await interactive.init();
    watchSandboxStatus(state, runtime, tui);
    stopWatch = startTitleAndBuildWatch(state);
    await interactive.run();
    return 0;
  } finally {
    unregisterCrashCleanup();
    stopWatch();
    await tui.stopRunningSubagents(state);
    await slot.current?.dispose();
  }
}
