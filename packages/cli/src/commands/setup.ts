import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  RECOMMENDED_SETUP_PROVIDERS,
  detectAvailableDefaultModel,
  importProviderModels,
  isThinkingLevel,
  openModelRuntime,
  resolveModelSelection,
  setConfiguredModel,
  setProviderAuthCredential,
  testConfiguredModel,
  type CodepunkConfig,
  type ConfiguredModel,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { resolveProject } from "../run/project.ts";

type ProjectContext = Awaited<ReturnType<typeof resolveProject>>;
type ModelRuntimeInstance = Awaited<ReturnType<typeof openModelRuntime>>;

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
  google: "Google (Gemini)",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  moonshotai: "Moonshot / Kimi",
  xai: "xAI (Grok)",
  groq: "Groq",
  mistral: "Mistral",
};

function sortProviderModels(
  models: readonly ConfiguredModel[],
): ConfiguredModel[] {
  return [...models].sort((left, right) => {
    if (left.reasoning !== right.reasoning) {
      return left.reasoning ? -1 : 1;
    }
    if (left.contextWindow !== right.contextWindow) {
      return right.contextWindow - left.contextWindow;
    }
    return left.id.localeCompare(right.id);
  });
}

function formatWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}K` : String(tokens);
}

async function promptLine(label: string, fallback = ""): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const suffix = fallback.length > 0 ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    return answer.length > 0 ? answer : fallback;
  } finally {
    rl.close();
  }
}

async function promptSecret(label: string): Promise<string> {
  if (
    process.stdin.isTTY !== true ||
    typeof process.stdin.setRawMode !== "function"
  ) {
    return await promptLine(label);
  }
  process.stderr.write(`${label}: `);
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const ch of text) {
        if (ch === "\u0003") {
          cleanup();
          process.stderr.write("\n");
          reject(new Error("setup cancelled"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stderr.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write("\b \b");
          }
          continue;
        }
        if (ch >= " ") {
          value += ch;
          process.stderr.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

function parseThinking(options: CliOptions) {
  if (options.thinking === undefined) {
    return undefined;
  }
  if (!isThinkingLevel(options.thinking)) {
    throw new Error(
      "--thinking must be off, minimal, low, medium, high, xhigh, or max",
    );
  }
  return options.thinking;
}

async function runNonInteractiveSetup(
  options: CliOptions,
  project: ProjectContext,
): Promise<number> {
  const { paths, config } = project;
  const thinking = parseThinking(options);
  if (options.baseUrl !== undefined) {
    const providerId = options.provider;
    if (providerId === undefined || providerId.length === 0) {
      throw new Error("setup with --base-url requires --provider <id>");
    }
    const api = options.api ?? "openai-responses";
    const imported = await importProviderModels(paths, {
      baseUrl: options.baseUrl,
      providerId,
      api,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      authHeader: options.authHeader || options.apiKey !== undefined,
    });
    const chosenId = options.model ?? imported.models[0]?.id;
    if (chosenId === undefined) {
      throw new Error(`no models returned by ${options.baseUrl}`);
    }
    await setConfiguredModel(paths, config, providerId, chosenId, thinking);
    emitSetupResult(options, paths, providerId, chosenId, false);
    return 0;
  }
  const providerId = options.provider!;
  let savedKey = false;
  if (options.apiKey !== undefined && options.apiKey.trim().length > 0) {
    await setProviderAuthCredential(paths, providerId, {
      type: "api_key",
      key: options.apiKey.trim(),
    });
    savedKey = true;
  }
  const runtime = await openModelRuntime(paths);
  const providerModels = sortProviderModels(
    runtime.getModels().filter((model) => model.provider === providerId),
  );
  if (providerModels.length === 0) {
    throw new Error(
      `unknown provider "${providerId}"; run \`codepunk models list\` or pass --base-url for a custom endpoint`,
    );
  }
  let chosen: ConfiguredModel;
  if (options.model !== undefined) {
    const ref = options.model.includes("/")
      ? options.model
      : `${providerId}/${options.model}`;
    const resolution = resolveModelSelection(runtime, ref);
    if (resolution.status !== "resolved") {
      throw new Error(resolution.error);
    }
    chosen = resolution.model;
  } else {
    chosen = providerModels[0]!;
  }
  await setConfiguredModel(paths, config, chosen.provider, chosen.id, thinking);
  emitSetupResult(options, paths, chosen.provider, chosen.id, savedKey);
  return 0;
}

function emitSetupResult(
  options: CliOptions,
  paths: ProjectContext["paths"],
  provider: string,
  modelId: string,
  savedKey: boolean,
): void {
  const configPath = path.join(paths.home, "config.toml");
  const authPath = path.join(paths.home, "auth.json");
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        provider,
        model: modelId,
        reference: `${provider}/${modelId}`,
        configPath,
        ...(savedKey ? { authPath } : {}),
      })}\n`,
    );
    return;
  }
  process.stdout.write(
    [
      `Codepunk configured: ${provider}/${modelId}`,
      `  config: ${configPath}`,
      ...(savedKey ? [`  auth:   ${authPath} (mode 0600)`] : []),
      "",
      "Next steps:",
      "  codepunk          start an interactive session",
      "  codepunk doctor   verify sandbox, tools, and credentials",
    ].join("\n") + "\n",
  );
}

async function pickCustomEndpointInteractive(
  options: CliOptions,
  paths: ProjectContext["paths"],
  config: CodepunkConfig,
): Promise<number> {
  const baseUrl = await promptLine(
    "OpenAI-compatible base URL (e.g. https://api.openai.com/v1)",
  );
  if (baseUrl.length === 0) {
    throw new Error("base URL is required");
  }
  const providerId = await promptLine("Provider id", "custom");
  const api = await promptLine(
    "API flavor (openai-responses or openai-completions)",
    "openai-responses",
  );
  const apiKey = await promptSecret("API key (leave blank for local no-auth)");
  const imported = await importProviderModels(paths, {
    baseUrl,
    providerId,
    api,
    ...(apiKey.length > 0
      ? { apiKey, authHeader: true }
      : { apiKey: providerId, authHeader: false }),
  });
  if (imported.models.length === 0) {
    throw new Error(`no models returned by ${baseUrl}`);
  }
  const { selectTerminalChoice } = await import("../terminal-select.ts");
  const chosenId = await selectTerminalChoice(
    `Select default model for ${providerId}`,
    imported.models.slice(0, 25).map((model) => ({
      label: model.id,
      value: model.id,
      description: `${formatWindow(model.contextWindow)} ctx${model.reasoning ? " · reasoning" : ""}`,
    })),
  );
  await setConfiguredModel(paths, config, providerId, chosenId);
  emitSetupResult(options, paths, providerId, chosenId, false);
  return 0;
}

async function pickBuiltInProviderInteractive(
  providerId: string,
  runtime: ModelRuntimeInstance,
  options: CliOptions,
  paths: ProjectContext["paths"],
  config: CodepunkConfig,
): Promise<number> {
  const hasAuth = (await runtime.checkAuth(providerId)) !== undefined;
  let savedKey = false;
  if (!hasAuth) {
    const key = await promptSecret(
      `Paste API key for ${PROVIDER_LABELS[providerId] ?? providerId}`,
    );
    if (key.length === 0) {
      throw new Error(`API key for ${providerId} cannot be empty`);
    }
    await setProviderAuthCredential(paths, providerId, {
      type: "api_key",
      key,
    });
    savedKey = true;
  }
  const refreshed = savedKey ? await openModelRuntime(paths) : runtime;
  const models = sortProviderModels(
    refreshed.getModels().filter((model) => model.provider === providerId),
  );
  if (models.length === 0) {
    throw new Error(`no models available for provider ${providerId}`);
  }
  const { selectTerminalChoice } = await import("../terminal-select.ts");
  const chosen = await selectTerminalChoice(
    `Select default model for ${PROVIDER_LABELS[providerId] ?? providerId}`,
    models.slice(0, 25).map((model) => ({
      label: model.id,
      value: model,
      description: `${formatWindow(model.contextWindow)} ctx${model.reasoning ? " · reasoning" : ""}`,
    })),
  );
  await setConfiguredModel(
    paths,
    config,
    chosen.provider,
    chosen.id,
    parseThinking(options),
  );
  const testChoice = await selectTerminalChoice<"test" | "skip">(
    "Verify connection with a quick test request?",
    [
      {
        label: "Test model now",
        value: "test",
        description: `Send a tiny prompt to ${chosen.provider}/${chosen.id}`,
      },
      {
        label: "Skip test",
        value: "skip",
        description: "Save configuration and finish",
      },
    ],
  );
  if (testChoice === "test") {
    const testResult = await testConfiguredModel(
      paths,
      {
        ...config,
        model: { ...config.model, provider: chosen.provider, id: chosen.id },
      },
      `${chosen.provider}/${chosen.id}`,
    );
    process.stderr.write(
      testResult.ok
        ? `Connection OK (${testResult.latency_ms} ms)\n`
        : `Connection check failed: ${testResult.error ?? testResult.stop_reason}\n`,
    );
  }
  emitSetupResult(options, paths, chosen.provider, chosen.id, savedKey);
  return 0;
}

export async function commandSetup(options: CliOptions): Promise<number> {
  const project = await resolveProject(options);
  if (options.provider !== undefined || options.baseUrl !== undefined) {
    return await runNonInteractiveSetup(options, project);
  }
  const { paths, config } = project;
  const runtime = await openModelRuntime(paths);
  const detected = await detectAvailableDefaultModel(paths, config, runtime);
  if (process.stdin.isTTY !== true) {
    if (detected !== null) {
      await setConfiguredModel(
        paths,
        config,
        detected.model.provider,
        detected.model.id,
        parseThinking(options),
      );
      emitSetupResult(
        options,
        paths,
        detected.model.provider,
        detected.model.id,
        false,
      );
      return 0;
    }
    throw new Error(
      "codepunk setup requires an interactive terminal, or pass --provider <id> --api-key <key>",
    );
  }
  const { selectTerminalChoice } = await import("../terminal-select.ts");
  const allProviders = [
    ...new Set(runtime.getModels().map((model) => model.provider)),
  ].sort();
  const topChoices: Array<{
    label: string;
    value: string;
    description: string;
  }> = [];
  if (detected !== null) {
    const ref = `${detected.model.provider}/${detected.model.id}`;
    topChoices.push({
      label: `Use detected model: ${ref}`,
      value: "__detected__",
      description: `${detected.totalAvailable} ready model(s) found from active credentials`,
    });
  }
  for (const providerId of RECOMMENDED_SETUP_PROVIDERS) {
    if (!allProviders.includes(providerId)) {
      continue;
    }
    const ready = (await runtime.checkAuth(providerId)) !== undefined;
    topChoices.push({
      label: PROVIDER_LABELS[providerId] ?? providerId,
      value: providerId,
      description: ready ? "credentials ready" : "enter API key",
    });
  }
  topChoices.push(
    {
      label: "Custom OpenAI-compatible endpoint…",
      value: "__custom__",
      description: "vLLM, LiteLLM, Ollama, corporate gateway, etc.",
    },
    {
      label: "All built-in providers…",
      value: "__all__",
      description: `${allProviders.length} providers available`,
    },
  );
  const picked = await selectTerminalChoice(
    "Codepunk Setup — Choose a model provider",
    topChoices,
    {
      contextLines: [
        `config: ${path.join(paths.home, "config.toml")}`,
        "API keys are stored locally in auth.json (mode 0600).",
      ],
    },
  );
  if (picked === "__detected__" && detected !== null) {
    await setConfiguredModel(
      paths,
      config,
      detected.model.provider,
      detected.model.id,
      parseThinking(options),
    );
    emitSetupResult(
      options,
      paths,
      detected.model.provider,
      detected.model.id,
      false,
    );
    return 0;
  }
  if (picked === "__custom__") {
    return await pickCustomEndpointInteractive(options, paths, config);
  }
  const providerId =
    picked === "__all__"
      ? await selectTerminalChoice(
          "Select provider",
          allProviders.map((id) => ({
            label: PROVIDER_LABELS[id] ?? id,
            value: id,
          })),
        )
      : picked;
  return await pickBuiltInProviderInteractive(
    providerId,
    runtime,
    options,
    paths,
    config,
  );
}
