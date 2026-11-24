import {
  nextRecentModel,
  readModelHistory,
  toggleFavoriteModel,
} from "../../model-history.ts";
import {
  resolveModelSelection,
  setConfiguredModel,
  resolveConfiguredModel,
  type CodepunkRuntime,
} from "codepunk-core";
import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TuiState } from "../state.ts";
import { setupChrome } from "../chrome/setup.ts";
import { modelOnboardingMessage, physicalModel } from "../chrome/model.ts";

export function modelLabel(model: {
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

export function customEndpointMessage(): string {
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
export async function promptForMissingModel(
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

export async function showProviderSetup(
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

export async function availableModels(runtime: CodepunkRuntime) {
  const modelRuntime = runtime.host.services.modelRuntime;
  const cached = modelRuntime.getAvailableSnapshot();
  if (cached.length > 0) {
    return [...cached];
  }
  return modelRuntime.getAvailable();
}

export async function selectModelReference(
  state: TuiState,
  context: ExtensionContext,
  reference: string,
  options: { persist?: boolean } = {},
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
  if (options.persist === false) {
    context.ui.notify(
      `model set to ${model.provider}/${model.id} for this session`,
      "info",
    );
    state.modelSelected = true;
    setupChrome(state, context);
    return true;
  }
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
export type ModelPickerResult = "selected" | "delegate" | "cancelled" | "empty";

export function modelReference(model: {
  provider: string;
  id: string;
}): string {
  return `${model.provider}/${model.id}`;
}

export async function showModelHistoryPicker(
  state: TuiState,
  context: ExtensionContext,
  runtime: CodepunkRuntime,
): Promise<ModelPickerResult> {
  const history = await readModelHistory(runtime.paths.home);
  if (history.warning !== null) {
    context.ui.notify(history.warning, "warning");
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
    return "cancelled";
  }
  const available = new Map(
    models.map((model) => [modelReference(model), model]),
  );
  const current = physicalModel(runtime);
  const currentReference =
    current === undefined ? null : modelReference(current);
  const favorites = history.favorites.filter((entry) => available.has(entry));
  const recent = history.recent.filter(
    (entry) => available.has(entry) && !favorites.includes(entry),
  );
  if (favorites.length === 0 && recent.length === 0) {
    return "empty";
  }
  const selections = new Map<string, string>();
  const options: string[] = [];
  for (const reference of favorites) {
    const label = `\u2605 ${reference}${
      reference === currentReference ? " (current)" : ""
    }`;
    selections.set(label, reference);
    options.push(label);
  }
  for (const reference of recent) {
    const label = `\u21ba ${reference}${
      reference === currentReference ? " (current)" : ""
    }`;
    selections.set(label, reference);
    options.push(label);
  }
  const search = "\u2315 Search all models (Pi)";
  const cancel = "Cancel";
  options.push(search, cancel);
  const selected = await context.ui.select("Select model", options);
  if (selected === undefined || selected === cancel) {
    return "cancelled";
  }
  if (selected === search) {
    return "delegate";
  }
  const reference = selections.get(selected);
  if (reference === undefined) {
    return "cancelled";
  }
  await selectModelReference(state, context, reference);
  return "selected";
}

export async function showFavoriteModels(
  state: TuiState,
  context: ExtensionCommandContext,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  const result = await showModelHistoryPicker(state, context, runtime);
  if (result === "empty") {
    context.ui.notify(
      "No recent or favorite models yet. Use /model to search all models.",
      "info",
    );
  } else if (result === "delegate") {
    context.ui.setEditorText("/model");
    context.ui.notify("Press Enter to open Pi's fuzzy model search.", "info");
  }
}

export async function cycleRecentModel(
  state: TuiState,
  context: ExtensionContext,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  const history = await readModelHistory(runtime.paths.home);
  if (history.warning !== null) {
    context.ui.notify(history.warning, "warning");
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
    return;
  }
  const available = new Set(models.map((model) => modelReference(model)));
  const current = physicalModel(runtime);
  const next = nextRecentModel(
    history.recent,
    current === undefined ? null : modelReference(current),
    available,
  );
  if (next === null) {
    context.ui.notify(
      "No recent models to cycle. Select a model once with /model.",
      "info",
    );
    return;
  }
  await selectModelReference(state, context, next);
}

export async function toggleFavorite(
  state: TuiState,
  context: ExtensionCommandContext,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  const current = physicalModel(runtime);
  if (current === undefined) {
    context.ui.notify("No model is selected. Use /model first.", "warning");
    return;
  }
  const reference = modelReference(current);
  try {
    const result = await toggleFavoriteModel(runtime.paths.home, reference);
    context.ui.notify(
      `${result.favorite ? "Added to" : "Removed from"} favorites: ${reference}`,
      "info",
    );
  } catch (error) {
    context.ui.notify(
      `favorite could not be saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
}
export { notify } from "./notify.ts";
