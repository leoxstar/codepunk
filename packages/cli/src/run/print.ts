import {
  ConfigError,
  JsonSchemaValidationError,
  buildJsonSchemaPromptSuffix,
  createRuntime,
  findDeliveryRoot,
  loadJsonOutputSchema,
  probeConfiguredModel,
  projectPaths,
  validateAssistantTextAgainstSchema,
  type CodepunkRuntime,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { preparedConfigOverrides } from "../args/overrides.ts";
import { makeSessionRuntime } from "./interactive.ts";
import { prepareFork, sessionSelector } from "./project.ts";
import {
  resolveRunWorkspaceTrust,
  trustRuntimeOptions,
} from "./trust-prompt.ts";
import { prepareCliWorktree } from "./worktree.ts";

function writeRuntimeWarnings(runtime: CodepunkRuntime): void {
  for (const warning of runtime.loadedConfig.warnings) {
    process.stderr.write(`codepunk: warning: ${warning}\n`);
  }
}

function exhaustedBudgetMessage(runtime: CodepunkRuntime): string | null {
  const maxTokens = runtime.config.budget.max_tokens;
  const maxCostUsd = runtime.config.budget.max_cost_usd;
  const usage = runtime.usage();
  const tokensExhausted = maxTokens !== null && usage.total_tokens >= maxTokens;
  const costExhausted = maxCostUsd !== null && usage.cost_total >= maxCostUsd;
  if (!tokensExhausted && !costExhausted) {
    return null;
  }
  const limits: string[] = [];
  if (maxTokens !== null) {
    limits.push(`${usage.total_tokens}/${maxTokens} tokens`);
  }
  if (maxCostUsd !== null) {
    limits.push(`$${usage.cost_total}/$${maxCostUsd}`);
  }
  return `session budget exhausted (${limits.join(", ")}); start a new session to continue`;
}

function extractLatestAssistantRawText(messages: readonly unknown[]): {
  text: string;
  stopError: string | null;
} {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i] as
      | {
          role?: unknown;
          stopReason?: unknown;
          errorMessage?: unknown;
          content?: unknown;
        }
      | undefined;
    if (candidate?.role !== "assistant") {
      continue;
    }
    if (
      candidate.stopReason === "error" ||
      candidate.stopReason === "aborted"
    ) {
      return {
        text: "",
        stopError:
          typeof candidate.errorMessage === "string" &&
          candidate.errorMessage.length > 0
            ? candidate.errorMessage
            : `Request ${String(candidate.stopReason)}`,
      };
    }
    if (typeof candidate.content === "string") {
      return { text: candidate.content, stopError: null };
    }
    if (!Array.isArray(candidate.content)) {
      return { text: "", stopError: null };
    }
    const text = candidate.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          part !== null &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("");
    return { text, stopError: null };
  }
  return { text: "", stopError: null };
}

async function runTextPrintWithSchemaGate(
  sessionRuntime: Awaited<ReturnType<typeof makeSessionRuntime>>,
  prompt: string,
  schema: Record<string, unknown>,
): Promise<number> {
  const session = sessionRuntime.session;
  try {
    await session.bindExtensions({
      mode: "print",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async (opts) => sessionRuntime.newSession(opts),
        fork: async (entryId, opts) => ({
          cancelled: (await sessionRuntime.fork(entryId, opts)).cancelled,
        }),
        navigateTree: async (targetId, opts) => ({
          cancelled: (
            await session.navigateTree(targetId, {
              ...(opts?.summarize !== undefined
                ? { summarize: opts.summarize }
                : {}),
              ...(opts?.customInstructions !== undefined
                ? { customInstructions: opts.customInstructions }
                : {}),
              ...(opts?.replaceInstructions !== undefined
                ? { replaceInstructions: opts.replaceInstructions }
                : {}),
              ...(opts?.label !== undefined ? { label: opts.label } : {}),
            })
          ).cancelled,
        }),
        switchSession: async (sessionPath, opts) =>
          sessionRuntime.switchSession(sessionPath, opts),
        reload: async () => {
          await session.reload();
        },
      },
      onError: (err) => {
        process.stderr.write(
          `codepunk: extension error (${err.extensionPath}): ${err.error}\n`,
        );
      },
    });
    await session.prompt(prompt);
    const extracted = extractLatestAssistantRawText(session.state.messages);
    if (extracted.stopError !== null) {
      process.stderr.write(`codepunk: ${extracted.stopError}\n`);
      return 1;
    }
    const checked = validateAssistantTextAgainstSchema(extracted.text, schema);
    if (!checked.ok) {
      const details = checked.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ");
      process.stderr.write(
        `codepunk: --json-schema validation failed: ${details}\n`,
      );
      return 1;
    }
    process.stdout.write(`${checked.canonicalJson}\n`);
    return 0;
  } finally {
    await sessionRuntime.dispose();
  }
}

export async function runPrint(
  options: CliOptions,
  prompt: string,
): Promise<number> {
  if (options.allowUnsandboxedShell) {
    throw new Error("--allow-unsandboxed-shell is interactive only");
  }
  if (options.dangerouslyBypass) {
    throw new Error(
      "--dangerously-bypass-approvals-and-sandbox is interactive only",
    );
  }
  if (options.allowPlugins) {
    throw new Error("--allow-plugins is interactive only");
  }
  if (
    options.permissionMode !== undefined &&
    options.permissionMode !== "read-only" &&
    options.headlessPolicy === undefined
  ) {
    throw new Error(
      `print mode exposes read-only tools unless --headless-policy grants write or shell; --permission-mode ${options.permissionMode} would not take effect`,
    );
  }
  const isolatedWorktree = await prepareCliWorktree(options.worktree);
  const effectiveCwd = isolatedWorktree?.cwd ?? process.cwd();
  let outputSchema: Record<string, unknown> | null = null;
  if (options.jsonSchema !== undefined) {
    try {
      outputSchema = await loadJsonOutputSchema(
        options.jsonSchema,
        effectiveCwd,
      );
    } catch (error) {
      if (error instanceof JsonSchemaValidationError) {
        throw new ConfigError(error.message);
      }
      throw error;
    }
  }
  const effectivePrompt =
    outputSchema === null
      ? prompt
      : `${prompt}${buildJsonSchemaPromptSuffix(outputSchema)}`;
  const forkedSessionId = await prepareFork(options, effectiveCwd);
  const selector =
    forkedSessionId === undefined
      ? sessionSelector(options.session)
      : { sessionId: forkedSessionId };
  const project = await findDeliveryRoot(effectiveCwd);
  const workspaceTrust = await resolveRunWorkspaceTrust(
    options,
    project,
    false,
  );
  const overrides = await preparedConfigOverrides(
    options,
    projectPaths(project),
  );
  const runtime = await createRuntime({
    cwd: effectiveCwd,
    additionalDirs: options.additionalDirs,
    environment: process.env,
    configOverrides: overrides,
    headless: true,
    continueSession: forkedSessionId === undefined && options.continueSession,
    newSession: forkedSessionId === undefined && options.newSession,
    ...(options.newSessionId !== undefined
      ? { newSessionId: options.newSessionId }
      : {}),
    ...(options.parentSessionId !== undefined
      ? { parentSessionId: options.parentSessionId }
      : {}),
    ...selector,
    ...(options.headlessPolicy !== undefined
      ? { headlessPolicyPath: options.headlessPolicy }
      : {}),
    bindMode: "print",
    allowUnsandboxedShell: false,
    disableMcp: options.noMcp,
    disableSkills: options.noSkills,
    disablePlugins: options.noPlugins,
    bare: options.bare,
    ...trustRuntimeOptions(workspaceTrust),
  });
  writeRuntimeWarnings(runtime);
  try {
    const modelIssue = await probeConfiguredModel(
      runtime.paths,
      runtime.config,
    );
    if (modelIssue !== null) {
      throw new Error(modelIssue);
    }
    const budgetIssue = exhaustedBudgetMessage(runtime);
    if (budgetIssue !== null) {
      throw new Error(budgetIssue);
    }
    const sessionRuntime = await makeSessionRuntime(runtime);
    if (outputSchema !== null && options.mode === "text") {
      return await runTextPrintWithSchemaGate(
        sessionRuntime,
        effectivePrompt,
        outputSchema,
      );
    }
    const { runPrintMode } = await import("@earendil-works/pi-coding-agent");
    const exitCode = await runPrintMode(sessionRuntime, {
      mode: options.mode,
      initialMessage: effectivePrompt,
    });
    if (exitCode === 0 && outputSchema !== null) {
      const extracted = extractLatestAssistantRawText(
        runtime.host.session.messages,
      );
      const checked = validateAssistantTextAgainstSchema(
        extracted.text,
        outputSchema,
      );
      if (!checked.ok) {
        const details = checked.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ");
        process.stderr.write(
          `codepunk: --json-schema validation failed: ${details}\n`,
        );
        return 1;
      }
    }
    return exitCode;
  } finally {
    await runtime.dispose();
  }
}
