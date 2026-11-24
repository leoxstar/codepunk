import {
  ProductPresetError,
  loadProductPresets,
  selectProductPreset,
  type CodepunkRuntime,
} from "codepunk-core";
import {
  autonomyRulesHash,
  loadScopedRules,
  readOnlyLiveSwitchIssue,
  readOnlyLiveWidenIssue,
} from "codepunk-core";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TuiState } from "../state.ts";
import { selectModelReference } from "./model.ts";
import { physicalModel } from "../chrome/model.ts";
export async function listPresets(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
): Promise<void> {
  try {
    const bundle = await loadProductPresets(runtime.paths);
    if (bundle.warnings.length > 0) {
      context.ui.notify(bundle.warnings.join("\n"), "warning");
    }
    if (bundle.presets.length === 0) {
      context.ui.notify(
        "No presets configured. Add [[preset]] entries to $CODEPUNK_HOME/presets.toml.",
        "info",
      );
      return;
    }
    context.ui.notify(
      [
        `Presets (${bundle.presets.length})`,
        ...bundle.presets.map((preset) => {
          const parts = [
            preset.name,
            preset.description.length === 0 ? null : preset.description,
            preset.model === null ? null : `model ${preset.model}`,
            preset.thinking === null ? null : `thinking ${preset.thinking}`,
            preset.permission === null
              ? null
              : `permission ${preset.permission}`,
            preset.tools.length === 0
              ? null
              : `tools ${preset.tools.join(",")}`,
          ].filter((part): part is string => part !== null);
          return `  ${parts.join(" · ")}`;
        }),
      ].join("\n"),
      "info",
    );
  } catch (error) {
    context.ui.notify(
      `/preset failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

export async function usePreset(
  state: TuiState,
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  name: string,
): Promise<void> {
  if (name.length === 0) {
    context.ui.notify("usage: /preset use <name>", "warning");
    return;
  }
  try {
    const bundle = await loadProductPresets(runtime.paths);
    if (bundle.warnings.length > 0) {
      context.ui.notify(bundle.warnings.join("\n"), "warning");
    }
    const selected = selectProductPreset(bundle, runtime.config, name);
    const applied: string[] = [];
    const skipped: string[] = [];

    if (selected.permission === "read-only") {
      try {
        await setAutonomyProfile(runtime, "read-only");
        runtime.config.autonomy.profile = "read-only";
        applied.push("permission read-only");
      } catch (error) {
        skipped.push(
          `permission read-only: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (runtime.autonomy.profile === "read-only") {
      skipped.push(
        "permission standard: a live read-only policy is not widened by a preset",
      );
    }

    if (selected.model !== null) {
      await selectModelReference(state, context, selected.model, {
        persist: false,
      });
      const appliedModel = physicalModel(runtime);
      if (
        appliedModel !== undefined &&
        `${appliedModel.provider}/${appliedModel.id}` === selected.model
      ) {
        applied.push(`model ${selected.model}`);
      } else {
        skipped.push(`model ${selected.model} could not be activated`);
      }
    }
    if (runtime.host.session.thinkingLevel !== selected.thinking) {
      runtime.host.session.setThinkingLevel(selected.thinking);
      applied.push(`thinking ${selected.thinking}`);
    }

    const active = runtime.host.session.getActiveToolNames();
    const available = state.activeToolsBeforePreset ?? active;
    const readOnlyLive = runtime.autonomy.profile === "read-only";
    const allowedTools = (tools: readonly string[]) =>
      readOnlyLive
        ? tools.filter(
            (tool) =>
              tool !== "write" &&
              tool !== "edit" &&
              tool !== "shell" &&
              tool !== "exec",
          )
        : [...tools];
    if (selected.tools.length > 0) {
      if (state.activeToolsBeforePreset === undefined) {
        state.activeToolsBeforePreset = [...active];
      }
      const requested = allowedTools(
        selected.tools.filter((tool) => available.includes(tool)),
      );
      const missing = selected.tools.filter(
        (tool) => !available.includes(tool),
      );
      runtime.host.session.setActiveToolsByName(requested);
      applied.push(
        `tools ${requested.length === 0 ? "(none)" : requested.join(",")}`,
      );
      if (missing.length > 0) {
        skipped.push(`tools unavailable in this session: ${missing.join(",")}`);
      }
    } else if (state.activeToolsBeforePreset !== undefined) {
      runtime.host.session.setActiveToolsByName(
        allowedTools(state.activeToolsBeforePreset),
      );
      delete state.activeToolsBeforePreset;
      applied.push("tools restored to the pre-preset set");
    }

    context.ui.notify(
      [
        `preset ${selected.name}`,
        applied.length === 0
          ? "applied: no changes"
          : `applied: ${applied.join("; ")}`,
        ...skipped.map((entry) => `skipped: ${entry}`),
        "preset changes apply to this session; policy is never widened",
      ].join("\n"),
      "info",
    );
  } catch (error) {
    context.ui.notify(
      `/preset use failed: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof ProductPresetError ? "warning" : "error",
    );
  }
}

export async function setAutonomyProfile(
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
