import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import type { SessionEvent } from "codepunk-protocol";

export interface ModelUsageRecord {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_total: number;
  stop_reason: string;
}

export interface ModelUsageSummary {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_total: number;
}

/**
 * Token counters reported by Pi for persisted session entries.
 *
 * Pi counts assistant messages and compaction entries. It cannot see calls
 * Codepunk makes directly through the model runtime, such as the durable
 * memory summary.
 */
export interface SessionUsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export function usageCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function cost(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

export function modelUsageFromMessage(
  event: MessageEndEvent,
): ModelUsageRecord | null {
  const message = event.message;
  if (message.role !== "assistant") {
    return null;
  }
  const usage = message.usage;
  if (usage === undefined || usage === null) {
    return null;
  }
  return {
    provider: message.provider,
    model: message.model,
    input_tokens: usageCount(usage.input),
    output_tokens: usageCount(usage.output),
    cache_read_tokens: usageCount(usage.cacheRead),
    cache_write_tokens: usageCount(usage.cacheWrite),
    total_tokens: usageCount(usage.totalTokens),
    cost_total: cost(usage.cost?.total),
    stop_reason: message.stopReason,
  };
}

export function summarizeModelUsage(
  events: readonly SessionEvent[],
): ModelUsageSummary {
  const summary: ModelUsageSummary = {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
    cost_total: 0,
  };
  for (const event of events) {
    if (event.kind === "compaction/decision") {
      const usage = event.data.checkpoint?.usage;
      if (usage === undefined) {
        continue;
      }
      summary.calls += 1;
      summary.input_tokens += usage.input_tokens;
      summary.output_tokens += usage.output_tokens;
      summary.cache_read_tokens += usage.cache_read_tokens;
      summary.cache_write_tokens += usage.cache_write_tokens;
      summary.total_tokens += usage.total_tokens;
      summary.cost_total += usage.cost_total;
      continue;
    }
    if (event.kind !== "model/usage") {
      continue;
    }
    summary.calls += 1;
    summary.input_tokens += event.data.input_tokens;
    summary.output_tokens += event.data.output_tokens;
    summary.cache_read_tokens += event.data.cache_read_tokens;
    summary.cache_write_tokens += event.data.cache_write_tokens;
    summary.total_tokens += event.data.total_tokens;
    summary.cost_total += event.data.cost_total;
  }
  summary.cost_total = Math.round(summary.cost_total * 1_000_000) / 1_000_000;
  return summary;
}

export function summarizeModelUsageBySource(
  events: readonly SessionEvent[],
  source: "assistant" | "summary",
): ModelUsageSummary {
  const summary: ModelUsageSummary = {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
    cost_total: 0,
  };
  for (const event of events) {
    if (event.kind !== "model/usage" || event.data.source !== source) {
      continue;
    }
    summary.calls += 1;
    summary.input_tokens += event.data.input_tokens;
    summary.output_tokens += event.data.output_tokens;
    summary.cache_read_tokens += event.data.cache_read_tokens;
    summary.cache_write_tokens += event.data.cache_write_tokens;
    summary.total_tokens += event.data.total_tokens;
    summary.cost_total += event.data.cost_total;
  }
  summary.cost_total = Math.round(summary.cost_total * 1_000_000) / 1_000_000;
  return summary;
}

/**
 * Combine Pi session statistics with supplemental model calls.
 *
 * Session totals and recorded events describe overlapping sets, so take the
 * larger of the two, then add direct-call usage that Pi never persisted.
 * A plain `Math.max(recorded, sessionStats)` hides summary calls as soon as
 * either side grows past the sum that previously included them.
 */
export function summarizeSessionModelUsage(
  events: readonly SessionEvent[],
  stats: SessionUsageStats,
): ModelUsageSummary {
  const recorded = summarizeModelUsage(events);
  const direct = summarizeModelUsageBySource(events, "summary");
  const sessionTotals = {
    input_tokens: Math.max(0, recorded.input_tokens - direct.input_tokens),
    output_tokens: Math.max(0, recorded.output_tokens - direct.output_tokens),
    cache_read_tokens: Math.max(
      0,
      recorded.cache_read_tokens - direct.cache_read_tokens,
    ),
    cache_write_tokens: Math.max(
      0,
      recorded.cache_write_tokens - direct.cache_write_tokens,
    ),
    total_tokens: Math.max(0, recorded.total_tokens - direct.total_tokens),
    cost_total: Math.max(0, recorded.cost_total - direct.cost_total),
  };
  return {
    calls: recorded.calls,
    input_tokens:
      Math.max(sessionTotals.input_tokens, stats.input) + direct.input_tokens,
    output_tokens:
      Math.max(sessionTotals.output_tokens, stats.output) +
      direct.output_tokens,
    cache_read_tokens:
      Math.max(sessionTotals.cache_read_tokens, stats.cacheRead) +
      direct.cache_read_tokens,
    cache_write_tokens:
      Math.max(sessionTotals.cache_write_tokens, stats.cacheWrite) +
      direct.cache_write_tokens,
    total_tokens:
      Math.max(sessionTotals.total_tokens, stats.total) + direct.total_tokens,
    cost_total:
      Math.round(
        (Math.max(sessionTotals.cost_total, stats.cost) + direct.cost_total) *
          1_000_000,
      ) / 1_000_000,
  };
}
