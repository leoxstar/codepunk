import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeUserPermissionSelection } from "codepunk-core";
import { refreshStatus } from "../chrome/statusline.ts";
import { refreshWorkWidget } from "../chrome/work-widget.ts";
import type { TuiState } from "../state.ts";

export type WorkModeStep = "plan" | "standard" | "auto" | "auto-approve";

const MODE_SEQUENCE: readonly WorkModeStep[] = [
  "plan",
  "standard",
  "auto",
  "auto-approve",
];

function currentModeStep(state: TuiState): WorkModeStep {
  const runtime = state.runtime;
  if (runtime === null) {
    return "standard";
  }
  if (runtime.planMode.state()?.mode === "planning") {
    return "plan";
  }
  const approval = runtime.config.approval.mode;
  if (approval === "allow") {
    return "auto-approve";
  }
  if (approval === "auto") {
    return "auto";
  }
  return "standard";
}

export function nextWorkMode(current: WorkModeStep): WorkModeStep {
  const index = MODE_SEQUENCE.indexOf(current);
  return MODE_SEQUENCE[(index + 1) % MODE_SEQUENCE.length] ?? "standard";
}

/**
 * Cycle common interactive work modes on Shift+Tab:
 * Plan (read-only) -> Standard (ask) -> Auto (auto) -> Auto-Approve (allow).
 * Never silently enables full-access or weakens sandbox/filesystem boundaries.
 */
export async function cycleWorkMode(
  state: TuiState,
  context: ExtensionContext,
): Promise<WorkModeStep | null> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return null;
  }
  if (runtime.autonomy.profile === "read-only") {
    context.ui.notify(
      "Session started in read-only autonomy; use /permissions or restart to widen.",
      "warning",
    );
    return null;
  }
  const target = nextWorkMode(currentModeStep(state));
  try {
    if (target === "plan") {
      await runtime.planMode.enter();
      refreshWorkWidget(state, context);
      refreshStatus(state, context);
      context.ui.notify(
        "Mode: plan (read-only tools until plan approved)",
        "info",
      );
      return target;
    }
    if (runtime.planMode.state()?.mode === "planning") {
      await runtime.planMode.exit();
    }
    const approvalMode =
      target === "standard" ? "ask" : target === "auto" ? "auto" : "allow";
    runtime.setApprovalMode(approvalMode);
    await writeUserPermissionSelection(runtime.paths, {
      approval: approvalMode,
    }).catch(() => undefined);
    refreshWorkWidget(state, context);
    refreshStatus(state, context);
    const label =
      target === "standard"
        ? "standard (ask before mutating)"
        : target === "auto"
          ? "auto (safe workspace writes, ask on shell/network)"
          : "auto-approve (allow covered actions inside sandbox)";
    context.ui.notify(`Mode: ${label}`, "info");
    return target;
  } catch (error) {
    context.ui.notify(
      `mode switch failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return null;
  }
}
