import { Type, type Static } from "typebox";
import { NonEmptyStringSchema, TimestampSchema } from "./common.ts";

export const WorkSourceSchema = Type.Union([
  Type.Literal("local"),
  Type.Literal("github"),
]);

export const WorkItemSchema = Type.Object(
  {
    version: Type.Literal(1),
    id: NonEmptyStringSchema,
    source: WorkSourceSchema,
    title: NonEmptyStringSchema,
    body: Type.String(),
    url: Type.Union([Type.String(), Type.Null()]),
    labels: Type.Array(Type.String()),
    created_at: TimestampSchema,
  },
  { additionalProperties: false },
);

export type WorkItem = Static<typeof WorkItemSchema>;

export const NotificationKindSchema = Type.Union([
  Type.Literal("task"),
  Type.Literal("worker"),
  Type.Literal("review"),
  Type.Literal("merge"),
  Type.Literal("system"),
]);

export const NotificationSchema = Type.Object(
  {
    version: Type.Literal(1),
    id: NonEmptyStringSchema,
    kind: NotificationKindSchema,
    title: NonEmptyStringSchema,
    body: Type.String(),
    task_id: Type.Union([Type.String(), Type.Null()]),
    created_at: TimestampSchema,
  },
  { additionalProperties: false },
);

export type Notification = Static<typeof NotificationSchema>;
