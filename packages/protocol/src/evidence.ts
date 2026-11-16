import { Type, type Static } from "typebox";
import {
  AutonomyEvidenceSchema,
  CoverageSchema,
  DecisionSchema,
  EffectsSchema,
  NonEmptyStringSchema,
  PolicyLayerSchema,
  SandboxDescriptorSchema,
  Sha256Schema,
  SourceSchema,
  TimestampSchema,
  VcsBindingSchema,
} from "./common.ts";
import { ApprovalEvidenceSchema, ReviewerEvidenceSchema } from "./approval.ts";

export const MemoryEvidenceSchema = Type.Object(
  {
    ids: Type.Array(Type.String()),
    action: Type.Union([
      Type.Literal("read"),
      Type.Literal("write"),
      Type.Literal("delete"),
      Type.Literal("none"),
    ]),
    query_sha256: Type.Union([Sha256Schema, Type.Null()]),
    cap: Type.Integer({ minimum: 0 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type MemoryEvidence = Static<typeof MemoryEvidenceSchema>;

export const PathCheckSchema = Type.Object(
  {
    performed: Type.Boolean(),
    target: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const EvidenceRecordSchema = Type.Object(
  {
    version: Type.Literal(1),
    id: NonEmptyStringSchema,
    seq: Type.Integer({ minimum: 1 }),
    prev_sha256: Type.Union([Sha256Schema, Type.Null()]),
    task_id: Type.Union([Type.String(), Type.Null()]),
    run_id: NonEmptyStringSchema,
    session_id: NonEmptyStringSchema,
    source: SourceSchema,
    tool: NonEmptyStringSchema,
    tool_call_id: NonEmptyStringSchema,
    decision: DecisionSchema,
    outcome: Type.Optional(
      Type.Union([
        Type.Literal("completed"),
        Type.Literal("failed"),
        Type.Literal("cancelled"),
        Type.Literal("denied"),
      ]),
    ),
    rule: NonEmptyStringSchema,
    rule_sha256: Sha256Schema,
    policy_layers: Type.Array(PolicyLayerSchema),
    approval: Type.Union([ApprovalEvidenceSchema, Type.Null()]),
    // Effective approval mode at call time. An operator-set environment
    // variable that loosens the file-configured mode is visible here, not only
    // in the startup warnings.
    approval_mode: Type.Optional(
      Type.Union([
        Type.Literal("ask"),
        Type.Literal("deny"),
        Type.Literal("auto"),
        Type.Literal("allow"),
      ]),
    ),
    reviewer: Type.Optional(Type.Union([ReviewerEvidenceSchema, Type.Null()])),
    command: Type.Union([Type.String(), Type.Null()]),
    command_argv: Type.Union([Type.Array(Type.String()), Type.Null()]),
    cwd: NonEmptyStringSchema,
    workspace_root: NonEmptyStringSchema,
    path_check: PathCheckSchema,
    sandbox: SandboxDescriptorSchema,
    effects: EffectsSchema,
    coverage: CoverageSchema,
    coverage_basis: Type.Array(Type.String()),
    exit_code: Type.Union([Type.Integer(), Type.Null()]),
    duration_ms: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    before_sha256: Type.Union([Sha256Schema, Type.Null()]),
    after_sha256: Type.Union([Sha256Schema, Type.Null()]),
    diff_sha256: Type.Union([Sha256Schema, Type.Null()]),
    output_ref: Type.Union([Type.String(), Type.Null()]),
    output_sha256: Type.Union([Sha256Schema, Type.Null()]),
    output_preview: Type.String(),
    empty_result: Type.Union([Type.Boolean(), Type.Null()]),
    executor: Type.Union([Type.String(), Type.Null()]),
    vcs: VcsBindingSchema,
    memory: MemoryEvidenceSchema,
    autonomy: Type.Optional(Type.Union([AutonomyEvidenceSchema, Type.Null()])),
    created_at: TimestampSchema,
  },
  { additionalProperties: false },
);

export type EvidenceRecord = Static<typeof EvidenceRecordSchema>;

export const EvidenceRecordArraySchema = Type.Array(EvidenceRecordSchema);
