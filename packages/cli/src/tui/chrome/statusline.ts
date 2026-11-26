import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  isFallbackModel,
  permissionProfileFor,
  type CodepunkRuntime,
} from "codepunk-core";
import { renderStatusline } from "../../statusline.ts";
import type { PanelColor, PanelTheme } from "../components/frame.ts";
import { budgetSnapshot, formatBudgetStatus } from "../format/status.ts";
import { trustDisplay } from "../format/trust.ts";
import type { TuiState } from "../state.ts";
import { evidenceCount, physicalModel, selectedModel } from "./model.ts";
import { currentShellStatus } from "./status.ts";

export interface StatusRenderOptions {
  readonly theme?: PanelTheme | undefined;
  readonly width?: number | undefined;
}

export function resolveLiveTheme(
  candidate: PanelTheme | undefined,
): PanelTheme | undefined {
  if (candidate === undefined) {
    return undefined;
  }
  try {
    const fg = candidate.fg;
    const bold = candidate.bold;
    return typeof fg === "function" && typeof bold === "function"
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function paint(
  theme: PanelTheme | undefined,
  color: PanelColor,
  text: string,
  bold = false,
): string {
  const live = resolveLiveTheme(theme);
  if (live === undefined) {
    return text;
  }
  const styled = live.fg(color, text);
  return bold ? live.bold(styled) : styled;
}

function sep(theme: PanelTheme | undefined): string {
  return paint(theme, "muted", " · ");
}

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

function agentStatus(state: TuiState, theme?: PanelTheme): string | null {
  const records = [...(state.subagents?.values() ?? [])];
  if (records.length === 0) {
    return null;
  }
  const running = records.filter(
    (record) => record.status === "running",
  ).length;
  const label = `agents ${running}/${records.length}`;
  return running > 0
    ? paint(theme, "accent", label, true)
    : paint(theme, "muted", label);
}

function headerModePill(
  runtime: CodepunkRuntime,
  theme?: PanelTheme,
): string | null {
  const planMode = runtime.planMode.state();
  if (planMode?.mode === "planning") {
    return paint(theme, "accent", "[PLAN]", true);
  }
  if (planMode?.mode === "executing") {
    return paint(theme, "accent", "[PLAN:EXEC]", true);
  }
  if (runtime.config.autonomy.profile === "read-only") {
    return paint(theme, "muted", "[RO]", true);
  }
  if (runtime.config.approval.mode === "allow") {
    return paint(theme, "error", "[ALLOW]", true);
  }
  if (runtime.config.approval.mode === "auto") {
    return paint(theme, "warning", "[AUTO]", true);
  }
  return null;
}

export function renderHeader(
  state: TuiState,
  options?: StatusRenderOptions,
): string {
  const theme = options?.theme;
  const width = options?.width ?? 120;
  const runtime = state.runtime;
  if (runtime === null) {
    return `${paint(theme, "accent", "codepunk", true)}${sep(theme)}${paint(theme, "muted", "starting")}`;
  }
  const brand = paint(theme, "accent", "codepunk", true);
  const model = paint(theme, "text", modelStatus(runtime));
  const pill = headerModePill(runtime, theme);
  const parts = [brand, model];
  if (pill !== null) {
    parts.push(pill);
  }
  if (width >= 82) {
    parts.push(
      paint(
        theme,
        "muted",
        `session ${runtime.session.sessionId.slice(0, 12)}`,
      ),
    );
  }
  if (width >= 112) {
    parts.push(
      paint(
        theme,
        "muted",
        "Alt+K palette · Alt+M mode · Alt+T tasks · F1 help",
      ),
    );
  } else if (width >= 88) {
    parts.push(paint(theme, "muted", "Alt+K · Alt+M · F1 help"));
  }
  return parts.join(sep(theme));
}

export function formatContextBar(percent: number, slots = 8): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * slots);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, slots - filled))}`;
}

function contextGaugeBadge(
  runtime: CodepunkRuntime,
  theme?: PanelTheme,
  compact = false,
): string | null {
  const usage = runtime.host.session.getContextUsage?.();
  if (
    usage === undefined ||
    usage.tokens === null ||
    usage.tokens <= 0 ||
    usage.percent === null ||
    !Number.isFinite(usage.percent)
  ) {
    return null;
  }
  const percent = Math.max(1, Math.min(100, Math.round(usage.percent)));
  const bar = compact ? "" : ` ${formatContextBar(percent, 6)}`;
  const raw =
    percent >= 75
      ? `ctx ${percent}%${bar} (/compact)`
      : `ctx ${percent}%${bar}`;
  const color: PanelColor =
    percent >= 85 ? "error" : percent >= 65 ? "warning" : "success";
  return paint(theme, color, raw, percent >= 85);
}

function styledPermissions(profile: string, theme?: PanelTheme): string {
  const text = `permissions ${profile}`;
  if (profile === "full-access" || profile === "auto-approve") {
    return paint(theme, "error", text, true);
  }
  if (profile === "auto") {
    return paint(theme, "warning", text);
  }
  if (profile === "read-only") {
    return paint(theme, "muted", text);
  }
  return paint(theme, "text", text);
}

function styledTrust(trustText: string, theme?: PanelTheme): string {
  const text = `trust ${trustText}`;
  if (trustText.startsWith("trusted")) {
    return paint(theme, "success", text);
  }
  return paint(theme, "warning", text);
}

function styledShell(
  shellStatus: ReturnType<typeof currentShellStatus>,
  theme?: PanelTheme,
): string {
  const text = `shell ${shellStatus}`;
  if (shellStatus === "srt") {
    return paint(theme, "success", text);
  }
  if (shellStatus === "srt-preparing") {
    return paint(theme, "warning", text);
  }
  if (shellStatus === "srt-failed") {
    return paint(theme, "error", text, true);
  }
  return paint(theme, "warning", text);
}

export function renderStatus(
  state: TuiState,
  options?: StatusRenderOptions,
): string {
  const theme = options?.theme;
  const width = options?.width ?? 120;
  const compact = width < 84;
  const runtime = state.runtime;
  if (runtime === null) {
    return paint(theme, "muted", "starting");
  }
  const profile = permissionProfileFor(runtime.config);
  const budget = budgetSnapshot(runtime);
  const budgetText =
    budget.maxTokens === null && budget.maxCostUsd === null
      ? ""
      : paint(theme, "muted", formatBudgetStatus(budget));
  const agents = agentStatus(state, theme);
  const ctxBadge = contextGaugeBadge(runtime, theme, compact);
  const planMode = runtime.planMode.state();
  const planBadge =
    planMode?.mode === "planning"
      ? paint(theme, "accent", "plan", true)
      : planMode?.mode === "executing"
        ? paint(theme, "accent", "plan:exec", true)
        : null;
  const mcpBadge =
    runtime.mcpStatus === "connecting"
      ? paint(theme, "accent", "mcp connecting")
      : null;
  const evidence = evidenceCount(runtime);
  const policySegments: string[] = [
    ...(planBadge === null ? [] : [planBadge]),
    styledPermissions(profile, theme),
  ];
  if (width >= 76) {
    policySegments.push(
      styledTrust(trustDisplay(runtime.workspaceTrust), theme),
    );
  }
  policySegments.push(styledShell(currentShellStatus(runtime), theme));
  if (width >= 90 || evidence > 0) {
    policySegments.push(paint(theme, "muted", `evidence ${evidence}`));
  }
  if (ctxBadge !== null) {
    policySegments.push(ctxBadge);
  }
  if (mcpBadge !== null) {
    policySegments.push(mcpBadge);
  }
  if (agents !== null) {
    policySegments.push(agents);
  }
  const policy = policySegments.join(sep(theme));
  return renderStatusline(runtime.config.tui.statusline, {
    model: paint(theme, "text", modelStatus(runtime)),
    session: paint(
      theme,
      "muted",
      `session ${runtime.session.sessionId.slice(0, 12)}`,
    ),
    sandbox: paint(
      theme,
      runtime.config.sandbox.mode === "required" ? "success" : "warning",
      `sandbox ${runtime.config.sandbox.mode}`,
    ),
    filesystem: paint(
      theme,
      runtime.config.filesystem.mode === "workspace" ? "muted" : "error",
      `fs ${runtime.config.filesystem.mode}`,
    ),
    policy,
    budget: budgetText,
  });
}

function noColorEnabled(): boolean {
  const value = process.env["NO_COLOR"];
  return value !== undefined && value.length > 0;
}

function safeUiTheme(context: ExtensionContext): PanelTheme | undefined {
  if (noColorEnabled()) {
    return undefined;
  }
  try {
    return resolveLiveTheme(context.ui.theme);
  } catch {
    return undefined;
  }
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
  const width =
    typeof process.stdout.columns === "number" && process.stdout.columns > 0
      ? process.stdout.columns
      : 120;
  context.ui.setStatus(
    "codepunk",
    runtime?.config.tui.status === true
      ? renderStatus(state, { theme: safeUiTheme(context), width })
      : undefined,
  );
}
