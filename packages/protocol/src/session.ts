import { Type, type Static } from "typebox";
import { ApprovalAnswerSchema, ApprovalEvidenceSchema } from "./approval.ts";
import {
  AutonomyProfileSchema,
  AutonomyRuleSchema,
  BudgetExceededSchema,
  DecisionSchema,
  NonEmptyStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "./common.ts";

export const SessionHeaderSchema = Type.Object(
  {
    type: Type.Literal("codepunk/session"),
    version: Type.Literal(1),
    id: NonEmptyStringSchema,
    project_id: NonEmptyStringSchema,
    cwd: NonEmptyStringSchema,
    created_at: TimestampSchema,
    pi_version: Type.String(),
    model: Type.Union([Type.String(), Type.Null()]),
    parent_session_id: Type.Optional(NonEmptyStringSchema),
    fork_entry_id: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export type SessionHeader = Static<typeof SessionHeaderSchema>;

const EventBase = {
  type: Type.Literal("codepunk/event"),
  version: Type.Literal(1),
  seq: Type.Integer({ minimum: 1 }),
  at: TimestampSchema,
};

export const RunStartEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("run/start"),
    data: Type.Object(
      {
        run_id: NonEmptyStringSchema,
        session_id: NonEmptyStringSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const UserInputEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("user/input"),
    data: Type.Object(
      {
        run_id: NonEmptyStringSchema,
        text: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SessionForkedEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("session/forked"),
    data: Type.Object(
      {
        parent_session_id: NonEmptyStringSchema,
        parent_last_seq: Type.Integer({ minimum: 0 }),
        parent_state_covers_seq: Type.Integer({ minimum: 0 }),
        parent_state_sha256: Sha256Schema,
        fork_entry_id: Type.Union([NonEmptyStringSchema, Type.Null()]),
        mode: Type.Union([Type.Literal("clone"), Type.Literal("live")]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SessionTreeEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("session/tree"),
    data: Type.Object(
      {
        action: Type.Literal("navigate"),
        from_entry_id: Type.Union([NonEmptyStringSchema, Type.Null()]),
        to_entry_id: Type.Union([NonEmptyStringSchema, Type.Null()]),
        target_entry_id: Type.Optional(NonEmptyStringSchema),
        branch_entries: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ApprovalAnswerEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("approval/answer"),
    data: ApprovalAnswerSchema,
  },
  { additionalProperties: false },
);

export const BashResultEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("bash/result"),
    data: Type.Object(
      {
        run_id: NonEmptyStringSchema,
        command: Type.String(),
        exit_code: Type.Union([Type.Integer(), Type.Null()]),
        output_sha256: Type.Union([Sha256Schema, Type.Null()]),
        cancelled: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const CommitCreatedEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("commit/created"),
    data: Type.Object(
      {
        run_id: NonEmptyStringSchema,
        commit: NonEmptyStringSchema,
        previous_commit: Type.Union([NonEmptyStringSchema, Type.Null()]),
        tree: NonEmptyStringSchema,
        message_sha256: Sha256Schema,
        message_bytes: Type.Integer({ minimum: 1 }),
        files: Type.Array(Type.String()),
        stage: Type.Union([
          Type.Literal("staged"),
          Type.Literal("tracked"),
          Type.Literal("all"),
        ]),
        root: NonEmptyStringSchema,
        evidence_head: Type.Union([Sha256Schema, Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const CheckpointRestoreEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("checkpoint/restore"),
    data: Type.Object(
      {
        action: Type.Union([Type.Literal("undo"), Type.Literal("redo")]),
        checkpoint_id: NonEmptyStringSchema,
        tool_call_id: NonEmptyStringSchema,
        target: NonEmptyStringSchema,
        from_sha256: Sha256Schema,
        to_sha256: Sha256Schema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ContextSourceSchema = Type.Object(
  {
    rank: Type.Integer({ minimum: 1 }),
    kind: Type.Union([
      Type.Literal("user-instructions"),
      Type.Literal("project-instructions"),
      Type.Literal("append"),
    ]),
    source: NonEmptyStringSchema,
    sha256: Sha256Schema,
    bytes: Type.Integer({ minimum: 0 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type ContextSource = Static<typeof ContextSourceSchema>;

export const ContextLoadedEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("context/loaded"),
    data: Type.Object(
      {
        sources: Type.Array(ContextSourceSchema),
        warnings: Type.Array(Type.String()),
        total_bytes: Type.Integer({ minimum: 0 }),
        truncated: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const TrustDecisionEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("trust/decision"),
    data: Type.Object(
      {
        cwd: NonEmptyStringSchema,
        root: NonEmptyStringSchema,
        decision: Type.Union([
          Type.Literal("trusted"),
          Type.Literal("untrusted"),
        ]),
        mode: Type.Optional(
          Type.Union([
            Type.Literal("all"),
            Type.Literal("custom"),
            Type.Literal("none"),
          ]),
        ),
        source: Type.Union([
          Type.Literal("flag"),
          Type.Literal("saved"),
          Type.Literal("prompt"),
          Type.Literal("default"),
          Type.Literal("no-resources"),
        ]),
        resources: Type.Array(Type.String()),
        skipped: Type.Array(Type.String()),
        grants: Type.Optional(
          Type.Object(
            {
              config: Type.Boolean(),
              policy: Type.Boolean(),
              skills: Type.Boolean(),
              instructions: Type.Boolean(),
            },
            { additionalProperties: false },
          ),
        ),
        available: Type.Optional(
          Type.Array(
            Type.Union([
              Type.Literal("config"),
              Type.Literal("policy"),
              Type.Literal("skills"),
              Type.Literal("instructions"),
            ]),
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type TrustDecisionEvent = Static<typeof TrustDecisionEventSchema>;

export const CompactionDecisionEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("compaction/decision"),
    data: Type.Object(
      {
        run_id: NonEmptyStringSchema,
        reason: Type.Union([
          Type.Literal("manual"),
          Type.Literal("threshold"),
          Type.Literal("overflow"),
        ]),
        cancelled: Type.Boolean(),
        entries: Type.Integer({ minimum: 0 }),
        keep_recent_tokens: Type.Integer({ minimum: 0 }),
        evidence_head: Type.Union([Sha256Schema, Type.Null()]),
        failure: Type.Optional(Type.String()),
        checkpoint: Type.Optional(
          Type.Object(
            {
              compaction_entry_id: NonEmptyStringSchema,
              first_kept_entry_id: NonEmptyStringSchema,
              summary_sha256: Sha256Schema,
              summary_bytes: Type.Integer({ minimum: 0 }),
              tokens_before: Type.Integer({ minimum: 0 }),
              messages_before: Type.Integer({ minimum: 0 }),
              messages_after: Type.Integer({ minimum: 0 }),
              model: Type.Union([NonEmptyStringSchema, Type.Null()]),
              loadout_sha256: Type.Union([Sha256Schema, Type.Null()]),
              tool_names: Type.Array(NonEmptyStringSchema),
              usage: Type.Optional(
                Type.Object(
                  {
                    input_tokens: Type.Integer({ minimum: 0 }),
                    output_tokens: Type.Integer({ minimum: 0 }),
                    cache_read_tokens: Type.Integer({ minimum: 0 }),
                    cache_write_tokens: Type.Integer({ minimum: 0 }),
                    total_tokens: Type.Integer({ minimum: 0 }),
                    cost_total: Type.Number({ minimum: 0 }),
                  },
                  { additionalProperties: false },
                ),
              ),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const RunEndEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("run/end"),
    data: Type.Object(
      {
        run_id: NonEmptyStringSchema,
        state: Type.Union([
          Type.Literal("settled"),
          Type.Literal("failed"),
          Type.Literal("aborted"),
          Type.Literal("cancelled"),
        ]),
        termination: Type.Union([Type.String(), Type.Null()]),
        evidence_head: Type.Union([Sha256Schema, Type.Null()]),
        actor: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SignOffEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("verdict/sign_off"),
    data: Type.Object(
      {
        sign_off_id: NonEmptyStringSchema,
        previous_sign_off_id: Type.Union([Type.String(), Type.Null()]),
        run_id: NonEmptyStringSchema,
        evidence_head: Sha256Schema,
        signed_verdict: Type.Union([
          Type.Literal("complete"),
          Type.Literal("incomplete"),
        ]),
        channel: Type.Union([Type.Literal("tui"), Type.Literal("cli")]),
        actor: Type.String(),
        signed_at: TimestampSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const MemoryWriteEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("memory/write"),
    data: Type.Object(
      {
        scope: Type.Union([Type.Literal("user"), Type.Literal("project")]),
        action: Type.Union([
          Type.Literal("add"),
          Type.Literal("edit"),
          Type.Literal("delete"),
          Type.Literal("archive"),
          Type.Literal("reject"),
        ]),
        memory_id: Type.Union([Type.String(), Type.Null()]),
        content_sha256: Type.Union([Sha256Schema, Type.Null()]),
        source_refs: Type.Array(Type.String()),
        reason: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const MemoryRetrieveEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("memory/retrieve"),
    data: Type.Object(
      {
        ids: Type.Array(Type.String()),
        hashes: Type.Array(Sha256Schema),
        cap: Type.Integer({ minimum: 0 }),
        truncated: Type.Boolean(),
        digest_sha256: Sha256Schema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ModelChangeEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("model/change"),
    data: Type.Object(
      {
        previous: Type.Union([Type.String(), Type.Null()]),
        model: NonEmptyStringSchema,
        thinking: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ModelUsageEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("model/usage"),
    data: Type.Object(
      {
        run_id: NonEmptyStringSchema,
        provider: NonEmptyStringSchema,
        model: NonEmptyStringSchema,
        input_tokens: Type.Integer({ minimum: 0 }),
        output_tokens: Type.Integer({ minimum: 0 }),
        cache_read_tokens: Type.Integer({ minimum: 0 }),
        cache_write_tokens: Type.Integer({ minimum: 0 }),
        total_tokens: Type.Integer({ minimum: 0 }),
        cost_total: Type.Number({ minimum: 0 }),
        stop_reason: Type.String(),
        source: Type.Optional(
          Type.Union([Type.Literal("assistant"), Type.Literal("summary")]),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ModelFallbackEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("model/fallback"),
    data: Type.Object(
      {
        from: NonEmptyStringSchema,
        to: Type.Union([NonEmptyStringSchema, Type.Null()]),
        reason: Type.Literal("error"),
        stop_reason: Type.Union([Type.String(), Type.Null()]),
        attempted: Type.Array(NonEmptyStringSchema),
        exhausted: Type.Boolean(),
        chain_sha256: Sha256Schema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ModelRetryStartEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("model/retry_start"),
    data: Type.Object(
      {
        run_id: NonEmptyStringSchema,
        model: Type.Union([NonEmptyStringSchema, Type.Null()]),
        attempt: Type.Integer({ minimum: 1 }),
        max_attempts: Type.Integer({ minimum: 1 }),
        delay_ms: Type.Integer({ minimum: 0 }),
        error_sha256: Sha256Schema,
        error_preview: Type.String({ maxLength: 512 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ModelRetryEndEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("model/retry_end"),
    data: Type.Object(
      {
        run_id: NonEmptyStringSchema,
        model: Type.Union([NonEmptyStringSchema, Type.Null()]),
        attempt: Type.Integer({ minimum: 1 }),
        success: Type.Boolean(),
        final_error_sha256: Type.Union([Sha256Schema, Type.Null()]),
        final_error_preview: Type.Union([
          Type.String({ maxLength: 512 }),
          Type.Null(),
        ]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const BudgetExceededEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("budget/exceeded"),
    data: BudgetExceededSchema,
  },
  { additionalProperties: false },
);

export const LoopGuardEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("loop_guard"),
    data: Type.Object(
      {
        run_id: NonEmptyStringSchema,
        tool: NonEmptyStringSchema,
        canonical_argv: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
        cwd: NonEmptyStringSchema,
        repeat_count: Type.Integer({ minimum: 1 }),
        threshold: Type.Integer({ minimum: 1 }),
        decision: DecisionSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const NetworkLimitSchema = Type.Object(
  {
    max_requests: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    max_bytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export type NetworkLimit = Static<typeof NetworkLimitSchema>;

export const NetworkRequestEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("network/request"),
    data: Type.Object(
      {
        run_id: NonEmptyStringSchema,
        domain: NonEmptyStringSchema,
        requests: Type.Integer({ minimum: 0 }),
        bytes: Type.Integer({ minimum: 0 }),
        limit: NetworkLimitSchema,
        decision: DecisionSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const NetworkRedirectEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("network/redirect"),
    data: Type.Object(
      {
        run_id: NonEmptyStringSchema,
        from: NonEmptyStringSchema,
        to: NonEmptyStringSchema,
        status: Type.Integer({ minimum: 300, maximum: 399 }),
        decision: DecisionSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const NetworkRejectedEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("network/rejected"),
    data: Type.Object(
      {
        run_id: NonEmptyStringSchema,
        domain: NonEmptyStringSchema,
        reason: NonEmptyStringSchema,
        limit: NetworkLimitSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const McpServerStartEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("mcp/server_start"),
    data: Type.Object(
      {
        server: NonEmptyStringSchema,
        command_sha256: Sha256Schema,
        pid: Type.Integer({ minimum: 0 }),
        transport: Type.Union([Type.Literal("stdio"), Type.Literal("http")]),
        coverage: Type.Literal("uncovered"),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SkillLoadedEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("skill/loaded"),
    data: Type.Object(
      {
        skills: Type.Array(
          Type.Object(
            {
              name: NonEmptyStringSchema,
              scope: Type.Union([
                Type.Literal("user"),
                Type.Literal("project"),
              ]),
              sha256: Sha256Schema,
              bytes: Type.Integer({ minimum: 0 }),
            },
            { additionalProperties: false },
          ),
        ),
        block_sha256: Sha256Schema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SkillInvokedEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("skill/invoked"),
    data: Type.Object(
      {
        name: NonEmptyStringSchema,
        scope: Type.Union([Type.Literal("user"), Type.Literal("project")]),
        sha256: Sha256Schema,
        bytes: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const WorkStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
]);

export const PlanStepSchema = Type.Object(
  {
    step: NonEmptyStringSchema,
    status: WorkStatusSchema,
  },
  { additionalProperties: false },
);

export type PlanStep = Static<typeof PlanStepSchema>;

export const PlanUpdateEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("plan/update"),
    data: Type.Object(
      {
        run_id: NonEmptyStringSchema,
        steps: Type.Array(PlanStepSchema, { maxItems: 50 }),
        explanation: Type.Union([Type.String(), Type.Null()]),
        updated_at: TimestampSchema,
        sha256: Sha256Schema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type PlanUpdateEvent = Static<typeof PlanUpdateEventSchema>;

export const TodoItemSchema = Type.Object(
  {
    content: NonEmptyStringSchema,
    status: WorkStatusSchema,
  },
  { additionalProperties: false },
);

export type TodoItem = Static<typeof TodoItemSchema>;

export const TodoUpdateEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("todo/update"),
    data: Type.Object(
      {
        run_id: NonEmptyStringSchema,
        items: Type.Array(TodoItemSchema, { maxItems: 50 }),
        updated_at: TimestampSchema,
        sha256: Sha256Schema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type TodoUpdateEvent = Static<typeof TodoUpdateEventSchema>;

export const AutonomyProfileEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("autonomy/profile"),
    data: Type.Object(
      {
        profile: AutonomyProfileSchema,
        source: Type.Union([
          Type.Literal("cli"),
          Type.Literal("user-config"),
          Type.Literal("default"),
        ]),
        rules_sha256: Type.Union([Sha256Schema, Type.Null()]),
        rules: Type.Array(AutonomyRuleSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const AutonomyRevokedEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("autonomy/revoked"),
    data: Type.Object(
      {
        profile: AutonomyProfileSchema,
        reason: Type.Literal("session_end"),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SubagentResultEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("subagent/result"),
    data: Type.Object(
      {
        run_id: NonEmptyStringSchema,
        parent_session_id: NonEmptyStringSchema,
        child_session_id: NonEmptyStringSchema,
        depth: Type.Integer({ minimum: 1 }),
        isolation: Type.Union([
          Type.Literal("worktree"),
          Type.Literal("shared"),
        ]),
        model: Type.Union([NonEmptyStringSchema, Type.Null()]),
        status: Type.Union([
          Type.Literal("completed"),
          Type.Literal("failed"),
          Type.Literal("stopped"),
        ]),
        summary: Type.String(),
        evidence_head: Type.Union([Sha256Schema, Type.Null()]),
        child_run_id: Type.Union([NonEmptyStringSchema, Type.Null()]),
        exit_code: Type.Union([Type.Integer(), Type.Null()]),
        error: Type.Union([Type.String(), Type.Null()]),
        profile: Type.Optional(Type.Union([NonEmptyStringSchema, Type.Null()])),
        profile_sha256: Type.Optional(Type.Union([Sha256Schema, Type.Null()])),
        worktree: Type.Optional(
          Type.Union([NonEmptyStringSchema, Type.Null()]),
        ),
        base_commit: Type.Optional(
          Type.Union([NonEmptyStringSchema, Type.Null()]),
        ),
        transcript_path: Type.Optional(
          Type.Union([NonEmptyStringSchema, Type.Null()]),
        ),
        changed_files: Type.Optional(
          Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PluginStartedEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("plugin/started"),
    data: Type.Object(
      {
        plugin_id: NonEmptyStringSchema,
        version: NonEmptyStringSchema,
        manifest_sha256: Sha256Schema,
        pid: Type.Integer({ minimum: 1 }),
        credential_verified: Type.Boolean(),
        started_at: TimestampSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PluginToolCallEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("plugin/tool_call"),
    data: Type.Object(
      {
        run_id: NonEmptyStringSchema,
        tool_call_id: NonEmptyStringSchema,
        plugin_id: NonEmptyStringSchema,
        plugin_manifest_sha256: Sha256Schema,
        executor: Type.Literal("child-host"),
        decision: DecisionSchema,
        approval: Type.Union([ApprovalEvidenceSchema, Type.Null()]),
        outcome: Type.Union([
          Type.Literal("completed"),
          Type.Literal("failed"),
          Type.Literal("denied"),
          Type.Literal("cancelled"),
        ]),
        reason: Type.Union([NonEmptyStringSchema, Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PluginStoppedEventSchema = Type.Object(
  {
    ...EventBase,
    kind: Type.Literal("plugin/stopped"),
    data: Type.Object(
      {
        plugin_id: NonEmptyStringSchema,
        pid: Type.Integer({ minimum: 1 }),
        credential_verified: Type.Boolean(),
        reason: Type.Union([
          Type.Literal("exit"),
          Type.Literal("crash"),
          Type.Literal("timeout"),
          Type.Literal("cancel"),
          Type.Literal("shutdown"),
          Type.Literal("error"),
        ]),
        exit_code: Type.Union([Type.Integer(), Type.Null()]),
        stopped_at: TimestampSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SessionEventSchema = Type.Union([
  RunStartEventSchema,
  UserInputEventSchema,
  SessionForkedEventSchema,
  SessionTreeEventSchema,
  ApprovalAnswerEventSchema,
  BashResultEventSchema,
  CommitCreatedEventSchema,
  CheckpointRestoreEventSchema,
  ContextLoadedEventSchema,
  TrustDecisionEventSchema,
  CompactionDecisionEventSchema,
  RunEndEventSchema,
  SignOffEventSchema,
  MemoryWriteEventSchema,
  MemoryRetrieveEventSchema,
  ModelChangeEventSchema,
  ModelUsageEventSchema,
  ModelFallbackEventSchema,
  ModelRetryStartEventSchema,
  ModelRetryEndEventSchema,
  BudgetExceededEventSchema,
  LoopGuardEventSchema,
  NetworkRequestEventSchema,
  NetworkRedirectEventSchema,
  NetworkRejectedEventSchema,
  McpServerStartEventSchema,
  SkillLoadedEventSchema,
  SkillInvokedEventSchema,
  PlanUpdateEventSchema,
  TodoUpdateEventSchema,
  AutonomyProfileEventSchema,
  AutonomyRevokedEventSchema,
  SubagentResultEventSchema,
  PluginStartedEventSchema,
  PluginToolCallEventSchema,
  PluginStoppedEventSchema,
]);

export type SessionEvent = Static<typeof SessionEventSchema>;
export type RunStartEvent = Static<typeof RunStartEventSchema>;
export type UserInputEvent = Static<typeof UserInputEventSchema>;
export type SessionForkedEvent = Static<typeof SessionForkedEventSchema>;
export type SessionTreeEvent = Static<typeof SessionTreeEventSchema>;
export type ApprovalAnswerEvent = Static<typeof ApprovalAnswerEventSchema>;
export type BashResultEvent = Static<typeof BashResultEventSchema>;
export type CommitCreatedEvent = Static<typeof CommitCreatedEventSchema>;
export type CheckpointRestoreEvent = Static<
  typeof CheckpointRestoreEventSchema
>;
export type ContextLoadedEvent = Static<typeof ContextLoadedEventSchema>;
export type CompactionDecisionEvent = Static<
  typeof CompactionDecisionEventSchema
>;
export type RunEndEvent = Static<typeof RunEndEventSchema>;
export type SignOffEvent = Static<typeof SignOffEventSchema>;
export type MemoryWriteEvent = Static<typeof MemoryWriteEventSchema>;
export type MemoryRetrieveEvent = Static<typeof MemoryRetrieveEventSchema>;
export type ModelChangeEvent = Static<typeof ModelChangeEventSchema>;
export type ModelUsageEvent = Static<typeof ModelUsageEventSchema>;
export type ModelFallbackEvent = Static<typeof ModelFallbackEventSchema>;
export type ModelRetryStartEvent = Static<typeof ModelRetryStartEventSchema>;
export type ModelRetryEndEvent = Static<typeof ModelRetryEndEventSchema>;
export type BudgetExceededEvent = Static<typeof BudgetExceededEventSchema>;
export type LoopGuardEvent = Static<typeof LoopGuardEventSchema>;
export type NetworkRequestEvent = Static<typeof NetworkRequestEventSchema>;
export type NetworkRedirectEvent = Static<typeof NetworkRedirectEventSchema>;
export type NetworkRejectedEvent = Static<typeof NetworkRejectedEventSchema>;
export type McpServerStartEvent = Static<typeof McpServerStartEventSchema>;
export type SkillLoadedEvent = Static<typeof SkillLoadedEventSchema>;
export type SkillInvokedEvent = Static<typeof SkillInvokedEventSchema>;
export type AutonomyProfileEvent = Static<typeof AutonomyProfileEventSchema>;
export type AutonomyRevokedEvent = Static<typeof AutonomyRevokedEventSchema>;
export type SubagentResultEvent = Static<typeof SubagentResultEventSchema>;
export type PluginStartedEvent = Static<typeof PluginStartedEventSchema>;
export type PluginToolCallEvent = Static<typeof PluginToolCallEventSchema>;
export type PluginStoppedEvent = Static<typeof PluginStoppedEventSchema>;

export const SessionRecordSchema = Type.Union([
  SessionHeaderSchema,
  SessionEventSchema,
]);

export type SessionRecord = Static<typeof SessionRecordSchema>;

export const SessionMetaSchema = Type.Object(
  {
    version: Type.Literal(1),
    updated_at: TimestampSchema,
    title: Type.Union([Type.String(), Type.Null()]),
    pinned: Type.Boolean(),
    decision_ref: Type.Union([Type.String(), Type.Null()]),
    log_seq: Type.Integer({ minimum: 0 }),
    state_covers_seq: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type SessionMeta = Static<typeof SessionMetaSchema>;

export const AgentStateSchema = Type.Object(
  {
    version: Type.Literal(1),
    session_version: Type.Integer({ minimum: 0 }),
    pi_version: Type.String(),
    session_id: NonEmptyStringSchema,
    saved_at: TimestampSchema,
    header: Type.Unknown(),
    branch: Type.Array(Type.Unknown()),
    entries: Type.Optional(Type.Array(Type.Unknown())),
    leaf_id: Type.Optional(Type.Union([NonEmptyStringSchema, Type.Null()])),
  },
  { additionalProperties: false },
);

export type AgentState = Static<typeof AgentStateSchema>;
