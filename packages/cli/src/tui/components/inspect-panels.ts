import type { DoctorCheck, DoctorReport } from "codepunk-core";
import {
  defaultViewportHeight,
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";
import { Panel, type PanelSection } from "./panel.ts";

function statusIcon(status: string): string {
  if (status === "ok") {
    return "✓";
  }
  if (status === "warn") {
    return "⚠";
  }
  return "✗";
}

function formatCheckLines(check: DoctorCheck): string[] {
  const symbol =
    check.status === "ok" ? "ok" : check.status === "warn" ? "warn" : "error";
  const lines = [
    `${statusIcon(check.status)} [${symbol}] ${check.id}: ${check.message}`,
  ];
  if (check.hint !== null) {
    lines.push(...check.hint.split("\n").map((line) => `    ${line}`));
  }
  return lines;
}

export function createDoctorPanel(
  report: DoctorReport,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: () => void,
): Panel {
  const summaryLine = `codepunk doctor (${report.platform}): ${report.ok ? "ready" : "blocking issues remain"}`;
  const okChecks = report.checks.filter((check) => check.status === "ok");
  const warnChecks = report.checks.filter((check) => check.status === "warn");
  const failChecks = report.checks.filter(
    (check) => check.status !== "ok" && check.status !== "warn",
  );
  const sections: PanelSection[] = [
    {
      label: "Summary",
      lines: [summaryLine],
      tone: report.ok ? "default" : "error",
    },
    ...(failChecks.length > 0
      ? [
          {
            label: `Blocking issues (${failChecks.length})`,
            lines: failChecks.flatMap(formatCheckLines),
            tone: "error" as const,
          },
        ]
      : []),
    ...(warnChecks.length > 0
      ? [
          {
            label: `Warnings (${warnChecks.length})`,
            lines: warnChecks.flatMap(formatCheckLines),
            tone: "warning" as const,
          },
        ]
      : []),
    {
      label: `Healthy checks (${okChecks.length})`,
      lines: okChecks.flatMap(formatCheckLines),
      tone: "default",
    },
  ];
  return new Panel(
    {
      title: "codepunk doctor",
      sections,
      footer: "esc close",
      tone: report.ok ? "accent" : "error",
      viewportHeight: defaultViewportHeight(),
    },
    theme,
    keybindings,
    done,
  );
}

export function createStructuredTextPanel(
  title: string,
  sections: readonly PanelSection[],
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: () => void,
  tone: "default" | "accent" | "warning" | "error" = "accent",
): Panel {
  return new Panel(
    {
      title,
      sections,
      footer: "esc close",
      tone,
      viewportHeight: defaultViewportHeight(),
    },
    theme,
    keybindings,
    done,
  );
}
