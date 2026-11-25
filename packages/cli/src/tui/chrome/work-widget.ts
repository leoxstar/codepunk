import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readWorkState, type CodepunkRuntime } from "codepunk-core";
import type { TuiState } from "../state.ts";

export function formatWorkWidgetLines(
  runtime: CodepunkRuntime,
): string[] | undefined {
  const planMode = runtime.planMode.state();
  const work = readWorkState(runtime.session.allEvents);
  const lines: string[] = [];

  if (planMode !== null && planMode.mode !== "off") {
    const label =
      planMode.mode === "planning"
        ? "PLAN MODE (read-only · Alt+M to switch · /plan-mode approve to execute)"
        : "PLAN EXECUTING (approved plan active)";
    lines.push(label);
  }

  if (work.plan !== null && work.plan.steps.length > 0) {
    const done = work.plan.steps.filter(
      (step) => step.status === "completed",
    ).length;
    const active = work.plan.steps.find(
      (step) => step.status === "in_progress",
    );
    const suffix = active !== undefined ? ` ▶ ${active.step}` : "";
    lines.push(`plan ${done}/${work.plan.steps.length}${suffix}`);
  }

  if (work.todos !== null && work.todos.items.length > 0) {
    const done = work.todos.items.filter(
      (item) => item.status === "completed",
    ).length;
    const active = work.todos.items.find(
      (item) => item.status === "in_progress",
    );
    const suffix = active !== undefined ? ` ▶ ${active.content}` : "";
    lines.push(`todos ${done}/${work.todos.items.length}${suffix}`);
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
  context.ui.setWidget("work-progress", formatWorkWidgetLines(runtime), {
    placement: "aboveEditor",
  });
}
