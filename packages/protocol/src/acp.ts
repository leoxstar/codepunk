import { Type, type Static } from "typebox";
import { SCHEMA_VERSIONS } from "./constants.ts";
import {
  DAEMON_METHODS,
  DAEMON_SCOPES,
  DAEMON_WRITE_LEASE_TTL_MS,
  DaemonControlEventSchema,
  DaemonSessionIdSchema,
  DaemonWriterLeaseSchema,
} from "./daemon.ts";

export const ACP_PROTOCOL_VERSION = SCHEMA_VERSIONS.acp;
export const ACP_REQUEST_MAX_BYTES = 64 * 1024;
export const ACP_RESPONSE_MAX_BYTES = 1024 * 1024;
export const ACP_METHODS = [
  "initialize",
  "session/new",
  "session/load",
  "session/prompt",
  "session/cancel",
] as const;

const IdSchema = Type.Union([
  Type.String({ minLength: 1, maxLength: 128 }),
  Type.Integer(),
]);
const IdOrNullSchema = Type.Union([IdSchema, Type.Null()]);
const AcpMethodSchema = Type.Union(
  ACP_METHODS.map((method) => Type.Literal(method)),
);

export const AcpErrorCodeSchema = Type.Union([
  Type.Literal(-32700),
  Type.Literal(-32600),
  Type.Literal(-32601),
  Type.Literal(-32602),
  Type.Literal(-32603),
  Type.Literal(49001),
  Type.Literal(49002),
  Type.Literal(49003),
  Type.Literal(49004),
  Type.Literal(49005),
  Type.Literal(49006),
  Type.Literal(49007),
]);

export type AcpErrorCode = Static<typeof AcpErrorCodeSchema>;

export const ACP_ERROR_MESSAGES = {
  "-32700": "ACP request is not valid JSON",
  "-32600": "ACP request is not a valid JSON-RPC 2.0 request",
  "-32601": "ACP method is not supported",
  "-32602": "ACP params are invalid",
  "-32603": "ACP request exceeded the size limit",
  49001: "ACP scope is denied",
  49002: "ACP writer lease conflict",
  49003: "ACP approval nonce does not match",
  49004: "ACP response exceeded the size limit",
  49005: "ACP session was not found",
  49006: "ACP backend failed",
  49007: "ACP run was cancelled",
} as const;

const ReasonSchema = Type.String({ minLength: 1, maxLength: 2_000 });

export const AcpPromptTextBlockSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String({ minLength: 1, maxLength: 32_000 }),
  },
  { additionalProperties: true },
);

export const AcpPromptResourceLinkBlockSchema = Type.Object(
  {
    type: Type.Literal("resource_link"),
    uri: Type.String({ minLength: 1, maxLength: 2_048 }),
    name: Type.Optional(Type.String({ maxLength: 512 })),
    description: Type.Optional(Type.String({ maxLength: 2_000 })),
  },
  { additionalProperties: true },
);

export const AcpPromptEmbeddedResourceBlockSchema = Type.Object(
  {
    type: Type.Literal("resource"),
    resource: Type.Object(
      {
        uri: Type.String({ minLength: 1, maxLength: 2_048 }),
        text: Type.Optional(Type.String({ maxLength: 32_000 })),
        mimeType: Type.Optional(Type.String({ maxLength: 256 })),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

export const AcpPromptBlockSchema = Type.Union([
  AcpPromptTextBlockSchema,
  AcpPromptResourceLinkBlockSchema,
  AcpPromptEmbeddedResourceBlockSchema,
]);

export type AcpPromptBlock = Static<typeof AcpPromptBlockSchema>;

export const AcpInitializeParamsSchema = Type.Union([
  Type.Object(
    {
      protocolVersion: Type.Literal(ACP_PROTOCOL_VERSION),
      scopes: Type.Array(
        Type.Union(DAEMON_SCOPES.map((scope) => Type.Literal(scope))),
        { uniqueItems: true },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      protocolVersion: Type.Optional(Type.Literal(ACP_PROTOCOL_VERSION)),
      clientCapabilities: Type.Optional(
        Type.Record(Type.String(), Type.Unknown()),
      ),
      clientInfo: Type.Optional(
        Type.Object(
          {
            name: Type.String({ minLength: 1, maxLength: 128 }),
            title: Type.Optional(Type.String({ maxLength: 256 })),
            version: Type.Optional(Type.String({ maxLength: 128 })),
          },
          { additionalProperties: true },
        ),
      ),
    },
    { additionalProperties: false },
  ),
]);

export const AcpSessionNewParamsSchema = Type.Union([
  Type.Object(
    {
      scopes: Type.Array(
        Type.Union(DAEMON_SCOPES.map((scope) => Type.Literal(scope))),
        { uniqueItems: true },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
      mcpServers: Type.Optional(Type.Array(Type.Unknown())),
    },
    { additionalProperties: false },
  ),
]);

export const AcpSessionLoadParamsSchema = Type.Object(
  {
    sessionId: DaemonSessionIdSchema,
    cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    mcpServers: Type.Optional(Type.Array(Type.Unknown())),
  },
  { additionalProperties: false },
);

export const AcpSessionPromptParamsSchema = Type.Object(
  {
    sessionId: DaemonSessionIdSchema,
    prompt: Type.Union([
      Type.String({ minLength: 1, maxLength: 32_000 }),
      Type.Array(AcpPromptBlockSchema, { minItems: 1, maxItems: 64 }),
    ]),
    reason: Type.Optional(ReasonSchema),
  },
  { additionalProperties: false },
);

export const AcpSessionCancelParamsSchema = Type.Object(
  {
    sessionId: DaemonSessionIdSchema,
    reason: Type.Optional(ReasonSchema),
  },
  { additionalProperties: false },
);

const AcpRequestBase = {
  jsonrpc: Type.Literal("2.0"),
  id: IdSchema,
};

export const AcpInitializeRequestSchema = Type.Object(
  {
    ...AcpRequestBase,
    method: Type.Literal("initialize"),
    params: Type.Optional(AcpInitializeParamsSchema),
  },
  { additionalProperties: false },
);

export const AcpSessionNewRequestSchema = Type.Object(
  {
    ...AcpRequestBase,
    method: Type.Literal("session/new"),
    params: Type.Optional(AcpSessionNewParamsSchema),
  },
  { additionalProperties: false },
);

export const AcpSessionLoadRequestSchema = Type.Object(
  {
    ...AcpRequestBase,
    method: Type.Literal("session/load"),
    params: AcpSessionLoadParamsSchema,
  },
  { additionalProperties: false },
);

export const AcpSessionPromptRequestSchema = Type.Object(
  {
    ...AcpRequestBase,
    method: Type.Literal("session/prompt"),
    params: AcpSessionPromptParamsSchema,
  },
  { additionalProperties: false },
);

export const AcpSessionCancelRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: Type.Optional(IdSchema),
    method: Type.Literal("session/cancel"),
    params: AcpSessionCancelParamsSchema,
  },
  { additionalProperties: false },
);

export const AcpRequestSchema = Type.Union([
  AcpInitializeRequestSchema,
  AcpSessionNewRequestSchema,
  AcpSessionLoadRequestSchema,
  AcpSessionPromptRequestSchema,
  AcpSessionCancelRequestSchema,
]);

export type AcpRequest = Static<typeof AcpRequestSchema>;

export const AcpInitializeResultSchema = Type.Object(
  {
    protocolVersion: Type.Literal(ACP_PROTOCOL_VERSION),
    methods: Type.Array(AcpMethodSchema),
    scopes: Type.Array(
      Type.Union(DAEMON_SCOPES.map((scope) => Type.Literal(scope))),
    ),
    methodScopes: Type.Record(
      Type.Union(DAEMON_METHODS.map((method) => Type.Literal(method))),
      Type.Union(DAEMON_SCOPES.map((scope) => Type.Literal(scope))),
    ),
    writerLeaseTtlMs: Type.Literal(DAEMON_WRITE_LEASE_TTL_MS),
    compatibility: Type.Literal(
      "ACP v1 wraps additive daemon v1 control; JSON-RPC errors are ACP-only",
    ),
  },
  { additionalProperties: false },
);

export const AcpStandardInitializeResultSchema = Type.Object(
  {
    protocolVersion: Type.Literal(ACP_PROTOCOL_VERSION),
    agentCapabilities: Type.Object(
      {
        loadSession: Type.Boolean(),
        promptCapabilities: Type.Object(
          {
            embeddedContext: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    agentInfo: Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 64 }),
        title: Type.String({ minLength: 1, maxLength: 128 }),
        version: Type.String({ minLength: 1, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const AcpSessionNewResultSchema = Type.Object(
  {
    sessionId: DaemonSessionIdSchema,
    scopes: Type.Array(
      Type.Union(DAEMON_SCOPES.map((scope) => Type.Literal(scope))),
      { uniqueItems: true },
    ),
    writerLease: DaemonWriterLeaseSchema,
  },
  { additionalProperties: false },
);

export const AcpStandardSessionResultSchema = Type.Object(
  {
    sessionId: DaemonSessionIdSchema,
  },
  { additionalProperties: false },
);

export const AcpControlResultSchema = Type.Object(
  {
    sessionId: DaemonSessionIdSchema,
    runId: Type.String({ minLength: 1, maxLength: 128 }),
    events: Type.Array(DaemonControlEventSchema),
    writerLease: DaemonWriterLeaseSchema,
  },
  { additionalProperties: false },
);

export const AcpStandardPromptResultSchema = Type.Object(
  {
    stopReason: Type.Union([
      Type.Literal("end_turn"),
      Type.Literal("cancelled"),
    ]),
    sessionId: DaemonSessionIdSchema,
    runId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);

export const AcpResultSchema = Type.Union([
  AcpInitializeResultSchema,
  AcpStandardInitializeResultSchema,
  AcpSessionNewResultSchema,
  AcpStandardSessionResultSchema,
  AcpControlResultSchema,
  AcpStandardPromptResultSchema,
]);

export type AcpInitializeResult = Static<typeof AcpInitializeResultSchema>;
export type AcpStandardInitializeResult = Static<
  typeof AcpStandardInitializeResultSchema
>;
export type AcpSessionNewResult = Static<typeof AcpSessionNewResultSchema>;
export type AcpStandardSessionResult = Static<
  typeof AcpStandardSessionResultSchema
>;
export type AcpControlResult = Static<typeof AcpControlResultSchema>;
export type AcpStandardPromptResult = Static<
  typeof AcpStandardPromptResultSchema
>;

export const AcpSuccessResponseSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: IdSchema,
    result: AcpResultSchema,
  },
  { additionalProperties: false },
);

export const AcpErrorResponseSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: IdOrNullSchema,
    error: Type.Object(
      {
        code: AcpErrorCodeSchema,
        message: Type.String({ minLength: 1, maxLength: 512 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const AcpResponseSchema = Type.Union([
  AcpSuccessResponseSchema,
  AcpErrorResponseSchema,
]);

export type AcpResponse = Static<typeof AcpResponseSchema>;

export const AcpEventNotificationSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    method: Type.Literal("session/event"),
    params: Type.Object(
      {
        sessionId: DaemonSessionIdSchema,
        event: DaemonControlEventSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const AcpSessionUpdateNotificationSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    method: Type.Literal("session/update"),
    params: Type.Object(
      {
        sessionId: DaemonSessionIdSchema,
        update: Type.Union([
          Type.Object(
            {
              sessionUpdate: Type.Literal("agent_message_chunk"),
              content: Type.Object(
                {
                  type: Type.Literal("text"),
                  text: Type.String({ maxLength: 64_000 }),
                },
                { additionalProperties: false },
              ),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              sessionUpdate: Type.Literal("status"),
              kind: Type.String({ minLength: 1, maxLength: 64 }),
              reason: Type.Optional(Type.String({ maxLength: 2_000 })),
            },
            { additionalProperties: false },
          ),
        ]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const AcpNotificationSchema = Type.Union([
  AcpEventNotificationSchema,
  AcpSessionUpdateNotificationSchema,
]);

export type AcpNotification = Static<typeof AcpNotificationSchema>;
