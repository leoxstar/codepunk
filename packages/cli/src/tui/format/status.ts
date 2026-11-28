import type { CodepunkRuntime, WorkspaceTrust } from "codepunk-core";
import {
  isFallbackModel,
  permissionBehaviorSummary,
  permissionProfileFor,
} from "codepunk-core";
import type { BudgetExceededEvent } from "codepunk-protocol";
import {
  evidenceCount,
  physicalModel,
  selectedModel,
} from "../chrome/model.ts";
import { currentShellStatus } from "../chrome/status.ts";
import { permissionUsage } from "./permissions.ts";

export function permissionSummary(runtime: CodepunkRuntime): string {
  const shell = currentShellStatus(runtime);
  const approval = {
    ask: "ask before actions outside safe read-only classes",
    deny: "deny actions that would otherwise ask",
    auto: "auto-approve routine and ordinary shell actions; destructive, explicit-policy, protected, sensitive, and MCP actions still ask",
    allow: "auto-approve sandbox-covered asks; MCP calls still require a human",
  }[runtime.config.approval.mode];
  const profile = permissionProfileFor(runtime.config);
  return [
    "Permissions",
    `profile: ${profile}`,
    `workspace trust: ${trustDisplay(runtime.workspaceTrust)} (${runtime.workspaceTrust.source})`,
    `trust root: ${runtime.workspaceTrust.root}`,
    `approvals: ${runtime.config.approval.mode} (${approval})`,
    ...(runtime.workspaceTrust.trusted
      ? []
      : [
          "approvals beyond this call: unavailable in an untrusted workspace; run /trust grant and restart",
        ]),
    ...(runtime.config.approval.reviewer === "off"
      ? []
      : [
          `approval reviewer: ${runtime.config.approval.reviewer} (${runtime.config.approval.reviewer_model ?? "session model"}, ${runtime.config.approval.reviewer_timeout_ms} ms)`,
        ]),
    `autonomy: ${runtime.autonomy.profile}`,
    `behavior: ${permissionBehaviorSummary(runtime.config)}`,
    `current shell: ${shell}`,
    `next session sandbox: ${runtime.config.sandbox.mode}`,
    `next session network: ${
      runtime.config.sandbox.network_allow.length === 0
        ? "deny by default"
        : runtime.config.sandbox.network_allow.join(", ")
    }`,
    ...(runtime.config.sandbox.network_deny.length === 0
      ? []
      : [
          `next session network deny: ${runtime.config.sandbox.network_deny.join(", ")}`,
        ]),
    `next session filesystem: ${runtime.config.filesystem.mode}`,
    ...(runtime.paths.additionalRoots.length === 0
      ? []
      : [`extra file roots: ${runtime.paths.additionalRoots.join(", ")}`]),
    "safe reads: date, identity, and workspace inspection run without approval",
    `config: ${runtime.paths.home}/config.toml`,
    "",
    "Profiles: read-only · standard · auto · auto-approve · full-access · custom",
    "",
    permissionUsage(),
  ].join("\n");
}

export { formatMcpReload } from "./mcp.ts";
export { formatSkillReload, formatPluginReload } from "./reload.ts";

export interface BudgetSnapshot {
  maxTokens: number | null;
  maxCostUsd: number | null;
  usedTokens: number;
  usedCostUsd: number;
  stopped: boolean;
}

/**
 * The active budget is the one bound into the Pi host at session start.
 * `reloadConfig()` deliberately leaves `config.budget` unchanged because a new
 * limit only applies to the next session; the last exceeded event is the
 * authoritative record once the guard has fired.
 */
export function budgetSnapshot(runtime: CodepunkRuntime): BudgetSnapshot {
  let exceeded: BudgetExceededEvent | null = null;
  for (const event of runtime.session.allEvents) {
    if (event.kind === "budget/exceeded") {
      exceeded = event;
    }
  }
  const totals = runtime.usage();
  return {
    maxTokens: runtime.config.budget.max_tokens,
    maxCostUsd: runtime.config.budget.max_cost_usd,
    usedTokens: totals.total_tokens,
    usedCostUsd: totals.cost_total,
    stopped: exceeded !== null,
  };
}

export function formatBudgetCost(value: number): string {
  const fixed = value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
  return `$${fixed.length === 0 ? "0" : fixed}`;
}

export function formatBudgetUsage(budget: BudgetSnapshot): string {
  const parts: string[] = [];
  if (budget.maxTokens !== null) {
    parts.push(`${budget.usedTokens}/${budget.maxTokens} tokens`);
  }
  if (budget.maxCostUsd !== null) {
    parts.push(
      `${formatBudgetCost(budget.usedCostUsd)}/${formatBudgetCost(
        budget.maxCostUsd,
      )}`,
    );
  }
  return parts.join(" \u00b7 ");
}

export function formatBudgetSummary(budget: BudgetSnapshot): string {
  if (budget.maxTokens === null && budget.maxCostUsd === null) {
    return "off";
  }
  return budget.stopped
    ? `stopped at ${formatBudgetUsage(budget)}; start a new session with /new`
    : `within ${formatBudgetUsage(budget)}`;
}

export function formatBudgetStatus(budget: BudgetSnapshot): string {
  if (budget.maxTokens === null && budget.maxCostUsd === null) {
    return "budget off";
  }
  return budget.stopped
    ? `budget stopped at ${formatBudgetUsage(budget)}`
    : `budget ${formatBudgetUsage(budget)}`;
}

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
