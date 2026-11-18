import { Type, type Static } from "typebox";
import {
  DecisionSchema,
  NonEmptyStringSchema,
  PolicyLayerSchema,
  Sha256Schema,
} from "./common.ts";

export const PolicyMatchSchema = Type.Object(
  {
    tool: NonEmptyStringSchema,
    path: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    argv: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export type PolicyMatch = Static<typeof PolicyMatchSchema>;

export const PolicyDecisionSchema = Type.Object(
  {
    version: Type.Literal(1),
    decision: DecisionSchema,
    approval_class: Type.Optional(
      Type.Union([
        Type.Literal("routine"),
        Type.Literal("shell"),
        Type.Literal("dynamic"),
        Type.Literal("network"),
        Type.Literal("exec"),
        Type.Literal("destructive"),
        Type.Literal("policy"),
        Type.Literal("protected"),
        Type.Literal("sensitive"),
        Type.Literal("mcp"),
        Type.Literal("unknown"),
      ]),
    ),
    rule: NonEmptyStringSchema,
    rule_sha256: Sha256Schema,
    justification: Type.Optional(NonEmptyStringSchema),
    reason: NonEmptyStringSchema,
    layers: Type.Array(PolicyLayerSchema),
    match: PolicyMatchSchema,
    requires_approval: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type PolicyDecision = Static<typeof PolicyDecisionSchema>;
