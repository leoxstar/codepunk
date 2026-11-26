import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { permissionProfileFor, type CodepunkRuntime } from "codepunk-core";
import type { PanelTheme } from "../components/frame.ts";
import { trustDisplay } from "../format/trust.ts";
import type { TuiState } from "../state.ts";
import { currentShellStatus } from "./status.ts";
import { resolveLiveTheme } from "./statusline.ts";

export function formatWelcomeLines(
  runtime: CodepunkRuntime,
  theme?: PanelTheme,
): string[] {
  const live = resolveLiveTheme(theme);
  const projectName = path.basename(runtime.paths.deliveryRoot) || ".";
  const profile = permissionProfileFor(runtime.config);
  const shell = currentShellStatus(runtime);
  const trust = trustDisplay(runtime.workspaceTrust);
  const accent = (text: string) =>
    live ? live.bold(live.fg("accent", text)) : text;
  const muted = (text: string) => (live ? live.fg("muted", text) : text);
  const badgeColor =
    shell === "srt" ? "success" : shell === "srt-failed" ? "error" : "warning";
  const shellBadge = live
    ? live.fg(badgeColor, `shell:${shell}`)
    : `shell:${shell}`;
  const trustBadge = live
    ? live.fg(trust.startsWith("trusted") ? "success" : "warning", trust)
    : trust;
  const line1 = `${accent("◆ codepunk")} ${muted("·")} ${projectName} ${muted("·")} ${profile} ${muted("·")} ${shellBadge} ${muted("·")} ${trustBadge}`;
  const line2 = muted(
    "  Alt+K palette · Alt+M mode · Alt+T tasks · /diff · /context · F1 help",
  );
  return [line1, line2];
}

export function shouldShowWelcomeWidget(state: TuiState): boolean {
  const runtime = state.runtime;
  if (runtime === null) {
    return false;
  }
  if (!runtime.config.tui.widgets || state.welcomeDismissed === true) {
    return false;
  }
  return runtime.host.session.messages.length === 0;
}

export function refreshWelcomeWidget(
  state: TuiState,
  context: ExtensionContext,
): void {
  const runtime = state.runtime;
  if (runtime === null || !shouldShowWelcomeWidget(state)) {
    context.ui.setWidget("welcome-banner", undefined);
    return;
  }
  context.ui.setWidget(
    "welcome-banner",
    (_tui, theme): Component => ({
      render: (width: number) => {
        const safeWidth = Math.max(1, Math.floor(width));
        return formatWelcomeLines(runtime, theme).map((line) =>
          truncateToWidth(line, safeWidth, "…"),
        );
      },
      invalidate: () => {},
    }),
    { placement: "aboveEditor" },
  );
}
