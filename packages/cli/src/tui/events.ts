import {
  filterInterceptedAutocomplete,
  loadPiBuiltinSlashCommands,
} from "./host-commands.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelSelectEvent,
  SessionShutdownEvent,
  ThinkingLevelSelectEvent,
} from "@earendil-works/pi-coding-agent";
import { isFallbackModel, writeUserThinkingSelection } from "codepunk-core";
import { recordRecentModel } from "../model-history.ts";
import { physicalModel } from "./chrome/model.ts";
import { refreshStatus } from "./chrome/statusline.ts";
import { refreshWorkWidget } from "./chrome/work-widget.ts";
import { modelReference } from "./format/model.ts";
import { persistPiDefaultModel } from "./model.ts";
import { setupChrome } from "./chrome/setup.ts";
import { stopRunningSubagents } from "./format/subagents.ts";
import type { TuiApprovalChannel } from "./approval/channel.ts";
import type { TuiState } from "./state.ts";

async function handleSessionStart(
  pi: Pick<ExtensionAPI, "on" | "getCommands">,
  state: TuiState,
  channel: TuiApprovalChannel,
  context: ExtensionContext,
): Promise<void> {
  state.context = context;
  state.ready = true;
  state.hostCommands = new Set([
    ...(await loadPiBuiltinSlashCommands()).map((command) => command.name),
    ...pi.getCommands().map((command) => command.name),
  ]);
  channel.attach(context);
  state.questionChannel?.attach(context);
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
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
        false
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
}

async function handleModelSelect(
  state: TuiState,
  event: ModelSelectEvent,
  context: ExtensionContext,
): Promise<void> {
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
  try {
    await recordRecentModel(runtime.paths.home, modelReference(event.model));
  } catch (error) {
    context.ui.notify(
      `recent model could not be saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "warning",
    );
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
  await persistPiDefaultModel(runtime, (message, level) =>
    context.ui.notify(message, level),
  );
  setupChrome(state, context);
}

async function handleThinkingLevelSelect(
  state: TuiState,
  event: ThinkingLevelSelectEvent,
  context: ExtensionContext,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    return;
  }
  runtime.config.model.thinking = event.level;
  try {
    await writeUserThinkingSelection(runtime.paths, event.level);
    refreshStatus(state, context);
  } catch (error) {
    context.ui.notify(
      `thinking changed for this session; config was not saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "warning",
    );
  }
}

async function handleAgentStart(
  state: TuiState,
  context: ExtensionContext,
): Promise<void> {
  state.lastRunId = state.runtime?.host.currentRunId ?? null;
  context.ui.setTitle(
    `codepunk · session ${state.runtime?.session.sessionId ?? "starting"}`,
  );
  refreshWorkWidget(state, context);
  refreshStatus(state, context);
}

async function handleAgentSettled(
  state: TuiState,
  context: ExtensionContext,
): Promise<void> {
  context.ui.setTitle(
    `codepunk · session ${state.runtime?.session.sessionId ?? "starting"}`,
  );
  state.lastEvidence = state.runtime?.ledger.all.length ?? state.lastEvidence;
  refreshWorkWidget(state, context);
  refreshStatus(state, context);
}

async function handleSessionShutdown(
  state: TuiState,
  event: SessionShutdownEvent,
): Promise<void> {
  for (const timer of state.titleTimers ?? []) {
    clearTimeout(timer);
  }
  state.titleTimers = [];
  if (state.buildWatch !== undefined) {
    clearInterval(state.buildWatch);
    state.buildWatch = undefined;
  }
  if (event.reason === "quit" && state.runtime !== null) {
    state.shuttingDown = true;
    const runtime = state.runtime;
    // Pi's quit path (/quit, Ctrl+D, double Ctrl+C, SIGTERM) calls
    // process.exit after this handler, so the caller's finally block
    // never runs. Everything a clean exit needs happens here.
    await stopRunningSubagents(state);
    await persistPiDefaultModel(runtime);
    state.resumeHint?.arm(runtime.session);
    // Release the session writer so the next codepunk process can
    // resume immediately instead of waiting for the lock lease.
    await runtime.dispose().catch(() => undefined);
  }
}

export function registerTuiEvents(
  pi: Pick<ExtensionAPI, "on" | "getCommands">,
  state: TuiState,
  channel: TuiApprovalChannel,
): void {
  pi.on("session_start", async (_event, context) => {
    await handleSessionStart(pi, state, channel, context);
  });
  pi.on("model_select", async (event, context) => {
    await handleModelSelect(state, event, context);
  });
  pi.on("thinking_level_select", async (event, context) => {
    await handleThinkingLevelSelect(state, event, context);
  });
  pi.on("agent_start", async (_event, context) => {
    await handleAgentStart(state, context);
  });
  pi.on("agent_settled", async (_event, context) => {
    await handleAgentSettled(state, context);
  });
  pi.on("session_shutdown", async (event) => {
    await handleSessionShutdown(state, event);
  });
}
