import { promises as fs } from "node:fs";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionServices,
  type ExtensionError,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentState, PlanStep, TodoItem } from "codepunk-protocol";
import {
  loadContext,
  truncateContextAtTurnBoundary,
} from "../../context/index.ts";
import { MCP_RESOURCE_TOOL_NAMES } from "../../mcp/names.ts";
import { isFallbackModel, modelReference } from "../../model/fallback.ts";
import {
  summarizeModelUsage,
  summarizeSessionModelUsage,
} from "../../model/index.ts";
import { createUlid } from "../../platform/hash.ts";
import { normalizeAbsolute } from "../../platform/path.ts";
import {
  isBenignTailEventKind,
  type SessionStore,
  type SessionWriter,
} from "../../session/index.ts";
import {
  TOOL_SEARCH_TOOL_NAME,
  createCodepunkToolDefinitions,
  createToolSearchTool,
  shouldDeferMcpTools,
  type CodepunkToolName,
} from "../../tools/index.ts";
import { readWorkState } from "../../work/index.ts";
import {
  wrapToolDefinition,
  wrapToolDefinitions,
  type ToolWrapOptions,
} from "../../wrap/index.ts";
import { configureHostModelSelection } from "./fallback-setup.ts";
import {
  additionalExtensionPaths,
  assertHostResources,
  assertNoForbiddenPiState,
  assertNoPiSessionFiles,
  assertWrappedToolRegistry,
  resolveSandbox,
  restoreEntries,
  restoreSessionLeaf,
  setHostEnvironment,
} from "./isolation.ts";
import { createProductExtension } from "./product-extension.ts";
import {
  PRODUCT_SYSTEM_SECTION,
  renderRuntimeEnvironment,
  retryErrorEvidence,
} from "./prompt.ts";
import { createSessionSummarizer } from "./summary.ts";
import {
  HostIsolationError,
  type CreatePiHostOptions,
  type PiHost,
  type ProductHookState,
  type ToolRegistrySnapshot,
} from "./types.ts";

export {
  HostIsolationError,
  PRODUCT_SYSTEM_SECTION,
  assertWrappedToolRegistry,
  renderRuntimeEnvironment,
  type CreatePiHostOptions,
  type PiHost,
  type ToolRegistrySnapshot,
};

export async function createPiHost(
  options: CreatePiHostOptions,
): Promise<PiHost> {
  const cwd = normalizeAbsolute(options.cwd);
  const codepunkHome = normalizeAbsolute(options.codepunkHome);
  const store = options.sessionStore ?? null;
  if (options.model !== undefined && isFallbackModel(options.model)) {
    throw new HostIsolationError(
      "the codepunk/auto virtual model cannot be used as the host's primary model",
    );
  }
  if (store !== null && store.sessionId !== options.sessionId) {
    throw new HostIsolationError(
      "Pi host session id does not match the codepunk session store",
    );
  }
  await assertNoForbiddenPiState(
    cwd,
    normalizeAbsolute(options.deliveryRoot),
    codepunkHome,
  );
  await assertNoPiSessionFiles(codepunkHome);
  await fs.mkdir(codepunkHome, { recursive: true, mode: 0o700 });

  const restoreEnvironment = await setHostEnvironment(codepunkHome);
  let writer: SessionWriter | null = null;
  let session: AgentSession | null = null;
  let services: AgentSessionServices | null = null;
  let disposed = false;

  let eventAppendTail: Promise<void> = Promise.resolve();
  const appendEvent = (
    kind: Parameters<SessionStore["append"]>[0],
    data: unknown,
  ): Promise<void> => {
    const operation = eventAppendTail.then(async () => {
      if (store === null || writer === null) {
        return;
      }
      await store.append(kind, data);
    });
    eventAppendTail = operation.catch(() => undefined);
    return operation;
  };

  let retryEventTail: Promise<void> = Promise.resolve();
  let retryEventFailure: unknown = null;
  let unsubscribeRetryEvents: (() => void) | null = null;
  const queueRetryEvent = (event: AgentSessionEvent): void => {
    if (event.type !== "auto_retry_start" && event.type !== "auto_retry_end") {
      return;
    }
    const runId = currentRunId;
    const model = session?.model;
    const modelRef = model === undefined ? null : modelReference(model);
    const kind =
      event.type === "auto_retry_start"
        ? "model/retry_start"
        : "model/retry_end";
    let data: unknown;
    if (event.type === "auto_retry_start") {
      const error = retryErrorEvidence(event.errorMessage, codepunkHome);
      data = {
        run_id: runId,
        model: modelRef,
        attempt: event.attempt,
        max_attempts: event.maxAttempts,
        delay_ms: event.delayMs,
        error_sha256: error.sha256,
        error_preview: error.preview,
      };
    } else {
      const error =
        event.finalError === undefined
          ? null
          : retryErrorEvidence(event.finalError, codepunkHome);
      data = {
        run_id: runId,
        model: modelRef,
        attempt: event.attempt,
        success: event.success,
        final_error_sha256: error?.sha256 ?? null,
        final_error_preview: error?.preview ?? null,
      };
    }
    retryEventTail = retryEventTail
      .then(() => appendEvent(kind, data))
      .catch((error: unknown) => {
        retryEventFailure ??= error;
      });
  };

  const eventAlreadyExists = (
    kind: "run/start" | "run/end",
    runId: string,
  ): boolean =>
    store?.allEvents.some(
      (event) =>
        event.kind === kind &&
        "run_id" in event.data &&
        event.data.run_id === runId,
    ) ?? false;

  let currentRunId = options.runId;
  let runStarted = eventAlreadyExists("run/start", currentRunId);
  let runEnded = eventAlreadyExists("run/end", currentRunId);
  let inputRecorded = false;
  const initialUsage =
    store === null ? null : summarizeModelUsage(store.allEvents);
  let usedTokens = initialUsage?.total_tokens ?? 0;
  let usedCostUsd = initialUsage?.cost_total ?? 0;
  let budgetExceeded =
    (options.budget?.maxTokens !== undefined &&
      usedTokens >= options.budget.maxTokens) ||
    (options.budget?.maxCostUsd !== undefined &&
      usedCostUsd >= options.budget.maxCostUsd);

  const budgetExceededMessage = (): string => {
    const limits: string[] = [];
    if (options.budget?.maxTokens !== undefined) {
      limits.push(`${usedTokens}/${options.budget.maxTokens} tokens`);
    }
    if (options.budget?.maxCostUsd !== undefined) {
      limits.push(`$${usedCostUsd}/$${options.budget.maxCostUsd}`);
    }
    return `session budget exhausted (${limits.join(", ")}); start a new session to continue`;
  };

  const maybeExceedBudget = async (runId: string): Promise<void> => {
    if (budgetExceeded) {
      return;
    }
    const tokenLimit = options.budget?.maxTokens;
    const costLimit = options.budget?.maxCostUsd;
    if (
      (tokenLimit === undefined || usedTokens < tokenLimit) &&
      (costLimit === undefined || usedCostUsd < costLimit)
    ) {
      return;
    }
    budgetExceeded = true;
    const tokenExceeded = tokenLimit !== undefined && usedTokens >= tokenLimit;
    await appendEvent("budget/exceeded", {
      run_id: runId,
      limit_kind: tokenExceeded ? "tokens" : "cost",
      limit: tokenExceeded ? tokenLimit! : costLimit!,
      used: tokenExceeded
        ? usedTokens
        : Math.round(usedCostUsd * 1_000_000) / 1_000_000,
      action: "abort_run",
    });
    const active = session;
    if (active !== null) {
      queueMicrotask(() => {
        void active.abort().catch(() => undefined);
      });
    }
  };

  const syncSessionUsage = (): void => {
    if (session === null) {
      return;
    }
    const stats = session.getSessionStats();
    if (store === null) {
      usedTokens = Math.max(usedTokens, stats.tokens.total);
      usedCostUsd = Math.max(usedCostUsd, stats.cost);
      return;
    }
    const combined = summarizeSessionModelUsage(store.allEvents, {
      ...stats.tokens,
      cost: stats.cost,
    });
    usedTokens = combined.total_tokens;
    usedCostUsd = combined.cost_total;
  };

  let lastAssistantStopReason: string | null = null;
  let beforeStopAttempt = 0;
  let beforeStopBlockedReason: string | null = null;
  let lastMemoryDigestSha: string | null = null;
  let lastRoutedModel: string | null = null;
  let lastDirectModel: string | null = null;
  let wallTimer: NodeJS.Timeout | undefined;
  let wallBudgetExceeded = false;
  const extensionFailures: ExtensionError[] = [];
  const assertNoExtensionFailures = (): void => {
    if (extensionFailures.length === 0) {
      return;
    }
    const first = extensionFailures[0]!;
    throw new HostIsolationError(
      `product extension handler ${first.event} failed: ${first.error}`,
    );
  };

  const beginRun = async (): Promise<void> => {
    assertNoExtensionFailures();
    if (runEnded) {
      currentRunId = createUlid();
      runStarted = false;
      runEnded = false;
      inputRecorded = false;
      lastMemoryDigestSha = null;
      wrapOptions.runId = currentRunId;
    }
    if (runStarted) {
      return;
    }
    lastAssistantStopReason = null;
    beforeStopAttempt = 0;
    beforeStopBlockedReason = null;
    await options.onRunStart?.(currentRunId);
    await appendEvent("run/start", {
      run_id: currentRunId,
      session_id: options.sessionId,
    });
    runStarted = true;
    wallBudgetExceeded = false;
    if (wallTimer !== undefined) {
      clearTimeout(wallTimer);
      wallTimer = undefined;
    }
    const maxWallMs = options.budget?.maxWallMs;
    if (maxWallMs !== undefined) {
      const startedAt = performance.now();
      wallTimer = setTimeout(() => {
        if (runEnded || wallBudgetExceeded) {
          return;
        }
        wallBudgetExceeded = true;
        const used = Math.max(0, Math.round(performance.now() - startedAt));
        void appendEvent("budget/exceeded", {
          run_id: currentRunId,
          limit_kind: "wall_ms",
          limit: maxWallMs,
          used,
          action: "abort_run",
        }).finally(() => {
          void session?.abort().catch(() => undefined);
        });
      }, maxWallMs);
      wallTimer.unref();
    }
  };

  const endRun = async (
    state: "settled" | "failed" | "aborted" | "cancelled" = "settled",
    termination: string | null = null,
  ): Promise<void> => {
    if (!runStarted || runEnded) {
      return;
    }
    if (wallTimer !== undefined) {
      clearTimeout(wallTimer);
      wallTimer = undefined;
    }
    await appendEvent("run/end", {
      run_id: currentRunId,
      state,
      termination,
      evidence_head: options.ledger.head,
      actor: "local-user",
    });
    await options.onRunEnd?.(currentRunId);
    runEnded = true;
  };

  const maybeSummarizeSession = createSessionSummarizer({
    options,
    store,
    getSession: () => session,
    getCurrentRunId: () => currentRunId,
    getLastDirectModel: () => lastDirectModel,
    getLastRoutedModel: () => lastRoutedModel,
    appendEvent,
    syncSessionUsage,
    maybeExceedBudget,
  });

  const context =
    options.context ??
    (await loadContext({
      cwd,
      deliveryRoot: options.deliveryRoot,
      codepunkHome,
      projectTrusted: false,
    }));
  const warnings = context.warnings.map(
    (warning) => `${warning.code}:${warning.source}:${warning.message}`,
  );
  const runtimeFacts = options.runtimeFacts;
  const currentRuntimeEnvironment =
    runtimeFacts === undefined
      ? null
      : (): string =>
          renderRuntimeEnvironment(
            typeof runtimeFacts.now === "function"
              ? runtimeFacts.now()
              : runtimeFacts.now,
            runtimeFacts.timeZone,
          );
  const productHookState: ProductHookState = {
    session: null,
    assertRegistry: () => {},
  };

  const wrapOptions: ToolWrapOptions = {
    ...options,
    cwd,
    runId: currentRunId,
    ...(options.disableUserBash !== undefined
      ? { disableUserBash: options.disableUserBash }
      : {}),
    ...(options.memory !== null && options.memory !== undefined
      ? { memoryCap: options.memory.maxTokens }
      : {}),
    onApprovalAnswer: async (answer) => {
      await appendEvent("approval/answer", answer);
    },
    onPluginToolCall: async (event) => {
      await appendEvent("plugin/tool_call", event);
    },
    onMemorySearch: async (retrieval) => {
      await appendEvent("memory/retrieve", {
        ids: retrieval.ids,
        hashes: retrieval.hashes,
        cap: retrieval.cap,
        truncated: retrieval.truncated,
        digest_sha256: retrieval.digest_sha256,
      });
    },
    onExecutionEvent: async (kind, data) => {
      await appendEvent(kind, data);
    },
    onBudgetAbort: async () => {
      await session?.abort().catch(() => undefined);
    },
  };

  const saveHostAgentState = async (): Promise<AgentState | null> => {
    if (session === null || store === null || writer === null) {
      return null;
    }
    if (session.sessionFile !== undefined) {
      throw new HostIsolationError(
        "Pi session unexpectedly has a persisted session file",
      );
    }
    const header = session.sessionManager.getHeader();
    if (header === null) {
      throw new HostIsolationError("Pi session header is missing");
    }
    return store.saveAgentState(header, session.sessionManager.getBranch(), {
      entries: session.sessionManager.getEntries(),
      leafId: session.sessionManager.getLeafId(),
    });
  };

  const productExtension = createProductExtension({
    options,
    cwd,
    codepunkHome,
    store,
    productHookState,
    currentRuntimeEnvironment,
    extensionFailures,
    assertNoExtensionFailures,
    getSession: () => session,
    getWriter: () => writer,
    getWrapOptions: () => wrapOptions,
    getEventAppendTail: () => eventAppendTail,
    getRetryEventTail: () => retryEventTail,
    getRetryEventFailure: () => retryEventFailure,
    appendEvent,
    beginRun,
    endRun,
    saveHostAgentState,
    maybeSummarizeSession,
    syncSessionUsage,
    maybeExceedBudget,
    isBudgetExceeded: () => budgetExceeded,
    budgetExceededMessage,
    getCurrentRunId: () => currentRunId,
    getInputRecorded: () => inputRecorded,
    setInputRecorded: (value) => {
      inputRecorded = value;
    },
    getLastMemoryDigestSha: () => lastMemoryDigestSha,
    setLastMemoryDigestSha: (value) => {
      lastMemoryDigestSha = value;
    },
    getLastAssistantStopReason: () => lastAssistantStopReason,
    setLastAssistantStopReason: (value) => {
      lastAssistantStopReason = value;
    },
    getBeforeStopAttempt: () => beforeStopAttempt,
    setBeforeStopAttempt: (value) => {
      beforeStopAttempt = value;
    },
    getBeforeStopBlockedReason: () => beforeStopBlockedReason,
    setBeforeStopBlockedReason: (value) => {
      beforeStopBlockedReason = value;
    },
    getLastDirectModel: () => lastDirectModel,
    setLastDirectModel: (value) => {
      lastDirectModel = value;
    },
    getLastRoutedModel: () => lastRoutedModel,
  });

  try {
    if (store !== null) {
      writer = await store.acquireWriter();
      await store.refreshFromDisk();
    }
    let recoverBenignTail = false;
    if (
      store !== null &&
      options.restore !== undefined &&
      options.restore !== null
    ) {
      const coveredSeq = store.metadata.state_covers_seq;
      const lastSeq = store.lastSeq;
      if (coveredSeq > lastSeq) {
        throw new HostIsolationError(
          "benign tail recovery found a snapshot ahead of the session log",
        );
      }
      if (coveredSeq < lastSeq) {
        const recoveryEvents = store.allEvents.filter(
          (event) => event.seq > coveredSeq,
        );
        if (
          recoveryEvents.length === 0 ||
          recoveryEvents.some((event) => !isBenignTailEventKind(event.kind))
        ) {
          throw new HostIsolationError(
            "benign tail recovery cannot verify the session snapshot coverage",
          );
        }
        recoverBenignTail = true;
      }
    }
    if (store !== null) {
      await appendEvent("context/loaded", {
        sources: context.sources,
        warnings,
        total_bytes: context.totalBytes,
        truncated: context.truncated,
      });
    }

    const appendSystemPrompt: string[] = [];
    if (context.instructionBlock.length > 0) {
      appendSystemPrompt.push(context.instructionBlock);
    }
    const extraInstructionIndex = appendSystemPrompt.length;
    if (
      options.extraInstruction !== undefined &&
      options.extraInstruction.length > 0
    ) {
      appendSystemPrompt.push(options.extraInstruction);
    }
    const allowedExtensionPaths = [
      ...(options.extensionPaths ?? []).map((candidate) =>
        normalizeAbsolute(candidate),
      ),
    ];
    services = await createAgentSessionServices({
      cwd,
      agentDir: codepunkHome,
      settingsManager: SettingsManager.inMemory(options.settings ?? {}),
      ...(options.modelRuntime !== undefined
        ? { modelRuntime: options.modelRuntime }
        : {}),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        disabledBuiltinExtensions: ["mcp", "codemode", "tool-search"],
        systemPrompt: "",
        appendSystemPrompt,
        extensionFactories: [
          productExtension,
          ...(options.additionalExtensionFactories ?? []),
        ],
        ...(allowedExtensionPaths.length > 0
          ? { additionalExtensionPaths: [...allowedExtensionPaths] }
          : {}),
      },
    });

    const { sessionModel, fallbackModels, selectableFallbackModels } =
      await configureHostModelSelection({
        options,
        services,
        appendEvent,
        onObservation: (observation) => {
          lastRoutedModel = observation.model;
          if (observation.reason === "direct") {
            lastDirectModel = observation.model;
          }
        },
      });

    const restored =
      options.restore === undefined || options.restore === null
        ? undefined
        : restoreEntries(options.restore, cwd);
    const sessionManager = SessionManager.inMemory(
      cwd,
      store === null ? undefined : { id: store.sessionId },
      restored?.entries as Parameters<typeof SessionManager.inMemory>[2],
    );
    if (restored !== undefined) {
      restoreSessionLeaf(sessionManager, restored);
    }
    if (sessionManager.isPersisted()) {
      throw new HostIsolationError("Pi session manager is persisted");
    }

    const work =
      store === null
        ? null
        : {
            runId: () => currentRunId,
            currentPlan: () => readWorkState(store.allEvents).plan,
            currentTodos: () => readWorkState(store.allEvents).todos,
            persistPlan: async (event: {
              run_id: string;
              steps: PlanStep[];
              explanation: string | null;
              updated_at: string;
              sha256: string;
            }) => {
              await appendEvent("plan/update", event);
            },
            persistTodos: async (event: {
              run_id: string;
              items: TodoItem[];
              updated_at: string;
              sha256: string;
            }) => {
              await appendEvent("todo/update", event);
            },
          };
    const baseDefinitions = createCodepunkToolDefinitions(
      cwd,
      resolveSandbox(options.sandbox),
      {
        mode: options.mode ?? "interactive",
        workspaceRoot: options.workspaceRoot,
        codepunkHome,
        ...(options.projectTrusted !== undefined
          ? { projectTrusted: options.projectTrusted }
          : {}),
        ...(options.additionalRoots !== undefined
          ? { additionalRoots: options.additionalRoots }
          : {}),
        ...(options.enabledTools !== undefined
          ? { enabledTools: options.enabledTools }
          : {}),
        ...(options.networkDeniedDomains !== undefined
          ? { networkDeny: options.networkDeniedDomains }
          : {}),
        ...(options.questionChannel !== undefined
          ? { questionChannel: options.questionChannel }
          : {}),
        ...(options.subagentExecutor !== undefined
          ? { subagentExecutor: options.subagentExecutor }
          : {}),
        memory: options.memory ?? null,
        work,
      },
    );
    const buildExtraDefinitions = (
      rawExtra: readonly ToolDefinition<any, any, any>[],
    ): ToolDefinition<any, any, any>[] => {
      if (!shouldDeferMcpTools(rawExtra, options.lazyMcp)) {
        return [...rawExtra];
      }
      const deferredExtra = rawExtra.map((definition) =>
        definition.name.startsWith("mcp__")
          ? { ...definition, exposure: "deferred" as const }
          : definition,
      );
      return [createToolSearchTool(() => session), ...deferredExtra];
    };
    const definitions = [
      ...baseDefinitions,
      ...buildExtraDefinitions(options.extraTools ?? []),
    ];
    const wrapped = await wrapToolDefinitions(definitions, wrapOptions);
    const mcpToolPatterns = [
      "mcp__*",
      "plugin__*",
      TOOL_SEARCH_TOOL_NAME,
      ...[...MCP_RESOURCE_TOOL_NAMES].filter(
        (name) => !wrapped.some((definition) => definition.name === name),
      ),
    ];
    const activeNames = [
      ...new Set([
        ...wrapped
          .filter((definition) => definition.exposure !== "deferred")
          .map((definition) => definition.name),
        ...mcpToolPatterns,
      ]),
    ];
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      tools: activeNames,
      noTools: "all",
      excludeTools: ["codemode"],
      customTools: wrapped,
      ...(sessionModel !== undefined ? { model: sessionModel } : {}),
      ...(options.thinkingLevel !== undefined
        ? { thinkingLevel: options.thinkingLevel }
        : {}),
    });
    session = created.session;
    unsubscribeRetryEvents = session.subscribe(queueRetryEvent);
    syncSessionUsage();
    budgetExceeded =
      budgetExceeded ||
      (options.budget?.maxTokens !== undefined &&
        usedTokens >= options.budget.maxTokens) ||
      (options.budget?.maxCostUsd !== undefined &&
        usedCostUsd >= options.budget.maxCostUsd);
    if (selectableFallbackModels.length > 0) {
      session.setScopedModels(
        selectableFallbackModels.map((model) => ({ model })),
      );
    }
    productHookState.session = session;
    const validate = () => {
      assertNoExtensionFailures();
      if (session === null) {
        throw new HostIsolationError("Pi session is not ready");
      }
      assertHostResources(services!, allowedExtensionPaths);
      return assertWrappedToolRegistry(session, wrapped);
    };
    productHookState.assertRegistry = () => {
      validate();
    };
    const transformContext = session.agent.transformContext;
    session.agent.transformContext = async (messages, signal) => {
      validate();
      const transformed = transformContext
        ? await transformContext(messages, signal)
        : messages;
      if (options.truncation === null) {
        return transformed;
      }
      const contextWindow = session?.model?.contextWindow;
      if (
        contextWindow === undefined ||
        !Number.isSafeInteger(contextWindow) ||
        contextWindow <= 0
      ) {
        return transformed;
      }
      const threshold = Math.min(
        1,
        Math.max(0, options.truncationThreshold ?? 0.8),
      );
      return truncateContextAtTurnBoundary(transformed, {
        maxTokens: Math.floor(contextWindow * threshold),
      }).messages;
    };
    await session.bindExtensions({
      mode: options.bindMode ?? "print",
      onError: (error) => {
        extensionFailures.push(error);
      },
    });
    validate();
    if (
      store !== null &&
      (recoverBenignTail || restored?.migratedHeaderId === true)
    ) {
      await eventAppendTail;
      await saveHostAgentState();
      if (
        recoverBenignTail &&
        store.metadata.state_covers_seq !== store.metadata.log_seq
      ) {
        throw new HostIsolationError(
          "benign tail recovery did not cover the current session log",
        );
      }
    }

    const wrappedToolNames = wrapped.map((definition) => definition.name);
    const replaceExtraTools = async (
      tools: readonly ToolDefinition<any, any, any>[],
    ): Promise<void> => {
      if (session === null) {
        throw new HostIsolationError("Pi session is not ready");
      }
      const preparedExtra = buildExtraDefinitions(tools);
      const wrappedExtra = await wrapToolDefinitions(
        preparedExtra,
        wrapOptions,
      );
      wrapped.splice(
        baseDefinitions.length,
        wrapped.length - baseDefinitions.length,
        ...wrappedExtra,
      );
      wrappedToolNames.splice(
        0,
        wrappedToolNames.length,
        ...wrapped.map((definition) => definition.name),
      );
    };
    const replaceExtraInstruction = (text: string): void => {
      if (appendSystemPrompt.length > extraInstructionIndex) {
        if (text.length === 0) {
          appendSystemPrompt.splice(extraInstructionIndex);
        } else {
          appendSystemPrompt[extraInstructionIndex] = text;
        }
        return;
      }
      if (text.length > 0) {
        appendSystemPrompt.push(text);
      }
    };
    const replaceExtensionPaths = (paths: readonly string[]): void => {
      const normalized = paths.map((candidate) => normalizeAbsolute(candidate));
      const loaderPaths = additionalExtensionPaths(services?.resourceLoader);
      allowedExtensionPaths.splice(
        0,
        allowedExtensionPaths.length,
        ...normalized,
      );
      loaderPaths.splice(0, loaderPaths.length, ...normalized);
    };

    return {
      session,
      services,
      sessionManager,
      wrappedToolNames,
      primaryModel:
        sessionModel !== undefined && !isFallbackModel(sessionModel)
          ? sessionModel
          : options.model,
      fallbackModels,
      get currentRunId(): string {
        return currentRunId;
      },
      replaceExtraTools,
      replaceExtraInstruction,
      replaceExtensionPaths,
      validateToolRegistry: validate,
      beginRun,
      endRun,
      saveAgentState: saveHostAgentState,
      async recordEvent(kind, data): Promise<void> {
        await appendEvent(kind, data);
      },
      async executeProductToolAsPlugin(input) {
        if (session === null) {
          throw new HostIsolationError("Pi session is not ready");
        }
        const baseDefinition = baseDefinitions.find(
          (definition) => definition.name === input.toolName,
        );
        if (baseDefinition === undefined) {
          return {
            result: {
              content: [
                {
                  type: "text",
                  text: `denied: plugin.capability_denied (tool ${input.toolName} is not available)`,
                },
              ],
              details: {},
              isError: true,
            },
            decision: "deny",
            rule: "plugin.capability_denied",
            reason: `tool ${input.toolName} is not available`,
          };
        }
        let observedOutcome: {
          decision: "allow" | "deny";
          rule: string;
          reason: string | null;
        } = {
          decision: "deny",
          rule: "policy.default",
          reason: "tool did not complete",
        };
        const additionalRoots = [
          ...new Set([
            ...(wrapOptions.additionalRoots ?? []),
            ...input.manifest.readRoots,
            ...input.manifest.writeRoots,
          ]),
        ];
        const writeSet = [
          ...new Set([
            ...(wrapOptions.writeSet ?? []),
            ...input.manifest.writeRoots,
          ]),
        ];
        const pluginWrapped = await wrapToolDefinition(baseDefinition, {
          ...wrapOptions,
          runId: currentRunId,
          additionalRoots,
          writeSet,
          pluginMeta: {
            pluginId: input.manifest.id,
            pluginManifestSha256: input.manifest.manifestSha256,
          },
          onToolOutcome: (outcome) => {
            observedOutcome = outcome;
          },
        });
        const result = await pluginWrapped.execute(
          input.toolCallId,
          input.params,
          input.signal,
          undefined,
          { cwd } as ExtensionToolContext,
        );
        return {
          result,
          decision: observedOutcome.decision,
          rule: observedOutcome.rule,
          reason: observedOutcome.reason,
        };
      },
      async dispose(): Promise<void> {
        if (disposed) {
          return;
        }
        disposed = true;
        let failure: unknown;
        try {
          if (session !== null) {
            await session.abort().catch(() => undefined);
            await session.waitForIdle().catch(() => undefined);
            await retryEventTail;
            unsubscribeRetryEvents?.();
            unsubscribeRetryEvents = null;
            if (retryEventFailure !== null) {
              failure ??= retryEventFailure;
            }
            await endRun("cancelled", "host_dispose").catch((error) => {
              failure ??= error;
            });
            await saveHostAgentState().catch((error) => {
              failure ??= error;
            });
            session.dispose();
          }
        } catch (error) {
          failure = error;
        } finally {
          unsubscribeRetryEvents?.();
          unsubscribeRetryEvents = null;
          try {
            await assertNoPiSessionFiles(codepunkHome);
            await writer?.release();
          } finally {
            restoreEnvironment();
            if (options.closeSandbox !== false) {
              await resolveSandbox(options.sandbox)?.close?.();
            }
          }
        }
        if (failure !== undefined) {
          throw failure;
        }
      },
    };
  } catch (error) {
    unsubscribeRetryEvents?.();
    unsubscribeRetryEvents = null;
    session?.dispose();
    await writer?.release().catch(() => {});
    restoreEnvironment();
    if (options.closeSandbox !== false) {
      await resolveSandbox(options.sandbox)
        ?.close?.()
        .catch(() => {});
    }
    throw error;
  }
}

export type { CodepunkToolName };
