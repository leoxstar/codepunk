import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { readWorkState, type CodepunkRuntime } from "codepunk-core";
import type { PanelColor, PanelTheme } from "../components/frame.ts";
import type { TuiState } from "../state.ts";
import { formatContextBar, resolveLiveTheme } from "./statusline.ts";

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

function progressBar(done: number, total: number, theme?: PanelTheme): string {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const bar = formatContextBar(percent, 6);
  return paint(theme, done === total && total > 0 ? "success" : "accent", bar);
}

export function formatWorkWidgetLines(
  runtime: CodepunkRuntime,
  theme?: PanelTheme,
): string[] | undefined {
  const planMode = runtime.planMode.state();
  const work = readWorkState(runtime.session.allEvents);
  const lines: string[] = [];

  if (planMode !== null && planMode.mode !== "off") {
    const label =
      planMode.mode === "planning"
        ? `${paint(theme, "accent", "◆ PLAN MODE", true)} ${paint(theme, "muted", "(read-only · Alt+M to switch · /plan-mode approve to execute)")}`
        : `${paint(theme, "success", "▶ PLAN EXECUTING", true)} ${paint(theme, "muted", "(approved plan active)")}`;
    lines.push(label);
  } else if (runtime.config.autonomy.profile === "read-only") {
    lines.push(
      `${paint(theme, "muted", "◆ READ-ONLY", true)} ${paint(theme, "muted", "(mutations denied · /permissions to change)")}`,
    );
  } else if (runtime.config.approval.mode === "allow") {
    lines.push(
      `${paint(theme, "error", "▲ AUTO-APPROVE", true)} ${paint(theme, "muted", "(covered sandbox actions auto-approved · Alt+M to switch)")}`,
    );
  } else if (runtime.config.approval.mode === "auto") {
    lines.push(
      `${paint(theme, "warning", "◆ AUTO MODE", true)} ${paint(theme, "muted", "(routine workspace edits auto-approved · Alt+M to switch)")}`,
    );
  }

  if (work.plan !== null && work.plan.steps.length > 0) {
    const done = work.plan.steps.filter(
      (step) => step.status === "completed",
    ).length;
    const active = work.plan.steps.find(
      (step) => step.status === "in_progress",
    );
    const suffix =
      active !== undefined
        ? ` ${paint(theme, "accent", "▶")} ${paint(theme, "text", active.step)}`
        : "";
    lines.push(
      `${paint(theme, "accent", "plan", true)} ${progressBar(done, work.plan.steps.length, theme)} ${paint(theme, "muted", `${done}/${work.plan.steps.length}`)}${suffix}`,
    );
  }

  if (work.todos !== null && work.todos.items.length > 0) {
    const done = work.todos.items.filter(
      (item) => item.status === "completed",
    ).length;
    const active = work.todos.items.find(
      (item) => item.status === "in_progress",
    );
    const suffix =
      active !== undefined
        ? ` ${paint(theme, "accent", "▶")} ${paint(theme, "text", active.content)}`
        : "";
    lines.push(
      `${paint(theme, "accent", "todos", true)} ${progressBar(done, work.todos.items.length, theme)} ${paint(theme, "muted", `${done}/${work.todos.items.length}`)}${suffix}`,
    );
  }

  return lines.length === 0 ? undefined : lines;
}

export function refreshWorkWidget(
  state: TuiState,
  context: ExtensionContext,
): void {
  const runtime = state.runtime;
  if (runtime === null || !runtime.config.tui.widgets) {
    context.ui.setWidget("work-progress", undefined);
    return;
  }
  const hasLines = formatWorkWidgetLines(runtime) !== undefined;
  if (!hasLines) {
    context.ui.setWidget("work-progress", undefined);
    return;
  }
  context.ui.setWidget(
    "work-progress",
    (_tui, theme): Component => ({
      render: (width: number) => {
        const safeWidth = Math.max(1, Math.floor(width));
        return (formatWorkWidgetLines(runtime, theme) ?? []).map((line) =>
          truncateToWidth(line, safeWidth, "…"),
        );
      },
      invalidate: () => {},
    }),
    { placement: "aboveEditor" },
  );
}
