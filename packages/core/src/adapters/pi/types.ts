import type {
  AgentSession,
  AgentSessionServices,
  InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ToolDefinition,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import type { AgentState } from "codepunk-protocol";
import type { ContextBundle } from "../../context/index.ts";
import type { MemoryManager } from "../../memory/index.ts";
import type { SessionStore } from "../../session/index.ts";
import type { PluginManifest } from "../../plugin/manifest.ts";
import type { AskUserChannel } from "../../tools/ask-user.ts";
import type { SubagentToolExecutor } from "../../tools/subagent.ts";
import type { AnyToolResult, ToolWrapOptions } from "../../wrap/index.ts";

export class HostIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostIsolationError";
  }
}

export type ExtensionPathLoader = {
  additionalExtensionPaths?: string[];
};

export interface ToolRegistrySnapshot {
  active: string[];
  registered: string[];
  wrapped: string[];
}

export interface CreatePiHostOptions extends ToolWrapOptions {
  sessionStore?: SessionStore | null;
  context?: ContextBundle;
  restore?: AgentState | null;
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  model?: NonNullable<
    Parameters<typeof createAgentSessionFromServices>[0]["model"]
  >;
  modelRuntime?: ModelRuntime;
  fallbackModels?: readonly string[];
  fallbackAllowCrossProvider?: boolean;
  thinkingLevel?: NonNullable<
    Parameters<typeof createAgentSessionFromServices>[0]["thinkingLevel"]
  >;
  closeSandbox?: boolean;
  extensionPaths?: readonly string[];
  bindMode?: "print" | "tui" | "json" | "rpc";
  enabledTools?: readonly string[];
  memory?: MemoryManager | null;
  autoMemorySummary?: boolean;
  disableUserBash?: boolean;
  truncation?: "turn-boundary" | null;
  truncationThreshold?: number;
  onRunStart?: (runId: string) => Promise<void> | void;
  onRunEnd?: (runId: string) => Promise<void> | void;
  beforeStopHook?: (input: {
    run_id: string;
    session_id: string;
    cwd: string;
    attempt: number;
  }) => Promise<void> | void;
  maxBeforeStopRetries?: number;
  additionalExtensionFactories?: readonly InlineExtension[];
  extraTools?: readonly ToolDefinition<any, any, any>[];
  lazyMcp?: boolean;
  questionChannel?: AskUserChannel | null;
  subagentExecutor?: SubagentToolExecutor | null;
  extraInstruction?: string;
  runtimeFacts?: {
    now: Date | (() => Date);
    timeZone?: string;
  };
  budget?: {
    maxTokens?: number;
    maxCostUsd?: number;
    maxToolCalls?: number;
    maxWallMs?: number;
  };
}

export interface PiHost {
  session: AgentSession;
  services: AgentSessionServices;
  sessionManager: SessionManager;
  wrappedToolNames: readonly string[];
  primaryModel:
    | NonNullable<Parameters<typeof createAgentSessionFromServices>[0]["model"]>
    | undefined;
  fallbackModels: readonly string[];
  readonly currentRunId: string;
  /**
   * Replace the tool definitions appended after Codepunk's own tool surface.
   * Pi keeps a reference to the custom-tool array, so callers that then invoke
   * `session.reload()` get a rebuilt registry without reaching into Pi's
   * private registry state.
   */
  replaceExtraTools(
    tools: readonly ToolDefinition<any, any, any>[],
  ): Promise<void>;
  /**
   * Replace the user-plugin extension paths used by Pi's resource loader.
   * `session.reload()` then re-discovers and rebinds those extensions without
   * replacing the Codepunk session or its evidence chain.
   */
  replaceExtensionPaths(paths: readonly string[]): void;
  /**
   * Replace the product-owned append-system-prompt block. Pi keeps a
   * reference to the array passed to its resource loader, so a later
   * `session.reload()` rebuilds the prompt from the new text without
   * replacing the session or its evidence chain.
   */
  replaceExtraInstruction(text: string): void;
  validateToolRegistry(): ToolRegistrySnapshot;
  beginRun(): Promise<void>;
  endRun(
    state?: "settled" | "failed" | "aborted" | "cancelled",
    termination?: string | null,
  ): Promise<void>;
  saveAgentState(): Promise<AgentState | null>;
  recordEvent(
    kind: Parameters<SessionStore["append"]>[0],
    data: unknown,
  ): Promise<void>;
  executeProductToolAsPlugin(input: {
    manifest: PluginManifest;
    toolCallId: string;
    toolName: string;
    params: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<{
    result: AnyToolResult;
    decision: "allow" | "deny";
    rule: string;
    reason: string | null;
  }>;
  dispose(): Promise<void>;
}

export interface ProductHookState {
  session: AgentSession | null;
  assertRegistry: () => void;
}

export interface RestoredPiEntries {
  entries: unknown[];
  activeBranch: unknown[];
  leafId?: string | null;
  migratedHeaderId: boolean;
}
