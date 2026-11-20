import { Type, type Static } from "typebox";
import {
  NonEmptyStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "./common.ts";

export const HookLifecycleEventSchema = Type.Union([
  Type.Literal("before_tool"),
  Type.Literal("after_tool"),
  Type.Literal("session_start"),
  Type.Literal("session_end"),
]);

export type HookLifecycleEvent = Static<typeof HookLifecycleEventSchema>;

export const HookDefinitionSchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z0-9._-]+$",
    }),
    event: HookLifecycleEventSchema,
    argv: Type.Array(NonEmptyStringSchema, { minItems: 1, maxItems: 64 }),
    timeout_ms: Type.Integer({ minimum: 1, maximum: 120_000 }),
    max_output_bytes: Type.Integer({
      minimum: 1,
      maximum: 1024 * 1024,
    }),
    fail_closed: Type.Literal(true),
  },
  { additionalProperties: false },
);

export type HookDefinition = Static<typeof HookDefinitionSchema>;

export const HooksConfigSchema = Type.Object(
  {
    version: Type.Literal(1),
    /**
     * User-scope only. Project hook files may contain hook definitions but
     * cannot authorize their own execution.
     */
    project_enabled: Type.Optional(Type.Boolean({ default: false })),
    hooks: Type.Array(HookDefinitionSchema, { maxItems: 64 }),
  },
  { additionalProperties: false },
);

export type HooksConfig = Static<typeof HooksConfigSchema>;

export const HookScopeSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("project"),
]);

export type HookScope = Static<typeof HookScopeSchema>;

export const HookEvidenceSchema = Type.Object(
  {
    version: Type.Literal(1),
    hook_name: Type.String({ minLength: 1, maxLength: 64 }),
    event: HookLifecycleEventSchema,
    scope: HookScopeSchema,
    outcome: Type.Union([
      Type.Literal("passed"),
      Type.Literal("failed"),
      Type.Literal("timed_out"),
      Type.Literal("rejected"),
      Type.Literal("skipped"),
    ]),
    exit_code: Type.Union([Type.Integer(), Type.Null()]),
    duration_ms: Type.Number({ minimum: 0 }),
    stdout_sha256: Type.Union([Sha256Schema, Type.Null()]),
    stderr_sha256: Type.Union([Sha256Schema, Type.Null()]),
    reason: Type.Union([
      Type.String({ minLength: 1, maxLength: 2_000 }),
      Type.Null(),
    ]),
    recorded_at: TimestampSchema,
  },
  { additionalProperties: false },
);

export type HookEvidence = Static<typeof HookEvidenceSchema>;
