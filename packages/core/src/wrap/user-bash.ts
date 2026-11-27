import type {
  BashOperations,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import type { EvidenceRecord } from "codepunk-protocol";
import { outputSha } from "../evidence/index.ts";
import {
  canReviewerResolveApproval,
  resolvePermissionGate,
  shellUnavailableReason as defaultShellUnavailableReason,
} from "../permissions/index.ts";
import { recordHash, sha256Text } from "../platform/hash.ts";
import { normalizeAbsolute } from "../platform/path.ts";
import { decidePolicy, policyRequestForCall } from "../policy/index.ts";
import type { ReviewResult } from "../reviewer/index.ts";
import { agentShellEnvironment } from "../sandbox/index.ts";
import { evaluatePlanModeGate } from "../work/index.ts";
import {
  approvalFailure,
  approvalReason,
  baseRecord,
  canonicalShellArgv,
  coveragePreview,
  denyPlanMode,
  exactApprovalArgv,
  executionStateFor,
  loopFingerprint,
  recordApprovalAnswer,
  resolveApprovalMode,
  resolveSandbox,
} from "./helpers.ts";
import { NONE_SANDBOX, type ToolWrapOptions } from "./types.ts";

export async function wrapUserBashCommand(
  command: string,
  toolCallId: string,
  options: ToolWrapOptions,
): Promise<UserBashEventResult> {
  if (toolCallId.length === 0) {
    throw new Error("tool call id is required");
  }
  if (options.disableUserBash === true) {
    const message =
      "! is disabled while Pi plugins are enabled; use the product shell through an approval";
    await options.ledger.append(
      baseRecord(options, {
        source: "user_bash",
        tool: "user_bash",
        toolCallId,
        decision: "deny",
        rule: "user_bash.plugins_enabled",
        ruleSha256: recordHash({ rule: "user_bash.plugins_enabled" }),
        policyLayers: [
          {
            layer: "user",
            source: "product/plugins",
            sha256: sha256Text("user_bash.plugins_enabled"),
            rule_sha256: recordHash({ rule: "user_bash.plugins_enabled" }),
          },
        ],
        approval: null,
        autonomy: null,
        command,
        commandArgv: null,
        pathTarget: null,
        sandbox: resolveSandbox(options.sandbox)?.descriptor ?? NONE_SANDBOX,
        coverage: "uncovered",
        coverageBasis: ["plugin"],
        exitCode: null,
        durationMs: 0,
        beforeSha256: null,
        afterSha256: null,
        diffSha256: null,
        outputRef: null,
        outputSha256: outputSha(message),
        outputPreview: message,
        emptyResult: null,
        executor: null,
      }),
    );
    return { result: deniedUserBashResult(message) };
  }
  const planModeState = options.planMode?.() ?? null;
  if (planModeState !== null && planModeState.mode !== "off") {
    const planGate = evaluatePlanModeGate({
      state: planModeState,
      plan: options.currentPlan?.() ?? null,
      tool: "user_bash",
    });
    if (!planGate.allowed) {
      const message = await denyPlanMode(options, {
        tool: "user_bash",
        toolCallId,
        command,
        commandArgv: null,
        pathTarget: null,
        rule: planGate.rule ?? "plan_mode.denied",
        reason: planGate.reason ?? "the active plan mode denied this call",
      });
      return { result: deniedUserBashResult(message) };
    }
  }
  let sandboxProvider = resolveSandbox(options.sandbox);
  if (
    sandboxProvider !== null &&
    typeof sandboxProvider.awaitReady === "function"
  ) {
    const settled = await sandboxProvider.awaitReady();
    const refreshed = resolveSandbox(options.sandbox);
    sandboxProvider = refreshed === null ? null : settled;
  }
  const autonomy = options.autonomy ?? null;
  const approvalMode = resolveApprovalMode(options);
  const policy = decidePolicy(
    policyRequestForCall({
      tool: "user_bash",
      rawCommand: command,
      cwd: options.cwd,
      workspaceRoot: options.workspaceRoot,
      ...(options.additionalRoots !== undefined
        ? { additionalRoots: options.additionalRoots }
        : {}),
      deliveryRoot: options.deliveryRoot,
      codepunkHome: options.codepunkHome,
      ...(options.artifactsDir !== undefined
        ? { artifactRoot: options.artifactsDir }
        : {}),
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      approvalMode,
      ...(options.filesystem !== undefined
        ? { filesystem: options.filesystem }
        : {}),
      reviewerAvailable:
        options.reviewer !== null && options.reviewer !== undefined,
      ...(autonomy !== null ? { autonomy: autonomy.profile } : {}),
      ...(options.writeSet !== undefined ? { writeSet: options.writeSet } : {}),
      ...(options.readableSkillFiles !== undefined
        ? { readableSkillFiles: options.readableSkillFiles }
        : {}),
      ...(options.userRules !== undefined
        ? { userRules: options.userRules }
        : {}),
      ...(options.projectRules !== undefined
        ? { projectRules: options.projectRules }
        : {}),
      ...(options.layers !== undefined ? { layers: options.layers } : {}),
    }),
  );

  let approvalEvidence: EvidenceRecord["approval"] = null;
  let reviewerEvidence: EvidenceRecord["reviewer"] = null;
  const gate = await resolvePermissionGate({
    policy,
    autonomy,
    approvalMode,
    tool: "user_bash",
    command,
    cwd: options.cwd,
  });
  let finalDecision = gate.decision;
  let finalRule = gate.rule;
  let finalRuleSha256 = gate.rule_sha256;
  let finalReason = gate.reason;
  let scopedRule = gate.scoped_rule;
  let budgetExceeded: EvidenceRecord["budget_exceeded"];
  const executionState = executionStateFor(options);
  const loopArgv = canonicalShellArgv("user_bash", {}, command);
  const autonomyEvidence = () =>
    autonomy === null ? null : autonomy.evidence(scopedRule);
  if (sandboxProvider === null) {
    if (finalDecision !== "deny") {
      finalDecision = "deny";
      finalRule = "sandbox.unavailable";
      finalRuleSha256 = recordHash({ rule: finalRule });
      finalReason =
        typeof options.shellUnavailableReason === "function"
          ? options.shellUnavailableReason()
          : (options.shellUnavailableReason ??
            defaultShellUnavailableReason("required"));
    }
  }

  if (finalDecision !== "deny" && loopArgv !== null) {
    const fingerprint = loopFingerprint("user_bash", loopArgv, options.cwd);
    if (executionState.lastLoopFingerprint === fingerprint) {
      executionState.repeatCount += 1;
    } else {
      executionState.lastLoopFingerprint = fingerprint;
      executionState.repeatCount = 1;
    }
    const threshold = 3;
    if (executionState.repeatCount > threshold) {
      finalDecision = "deny";
      finalRule = "loop_guard";
      finalRuleSha256 = recordHash({ rule: finalRule });
      finalReason = `the same command repeated ${executionState.repeatCount} times in a row (threshold ${threshold})`;
      await options.onExecutionEvent?.("loop_guard", {
        run_id: options.runId,
        tool: "user_bash",
        canonical_argv: [...loopArgv],
        cwd: normalizeAbsolute(options.cwd),
        repeat_count: executionState.repeatCount,
        threshold,
        decision: "deny",
      });
    }
  }

  if (finalDecision !== "deny") {
    const maxToolCalls = options.budget?.maxToolCalls;
    if (
      maxToolCalls !== undefined &&
      executionState.usedToolCalls >= maxToolCalls
    ) {
      budgetExceeded = {
        run_id: options.runId,
        limit_kind: "tool_calls",
        limit: maxToolCalls,
        used: executionState.usedToolCalls,
        action: "reject_call",
      };
      finalDecision = "deny";
      finalRule = "budget.tool_calls";
      finalRuleSha256 = recordHash({ rule: finalRule });
      finalReason = `tool call budget exhausted (${executionState.usedToolCalls}/${maxToolCalls}); the call was not executed`;
      await options.onExecutionEvent?.("budget/exceeded", budgetExceeded);
    } else {
      const maxWallMs = options.budget?.maxWallMs;
      const elapsedMs = Math.max(
        0,
        Math.round(performance.now() - executionState.wallStartedAt),
      );
      if (maxWallMs !== undefined && elapsedMs >= maxWallMs) {
        budgetExceeded = {
          run_id: options.runId,
          limit_kind: "wall_ms",
          limit: maxWallMs,
          used: elapsedMs,
          action: "abort_run",
        };
        finalDecision = "deny";
        finalRule = "budget.wall_ms";
        finalRuleSha256 = recordHash({ rule: finalRule });
        finalReason = `wall-clock budget exhausted (${elapsedMs}/${maxWallMs} ms); the call was not executed`;
        await options.onExecutionEvent?.("budget/exceeded", budgetExceeded);
        await options.onBudgetAbort?.();
      } else {
        executionState.usedToolCalls += 1;
      }
    }
  }

  if (finalDecision !== "deny" && gate.consult_approval) {
    const approvalArgv = exactApprovalArgv("user_bash", command, null);
    const requestReason = approvalReason(
      policy,
      gate.reason,
      options.networkAllowedDomains,
      options.networkDeniedDomains,
    );
    const reviewer = options.reviewer ?? null;
    let review: ReviewResult | null = null;
    if (
      reviewer !== null &&
      approvalMode === "auto" &&
      gate.rule !== "scoped.unmatched" &&
      canReviewerResolveApproval(gate.approval_class)
    ) {
      try {
        review = await reviewer.review({
          tool: "user_bash",
          command,
          argv: approvalArgv,
          cwd: options.cwd,
          path: null,
          approvalClass: gate.approval_class,
          policyRule: policy.rule,
          policyReason: policy.reason,
          approvalReason: requestReason,
          argsPreview: null,
          argsSha256: null,
          diffSha256: null,
        });
      } catch {
        review = null;
      }
      if (review !== null) {
        reviewerEvidence = review.evidence;
      }
    }
    let reviewResolved = false;
    if (review !== null && review.decision === "allow") {
      finalDecision = "allow";
      finalRule = "reviewer.model.allow";
      finalRuleSha256 = recordHash({ rule: finalRule });
      finalReason = `reviewer allowed: ${review.reason}`;
      reviewResolved = true;
    } else if (review !== null && review.decision === "deny") {
      finalDecision = "deny";
      finalRule = "reviewer.model.deny";
      finalRuleSha256 = recordHash({ rule: finalRule });
      finalReason = `reviewer denied: ${review.reason}`;
      reviewResolved = true;
    }
    if (!reviewResolved) {
      if (options.approval === null || options.approval === undefined) {
        finalDecision = "deny";
        finalRule =
          review === null ? "approval.unavailable" : "reviewer.abstained";
        finalRuleSha256 = recordHash({ rule: finalRule });
        finalReason =
          review === null
            ? gate.reason
            : `reviewer abstained and no interactive approval channel is available: ${review.reason}`;
      } else {
        const approval = await options.approval.request({
          sessionId: options.sessionId,
          workerId: options.workerId ?? "local",
          toolCallId,
          tool: "user_bash",
          command,
          ...(approvalArgv === null
            ? {}
            : { argv: approvalArgv, cwd: options.cwd }),
          reason: requestReason,
          coveragePreview: coveragePreview("user_bash", sandboxProvider)!,
        });
        approvalEvidence = approval.evidence;
        await recordApprovalAnswer(options, approval.answer);
        if (!approval.approved) {
          const failure = approvalFailure(approval);
          finalDecision = "deny";
          finalRule = failure.rule;
          finalRuleSha256 = recordHash({ rule: finalRule });
          finalReason = failure.reason;
        } else {
          finalDecision = "allow";
        }
      }
    }
  }

  const guidance = approvalEvidence?.guidance;
  const denialMessage =
    finalDecision === "allow"
      ? null
      : `denied: ${finalRule} (${finalReason})${
          guidance === undefined ? "" : `\nUser guidance: ${guidance}`
        }`;
  if (denialMessage !== null) {
    await options.ledger.append(
      baseRecord(options, {
        source: "user_bash",
        tool: "user_bash",
        toolCallId,
        decision: "deny",
        rule: finalRule,
        ruleSha256: finalRuleSha256,
        policyLayers: policy.layers,
        approval: approvalEvidence,
        reviewer: reviewerEvidence,
        autonomy: autonomyEvidence(),
        command,
        commandArgv: null,
        pathTarget: null,
        sandbox: sandboxProvider?.descriptor ?? NONE_SANDBOX,
        coverage: "uncovered",
        coverageBasis: ["policy"],
        exitCode: null,
        durationMs: 0,
        beforeSha256: null,
        afterSha256: null,
        diffSha256: null,
        outputRef: null,
        outputSha256: outputSha(denialMessage),
        outputPreview: denialMessage,
        emptyResult: null,
        executor: null,
        ...(budgetExceeded === undefined ? {} : { budgetExceeded }),
      }),
    );
    return { result: deniedUserBashResult(denialMessage) };
  }

  const sandbox = sandboxProvider;
  if (sandbox === null) {
    throw new Error("unreachable: denied sandbox-unavailable user_bash");
  }
  const operations: BashOperations = {
    async exec(actualCommand, cwd, executionOptions) {
      const start = performance.now();
      try {
        const result = await sandbox.execCommand(actualCommand, cwd, {
          onData: executionOptions.onData,
          ...(executionOptions.signal !== undefined
            ? { signal: executionOptions.signal }
            : {}),
          ...(executionOptions.timeout !== undefined
            ? { timeout: executionOptions.timeout }
            : {}),
          env: agentShellEnvironment(executionOptions.env),
        });
        const durationMs = Math.max(0, Math.round(performance.now() - start));
        await options.ledger.append(
          baseRecord(options, {
            source: "user_bash",
            tool: "user_bash",
            toolCallId,
            decision: "allow",
            rule: finalRule,
            ruleSha256: finalRuleSha256,
            policyLayers: policy.layers,
            approval: approvalEvidence,
            reviewer: reviewerEvidence,
            autonomy: autonomyEvidence(),
            command,
            commandArgv: null,
            pathTarget: null,
            sandbox: sandbox.descriptor,
            coverage: sandbox.sandboxed ? "enforced" : "uncovered",
            coverageBasis: sandbox.sandboxed
              ? ["policy", "srt"]
              : ["policy", "unsandboxed"],
            exitCode: result.exitCode,
            durationMs,
            beforeSha256: null,
            afterSha256: null,
            diffSha256: null,
            outputRef: null,
            outputSha256: outputSha(result.output),
            outputPreview: result.output.slice(0, 4_096),
            emptyResult: null,
            executor: result.executor,
          }),
        );
        await options.onUserBashResult?.({
          command,
          output: result.output,
          exitCode: result.exitCode,
          cancelled: result.cancelled,
          timedOut: result.timedOut,
        });
        if (result.cancelled) {
          throw new Error("aborted");
        }
        return { exitCode: result.exitCode };
      } catch (error) {
        if (error instanceof Error && error.message === "aborted") {
          throw error;
        }
        const message = `user_bash failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        await options.ledger.append(
          baseRecord(options, {
            source: "user_bash",
            tool: "user_bash",
            toolCallId,
            decision: "allow",
            rule: finalRule,
            ruleSha256: finalRuleSha256,
            policyLayers: policy.layers,
            approval: approvalEvidence,
            reviewer: reviewerEvidence,
            autonomy: autonomyEvidence(),
            command,
            commandArgv: null,
            pathTarget: null,
            sandbox: sandbox.descriptor,
            coverage: sandbox.sandboxed ? "enforced" : "uncovered",
            coverageBasis: sandbox.sandboxed
              ? ["policy", "srt"]
              : ["policy", "unsandboxed"],
            exitCode: null,
            durationMs: Math.max(0, Math.round(performance.now() - start)),
            beforeSha256: null,
            afterSha256: null,
            diffSha256: null,
            outputRef: null,
            outputSha256: outputSha(message),
            outputPreview: message,
            emptyResult: null,
            executor: sandbox.sandboxed ? "srt" : "direct",
          }),
        );
        await options.onUserBashFailure?.(message);
        throw error;
      }
    },
  };
  return { operations };
}

export function deniedUserBashResult(message: string): {
  output: string;
  exitCode: number;
  cancelled: boolean;
  truncated: boolean;
} {
  return {
    output: message,
    exitCode: 1,
    cancelled: false,
    truncated: false,
  };
}
