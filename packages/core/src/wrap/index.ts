import { promises as fs } from "node:fs";
import path from "node:path";
import {
  generateUnifiedPatch,
  type AgentToolResult,
  type BashOperations,
  type ExtensionToolContext,
  type ToolDefinition,
  type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import type {
  ApprovalAnswer,
  AutonomyEvidence,
  EvidenceRecord,
  PolicyDecision,
  SandboxDescriptor,
} from "codepunk-protocol";
import { validateSchema } from "codepunk-protocol";
import type { ApprovalBroker } from "../approval/index.ts";
import type { ApprovalResult } from "../approval/index.ts";
import type { CheckpointStore } from "../checkpoints/index.ts";
import type { ActionReviewer, ReviewResult } from "../reviewer/index.ts";
import { AutonomyController, isShellLauncher } from "../autonomy/index.ts";
import {
  boundedToolOutput,
  estimateTextTokens,
  redactOutputPreview,
  writeToolOutputArtifact,
  type ToolOutputArtifact,
} from "../artifacts/index.ts";
import type { ApprovalMode } from "../config/index.ts";
import {
  EvidenceLedger,
  fileContentHash,
  outputSha,
} from "../evidence/index.ts";
import { canonicalJson, recordHash, sha256Text } from "../platform/hash.ts";
import {
  normalizeAbsolute,
  relativeDisplayPath,
  resolveRealPath,
} from "../platform/path.ts";
import {
  coverageFor,
  decidePolicy,
  effectsForTool,
  isMcpProductTool,
  policyRequestForCall,
  simpleShellArgv,
  type PolicyLayerInput,
  type PolicyMode,
  type PolicyRule,
} from "../policy/index.ts";
import {
  canReviewerResolveApproval,
  resolvePermissionGate,
  shellUnavailableReason as defaultShellUnavailableReason,
} from "../permissions/index.ts";
import { agentShellEnvironment, type ShellProvider } from "../sandbox/index.ts";
import { toolExecutionPolicy } from "../tools/index.ts";

const NONE_SANDBOX: SandboxDescriptor = {
  backend: "none",
  version: null,
  profile_sha256: null,
};

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
  /** Operator-configured egress allowlist; used to explain network approvals. */
  networkAllowedDomains?: readonly string[];
  /** Operator-configured egress deny list; shown in the same explanation. */
  networkDeniedDomains?: readonly string[];
  ledger: EvidenceLedger;
  sandbox?: ShellProvider | null;
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

type AnyToolDefinition = ToolDefinition<any, any, any>;
type AnyToolResult = AgentToolResult<any>;

export interface ToolExecutionState {
  runId: string | null;
  usedToolCalls: number;
  wallStartedAt: number;
  lastLoopFingerprint: string | null;
  repeatCount: number;
  idempotentResults: Map<string, string>;
}

const executionStates = new WeakMap<object, ToolExecutionState>();

function executionStateFor(options: ToolWrapOptions): ToolExecutionState {
  let state = executionStates.get(options);
  if (state === undefined) {
    state = {
      runId: null,
      usedToolCalls: 0,
      wallStartedAt: performance.now(),
      lastLoopFingerprint: null,
      repeatCount: 0,
      idempotentResults: new Map(),
    };
    executionStates.set(options, state);
  }
  if (state.runId !== options.runId) {
    state.runId = options.runId;
    state.usedToolCalls = 0;
    state.wallStartedAt = performance.now();
    state.lastLoopFingerprint = null;
    state.repeatCount = 0;
  }
  return state;
}

interface FileSnapshot {
  exists: boolean;
  bytes: Buffer;
  sha256: string;
  mode: number | null;
}

function emptySnapshot(): FileSnapshot {
  const bytes = Buffer.alloc(0);
  return {
    exists: false,
    bytes,
    sha256: fileContentHash(bytes),
    mode: null,
  };
}

function isShellTool(name: string): boolean {
  return name === "bash" || name === "exec" || name === "user_bash";
}

function canonicalShellArgv(
  tool: string,
  params: Record<string, unknown>,
  rawCommand?: string,
): string[] | null {
  if (tool === "exec") {
    return argvParam(params);
  }
  if (tool !== "bash" && tool !== "user_bash") {
    return null;
  }
  const command =
    rawCommand ??
    (typeof params["command"] === "string" ? params["command"] : null);
  if (command === null || command.length === 0) {
    return null;
  }
  return simpleShellArgv(command) ?? ["<raw-shell>", command];
}

function loopFingerprint(
  tool: string,
  argv: readonly string[],
  cwd: string,
): string {
  return sha256Text(
    canonicalJson({
      tool,
      canonical_argv: [...argv],
      cwd: normalizeAbsolute(cwd),
    }),
  );
}

function mutationIdempotencyKey(
  tool: string,
  target: string | null,
  params: Record<string, unknown>,
): string | null {
  if (target === null || (tool !== "write" && tool !== "edit")) {
    return null;
  }
  if (tool === "write" && typeof params["content"] === "string") {
    return sha256Text(
      canonicalJson({
        tool,
        path: target,
        content_sha256: sha256Text(params["content"]),
      }),
    );
  }
  if (tool === "edit" && Array.isArray(params["edits"])) {
    return sha256Text(
      canonicalJson({
        tool,
        path: target,
        edits: params["edits"],
      }),
    );
  }
  return null;
}

function expectedMutationBytes(
  tool: string,
  params: Record<string, unknown>,
  before: FileSnapshot,
): Buffer | null {
  if (tool === "write" && typeof params["content"] === "string") {
    return Buffer.from(params["content"], "utf8");
  }
  if (tool !== "edit" || !before.exists || !Array.isArray(params["edits"])) {
    return null;
  }
  let candidate = before.bytes.toString("utf8");
  if (candidate.includes("\0")) {
    return null;
  }
  for (const edit of params["edits"]) {
    const record =
      edit !== null && typeof edit === "object"
        ? (edit as Record<string, unknown>)
        : null;
    if (
      record === null ||
      typeof record["oldText"] !== "string" ||
      typeof record["newText"] !== "string"
    ) {
      return null;
    }
    const oldText = record["oldText"];
    const newText = record["newText"];
    const first = candidate.indexOf(oldText);
    if (first < 0 || candidate.indexOf(oldText, first + 1) >= 0) {
      return null;
    }
    candidate =
      candidate.slice(0, first) +
      newText +
      candidate.slice(first + oldText.length);
  }
  return Buffer.from(candidate, "utf8");
}

async function verifyMutationResult(input: {
  tool: string;
  params: Record<string, unknown>;
  target: string | null;
  before: FileSnapshot;
  after: FileSnapshot;
  result: AnyToolResult;
}): Promise<{ result: "pass" | "fail"; reason: string | null }> {
  if (input.target === null) {
    return { result: "pass", reason: null };
  }
  const expected = expectedMutationBytes(
    input.tool,
    input.params,
    input.before,
  );
  if (expected === null) {
    return { result: "pass", reason: null };
  }
  const actual = await fs.readFile(input.target);
  if (actual.equals(expected)) {
    return { result: "pass", reason: null };
  }
  return {
    result: "fail",
    reason: "the file content does not match the requested mutation",
  };
}

function argvParam(params: Record<string, unknown>): string[] | null {
  const candidate = params["argv"];
  if (
    !Array.isArray(candidate) ||
    candidate.length === 0 ||
    candidate.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    return null;
  }
  return [...candidate] as string[];
}

function exactApprovalArgv(
  tool: string,
  command: string | null,
  argv: readonly string[] | null,
): string[] | null {
  if (tool !== "bash" && tool !== "exec" && tool !== "user_bash") {
    return null;
  }
  const candidate =
    argv ?? (command === null ? null : simpleShellArgv(command));
  if (
    candidate === null ||
    candidate.length === 0 ||
    isShellLauncher(candidate)
  ) {
    return null;
  }
  return [...candidate];
}

async function snapshotFile(target: string): Promise<FileSnapshot> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`mutation target is not a regular file: ${target}`);
    }
    const bytes = await fs.readFile(target);
    return {
      exists: true,
      bytes,
      sha256: fileContentHash(bytes),
      mode: stat.mode & 0o7777,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptySnapshot();
    }
    throw error;
  }
}

const toolMutationTails = new Map<string, Promise<void>>();

/**
 * Serialize a wrapped mutation from its before-snapshot through its
 * after-snapshot. Pi's own write/edit queue protects the file bytes, but it
 * starts inside `definition.execute`; without this outer lock two parallel
 * tool calls can both observe the same pre-mutation state and record an
 * evidence chain that never existed.
 */
async function acquireToolMutation(target: string): Promise<() => void> {
  const key = resolveRealPath(target);
  const previous = toolMutationTails.get(key) ?? Promise.resolve();
  let releaseNext = (): void => {};
  const next = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  const tail = previous.then(() => next);
  toolMutationTails.set(key, tail);
  await previous;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    releaseNext();
    if (toolMutationTails.get(key) === tail) {
      toolMutationTails.delete(key);
    }
  };
}

const APPROVAL_PREVIEW_CHARS = 16_384;

function boundedApprovalPreview(value: string): string {
  if (value.length <= APPROVAL_PREVIEW_CHARS) {
    return value;
  }
  return `${value.slice(0, APPROVAL_PREVIEW_CHARS)}\n... [preview truncated; approval evidence binds the full hash]`;
}

const SENSITIVE_ARGUMENT_KEY =
  /(?:api[_-]?key|authorization|client[_-]?secret|credential|cookie|password|private[_-]?key|refresh[_-]?token|secret|token)/iu;

function redactApprovalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactApprovalValue(entry));
  }
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? redactOutputPreview(value) : value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SENSITIVE_ARGUMENT_KEY.test(key)
      ? "[REDACTED]"
      : redactApprovalValue(entry);
  }
  return result;
}

function approvalArguments(
  tool: string,
  params: Record<string, unknown>,
): { preview: string; sha256: string } | null {
  if (!isMcpProductTool(tool)) {
    return null;
  }
  return {
    preview: boundedApprovalPreview(
      JSON.stringify(redactApprovalValue(params), null, 2),
    ),
    sha256: sha256Text(canonicalJson(params)),
  };
}

function coveragePreview(
  tool: string,
  sandbox: ShellProvider | null,
): string | undefined {
  if (isMcpProductTool(tool)) {
    return "uncovered: MCP server executes outside Codepunk's sandbox";
  }
  if (isShellTool(tool)) {
    return sandbox?.sandboxed === true
      ? `enforced: srt ${sandbox.descriptor.version ?? "unknown"}; network denied; writes restricted to the Codepunk write set`
      : "uncovered: no srt sandbox is available";
  }
  if (tool === "write" || tool === "edit") {
    return "app-layer: path and write-set policy are enforced; file tools are not executed inside srt";
  }
  return undefined;
}

function approvalReason(
  policy: PolicyDecision,
  reason: string,
  allowedDomains: readonly string[] | undefined,
  deniedDomains: readonly string[] | undefined,
): string {
  if (policy.approval_class !== "network") {
    return reason;
  }
  if (allowedDomains === undefined || allowedDomains.length === 0) {
    return `${reason}; sandbox.network_allow is empty, so srt will deny egress even if approved`;
  }
  const deny =
    deniedDomains === undefined || deniedDomains.length === 0
      ? null
      : `denied: ${deniedDomains.join(", ")}`;
  return `${reason}; srt egress allowlist: ${allowedDomains.join(", ")}${deny === null ? "" : `; ${deny}`}`;
}

function approvalFailure(result: Pick<ApprovalResult, "failure" | "reason">): {
  rule: string;
  reason: string;
} {
  switch (result.failure) {
    case "channel_unavailable":
      return { rule: "approval.unavailable", reason: result.reason };
    case "channel_error":
      return { rule: "approval.channel_failed", reason: result.reason };
    case "expired":
      return { rule: "approval.expired", reason: result.reason };
    case "mismatch":
      return { rule: "approval.mismatch", reason: result.reason };
    case "scope_untrusted":
      return { rule: "approval.scope_untrusted", reason: result.reason };
    case "already_answered":
      return { rule: "approval.already_answered", reason: result.reason };
    case "not_answered":
    case null:
      return { rule: "approval.denied", reason: result.reason };
  }
}

async function diffPreview(
  tool: string,
  params: Record<string, unknown>,
  target: string | null,
  before: FileSnapshot | null,
  workspaceRoot: string,
): Promise<{ text: string; sha256: string } | null> {
  if (
    target === null ||
    before === null ||
    (tool !== "write" && tool !== "edit")
  ) {
    return null;
  }
  const label = relativeDisplayPath(workspaceRoot, target);
  const oldText = before.exists ? before.bytes.toString("utf8") : "";
  if (oldText.includes("\0")) {
    return {
      text: "preview unavailable: the target is a binary file",
      sha256: sha256Text(`binary:${before.sha256}`),
    };
  }
  let newText: string | null = null;
  if (tool === "write" && typeof params["content"] === "string") {
    newText = params["content"];
  }
  if (tool === "edit" && before.exists && Array.isArray(params["edits"])) {
    let candidate = oldText;
    let exact = true;
    for (const edit of params["edits"]) {
      const record =
        edit !== null && typeof edit === "object"
          ? (edit as Record<string, unknown>)
          : null;
      if (
        record === null ||
        typeof record["oldText"] !== "string" ||
        typeof record["newText"] !== "string"
      ) {
        exact = false;
        break;
      }
      const oldValue = record["oldText"];
      const newValue = record["newText"];
      const first = candidate.indexOf(oldValue);
      if (first < 0 || candidate.indexOf(oldValue, first + 1) >= 0) {
        exact = false;
        break;
      }
      candidate =
        candidate.slice(0, first) +
        newValue +
        candidate.slice(first + oldValue.length);
    }
    newText = exact ? candidate : null;
  }
  if (newText === null) {
    return {
      text: "preview unavailable: the edit does not match the current file exactly",
      sha256: sha256Text(`unavailable:${label}:${before.sha256}`),
    };
  }
  const patch = generateUnifiedPatch(label, oldText, newText, 3);
  return { text: boundedApprovalPreview(patch), sha256: sha256Text(patch) };
}

function textResult(text: string): AnyToolResult {
  return {
    content: [{ type: "text", text }],
    details: {},
    isError: true,
  };
}

function alreadyAppliedResult(
  tool: string,
  target: string,
  idempotencyKey: string,
): AnyToolResult {
  const message = `already_applied: ${tool} ${target} (${idempotencyKey})`;
  return {
    content: [{ type: "text", text: message }],
    details: {},
    structuredContent: {
      already_applied: true,
      idempotency_key: idempotencyKey,
      path: target,
    },
  };
}

function resultText(result: AnyToolResult): string {
  return result.content
    .map((part) =>
      part.type === "text" ? part.text : `[${part.type} content omitted]`,
    )
    .join("\n");
}

function resultWithBoundedOutput(
  result: AnyToolResult,
  output: string,
): AnyToolResult {
  // Artifact truncation may replace text, but it must not erase images or
  // other non-text blocks from the model-visible tool result.
  const content: AnyToolResult["content"] = [];
  let textInserted = false;
  for (const part of result.content) {
    if (part.type === "text") {
      if (!textInserted) {
        content.push({ type: "text", text: output });
        textInserted = true;
      }
      continue;
    }
    content.push(part);
  }
  if (!textInserted && output.length > 0) {
    content.push({ type: "text", text: output });
  }
  let structuredContent = result.structuredContent;
  if (
    structuredContent !== null &&
    typeof structuredContent === "object" &&
    !Array.isArray(structuredContent) &&
    typeof (structuredContent as Record<string, unknown>)["output"] === "string"
  ) {
    structuredContent = {
      ...(structuredContent as Record<string, unknown>),
      output,
    };
  }
  return {
    ...result,
    content,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
}

function structuredNumber(result: AnyToolResult, key: string): number | null {
  if (
    result.structuredContent === null ||
    typeof result.structuredContent !== "object" ||
    Array.isArray(result.structuredContent)
  ) {
    return null;
  }
  const value = (result.structuredContent as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function structuredString(result: AnyToolResult, key: string): string | null {
  if (
    result.structuredContent === null ||
    typeof result.structuredContent !== "object" ||
    Array.isArray(result.structuredContent)
  ) {
    return null;
  }
  const value = (result.structuredContent as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function targetPath(
  tool: string,
  params: Record<string, unknown>,
  cwd: string,
): string | null {
  const candidate = params["path"];
  if (typeof candidate === "string") {
    return normalizeAbsolute(
      path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate),
    );
  }
  // A workspace-wide search has no path argument, but the policy still
  // checks its cwd as the read target. Record that target so the evidence
  // class check and verdict describe the check that actually happened.
  return tool === "search" ? normalizeAbsolute(cwd) : null;
}

function diffHash(before: Buffer, after: Buffer, label: string): string | null {
  try {
    const patch = generateUnifiedPatch(
      label,
      before.toString("utf8"),
      after.toString("utf8"),
    );
    return sha256Text(patch);
  } catch {
    return null;
  }
}

function shellCoverage(
  tool: string,
  allowed: boolean,
  sandbox: ShellProvider | null,
): "enforced" | "uncovered" | "app-layer" {
  if (isMcpProductTool(tool)) {
    return "uncovered";
  }
  if (tool === "bash" || tool === "exec" || tool === "user_bash") {
    return allowed && sandbox?.sandboxed === true ? "enforced" : "uncovered";
  }
  return coverageFor(tool, allowed ? "allow" : "deny");
}

function evidenceSource(tool: string): EvidenceRecord["source"] {
  return isMcpProductTool(tool) ? "mcp" : "tool";
}

function resolveApprovalMode(options: ToolWrapOptions): ApprovalMode {
  return typeof options.approvalMode === "function"
    ? options.approvalMode()
    : (options.approvalMode ?? "ask");
}

function baseRecord(
  options: ToolWrapOptions,
  input: {
    source: EvidenceRecord["source"];
    tool: string;
    toolCallId: string;
    decision: EvidenceRecord["decision"];
    outcome?: EvidenceRecord["outcome"];
    rule: string;
    ruleSha256: string;
    policyLayers: EvidenceRecord["policy_layers"];
    approval: EvidenceRecord["approval"];
    reviewer?: EvidenceRecord["reviewer"];
    command: string | null;
    commandArgv: string[] | null;
    pathTarget: string | null;
    sandbox: SandboxDescriptor;
    coverage: EvidenceRecord["coverage"];
    coverageBasis: string[];
    exitCode: number | null;
    durationMs: number | null;
    beforeSha256: string | null;
    afterSha256: string | null;
    diffSha256: string | null;
    outputRef: string | null;
    outputSha256: string | null;
    outputPreview: string;
    emptyResult: boolean | null;
    executor: string | null;
    memory?: EvidenceRecord["memory"];
    autonomy?: AutonomyEvidence | null;
    budgetExceeded?: EvidenceRecord["budget_exceeded"];
    idempotencyKey?: EvidenceRecord["idempotency_key"];
    reused?: EvidenceRecord["reused"];
    retry?: EvidenceRecord["retry"];
    verify?: EvidenceRecord["verify"];
  },
): Omit<
  EvidenceRecord,
  "version" | "id" | "seq" | "prev_sha256" | "created_at"
> {
  return {
    task_id: options.taskId ?? null,
    run_id: options.runId,
    session_id: options.sessionId,
    source: input.source,
    tool: input.tool,
    tool_call_id: input.toolCallId,
    decision: input.decision,
    outcome:
      input.outcome ?? (input.decision === "allow" ? "completed" : "denied"),
    rule: input.rule,
    rule_sha256: input.ruleSha256,
    policy_layers: input.policyLayers,
    approval: input.approval,
    approval_mode: resolveApprovalMode(options),
    ...(input.reviewer === undefined ? {} : { reviewer: input.reviewer }),
    command: input.command,
    command_argv: input.commandArgv,
    cwd: normalizeAbsolute(options.cwd),
    workspace_root: normalizeAbsolute(options.workspaceRoot),
    path_check: {
      performed: input.pathTarget !== null,
      target: input.pathTarget,
    },
    sandbox: input.sandbox,
    effects: effectsForTool(input.tool),
    coverage: input.coverage,
    coverage_basis: input.coverageBasis,
    exit_code: input.exitCode,
    duration_ms: input.durationMs,
    before_sha256: input.beforeSha256,
    after_sha256: input.afterSha256,
    diff_sha256: input.diffSha256,
    output_ref: input.outputRef,
    output_sha256: input.outputSha256,
    output_preview: input.outputPreview,
    empty_result: input.emptyResult,
    executor: input.executor,
    vcs: { commit: null, tree: null, base_commit: null },
    memory: input.memory ?? {
      ids: [],
      action: "none",
      query_sha256: null,
      cap: 0,
      truncated: false,
    },
    ...(input.autonomy !== undefined ? { autonomy: input.autonomy } : {}),
    ...(input.budgetExceeded !== undefined
      ? { budget_exceeded: input.budgetExceeded }
      : {}),
    ...(input.idempotencyKey !== undefined
      ? { idempotency_key: input.idempotencyKey }
      : {}),
    ...(input.reused !== undefined ? { reused: input.reused } : {}),
    ...(input.retry !== undefined ? { retry: input.retry } : {}),
    ...(input.verify !== undefined ? { verify: input.verify } : {}),
  };
}

function memoryQuery(params: Record<string, unknown>): string | null {
  return typeof params["query"] === "string" ? params["query"] : null;
}

function memoryEvidence(
  params: Record<string, unknown>,
  result: AnyToolResult | null,
  cap: number,
): EvidenceRecord["memory"] {
  const query = memoryQuery(params);
  const queryHash = query === null ? null : sha256Text(query);
  if (result === null) {
    return {
      ids: [],
      action: "none",
      query_sha256: queryHash,
      cap,
      truncated: false,
    };
  }
  const structured = result.structuredContent;
  if (
    structured === null ||
    typeof structured !== "object" ||
    Array.isArray(structured)
  ) {
    return {
      ids: [],
      action: "read",
      query_sha256: queryHash,
      cap,
      truncated: false,
    };
  }
  const record = structured as Record<string, unknown>;
  const records = Array.isArray(record["records"]) ? record["records"] : [];
  const ids = records
    .map((entry) =>
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>)["id"] === "string"
        ? String((entry as Record<string, unknown>)["id"])
        : null,
    )
    .filter((entry): entry is string => entry !== null);
  const returnedCap = typeof record["cap"] === "number" ? record["cap"] : cap;
  return {
    ids,
    action: "read",
    query_sha256: queryHash,
    cap: returnedCap,
    truncated: record["truncated"] === true,
  };
}

function memoryRetrieval(result: AnyToolResult): {
  ids: string[];
  hashes: string[];
  query_sha256: string;
  cap: number;
  truncated: boolean;
  digest_sha256: string;
} | null {
  const structured = result.structuredContent;
  if (
    structured === null ||
    typeof structured !== "object" ||
    Array.isArray(structured)
  ) {
    return null;
  }
  const record = structured as Record<string, unknown>;
  if (
    !Array.isArray(record["records"]) ||
    typeof record["query_sha256"] !== "string" ||
    typeof record["cap"] !== "number"
  ) {
    return null;
  }
  const ids: string[] = [];
  const hashes: string[] = [];
  for (const entry of record["records"]) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const item = entry as Record<string, unknown>;
    if (typeof item["id"] !== "string") {
      continue;
    }
    ids.push(item["id"]);
    if (typeof item["content_sha256"] === "string") {
      hashes.push(item["content_sha256"]);
    }
  }
  return {
    ids,
    hashes,
    query_sha256: record["query_sha256"],
    cap: record["cap"],
    truncated: record["truncated"] === true,
    digest_sha256: sha256Text(
      JSON.stringify({
        ids,
        hashes,
        query_sha256: record["query_sha256"],
      }),
    ),
  };
}

async function recordApprovalAnswer(
  options: ToolWrapOptions,
  answer: ApprovalAnswer | null,
): Promise<void> {
  if (answer !== null && options.onApprovalAnswer !== undefined) {
    await options.onApprovalAnswer(answer);
  }
}

export async function wrapToolDefinition(
  definition: AnyToolDefinition,
  options: ToolWrapOptions,
): Promise<AnyToolDefinition> {
  return {
    ...definition,
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: ((partial: AnyToolResult) => void) | undefined,
      context: ExtensionToolContext,
    ): Promise<AnyToolResult> {
      if (toolCallId.length === 0) {
        throw new Error("tool call id is required");
      }
      const argumentValidation = validateSchema(definition.parameters, params);
      if (!argumentValidation.ok) {
        const message = `invalid tool arguments: ${argumentValidation.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ")}`;
        await options.ledger.append(
          baseRecord(options, {
            source: evidenceSource(definition.name),
            tool: definition.name,
            toolCallId,
            decision: "deny",
            rule: "tool.invalid_arguments",
            ruleSha256: recordHash({ rule: "tool.invalid_arguments" }),
            policyLayers: [],
            approval: null,
            command: null,
            commandArgv: null,
            pathTarget: null,
            sandbox: NONE_SANDBOX,
            coverage: "uncovered",
            coverageBasis: ["arguments"],
            exitCode: null,
            durationMs: 0,
            beforeSha256: null,
            afterSha256: null,
            diffSha256: null,
            outputRef: null,
            outputSha256: outputSha(message),
            outputPreview: message,
            emptyResult: null,
            executor: null,
          }),
        );
        return textResult(message);
      }
      const sandboxProvider = options.sandbox ?? null;
      const autonomy = options.autonomy ?? null;
      const target = targetPath(definition.name, params, options.cwd);
      const isMutation =
        definition.name === "write" || definition.name === "edit";
      const commandArgv = definition.name === "exec" ? argvParam(params) : null;
      const command =
        definition.name === "bash" && typeof params["command"] === "string"
          ? params["command"]
          : null;
      const executionState = executionStateFor(options);
      const executionPolicy = toolExecutionPolicy(definition.name);
      const loopArgv = canonicalShellArgv(definition.name, params);
      const idempotencyKey = mutationIdempotencyKey(
        definition.name,
        target,
        params,
      );
      const approvalMode = resolveApprovalMode(options);
      const policy = decidePolicy(
        policyRequestForCall({
          tool: definition.name,
          args: params,
          cwd: options.cwd,
          workspaceRoot: options.workspaceRoot,
          ...(options.additionalRoots !== undefined
            ? { additionalRoots: options.additionalRoots }
            : {}),
          deliveryRoot: options.deliveryRoot,
          codepunkHome: options.codepunkHome,
          ...(options.mode !== undefined ? { mode: options.mode } : {}),
          approvalMode,
          ...(options.filesystem !== undefined
            ? { filesystem: options.filesystem }
            : {}),
          reviewerAvailable:
            options.reviewer !== null && options.reviewer !== undefined,
          ...(autonomy !== null ? { autonomy: autonomy.profile } : {}),
          ...(options.writeSet !== undefined
            ? { writeSet: options.writeSet }
            : {}),
          ...(options.readableSkillFiles !== undefined
            ? { readableSkillFiles: options.readableSkillFiles }
            : {}),
          ...(options.userRules !== undefined
            ? { userRules: options.userRules }
            : {}),
          ...(options.projectRules !== undefined
            ? { projectRules: options.projectRules }
            : {}),
          ...(options.layers !== undefined ? { layers: options.layers } : {}),
        }),
      );
      const releaseMutation =
        isMutation && target !== null
          ? await acquireToolMutation(target)
          : null;
      try {
        const before =
          isMutation && target !== null && policy.decision !== "deny"
            ? await snapshotFile(target)
            : null;

        let approvalEvidence: EvidenceRecord["approval"] = null;
        let reviewerEvidence: EvidenceRecord["reviewer"] = null;
        const gate = await resolvePermissionGate({
          policy,
          autonomy,
          approvalMode,
          tool: definition.name,
          command,
          argv: commandArgv,
          cwd: options.cwd,
        });
        let finalDecision = gate.decision;
        let finalRule = gate.rule;
        let finalRuleSha256 = gate.rule_sha256;
        let finalReason = gate.reason;
        let scopedRule = gate.scoped_rule;
        let budgetExceeded: EvidenceRecord["budget_exceeded"];
        const autonomyEvidence = () =>
          autonomy === null ? null : autonomy.evidence(scopedRule);
        if (isShellTool(definition.name) && sandboxProvider === null) {
          if (finalDecision !== "deny") {
            finalDecision = "deny";
            finalRule = "sandbox.unavailable";
            finalRuleSha256 = recordHash({ rule: finalRule });
            finalReason =
              typeof options.shellUnavailableReason === "function"
                ? options.shellUnavailableReason()
                : (options.shellUnavailableReason ??
                  defaultShellUnavailableReason("required"));
          }
        }

        if (
          finalDecision !== "deny" &&
          loopArgv !== null &&
          isShellTool(definition.name)
        ) {
          const fingerprint = loopFingerprint(
            definition.name,
            loopArgv,
            options.cwd,
          );
          if (executionState.lastLoopFingerprint === fingerprint) {
            executionState.repeatCount += 1;
          } else {
            executionState.lastLoopFingerprint = fingerprint;
            executionState.repeatCount = 1;
          }
          const threshold = 3;
          if (executionState.repeatCount > threshold) {
            finalDecision = "deny";
            finalRule = "loop_guard";
            finalRuleSha256 = recordHash({ rule: finalRule });
            finalReason = `the same command repeated ${executionState.repeatCount} times in a row (threshold ${threshold})`;
            await options.onExecutionEvent?.("loop_guard", {
              run_id: options.runId,
              tool: definition.name,
              canonical_argv: [...loopArgv],
              cwd: normalizeAbsolute(options.cwd),
              repeat_count: executionState.repeatCount,
              threshold,
              decision: "deny",
            });
          }
        }

        if (finalDecision !== "deny") {
          const maxToolCalls = options.budget?.maxToolCalls;
          if (
            maxToolCalls !== undefined &&
            executionState.usedToolCalls >= maxToolCalls
          ) {
            budgetExceeded = {
              run_id: options.runId,
              limit_kind: "tool_calls",
              limit: maxToolCalls,
              used: executionState.usedToolCalls,
              action: "reject_call",
            };
            finalDecision = "deny";
            finalRule = "budget.tool_calls";
            finalRuleSha256 = recordHash({ rule: finalRule });
            finalReason = `tool call budget exhausted (${executionState.usedToolCalls}/${maxToolCalls}); the call was not executed`;
            await options.onExecutionEvent?.("budget/exceeded", budgetExceeded);
          } else {
            const maxWallMs = options.budget?.maxWallMs;
            const elapsedMs = Math.max(
              0,
              Math.round(performance.now() - executionState.wallStartedAt),
            );
            if (maxWallMs !== undefined && elapsedMs >= maxWallMs) {
              budgetExceeded = {
                run_id: options.runId,
                limit_kind: "wall_ms",
                limit: maxWallMs,
                used: elapsedMs,
                action: "abort_run",
              };
              finalDecision = "deny";
              finalRule = "budget.wall_ms";
              finalRuleSha256 = recordHash({ rule: finalRule });
              finalReason = `wall-clock budget exhausted (${elapsedMs}/${maxWallMs} ms); the call was not executed`;
              await options.onExecutionEvent?.(
                "budget/exceeded",
                budgetExceeded,
              );
              await options.onBudgetAbort?.();
            } else {
              executionState.usedToolCalls += 1;
            }
          }
        }

        if (
          finalDecision === "allow" &&
          idempotencyKey !== null &&
          target !== null &&
          before !== null
        ) {
          const expectedAfter =
            executionState.idempotentResults.get(idempotencyKey);
          if (expectedAfter !== undefined) {
            const current = await snapshotFile(target);
            if (current.sha256 === expectedAfter) {
              const result = alreadyAppliedResult(
                definition.name,
                target,
                idempotencyKey,
              );
              const message = resultText(result);
              await options.ledger.append(
                baseRecord(options, {
                  source: evidenceSource(definition.name),
                  tool: definition.name,
                  toolCallId,
                  decision: "allow",
                  outcome: "completed",
                  rule: "idempotency.already_applied",
                  ruleSha256: recordHash({
                    rule: "idempotency.already_applied",
                  }),
                  policyLayers: policy.layers,
                  approval: null,
                  command,
                  commandArgv,
                  pathTarget: target,
                  sandbox: NONE_SANDBOX,
                  coverage: shellCoverage(
                    definition.name,
                    true,
                    sandboxProvider,
                  ),
                  coverageBasis: ["policy", "idempotency"],
                  exitCode: null,
                  durationMs: 0,
                  beforeSha256: current.sha256,
                  afterSha256: current.sha256,
                  diffSha256: null,
                  outputRef: null,
                  outputSha256: outputSha(message),
                  outputPreview: message,
                  emptyResult: null,
                  executor: null,
                  idempotencyKey,
                  reused: true,
                }),
              );
              return result;
            }
          }
        }

        if (finalDecision !== "deny" && gate.consult_approval) {
          const approvalArgv = exactApprovalArgv(
            definition.name,
            command,
            commandArgv,
          );
          const preview = await diffPreview(
            definition.name,
            params,
            target,
            before,
            options.workspaceRoot,
          );
          const coverage = coveragePreview(definition.name, sandboxProvider);
          const args = approvalArguments(definition.name, params);
          const approvalPath =
            typeof policy.match.path === "string" ? policy.match.path : target;
          const requestReason = approvalReason(
            policy,
            gate.reason,
            options.networkAllowedDomains,
            options.networkDeniedDomains,
          );
          const reviewer = options.reviewer ?? null;
          let review: ReviewResult | null = null;
          if (
            reviewer !== null &&
            approvalMode === "auto" &&
            gate.rule !== "scoped.unmatched" &&
            canReviewerResolveApproval(gate.approval_class)
          ) {
            try {
              review = await reviewer.review(
                {
                  tool: definition.name,
                  command,
                  argv: approvalArgv,
                  cwd: options.cwd,
                  path: approvalPath,
                  approvalClass: gate.approval_class,
                  policyRule: policy.rule,
                  policyReason: policy.reason,
                  approvalReason: requestReason,
                  argsPreview: args?.preview ?? null,
                  argsSha256: args?.sha256 ?? null,
                  diffSha256: preview?.sha256 ?? null,
                },
                signal,
              );
            } catch {
              review = null;
            }
            if (review !== null) {
              reviewerEvidence = review.evidence;
            }
          }
          let reviewResolved = false;
          if (review !== null && review.decision === "allow") {
            finalDecision = "allow";
            finalRule = "reviewer.model.allow";
            finalRuleSha256 = recordHash({ rule: finalRule });
            finalReason = `reviewer allowed: ${review.reason}`;
            reviewResolved = true;
          } else if (review !== null && review.decision === "deny") {
            finalDecision = "deny";
            finalRule = "reviewer.model.deny";
            finalRuleSha256 = recordHash({ rule: finalRule });
            finalReason = `reviewer denied: ${review.reason}`;
            reviewResolved = true;
          }
          if (!reviewResolved) {
            if (options.approval === null || options.approval === undefined) {
              finalDecision = "deny";
              finalRule =
                review === null ? "approval.unavailable" : "reviewer.abstained";
              finalRuleSha256 = recordHash({ rule: finalRule });
              finalReason =
                review === null
                  ? gate.reason
                  : `reviewer abstained and no interactive approval channel is available: ${review.reason}`;
            } else {
              const approval = await options.approval.request({
                sessionId: options.sessionId,
                workerId: options.workerId ?? "local",
                toolCallId,
                tool: definition.name,
                command,
                ...(approvalArgv === null
                  ? {}
                  : { argv: approvalArgv, cwd: options.cwd }),
                path: approvalPath,
                reason: requestReason,
                ...(args === null
                  ? {}
                  : {
                      argsPreview: args.preview,
                      argsSha256: args.sha256,
                    }),
                ...(preview === null
                  ? {}
                  : {
                      diffPreview: preview.text,
                      diffSha256: preview.sha256,
                    }),
                ...(coverage === undefined
                  ? {}
                  : { coveragePreview: coverage }),
              });
              approvalEvidence = approval.evidence;
              await recordApprovalAnswer(options, approval.answer);
              if (!approval.approved) {
                const failure = approvalFailure(approval);
                finalDecision = "deny";
                finalRule = failure.rule;
                finalRuleSha256 = recordHash({ rule: finalRule });
                finalReason = failure.reason;
              } else {
                finalDecision = "allow";
              }
            }
          }
        }

        // The policy decision and any human approval happened above. Snapshot
        // the target once more immediately before execution: if it became a
        // symbolic link, changed content, or changed mode while the caller was
        // deciding, refuse the write instead of following the new object. Pi's
        // writer uses a plain file write and would follow a swapped link.
        if (
          isMutation &&
          target !== null &&
          finalDecision === "allow" &&
          before !== null
        ) {
          let recheck: FileSnapshot | null = null;
          let recheckIssue: string | null = null;
          try {
            recheck = await snapshotFile(target);
          } catch (error) {
            recheckIssue =
              error instanceof Error ? error.message : String(error);
          }
          if (
            recheckIssue === null &&
            recheck !== null &&
            (recheck.exists !== before.exists ||
              recheck.sha256 !== before.sha256 ||
              recheck.mode !== before.mode)
          ) {
            recheckIssue =
              "mutation target changed after the approval decision";
          }
          if (recheckIssue !== null) {
            finalDecision = "deny";
            finalRule = "path.recheck";
            finalRuleSha256 = recordHash({ rule: finalRule });
            finalReason = recheckIssue;
          }
        }

        if (finalDecision !== "allow") {
          const guidance = approvalEvidence?.guidance;
          const message = `denied: ${finalRule} (${finalReason})${
            guidance === undefined ? "" : `\nUser guidance: ${guidance}`
          }`;
          await options.ledger.append(
            baseRecord(options, {
              source: evidenceSource(definition.name),
              tool: definition.name,
              toolCallId,
              decision: "deny",
              rule: finalRule,
              ruleSha256: finalRuleSha256,
              policyLayers: policy.layers,
              approval: approvalEvidence,
              reviewer: reviewerEvidence,
              autonomy: autonomyEvidence(),
              command,
              commandArgv,
              pathTarget: target,
              sandbox: NONE_SANDBOX,
              coverage: shellCoverage(definition.name, false, sandboxProvider),
              coverageBasis: ["policy"],
              exitCode: null,
              durationMs: 0,
              beforeSha256: before?.sha256 ?? null,
              afterSha256: before?.sha256 ?? null,
              diffSha256: null,
              outputRef: null,
              outputSha256: outputSha(message),
              outputPreview: message,
              emptyResult:
                definition.name === "read" || definition.name === "search"
                  ? true
                  : null,
              executor: null,
              ...(budgetExceeded === undefined ? {} : { budgetExceeded }),
              ...(definition.name === "memory_search"
                ? {
                    memory: memoryEvidence(
                      params,
                      null,
                      options.memoryCap ??
                        (typeof params["limit"] === "number"
                          ? params["limit"]
                          : 0),
                    ),
                  }
                : {}),
            }),
          );
          return textResult(message);
        }

        if (
          definition.name === "exec" &&
          commandArgv !== null &&
          options.verifyExec !== undefined
        ) {
          let issue: string | null;
          try {
            issue = await options.verifyExec(commandArgv, options.cwd);
          } catch (error) {
            issue = `headless exec verification failed: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
          if (issue !== null) {
            await options.ledger.append(
              baseRecord(options, {
                source: evidenceSource(definition.name),
                tool: definition.name,
                toolCallId,
                decision: "deny",
                rule: "exec.verification_failed",
                ruleSha256: recordHash({ rule: "exec.verification_failed" }),
                policyLayers: policy.layers,
                approval: approvalEvidence,
                reviewer: reviewerEvidence,
                autonomy: autonomyEvidence(),
                command: null,
                commandArgv,
                pathTarget: null,
                sandbox: sandboxProvider?.descriptor ?? NONE_SANDBOX,
                coverage: "uncovered",
                coverageBasis: ["policy", "digest"],
                exitCode: null,
                durationMs: 0,
                beforeSha256: null,
                afterSha256: null,
                diffSha256: null,
                outputRef: null,
                outputSha256: outputSha(issue),
                outputPreview: issue,
                emptyResult: null,
                executor: null,
              }),
            );
            return textResult(`denied: ${issue}`);
          }
        }

        let durationMs = 0;
        const executeOnce = async (): Promise<{
          result: AnyToolResult;
          executionError: unknown;
        }> => {
          const start = performance.now();
          let result: AnyToolResult;
          let executionError: unknown;
          try {
            result = await definition.execute(
              toolCallId,
              params,
              signal,
              onUpdate,
              context,
            );
          } catch (error) {
            executionError = error;
            result = textResult(
              `tool failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          durationMs += Math.max(0, Math.round(performance.now() - start));
          return { result, executionError };
        };
        let attempt = await executeOnce();
        let result = attempt.result;
        let executionError = attempt.executionError;
        let after =
          isMutation && target !== null ? await snapshotFile(target) : null;
        let verifyEvidence: EvidenceRecord["verify"];
        let retryEvidence: EvidenceRecord["retry"];
        const maxAttempts =
          executionPolicy.retry === "safe" &&
          executionPolicy.idempotent &&
          executionPolicy.sideEffect === "write"
            ? 1
            : 0;
        const verifyResult = options.verifyToolResult ?? verifyMutationResult;
        if (
          isMutation &&
          target !== null &&
          before !== null &&
          after !== null &&
          result.isError !== true
        ) {
          verifyEvidence = await verifyResult({
            tool: definition.name,
            params,
            target,
            before,
            after,
            result,
          });
          if (verifyEvidence.result === "fail" && maxAttempts > 0) {
            const reason =
              verifyEvidence.reason ?? "the mutation verifier failed";
            const failedMessage = `verification failed: ${reason}`;
            await options.ledger.append(
              baseRecord(options, {
                source: evidenceSource(definition.name),
                tool: definition.name,
                toolCallId,
                decision: "allow",
                outcome: "failed",
                rule: "verify.failed",
                ruleSha256: recordHash({ rule: "verify.failed" }),
                policyLayers: policy.layers,
                approval: approvalEvidence,
                reviewer: reviewerEvidence,
                autonomy: autonomyEvidence(),
                command,
                commandArgv,
                pathTarget: target,
                sandbox: NONE_SANDBOX,
                coverage: "app-layer",
                coverageBasis: ["policy", "verify"],
                exitCode: null,
                durationMs: 0,
                beforeSha256: before.sha256,
                afterSha256: after.sha256,
                diffSha256: null,
                outputRef: null,
                outputSha256: outputSha(failedMessage),
                outputPreview: failedMessage,
                emptyResult: null,
                executor: null,
                ...(idempotencyKey === null ? {} : { idempotencyKey }),
                verify: verifyEvidence,
                retry: {
                  attempt: 0,
                  max_attempts: maxAttempts,
                  reason,
                },
              }),
            );
            retryEvidence = {
              attempt: 1,
              max_attempts: maxAttempts,
              reason,
            };
            const retryBefore = after;
            attempt = await executeOnce();
            result = attempt.result;
            executionError = attempt.executionError;
            after = await snapshotFile(target);
            if (result.isError !== true) {
              verifyEvidence = await verifyResult({
                tool: definition.name,
                params,
                target,
                before: retryBefore,
                after,
                result,
              });
            }
          }
          if (verifyEvidence.result === "fail") {
            result = textResult(
              `verification failed: ${
                verifyEvidence.reason ?? "the mutation verifier failed"
              }`,
            );
            executionError = null;
          }
        }
        const outcome: EvidenceRecord["outcome"] =
          signal?.aborted === true ||
          (executionError instanceof Error &&
            (executionError.name === "AbortError" ||
              executionError.message === "aborted" ||
              executionError.message.includes("Command aborted")))
            ? "cancelled"
            : result.isError === true
              ? "failed"
              : "completed";
        const output = resultText(result);
        const shellOutput = structuredString(result, "output");
        const effectiveOutput = shellOutput ?? output;
        let artifact: ToolOutputArtifact | null = null;
        const artifactThreshold = Math.max(
          1,
          options.artifactThresholdTokens ?? 2_000,
        );
        if (
          options.artifactsDir !== undefined &&
          estimateTextTokens(effectiveOutput) > artifactThreshold
        ) {
          artifact = await writeToolOutputArtifact({
            artifactsDir: options.artifactsDir,
            sessionId: options.sessionId,
            output: effectiveOutput,
            ...(options.now !== undefined ? { now: options.now } : {}),
          });
        }
        const visibleOutput = boundedToolOutput(effectiveOutput, {
          maxTokens: Math.max(1, options.maxToolOutputTokens ?? 8_000),
          artifact,
          home: options.codepunkHome,
        });
        const exitCode = isShellTool(definition.name)
          ? structuredNumber(result, "exit_code")
          : null;
        const sandbox =
          isShellTool(definition.name) && sandboxProvider !== null
            ? sandboxProvider.descriptor
            : NONE_SANDBOX;
        const coverage = shellCoverage(definition.name, true, sandboxProvider);
        const beforeBytes = before?.bytes ?? Buffer.alloc(0);
        const afterBytes = after?.bytes ?? beforeBytes;
        const label =
          target === null
            ? definition.name
            : relativeDisplayPath(options.cwd, target);
        const patch =
          isMutation && before !== null && after !== null
            ? diffHash(beforeBytes, afterBytes, label)
            : null;
        if (
          isMutation &&
          target !== null &&
          before !== null &&
          after !== null &&
          outcome === "completed" &&
          options.checkpoints !== null &&
          options.checkpoints !== undefined
        ) {
          try {
            await options.checkpoints.record({
              tool: definition.name as "write" | "edit",
              toolCallId,
              target,
              before,
              after,
            });
          } catch {
            // Undo is an auxiliary recovery surface. A full checkpoint store
            // must not turn a successful file mutation into a tool failure.
          }
        }
        if (
          outcome === "completed" &&
          idempotencyKey !== null &&
          after !== null
        ) {
          executionState.idempotentResults.set(idempotencyKey, after.sha256);
        }
        await options.ledger.append(
          baseRecord(options, {
            source: evidenceSource(definition.name),
            tool: definition.name,
            toolCallId,
            decision: "allow",
            outcome,
            rule: finalRule,
            ruleSha256: finalRuleSha256,
            policyLayers: policy.layers,
            approval: approvalEvidence,
            reviewer: reviewerEvidence,
            autonomy: autonomyEvidence(),
            command,
            commandArgv,
            pathTarget: target,
            sandbox,
            coverage,
            coverageBasis: isShellTool(definition.name)
              ? sandboxProvider?.sandboxed === true
                ? ["policy", "srt"]
                : ["policy", "unsandboxed"]
              : ["policy"],
            exitCode,
            durationMs,
            beforeSha256: before?.sha256 ?? null,
            afterSha256: after?.sha256 ?? null,
            diffSha256: patch,
            outputRef: artifact?.ref ?? null,
            outputSha256: outputSha(effectiveOutput),
            outputPreview: redactOutputPreview(
              effectiveOutput,
              options.codepunkHome,
            ).slice(0, 4_096),
            emptyResult:
              definition.name === "read" || definition.name === "search"
                ? effectiveOutput.trim().length === 0
                : null,
            executor:
              isShellTool(definition.name) && sandboxProvider !== null
                ? sandboxProvider.sandboxed
                  ? "srt"
                  : "direct"
                : null,
            ...(idempotencyKey === null ? {} : { idempotencyKey }),
            ...(retryEvidence === undefined ? {} : { retry: retryEvidence }),
            ...(verifyEvidence === undefined ? {} : { verify: verifyEvidence }),
            ...(definition.name === "memory_search"
              ? {
                  memory: memoryEvidence(
                    params,
                    result,
                    options.memoryCap ??
                      (typeof params["limit"] === "number"
                        ? params["limit"]
                        : 0),
                  ),
                }
              : {}),
          }),
        );
        if (definition.name === "memory_search") {
          const retrieval = memoryRetrieval(result);
          if (retrieval !== null) {
            await options.onMemorySearch?.(retrieval);
          }
        }
        return artifact === null
          ? result
          : resultWithBoundedOutput(result, visibleOutput);
      } finally {
        releaseMutation?.();
      }
    },
  };
}

export async function wrapToolDefinitions(
  definitions: readonly AnyToolDefinition[],
  options: ToolWrapOptions,
): Promise<AnyToolDefinition[]> {
  const wrapped: AnyToolDefinition[] = [];
  for (const definition of definitions) {
    wrapped.push(await wrapToolDefinition(definition, options));
  }
  return wrapped;
}

export async function wrapUserBashCommand(
  command: string,
  toolCallId: string,
  options: ToolWrapOptions,
): Promise<UserBashEventResult> {
  if (toolCallId.length === 0) {
    throw new Error("tool call id is required");
  }
  if (options.disableUserBash === true) {
    const message =
      "! is disabled while Pi plugins are enabled; use the product shell through an approval";
    await options.ledger.append(
      baseRecord(options, {
        source: "user_bash",
        tool: "user_bash",
        toolCallId,
        decision: "deny",
        rule: "user_bash.plugins_enabled",
        ruleSha256: recordHash({ rule: "user_bash.plugins_enabled" }),
        policyLayers: [
          {
            layer: "user",
            source: "product/plugins",
            sha256: sha256Text("user_bash.plugins_enabled"),
            rule_sha256: recordHash({ rule: "user_bash.plugins_enabled" }),
          },
        ],
        approval: null,
        autonomy: null,
        command,
        commandArgv: null,
        pathTarget: null,
        sandbox: options.sandbox?.descriptor ?? NONE_SANDBOX,
        coverage: "uncovered",
        coverageBasis: ["plugin"],
        exitCode: null,
        durationMs: 0,
        beforeSha256: null,
        afterSha256: null,
        diffSha256: null,
        outputRef: null,
        outputSha256: outputSha(message),
        outputPreview: message,
        emptyResult: null,
        executor: null,
      }),
    );
    return { result: deniedUserBashResult(message) };
  }
  const sandboxProvider = options.sandbox ?? null;
  const autonomy = options.autonomy ?? null;
  const approvalMode = resolveApprovalMode(options);
  const policy = decidePolicy(
    policyRequestForCall({
      tool: "user_bash",
      rawCommand: command,
      cwd: options.cwd,
      workspaceRoot: options.workspaceRoot,
      ...(options.additionalRoots !== undefined
        ? { additionalRoots: options.additionalRoots }
        : {}),
      deliveryRoot: options.deliveryRoot,
      codepunkHome: options.codepunkHome,
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      approvalMode,
      ...(options.filesystem !== undefined
        ? { filesystem: options.filesystem }
        : {}),
      reviewerAvailable:
        options.reviewer !== null && options.reviewer !== undefined,
      ...(autonomy !== null ? { autonomy: autonomy.profile } : {}),
      ...(options.writeSet !== undefined ? { writeSet: options.writeSet } : {}),
      ...(options.readableSkillFiles !== undefined
        ? { readableSkillFiles: options.readableSkillFiles }
        : {}),
      ...(options.userRules !== undefined
        ? { userRules: options.userRules }
        : {}),
      ...(options.projectRules !== undefined
        ? { projectRules: options.projectRules }
        : {}),
      ...(options.layers !== undefined ? { layers: options.layers } : {}),
    }),
  );

  let approvalEvidence: EvidenceRecord["approval"] = null;
  let reviewerEvidence: EvidenceRecord["reviewer"] = null;
  const gate = await resolvePermissionGate({
    policy,
    autonomy,
    approvalMode,
    tool: "user_bash",
    command,
    cwd: options.cwd,
  });
  let finalDecision = gate.decision;
  let finalRule = gate.rule;
  let finalRuleSha256 = gate.rule_sha256;
  let finalReason = gate.reason;
  let scopedRule = gate.scoped_rule;
  let budgetExceeded: EvidenceRecord["budget_exceeded"];
  const executionState = executionStateFor(options);
  const loopArgv = canonicalShellArgv("user_bash", {}, command);
  const autonomyEvidence = () =>
    autonomy === null ? null : autonomy.evidence(scopedRule);
  if (sandboxProvider === null) {
    if (finalDecision !== "deny") {
      finalDecision = "deny";
      finalRule = "sandbox.unavailable";
      finalRuleSha256 = recordHash({ rule: finalRule });
      finalReason =
        typeof options.shellUnavailableReason === "function"
          ? options.shellUnavailableReason()
          : (options.shellUnavailableReason ??
            defaultShellUnavailableReason("required"));
    }
  }

  if (finalDecision !== "deny" && loopArgv !== null) {
    const fingerprint = loopFingerprint("user_bash", loopArgv, options.cwd);
    if (executionState.lastLoopFingerprint === fingerprint) {
      executionState.repeatCount += 1;
    } else {
      executionState.lastLoopFingerprint = fingerprint;
      executionState.repeatCount = 1;
    }
    const threshold = 3;
    if (executionState.repeatCount > threshold) {
      finalDecision = "deny";
      finalRule = "loop_guard";
      finalRuleSha256 = recordHash({ rule: finalRule });
      finalReason = `the same command repeated ${executionState.repeatCount} times in a row (threshold ${threshold})`;
      await options.onExecutionEvent?.("loop_guard", {
        run_id: options.runId,
        tool: "user_bash",
        canonical_argv: [...loopArgv],
        cwd: normalizeAbsolute(options.cwd),
        repeat_count: executionState.repeatCount,
        threshold,
        decision: "deny",
      });
    }
  }

  if (finalDecision !== "deny") {
    const maxToolCalls = options.budget?.maxToolCalls;
    if (
      maxToolCalls !== undefined &&
      executionState.usedToolCalls >= maxToolCalls
    ) {
      budgetExceeded = {
        run_id: options.runId,
        limit_kind: "tool_calls",
        limit: maxToolCalls,
        used: executionState.usedToolCalls,
        action: "reject_call",
      };
      finalDecision = "deny";
      finalRule = "budget.tool_calls";
      finalRuleSha256 = recordHash({ rule: finalRule });
      finalReason = `tool call budget exhausted (${executionState.usedToolCalls}/${maxToolCalls}); the call was not executed`;
      await options.onExecutionEvent?.("budget/exceeded", budgetExceeded);
    } else {
      const maxWallMs = options.budget?.maxWallMs;
      const elapsedMs = Math.max(
        0,
        Math.round(performance.now() - executionState.wallStartedAt),
      );
      if (maxWallMs !== undefined && elapsedMs >= maxWallMs) {
        budgetExceeded = {
          run_id: options.runId,
          limit_kind: "wall_ms",
          limit: maxWallMs,
          used: elapsedMs,
          action: "abort_run",
        };
        finalDecision = "deny";
        finalRule = "budget.wall_ms";
        finalRuleSha256 = recordHash({ rule: finalRule });
        finalReason = `wall-clock budget exhausted (${elapsedMs}/${maxWallMs} ms); the call was not executed`;
        await options.onExecutionEvent?.("budget/exceeded", budgetExceeded);
        await options.onBudgetAbort?.();
      } else {
        executionState.usedToolCalls += 1;
      }
    }
  }

  if (finalDecision !== "deny" && gate.consult_approval) {
    const approvalArgv = exactApprovalArgv("user_bash", command, null);
    const requestReason = approvalReason(
      policy,
      gate.reason,
      options.networkAllowedDomains,
      options.networkDeniedDomains,
    );
    const reviewer = options.reviewer ?? null;
    let review: ReviewResult | null = null;
    if (
      reviewer !== null &&
      approvalMode === "auto" &&
      gate.rule !== "scoped.unmatched" &&
      canReviewerResolveApproval(gate.approval_class)
    ) {
      try {
        review = await reviewer.review({
          tool: "user_bash",
          command,
          argv: approvalArgv,
          cwd: options.cwd,
          path: null,
          approvalClass: gate.approval_class,
          policyRule: policy.rule,
          policyReason: policy.reason,
          approvalReason: requestReason,
          argsPreview: null,
          argsSha256: null,
          diffSha256: null,
        });
      } catch {
        review = null;
      }
      if (review !== null) {
        reviewerEvidence = review.evidence;
      }
    }
    let reviewResolved = false;
    if (review !== null && review.decision === "allow") {
      finalDecision = "allow";
      finalRule = "reviewer.model.allow";
      finalRuleSha256 = recordHash({ rule: finalRule });
      finalReason = `reviewer allowed: ${review.reason}`;
      reviewResolved = true;
    } else if (review !== null && review.decision === "deny") {
      finalDecision = "deny";
      finalRule = "reviewer.model.deny";
      finalRuleSha256 = recordHash({ rule: finalRule });
      finalReason = `reviewer denied: ${review.reason}`;
      reviewResolved = true;
    }
    if (!reviewResolved) {
      if (options.approval === null || options.approval === undefined) {
        finalDecision = "deny";
        finalRule =
          review === null ? "approval.unavailable" : "reviewer.abstained";
        finalRuleSha256 = recordHash({ rule: finalRule });
        finalReason =
          review === null
            ? gate.reason
            : `reviewer abstained and no interactive approval channel is available: ${review.reason}`;
      } else {
        const approval = await options.approval.request({
          sessionId: options.sessionId,
          workerId: options.workerId ?? "local",
          toolCallId,
          tool: "user_bash",
          command,
          ...(approvalArgv === null
            ? {}
            : { argv: approvalArgv, cwd: options.cwd }),
          reason: requestReason,
          coveragePreview: coveragePreview("user_bash", sandboxProvider)!,
        });
        approvalEvidence = approval.evidence;
        await recordApprovalAnswer(options, approval.answer);
        if (!approval.approved) {
          const failure = approvalFailure(approval);
          finalDecision = "deny";
          finalRule = failure.rule;
          finalRuleSha256 = recordHash({ rule: finalRule });
          finalReason = failure.reason;
        } else {
          finalDecision = "allow";
        }
      }
    }
  }

  const guidance = approvalEvidence?.guidance;
  const denialMessage =
    finalDecision === "allow"
      ? null
      : `denied: ${finalRule} (${finalReason})${
          guidance === undefined ? "" : `\nUser guidance: ${guidance}`
        }`;
  if (denialMessage !== null) {
    await options.ledger.append(
      baseRecord(options, {
        source: "user_bash",
        tool: "user_bash",
        toolCallId,
        decision: "deny",
        rule: finalRule,
        ruleSha256: finalRuleSha256,
        policyLayers: policy.layers,
        approval: approvalEvidence,
        reviewer: reviewerEvidence,
        autonomy: autonomyEvidence(),
        command,
        commandArgv: null,
        pathTarget: null,
        sandbox: sandboxProvider?.descriptor ?? NONE_SANDBOX,
        coverage: "uncovered",
        coverageBasis: ["policy"],
        exitCode: null,
        durationMs: 0,
        beforeSha256: null,
        afterSha256: null,
        diffSha256: null,
        outputRef: null,
        outputSha256: outputSha(denialMessage),
        outputPreview: denialMessage,
        emptyResult: null,
        executor: null,
        ...(budgetExceeded === undefined ? {} : { budgetExceeded }),
      }),
    );
    return { result: deniedUserBashResult(denialMessage) };
  }

  const sandbox = sandboxProvider;
  if (sandbox === null) {
    throw new Error("unreachable: denied sandbox-unavailable user_bash");
  }
  const operations: BashOperations = {
    async exec(actualCommand, cwd, executionOptions) {
      const start = performance.now();
      try {
        const result = await sandbox.execCommand(actualCommand, cwd, {
          onData: executionOptions.onData,
          ...(executionOptions.signal !== undefined
            ? { signal: executionOptions.signal }
            : {}),
          ...(executionOptions.timeout !== undefined
            ? { timeout: executionOptions.timeout }
            : {}),
          env: agentShellEnvironment(executionOptions.env),
        });
        const durationMs = Math.max(0, Math.round(performance.now() - start));
        await options.ledger.append(
          baseRecord(options, {
            source: "user_bash",
            tool: "user_bash",
            toolCallId,
            decision: "allow",
            rule: finalRule,
            ruleSha256: finalRuleSha256,
            policyLayers: policy.layers,
            approval: approvalEvidence,
            reviewer: reviewerEvidence,
            autonomy: autonomyEvidence(),
            command,
            commandArgv: null,
            pathTarget: null,
            sandbox: sandbox.descriptor,
            coverage: sandbox.sandboxed ? "enforced" : "uncovered",
            coverageBasis: sandbox.sandboxed
              ? ["policy", "srt"]
              : ["policy", "unsandboxed"],
            exitCode: result.exitCode,
            durationMs,
            beforeSha256: null,
            afterSha256: null,
            diffSha256: null,
            outputRef: null,
            outputSha256: outputSha(result.output),
            outputPreview: result.output.slice(0, 4_096),
            emptyResult: null,
            executor: result.executor,
          }),
        );
        await options.onUserBashResult?.({
          command,
          output: result.output,
          exitCode: result.exitCode,
          cancelled: result.cancelled,
          timedOut: result.timedOut,
        });
        if (result.cancelled) {
          throw new Error("aborted");
        }
        return { exitCode: result.exitCode };
      } catch (error) {
        if (error instanceof Error && error.message === "aborted") {
          throw error;
        }
        const message = `user_bash failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        await options.ledger.append(
          baseRecord(options, {
            source: "user_bash",
            tool: "user_bash",
            toolCallId,
            decision: "allow",
            rule: finalRule,
            ruleSha256: finalRuleSha256,
            policyLayers: policy.layers,
            approval: approvalEvidence,
            reviewer: reviewerEvidence,
            autonomy: autonomyEvidence(),
            command,
            commandArgv: null,
            pathTarget: null,
            sandbox: sandbox.descriptor,
            coverage: sandbox.sandboxed ? "enforced" : "uncovered",
            coverageBasis: sandbox.sandboxed
              ? ["policy", "srt"]
              : ["policy", "unsandboxed"],
            exitCode: null,
            durationMs: Math.max(0, Math.round(performance.now() - start)),
            beforeSha256: null,
            afterSha256: null,
            diffSha256: null,
            outputRef: null,
            outputSha256: outputSha(message),
            outputPreview: message,
            emptyResult: null,
            executor: sandbox.sandboxed ? "srt" : "direct",
          }),
        );
        await options.onUserBashFailure?.(message);
        throw error;
      }
    },
  };
  return { operations };
}

export function deniedUserBashResult(message: string): {
  output: string;
  exitCode: number;
  cancelled: boolean;
  truncated: boolean;
} {
  return {
    output: message,
    exitCode: 1,
    cancelled: false,
    truncated: false,
  };
}
