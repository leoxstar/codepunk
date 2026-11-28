import { existsSync } from "node:fs";
import path from "node:path";
import {
  isInsidePath,
  readSkillInvocation,
  resolveModelSelection,
  type CodepunkRuntime,
} from "codepunk-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { TuiState } from "../state.ts";
import { openInteractiveHelp } from "./help-action.ts";
import { selectedModel, noAuthenticatedModelsMessage } from "./model.ts";
import { refreshStatus, renderHeader } from "./statusline.ts";
import { sandboxStatusLines } from "./status.ts";
import { EditorBridge } from "./widgets.ts";
import { isSlashCommand } from "../host-commands.ts";
import {
  formatConfigReload,
  formatPluginReload,
  formatSkillReload,
} from "../format/reload.ts";
import { formatMcpReload } from "../format/status.ts";
import {
  forkCurrentSession,
  navigateSessionTree,
  resumeSession,
  startNewSession,
} from "../commands/session.ts";
import { configurePermissions } from "../commands/permission-actions.ts";
import { runCopyAction } from "../commands/copy.ts";
import { sendWorkspaceImage } from "../commands/images.ts";
import { showInteractiveSettingsMenu } from "../commands/settings.ts";
import { configureTrust } from "../commands/trust-actions.ts";
import { extractDroppedImageInput } from "../format/clipboard-image.ts";
import { refreshWelcomeWidget } from "./welcome.ts";
import { refreshWorkWidget } from "./work-widget.ts";
import {
  promptForMissingModel,
  availableModels,
  selectModelReference,
} from "../format/model.ts";
import { sessionSummary } from "../format/status-summary.ts";

function component(text: () => string, visible: () => boolean): Component {
  return {
    render: (width: number) =>
      visible()
        ? text()
            .split("\n")
            .map((line) => truncateToWidth(line, Math.max(1, width), "…"))
        : [],
    invalidate: () => {},
  };
}

async function handleShellInput(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
  trimmed: string,
): Promise<boolean> {
  if (trimmed === "!" || trimmed === "!!") {
    context.ui.notify("usage: !<command> or !!<command>", "warning");
    return true;
  }
  if (runtime.plugins.enabled) {
    context.ui.notify("! is disabled while Pi plugins are enabled", "warning");
    return true;
  }
  return false;
}

async function handleSkillInput(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
  trimmed: string,
  command: string,
): Promise<boolean> {
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

async function handleModelInput(
  state: TuiState,
  context: ExtensionContext,
  runtime: CodepunkRuntime,
  trimmed: string,
): Promise<boolean> {
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
  return false;
}

async function handleReloadInput(
  state: TuiState,
  runtime: CodepunkRuntime,
  trimmed: string,
): Promise<boolean> {
  if (trimmed !== "/reload") {
    state.context?.ui.notify("usage: /reload", "warning");
    return true;
  }
  try {
    const previousPluginsEnabled = runtime.config.plugins.enabled;
    const configReload = await runtime.reloadConfig();
    const plugins = await runtime.reloadPlugins();
    const pluginRolledBack =
      configReload.pluginsChanged && plugins.error !== null;
    if (pluginRolledBack) {
      runtime.config.plugins.enabled = previousPluginsEnabled;
    }
    const reportedConfig = pluginRolledBack
      ? {
          ...configReload,
          applied: configReload.applied.filter(
            (entry) => !entry.startsWith("plugins.enabled="),
          ),
          pluginsChanged: false,
          blocked: [
            ...configReload.blocked,
            "plugins.enabled: reload failed, so the previous setting was restored",
          ],
        }
      : configReload;
    const skills = await runtime.reloadSkills();
    const result = await runtime.reloadMcp();
    const failed =
      result.error !== null || skills.error !== null || plugins.error !== null;
    state.context?.ui.notify(
      `${formatConfigReload(reportedConfig)}\n${formatPluginReload(plugins)}\n${formatSkillReload(skills)}\n${formatMcpReload(result)}`,
      failed
        ? "error"
        : reportedConfig.blocked.length > 0 ||
            reportedConfig.warnings.length > 0
          ? "warning"
          : "info",
    );
  } catch (error) {
    state.context?.ui.notify(
      `Reload failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
  return true;
}

async function handleSessionSlashCommand(
  state: TuiState,
  context: ExtensionContext,
  runtime: CodepunkRuntime,
  trimmed: string,
): Promise<boolean | null> {
  if (trimmed === "/resume" || trimmed.startsWith("/resume ")) {
    await resumeSession(state, context, trimmed.slice("/resume".length).trim());
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
  return null;
}

async function handleConfigSlashCommand(
  state: TuiState,
  context: ExtensionContext,
  runtime: CodepunkRuntime,
  trimmed: string,
): Promise<boolean | null> {
  if (trimmed === "/model" || trimmed.startsWith("/model ")) {
    return await handleModelInput(state, context, runtime, trimmed);
  }
  if (isSlashCommand(trimmed, "/help")) {
    const query = trimmed.slice("/help".length).trim();
    await openInteractiveHelp(state, context, query);
    return true;
  }
  if (
    isSlashCommand(trimmed, "/settings") ||
    isSlashCommand(trimmed, "/config")
  ) {
    const argument = trimmed.replace(/^\/(?:settings|config)/u, "").trim();
    await showInteractiveSettingsMenu(state, context, argument);
    return true;
  }
  if (isSlashCommand(trimmed, "/scoped-models")) {
    context.ui.notify(
      [
        "Model scope is file-backed in codepunk.",
        `Set model.enabled in ${runtime.paths.home}/config.toml, for example:`,
        '  enabled = ["gateway/primary-model", "openai/gpt-5"]',
        "The built-in selector only changes in-memory host state in this build, so codepunk does not open it.",
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
  if (trimmed === "/permissions" || trimmed.startsWith("/permissions ")) {
    const slash = trimmed.indexOf(" ");
    await configurePermissions(
      state,
      context,
      slash < 0 ? "" : trimmed.slice(slash + 1).trim(),
    );
    return true;
  }
  return null;
}

async function handlePiSlashCommand(
  state: TuiState,
  context: ExtensionContext,
  runtime: CodepunkRuntime,
  trimmed: string,
): Promise<boolean | null> {
  if (isSlashCommand(trimmed, "/import")) {
    context.ui.notify(
      [
        "External session import is not supported in codepunk.",
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
        "The built-in /bug flow can upload a session transcript to an external service.",
        "Codepunk keeps session data local; use /cp-export for a redacted transcript.",
        "Attach that export manually if you need to report a Codepunk defect.",
      ].join("\n"),
      "warning",
    );
    return true;
  }
  if (isSlashCommand(trimmed, "/copy")) {
    await runCopyAction(runtime, context, trimmed.slice("/copy".length).trim());
    return true;
  }
  if (isSlashCommand(trimmed, "/reload")) {
    return await handleReloadInput(state, runtime, trimmed);
  }
  if (isSlashCommand(trimmed, "/fork") || isSlashCommand(trimmed, "/clone")) {
    await forkCurrentSession(
      state,
      context,
      trimmed.split(/\s+/u).slice(1).join(" ").trim(),
    );
    return true;
  }
  if (trimmed === "/tree") {
    return false;
  }
  if (trimmed.startsWith("/tree ")) {
    await navigateSessionTree(
      state,
      context,
      trimmed.slice("/tree".length).trim(),
    );
    return true;
  }
  return null;
}

async function handleEditorInput(
  state: TuiState,
  text: string,
): Promise<boolean> {
  if (
    state.transitionPromise !== null &&
    state.transitionPromise !== undefined
  ) {
    await state.transitionPromise.catch(() => undefined);
  }
  const activeRuntime = state.runtime;
  const activeContext = state.context;
  if (activeRuntime === null || activeContext === null) {
    return true;
  }
  const trimmed = text.trim();
  const command = trimmed.split(/\s+/u)[0] ?? "";
  if (trimmed.startsWith("!")) {
    return await handleShellInput(activeRuntime, activeContext, trimmed);
  }
  if (command.startsWith("/skill:")) {
    return await handleSkillInput(
      activeRuntime,
      activeContext,
      trimmed,
      command,
    );
  }
  const sessionResult = await handleSessionSlashCommand(
    state,
    activeContext,
    activeRuntime,
    trimmed,
  );
  if (sessionResult !== null) {
    return sessionResult;
  }
  const configResult = await handleConfigSlashCommand(
    state,
    activeContext,
    activeRuntime,
    trimmed,
  );
  if (configResult !== null) {
    return configResult;
  }
  const piResult = await handlePiSlashCommand(
    state,
    activeContext,
    activeRuntime,
    trimmed,
  );
  if (piResult !== null) {
    return piResult;
  }
  const droppedImage = extractDroppedImageInput(trimmed);
  if (droppedImage !== null) {
    const resolvedImage = path.resolve(
      activeRuntime.paths.cwd,
      droppedImage.rawPath,
    );
    if (existsSync(resolvedImage)) {
      if (!state.modelSelected) {
        await promptForMissingModel(state, activeContext);
        return true;
      }
      if (!isInsidePath(activeRuntime.paths.deliveryRoot, resolvedImage)) {
        activeContext.ui.notify(
          "Dropped image is outside this workspace; copy it into the project or use `/image --clipboard`.",
          "warning",
        );
        return true;
      }
      await sendWorkspaceImage(
        activeRuntime,
        activeContext,
        resolvedImage,
        droppedImage.prompt,
      );
      return true;
    }
  }
  if (trimmed.startsWith("/")) {
    const commandName = trimmed.slice(1).split(/\s+/u)[0] ?? "";
    if (!state.hostCommands.has(commandName)) {
      activeContext.ui.notify(
        [
          `Unknown command /${commandName}.`,
          "Type /help for the available Codepunk commands.",
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
    await promptForMissingModel(state, activeContext);
    return true;
  }
  return false;
}

export function setupChrome(state: TuiState, context: ExtensionContext): void {
  const runtime = state.runtime;
  if (runtime === null) {
    return;
  }
  const tui = runtime.config.tui;
  const title = ["codepunk", `session ${runtime.session.sessionId}`];
  context.ui.setTitle(title.join(" · "));
  context.ui.setHeader((_tui, theme) => ({
    render: (width: number) =>
      tui.header
        ? renderHeader(state, {
            theme:
              process.env["NO_COLOR"] !== undefined &&
              process.env["NO_COLOR"].length > 0
                ? undefined
                : theme,
            width,
          })
            .split("\n")
            .map((line) => truncateToWidth(line, Math.max(1, width), "…"))
        : [],
    invalidate: () => {},
  }));
  if (tui.footer) {
    context.ui.setFooter(undefined);
  } else {
    context.ui.setFooter(() =>
      component(
        () => "",
        () => false,
      ),
    );
  }
  context.ui.setWidget(
    "model-onboarding",
    selectedModel(runtime) === undefined
      ? [
          "No model configured. The first message opens setup; run /model or /login to configure now.",
        ]
      : undefined,
  );
  if (tui.widgets) {
    context.ui.setWidget("sandbox-status", sandboxStatusLines(runtime), {
      placement: "aboveEditor",
    });
  }
  refreshStatus(state, context);
  refreshWorkWidget(state, context);
  refreshWelcomeWidget(state, context);
  if (!tui.widgets) {
    context.ui.setWidget("codepunk", undefined);
  }
  context.ui.setEditorComponent(
    (tui, theme, keybindings) =>
      new EditorBridge(tui, theme, keybindings, (text) =>
        handleEditorInput(state, text),
      ),
  );
}
