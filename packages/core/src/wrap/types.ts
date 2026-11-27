import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ApprovalAnswer, SandboxDescriptor } from "codepunk-protocol";
import type { ApprovalBroker } from "../approval/index.ts";
import type { AutonomyController } from "../autonomy/index.ts";
import type { CheckpointStore, ShadowGitStore } from "../checkpoints/index.ts";
import type { ApprovalMode } from "../config/index.ts";
import type { EvidenceLedgerPort } from "../evidence/index.ts";
import type {
  PolicyLayerInput,
  PolicyMode,
  PolicyRule,
} from "../policy/index.ts";
import type { ActionReviewer } from "../reviewer/index.ts";
import type { ShellProvider } from "../sandbox/index.ts";
import type { PlanModeState, WorkState } from "../work/index.ts";

export const NONE_SANDBOX: SandboxDescriptor = {
  backend: "none",
  version: null,
  profile_sha256: null,
};

export interface FileSnapshot {
  exists: boolean;
  bytes: Buffer;
  sha256: string;
  mode: number | null;
}

export type AnyToolDefinition = ToolDefinition<any, any, any>;
export type AnyToolResult = AgentToolResult<any>;

export interface ToolLifecycleHookInput {
  tool: string;
  tool_call_id: string;
  args_sha256: string;
  args_preview: string;
}

export interface ToolLifecycleHookResult extends ToolLifecycleHookInput {
  is_error: boolean;
  output_sha256: string;
  duration_ms: number;
}

export interface TaintOrigin {
  tool: "web_fetch" | "web_search";
  source: string;
}

export interface ToolExecutionState {
  runId: string | null;
  usedToolCalls: number;
  wallStartedAt: number;
  lastLoopFingerprint: string | null;
  repeatCount: number;
  idempotentResults: Map<string, string>;
  taintedBy: TaintOrigin | null;
}

export interface ToolWrapOptions {
  cwd: string;
  workspaceRoot: string;
  /** Explicit extra file roots; project resources are never loaded from them. */
  additionalRoots?: readonly string[];
  deliveryRoot: string;
  codepunkHome: string;
  sessionId: string;
  runId: string;
  taskId?: string | null;
  writeSet?: readonly string[];
  readableSkillFiles?: readonly string[];
  filesystem?: "workspace" | "full";
  mode?: PolicyMode;
  userRules?: readonly PolicyRule[];
  projectRules?: readonly PolicyRule[];
  layers?: readonly PolicyLayerInput[];
  approval?: ApprovalBroker | null;
  reviewer?: ActionReviewer | null;
  autonomy?: AutonomyController | null;
  approvalMode?: ApprovalMode | (() => ApprovalMode);
  planMode?: () => PlanModeState | null;
  currentPlan?: () => WorkState | null;
  /** Operator-configured egress allowlist; used to explain network approvals. */
  networkAllowedDomains?: readonly string[];
  /** Operator-configured egress deny list; shown in the same explanation. */
  networkDeniedDomains?: readonly string[];
  ledger: EvidenceLedgerPort;
  sandbox?: ShellProvider | null | (() => ShellProvider | null);
  forceShellApproval?: () => boolean;
  userBashUnsandboxed?: () => boolean;
  shellUnavailableReason?: string | (() => string);
  workerId?: string;
  disableUserBash?: boolean;
  memoryCap?: number;
  artifactsDir?: string;
  artifactThresholdTokens?: number;
  maxToolOutputTokens?: number;
  /**
   * Optional bounded file snapshots for `/undo` and `/redo`. Snapshot capture
   * is deliberately best-effort: a full or oversized store must not fail the
   * file mutation itself. External shell edits remain outside this boundary.
   */
  checkpoints?: CheckpointStore | null;
  shadowGit?: ShadowGitStore | null;
  projectTrusted?: () => boolean;
  verifyExec?: (
    argv: readonly string[],
    cwd: string,
  ) => Promise<string | null> | string | null;
  now?: () => Date;
  onApprovalAnswer?: (answer: ApprovalAnswer) => Promise<void> | void;
  onMemorySearch?: (retrieval: {
    ids: string[];
    hashes: string[];
    query_sha256: string;
    cap: number;
    truncated: boolean;
    digest_sha256: string;
  }) => Promise<void> | void;
  onUserBashResult?: (result: {
    command: string;
    output: string;
    exitCode: number | null;
    cancelled: boolean;
    timedOut: boolean;
  }) => Promise<void> | void;
  onUserBashFailure?: (message: string) => Promise<void> | void;
  budget?: {
    maxToolCalls?: number;
    maxWallMs?: number;
  };
  onExecutionEvent?: (
    kind:
      | "loop_guard"
      | "budget/exceeded"
      | "network/request"
      | "network/redirect"
      | "network/rejected",
    data: unknown,
  ) => Promise<void> | void;
  onBudgetAbort?: () => Promise<void> | void;
  beforeToolHook?: (input: ToolLifecycleHookInput) => Promise<void> | void;
  afterToolHook?: (input: ToolLifecycleHookResult) => Promise<void> | void;
  verifyToolResult?: (input: {
    tool: string;
    params: Record<string, unknown>;
    target: string | null;
    before: FileSnapshot;
    after: FileSnapshot;
    result: AnyToolResult;
  }) =>
    | Promise<{ result: "pass" | "fail"; reason: string | null }>
    | { result: "pass" | "fail"; reason: string | null };
}
