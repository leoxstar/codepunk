import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  isFallbackModel,
  permissionProfileFor,
  type CodepunkRuntime,
} from "codepunk-core";
import { renderStatusline } from "../../statusline.ts";
import { budgetSnapshot, formatBudgetStatus } from "../format/status.ts";
import { trustDisplay } from "../format/trust.ts";
import type { TuiState } from "../state.ts";
import { evidenceCount, physicalModel, selectedModel } from "./model.ts";
import { currentShellStatus } from "./status.ts";

function lastRoutedModel(runtime: CodepunkRuntime): string | undefined {
  for (
    let index = runtime.host.session.messages.length - 1;
    index >= 0;
    index--
  ) {
    const message = runtime.host.session.messages[index]!;
    if (
      message.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted"
    ) {
      return `${message.provider}/${message.model}`;
    }
  }
  return undefined;
}

function modelStatus(runtime: CodepunkRuntime): string {
  const selected = selectedModel(runtime);
  if (selected === undefined) {
    return `${runtime.config.model.provider ?? "auto"}/${runtime.config.model.id ?? "auto"}`;
  }
  if (isFallbackModel(selected)) {
    const primary = physicalModel(runtime);
    const primaryReference =
      primary === undefined ? "unrouted" : `${primary.provider}/${primary.id}`;
    const routed = lastRoutedModel(runtime);
    return `auto -> ${primaryReference}${
      routed !== undefined && routed !== primaryReference
        ? ` (last ${routed})`
        : ""
    }`;
  }
  return `${selected.provider}/${selected.id}`;
}

function agentStatus(state: TuiState): string | null {
  const records = [...(state.subagents?.values() ?? [])];
  if (records.length === 0) {
    return null;
  }
  const running = records.filter(
    (record) => record.status === "running",
  ).length;
  return `agents ${running}/${records.length}`;
}

export function renderHeader(state: TuiState): string {
  const runtime = state.runtime;
  if (runtime === null) {
    return "codepunk · starting";
  }
  return `codepunk · ${modelStatus(runtime)} · session ${runtime.session.sessionId.slice(0, 12)} · Alt+M mode · Alt+T tasks · F1 help`;
}

export function renderStatus(state: TuiState): string {
  const runtime = state.runtime;
  if (runtime === null) {
    return "starting";
  }
  const profile = permissionProfileFor(runtime.config);
  const budget = budgetSnapshot(runtime);
  const budgetText =
    budget.maxTokens === null && budget.maxCostUsd === null
      ? ""
      : formatBudgetStatus(budget);
  const agents = agentStatus(state);
  const planMode = runtime.planMode.state();
  const planBadge =
    planMode?.mode === "planning"
      ? "plan"
      : planMode?.mode === "executing"
        ? "plan:exec"
        : null;
  const mcpBadge = runtime.mcpStatus === "connecting" ? "mcp connecting" : null;
  const policy = [
    ...(planBadge === null ? [] : [planBadge]),
    `permissions ${profile}`,
    `trust ${trustDisplay(runtime.workspaceTrust)}`,
    `shell ${currentShellStatus(runtime)}`,
    `evidence ${evidenceCount(runtime)}`,
    ...(mcpBadge === null ? [] : [mcpBadge]),
    ...(agents === null ? [] : [agents]),
  ].join(" · ");
  return renderStatusline(runtime.config.tui.statusline, {
    model: modelStatus(runtime),
    session: `session ${runtime.session.sessionId.slice(0, 12)}`,
    sandbox: `sandbox ${runtime.config.sandbox.mode}`,
    filesystem: `fs ${runtime.config.filesystem.mode}`,
    policy,
    budget: budgetText,
  });
}

/**
 * Rewrite the single footer status line from the current TUI state.
 * Callers use this after model, shell, evidence, or agent changes instead of
 * publishing one status key per subsystem.
 */
export function refreshStatus(
  state: TuiState,
  context: ExtensionContext,
): void {
  const runtime = state.runtime;
  context.ui.setStatus(
    "codepunk",
    runtime?.config.tui.status === true ? renderStatus(state) : undefined,
  );
}
