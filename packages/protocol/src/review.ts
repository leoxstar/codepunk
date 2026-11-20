import { Type, type Static } from "typebox";
import {
  NonEmptyStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "./common.ts";

export const ReviewSeveritySchema = Type.Union([
  Type.Literal("critical"),
  Type.Literal("high"),
  Type.Literal("medium"),
  Type.Literal("low"),
  Type.Literal("info"),
]);

export type ReviewSeverity = Static<typeof ReviewSeveritySchema>;

export const ReviewFindingSchema = Type.Object(
  {
    severity: ReviewSeveritySchema,
    file: Type.String({
      minLength: 1,
      maxLength: 1_024,
      pattern: "^(?!/)(?!.*\\\\).*[^/]$",
      description: "Repository-relative path using forward slashes.",
    }),
    line: Type.Integer({ minimum: 1 }),
    reason: Type.String({ minLength: 1, maxLength: 2_000 }),
  },
  { additionalProperties: false },
);

export type ReviewFinding = Static<typeof ReviewFindingSchema>;

export const StructuredReviewSchema = Type.Object(
  {
    version: Type.Literal(1),
    review_id: NonEmptyStringSchema,
    session_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    diff_sha256: Sha256Schema,
    changed_paths: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
    findings: Type.Array(ReviewFindingSchema, { maxItems: 200 }),
    created_at: TimestampSchema,
  },
  { additionalProperties: false },
);

export type StructuredReview = Static<typeof StructuredReviewSchema>;

export const ReviewEventDataSchema = StructuredReviewSchema;

export type ReviewEventData = Static<typeof ReviewEventDataSchema>;

export const ReviewErrorDataSchema = Type.Object(
  {
    version: Type.Literal(1),
    session_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    reason: Type.String({ minLength: 1, maxLength: 2_000 }),
    created_at: TimestampSchema,
  },
  { additionalProperties: false },
);

export type ReviewErrorData = Static<typeof ReviewErrorDataSchema>;
