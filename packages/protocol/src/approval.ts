import { Type, type Static } from "typebox";
import {
  NonEmptyStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "./common.ts";

export const ApprovalScopeSchema = Type.Union([
  Type.Literal("once"),
  Type.Literal("session"),
  Type.Literal("persistent"),
]);

export type ApprovalScope = Static<typeof ApprovalScopeSchema>;

export const ApprovalRequestSchema = Type.Object(
  {
    request_id: NonEmptyStringSchema,
    nonce_sha256: Sha256Schema,
    ttl_ms: Type.Integer({ minimum: 1 }),
    worker_id: NonEmptyStringSchema,
    session_id: NonEmptyStringSchema,
    tool_call_id: NonEmptyStringSchema,
    channel_id: NonEmptyStringSchema,
    tool: Type.Optional(NonEmptyStringSchema),
    command: Type.Optional(Type.String()),
    argv: Type.Optional(Type.Array(Type.String())),
    cwd: Type.Optional(NonEmptyStringSchema),
    path: Type.Optional(NonEmptyStringSchema),
    reason: Type.Optional(NonEmptyStringSchema),
    args_preview: Type.Optional(Type.String()),
    args_sha256: Type.Optional(Sha256Schema),
    diff_preview: Type.Optional(Type.String()),
    diff_sha256: Type.Optional(Sha256Schema),
    coverage_preview: Type.Optional(NonEmptyStringSchema),
    created_at: TimestampSchema,
    expires_at: TimestampSchema,
  },
  { additionalProperties: false },
);

export type ApprovalRequest = Static<typeof ApprovalRequestSchema>;

export const ApprovalAnswerSchema = Type.Object(
  {
    request_id: NonEmptyStringSchema,
    answer: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    scope: Type.Optional(ApprovalScopeSchema),
    guidance: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    channel: NonEmptyStringSchema,
    channel_id: NonEmptyStringSchema,
    nonce_sha256: Sha256Schema,
    worker_id: NonEmptyStringSchema,
    session_id: NonEmptyStringSchema,
    tool_call_id: NonEmptyStringSchema,
    answered_at: TimestampSchema,
  },
  { additionalProperties: false },
);

export type ApprovalAnswer = Static<typeof ApprovalAnswerSchema>;

export const ApprovalEvidenceSchema = Type.Object(
  {
    channel: NonEmptyStringSchema,
    request_id: NonEmptyStringSchema,
    nonce_sha256: Sha256Schema,
    ttl_ms: Type.Integer({ minimum: 1 }),
    worker_id: NonEmptyStringSchema,
    session_id: NonEmptyStringSchema,
    tool_call_id: NonEmptyStringSchema,
    answer: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    scope: Type.Optional(ApprovalScopeSchema),
    guidance: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    args_sha256: Type.Optional(Sha256Schema),
    diff_sha256: Type.Optional(Sha256Schema),
  },
  { additionalProperties: false },
);

export type ApprovalEvidence = Static<typeof ApprovalEvidenceSchema>;

export const ReviewerEvidenceSchema = Type.Object(
  {
    kind: Type.Literal("model"),
    provider: NonEmptyStringSchema,
    model: NonEmptyStringSchema,
    decision: Type.Union([
      Type.Literal("allow"),
      Type.Literal("deny"),
      Type.Literal("abstain"),
    ]),
    reason: Type.String({ maxLength: 2000 }),
    action_sha256: Sha256Schema,
    latency_ms: Type.Number({ minimum: 0 }),
    error: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);

export type ReviewerEvidence = Static<typeof ReviewerEvidenceSchema>;

export const ApprovalRequestArraySchema = Type.Array(ApprovalRequestSchema);
