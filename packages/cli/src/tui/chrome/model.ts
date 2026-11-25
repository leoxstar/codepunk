import { isFallbackModel, type CodepunkRuntime } from "codepunk-core";

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
