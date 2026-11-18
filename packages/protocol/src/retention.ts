import { Type, type Static } from "typebox";
import {
  NonEmptyStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "./common.ts";

export const RetentionOperationSchema = Type.Object(
  {
    type: Type.Literal("codepunk/retention-operation"),
    version: Type.Literal(1),
    seq: Type.Integer({ minimum: 1 }),
    prev_sha256: Type.Union([Sha256Schema, Type.Null()]),
    at: TimestampSchema,
    action: Type.Union([
      Type.Literal("gc"),
      Type.Literal("migrate"),
      Type.Literal("backup.create"),
      Type.Literal("backup.restore"),
    ]),
    mode: Type.Union([
      Type.Literal("check"),
      Type.Literal("dry-run"),
      Type.Literal("apply"),
      Type.Literal("restore"),
    ]),
    paths: Type.Array(
      Type.Object(
        {
          path: NonEmptyStringSchema,
          before_sha256: Type.Union([Sha256Schema, Type.Null()]),
          after_sha256: Type.Union([Sha256Schema, Type.Null()]),
          bytes: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
    backup_id: Type.Union([NonEmptyStringSchema, Type.Null()]),
    exit_code: Type.Integer(),
    failure: Type.Union([NonEmptyStringSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export type RetentionOperation = Static<typeof RetentionOperationSchema>;
