import type {
  AgentSession,
  AgentSettledEvent,
  BeforeAgentStartEvent,
  ContextEvent,
  ContextWithSystemEvent,
  ExtensionContext,
  ExtensionError,
  ExtensionFactory,
  InlineExtension,
  InputEvent,
  SessionBeforeCompactEvent,
  SessionBeforeTreeEvent,
  SessionCompactEvent,
  SessionCompactFailedEvent,
  SessionTreeEvent,
  UserBashEvent,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import type { AgentState } from "codepunk-protocol";
import { HookBlockedError } from "../../capabilities/hooks.ts";
import { expandPromptFileSlices } from "../../context/index.ts";
import { outputSha } from "../../evidence/index.ts";
import { isFallbackModel } from "../../model/fallback.ts";
import { modelUsageFromMessage } from "../../model/index.ts";
import { canonicalJson, createUlid, sha256Text } from "../../platform/hash.ts";
import { GoalCorruptError, goalModelContext } from "../../session/goal.ts";
import type { SessionStore, SessionWriter } from "../../session/index.ts";
import { normalizeSessionTitle } from "../../session/ops.ts";
import {
  readWorkState,
  type TodoState,
  type WorkState,
} from "../../work/index.ts";
import { wrapUserBashCommand, type ToolWrapOptions } from "../../wrap/index.ts";
import { PRODUCT_SYSTEM_SECTION } from "./prompt.ts";
import type { CreatePiHostOptions, ProductHookState } from "./types.ts";

export interface ProductExtensionDeps {
  options: CreatePiHostOptions;
  cwd: string;
  codepunkHome: string;
  store: SessionStore | null;
  productHookState: ProductHookState;
  currentRuntimeEnvironment: (() => string) | null;
  extensionFailures: ExtensionError[];
  assertNoExtensionFailures: () => void;
  getSession: () => AgentSession | null;
  getWriter: () => SessionWriter | null;
  getWrapOptions: () => ToolWrapOptions;
  getEventAppendTail: () => Promise<void>;
  getRetryEventTail: () => Promise<void>;
  getRetryEventFailure: () => unknown;
  appendEvent: (
    kind: Parameters<SessionStore["append"]>[0],
    data: unknown,
  ) => Promise<void>;
  beginRun: () => Promise<void>;
  endRun: (
    state?: "settled" | "failed" | "aborted" | "cancelled",
    termination?: string | null,
  ) => Promise<void>;
  saveHostAgentState: () => Promise<AgentState | null>;
  maybeSummarizeSession: (
    trigger: "settled" | "compact",
    compactCheckpoint?: { summary: string; entryId: string },
  ) => Promise<void>;
  syncSessionUsage: () => void;
  maybeExceedBudget: (runId: string) => Promise<void>;
  isBudgetExceeded: () => boolean;
  budgetExceededMessage: () => string;
  getCurrentRunId: () => string;
  getInputRecorded: () => boolean;
  setInputRecorded: (value: boolean) => void;
  getLastMemoryDigestSha: () => string | null;
  setLastMemoryDigestSha: (value: string | null) => void;
  getLastAssistantStopReason: () => string | null;
  setLastAssistantStopReason: (value: string | null) => void;
  getBeforeStopAttempt: () => number;
  setBeforeStopAttempt: (value: number) => void;
  getBeforeStopBlockedReason: () => string | null;
  setBeforeStopBlockedReason: (value: string | null) => void;
  getLastDirectModel: () => string | null;
  setLastDirectModel: (value: string | null) => void;
  getLastRoutedModel: () => string | null;
}

export function createProductExtension(
  deps: ProductExtensionDeps,
): InlineExtension {
  let lastWorkState: { plan: WorkState | null; todos: TodoState | null } = {
    plan: null,
    todos: null,
  };
  let pendingCompactionMessages: number | null = null;
  let sessionTitleSet = false;
  let pendingTreeTarget: string | null = null;

  return {
    name: "codepunk-product",
    hidden: true,
    factory: ((pi) => {
      const refreshWorkState = async (): Promise<void> => {
        if (deps.store === null) {
          return;
        }
        await deps.getEventAppendTail();
        lastWorkState = readWorkState(deps.store.allEvents);
      };
      const renderWorkState = (): string | null => {
        const sections: string[] = [];
        if (
          lastWorkState.plan !== null &&
          lastWorkState.plan.steps.length > 0
        ) {
          sections.push(
            [
              `<codepunk_plan sha256="${lastWorkState.plan.sha256}">`,
              ...lastWorkState.plan.steps.map(
                (step) => `${step.status}: ${step.step}`,
              ),
              ...(lastWorkState.plan.explanation === null
                ? []
                : [`note: ${lastWorkState.plan.explanation}`]),
              "</codepunk_plan>",
            ].join("\n"),
          );
        }
        if (
          lastWorkState.todos !== null &&
          lastWorkState.todos.items.length > 0
        ) {
          sections.push(
            [
              `<codepunk_todos sha256="${lastWorkState.todos.sha256}">`,
              ...lastWorkState.todos.items.map(
                (item) => `${item.status}: ${item.content}`,
              ),
              "</codepunk_todos>",
            ].join("\n"),
          );
        }
        return sections.length === 0 ? null : sections.join("\n\n");
      };
      const recordContextRequest = async (
        messages: ContextEvent["messages"],
        extensionContext: ExtensionContext,
      ): Promise<void> => {
        const session = deps.getSession();
        if (deps.store === null || session === null) {
          return;
        }
        const entries = session.sessionManager.getEntries();
        const messageEntries: {
          id: string;
          message: ContextEvent["messages"][number];
        }[] = [];
        let compactionId: string | null = null;
        for (const entry of entries) {
          if (entry.type === "message") {
            const role = (entry.message as { role?: unknown }).role;
            if (
              role !== "user" &&
              role !== "assistant" &&
              role !== "toolResult"
            ) {
              continue;
            }
            messageEntries.push(
              entry as unknown as {
                id: string;
                message: ContextEvent["messages"][number];
              },
            );
          } else if (entry.type === "compaction") {
            compactionId = entry.id;
          }
        }
        const usedEntryIds = new Set<string>();
        const messageIds: string[] = [];
        for (const message of messages) {
          const byObject = messageEntries.find(
            (entry) => entry.message === message && !usedEntryIds.has(entry.id),
          );
          const byTimestamp =
            byObject ??
            messageEntries.find(
              (entry) =>
                !usedEntryIds.has(entry.id) &&
                entry.message.role === message.role &&
                entry.message.timestamp === message.timestamp,
            );
          if (byTimestamp !== undefined) {
            usedEntryIds.add(byTimestamp.id);
            messageIds.push(byTimestamp.id);
            continue;
          }
          messageIds.push(
            `msg-${sha256Text(canonicalJson(message)).slice(7, 23)}`,
          );
        }
        const omittedIds: string[] = [];
        const ranges: { start: number; end: number }[] = [];
        let rangeStart: number | null = null;
        messageEntries.forEach((entry, index) => {
          if (usedEntryIds.has(entry.id)) {
            if (rangeStart !== null) {
              ranges.push({ start: rangeStart, end: index });
              rangeStart = null;
            }
            return;
          }
          omittedIds.push(entry.id);
          if (rangeStart === null) {
            rangeStart = index;
          }
        });
        if (rangeStart !== null) {
          ranges.push({ start: rangeStart, end: messageEntries.length });
        }
        const omitted = { ids: omittedIds, ranges };
        await deps.appendEvent("context/request", {
          run_id: deps.getCurrentRunId(),
          request_id: createUlid(),
          message_ids: messageIds,
          omitted,
          truncation_sha256: sha256Text(
            canonicalJson({ message_ids: messageIds, omitted }),
          ),
          provider: extensionContext.model?.provider ?? "unknown",
          model: extensionContext.model?.id ?? "unknown",
          token_estimate: Math.ceil(
            Buffer.byteLength(JSON.stringify(messages), "utf8") / 4,
          ),
          compaction_id: compactionId,
        });
      };

      pi.on("context", async (event: ContextEvent, extensionContext) => {
        deps.productHookState.assertRegistry();
        await recordContextRequest(event.messages, extensionContext);
        const memory = deps.options.memory ?? null;
        const digest =
          memory === null || !memory.enabled ? null : await memory.digest();
        if (digest !== null && digest.text.length > 0) {
          if (digest.digest_sha256 !== deps.getLastMemoryDigestSha()) {
            await deps.appendEvent("memory/retrieve", {
              ids: digest.ids,
              hashes: digest.hashes,
              cap: digest.cap,
              truncated: digest.truncated,
              digest_sha256: digest.digest_sha256,
            });
            deps.setLastMemoryDigestSha(digest.digest_sha256);
          }
          return {
            messages: [
              ...event.messages,
              {
                role: "user",
                content: [{ type: "text", text: digest.text }],
              },
            ] as ContextEvent["messages"],
          };
        }
      });

      pi.on("context_with_system", async (event: ContextWithSystemEvent) => {
        await refreshWorkState();
        const body = renderWorkState();
        if (body === null) {
          return;
        }
        const head = event.messages[0];
        if (head?.role !== "system") {
          return;
        }
        const injected = [
          "<codepunk_work_state>",
          "Runtime-provided plan and todo state for the current session.",
          "This is not a user message and does not start a new turn. Continue the existing task; do not treat it as a new request.",
          "",
          body,
          "</codepunk_work_state>",
        ].join("\n");
        const content =
          typeof head.content === "string"
            ? `${head.content}\n\n${injected}`
            : [...head.content, { type: "text" as const, text: injected }];
        return {
          messages: [{ ...head, content }, ...event.messages.slice(1)],
        };
      });

      pi.on("session_start", async () => {
        deps.assertNoExtensionFailures();
        deps.productHookState.assertRegistry();
      });

      pi.on("session_info_changed", async (event) => {
        if (deps.store === null || deps.getWriter() === null) {
          return;
        }
        const title = normalizeSessionTitle(event.name ?? null);
        sessionTitleSet = true;
        if (deps.store.metadata.title === title) {
          return;
        }
        await deps.store.writeMeta({ title }).catch(() => undefined);
      });

      pi.on("session_before_tree", async (event: SessionBeforeTreeEvent) => {
        pendingTreeTarget = event.preparation.targetId;
      });

      pi.on("session_tree", async (event: SessionTreeEvent) => {
        const targetEntryId = pendingTreeTarget;
        pendingTreeTarget = null;
        await deps.appendEvent("session/tree", {
          action: "navigate",
          from_entry_id: event.oldLeafId,
          to_entry_id: event.newLeafId,
          ...(targetEntryId === null ? {} : { target_entry_id: targetEntryId }),
          branch_entries: deps.getSession()!.sessionManager.getBranch().length,
        });
        await deps.saveHostAgentState();
      });

      pi.on("model_select", async (event) => {
        await deps.appendEvent("model/change", {
          previous:
            event.previousModel === undefined
              ? null
              : `${event.previousModel.provider}/${event.previousModel.id}`,
          model: `${event.model.provider}/${event.model.id}`,
          thinking: deps.productHookState.session?.thinkingLevel ?? null,
        });
      });

      pi.on("message_end", async (event) => {
        const currentRunId = deps.getCurrentRunId();
        if (event.message.role === "assistant") {
          deps.setLastAssistantStopReason(event.message.stopReason);
          const usage = modelUsageFromMessage(event);
          if (usage !== null) {
            await deps.appendEvent("model/usage", {
              run_id: currentRunId,
              ...usage,
              source: "assistant",
            });
          }
        }
        deps.syncSessionUsage();
        await deps.maybeExceedBudget(currentRunId);
      });

      pi.on("session_compact", async () => {
        deps.syncSessionUsage();
        await deps.maybeExceedBudget(deps.getCurrentRunId());
      });

      pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
        deps.assertNoExtensionFailures();
        deps.productHookState.assertRegistry();
        event.systemPromptOptions.sections["product"] = PRODUCT_SYSTEM_SECTION;
        let goalContext: string | null = null;
        if (deps.store !== null) {
          try {
            goalContext = goalModelContext(deps.store.allEvents);
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            await deps.store
              .append("goal/error", {
                version: 1,
                code: "goal.corrupt",
                reason: reason.slice(0, 2_000),
                created_at: new Date().toISOString(),
              })
              .catch(() => undefined);
            throw new GoalCorruptError(
              `goal state could not be injected; the prompt was blocked: ${reason}`,
              { cause: error },
            );
          }
        }
        if (goalContext === null) {
          delete event.systemPromptOptions.sections["goal"];
        } else {
          event.systemPromptOptions.sections["goal"] = goalContext;
        }
        if (deps.currentRuntimeEnvironment !== null) {
          event.systemPromptOptions.sections["environment"] =
            deps.currentRuntimeEnvironment();
        }
        await deps.beginRun();
        if (event.messageType === "user" && !deps.getInputRecorded()) {
          await deps.appendEvent("user/input", {
            run_id: deps.getCurrentRunId(),
            text: event.prompt,
          });
          deps.setInputRecorded(true);
        }
      });

      pi.on("input", async (event: InputEvent, context) => {
        if (deps.extensionFailures.length > 0) {
          const first = deps.extensionFailures[0]!;
          context.ui.notify(
            `codepunk blocked the prompt: product extension handler ${first.event} failed: ${first.error}`,
            "error",
          );
          return { action: "handled" as const };
        }
        if (deps.store !== null) {
          try {
            goalModelContext(deps.store.allEvents);
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            await deps.appendEvent("goal/error", {
              version: 1,
              code: "goal.corrupt",
              reason: reason.slice(0, 2_000),
              created_at: new Date().toISOString(),
            });
            context.ui.notify(
              `codepunk blocked the prompt: goal state is corrupt: ${reason}`,
              "error",
            );
            return { action: "handled" as const };
          }
        }
        if (deps.isBudgetExceeded()) {
          context.ui.notify(deps.budgetExceededMessage(), "error");
          return { action: "handled" as const };
        }
        await deps.beginRun();
        await deps.appendEvent("user/input", {
          run_id: deps.getCurrentRunId(),
          text: event.text,
        });
        if (
          !sessionTitleSet &&
          deps.store !== null &&
          deps.store.metadata.title === null
        ) {
          const title = normalizeSessionTitle(event.text);
          if (title !== null) {
            await deps.store.writeMeta({ title }).catch(() => undefined);
          }
        }
        sessionTitleSet = true;
        deps.setInputRecorded(true);
        const expanded = await expandPromptFileSlices(event.text, {
          cwd: deps.cwd,
          workspaceRoot: deps.options.workspaceRoot,
          deliveryRoot: deps.options.deliveryRoot,
          ...(deps.options.additionalRoots !== undefined
            ? { additionalRoots: deps.options.additionalRoots }
            : {}),
          codepunkHome: deps.codepunkHome,
          ...(deps.options.filesystem !== undefined
            ? { filesystem: deps.options.filesystem }
            : {}),
        });
        for (const warning of expanded.warnings) {
          context.ui.notify(warning, "warning");
        }
        if (expanded.slices.length > 0) {
          return { action: "transform" as const, text: expanded.text };
        }
        return { action: "continue" as const };
      });

      pi.on("tool_call", async () => {
        deps.productHookState.assertRegistry();
        if (deps.isBudgetExceeded()) {
          return {
            block: true,
            terminate: true,
            reason: deps.budgetExceededMessage(),
          };
        }
        return undefined;
      });

      pi.on("agent_start", async () => {
        await deps.beginRun();
      });

      pi.on("agent_before_settle", async (event) => {
        if (
          deps.options.beforeStopHook === undefined ||
          event.outcome !== "completed" ||
          deps.isBudgetExceeded()
        ) {
          return undefined;
        }
        try {
          await deps.options.beforeStopHook({
            run_id: deps.getCurrentRunId(),
            session_id: deps.options.sessionId,
            cwd: deps.cwd,
            attempt: deps.getBeforeStopAttempt() + 1,
          });
          deps.setBeforeStopBlockedReason(null);
          return undefined;
        } catch (error) {
          const nextAttempt = deps.getBeforeStopAttempt() + 1;
          deps.setBeforeStopAttempt(nextAttempt);
          const maxRetries = deps.options.maxBeforeStopRetries ?? 2;
          const reason = error instanceof Error ? error.message : String(error);
          const preview =
            error instanceof HookBlockedError ? error.preview : null;
          if (nextAttempt <= maxRetries) {
            const feedback = [
              `[before_stop hook blocked completion (attempt ${nextAttempt}/${maxRetries})]: ${reason}`,
              ...(preview !== null ? [preview] : []),
              "Resolve the verification failure before finishing.",
            ].join("\n");
            return {
              entries: [
                ...event.entries,
                {
                  type: "custom_message" as const,
                  customType: "codepunk:before_stop",
                  content: [{ type: "text" as const, text: feedback }],
                  display: true,
                },
              ],
              continue: true,
            };
          }
          deps.setBeforeStopBlockedReason(reason);
          return undefined;
        }
      });

      pi.on("agent_settled", async (event: AgentSettledEvent) => {
        await deps.getRetryEventTail();
        const retryFailure = deps.getRetryEventFailure();
        const blockedReason = deps.getBeforeStopBlockedReason();
        const state = event.aborted
          ? "aborted"
          : deps.getLastAssistantStopReason() === "error" ||
              blockedReason !== null
            ? "failed"
            : "settled";
        await deps.endRun(
          state,
          blockedReason !== null ? "before_stop_blocked" : null,
        );
        if (state === "settled") {
          await deps.maybeSummarizeSession("settled");
        }
        await deps.saveHostAgentState();
        if (retryFailure !== null) {
          throw new Error(
            `cannot record automatic retry evidence: ${
              retryFailure instanceof Error
                ? retryFailure.message
                : String(retryFailure)
            }`,
          );
        }
      });

      pi.on("user_bash", async (event: UserBashEvent) => {
        await deps.beginRun();
        const userBashRunId = deps.getCurrentRunId();
        const toolCallId = `user-bash-${createUlid()}`;
        const result = await wrapUserBashCommand(event.command, toolCallId, {
          ...deps.getWrapOptions(),
          cwd: event.cwd,
          mode: "interactive",
          onUserBashResult: async (completed) => {
            await deps.appendEvent("bash/result", {
              run_id: userBashRunId,
              command: completed.command,
              exit_code: completed.exitCode,
              output_sha256: outputSha(completed.output),
              cancelled: completed.cancelled,
            });
            await deps.endRun(
              completed.cancelled
                ? "cancelled"
                : completed.exitCode === 0
                  ? "settled"
                  : "failed",
              completed.timedOut ? "user_bash_timed_out" : null,
            );
          },
          onUserBashFailure: async () => {
            await deps.endRun("failed", "user_bash_execution_error");
          },
        });
        if ("result" in result && result.result !== undefined) {
          await deps.endRun("failed", "user_bash_denied");
        }
        return result satisfies UserBashEventResult;
      });

      pi.on(
        "session_before_compact",
        async (event: SessionBeforeCompactEvent) => {
          pendingCompactionMessages =
            event.preparation.messagesToSummarize.length +
            event.preparation.turnPrefixMessages.length;
        },
      );

      pi.on("session_compact", async (event: SessionCompactEvent) => {
        const session = deps.getSession()!;
        const checkpointEntry = event.compactionEntry;
        const checkpointSource = session.sessionManager.getBranch();
        const firstSummarizedIndex = checkpointSource.findIndex(
          (entry) => entry.id === checkpointEntry.firstKeptEntryId,
        );
        const messagesAfter =
          session.sessionManager.buildSessionProjection().messages.length;
        const messagesBefore =
          pendingCompactionMessages ??
          checkpointSource
            .slice(
              0,
              firstSummarizedIndex < 0
                ? checkpointSource.length
                : firstSummarizedIndex,
            )
            .filter((entry) => entry.type === "message").length;
        const activeModel = session.model;
        const activeReference =
          activeModel === undefined
            ? null
            : `${activeModel.provider}/${activeModel.id}`;
        const checkpointModel =
          activeModel !== undefined && !isFallbackModel(activeModel)
            ? activeReference
            : (deps.getLastDirectModel() ??
              deps.getLastRoutedModel() ??
              activeReference);
        const checkpointUsage =
          checkpointEntry.usage === undefined
            ? null
            : {
                input_tokens: checkpointEntry.usage.input,
                output_tokens: checkpointEntry.usage.output,
                cache_read_tokens: checkpointEntry.usage.cacheRead,
                cache_write_tokens: checkpointEntry.usage.cacheWrite,
                total_tokens: checkpointEntry.usage.totalTokens,
                cost_total:
                  Math.round(checkpointEntry.usage.cost.total * 1_000_000) /
                  1_000_000,
              };
        await deps.appendEvent("compaction/decision", {
          run_id: deps.getCurrentRunId(),
          reason: event.reason,
          cancelled: false,
          entries: 1,
          keep_recent_tokens:
            deps.options.settings?.compaction?.keepRecentTokens ?? 0,
          evidence_head: deps.options.ledger.head,
          checkpoint: {
            compaction_entry_id: checkpointEntry.id,
            first_kept_entry_id: checkpointEntry.firstKeptEntryId,
            summary_sha256: sha256Text(checkpointEntry.summary),
            summary_bytes: Buffer.byteLength(checkpointEntry.summary, "utf8"),
            tokens_before: checkpointEntry.tokensBefore,
            messages_before: messagesBefore,
            messages_after: messagesAfter,
            model: checkpointModel,
            loadout_sha256:
              checkpointEntry.systemMessage === undefined
                ? null
                : sha256Text(JSON.stringify(checkpointEntry.systemMessage)),
            tool_names: [...session.getActiveToolNames()].sort(),
            ...(checkpointUsage === null ? {} : { usage: checkpointUsage }),
          },
        });
        pendingCompactionMessages = null;
        deps.setLastDirectModel(null);
        await deps.saveHostAgentState();
        await deps.maybeSummarizeSession("compact", {
          summary: checkpointEntry.summary,
          entryId: checkpointEntry.id,
        });
      });

      pi.on(
        "session_compact_failed",
        async (event: SessionCompactFailedEvent) => {
          await deps.appendEvent("compaction/decision", {
            run_id: deps.getCurrentRunId(),
            reason: event.reason,
            cancelled: true,
            entries: 0,
            keep_recent_tokens:
              deps.options.settings?.compaction?.keepRecentTokens ?? 0,
            evidence_head: deps.options.ledger.head,
            ...(event.errorMessage === undefined
              ? {}
              : { failure: event.errorMessage }),
          });
          pendingCompactionMessages = null;
        },
      );
    }) as ExtensionFactory,
  };
}
