import { Type, type Static } from "typebox";
import { NonEmptyStringSchema } from "./common.ts";

export const PLUGIN_PROTOCOL_VERSION = 1 as const;
export const PLUGIN_MAX_FRAME_BYTES = 1024 * 1024;

export const PluginMethodSchema = Type.Union([
  Type.Literal("health"),
  Type.Literal("tools/list"),
  Type.Literal("tools/call"),
  Type.Literal("tools/cancel"),
  Type.Literal("shutdown"),
]);

export type PluginMethod = Static<typeof PluginMethodSchema>;

export const PluginErrorCodeSchema = Type.Union([
  Type.Literal("plugin.invalid_request"),
  Type.Literal("plugin.unknown_method"),
  Type.Literal("plugin.duplicate_call"),
  Type.Literal("plugin.timeout"),
  Type.Literal("plugin.cancelled"),
  Type.Literal("plugin.frame_too_large"),
  Type.Literal("plugin.crashed"),
  Type.Literal("plugin.capability_denied"),
  Type.Literal("plugin.policy_denied"),
  Type.Literal("plugin.approval_denied"),
  Type.Literal("plugin.internal"),
]);

export type PluginErrorCode = Static<typeof PluginErrorCodeSchema>;

export const PluginErrorSchema = Type.Object(
  {
    code: PluginErrorCodeSchema,
    message: NonEmptyStringSchema,
    retryable: Type.Boolean(),
    details: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export type PluginError = Static<typeof PluginErrorSchema>;

export const PluginRequestSchema = Type.Object(
  {
    type: Type.Literal("codepunk/plugin-request"),
    version: Type.Literal(PLUGIN_PROTOCOL_VERSION),
    call_id: NonEmptyStringSchema,
    plugin_id: NonEmptyStringSchema,
    method: PluginMethodSchema,
    params: Type.Unknown(),
    timeout_ms: Type.Integer({ minimum: 1, maximum: 600_000 }),
    cancel_token: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export type PluginRequest = Static<typeof PluginRequestSchema>;

const PluginSuccessResponseSchema = Type.Object(
  {
    type: Type.Literal("codepunk/plugin-response"),
    version: Type.Literal(PLUGIN_PROTOCOL_VERSION),
    call_id: NonEmptyStringSchema,
    plugin_id: NonEmptyStringSchema,
    ok: Type.Literal(true),
    result: Type.Unknown(),
  },
  { additionalProperties: false },
);

const PluginFailureResponseSchema = Type.Object(
  {
    type: Type.Literal("codepunk/plugin-response"),
    version: Type.Literal(PLUGIN_PROTOCOL_VERSION),
    call_id: NonEmptyStringSchema,
    plugin_id: NonEmptyStringSchema,
    ok: Type.Literal(false),
    error: PluginErrorSchema,
  },
  { additionalProperties: false },
);

export const PluginResponseSchema = Type.Union([
  PluginSuccessResponseSchema,
  PluginFailureResponseSchema,
]);

export type PluginResponse = Static<typeof PluginResponseSchema>;

export const PluginFrameSchema = Type.Union([
  PluginRequestSchema,
  PluginResponseSchema,
]);

export type PluginFrame = Static<typeof PluginFrameSchema>;
