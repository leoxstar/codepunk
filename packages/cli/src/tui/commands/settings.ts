import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  writeUserThinkingSelection,
  writeUserTuiPreferences,
} from "codepunk-core";
import { setupChrome } from "../chrome/setup.ts";
import { refreshStatus } from "../chrome/statusline.ts";
import { applyTuiTheme, availableThemeChoices } from "../chrome/theme.ts";
import { refreshWelcomeWidget } from "../chrome/welcome.ts";
import { refreshWorkWidget } from "../chrome/work-widget.ts";
import { cycleWorkMode } from "../format/mode-cycle.ts";
import type { TuiState } from "../state.ts";
import { showPermissionsMenu } from "./permission-actions.ts";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

async function chooseThemeSetting(
  state: TuiState,
  context: ExtensionContext,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    return;
  }
  const choices = availableThemeChoices(context);
  const labels = choices.map(
    (choice) =>
      `${choice.id === runtime.config.tui.theme ? "\u2713" : " "} ${choice.label}`,
  );
  const picked = await context.ui.select("TUI theme", labels);
  if (picked === undefined) {
    return;
  }
  const chosen = choices[labels.indexOf(picked)];
  if (chosen === undefined) {
    return;
  }
  const applied = await applyTuiTheme(runtime, context, chosen.id);
  if (applied.ok) {
    setupChrome(state, context);
    context.ui.notify(`Theme saved as ${chosen.id}.`, "info");
  } else {
    context.ui.notify(
      `Theme switch failed: ${applied.error ?? chosen.id}`,
      "warning",
    );
  }
}

export async function showInteractiveSettingsMenu(
  state: TuiState,
  context: ExtensionContext,
  argument: string,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  const trimmed = argument.trim();
  if (trimmed === "permissions" || trimmed === "permission") {
    await showPermissionsMenu(state, context);
    return;
  }
  for (;;) {
    const tui = runtime.config.tui;
    const rows = [
      "Permissions",
      "Cycle work mode  (Alt+M)",
      `Theme            ${tui.theme}`,
      `Thinking level   ${runtime.config.model.thinking}`,
      `Hide thinking    ${tui.hide_thinking ? "on" : "off"}`,
      `Header           ${tui.header ? "on" : "off"}`,
      `Status bar       ${tui.status ? "on" : "off"}`,
      `Widgets          ${tui.widgets ? "on" : "off"}`,
      `Compaction       ${runtime.config.context.compaction}`,
      "Config paths",
      "Close",
    ];
    const selected = await context.ui.select("codepunk settings", rows);
    if (selected === undefined || selected === "Close") {
      return;
    }
    if (selected === "Permissions") {
      await showPermissionsMenu(state, context);
      continue;
    }
    if (selected.startsWith("Cycle work mode")) {
      await cycleWorkMode(state, context);
      continue;
    }
    if (selected.startsWith("Theme")) {
      await chooseThemeSetting(state, context);
      continue;
    }
    if (selected.startsWith("Thinking level")) {
      const labels = THINKING_LEVELS.map(
        (level) =>
          `${level === runtime.config.model.thinking ? "\u2713" : " "} ${level}`,
      );
      const picked = await context.ui.select("Thinking level", labels);
      if (picked !== undefined) {
        const chosen = THINKING_LEVELS[labels.indexOf(picked)];
        if (chosen !== undefined) {
          runtime.config.model.thinking = chosen;
          runtime.host.session.setThinkingLevel(chosen);
          await writeUserThinkingSelection(runtime.paths, chosen).catch(
            () => undefined,
          );
          refreshStatus(state, context);
        }
      }
      continue;
    }
    if (selected.startsWith("Hide thinking")) {
      tui.hide_thinking = !tui.hide_thinking;
      runtime.host.services.settingsManager.setHideThinkingBlock(
        tui.hide_thinking,
      );
      await writeUserTuiPreferences(runtime.paths, {
        hideThinking: tui.hide_thinking,
      }).catch(() => undefined);
      context.ui.notify(
        `Hide thinking saved as ${tui.hide_thinking ? "on" : "off"}.`,
        "info",
      );
      continue;
    }
    if (selected.startsWith("Header")) {
      tui.header = !tui.header;
      await writeUserTuiPreferences(runtime.paths, {
        header: tui.header,
      }).catch(() => undefined);
      setupChrome(state, context);
      continue;
    }
    if (selected.startsWith("Status bar")) {
      tui.status = !tui.status;
      await writeUserTuiPreferences(runtime.paths, {
        status: tui.status,
      }).catch(() => undefined);
      refreshStatus(state, context);
      continue;
    }
    if (selected.startsWith("Widgets")) {
      tui.widgets = !tui.widgets;
      await writeUserTuiPreferences(runtime.paths, {
        widgets: tui.widgets,
      }).catch(() => undefined);
      refreshWorkWidget(state, context);
      refreshWelcomeWidget(state, context);
      setupChrome(state, context);
      continue;
    }
    if (selected.startsWith("Compaction")) {
      runtime.config.context.compaction =
        runtime.config.context.compaction === "auto" ? "manual" : "auto";
      runtime.host.services.settingsManager.setCompactionEnabled(
        runtime.config.context.compaction === "auto",
      );
      await writeUserTuiPreferences(runtime.paths, {
        compaction: runtime.config.context.compaction,
      }).catch(() => undefined);
      context.ui.notify(
        `Compaction saved as ${runtime.config.context.compaction}.`,
        "info",
      );
      continue;
    }
    context.ui.notify(
      [
        "codepunk settings are file-backed.",
        `config: ${runtime.paths.home}/config.toml`,
        "Use /permissions to change approval, autonomy, sandbox, and filesystem modes.",
        "Use /model for the model and /thinking for the reasoning level.",
      ].join("\n"),
      "info",
    );
  }
}
