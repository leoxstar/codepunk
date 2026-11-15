import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

export {
  AGENT_STATE_SCHEMA_VERSION,
  EVIDENCE_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  SESSION_EVENT_SCHEMA_VERSION,
  VERDICT_SCHEMA_VERSION,
  ProtocolError,
  assertSupportedVersion,
  currentVersionFor,
  type ProtocolKind,
} from "./version.ts";

export {
  AutonomyEvidenceSchema,
  AutonomyProfileSchema,
  AutonomyRuleSchema,
  CoverageSchema,
  DecisionSchema,
  EffectsSchema,
  NonEmptyStringSchema,
  PolicyLayerNameSchema,
  PolicyLayerSchema,
  SandboxDescriptorSchema,
  Sha256Schema,
  SourceSchema,
  TimestampSchema,
  VcsBindingSchema,
  type Coverage,
  type Decision,
  type Effects,
  type AutonomyEvidence,
  type AutonomyProfile,
  type AutonomyRule,
  type PolicyLayer,
  type PolicyLayerName,
  type SandboxDescriptor,
  type Source,
  type VcsBinding,
} from "./common.ts";

export {
  PolicyDecisionSchema,
  PolicyMatchSchema,
  type PolicyDecision,
  type PolicyMatch,
} from "./policy.ts";

export {
  ApprovalAnswerSchema,
  ApprovalEvidenceSchema,
  ApprovalRequestArraySchema,
  ApprovalRequestSchema,
  ApprovalScopeSchema,
  ReviewerEvidenceSchema,
  type ApprovalAnswer,
  type ApprovalEvidence,
  type ApprovalRequest,
  type ApprovalScope,
  type ReviewerEvidence,
} from "./approval.ts";

export {
  EvidenceRecordArraySchema,
  EvidenceRecordSchema,
  MemoryEvidenceSchema,
  PathCheckSchema,
  type EvidenceRecord,
  type MemoryEvidence,
} from "./evidence.ts";

export {
  MemoryDurabilitySchema,
  MemoryKindSchema,
  MemoryRecordArraySchema,
  MemoryRecordSchema,
  MemoryScopeSchema,
  MemorySourceSchema,
  MemoryStatusSchema,
  type MemoryDurability,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type MemorySource,
  type MemoryStatus,
} from "./memory.ts";

export {
  AgentStateSchema,
  ApprovalAnswerEventSchema,
  AutonomyProfileEventSchema,
  AutonomyRevokedEventSchema,
  BashResultEventSchema,
  BudgetExceededEventSchema,
  CheckpointRestoreEventSchema,
  CommitCreatedEventSchema,
  ContextLoadedEventSchema,
  ContextSourceSchema,
  CompactionDecisionEventSchema,
  MemoryRetrieveEventSchema,
  MemoryWriteEventSchema,
  McpServerStartEventSchema,
  ModelChangeEventSchema,
  ModelFallbackEventSchema,
  ModelRetryEndEventSchema,
  ModelRetryStartEventSchema,
  ModelUsageEventSchema,
  PlanStepSchema,
  PlanUpdateEventSchema,
  RunEndEventSchema,
  RunStartEventSchema,
  SessionForkedEventSchema,
  SessionTreeEventSchema,
  SessionEventSchema,
  SessionHeaderSchema,
  SessionMetaSchema,
  SessionRecordSchema,
  SignOffEventSchema,
  SkillLoadedEventSchema,
  SkillInvokedEventSchema,
  SubagentResultEventSchema,
  TodoItemSchema,
  TodoUpdateEventSchema,
  TrustDecisionEventSchema,
  UserInputEventSchema,
  type AgentState,
  type ApprovalAnswerEvent,
  type AutonomyProfileEvent,
  type AutonomyRevokedEvent,
  type BashResultEvent,
  type BudgetExceededEvent,
  type CheckpointRestoreEvent,
  type CommitCreatedEvent,
  type ContextLoadedEvent,
  type ContextSource,
  type CompactionDecisionEvent,
  type MemoryRetrieveEvent,
  type MemoryWriteEvent,
  type McpServerStartEvent,
  type ModelChangeEvent,
  type ModelFallbackEvent,
  type ModelRetryEndEvent,
  type ModelRetryStartEvent,
  type ModelUsageEvent,
  type PlanStep,
  type PlanUpdateEvent,
  type RunEndEvent,
  type RunStartEvent,
  type SessionForkedEvent,
  type SessionTreeEvent,
  type SessionEvent,
  type SessionHeader,
  type SessionMeta,
  type SessionRecord,
  type SignOffEvent,
  type SkillLoadedEvent,
  type SkillInvokedEvent,
  type SubagentResultEvent,
  type TodoItem,
  type TodoUpdateEvent,
  type TrustDecisionEvent,
  type UserInputEvent,
} from "./session.ts";

export {
  SignOffRequestSchema,
  VerdictSchema,
  VerdictValueSchema,
  type SignOffRequest,
  type Verdict,
  type VerdictValue,
} from "./verdict.ts";

export {
  HandoffClaimSchema,
  HandoffEvidenceSchema,
  HandoffFileSchema,
  HandoffVerdictSchema,
  MergeRecordSchema,
  TaskBudgetSchema,
  TaskHandoffSchema,
  TaskSpecSchema,
  type MergeRecord,
  type TaskHandoff,
  type TaskSpec,
} from "./delivery.ts";

export {
  NotificationKindSchema,
  NotificationSchema,
  WorkItemSchema,
  WorkSourceSchema,
  type Notification,
  type WorkItem,
} from "./swarm.ts";

export {
  DAEMON_DEFAULT_PAGE_SIZE,
  DAEMON_MAX_CONNECTIONS,
  DAEMON_MAX_PAGE_SIZE,
  DAEMON_METHODS,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_REQUEST_MAX_BYTES,
  DAEMON_REQUEST_TIMEOUT_MS,
  DAEMON_RESPONSE_MAX_BYTES,
  DaemonErrorCodeSchema,
  DaemonErrorResponseSchema,
  DaemonErrorSchema,
  DaemonHelloRequestSchema,
  DaemonHelloResponseSchema,
  DaemonHelloResultSchema,
  DaemonRequestIdSchema,
  DaemonRequestSchema,
  DaemonResponseSchema,
  DaemonSessionIdSchema,
  DaemonSessionListRequestSchema,
  DaemonSessionListResponseSchema,
  DaemonSessionListResultSchema,
  DaemonSessionReadRequestSchema,
  DaemonSessionReadResponseSchema,
  DaemonSessionReadResultSchema,
  DaemonSessionSummarySchema,
  type DaemonError,
  type DaemonErrorCode,
  type DaemonHelloResult,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonSessionListResult,
  type DaemonSessionReadResult,
  type DaemonSessionSummary,
} from "./daemon.ts";

export type SchemaIssue = {
  path: string;
  message: string;
};

export function validateSchema(
  schema: TSchema,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; issues: SchemaIssue[] } {
  if (Check(schema, value)) {
    return { ok: true, value };
  }
  const issues = Errors(schema, value).map((error) => ({
    path: error.instancePath || "/",
    message: error.message,
  }));
  return { ok: false, issues };
}
