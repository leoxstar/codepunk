import { promises as fs } from "node:fs";
import path from "node:path";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import type {
  ApprovalAnswer,
  AutonomyEvidence,
  Decision,
  EvidenceRecord,
  PolicyDecision,
  SandboxDescriptor,
} from "codepunk-protocol";
import type { ApprovalResult } from "../approval/index.ts";
import { redactOutputPreview } from "../artifacts/index.ts";
import { isShellLauncher } from "../autonomy/index.ts";
import type { ApprovalMode } from "../config/index.ts";
import { fileContentHash, outputSha } from "../evidence/index.ts";
import { canonicalJson, recordHash, sha256Text } from "../platform/hash.ts";
import {
  normalizeAbsolute,
  relativeDisplayPath,
  resolveRealPath,
} from "../platform/path.ts";
import {
  coverageFor,
  effectsForTool,
  isMcpProductTool,
  simpleShellArgv,
} from "../policy/index.ts";
import type { ShellProvider } from "../sandbox/index.ts";
import {
  extractEditReplacements,
  resolveIndentationFallbackEdits,
} from "../tools/index.ts";
import {
  NONE_SANDBOX,
  type AnyToolResult,
  type FileSnapshot,
  type TaintOrigin,
  type ToolExecutionState,
  type ToolWrapOptions,
} from "./types.ts";

export function resolveSandbox(
  sandbox: ToolWrapOptions["sandbox"],
): ShellProvider | null {
  return typeof sandbox === "function" ? sandbox() : (sandbox ?? null);
}

const executionStates = new WeakMap<object, ToolExecutionState>();

export function executionStateFor(
  options: ToolWrapOptions,
): ToolExecutionState {
  let state = executionStates.get(options);
  if (state === undefined) {
    state = {
      runId: null,
      usedToolCalls: 0,
      wallStartedAt: performance.now(),
      lastLoopFingerprint: null,
      repeatCount: 0,
      idempotentResults: new Map(),
      taintedBy: null,
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

export function extractTaintOrigin(
  tool: "web_fetch" | "web_search",
  params: Record<string, unknown>,
): TaintOrigin {
  if (tool === "web_fetch" && typeof params["url"] === "string") {
    try {
      const parsed = new URL(params["url"]);
      if (parsed.host.length > 0) {
        return { tool, source: parsed.host };
      }
    } catch {
      // Fall back to redacted string preview below.
    }
    return {
      tool,
      source: redactOutputPreview(params["url"]).slice(0, 80),
    };
  }
  const rawQuery =
    typeof params["query"] === "string" ? params["query"].trim() : "query";
  return {
    tool,
    source: `query:${redactOutputPreview(rawQuery).slice(0, 64)}`,
  };
}

export function shouldEscalateTaintedCall(
  tool: string,
  policyDecision: Decision,
): boolean {
  return (
    policyDecision === "ask" && (isShellTool(tool) || isMcpProductTool(tool))
  );
}

export function emptySnapshot(): FileSnapshot {
  const bytes = Buffer.alloc(0);
  return {
    exists: false,
    bytes,
    sha256: fileContentHash(bytes),
    mode: null,
  };
}

export function isShellTool(name: string): boolean {
  return name === "bash" || name === "exec" || name === "user_bash";
}

export function canonicalShellArgv(
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

export function loopFingerprint(
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

export function mutationIdempotencyKey(
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

function applyEditPreviewToText(
  oldText: string,
  params: Record<string, unknown>,
): string | null {
  const edits = extractEditReplacements(params);
  if (edits === null) {
    return null;
  }
  const hasCrlf = oldText.includes("\r\n");
  const tryApply = (
    source: string,
    replacements: readonly { oldText: string; newText: string }[],
  ): string | null => {
    const spans: Array<{ start: number; end: number; newText: string }> = [];
    for (const edit of replacements) {
      if (edit.oldText.length === 0) {
        return null;
      }
      const first = source.indexOf(edit.oldText);
      if (first < 0 || source.indexOf(edit.oldText, first + 1) >= 0) {
        return null;
      }
      spans.push({
        start: first,
        end: first + edit.oldText.length,
        newText: edit.newText,
      });
    }
    spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i += 1) {
      if (spans[i]!.start < spans[i - 1]!.end) {
        return null;
      }
    }
    let candidate = source;
    for (let i = spans.length - 1; i >= 0; i -= 1) {
      const span = spans[i]!;
      candidate =
        candidate.slice(0, span.start) +
        span.newText +
        candidate.slice(span.end);
    }
    return candidate;
  };
  const direct = tryApply(oldText, edits);
  if (direct !== null) {
    return direct;
  }
  const resolved = resolveIndentationFallbackEdits(oldText, edits);
  if (resolved === null) {
    return null;
  }
  const lfSource = oldText.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  const appliedLf = tryApply(lfSource, resolved.edits);
  if (appliedLf === null) {
    return null;
  }
  return hasCrlf ? appliedLf.replace(/\n/gu, "\r\n") : appliedLf;
}

export function expectedMutationBytes(
  tool: string,
  params: Record<string, unknown>,
  before: FileSnapshot,
): Buffer | null {
  if (tool === "write" && typeof params["content"] === "string") {
    return Buffer.from(params["content"], "utf8");
  }
  if (tool !== "edit" || !before.exists) {
    return null;
  }
  const oldText = before.bytes.toString("utf8");
  if (oldText.includes("\0")) {
    return null;
  }
  const applied = applyEditPreviewToText(oldText, params);
  return applied === null ? null : Buffer.from(applied, "utf8");
}

export async function verifyMutationResult(input: {
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

export function argvParam(params: Record<string, unknown>): string[] | null {
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

export function exactApprovalArgv(
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

export async function snapshotFile(target: string): Promise<FileSnapshot> {
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
export async function acquireToolMutation(target: string): Promise<() => void> {
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

export function boundedApprovalPreview(value: string): string {
  if (value.length <= APPROVAL_PREVIEW_CHARS) {
    return value;
  }
  return `${value.slice(0, APPROVAL_PREVIEW_CHARS)}\n... [preview truncated; approval evidence binds the full hash]`;
}

const SENSITIVE_ARGUMENT_KEY =
  /(?:api[_-]?key|authorization|client[_-]?secret|credential|cookie|password|private[_-]?key|refresh[_-]?token|secret|token)/iu;

export function redactApprovalValue(value: unknown): unknown {
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

export function approvalArguments(
  tool: string,
  params: Record<string, unknown>,
): { preview: string; sha256: string } | null {
  if (tool === "web_fetch" && typeof params["url"] === "string") {
    const params2 = { url: redactOutputPreview(params["url"]) };
    return {
      preview: boundedApprovalPreview(JSON.stringify(params2, null, 2)),
      sha256: sha256Text(canonicalJson(params2)),
    };
  }
  if (tool === "web_search" && typeof params["query"] === "string") {
    const params2 = { query: redactOutputPreview(params["query"]) };
    return {
      preview: boundedApprovalPreview(JSON.stringify(params2, null, 2)),
      sha256: sha256Text(canonicalJson(params2)),
    };
  }
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

export function coveragePreview(
  tool: string,
  sandbox: ShellProvider | null,
): string | undefined {
  if (isMcpProductTool(tool)) {
    return "uncovered: MCP server runs outside the Codepunk sandbox";
  }
  if (isShellTool(tool)) {
    return sandbox?.sandboxed === true
      ? `srt ${sandbox.descriptor.version ?? "unknown"} enforced; network off unless allowlisted; writes limited to the Codepunk write set`
      : "no srt sandbox; this command runs directly on your machine";
  }
  if (tool === "write" || tool === "edit") {
    return "path and write-set policy enforced; file tools do not run inside srt";
  }
  if (tool === "web_fetch" || tool === "web_search") {
    return "in-process request; approving grants only this call; the domain deny list and private-host guard still apply";
  }
  return undefined;
}

export function approvalReason(
  policy: PolicyDecision,
  reason: string,
  allowedDomains: readonly string[] | undefined,
  deniedDomains: readonly string[] | undefined,
): string {
  if (policy.approval_class !== "network") {
    return reason;
  }
  if (policy.match.tool === "web_fetch" || policy.match.tool === "web_search") {
    return `${reason}; approving grants only this request, and the domain deny list still applies`;
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

export function approvalFailure(
  result: Pick<ApprovalResult, "failure" | "reason">,
): {
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

export async function diffPreview(
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
  if (tool === "edit" && before.exists) {
    newText = applyEditPreviewToText(oldText, params);
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

export function textResult(text: string): AnyToolResult {
  return {
    content: [{ type: "text", text }],
    details: {},
    isError: true,
  };
}

export async function denyPlanMode(
  options: ToolWrapOptions,
  input: {
    tool: string;
    toolCallId: string;
    command: string | null;
    commandArgv: string[] | null;
    pathTarget: string | null;
    rule: string;
    reason: string;
  },
): Promise<string> {
  const message = `denied: ${input.rule} (${input.reason})`;
  await options.ledger.append(
    baseRecord(options, {
      source:
        input.tool === "user_bash" ? "user_bash" : evidenceSource(input.tool),
      tool: input.tool,
      toolCallId: input.toolCallId,
      decision: "deny",
      rule: input.rule,
      ruleSha256: recordHash({ rule: input.rule }),
      policyLayers: [
        {
          layer: "user",
          source: "product/plan-mode",
          sha256: sha256Text("plan_mode"),
          rule_sha256: recordHash({ rule: "plan_mode" }),
        },
      ],
      approval: null,
      command: input.command,
      commandArgv: input.commandArgv,
      pathTarget: input.pathTarget,
      sandbox: NONE_SANDBOX,
      coverage: "uncovered",
      coverageBasis: ["plan-mode"],
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
  return message;
}

export function alreadyAppliedResult(
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

export function resultText(result: AnyToolResult): string {
  return result.content
    .map((part) =>
      part.type === "text" ? part.text : `[${part.type} content omitted]`,
    )
    .join("\n");
}

export function resultWithBoundedOutput(
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

export function structuredNumber(
  result: AnyToolResult,
  key: string,
): number | null {
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

export function structuredString(
  result: AnyToolResult,
  key: string,
): string | null {
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

export function targetPath(
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
  return tool === "search" || tool === "lsp_query"
    ? normalizeAbsolute(cwd)
    : null;
}

export function diffHash(
  before: Buffer,
  after: Buffer,
  label: string,
): string | null {
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

export function shellCoverage(
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

export function evidenceSource(tool: string): EvidenceRecord["source"] {
  return isMcpProductTool(tool) ? "mcp" : "tool";
}

export function resolveApprovalMode(options: ToolWrapOptions): ApprovalMode {
  return typeof options.approvalMode === "function"
    ? options.approvalMode()
    : (options.approvalMode ?? "ask");
}

export function baseRecord(
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

export function memoryEvidence(
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

export function memoryRetrieval(result: AnyToolResult): {
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

export async function recordApprovalAnswer(
  options: ToolWrapOptions,
  answer: ApprovalAnswer | null,
): Promise<void> {
  if (answer !== null && options.onApprovalAnswer !== undefined) {
    await options.onApprovalAnswer(answer);
  }
}
