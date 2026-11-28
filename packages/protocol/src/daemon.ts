import { Type, type Static } from "typebox";
import {
  NonEmptyStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "./common.ts";
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
export const DAEMON_WRITE_LEASE_TTL_MS = 120_000;
export const DAEMON_METHOD_LIMIT = 2_000;
export const DAEMON_REASON_LIMIT = 2_000;
export const DAEMON_MESSAGE_LIMIT = 512;

export const DAEMON_METHODS = [
  "daemon/hello",
  "session/list",
  "session/read",
  "session/pin",
  "session/new",
  "session/run",
  "session/steer",
  "session/stop",
  "session/approve",
  "session/plan",
  "session/goal",
] as const;

export const DAEMON_READ_METHODS = [
  "daemon/hello",
  "session/list",
  "session/read",
] as const;

export const DAEMON_SESSION_METHODS = ["session/pin", "session/new"] as const;

export const DAEMON_RUN_METHODS = [
  "session/run",
  "session/steer",
  "session/stop",
] as const;

export const DAEMON_APPROVAL_METHODS = ["session/approve"] as const;

export const DAEMON_PLAN_METHODS = ["session/plan"] as const;

export const DAEMON_GOAL_METHODS = ["session/goal"] as const;

export const DAEMON_METHOD_SCOPES = {
  "daemon/hello": "daemon:read",
  "session/list": "sessions:read",
  "session/read": "sessions:read",
  "session/pin": "sessions:write",
  "session/new": "sessions:write",
  "session/run": "runs:write",
  "session/steer": "runs:write",
  "session/stop": "runs:write",
  "session/approve": "approvals:write",
  "session/plan": "plan:write",
  "session/goal": "goal:write",
} as const;

export const DAEMON_SCOPES = [
  "daemon:read",
  "sessions:read",
  "sessions:write",
  "runs:write",
  "approvals:write",
  "plan:write",
  "goal:write",
] as const;

export type DaemonScope = (typeof DAEMON_SCOPES)[number];

const DaemonErrorMessageSchema = Type.String({
  minLength: 1,
  maxLength: DAEMON_MESSAGE_LIMIT,
});

export const DaemonReasonSchema = Type.String({
  minLength: 1,
  maxLength: DAEMON_REASON_LIMIT,
});

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
  Type.Literal("daemon.scope_denied"),
  Type.Literal("daemon.write_conflict"),
  Type.Literal("daemon.approval_mismatch"),
  Type.Literal("daemon.run_failed"),
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
    message: DaemonErrorMessageSchema,
  },
  { additionalProperties: false },
);

export type DaemonError = Static<typeof DaemonErrorSchema>;

export const DaemonWriterLeaseSchema = Type.Object(
  {
    session_id: DaemonSessionIdSchema,
    run_id: NonEmptyStringSchema,
    token: NonEmptyStringSchema,
    channel_id: NonEmptyStringSchema,
    expires_at: TimestampSchema,
  },
  { additionalProperties: false },
);

export type DaemonWriterLease = Static<typeof DaemonWriterLeaseSchema>;

export const DaemonControlEventSchema = Type.Object(
  {
    type: Type.Literal("codepunk/daemon-control-event"),
    version: Type.Literal(DAEMON_PROTOCOL_VERSION),
    session_id: DaemonSessionIdSchema,
    run_id: NonEmptyStringSchema,
    seq: Type.Integer({ minimum: 1 }),
    kind: Type.Union([
      Type.Literal("control/accepted"),
      Type.Literal("control/started"),
      Type.Literal("control/message"),
      Type.Literal("control/completed"),
      Type.Literal("control/stopped"),
      Type.Literal("control/error"),
    ]),
    reason: Type.Optional(DaemonReasonSchema),
  },
  { additionalProperties: false },
);

export type DaemonControlEvent = Static<typeof DaemonControlEventSchema>;

/**
 * `read_only` describes the whole wire surface, not one method: it is `true`
 * only while every advertised method is a read. `session/pin` makes it
 * `false`, while `DaemonSessionReadResultSchema.read_only` keeps describing
 * that one response, which is still a read-only snapshot.
 */
export const DaemonHelloResultSchema = Type.Object(
  {
    protocol_version: Type.Literal(DAEMON_PROTOCOL_VERSION),
    read_only: Type.Boolean(),
    methods: Type.Array(
      Type.Union([
        Type.Literal("daemon/hello"),
        Type.Literal("session/list"),
        Type.Literal("session/read"),
        Type.Literal("session/pin"),
        Type.Literal("session/new"),
        Type.Literal("session/run"),
        Type.Literal("session/steer"),
        Type.Literal("session/stop"),
        Type.Literal("session/approve"),
        Type.Literal("session/plan"),
        Type.Literal("session/goal"),
      ]),
    ),
    scopes: Type.Array(
      Type.Union([
        Type.Literal("daemon:read"),
        Type.Literal("sessions:read"),
        Type.Literal("sessions:write"),
        Type.Literal("runs:write"),
        Type.Literal("approvals:write"),
        Type.Literal("plan:write"),
        Type.Literal("goal:write"),
      ]),
    ),
    method_scopes: Type.Object({
      "daemon/hello": Type.Literal(DAEMON_METHOD_SCOPES["daemon/hello"]),
      "session/list": Type.Literal(DAEMON_METHOD_SCOPES["session/list"]),
      "session/read": Type.Literal(DAEMON_METHOD_SCOPES["session/read"]),
      "session/pin": Type.Literal(DAEMON_METHOD_SCOPES["session/pin"]),
      "session/new": Type.Literal(DAEMON_METHOD_SCOPES["session/new"]),
      "session/run": Type.Literal(DAEMON_METHOD_SCOPES["session/run"]),
      "session/steer": Type.Literal(DAEMON_METHOD_SCOPES["session/steer"]),
      "session/stop": Type.Literal(DAEMON_METHOD_SCOPES["session/stop"]),
      "session/approve": Type.Literal(DAEMON_METHOD_SCOPES["session/approve"]),
      "session/plan": Type.Literal(DAEMON_METHOD_SCOPES["session/plan"]),
      "session/goal": Type.Literal(DAEMON_METHOD_SCOPES["session/goal"]),
    }),
    write_lease_ttl_ms: Type.Literal(DAEMON_WRITE_LEASE_TTL_MS),
    compatibility: Type.Literal(
      "v1 responses and four original methods remain valid; control methods and events are additive v1",
    ),
    pid: Type.Integer({ minimum: 1 }),
    started_at: TimestampSchema,
  },
  { additionalProperties: false },
);

export type DaemonHelloResult = Static<typeof DaemonHelloResultSchema>;

const RequestBase = {
  type: Type.Literal("codepunk/daemon-request"),
  version: Type.Literal(DAEMON_PROTOCOL_VERSION),
  request_id: DaemonRequestIdSchema,
};

const BaseControlParams = {
  session_id: DaemonSessionIdSchema,
  writer_lease: DaemonWriterLeaseSchema,
  reason: DaemonReasonSchema,
};

export const DaemonSessionRunRequestSchema = Type.Object(
  {
    ...RequestBase,
    method: Type.Literal("session/run"),
    params: Type.Object(
      {
        ...BaseControlParams,
        prompt: Type.String({ minLength: 1, maxLength: 32_000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const DaemonSessionSteerRequestSchema = Type.Object(
  {
    ...RequestBase,
    method: Type.Literal("session/steer"),
    params: Type.Object(
      {
        ...BaseControlParams,
        message: Type.String({ minLength: 1, maxLength: 32_000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const DaemonSessionStopRequestSchema = Type.Object(
  {
    ...RequestBase,
    method: Type.Literal("session/stop"),
    params: Type.Object(
      { ...BaseControlParams },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const DaemonSessionApproveRequestSchema = Type.Object(
  {
    ...RequestBase,
    method: Type.Literal("session/approve"),
    params: Type.Object(
      {
        ...BaseControlParams,
        approval_id: NonEmptyStringSchema,
        nonce_sha256: Sha256Schema,
        approved: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const DaemonSessionPlanRequestSchema = Type.Object(
  {
    ...RequestBase,
    method: Type.Literal("session/plan"),
    params: Type.Object(
      {
        ...BaseControlParams,
        plan: Type.String({ minLength: 1, maxLength: 32_000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const DaemonSessionGoalRequestSchema = Type.Object(
  {
    ...RequestBase,
    method: Type.Literal("session/goal"),
    params: Type.Object(
      {
        ...BaseControlParams,
        goal: Type.String({ minLength: 1, maxLength: 32_000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const DaemonControlResultSchema = Type.Object(
  {
    session_id: DaemonSessionIdSchema,
    run_id: NonEmptyStringSchema,
    events: Type.Array(DaemonControlEventSchema),
    writer_lease: DaemonWriterLeaseSchema,
  },
  { additionalProperties: false },
);

export type DaemonControlResult = Static<typeof DaemonControlResultSchema>;

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

export const DaemonSessionNewResultSchema = Type.Object(
  {
    session_id: DaemonSessionIdSchema,
    writer_lease: DaemonWriterLeaseSchema,
  },
  { additionalProperties: false },
);

export type DaemonSessionNewResult = Static<
  typeof DaemonSessionNewResultSchema
>;

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

export const DaemonSessionNewRequestSchema = Type.Object(
  {
    ...RequestBase,
    method: Type.Literal("session/new"),
    params: Type.Object({}, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

const ControlRequestSchemas = [
  DaemonSessionRunRequestSchema,
  DaemonSessionSteerRequestSchema,
  DaemonSessionStopRequestSchema,
  DaemonSessionApproveRequestSchema,
  DaemonSessionPlanRequestSchema,
  DaemonSessionGoalRequestSchema,
] as const;

export const DaemonRequestSchema = Type.Union([
  DaemonHelloRequestSchema,
  DaemonSessionListRequestSchema,
  DaemonSessionReadRequestSchema,
  DaemonSessionPinRequestSchema,
  DaemonSessionNewRequestSchema,
  ...ControlRequestSchemas,
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

export const DaemonSessionNewResponseSchema = Type.Object(
  {
    ...ResponseBase,
    ok: Type.Literal(true),
    result: DaemonSessionNewResultSchema,
  },
  { additionalProperties: false },
);

export const DaemonControlResponseSchema = Type.Object(
  {
    ...ResponseBase,
    ok: Type.Literal(true),
    result: DaemonControlResultSchema,
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
  DaemonSessionNewResponseSchema,
  DaemonControlResponseSchema,
  DaemonErrorResponseSchema,
]);

export type DaemonResponse = Static<typeof DaemonResponseSchema>;
