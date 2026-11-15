import { Type, type Static } from "typebox";
import {
  CoverageSchema,
  NonEmptyStringSchema,
  Sha256Schema,
  TimestampSchema,
  VcsBindingSchema,
} from "./common.ts";

export const VerdictValueSchema = Type.Union([
  Type.Literal("complete"),
  Type.Literal("incomplete"),
  Type.Literal("unverifiable"),
]);

export type VerdictValue = Static<typeof VerdictValueSchema>;

export const VerdictSchema = Type.Object(
  {
    version: Type.Literal(1),
    run_id: NonEmptyStringSchema,
    session_id: NonEmptyStringSchema,
    verdict: VerdictValueSchema,
    evidence_head: Type.Union([Sha256Schema, Type.Null()]),
    sign_off_id: Type.Union([Type.String(), Type.Null()]),
    signed_verdict: Type.Union([
      Type.Literal("complete"),
      Type.Literal("incomplete"),
      Type.Null(),
    ]),
    coverage: CoverageSchema,
    reasons: Type.Array(Type.String()),
    computed_at: TimestampSchema,
    vcs: VcsBindingSchema,
  },
  { additionalProperties: false },
);

export type Verdict = Static<typeof VerdictSchema>;

export const SignOffRequestSchema = Type.Object(
  {
    version: Type.Literal(1),
    run_id: NonEmptyStringSchema,
    evidence_head: Sha256Schema,
    signed_verdict: Type.Union([
      Type.Literal("complete"),
      Type.Literal("incomplete"),
    ]),
    channel: Type.Union([Type.Literal("tui"), Type.Literal("cli")]),
    actor: Type.String(),
    is_tty: Type.Boolean(),
    source: Type.Union([
      Type.Literal("human"),
      Type.Literal("tool"),
      Type.Literal("plugin"),
      Type.Literal("mcp"),
    ]),
    previous_sign_off_id: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export type SignOffRequest = Static<typeof SignOffRequestSchema>;
