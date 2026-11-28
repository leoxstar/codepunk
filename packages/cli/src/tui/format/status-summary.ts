import {
  isFallbackModel,
  permissionProfileFor,
  type CodepunkRuntime,
  type WorkspaceTrust,
} from "codepunk-core";
import { budgetSnapshot, formatBudgetSummary } from "./status.ts";
import {
  physicalModel,
  selectedModel,
  evidenceCount,
} from "../chrome/model.ts";

export function sessionSummary(runtime: CodepunkRuntime): string {
  const model = runtime.host.session.model;
  const usage = runtime.host.session.getContextUsage();
  const budget = budgetSnapshot(runtime);
  return [
    `session: ${runtime.session.sessionId}`,
    `model: ${model === undefined ? "not selected" : `${model.provider}/${model.id}`}`,
    `budget: ${formatBudgetSummary(budget)}`,
    `thinking: ${runtime.host.session.thinkingLevel}`,
    `context: ${
      usage === undefined || usage.tokens === null
        ? "unknown"
        : `${usage.tokens}/${usage.contextWindow} tokens${
            usage.percent === null ? "" : ` (${usage.percent.toFixed(1)}%)`
          }`
    }`,
    `run: ${runtime.host.currentRunId}`,
    `evidence: ${evidenceCount(runtime)} record(s)`,
    `sessions: ${runtime.paths.sessionsDir}`,
  ].join("\n");
}

export function formatStatusSummary(runtime: CodepunkRuntime): string {
  const model = physicalModel(runtime);
  const selected = selectedModel(runtime);
  const usage = runtime.host.session.getContextUsage();
  const totals = runtime.usage();
  const budget = budgetSnapshot(runtime);
  const profile = permissionProfileFor(runtime.config);
  const trust = runtime.workspaceTrust;
  return [
    "codepunk status",
    `project: ${runtime.paths.deliveryRoot}`,
    `cwd: ${runtime.paths.cwd}`,
    `session: ${runtime.session.sessionId} (run ${runtime.host.currentRunId})`,
    `model: ${
      model === undefined ? "not selected" : `${model.provider}/${model.id}`
    }${
      selected !== undefined && isFallbackModel(selected)
        ? " (fallback route)"
        : ""
    }`,
    `thinking: ${runtime.host.session.thinkingLevel}`,
    `context: ${
      usage === undefined || usage.tokens === null
        ? "unknown"
        : `${usage.tokens}/${usage.contextWindow} tokens${
            usage.percent === null ? "" : ` (${usage.percent.toFixed(1)}%)`
          }`
    }`,
    `permissions: ${profile} · approval ${runtime.config.approval.mode} · autonomy ${runtime.config.autonomy.profile}`,
    `sandbox: ${runtime.config.sandbox.mode} · filesystem ${runtime.config.filesystem.mode}`,
    `trust: ${trustDisplay(trust)} · ${trust.storePath}`,
    `capabilities: ${runtime.skills.length} skill(s) · ${runtime.mcpServers.length} MCP server(s) · plugins ${runtime.plugins.enabled ? "enabled" : "disabled"}`,
    `evidence: ${evidenceCount(runtime)} record(s) · head ${runtime.ledger.head ?? "none"}`,
    `usage: ${totals.total_tokens} tokens · $${totals.cost_total.toFixed(6)} · ${totals.calls} call(s)`,
    `budget: ${formatBudgetSummary(budget)}`,
    `config: ${runtime.paths.home}/config.toml`,
    `sessions: ${runtime.paths.sessionsDir}`,
  ].join("\n");
}

export function trustDisplay(trust: WorkspaceTrust): string {
  const allowed = trust.available.filter((kind) => trust.grants[kind]);
  const value =
    trust.mode === "all"
      ? "trusted"
      : trust.mode === "none"
        ? "untrusted"
        : allowed.length === 0
          ? "custom"
          : `custom (${allowed.join(", ")})`;
  if (trust.mode === "custom") {
    const scope =
      trust.source === "prompt" && trust.savedPath === null
        ? "session only"
        : trust.source === "flag"
          ? "one run"
          : trust.source === "saved" || trust.savedPath !== null
            ? "saved"
            : null;
    return scope === null ? value : `${value} · ${scope}`;
  }
  if (trust.source === "prompt" && trust.savedPath === null) {
    return `${value} (session only)`;
  }
  if (trust.source === "flag") {
    return `${value} (one run)`;
  }
  if (trust.source === "saved" || trust.savedPath !== null) {
    return `${value} (saved)`;
  }
  return value;
}
