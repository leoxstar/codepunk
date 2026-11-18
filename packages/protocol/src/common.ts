import { Type, type Static } from "typebox";

export const Sha256Schema = Type.String({
  pattern: "^sha256:[0-9a-f]{64}$",
  description: "Lowercase SHA-256 digest with an explicit algorithm prefix.",
});

export const TimestampSchema = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$",
  description: "UTC ISO-8601 timestamp.",
});

export const NonEmptyStringSchema = Type.String({ minLength: 1 });

export const DecisionSchema = Type.Union([
  Type.Literal("allow"),
  Type.Literal("ask"),
  Type.Literal("deny"),
]);

export type Decision = Static<typeof DecisionSchema>;

export const AutonomyProfileSchema = Type.Union([
  Type.Literal("read-only"),
  Type.Literal("ask"),
  Type.Literal("scoped"),
]);

export type AutonomyProfile = Static<typeof AutonomyProfileSchema>;

export const AutonomyRuleSchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    argv: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
    cwd: NonEmptyStringSchema,
    executable_sha256: Sha256Schema,
    rule_sha256: Sha256Schema,
  },
  { additionalProperties: false },
);

export type AutonomyRule = Static<typeof AutonomyRuleSchema>;

export const AutonomyEvidenceSchema = Type.Object(
  {
    profile: AutonomyProfileSchema,
    rule_id: Type.Union([NonEmptyStringSchema, Type.Null()]),
    rule_sha256: Type.Union([Sha256Schema, Type.Null()]),
    rules_sha256: Type.Union([Sha256Schema, Type.Null()]),
  },
  { additionalProperties: false },
);

export type AutonomyEvidence = Static<typeof AutonomyEvidenceSchema>;

export const SourceSchema = Type.Union([
  Type.Literal("tool"),
  Type.Literal("user_bash"),
  Type.Literal("plugin"),
  Type.Literal("mcp"),
]);

export type Source = Static<typeof SourceSchema>;

export const CoverageSchema = Type.Union([
  Type.Literal("enforced"),
  Type.Literal("app-layer"),
  Type.Literal("uncovered"),
]);

export type Coverage = Static<typeof CoverageSchema>;

export const PolicyLayerNameSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("project"),
  Type.Literal("headless"),
  Type.Literal("worker"),
]);

export type PolicyLayerName = Static<typeof PolicyLayerNameSchema>;

export const PolicyLayerSchema = Type.Object(
  {
    layer: PolicyLayerNameSchema,
    source: NonEmptyStringSchema,
    sha256: Sha256Schema,
    rule_sha256: Sha256Schema,
    justification: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export type PolicyLayer = Static<typeof PolicyLayerSchema>;

export const SandboxDescriptorSchema = Type.Object(
  {
    backend: Type.Union([Type.Literal("srt"), Type.Literal("none")]),
    version: Type.Union([Type.String(), Type.Null()]),
    profile_sha256: Type.Union([Sha256Schema, Type.Null()]),
    network_allowed_domains: Type.Optional(Type.Array(Type.String())),
    network_denied_domains: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export type SandboxDescriptor = Static<typeof SandboxDescriptorSchema>;

export const EffectsSchema = Type.Object(
  {
    fs: Type.Union([
      Type.Literal("none"),
      Type.Literal("read"),
      Type.Literal("write"),
      Type.Literal("unknown"),
    ]),
    shell: Type.Boolean(),
    network: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type Effects = Static<typeof EffectsSchema>;

export const BudgetLimitKindSchema = Type.Union([
  Type.Literal("tool_calls"),
  Type.Literal("wall_ms"),
  Type.Literal("tokens"),
  Type.Literal("cost"),
]);

export type BudgetLimitKind = Static<typeof BudgetLimitKindSchema>;

export const BudgetExceededSchema = Type.Object(
  {
    run_id: NonEmptyStringSchema,
    limit_kind: BudgetLimitKindSchema,
    limit: Type.Number({ minimum: 0 }),
    used: Type.Number({ minimum: 0 }),
    action: Type.Union([
      Type.Literal("reject_call"),
      Type.Literal("abort_run"),
    ]),
  },
  { additionalProperties: false },
);

export type BudgetExceeded = Static<typeof BudgetExceededSchema>;

export const VcsBindingSchema = Type.Object(
  {
    commit: Type.Union([Type.String(), Type.Null()]),
    tree: Type.Union([Type.String(), Type.Null()]),
    base_commit: Type.Union([Type.String(), Type.Null()]),
    merge_commit: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);

export type VcsBinding = Static<typeof VcsBindingSchema>;
