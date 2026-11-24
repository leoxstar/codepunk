import {
  createRuntime,
  findDeliveryRoot,
  probeConfiguredModel,
  projectPaths,
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
  const forkedSessionId = await prepareFork(options);
  const selector =
    forkedSessionId === undefined
      ? sessionSelector(options.session)
      : { sessionId: forkedSessionId };
  const project = await findDeliveryRoot(process.cwd());
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
    cwd: process.cwd(),
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
    const { runPrintMode } = await import("@earendil-works/pi-coding-agent");
    return await runPrintMode(sessionRuntime, {
      mode: options.mode,
      initialMessage: prompt,
    });
  } finally {
    await runtime.dispose();
  }
}
