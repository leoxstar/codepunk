import { randomBytes, randomUUID } from "node:crypto";
import type {
  ApprovalAnswer,
  ApprovalEvidence,
  ApprovalRequest,
  ApprovalScope,
} from "@codepunk/protocol";
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
    | null;
}

export interface ApprovalBrokerOptions {
  ttlMs?: number;
  now?: () => Date;
}

interface PendingApproval {
  request: ApprovalRequest;
  used: boolean;
}

interface SessionGrant {
  tool: string;
  argv: string[];
  cwd: string;
  scope: Exclude<ApprovalScope, "once">;
  channel: ApprovalAnswer["channel"];
  // The request a human actually answered. Reused grants name it in evidence.
  requestId: string;
}

export class ApprovalBroker {
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private channel: ApprovalChannel | null = null;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly sessionGrants: SessionGrant[] = [];

  constructor(options: ApprovalBrokerOptions = {}) {
    this.ttlMs = options.ttlMs ?? 120_000;
    this.now = options.now ?? (() => new Date());
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
    const pending: PendingApproval = { request, used: false };
    this.pending.set(request.request_id, pending);
    let answer: ApprovalAnswer | null;
    let channelError: string | null = null;
    try {
      answer = await channel.ask(request);
    } catch (error) {
      answer = null;
      channelError =
        error instanceof Error ? error.message : "approval channel failed";
    }
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
    return this.acceptAnswer(answer, request, pending);
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
      (scope !== "once" && scope !== "session" && scope !== "persistent") ||
      (scope !== "once" &&
        (request.argv === undefined || request.cwd === undefined));
    const approved = !correlationMismatch && answer.answer === "allow";
    if (approved && scope !== "once") {
      const tool = request.tool;
      if (
        tool !== undefined &&
        request.argv !== undefined &&
        request.cwd !== undefined
      ) {
        this.sessionGrants.push({
          tool,
          argv: [...request.argv],
          cwd: normalizeAbsolute(request.cwd),
          scope,
          channel: answer.channel,
          requestId: request.request_id,
        });
      }
    }
    return {
      approved,
      answer,
      evidence: approvalEvidence(request, answer),
      reason: correlationMismatch
        ? "approval answer did not match the request"
        : approved
          ? "approval allowed"
          : "approval denied",
      failure: correlationMismatch ? "mismatch" : null,
    };
  }

  private matchSessionGrant(request: ApprovalRequest): SessionGrant | null {
    if (
      request.tool === undefined ||
      request.argv === undefined ||
      request.cwd === undefined
    ) {
      return null;
    }
    const cwd = normalizeAbsolute(request.cwd);
    const grant = this.sessionGrants.find(
      (candidate) =>
        candidate.tool === request.tool &&
        candidate.cwd === cwd &&
        candidate.argv.length === request.argv!.length &&
        candidate.argv.every((value, index) => value === request.argv![index]),
    );
    return grant ?? null;
  }
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
