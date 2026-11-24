import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type PanelTone = "default" | "muted" | "warning" | "error";

export interface PanelTheme {
  bold(text: string): string;
  fg(
    color: "text" | "muted" | "warning" | "error" | "accent" | "border",
    text: string,
  ): string;
}

export interface PanelKeybindings {
  matches(data: string, keybinding: "tui.select.cancel"): boolean;
}

export interface FrameOptions {
  readonly title: string;
  readonly body: readonly string[];
  readonly footer?: string;
}

export const BORDERED_MIN_WIDTH = 12;

export function isCloseInput(
  data: string,
  keybindings: PanelKeybindings,
): boolean {
  return keybindings.matches(data, "tui.select.cancel") || data === "q";
}

/**
 * Frame a block of already width-safe body lines. The frame is the only part
 * that draws borders; callers keep ownership of wrapping their content.
 */
export function frameLines(
  options: FrameOptions,
  width: number,
  theme: PanelTheme,
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  return safeWidth < BORDERED_MIN_WIDTH
    ? narrowLines(options, safeWidth, theme)
    : borderedLines(options, safeWidth, theme);
}

function narrowLines(
  options: FrameOptions,
  width: number,
  theme: PanelTheme,
): string[] {
  const lines = [
    truncateToWidth(theme.bold(theme.fg("accent", options.title)), width),
  ];
  for (const line of options.body) {
    lines.push(truncateToWidth(`  ${line}`, width));
  }
  if (options.footer !== undefined) {
    lines.push("");
    lines.push(truncateToWidth(theme.fg("muted", options.footer), width));
  }
  return lines.map((line) => truncateToWidth(line, width));
}

function borderedLines(
  options: FrameOptions,
  width: number,
  theme: PanelTheme,
): string[] {
  const lines = [topBorder(options.title, width, theme)];
  for (const line of options.body) {
    lines.push(frameLine(line, width, theme));
  }
  if (options.footer !== undefined) {
    lines.push(divider(width, theme));
    lines.push(frameLine(theme.fg("muted", options.footer), width, theme));
  }
  lines.push(bottomBorder(width, theme));
  return lines;
}

function topBorder(title: string, width: number, theme: PanelTheme): string {
  const label = truncateToWidth(`─ ${title} `, Math.max(1, width - 2), "…");
  const fill = Math.max(0, width - 2 - visibleWidth(label));
  return theme.fg("border", `┌${label}${"─".repeat(fill)}┐`);
}

function divider(width: number, theme: PanelTheme): string {
  return theme.fg("border", `├${"─".repeat(Math.max(0, width - 2))}┤`);
}

function bottomBorder(width: number, theme: PanelTheme): string {
  return theme.fg("border", `└${"─".repeat(Math.max(0, width - 2))}┘`);
}

function frameLine(content: string, width: number, theme: PanelTheme): string {
  const inner = Math.max(1, width - 4);
  const body = truncateToWidth(content, inner, "…", true);
  return `${theme.fg("border", "│")} ${body} ${theme.fg("border", "│")}`;
}
