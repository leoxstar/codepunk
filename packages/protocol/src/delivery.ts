import { Type, type Static } from "typebox";
import {
  NonEmptyStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "./common.ts";

const CommitIdSchema = Type.String({
  pattern: "^[0-9a-f]{40,64}$",
  description: "Lowercase Git commit id.",
});

const PathStringSchema = Type.String({ minLength: 1 });

export const TaskBudgetSchema = Type.Object(
  {
    max_wall_ms: Type.Integer({ minimum: 1 }),
    max_tool_calls: Type.Integer({ minimum: 1 }),
    max_disk_bytes: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const TaskSpecSchema = Type.Object(
  {
    version: Type.Literal(1),
    task_id: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    objective: NonEmptyStringSchema,
    base_commit: CommitIdSchema,
    write_set: Type.Array(PathStringSchema, { minItems: 1 }),
    protected_paths: Type.Array(PathStringSchema),
    acceptance: Type.Array(NonEmptyStringSchema),
    budget: TaskBudgetSchema,
    isolation: Type.Union([Type.Literal("worktree"), Type.Literal("shared")]),
    created_at: TimestampSchema,
    spec_sha256: Sha256Schema,
  },
  { additionalProperties: false },
);

export type TaskSpec = Static<typeof TaskSpecSchema>;

export const HandoffFileSchema = Type.Object(
  {
    path: PathStringSchema,
    before_sha256: Type.Union([Sha256Schema, Type.Null()]),
    after_sha256: Type.Union([Sha256Schema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const HandoffEvidenceSchema = Type.Object(
  {
    session_id: NonEmptyStringSchema,
    first_seq: Type.Integer({ minimum: 1 }),
    last_seq: Type.Integer({ minimum: 1 }),
    head_sha256: Sha256Schema,
  },
  { additionalProperties: false },
);

export const HandoffClaimSchema = Type.Object(
  {
    claim_id: Type.Union([NonEmptyStringSchema, Type.Null()]),
    fence: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    lease: Type.Union([
      Type.Object(
        {
          ttl_ms: Type.Integer({ minimum: 1 }),
          expires_at: TimestampSchema,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    acquired_at: Type.Union([TimestampSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const HandoffVerdictSchema = Type.Object(
  {
    value: Type.Union([
      Type.Literal("complete"),
      Type.Literal("incomplete"),
      Type.Literal("unverifiable"),
    ]),
    sign_off_id: Type.Union([NonEmptyStringSchema, Type.Null()]),
    evidence_head: Sha256Schema,
  },
  { additionalProperties: false },
);

export const TaskHandoffSchema = Type.Object(
  {
    version: Type.Literal(1),
    task_id: NonEmptyStringSchema,
    spec_sha256: Sha256Schema,
    run_id: NonEmptyStringSchema,
    worker_id: NonEmptyStringSchema,
    base_commit: CommitIdSchema,
    head_commit: CommitIdSchema,
    tree: NonEmptyStringSchema,
    diff_sha256: Sha256Schema,
    changed_paths: Type.Array(PathStringSchema),
    files: Type.Array(HandoffFileSchema),
    write_set: Type.Array(PathStringSchema),
    protected_paths: Type.Array(PathStringSchema),
    evidence: HandoffEvidenceSchema,
    claim: HandoffClaimSchema,
    verdict: HandoffVerdictSchema,
    open_issues: Type.Array(Type.String()),
    created_at: TimestampSchema,
  },
  { additionalProperties: false },
);

export type TaskHandoff = Static<typeof TaskHandoffSchema>;

export const MergeRecordSchema = Type.Object(
  {
    version: Type.Literal(1),
    merge_id: NonEmptyStringSchema,
    task_id: NonEmptyStringSchema,
    handoff_head: CommitIdSchema,
    base_commit: CommitIdSchema,
    merge_commit: CommitIdSchema,
    tree: NonEmptyStringSchema,
    diff_sha256: Sha256Schema,
    actor: NonEmptyStringSchema,
    at: TimestampSchema,
  },
  { additionalProperties: false },
);

export type MergeRecord = Static<typeof MergeRecordSchema>;
