import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { EvidenceRecord } from "codepunk-protocol";
import { validateSchema } from "codepunk-protocol";
import {
  boundedToolOutput,
  estimateTextTokens,
  foldTestRunnerOutput,
  redactOutputPreview,
  writeToolOutputArtifact,
  type ToolOutputArtifact,
} from "../artifacts/index.ts";
import {
  diagnoseFileContent,
  formatDiagnosticsSummary,
  formatEditAnchorHints,
} from "../diagnostics/index.ts";
import { outputSha } from "../evidence/index.ts";
import {
  canReviewerResolveApproval,
  resolvePermissionGate,
  shellUnavailableReason as defaultShellUnavailableReason,
} from "../permissions/index.ts";
import { canonicalJson, recordHash, sha256Text } from "../platform/hash.ts";
import { normalizeAbsolute, relativeDisplayPath } from "../platform/path.ts";
import { decidePolicy, policyRequestForCall } from "../policy/index.ts";
import type { ReviewResult } from "../reviewer/index.ts";
import {
  extractEditReplacements,
  toolExecutionPolicy,
} from "../tools/index.ts";
import { evaluatePlanModeGate } from "../work/index.ts";
import {
  acquireToolMutation,
  alreadyAppliedResult,
  approvalArguments,
  approvalFailure,
  approvalReason,
  argvParam,
  baseRecord,
  boundedApprovalPreview,
  canonicalShellArgv,
  coveragePreview,
  denyPlanMode,
  diffHash,
  diffPreview,
  evidenceSource,
  exactApprovalArgv,
  executionStateFor,
  extractTaintOrigin,
  isShellTool,
  loopFingerprint,
  memoryEvidence,
  memoryRetrieval,
  mutationIdempotencyKey,
  recordApprovalAnswer,
  redactApprovalValue,
  resolveApprovalMode,
  resolveSandbox,
  resultText,
  resultWithBoundedOutput,
  shellCoverage,
  shouldEscalateTaintedCall,
  snapshotFile,
  structuredNumber,
  structuredString,
  targetPath,
  textResult,
  verifyMutationResult,
} from "./helpers.ts";
import {
  NONE_SANDBOX,
  type AnyToolDefinition,
  type AnyToolResult,
  type FileSnapshot,
  type TaintOrigin,
  type ToolExecutionState,
  type ToolLifecycleHookInput,
  type ToolLifecycleHookResult,
  type ToolWrapOptions,
} from "./types.ts";
import { deniedUserBashResult, wrapUserBashCommand } from "./user-bash.ts";

export {
  deniedUserBashResult,
  wrapUserBashCommand,
  type TaintOrigin,
  type ToolExecutionState,
  type ToolLifecycleHookInput,
  type ToolLifecycleHookResult,
  type ToolWrapOptions,
};

export async function wrapToolDefinition(
  definition: AnyToolDefinition,
  options: ToolWrapOptions,
): Promise<AnyToolDefinition> {
  return {
    ...definition,
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: ((partial: AnyToolResult) => void) | undefined,
      context: ExtensionToolContext,
    ): Promise<AnyToolResult> {
      if (toolCallId.length === 0) {
        throw new Error("tool call id is required");
      }
      const argumentValidation = validateSchema(definition.parameters, params);
      if (!argumentValidation.ok) {
        const message = `invalid tool arguments: ${argumentValidation.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ")}`;
        await options.ledger.append(
          baseRecord(options, {
            source: evidenceSource(definition.name),
            tool: definition.name,
            toolCallId,
            decision: "deny",
            rule: "tool.invalid_arguments",
            ruleSha256: recordHash({ rule: "tool.invalid_arguments" }),
            policyLayers: [],
            approval: null,
            command: null,
            commandArgv: null,
            pathTarget: null,
            sandbox: NONE_SANDBOX,
            coverage: "uncovered",
            coverageBasis: ["arguments"],
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
        return textResult(message);
      }
      const hookInput: ToolLifecycleHookInput = {
        tool: definition.name,
        tool_call_id: toolCallId,
        args_sha256: sha256Text(canonicalJson(params)),
        args_preview: boundedApprovalPreview(
          JSON.stringify(redactApprovalValue(params), null, 2),
        ),
      };
      let sandboxProvider = resolveSandbox(options.sandbox);
      if (
        isShellTool(definition.name) &&
        sandboxProvider !== null &&
        typeof sandboxProvider.awaitReady === "function"
      ) {
        const settled = await sandboxProvider.awaitReady();
        const refreshed = resolveSandbox(options.sandbox);
        sandboxProvider = refreshed === null ? null : settled;
      }
      const autonomy = options.autonomy ?? null;
      const target = targetPath(definition.name, params, options.cwd);
      const isMutation =
        definition.name === "write" || definition.name === "edit";
      const commandArgv = definition.name === "exec" ? argvParam(params) : null;
      const command =
        definition.name === "bash" && typeof params["command"] === "string"
          ? params["command"]
          : null;
      const planModeState = options.planMode?.() ?? null;
      if (planModeState !== null && planModeState.mode !== "off") {
        const planGate = evaluatePlanModeGate({
          state: planModeState,
          plan: options.currentPlan?.() ?? null,
          tool: definition.name,
        });
        if (!planGate.allowed) {
          const message = await denyPlanMode(options, {
            tool: definition.name,
            toolCallId,
            command,
            commandArgv,
            pathTarget: target,
            rule: planGate.rule ?? "plan_mode.denied",
            reason: planGate.reason ?? "the active plan mode denied this call",
          });
          return textResult(message);
        }
      }
      const executionState = executionStateFor(options);
      const executionPolicy = toolExecutionPolicy(definition.name);
      const loopArgv = canonicalShellArgv(definition.name, params);
      const idempotencyKey = mutationIdempotencyKey(
        definition.name,
        target,
        params,
      );
      const approvalMode = resolveApprovalMode(options);
      const policy = decidePolicy(
        policyRequestForCall({
          tool: definition.name,
          args: params,
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
          ...(options.writeSet !== undefined
            ? { writeSet: options.writeSet }
            : {}),
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
      const releaseMutation =
        isMutation && target !== null
          ? await acquireToolMutation(target)
          : null;
      try {
        const before =
          isMutation && target !== null && policy.decision !== "deny"
            ? await snapshotFile(target)
            : null;

        let approvalEvidence: EvidenceRecord["approval"] = null;
        let reviewerEvidence: EvidenceRecord["reviewer"] = null;
        const gate = await resolvePermissionGate({
          policy,
          autonomy,
          approvalMode,
          tool: definition.name,
          command,
          argv: commandArgv,
          cwd: options.cwd,
        });
        let finalDecision = gate.decision;
        let finalRule = gate.rule;
        let finalRuleSha256 = gate.rule_sha256;
        let finalReason = gate.reason;
        let scopedRule = gate.scoped_rule;
        let consultApproval = gate.consult_approval;
        let taintEscalated = false;
        if (
          executionState.taintedBy !== null &&
          finalDecision !== "deny" &&
          scopedRule === null &&
          shouldEscalateTaintedCall(definition.name, policy.decision)
        ) {
          finalDecision = "ask";
          consultApproval = true;
          taintEscalated = true;
        }
        let degradedShellEscalated = false;
        if (
          options.forceShellApproval?.() === true &&
          finalDecision !== "deny" &&
          scopedRule === null &&
          isShellTool(definition.name)
        ) {
          finalDecision = "ask";
          consultApproval = true;
          degradedShellEscalated = true;
        }
        let budgetExceeded: EvidenceRecord["budget_exceeded"];
        const autonomyEvidence = () =>
          autonomy === null ? null : autonomy.evidence(scopedRule);
        if (isShellTool(definition.name) && sandboxProvider === null) {
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

        if (
          finalDecision !== "deny" &&
          loopArgv !== null &&
          isShellTool(definition.name)
        ) {
          const fingerprint = loopFingerprint(
            definition.name,
            loopArgv,
            options.cwd,
          );
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
              tool: definition.name,
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
              await options.onExecutionEvent?.(
                "budget/exceeded",
                budgetExceeded,
              );
              await options.onBudgetAbort?.();
            } else {
              executionState.usedToolCalls += 1;
            }
          }
        }

        if (
          finalDecision === "allow" &&
          idempotencyKey !== null &&
          target !== null &&
          before !== null
        ) {
          const expectedAfter =
            executionState.idempotentResults.get(idempotencyKey);
          if (expectedAfter !== undefined) {
            const current = await snapshotFile(target);
            if (current.sha256 === expectedAfter) {
              const result = alreadyAppliedResult(
                definition.name,
                target,
                idempotencyKey,
              );
              const message = resultText(result);
              await options.ledger.append(
                baseRecord(options, {
                  source: evidenceSource(definition.name),
                  tool: definition.name,
                  toolCallId,
                  decision: "allow",
                  outcome: "completed",
                  rule: "idempotency.already_applied",
                  ruleSha256: recordHash({
                    rule: "idempotency.already_applied",
                  }),
                  policyLayers: policy.layers,
                  approval: null,
                  command,
                  commandArgv,
                  pathTarget: target,
                  sandbox: NONE_SANDBOX,
                  coverage: shellCoverage(
                    definition.name,
                    true,
                    sandboxProvider,
                  ),
                  coverageBasis: ["policy", "idempotency"],
                  exitCode: null,
                  durationMs: 0,
                  beforeSha256: current.sha256,
                  afterSha256: current.sha256,
                  diffSha256: null,
                  outputRef: null,
                  outputSha256: outputSha(message),
                  outputPreview: message,
                  emptyResult: null,
                  executor: null,
                  idempotencyKey,
                  reused: true,
                }),
              );
              return result;
            }
          }
        }

        if (finalDecision !== "deny" && consultApproval) {
          const approvalArgv = exactApprovalArgv(
            definition.name,
            command,
            commandArgv,
          );
          const preview = await diffPreview(
            definition.name,
            params,
            target,
            before,
            options.workspaceRoot,
          );
          const coverage = coveragePreview(definition.name, sandboxProvider);
          const args = approvalArguments(definition.name, params);
          const approvalPath =
            typeof policy.match.path === "string" ? policy.match.path : target;
          const baseReason = approvalReason(
            policy,
            gate.reason,
            options.networkAllowedDomains,
            options.networkDeniedDomains,
          );
          const taintNotice =
            taintEscalated && executionState.taintedBy !== null
              ? `[taint guard: session ingested untrusted ${executionState.taintedBy.tool} output from ${executionState.taintedBy.source}] `
              : "";
          const degradedNotice = degradedShellEscalated
            ? "[degraded unsandboxed shell: srt unavailable] "
            : "";
          const requestReason = `${taintNotice}${degradedNotice}${baseReason}`;
          const reviewer = options.reviewer ?? null;
          let review: ReviewResult | null = null;
          if (
            !taintEscalated &&
            reviewer !== null &&
            approvalMode === "auto" &&
            gate.rule !== "scoped.unmatched" &&
            canReviewerResolveApproval(gate.approval_class)
          ) {
            try {
              review = await reviewer.review(
                {
                  tool: definition.name,
                  command,
                  argv: approvalArgv,
                  cwd: options.cwd,
                  path: approvalPath,
                  approvalClass: gate.approval_class,
                  policyRule: policy.rule,
                  policyReason: policy.reason,
                  approvalReason: requestReason,
                  argsPreview: args?.preview ?? null,
                  argsSha256: args?.sha256 ?? null,
                  diffSha256: preview?.sha256 ?? null,
                },
                signal,
              );
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
              finalRule = taintEscalated
                ? "taint.untrusted_context"
                : review === null
                  ? "approval.unavailable"
                  : "reviewer.abstained";
              finalRuleSha256 = recordHash({ rule: finalRule });
              finalReason = taintEscalated
                ? `${requestReason}; interactive human approval is required after untrusted web ingestion`
                : review === null
                  ? gate.reason
                  : `reviewer abstained and no interactive approval channel is available: ${review.reason}`;
            } else {
              const approval = await options.approval.request({
                sessionId: options.sessionId,
                workerId: options.workerId ?? "local",
                toolCallId,
                tool: definition.name,
                command,
                ...(approvalArgv === null ? {} : { argv: approvalArgv }),
                cwd: options.cwd,
                path: approvalPath,
                reason: requestReason,
                ...(args === null
                  ? {}
                  : {
                      argsPreview: args.preview,
                      argsSha256: args.sha256,
                    }),
                ...(preview === null
                  ? {}
                  : {
                      diffPreview: preview.text,
                      diffSha256: preview.sha256,
                    }),
                ...(coverage === undefined
                  ? {}
                  : { coveragePreview: coverage }),
              });
              approvalEvidence = approval.evidence;
              await recordApprovalAnswer(options, approval.answer);
              if (!approval.approved) {
                const failure = approvalFailure(approval);
                finalDecision = "deny";
                finalRule =
                  taintEscalated && failure.rule === "approval.unavailable"
                    ? "taint.untrusted_context"
                    : failure.rule;
                finalRuleSha256 = recordHash({ rule: finalRule });
                finalReason =
                  taintEscalated && failure.rule === "approval.unavailable"
                    ? `${requestReason}; interactive human approval is required after untrusted web ingestion`
                    : failure.reason;
              } else {
                finalDecision = "allow";
              }
            }
          }
        }

        if (
          definition.name === "exec" &&
          commandArgv !== null &&
          options.verifyExec !== undefined
        ) {
          let issue: string | null;
          try {
            issue = await options.verifyExec(commandArgv, options.cwd);
          } catch (error) {
            issue = `headless exec verification failed: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
          if (issue !== null) {
            await options.ledger.append(
              baseRecord(options, {
                source: evidenceSource(definition.name),
                tool: definition.name,
                toolCallId,
                decision: "deny",
                rule: "exec.verification_failed",
                ruleSha256: recordHash({ rule: "exec.verification_failed" }),
                policyLayers: policy.layers,
                approval: approvalEvidence,
                reviewer: reviewerEvidence,
                autonomy: autonomyEvidence(),
                command: null,
                commandArgv,
                pathTarget: null,
                sandbox: sandboxProvider?.descriptor ?? NONE_SANDBOX,
                coverage: "uncovered",
                coverageBasis: ["policy", "digest"],
                exitCode: null,
                durationMs: 0,
                beforeSha256: null,
                afterSha256: null,
                diffSha256: null,
                outputRef: null,
                outputSha256: outputSha(issue),
                outputPreview: issue,
                emptyResult: null,
                executor: null,
              }),
            );
            return textResult(`denied: ${issue}`);
          }
        }

        const recheckMutation = async (
          expected: FileSnapshot | null,
        ): Promise<{ rule: string; reason: string } | null> => {
          if (!isMutation || target === null || expected === null) {
            return null;
          }
          let recheck: FileSnapshot | null = null;
          let issue: string | null = null;
          try {
            recheck = await snapshotFile(target);
          } catch (error) {
            issue = error instanceof Error ? error.message : String(error);
          }
          if (
            issue === null &&
            recheck !== null &&
            (recheck.exists !== expected.exists ||
              recheck.sha256 !== expected.sha256 ||
              recheck.mode !== expected.mode)
          ) {
            issue = "mutation target changed after the approval decision";
          }
          return issue === null
            ? null
            : { rule: "path.recheck", reason: issue };
        };
        const prepareAttempt = async (
          expected: FileSnapshot | null,
        ): Promise<{ rule: string; reason: string } | null> => {
          try {
            await options.beforeToolHook?.(hookInput);
          } catch (error) {
            return {
              rule: "hook.before_tool",
              reason: error instanceof Error ? error.message : String(error),
            };
          }
          return recheckMutation(expected);
        };
        const runAfterHook = async (
          result: AnyToolResult,
          executionError: unknown,
        ): Promise<{ rule: string; reason: string } | null> => {
          try {
            await options.afterToolHook?.({
              ...hookInput,
              is_error: result.isError === true || executionError !== undefined,
              output_sha256: sha256Text(canonicalJson(result.content ?? [])),
              duration_ms: durationMs,
            });
            return null;
          } catch (error) {
            return {
              rule: "hook.after_tool",
              reason: error instanceof Error ? error.message : String(error),
            };
          }
        };
        const hookIssue = await prepareAttempt(before);
        if (hookIssue !== null) {
          finalDecision = "deny";
          finalRule = hookIssue.rule;
          finalRuleSha256 = recordHash({ rule: finalRule });
          finalReason = hookIssue.reason;
        }

        if (finalDecision !== "allow") {
          const guidance = approvalEvidence?.guidance;
          const message = `${
            finalRule.startsWith("hook.")
              ? `blocked by ${finalRule.slice("hook.".length)} hook: ${finalReason}`
              : `denied: ${finalRule} (${finalReason})`
          }${guidance === undefined ? "" : `\nUser guidance: ${guidance}`}`;
          await options.ledger.append(
            baseRecord(options, {
              source: evidenceSource(definition.name),
              tool: definition.name,
              toolCallId,
              decision: "deny",
              rule: finalRule,
              ruleSha256: finalRuleSha256,
              policyLayers: policy.layers,
              approval: approvalEvidence,
              reviewer: reviewerEvidence,
              autonomy: autonomyEvidence(),
              command,
              commandArgv,
              pathTarget: target,
              sandbox: NONE_SANDBOX,
              coverage: shellCoverage(definition.name, false, sandboxProvider),
              coverageBasis: ["policy"],
              exitCode: null,
              durationMs: 0,
              beforeSha256: before?.sha256 ?? null,
              afterSha256: before?.sha256 ?? null,
              diffSha256: null,
              outputRef: null,
              outputSha256: outputSha(message),
              outputPreview: message,
              emptyResult:
                definition.name === "read" || definition.name === "search"
                  ? true
                  : null,
              executor: null,
              ...(budgetExceeded === undefined ? {} : { budgetExceeded }),
              ...(definition.name === "memory_search"
                ? {
                    memory: memoryEvidence(
                      params,
                      null,
                      options.memoryCap ??
                        (typeof params["limit"] === "number"
                          ? params["limit"]
                          : 0),
                    ),
                  }
                : {}),
            }),
          );
          return textResult(message);
        }

        let durationMs = 0;
        const executeOnce = async (): Promise<{
          result: AnyToolResult;
          executionError: unknown;
        }> => {
          const start = performance.now();
          let result: AnyToolResult;
          let executionError: unknown;
          try {
            result = await definition.execute(
              toolCallId,
              params,
              signal,
              onUpdate,
              context,
            );
          } catch (error) {
            executionError = error;
            result = textResult(
              `tool failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          durationMs += Math.max(0, Math.round(performance.now() - start));
          return { result, executionError };
        };
        let attempt = await executeOnce();
        let result = attempt.result;
        let executionError = attempt.executionError;
        let hookFailure = await runAfterHook(result, executionError);
        if (hookFailure !== null) {
          executionError = new Error(hookFailure.reason);
          result = textResult(
            `blocked by ${hookFailure.rule.slice("hook.".length)} hook: ${
              hookFailure.reason
            }`,
          );
        }
        let after =
          isMutation && target !== null ? await snapshotFile(target) : null;
        let verifyEvidence: EvidenceRecord["verify"];
        let retryEvidence: EvidenceRecord["retry"];
        const maxAttempts =
          executionPolicy.retry === "safe" &&
          executionPolicy.idempotent &&
          executionPolicy.sideEffect === "write"
            ? 1
            : 0;
        const verifyResult = options.verifyToolResult ?? verifyMutationResult;
        if (
          isMutation &&
          target !== null &&
          before !== null &&
          after !== null &&
          result.isError !== true &&
          hookFailure === null
        ) {
          verifyEvidence = await verifyResult({
            tool: definition.name,
            params,
            target,
            before,
            after,
            result,
          });
          if (verifyEvidence.result === "fail" && maxAttempts > 0) {
            const reason =
              verifyEvidence.reason ?? "the mutation verifier failed";
            const failedMessage = `verification failed: ${reason}`;
            await options.ledger.append(
              baseRecord(options, {
                source: evidenceSource(definition.name),
                tool: definition.name,
                toolCallId,
                decision: "allow",
                outcome: "failed",
                rule: "verify.failed",
                ruleSha256: recordHash({ rule: "verify.failed" }),
                policyLayers: policy.layers,
                approval: approvalEvidence,
                reviewer: reviewerEvidence,
                autonomy: autonomyEvidence(),
                command,
                commandArgv,
                pathTarget: target,
                sandbox: NONE_SANDBOX,
                coverage: "app-layer",
                coverageBasis: ["policy", "verify"],
                exitCode: null,
                durationMs: 0,
                beforeSha256: before.sha256,
                afterSha256: after.sha256,
                diffSha256: null,
                outputRef: null,
                outputSha256: outputSha(failedMessage),
                outputPreview: failedMessage,
                emptyResult: null,
                executor: null,
                ...(idempotencyKey === null ? {} : { idempotencyKey }),
                verify: verifyEvidence,
                retry: {
                  attempt: 0,
                  max_attempts: maxAttempts,
                  reason,
                },
              }),
            );
            retryEvidence = {
              attempt: 1,
              max_attempts: maxAttempts,
              reason,
            };
            const retryBefore = after;
            const retryIssue = await prepareAttempt(retryBefore);
            if (retryIssue !== null) {
              hookFailure = retryIssue;
              executionError = new Error(retryIssue.reason);
              result = textResult(
                retryIssue.rule.startsWith("hook.")
                  ? `blocked by ${retryIssue.rule.slice("hook.".length)} hook: ${
                      retryIssue.reason
                    }`
                  : `denied: ${retryIssue.rule} (${retryIssue.reason})`,
              );
            } else {
              attempt = await executeOnce();
              result = attempt.result;
              executionError = attempt.executionError;
              hookFailure = await runAfterHook(result, executionError);
              if (hookFailure !== null) {
                executionError = new Error(hookFailure.reason);
                result = textResult(
                  `blocked by ${hookFailure.rule.slice("hook.".length)} hook: ${
                    hookFailure.reason
                  }`,
                );
              }
              after = await snapshotFile(target);
              if (hookFailure === null && result.isError !== true) {
                verifyEvidence = await verifyResult({
                  tool: definition.name,
                  params,
                  target,
                  before: retryBefore,
                  after,
                  result,
                });
              }
            }
          }
          if (
            hookFailure === null &&
            verifyEvidence !== undefined &&
            verifyEvidence.result === "fail"
          ) {
            result = textResult(
              `verification failed: ${
                verifyEvidence.reason ?? "the mutation verifier failed"
              }`,
            );
            executionError = null;
          }
        }
        const outcome: EvidenceRecord["outcome"] =
          signal?.aborted === true ||
          (executionError instanceof Error &&
            (executionError.name === "AbortError" ||
              executionError.message === "aborted" ||
              executionError.message.includes("Command aborted")))
            ? "cancelled"
            : result.isError === true
              ? "failed"
              : "completed";
        if (
          outcome === "completed" &&
          (definition.name === "web_fetch" ||
            definition.name === "web_search") &&
          executionState.taintedBy === null
        ) {
          executionState.taintedBy = extractTaintOrigin(
            definition.name,
            params,
          );
        }
        const output = resultText(result);
        const shellOutput = structuredString(result, "output");
        const effectiveOutput = shellOutput ?? output;
        let artifact: ToolOutputArtifact | null = null;
        const artifactThreshold = Math.max(
          1,
          options.artifactThresholdTokens ?? 2_000,
        );
        if (
          options.artifactsDir !== undefined &&
          estimateTextTokens(effectiveOutput) > artifactThreshold
        ) {
          artifact = await writeToolOutputArtifact({
            artifactsDir: options.artifactsDir,
            sessionId: options.sessionId,
            output: effectiveOutput,
            ...(options.now !== undefined ? { now: options.now } : {}),
          });
        }
        const folded = isShellTool(definition.name)
          ? foldTestRunnerOutput(effectiveOutput, {
              command,
              argv: commandArgv,
              artifact,
            })
          : { text: effectiveOutput, foldedPassingLines: 0 };
        const visibleOutput = boundedToolOutput(folded.text, {
          maxTokens: Math.max(1, options.maxToolOutputTokens ?? 8_000),
          artifact,
          home: options.codepunkHome,
        });
        const exitCode = isShellTool(definition.name)
          ? structuredNumber(result, "exit_code")
          : null;
        const sandbox =
          isShellTool(definition.name) && sandboxProvider !== null
            ? sandboxProvider.descriptor
            : NONE_SANDBOX;
        const coverage = shellCoverage(definition.name, true, sandboxProvider);
        const beforeBytes = before?.bytes ?? Buffer.alloc(0);
        const afterBytes = after?.bytes ?? beforeBytes;
        const label =
          target === null
            ? definition.name
            : relativeDisplayPath(options.cwd, target);
        const patch =
          isMutation && before !== null && after !== null
            ? diffHash(beforeBytes, afterBytes, label)
            : null;
        if (
          isMutation &&
          target !== null &&
          before !== null &&
          after !== null &&
          outcome === "completed" &&
          options.checkpoints !== null &&
          options.checkpoints !== undefined
        ) {
          try {
            await options.checkpoints.record({
              tool: definition.name as "write" | "edit",
              toolCallId,
              target,
              before,
              after,
            });
          } catch {
            // Undo is an auxiliary recovery surface. A full checkpoint store
            // must not turn a successful file mutation into a tool failure.
          }
        }
        if (
          outcome === "completed" &&
          idempotencyKey !== null &&
          after !== null
        ) {
          executionState.idempotentResults.set(idempotencyKey, after.sha256);
        }
        await options.ledger.append(
          baseRecord(options, {
            source: evidenceSource(definition.name),
            tool: definition.name,
            toolCallId,
            decision: hookFailure === null ? "allow" : "deny",
            outcome,
            rule: hookFailure?.rule ?? finalRule,
            ruleSha256: recordHash({
              rule: hookFailure?.rule ?? finalRule,
            }),
            policyLayers: policy.layers,
            approval: approvalEvidence,
            reviewer: reviewerEvidence,
            autonomy: autonomyEvidence(),
            command,
            commandArgv,
            pathTarget: target,
            sandbox,
            coverage,
            coverageBasis:
              hookFailure !== null
                ? ["policy", "hook"]
                : isShellTool(definition.name)
                  ? sandboxProvider?.sandboxed === true
                    ? ["policy", "srt"]
                    : ["policy", "unsandboxed"]
                  : ["policy"],
            exitCode,
            durationMs,
            beforeSha256: before?.sha256 ?? null,
            afterSha256: after?.sha256 ?? null,
            diffSha256: patch,
            outputRef: artifact?.ref ?? null,
            outputSha256: outputSha(effectiveOutput),
            outputPreview: redactOutputPreview(
              effectiveOutput,
              options.codepunkHome,
            ).slice(0, 4_096),
            emptyResult:
              definition.name === "read" || definition.name === "search"
                ? effectiveOutput.trim().length === 0
                : null,
            executor:
              isShellTool(definition.name) && sandboxProvider !== null
                ? sandboxProvider.sandboxed
                  ? "srt"
                  : "direct"
                : null,
            ...(idempotencyKey === null ? {} : { idempotencyKey }),
            ...(retryEvidence === undefined ? {} : { retry: retryEvidence }),
            ...(verifyEvidence === undefined ? {} : { verify: verifyEvidence }),
            ...(definition.name === "memory_search"
              ? {
                  memory: memoryEvidence(
                    params,
                    result,
                    options.memoryCap ??
                      (typeof params["limit"] === "number"
                        ? params["limit"]
                        : 0),
                  ),
                }
              : {}),
          }),
        );
        if (definition.name === "memory_search") {
          const retrieval = memoryRetrieval(result);
          if (retrieval !== null) {
            await options.onMemorySearch?.(retrieval);
          }
        }
        let finalResult =
          artifact === null && folded.foldedPassingLines === 0
            ? result
            : resultWithBoundedOutput(result, visibleOutput);
        if (
          isMutation &&
          target !== null &&
          outcome === "completed" &&
          after !== null &&
          after.exists
        ) {
          const diagnostics = diagnoseFileContent(
            target,
            after.bytes.toString("utf8"),
          );
          if (diagnostics.length > 0) {
            const summary = formatDiagnosticsSummary(label, diagnostics);
            finalResult = {
              ...finalResult,
              content: [
                ...(finalResult.content ?? []),
                { type: "text", text: `\n${summary}` },
              ],
            };
          }
        } else if (
          definition.name === "edit" &&
          outcome !== "completed" &&
          before !== null &&
          before.exists
        ) {
          const beforeText = before.bytes.toString("utf8");
          let searchText =
            typeof params["oldText"] === "string"
              ? params["oldText"]
              : typeof params["old_string"] === "string"
                ? params["old_string"]
                : "";
          if (searchText.length === 0) {
            const edits = extractEditReplacements(params);
            if (edits !== null && edits.length > 0) {
              const resultText =
                finalResult.content
                  ?.map((block) => (block.type === "text" ? block.text : ""))
                  .join("\n") ?? "";
              const indexMatch = /edits\[(\d+)\]/u.exec(resultText);
              const indexed =
                indexMatch !== null ? edits[Number(indexMatch[1])] : undefined;
              const missing =
                indexed ??
                edits.find((item) => !beforeText.includes(item.oldText)) ??
                edits[0];
              searchText = missing?.oldText ?? "";
            }
          }
          const hints =
            searchText.length > 0
              ? formatEditAnchorHints(beforeText, searchText)
              : null;
          if (hints !== null) {
            finalResult = {
              ...finalResult,
              content: [
                ...(finalResult.content ?? []),
                { type: "text", text: `\n${hints}` },
              ],
            };
          }
        }
        return finalResult;
      } finally {
        releaseMutation?.();
      }
    },
  };
}

export async function wrapToolDefinitions(
  definitions: readonly AnyToolDefinition[],
  options: ToolWrapOptions,
): Promise<AnyToolDefinition[]> {
  const wrapped: AnyToolDefinition[] = [];
  for (const definition of definitions) {
    wrapped.push(await wrapToolDefinition(definition, options));
  }
  return wrapped;
}
