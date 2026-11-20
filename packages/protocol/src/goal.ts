import { Type, type Static } from "typebox";
import {
  NonEmptyStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "./common.ts";

export const GoalStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("cleared"),
]);

export type GoalStatus = Static<typeof GoalStatusSchema>;

export const GoalActionSchema = Type.Union([
  Type.Literal("set"),
  Type.Literal("pause"),
  Type.Literal("resume"),
  Type.Literal("clear"),
]);

export type GoalAction = Static<typeof GoalActionSchema>;

export const GoalStateSchema = Type.Object(
  {
    goal_id: NonEmptyStringSchema,
    objective: Type.String({ minLength: 1, maxLength: 8_192 }),
    status: GoalStatusSchema,
    revision: Type.Integer({ minimum: 1 }),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  },
  { additionalProperties: false },
);

export type GoalState = Static<typeof GoalStateSchema>;

export const GoalEventDataSchema = Type.Object(
  {
    action: GoalActionSchema,
    previous_sha256: Type.Union([Sha256Schema, Type.Null()]),
    goal: GoalStateSchema,
    event_sha256: Sha256Schema,
  },
  { additionalProperties: false },
);

export type GoalEventData = Static<typeof GoalEventDataSchema>;

export const GoalErrorDataSchema = Type.Object(
  {
    version: Type.Literal(1),
    code: Type.Union([
      Type.Literal("goal.corrupt"),
      Type.Literal("goal.inject_failed"),
    ]),
    reason: Type.String({ minLength: 1, maxLength: 2_000 }),
    created_at: TimestampSchema,
  },
  { additionalProperties: false },
);

export type GoalErrorData = Static<typeof GoalErrorDataSchema>;
