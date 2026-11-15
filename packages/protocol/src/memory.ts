import { Type, type Static } from "typebox";
import {
  NonEmptyStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "./common.ts";

export const MemoryScopeSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("project"),
]);

export type MemoryScope = Static<typeof MemoryScopeSchema>;

export const MemoryKindSchema = Type.Union([
  Type.Literal("fact"),
  Type.Literal("preference"),
  Type.Literal("decision"),
  Type.Literal("convention"),
  Type.Literal("pitfall"),
  Type.Literal("session_summary"),
  Type.Literal("task_summary"),
]);

export type MemoryKind = Static<typeof MemoryKindSchema>;

export const MemorySourceSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("session_summary"),
  Type.Literal("task_summary"),
  Type.Literal("import"),
]);

export type MemorySource = Static<typeof MemorySourceSchema>;

export const MemoryDurabilitySchema = Type.Union([
  Type.Literal("temporary"),
  Type.Literal("project"),
  Type.Literal("permanent"),
]);

export type MemoryDurability = Static<typeof MemoryDurabilitySchema>;

export const MemoryStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("active"),
  Type.Literal("superseded"),
  Type.Literal("archived"),
]);

export type MemoryStatus = Static<typeof MemoryStatusSchema>;

export const MemoryRecordSchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    scope: MemoryScopeSchema,
    task_id: Type.Union([Type.String(), Type.Null()]),
    kind: MemoryKindSchema,
    content: Type.String({ minLength: 1, maxLength: 2_048 }),
    source: MemorySourceSchema,
    source_refs: Type.Array(NonEmptyStringSchema),
    tags: Type.Array(Type.String()),
    importance: Type.Number({ minimum: 0, maximum: 1 }),
    durability: MemoryDurabilitySchema,
    status: MemoryStatusSchema,
    supersedes: Type.Union([Type.String(), Type.Null()]),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    last_used_at: Type.Union([TimestampSchema, Type.Null()]),
    access_count: Type.Integer({ minimum: 0 }),
    content_sha256: Sha256Schema,
  },
  { additionalProperties: false },
);

export type MemoryRecord = Static<typeof MemoryRecordSchema>;

export const MemoryRecordArraySchema = Type.Array(MemoryRecordSchema);
