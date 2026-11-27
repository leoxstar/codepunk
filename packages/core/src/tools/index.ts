import {
  createBashToolDefinition,
  createWriteToolDefinition,
  type AgentToolResult,
  type BashOperations,
  type BashToolDetails,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createEnhancedEditToolDefinition,
  extractEditReplacements,
  resolveIndentationFallbackEdits,
  type EditReplacement,
  type IndentationFallbackResolution,
} from "./enhanced-edit.ts";
import {
  createEnhancedReadToolDefinition,
  extractCodeOutline,
  formatCodeOutline,
  type OutlineEntry,
} from "./enhanced-read.ts";
import { createMemorySearchTool, type MemoryManager } from "../memory/index.ts";
import { createSearchTool } from "../search/index.ts";
import { createWebFetchTool } from "../webfetch/index.ts";
import { createWebSearchTool } from "../websearch/index.ts";
import { createAskUserTool, type AskUserChannel } from "./ask-user.ts";
import { createSubagentTool, type SubagentToolExecutor } from "./subagent.ts";
import {
  DEFAULT_TOOL_SEARCH_LIMIT,
  LAZY_MCP_TOOL_THRESHOLD,
  TOOL_SEARCH_TOOL_NAME,
  createToolSearchTool,
  rankDeferredTools,
  shouldDeferMcpTools,
  type RankedDeferredTool,
  type ToolSearchCandidate,
  type ToolSearchNamespace,
  type ToolSearchRegistry,
} from "./tool-search.ts";
import {
  createPlanTool,
  createTodoTool,
  type TodoState,
  type WorkState,
} from "../work/index.ts";
import {
  agentShellEnvironment,
  type ShellExecutionResult,
  type ShellProvider,
} from "../sandbox/index.ts";

export const CODEPUNK_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "exec",
  "search",
  "memory_search",
  "web_fetch",
  "web_search",
  "ask_user",
  "subagent",
  "plan",
  "todo",
  "tool_search",
] as const;
export const HEADLESS_EXEC_TOOL_NAME = "exec" as const;
export type CodepunkToolName = (typeof CODEPUNK_TOOL_NAMES)[number];

export interface ToolExecutionPolicy {
  sideEffect: "none" | "read" | "write" | "external";
  idempotent: boolean;
  resultBudgetBytes: number;
  retry: "never" | "safe";
}

export const TOOL_EXECUTION_POLICIES: Readonly<
  Record<CodepunkToolName, ToolExecutionPolicy>
> = {
  read: {
    sideEffect: "read",
    idempotent: true,
    resultBudgetBytes: 256 * 1_024,
    retry: "never",
  },
  write: {
    sideEffect: "write",
    idempotent: true,
    resultBudgetBytes: 64 * 1_024,
    retry: "safe",
  },
  edit: {
    sideEffect: "write",
    idempotent: true,
    resultBudgetBytes: 64 * 1_024,
    retry: "safe",
  },
  bash: {
    sideEffect: "external",
    idempotent: false,
    resultBudgetBytes: 256 * 1_024,
    retry: "never",
  },
  exec: {
    sideEffect: "external",
    idempotent: false,
    resultBudgetBytes: 256 * 1_024,
    retry: "never",
  },
  search: {
    sideEffect: "read",
    idempotent: true,
    resultBudgetBytes: 256 * 1_024,
    retry: "never",
  },
  memory_search: {
    sideEffect: "read",
    idempotent: true,
    resultBudgetBytes: 128 * 1_024,
    retry: "never",
  },
  web_fetch: {
    sideEffect: "external",
    idempotent: false,
    resultBudgetBytes: 256 * 1_024,
    retry: "never",
  },
  web_search: {
    sideEffect: "external",
    idempotent: true,
    resultBudgetBytes: 128 * 1_024,
    retry: "never",
  },
  ask_user: {
    sideEffect: "none",
    idempotent: false,
    resultBudgetBytes: 16 * 1_024,
    retry: "never",
  },
  subagent: {
    sideEffect: "read",
    idempotent: false,
    resultBudgetBytes: 64 * 1_024,
    retry: "never",
  },
  plan: {
    sideEffect: "write",
    idempotent: false,
    resultBudgetBytes: 16 * 1_024,
    retry: "never",
  },
  todo: {
    sideEffect: "write",
    idempotent: false,
    resultBudgetBytes: 16 * 1_024,
    retry: "never",
  },
  tool_search: {
    sideEffect: "none",
    idempotent: false,
    resultBudgetBytes: 32 * 1_024,
    retry: "never",
  },
};

export function toolExecutionPolicy(name: string): ToolExecutionPolicy {
  return (
    TOOL_EXECUTION_POLICIES[name as CodepunkToolName] ?? {
      sideEffect: "external",
      idempotent: false,
      resultBudgetBytes: 256 * 1_024,
      retry: "never",
    }
  );
}

export {
  DEFAULT_TOOL_SEARCH_LIMIT,
  LAZY_MCP_TOOL_THRESHOLD,
  TOOL_SEARCH_TOOL_NAME,
  createToolSearchTool,
  rankDeferredTools,
  shouldDeferMcpTools,
  type RankedDeferredTool,
  type ToolSearchCandidate,
  type ToolSearchNamespace,
  type ToolSearchRegistry,
};

export {
  createEnhancedEditToolDefinition,
  extractEditReplacements,
  resolveIndentationFallbackEdits,
  type EditReplacement,
  type IndentationFallbackResolution,
};
export {
  createEnhancedReadToolDefinition,
  extractCodeOutline,
  formatCodeOutline,
  type OutlineEntry,
};
export { createAskUserTool, type AskUserChannel } from "./ask-user.ts";
export { createSubagentTool, type SubagentToolExecutor } from "./subagent.ts";

export interface BashObservation {
  command: string;
  cwd: string;
  result: ShellExecutionResult;
}

export interface WorkToolOptions {
  runId: string | (() => string);
  now?: () => Date;
  currentPlan?: () => WorkState | null;
  currentTodos?: () => TodoState | null;
  persistPlan: Parameters<typeof createPlanTool>[0]["persist"];
  persistTodos: Parameters<typeof createTodoTool>[0]["persist"];
}

export function createSandboxBashOperations(
  sandbox: ShellProvider,
  onComplete?: (observation: BashObservation) => Promise<void>,
): BashOperations {
  return {
    async exec(command, cwd, options) {
      const executionOptions = {
        onData: options.onData,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        env: agentShellEnvironment(options.env),
      };
      const result = await sandbox.execCommand(command, cwd, executionOptions);
      if (onComplete !== undefined) {
        await onComplete({ command, cwd, result });
      }
      if (result.cancelled) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return { exitCode: result.exitCode };
    },
  };
}

export function createCodepunkToolDefinitions(
  cwd: string,
  sandbox: ShellProvider | null,
  options: {
    mode?: "interactive" | "headless" | "worker";
    enabledTools?: readonly string[];
    memory?: MemoryManager | null;
    workspaceRoot?: string;
    additionalRoots?: readonly string[];
    work?: WorkToolOptions | null;
    /** Operator-denied domains applied to every web_fetch and web_search call. */
    networkDeny?: readonly string[];
    questionChannel?: AskUserChannel | null;
    subagentExecutor?: SubagentToolExecutor | null;
    webSearchEndpoint?: string;
    environment?: NodeJS.ProcessEnv;
  } = {},
): ToolDefinition<any, any, any>[] {
  const defaultEnabled: string[] = [
    "read",
    "write",
    "edit",
    options.mode === "headless" ? "exec" : "bash",
  ];
  if (options.work !== null && options.work !== undefined) {
    defaultEnabled.push("plan", "todo");
  }
  const enabled = new Set(options.enabledTools ?? defaultEnabled);
  const all: ToolDefinition<any, any, any>[] = [
    createEnhancedReadToolDefinition(cwd),
    createWriteToolDefinition(cwd) as ToolDefinition<any, any, any>,
    createEnhancedEditToolDefinition(cwd),
    createSearchTool({
      cwd,
      ...(options.workspaceRoot !== undefined
        ? { workspaceRoot: options.workspaceRoot }
        : {}),
      ...(options.additionalRoots !== undefined
        ? { additionalRoots: options.additionalRoots }
        : {}),
    }),
  ];
  if (sandbox !== null && options.mode !== "headless") {
    all.push(
      createBashToolDefinition(cwd, {
        operations: createSandboxBashOperations(sandbox),
        exposeSessionEnvironment: false,
      }) as ToolDefinition<any, BashToolDetails | undefined, any>,
    );
  }
  if (sandbox !== null && options.mode === "headless") {
    all.push(createHeadlessExecToolDefinition(cwd, sandbox));
  }
  if (
    options.mode !== "worker" &&
    options.memory !== null &&
    options.memory !== undefined
  ) {
    all.push(createMemorySearchTool(options.memory));
  }
  all.push(
    createWebFetchTool(
      options.networkDeny === undefined
        ? {}
        : { deniedDomains: options.networkDeny },
    ),
    createWebSearchTool({
      ...(options.networkDeny === undefined
        ? {}
        : { deniedDomains: options.networkDeny }),
      ...(options.webSearchEndpoint === undefined
        ? {}
        : { endpoint: options.webSearchEndpoint }),
      ...(options.environment === undefined
        ? {}
        : { environment: options.environment }),
    }),
  );
  if (options.mode !== "worker" && options.mode !== "headless") {
    all.push(
      createAskUserTool(options.questionChannel ?? null),
      createSubagentTool(options.subagentExecutor ?? null),
    );
  }
  if (options.work !== null && options.work !== undefined) {
    all.push(
      createPlanTool({
        runId: options.work.runId,
        ...(options.work.now !== undefined ? { now: options.work.now } : {}),
        persist: options.work.persistPlan,
      }),
      createTodoTool({
        runId: options.work.runId,
        ...(options.work.now !== undefined ? { now: options.work.now } : {}),
        ...(options.work.currentTodos !== undefined
          ? { current: options.work.currentTodos }
          : {}),
        persist: options.work.persistTodos,
      }),
    );
  }
  return all.filter((tool) => enabled.has(tool.name));
}

type ExecToolResult = AgentToolResult<{
  executor: "srt" | "direct";
  profile_sha256: string;
}>;

function execTextResult(text: string): ExecToolResult {
  return {
    content: [{ type: "text", text }],
    details: {
      executor: "srt",
      profile_sha256: "",
    },
    isError: true,
  };
}

function execOutputResult(result: ShellExecutionResult): ExecToolResult {
  const text = result.output.length > 0 ? result.output : "(no output)";
  const isError =
    result.cancelled ||
    result.timedOut ||
    result.exitCode === null ||
    result.exitCode !== 0;
  return {
    content: [{ type: "text", text }],
    details: {
      executor: result.executor,
      profile_sha256: result.descriptor.profile_sha256 ?? "",
    },
    structuredContent: {
      output: result.output,
      exit_code: result.exitCode,
      cancelled: result.cancelled,
      timed_out: result.timedOut,
      truncated: false,
    },
    ...(isError ? { isError: true } : {}),
  };
}

export function createHeadlessExecToolDefinition(
  cwd: string,
  sandbox: ShellProvider,
): ToolDefinition<any, any, any> {
  return {
    name: HEADLESS_EXEC_TOOL_NAME,
    label: "exec",
    description: "Execute an explicitly approved argv without a shell.",
    promptSnippet:
      "Run an explicitly approved argv in the sandbox; no shell expansion",
    parameters: {
      type: "object",
      properties: {
        argv: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        timeout: { type: "number", minimum: 1 },
      },
      required: ["argv"],
      additionalProperties: false,
    } as never,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
    ): Promise<ExecToolResult> {
      const argv = params["argv"];
      if (
        !Array.isArray(argv) ||
        argv.length === 0 ||
        argv.some((value) => typeof value !== "string" || value.length === 0)
      ) {
        return execTextResult("exec requires a non-empty argv of strings");
      }
      const timeout = params["timeout"];
      if (
        timeout !== undefined &&
        (typeof timeout !== "number" || timeout <= 0)
      ) {
        return execTextResult("exec timeout must be a positive number");
      }
      try {
        const result = await sandbox.execArgv(argv as string[], cwd, {
          ...(signal !== undefined ? { signal } : {}),
          ...(timeout !== undefined ? { timeout } : {}),
          env: agentShellEnvironment(),
        });
        return execOutputResult(result);
      } catch (error) {
        return execTextResult(
          `exec failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
}
