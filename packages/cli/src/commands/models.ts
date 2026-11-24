import {
  formatModelCatalog,
  importProviderModels,
  isThinkingLevel,
  listModelCatalog,
  openModelRuntime,
  removeModelsProvider,
  resolveModelSelection,
  setConfiguredModel,
  testConfiguredModel,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { resolveProject } from "../run/project.ts";

type ProjectContext = Awaited<ReturnType<typeof resolveProject>>;

export async function commandModels(options: CliOptions): Promise<number> {
  const project = await resolveProject(options);
  const subcommand = options.positionals[1] ?? "list";
  if (subcommand === "list") {
    return modelsList(options, project);
  }
  if (subcommand === "set") {
    return modelsSet(options, project);
  }
  if (subcommand === "test") {
    return modelsTest(options, project);
  }
  if (subcommand === "remove") {
    return modelsRemove(options, project);
  }
  if (subcommand === "import") {
    return modelsImport(options, project);
  }
  throw new Error(`unknown models command: ${subcommand}`);
}

async function modelsList(
  options: CliOptions,
  { paths, config }: ProjectContext,
): Promise<number> {
  const catalog = await listModelCatalog(paths, config);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(catalog)}\n`);
  } else {
    process.stdout.write(`${formatModelCatalog(catalog)}\n`);
  }
  return catalog.error === null ? 0 : 1;
}

async function modelsSet(
  options: CliOptions,
  { paths, config }: ProjectContext,
): Promise<number> {
  const reference = options.positionals[2] ?? options.model;
  if (reference === undefined) {
    throw new Error("models set requires <provider/id>");
  }
  const runtime = await openModelRuntime(paths);
  const resolution = resolveModelSelection(runtime, reference);
  if (resolution.status !== "resolved" || !resolution.exact) {
    throw new Error(
      resolution.status === "resolved"
        ? `models set requires an exact <provider/id>; run codepunk models list`
        : resolution.error,
    );
  }
  const provider = resolution.model.provider;
  const id = resolution.model.id;
  let thinking;
  if (options.thinking !== undefined) {
    if (!isThinkingLevel(options.thinking)) {
      throw new Error(
        "--thinking must be off, minimal, low, medium, high, xhigh, or max",
      );
    }
    thinking = options.thinking;
  }
  await setConfiguredModel(paths, config, provider, id, thinking);
  process.stdout.write(
    `model set to ${provider}/${id}\nconfig: ${paths.home}/config.toml\n`,
  );
  return 0;
}

async function modelsTest(
  options: CliOptions,
  { paths, config }: ProjectContext,
): Promise<number> {
  const reference = options.positionals[2] ?? options.model;
  const result = await testConfiguredModel(paths, config, reference);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(
      [
        `model: ${result.provider}/${result.id}`,
        `status: ${result.ok ? "ok" : "failed"}`,
        `stop: ${result.stop_reason}`,
        `latency: ${result.latency_ms} ms`,
        `tokens: input ${result.input_tokens}, output ${result.output_tokens}, total ${result.total_tokens}`,
        ...(result.text.length === 0 ? [] : [`text: ${result.text}`]),
        ...(result.error === null ? [] : [`error: ${result.error}`]),
      ].join("\n") + "\n",
    );
  }
  return result.ok ? 0 : 1;
}

async function modelsRemove(
  options: CliOptions,
  { paths, config }: ProjectContext,
): Promise<number> {
  const providerId = options.positionals[2];
  if (providerId === undefined || providerId.length === 0) {
    throw new Error("models remove requires <provider>");
  }
  if (config.model.provider === providerId) {
    throw new Error(
      `provider ${providerId} owns the selected model; choose another default with codepunk models set before removing it`,
    );
  }
  const referenced = config.model.fallback.filter((reference) =>
    reference.startsWith(`${providerId}/`),
  );
  if (referenced.length > 0) {
    throw new Error(
      `provider ${providerId} is still referenced by model.fallback: ${referenced.join(", ")}; update the fallback chain first`,
    );
  }
  const result = await removeModelsProvider(paths, providerId);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  process.stdout.write(
    [
      `removed provider ${result.providerId} from ${result.path}`,
      result.remaining.length === 0
        ? "no custom providers remain"
        : `remaining providers: ${result.remaining.join(", ")}`,
    ].join("\n") + "\n",
  );
  return 0;
}

async function modelsImport(
  options: CliOptions,
  { paths }: ProjectContext,
): Promise<number> {
  const baseUrl = options.baseUrl ?? options.positionals[2];
  if (baseUrl === undefined) {
    throw new Error("models import requires <base-url>");
  }
  const provider = options.provider;
  if (provider === undefined || provider.length === 0) {
    throw new Error("models import requires --provider <id>");
  }
  const api = options.api ?? "openai-responses";
  if (api !== "openai-responses" && api !== "openai-completions") {
    throw new Error(
      "--api must be openai-responses or openai-completions for model discovery",
    );
  }
  const filters =
    options.model === undefined
      ? undefined
      : options.model
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
  const result = await importProviderModels(paths, {
    baseUrl,
    providerId: provider,
    api,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    authHeader: options.authHeader,
    ...(filters === undefined ? {} : { models: filters }),
  });
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        provider: result.providerId,
        baseUrl: result.baseUrl,
        api: result.api,
        modelCount: result.models.length,
        models: result.models.map((model) => model.id),
        path: result.path,
      })}\n`,
    );
    return 0;
  }
  process.stdout.write(
    [
      `imported ${result.models.length} model(s) into ${result.path}`,
      `provider: ${result.providerId} · ${result.baseUrl} · ${result.api}${
        options.authHeader ? " · bearer auth" : ""
      }`,
      "next: codepunk models list",
      `      codepunk models set ${result.providerId}/<model-id>`,
    ].join("\n") + "\n",
  );
  return 0;
}
