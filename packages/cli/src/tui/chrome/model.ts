import {
  isFallbackModel,
  permissionProfileFor,
  type CodepunkRuntime,
} from "codepunk-core";
import { renderStatusline } from "../../statusline.ts";
import { budgetSnapshot, formatBudgetStatus } from "../format/status.ts";
import { trustDisplay } from "../format/trust.ts";
import { currentShellStatus } from "./status.ts";

import type { TuiState } from "../state.ts";

export function evidenceCount(runtime: CodepunkRuntime): number {
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

export function selectedModel(
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

export function physicalModel(
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

export function renderStatus(state: TuiState): string {
  const runtime = state.runtime;
  if (runtime === null) {
    return "codepunk · starting";
  }
  const profile = permissionProfileFor(runtime.config);
  const budget = budgetSnapshot(runtime);
  return renderStatusline(runtime.config.tui.statusline, {
    model: modelStatus(runtime),
    session: `project ${runtime.paths.projectId} · session ${runtime.session.sessionId.slice(0, 12)}`,
    sandbox: `next sandbox ${runtime.config.sandbox.mode}`,
    filesystem: `fs ${runtime.config.filesystem.mode}`,
    policy: `permissions ${profile} · trust ${trustDisplay(runtime.workspaceTrust)} · shell ${currentShellStatus(runtime)} · evidence ${evidenceCount(runtime)}`,
    budget: formatBudgetStatus(budget),
  });
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

export function noAuthenticatedModelsMessage(): string {
  return [
    "No authenticated models.",
    "Add a provider first:",
    "  /login                         sign in to a built-in provider",
    "  codepunk models import <base-url> --provider <id> --api openai-responses",
    "  codepunk models set <id>/<model>",
    "Then run /model to choose a model.",
  ].join("\n");
}
