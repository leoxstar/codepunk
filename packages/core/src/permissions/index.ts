import type { Decision, PolicyDecision } from "@codepunk/protocol";
import type { AutonomyController, ScopedRule } from "../autonomy/index.ts";
import {
  effectiveApprovalDecision,
  type ApprovalMode,
  type ApprovalClass,
  type FilesystemMode,
  type SandboxMode,
} from "../config/index.ts";
import { recordHash } from "../platform/hash.ts";

export interface PermissionExecution {
  status: "available" | "blocked";
  reason: string | null;
}

export interface PermissionGate {
  decision: Decision;
  rule: string;
  rule_sha256: string;
  reason: string;
  requires_approval: boolean;
  approval_adjusted: boolean;
  approval_mode: ApprovalMode;
  approval_class: ApprovalClass;
  scoped_rule: ScopedRule | null;
  consult_approval: boolean;
}

/**
 * Reviewer scope is deliberately narrower than "every approval question".
 * A model reviewer may classify network commands and headless argv exec,
 * because those are the two classes the static table leaves unresolved by
 * design. It must not overrule a human-only boundary: destructive actions,
 * sensitive paths, protected control-plane writes, MCP side effects, explicit
 * policy asks, and scoped allowlist misses stay with the human gate.
 */
const REVIEWER_RESOLVABLE_CLASSES: ReadonlySet<ApprovalClass> = new Set([
  "network",
  "exec",
]);

export function canReviewerResolveApproval(
  approvalClass: ApprovalClass,
): boolean {
  return REVIEWER_RESOLVABLE_CLASSES.has(approvalClass);
}

/**
 * Read-only is a startup boundary, not only a policy flag: user plugins run
 * in-process, MCP servers have already executed their own startup path, and
 * an srt profile binds its `allowWrite` list when it is created. Switching an
 * existing session to read-only cannot unload the first two or remove the
 * sandbox's write grant, so the safe product behavior is to require a clean
 * read-only restart.
 */
export function readOnlyLiveSwitchIssue(input: {
  pluginsEnabled: boolean;
  mcpServers: readonly string[];
  sandboxStartedWritable?: boolean;
}): string | null {
  const active: string[] = [];
  if (input.sandboxStartedWritable === true) {
    active.push("srt workspace write grants");
  }
  if (input.pluginsEnabled) {
    active.push("user plugins");
  }
  if (input.mcpServers.length > 0) {
    active.push(`MCP servers (${input.mcpServers.join(", ")})`);
  }
  if (active.length === 0) {
    return null;
  }
  const restart = [
    "--permission-mode read-only",
    ...(input.mcpServers.length > 0 ? ["--no-mcp"] : []),
  ];
  return `cannot switch to read-only while ${active.join(
    " and ",
  )} are already active; read-only binds its policy and OS write grants at startup. Restart with ${restart.join(" ")}.${
    input.pluginsEnabled ? " Disable user plugins before restart." : ""
  }`;
}

/**
 * The inverse of the read-only switch: an srt profile started read-only has
 * an empty `allowWrite` list for the life of the process. Widening autonomy
 * changes policy but cannot add the write grant back, so the UI must not
 * imply that a live switch to `ask` or `scoped` made the workspace writable.
 */
export function readOnlyLiveWidenIssue(input: {
  target: "ask" | "scoped";
  sandboxStartedReadOnly: boolean;
}): string | null {
  if (!input.sandboxStartedReadOnly) {
    return null;
  }
  return `cannot switch from read-only to ${input.target} while the srt sandbox was started read-only; its allowWrite list stays empty for the life of the process. Restart with --autonomy ${input.target} and a writable permission profile before widening.`;
}

export interface PermissionExplanation {
  version: 1;
  decision: Decision;
  effective_decision: Decision;
  policy_decision: Decision;
  approval_decision: Decision;
  rule: string;
  policy_rule: string;
  approval_rule: string;
  rule_sha256: string;
  policy_rule_sha256: string;
  approval_rule_sha256: string;
  reason: string;
  policy_reason: string;
  approval_reason: string;
  requires_approval: boolean;
  approval_mode: ApprovalMode;
  approval_adjusted: boolean;
  approval_class: ApprovalClass;
  network_allow: readonly string[];
  network_deny: readonly string[];
  scoped_rule: ScopedRule | null;
  execution: PermissionExecution;
  layers: PolicyDecision["layers"];
  match: PolicyDecision["match"];
}

export function shellUnavailableReason(mode: SandboxMode): string {
  return mode === "required"
    ? "srt sandbox is unavailable; shell tools are disabled; run codepunk doctor"
    : "shell tools are disabled; restart with --allow-unsandboxed-shell to run uncovered";
}

export function filesystemFullStartupIssue(
  mode: FilesystemMode,
  allowFullFilesystem: boolean,
): string | null {
  if (mode !== "full" || allowFullFilesystem) {
    return null;
  }
  return "filesystem full requires --dangerously-bypass-approvals-and-sandbox; run codepunk permissions filesystem workspace to restore the workspace boundary";
}

export async function resolvePermissionGate(input: {
  policy: PolicyDecision;
  autonomy: Pick<AutonomyController, "authorize" | "profile"> | null;
  approvalMode: ApprovalMode;
  tool: string;
  command?: string | null;
  argv?: readonly string[] | null;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<PermissionGate> {
  let decision = input.policy.decision;
  let rule = input.policy.rule;
  let ruleSha256 = input.policy.rule_sha256;
  let requiresApproval = input.policy.requires_approval;
  let scopedRule: ScopedRule | null = null;
  let consultApproval = false;

  if (input.policy.decision === "ask" && input.autonomy !== null) {
    scopedRule = await input.autonomy.authorize({
      tool: input.tool,
      ...(input.command === undefined || input.command === null
        ? {}
        : { command: input.command }),
      ...(input.argv === undefined || input.argv === null
        ? {}
        : { argv: input.argv }),
      cwd: input.cwd,
      ...(input.environment === undefined
        ? {}
        : { environment: input.environment }),
    });
    if (scopedRule !== null) {
      decision = "allow";
      rule = `scoped.${scopedRule.id}`;
      ruleSha256 = scopedRule.rule_sha256;
      requiresApproval = false;
    }
  }

  if (input.policy.decision === "ask" && scopedRule === null) {
    if (input.autonomy?.profile === "scoped") {
      // Scoped autonomy is an allowlist, not an overlay: an unmatched action
      // may never fall through to blanket approval.
      decision = input.approvalMode === "deny" ? "deny" : "ask";
      requiresApproval = decision === "ask";
      consultApproval = decision === "ask";
      rule = decision === "deny" ? "approval.denied" : "scoped.unmatched";
      ruleSha256 = recordHash({ rule });
    } else {
      const approval = effectiveApprovalDecision(
        "ask",
        input.approvalMode,
        input.policy.approval_class,
      );
      decision = approval.decision;
      requiresApproval = approval.requiresApproval;
      consultApproval =
        approval.decision === "ask" && approval.requiresApproval;
      if (input.approvalMode === "deny") {
        rule = "approval.denied";
        ruleSha256 = recordHash({ rule });
      }
    }
  }

  return {
    decision,
    rule,
    rule_sha256: ruleSha256,
    reason: input.policy.reason,
    requires_approval: requiresApproval,
    approval_adjusted:
      input.policy.decision === "ask" &&
      (scopedRule !== null || input.approvalMode !== "ask"),
    approval_mode: input.approvalMode,
    approval_class: input.policy.approval_class ?? "unknown",
    scoped_rule: scopedRule,
    consult_approval: consultApproval,
  };
}

export async function explainPermission(input: {
  policy: PolicyDecision;
  autonomy: Pick<AutonomyController, "authorize" | "profile"> | null;
  approvalMode: ApprovalMode;
  tool: string;
  command?: string | null;
  argv?: readonly string[] | null;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  networkAllow?: readonly string[];
  networkDeny?: readonly string[];
  execution: PermissionExecution;
}): Promise<PermissionExplanation> {
  const gate = await resolvePermissionGate(input);
  const blocked = input.execution.status === "blocked";
  const effectiveDecision = blocked ? "deny" : gate.decision;
  const effectiveRule = blocked ? "sandbox.unavailable" : gate.rule;
  const effectiveRuleSha256 = blocked
    ? recordHash({ rule: effectiveRule })
    : gate.rule_sha256;
  return {
    version: 1,
    decision: effectiveDecision,
    effective_decision: effectiveDecision,
    policy_decision: input.policy.decision,
    approval_decision: gate.decision,
    rule: effectiveRule,
    policy_rule: input.policy.rule,
    approval_rule: gate.rule,
    rule_sha256: effectiveRuleSha256,
    policy_rule_sha256: input.policy.rule_sha256,
    approval_rule_sha256: gate.rule_sha256,
    reason: blocked
      ? (input.execution.reason ?? "shell execution is unavailable")
      : gate.reason,
    policy_reason: input.policy.reason,
    approval_reason: gate.reason,
    requires_approval: blocked ? false : gate.requires_approval,
    approval_mode: gate.approval_mode,
    approval_adjusted: gate.approval_adjusted,
    approval_class: gate.approval_class,
    network_allow: [...(input.networkAllow ?? [])],
    network_deny: [...(input.networkDeny ?? [])],
    scoped_rule: gate.scoped_rule,
    execution: input.execution,
    layers: input.policy.layers,
    match: input.policy.match,
  };
}

export function formatPermissionExplanation(
  explanation: PermissionExplanation,
): string {
  return [
    `decision: ${explanation.decision}`,
    `policy decision: ${explanation.policy_decision}`,
    `approval decision: ${explanation.approval_decision}`,
    `approval mode: ${explanation.approval_mode}`,
    `approval class: ${explanation.approval_class}`,
    `requires approval: ${explanation.requires_approval ? "yes" : "no"}`,
    `execution: ${explanation.execution.status}${
      explanation.execution.reason === null
        ? ""
        : ` (${explanation.execution.reason})`
    }`,
    `rule: ${explanation.rule}`,
    ...(explanation.policy_rule === explanation.rule
      ? []
      : [`policy rule: ${explanation.policy_rule}`]),
    ...(explanation.approval_rule === explanation.rule ||
    explanation.approval_rule === explanation.policy_rule
      ? []
      : [`approval rule: ${explanation.approval_rule}`]),
    ...(explanation.scoped_rule === null
      ? []
      : [`scoped rule: ${explanation.scoped_rule.id}`]),
    ...(explanation.approval_class === "network"
      ? [
          `network allow: ${
            explanation.network_allow.length === 0
              ? "none (srt denies egress even when approved)"
              : explanation.network_allow.join(", ")
          }`,
          ...(explanation.network_deny.length === 0
            ? []
            : [`network deny: ${explanation.network_deny.join(", ")}`]),
        ]
      : []),
    `reason: ${explanation.reason}`,
    ...(explanation.policy_reason === explanation.reason
      ? []
      : [`policy reason: ${explanation.policy_reason}`]),
    `match: ${explanation.match.tool}${
      explanation.match.argv === undefined
        ? ""
        : ` · argv=${explanation.match.argv.join(" ")}`
    }`,
    ...(explanation.layers.length === 0
      ? []
      : [
          `layers: ${explanation.layers.map((layer) => layer.layer).join(", ")}`,
        ]),
  ].join("\n");
}
