import { Type, type Static } from "typebox";
import { NonEmptyStringSchema, TimestampSchema } from "./common.ts";
import {
  SessionEventSchema,
  SessionHeaderSchema,
  SessionMetaSchema,
} from "./session.ts";
import { PROTOCOL_VERSION } from "./version.ts";

export const DAEMON_PROTOCOL_VERSION = PROTOCOL_VERSION;
export const DAEMON_REQUEST_MAX_BYTES = 64 * 1024;
export const DAEMON_RESPONSE_MAX_BYTES = 1024 * 1024;
export const DAEMON_DEFAULT_PAGE_SIZE = 100;
export const DAEMON_MAX_PAGE_SIZE = 100;
export const DAEMON_MAX_CONNECTIONS = 32;
export const DAEMON_REQUEST_TIMEOUT_MS = 5_000;

export const DAEMON_METHODS = [
  "daemon/hello",
  "session/list",
  "session/read",
  "session/pin",
] as const;

const DaemonMethodSchema = Type.Union([
  Type.Literal("daemon/hello"),
  Type.Literal("session/list"),
  Type.Literal("session/read"),
  Type.Literal("session/pin"),
]);

export const DaemonRequestIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9._:-]+$",
});

export const DaemonSessionIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9_-]+$",
});

export const DaemonErrorCodeSchema = Type.Union([
  Type.Literal("protocol.invalid_request"),
  Type.Literal("protocol.version_mismatch"),
  Type.Literal("daemon.read_only"),
  Type.Literal("daemon.not_found"),
  Type.Literal("daemon.request_too_large"),
  Type.Literal("daemon.response_too_large"),
  Type.Literal("daemon.timeout"),
  Type.Literal("daemon.internal"),
]);

export type DaemonErrorCode = Static<typeof DaemonErrorCodeSchema>;

export const DaemonErrorSchema = Type.Object(
  {
    code: DaemonErrorCodeSchema,
    message: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export type DaemonError = Static<typeof DaemonErrorSchema>;

/**
 * `read_only` describes the whole wire surface, not one method: it is `true`
 * only while every advertised method is a read. `session/pin` makes it
 * `false`, while `DaemonSessionReadResultSchema.read_only` keeps describing
 * that one response, which is still a read-only snapshot.
 */
export const DaemonHelloResultSchema = Type.Object(
  {
    protocol_version: Type.Literal(1),
    read_only: Type.Boolean(),
    methods: Type.Array(DaemonMethodSchema),
    pid: Type.Integer({ minimum: 1 }),
    started_at: TimestampSchema,
  },
  { additionalProperties: false },
);

export type DaemonHelloResult = Static<typeof DaemonHelloResultSchema>;

export const DaemonSessionSummarySchema = Type.Object(
  {
    id: DaemonSessionIdSchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    title: Type.Union([Type.String(), Type.Null()]),
    pinned: Type.Boolean(),
    last_seq: Type.Integer({ minimum: 0 }),
    cwd: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export type DaemonSessionSummary = Static<typeof DaemonSessionSummarySchema>;

export const DaemonSessionListResultSchema = Type.Object(
  {
    sessions: Type.Array(DaemonSessionSummarySchema),
  },
  { additionalProperties: false },
);

export type DaemonSessionListResult = Static<
  typeof DaemonSessionListResultSchema
>;

export const DaemonSessionReadResultSchema = Type.Object(
  {
    header: SessionHeaderSchema,
    metadata: SessionMetaSchema,
    events: Type.Array(SessionEventSchema),
    after_seq: Type.Integer({ minimum: 0 }),
    next_seq: Type.Integer({ minimum: 0 }),
    has_more: Type.Boolean(),
    read_only: Type.Literal(true),
  },
  { additionalProperties: false },
);

export type DaemonSessionReadResult = Static<
  typeof DaemonSessionReadResultSchema
>;

export const DaemonSessionPinResultSchema = Type.Object(
  {
    session_id: DaemonSessionIdSchema,
    pinned: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type DaemonSessionPinResult = Static<
  typeof DaemonSessionPinResultSchema
>;

const RequestBase = {
  type: Type.Literal("codepunk/daemon-request"),
  version: Type.Literal(DAEMON_PROTOCOL_VERSION),
  request_id: DaemonRequestIdSchema,
};

export const DaemonHelloRequestSchema = Type.Object(
  {
    ...RequestBase,
    method: Type.Literal("daemon/hello"),
    params: Type.Object({}, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

export const DaemonSessionListRequestSchema = Type.Object(
  {
    ...RequestBase,
    method: Type.Literal("session/list"),
    params: Type.Object({}, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

export const DaemonSessionReadRequestSchema = Type.Object(
  {
    ...RequestBase,
    method: Type.Literal("session/read"),
    params: Type.Object(
      {
        session_id: DaemonSessionIdSchema,
        after_seq: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: DAEMON_MAX_PAGE_SIZE }),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const DaemonSessionPinRequestSchema = Type.Object(
  {
    ...RequestBase,
    method: Type.Literal("session/pin"),
    params: Type.Object(
      {
        session_id: DaemonSessionIdSchema,
        pinned: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const DaemonRequestSchema = Type.Union([
  DaemonHelloRequestSchema,
  DaemonSessionListRequestSchema,
  DaemonSessionReadRequestSchema,
  DaemonSessionPinRequestSchema,
]);

export type DaemonRequest = Static<typeof DaemonRequestSchema>;

const ResponseBase = {
  type: Type.Literal("codepunk/daemon-response"),
  version: Type.Literal(DAEMON_PROTOCOL_VERSION),
  request_id: DaemonRequestIdSchema,
};

export const DaemonHelloResponseSchema = Type.Object(
  {
    ...ResponseBase,
    ok: Type.Literal(true),
    result: DaemonHelloResultSchema,
  },
  { additionalProperties: false },
);

export const DaemonSessionListResponseSchema = Type.Object(
  {
    ...ResponseBase,
    ok: Type.Literal(true),
    result: DaemonSessionListResultSchema,
  },
  { additionalProperties: false },
);

export const DaemonSessionReadResponseSchema = Type.Object(
  {
    ...ResponseBase,
    ok: Type.Literal(true),
    result: DaemonSessionReadResultSchema,
  },
  { additionalProperties: false },
);

export const DaemonSessionPinResponseSchema = Type.Object(
  {
    ...ResponseBase,
    ok: Type.Literal(true),
    result: DaemonSessionPinResultSchema,
  },
  { additionalProperties: false },
);

export const DaemonErrorResponseSchema = Type.Object(
  {
    ...ResponseBase,
    ok: Type.Literal(false),
    error: DaemonErrorSchema,
  },
  { additionalProperties: false },
);

export const DaemonResponseSchema = Type.Union([
  DaemonHelloResponseSchema,
  DaemonSessionListResponseSchema,
  DaemonSessionReadResponseSchema,
  DaemonSessionPinResponseSchema,
  DaemonErrorResponseSchema,
]);

export type DaemonResponse = Static<typeof DaemonResponseSchema>;
