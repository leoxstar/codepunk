import { randomBytes, randomUUID } from "node:crypto";
import type {
  ApprovalAnswer,
  ApprovalEvidence,
  ApprovalRequest,
  ApprovalScope,
} from "codepunk-protocol";
import { sha256Text } from "../platform/hash.ts";
import { normalizeAbsolute } from "../platform/path.ts";

export interface ApprovalChannel {
  id: string;
  kind: "tui" | "cli";
  isTTY: boolean;
  ask(request: ApprovalRequest): Promise<ApprovalAnswer | null>;
}

export interface ApprovalResult {
  approved: boolean;
  unsandboxedOnce?: boolean;
  answer: ApprovalAnswer | null;
  evidence: ApprovalEvidence | null;
  reason: string;
  failure:
    | "channel_unavailable"
    | "channel_error"
    | "not_answered"
    | "expired"
    | "mismatch"
    | "already_answered"
    | "scope_untrusted"
    | null;
}

export interface ApprovalBrokerOptions {
  ttlMs?: number;
  now?: () => Date;
  /**
   * Whether the current workspace is trusted for persistent rules or host
   * shell escapes. Untrusted workspaces may receive `once` or in-process
   * `session` grants, while `persistent` scopes and `unsandboxed_once` escapes
   * are rejected with `scope_untrusted`.
   */
  workspaceTrusted?: boolean;
}

interface PendingApproval {
  request: ApprovalRequest;
  used: boolean;
  control: Promise<ApprovalResult>;
  resolveControl: (result: ApprovalResult) => void;
}

interface SessionGrant {
  tool: string;
  // A stable selector for the approved action. Shell calls use their exact
  // argv, file mutations use the target path, and other tools fall back to
  // the tool name. It deliberately excludes hashes that change with content.
  key: string;
  scope: Exclude<ApprovalScope, "once">;
  channel: ApprovalAnswer["channel"];
  // The request a human actually answered. Reused grants name it in evidence.
  requestId: string;
}

export class ApprovalBroker {
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly workspaceTrusted: boolean;
  private channel: ApprovalChannel | null = null;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly sessionGrants: SessionGrant[] = [];

  constructor(options: ApprovalBrokerOptions = {}) {
    this.ttlMs = options.ttlMs ?? 120_000;
    this.now = options.now ?? (() => new Date());
    this.workspaceTrusted = options.workspaceTrusted ?? false;
  }

  registerChannel(channel: ApprovalChannel): void {
    if (this.channel !== null) {
      throw new Error("approval channel is already registered");
    }
    this.assertChannel(channel);
    this.channel = channel;
  }

  replaceChannel(channel: ApprovalChannel | null): void {
    if (channel !== null) {
      this.assertChannel(channel);
    }
    this.channel = channel;
  }

  clearSessionGrants(): void {
    this.sessionGrants.length = 0;
  }

  /**
   * Answer a pending request from a trusted control surface. The nonce and
   * the full request correlation are still checked by `acceptAnswer`; this
   * method never creates an approval that was not requested by a channel.
   */
  answer(
    requestId: string,
    nonceSha256: string,
    approved: boolean,
  ): ApprovalResult {
    const pending = this.pending.get(requestId);
    if (pending === undefined) {
      return {
        approved: false,
        answer: null,
        evidence: null,
        reason: "approval request is not pending",
        failure: "already_answered",
      };
    }
    const request = pending.request;
    if (request.nonce_sha256 !== nonceSha256) {
      return {
        approved: false,
        answer: null,
        evidence: null,
        reason: "approval nonce does not match",
        failure: "mismatch",
      };
    }
    const answer: ApprovalAnswer = {
      request_id: request.request_id,
      answer: approved ? "allow" : "deny",
      scope: "once",
      channel: "cli",
      channel_id: request.channel_id,
      nonce_sha256: request.nonce_sha256,
      worker_id: request.worker_id,
      session_id: request.session_id,
      tool_call_id: request.tool_call_id,
      answered_at: this.now().toISOString(),
    };
    const result = this.acceptAnswer(answer, request, pending);
    pending.resolveControl(result);
    return result;
  }

  private assertChannel(channel: ApprovalChannel): void {
    if (channel.kind !== "tui" && channel.kind !== "cli") {
      throw new Error("unsupported approval channel kind");
    }
    if (typeof channel.ask !== "function") {
      throw new Error("approval channel must implement ask");
    }
    if (channel.id.length === 0) {
      throw new Error("approval channel id is required");
    }
  }

  get hasChannel(): boolean {
    return this.channel !== null;
  }

  async request(input: {
    sessionId: string;
    workerId: string;
    toolCallId: string;
    tool?: string;
    command?: string | null;
    argv?: readonly string[] | null;
    cwd?: string | null;
    path?: string | null;
    reason?: string;
    argsPreview?: string | null;
    argsSha256?: string | null;
    diffPreview?: string | null;
    diffSha256?: string | null;
    coveragePreview?: string | null;
  }): Promise<ApprovalResult> {
    const channel = this.channel;
    if (channel === null || !channel.isTTY) {
      return {
        approved: false,
        answer: null,
        evidence: null,
        reason: "no interactive approval channel",
        failure: "channel_unavailable",
      };
    }
    const now = this.now();
    const request: ApprovalRequest = {
      request_id: randomUUID(),
      nonce_sha256: sha256Text(randomBytes(32).toString("hex")),
      ttl_ms: this.ttlMs,
      worker_id: input.workerId,
      session_id: input.sessionId,
      tool_call_id: input.toolCallId,
      channel_id: channel.id,
      ...(input.tool === undefined ? {} : { tool: input.tool }),
      ...(input.command === undefined || input.command === null
        ? {}
        : { command: input.command }),
      ...(input.argv === undefined ||
      input.argv === null ||
      input.argv.length === 0
        ? {}
        : { argv: [...input.argv] }),
      ...(input.cwd === undefined || input.cwd === null
        ? {}
        : { cwd: normalizeAbsolute(input.cwd) }),
      ...(input.path === undefined || input.path === null
        ? {}
        : { path: input.path }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.argsPreview === undefined || input.argsPreview === null
        ? {}
        : { args_preview: input.argsPreview }),
      ...(input.argsSha256 === undefined || input.argsSha256 === null
        ? {}
        : { args_sha256: input.argsSha256 }),
      ...(input.diffPreview === undefined || input.diffPreview === null
        ? {}
        : { diff_preview: input.diffPreview }),
      ...(input.diffSha256 === undefined || input.diffSha256 === null
        ? {}
        : { diff_sha256: input.diffSha256 }),
      ...(input.coveragePreview === undefined || input.coveragePreview === null
        ? {}
        : { coverage_preview: input.coveragePreview }),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
    const grant = this.matchSessionGrant(request);
    if (grant !== null) {
      const answer = grantAnswer(request, grant);
      return {
        approved: true,
        answer,
        evidence: approvalEvidence(request, answer, grant.requestId),
        reason: `approval reused for this session (${grant.scope})`,
        failure: null,
      };
    }
    const control = Promise.withResolvers<ApprovalResult>();
    const pending: PendingApproval = {
      request,
      used: false,
      control: control.promise,
      resolveControl: control.resolve,
    };
    this.pending.set(request.request_id, pending);
    const outcome = await Promise.race([
      channel.ask(request).then(
        (answer) => ({ kind: "answer" as const, answer }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      control.promise.then((result) => ({ kind: "control" as const, result })),
    ]);
    if (outcome.kind === "control") {
      return outcome.result;
    }
    const channelError =
      outcome.kind === "error"
        ? outcome.error instanceof Error
          ? outcome.error.message
          : "approval channel failed"
        : null;
    if (channelError !== null) {
      pending.used = true;
      this.pending.delete(request.request_id);
      return {
        approved: false,
        answer: null,
        evidence: null,
        reason: `approval channel failed: ${channelError}`,
        failure: "channel_error",
      };
    }
    return this.acceptAnswer(
      outcome.kind === "answer" ? outcome.answer : null,
      request,
      pending,
    );
  }

  acceptAnswer(
    answer: ApprovalAnswer | null,
    request: ApprovalRequest,
    pending: PendingApproval,
  ): ApprovalResult {
    const time = this.now();
    if (pending.used) {
      return {
        approved: false,
        answer: null,
        evidence: null,
        reason: "approval request was already answered",
        failure: "already_answered",
      };
    }
    pending.used = true;
    this.pending.delete(request.request_id);
    if (answer === null) {
      return {
        approved: false,
        answer: null,
        evidence: null,
        reason: "approval was not answered",
        failure: "not_answered",
      };
    }
    if (time.getTime() > Date.parse(request.expires_at)) {
      return {
        approved: false,
        answer,
        evidence: approvalEvidence(request, answer),
        reason: "approval request expired",
        failure: "expired",
      };
    }
    const scope = answer.scope ?? "once";
    const correlationMismatch =
      answer.request_id !== request.request_id ||
      answer.channel_id !== request.channel_id ||
      answer.nonce_sha256 !== request.nonce_sha256 ||
      answer.worker_id !== request.worker_id ||
      answer.session_id !== request.session_id ||
      answer.tool_call_id !== request.tool_call_id ||
      (answer.answer !== "allow" && answer.answer !== "deny") ||
      (scope !== "once" && scope !== "session" && scope !== "persistent");
    if (
      !correlationMismatch &&
      answer.answer === "allow" &&
      scope === "persistent" &&
      !this.workspaceTrusted
    ) {
      return {
        approved: false,
        answer,
        evidence: approvalEvidence(request, answer),
        reason:
          "approval.scope_untrusted: persistent rules need workspace trust; " +
          "use session approval, or run `codepunk trust grant` and start a new session",
        failure: "scope_untrusted",
      };
    }
    if (
      !correlationMismatch &&
      answer.answer === "allow" &&
      scope === "once" &&
      answer.unsandboxed_once === true &&
      isShellApprovalTool(request.tool) &&
      !this.workspaceTrusted
    ) {
      return {
        approved: false,
        answer,
        evidence: approvalEvidence(request, answer),
        reason:
          "approval.scope_untrusted: unsandboxed shell escape requires workspace trust; " +
          "run `codepunk trust grant` and start a new session",
        failure: "scope_untrusted",
      };
    }
    const unsandboxedMismatch =
      !correlationMismatch &&
      answer.unsandboxed_once === true &&
      (answer.answer !== "allow" ||
        scope !== "once" ||
        !isShellApprovalTool(request.tool));
    const scopeShapeMismatch =
      !correlationMismatch &&
      (unsandboxedMismatch ||
        (scope !== "once" &&
          (request.tool === undefined ||
            (scope === "persistent" &&
              (request.argv === undefined || request.cwd === undefined)) ||
            (scope === "session" &&
              isShellApprovalTool(request.tool) &&
              request.argv === undefined &&
              (request.command === undefined ||
                request.command.trim().length === 0 ||
                request.cwd === undefined)))));
    const approved =
      !correlationMismatch && !scopeShapeMismatch && answer.answer === "allow";
    if (approved && scope !== "once" && !scopeShapeMismatch) {
      const tool = request.tool;
      const key = tool === undefined ? null : approvalGrantKey(request);
      if (tool !== undefined && key !== null) {
        this.sessionGrants.push({
          tool,
          key,
          scope,
          channel: answer.channel,
          requestId: request.request_id,
        });
      }
    }
    return {
      approved,
      ...(approved && answer.unsandboxed_once === true
        ? { unsandboxedOnce: true }
        : {}),
      answer,
      evidence: approvalEvidence(request, answer),
      reason: correlationMismatch
        ? "approval answer did not match the request"
        : scopeShapeMismatch
          ? "approval answer did not match the request"
          : approved
            ? "approval allowed"
            : "approval denied",
      failure: correlationMismatch || scopeShapeMismatch ? "mismatch" : null,
    };
  }

  private matchSessionGrant(request: ApprovalRequest): SessionGrant | null {
    if (request.tool === undefined) {
      return null;
    }
    const key = approvalGrantKey(request);
    if (key === null) {
      return null;
    }
    const grant = this.sessionGrants.find(
      (candidate) => candidate.tool === request.tool && candidate.key === key,
    );
    return grant ?? null;
  }
}

function isShellApprovalTool(tool: string | undefined): boolean {
  return tool === "bash" || tool === "exec" || tool === "user_bash";
}

/**
 * The identity a session grant reuses. Shell calls stay exact (by parsed argv
 * when simple, or by exact trimmed command string inside the same cwd for
 * pipelines), file mutations reuse per target path, and every other tool
 * reuses per tool inside the same working directory. `once` and `persistent`
 * scopes never consult this key.
 */
function approvalGrantKey(request: ApprovalRequest): string | null {
  const cwd = request.cwd === undefined ? "" : normalizeAbsolute(request.cwd);
  if (request.argv !== undefined && request.argv.length > 0) {
    return `argv\0${cwd}\0${request.argv.join("\0")}`;
  }
  if (
    request.command !== undefined &&
    request.command.trim().length > 0 &&
    request.cwd !== undefined
  ) {
    return `cmd\0${cwd}\0${request.command.trim()}`;
  }
  if (isShellApprovalTool(request.tool)) {
    return null;
  }
  if (request.path !== undefined && request.path.length > 0) {
    return `path\0${normalizeAbsolute(request.path)}`;
  }
  if (request.tool !== undefined) {
    return `tool\0${cwd}\0${request.tool}`;
  }
  return null;
}

function approvalEvidence(
  request: ApprovalRequest,
  answer: ApprovalAnswer,
  reusedFromRequestId: string | null = null,
): ApprovalEvidence {
  return {
    channel: answer.channel,
    request_id: request.request_id,
    nonce_sha256: request.nonce_sha256,
    ttl_ms: request.ttl_ms,
    worker_id: request.worker_id,
    session_id: request.session_id,
    tool_call_id: request.tool_call_id,
    answer: answer.answer,
    scope: answer.scope ?? "once",
    ...(answer.unsandboxed_once === true ? { unsandboxed_once: true } : {}),
    ...(answer.guidance === undefined ? {} : { guidance: answer.guidance }),
    ...(reusedFromRequestId === null
      ? {}
      : { reused_from_request_id: reusedFromRequestId }),
    ...(request.args_sha256 === undefined
      ? {}
      : { args_sha256: request.args_sha256 }),
    ...(request.diff_sha256 === undefined
      ? {}
      : { diff_sha256: request.diff_sha256 }),
  };
}

function grantAnswer(
  request: ApprovalRequest,
  grant: SessionGrant,
): ApprovalAnswer {
  return {
    request_id: request.request_id,
    answer: "allow",
    scope: grant.scope,
    channel: grant.channel,
    channel_id: request.channel_id,
    nonce_sha256: request.nonce_sha256,
    worker_id: request.worker_id,
    session_id: request.session_id,
    tool_call_id: request.tool_call_id,
    answered_at: new Date().toISOString(),
  };
}
