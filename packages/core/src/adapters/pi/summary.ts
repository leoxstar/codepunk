import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { redactMemoryContent, type MemoryManager } from "../../memory/index.ts";
import { isFallbackModel } from "../../model/fallback.ts";
import { sha256Text } from "../../platform/hash.ts";
import type { SessionStore } from "../../session/index.ts";
import {
  isEmptySessionSummary,
  SESSION_SUMMARY_MAX_TOKENS,
  SESSION_SUMMARY_SYSTEM_PROMPT,
  summarizeProjection,
  trimSummaryBytes,
} from "./prompt.ts";
import type { CreatePiHostOptions } from "./types.ts";

export interface SessionSummarizerDeps {
  options: CreatePiHostOptions;
  store: SessionStore | null;
  getSession: () => AgentSession | null;
  getCurrentRunId: () => string;
  getLastDirectModel: () => string | null;
  getLastRoutedModel: () => string | null;
  appendEvent: (
    kind: Parameters<SessionStore["append"]>[0],
    data: unknown,
  ) => Promise<void>;
  syncSessionUsage: () => void;
  maybeExceedBudget: (runId: string) => Promise<void>;
}

export function createSessionSummarizer(
  deps: SessionSummarizerDeps,
): (
  trigger: "settled" | "compact",
  compactCheckpoint?: { summary: string; entryId: string },
) => Promise<void> {
  const summaryAttempts = new Set<string>();
  let summarizedRunId: string | null = null;

  return async (
    trigger: "settled" | "compact",
    compactCheckpoint?: { summary: string; entryId: string },
  ): Promise<void> => {
    const memory: MemoryManager | null = deps.options.memory ?? null;
    const session = deps.getSession();
    const store = deps.store;
    const currentRunId = deps.getCurrentRunId();
    if (
      deps.options.autoMemorySummary !== true ||
      memory === null ||
      !memory.enabled ||
      deps.options.mode === "worker" ||
      session === null ||
      store === null
    ) {
      return;
    }
    if (summarizedRunId === currentRunId) {
      return;
    }
    const source =
      compactCheckpoint === undefined
        ? summarizeProjection(session.sessionManager.buildSessionProjection())
        : {
            transcript: `[compactionSummary]\n${compactCheckpoint.summary}`,
            entryIds: [compactCheckpoint.entryId],
          };
    if (source === null) {
      return;
    }
    const routedReference =
      deps.getLastDirectModel() ?? deps.getLastRoutedModel();
    const routedModel = (() => {
      if (routedReference === null) {
        return undefined;
      }
      const separator = routedReference.indexOf("/");
      if (separator <= 0) {
        return undefined;
      }
      return session.modelRuntime.getModel(
        routedReference.slice(0, separator),
        routedReference.slice(separator + 1),
      );
    })();
    const model =
      routedModel ??
      (deps.options.model !== undefined && !isFallbackModel(deps.options.model)
        ? deps.options.model
        : undefined) ??
      (session.model !== undefined && !isFallbackModel(session.model)
        ? session.model
        : undefined);
    if (model === undefined) {
      return;
    }
    const firstEntry = source.entryIds[0]!;
    const lastEntry = source.entryIds.at(-1)!;
    const attemptSha = sha256Text(
      `${firstEntry}\0${lastEntry}\0${source.transcript}`,
    );
    if (summaryAttempts.has(attemptSha)) {
      return;
    }
    summarizedRunId = currentRunId;
    summaryAttempts.add(attemptSha);
    const sourceRefs = [
      `session:${store.sessionId}`,
      `session:${store.sessionId}:entries:${firstEntry}..${lastEntry}`,
      `run:${currentRunId}`,
    ];
    try {
      const response = await session.modelRuntime.completeSimple(
        model,
        {
          systemPrompt: SESSION_SUMMARY_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: [
                    `Summarize the ${trigger === "compact" ? "compacted" : "settled"} session for durable project memory.`,
                    "<session_transcript>",
                    source.transcript.replaceAll(
                      "</session_transcript>",
                      "&lt;/session_transcript>",
                    ),
                    "</session_transcript>",
                  ].join("\n"),
                },
              ],
              timestamp: Date.now(),
            },
          ],
        },
        {
          maxTokens: SESSION_SUMMARY_MAX_TOKENS,
          temperature: 0,
          cacheRetention: "none",
          disableContinuation: true,
          sessionId: store.sessionId,
        },
      );
      const summaryUsage = {
        provider: model.provider,
        model: model.id,
        input_tokens: Math.max(0, Math.trunc(response.usage.input)),
        output_tokens: Math.max(0, Math.trunc(response.usage.output)),
        cache_read_tokens: Math.max(0, Math.trunc(response.usage.cacheRead)),
        cache_write_tokens: Math.max(0, Math.trunc(response.usage.cacheWrite)),
        total_tokens: Math.max(0, Math.trunc(response.usage.totalTokens)),
        cost_total: Math.max(0, response.usage.cost?.total ?? 0),
        stop_reason: response.stopReason,
      };
      await deps.appendEvent("model/usage", {
        run_id: currentRunId,
        ...summaryUsage,
        source: "summary",
      });
      deps.syncSessionUsage();
      await deps.maybeExceedBudget(currentRunId);
      if (response.stopReason !== "stop") {
        throw new Error("summary model did not complete");
      }
      const summary = trimSummaryBytes(
        redactMemoryContent(
          response.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        ),
      );
      if (isEmptySessionSummary(summary)) {
        return;
      }
      const added = await memory.add({
        scope: "project",
        content: summary,
        kind: "session_summary",
        source: "session_summary",
        source_refs: sourceRefs,
        tags: ["session-summary"],
        importance: 0.4,
        durability: "project",
        status: "active",
      });
      await deps.appendEvent("memory/write", {
        scope: "project",
        action: added.ok ? "add" : "reject",
        memory_id: added.record?.id ?? null,
        content_sha256: added.record?.content_sha256 ?? null,
        source_refs: sourceRefs,
        reason: added.reason,
      });
    } catch {
      await deps
        .appendEvent("memory/write", {
          scope: "project",
          action: "reject",
          memory_id: null,
          content_sha256: null,
          source_refs: sourceRefs,
          reason: "summary_failed",
        })
        .catch(() => undefined);
    }
  };
}
