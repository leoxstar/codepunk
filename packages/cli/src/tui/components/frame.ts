import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type PanelTone = "default" | "muted" | "warning" | "error";

export type FrameTone = "default" | "accent" | "warning" | "error";

export type PanelColor =
  "text" | "muted" | "warning" | "error" | "accent" | "border" | "success";

export interface PanelTheme {
  bold(text: string): string;
  fg(color: PanelColor, text: string): string;
}

export interface PanelKeybindings {
  matches(data: string, keybinding: "tui.select.cancel"): boolean;
}

export interface FrameScrollbar {
  readonly offset: number;
  readonly visibleCount: number;
  readonly total: number;
}

export interface FrameOptions {
  readonly title: string;
  readonly body: readonly string[];
  readonly footer?: string;
  readonly tone?: FrameTone;
  readonly scrollbar?: FrameScrollbar;
}

export const BORDERED_MIN_WIDTH = 12;

export function isCloseInput(
  data: string,
  keybindings: PanelKeybindings,
): boolean {
  return keybindings.matches(data, "tui.select.cancel") || data === "q";
}

export type ScrollDirection =
  "line-up" | "line-down" | "page-up" | "page-down" | "top" | "bottom";

export function parseScrollInput(data: string): ScrollDirection | null {
  if (data === "\u001b[A" || data === "\u001bOA" || data === "k") {
    return "line-up";
  }
  if (data === "\u001b[B" || data === "\u001bOB" || data === "j") {
    return "line-down";
  }
  if (data === "\u001b[5~" || data === "\u0015") {
    return "page-up";
  }
  if (data === "\u001b[6~" || data === "\u0004") {
    return "page-down";
  }
  if (data === "\u001b[H" || data === "\u001bOH" || data === "g") {
    return "top";
  }
  if (data === "\u001b[F" || data === "\u001bOF" || data === "G") {
    return "bottom";
  }
  return null;
}

export function nextScrollOffset(
  current: number,
  direction: ScrollDirection,
  totalLines: number,
  viewportHeight: number,
): number {
  const maxOffset = Math.max(0, totalLines - viewportHeight);
  const page = Math.max(1, viewportHeight - 2);
  switch (direction) {
    case "line-up":
      return Math.max(0, current - 1);
    case "line-down":
      return Math.min(maxOffset, current + 1);
    case "page-up":
      return Math.max(0, current - page);
    case "page-down":
      return Math.min(maxOffset, current + page);
    case "top":
      return 0;
    case "bottom":
      return maxOffset;
  }
}

export function defaultViewportHeight(rows = process.stdout.rows): number {
  if (typeof rows !== "number" || !Number.isFinite(rows) || rows <= 0) {
    return 18;
  }
  return Math.max(8, Math.floor(rows) - 12);
}

export function sliceViewport(
  lines: readonly string[],
  offset: number,
  viewportHeight?: number,
): {
  readonly visible: readonly string[];
  readonly offset: number;
  readonly total: number;
  readonly scrollable: boolean;
} {
  if (
    viewportHeight === undefined ||
    viewportHeight <= 0 ||
    lines.length <= viewportHeight
  ) {
    return {
      visible: lines,
      offset: 0,
      total: lines.length,
      scrollable: false,
    };
  }
  const safeHeight = Math.max(1, Math.floor(viewportHeight));
  const clampedOffset = Math.max(
    0,
    Math.min(offset, Math.max(0, lines.length - safeHeight)),
  );
  return {
    visible: lines.slice(clampedOffset, clampedOffset + safeHeight),
    offset: clampedOffset,
    total: lines.length,
    scrollable: true,
  };
}

export function viewportScrollbar(viewport: {
  readonly visible: readonly string[];
  readonly offset: number;
  readonly total: number;
  readonly scrollable: boolean;
}): FrameScrollbar | undefined {
  if (!viewport.scrollable || viewport.visible.length === 0) {
    return undefined;
  }
  return {
    offset: viewport.offset,
    visibleCount: viewport.visible.length,
    total: viewport.total,
  };
}

export function scrollFooter(
  baseFooter: string | undefined,
  viewport: {
    readonly visible: readonly string[];
    readonly offset: number;
    readonly total: number;
    readonly scrollable: boolean;
  },
): string | undefined {
  if (!viewport.scrollable) {
    return baseFooter;
  }
  const start = viewport.offset + 1;
  const end = viewport.offset + viewport.visible.length;
  const indicator = `lines ${start}-${end}/${viewport.total} · ↑/↓ scroll`;
  return baseFooter === undefined || baseFooter.length === 0
    ? indicator
    : `${indicator} · ${baseFooter}`;
}

function borderColorFor(tone: FrameTone | undefined): PanelColor {
  switch (tone) {
    case "accent":
      return "accent";
    case "warning":
      return "warning";
    case "error":
      return "error";
    default:
      return "border";
  }
}

function titleColorFor(tone: FrameTone | undefined): PanelColor {
  switch (tone) {
    case "warning":
      return "warning";
    case "error":
      return "error";
    default:
      return "accent";
  }
}

function scrollbarRange(
  scrollbar: FrameScrollbar | undefined,
  rowCount: number,
): { readonly start: number; readonly end: number } | null {
  if (
    scrollbar === undefined ||
    rowCount <= 0 ||
    scrollbar.total <= scrollbar.visibleCount
  ) {
    return null;
  }
  const maxOffset = Math.max(1, scrollbar.total - scrollbar.visibleCount);
  const thumbHeight = Math.max(
    1,
    Math.min(
      rowCount,
      Math.round((scrollbar.visibleCount / scrollbar.total) * rowCount),
    ),
  );
  const maxStart = Math.max(0, rowCount - thumbHeight);
  const start = Math.max(
    0,
    Math.min(maxStart, Math.round((scrollbar.offset / maxOffset) * maxStart)),
  );
  return { start, end: start + thumbHeight };
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
  const titleColor = titleColorFor(options.tone);
  const lines = [
    truncateToWidth(theme.bold(theme.fg(titleColor, options.title)), width),
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
  const borderColor = borderColorFor(options.tone);
  const titleColor = titleColorFor(options.tone);
  const thumb = scrollbarRange(options.scrollbar, options.body.length);
  const lines = [
    topBorder(options.title, width, theme, borderColor, titleColor),
  ];
  for (let index = 0; index < options.body.length; index += 1) {
    const line = options.body[index]!;
    const isThumb = thumb !== null && index >= thumb.start && index < thumb.end;
    lines.push(
      frameLine(line, width, theme, borderColor, isThumb ? titleColor : null),
    );
  }
  if (options.footer !== undefined) {
    lines.push(divider(width, theme, borderColor));
    lines.push(
      frameLine(theme.fg("muted", options.footer), width, theme, borderColor),
    );
  }
  lines.push(bottomBorder(width, theme, borderColor));
  return lines;
}

function topBorder(
  title: string,
  width: number,
  theme: PanelTheme,
  borderColor: PanelColor,
  titleColor: PanelColor,
): string {
  const maxInner = Math.max(1, width - 2);
  if (maxInner <= 3) {
    const label = truncateToWidth(title, maxInner, "…");
    const fill = Math.max(0, maxInner - visibleWidth(label));
    return `${theme.fg(borderColor, "╭")}${theme.bold(theme.fg(titleColor, label))}${theme.fg(borderColor, `${"─".repeat(fill)}╮`)}`;
  }
  const clippedTitle = truncateToWidth(title, Math.max(1, maxInner - 3), "…");
  const titlePart = ` ${clippedTitle} `;
  const fill = Math.max(0, maxInner - 1 - visibleWidth(titlePart));
  return `${theme.fg(borderColor, "╭─")}${theme.bold(theme.fg(titleColor, titlePart))}${theme.fg(borderColor, `${"─".repeat(fill)}╮`)}`;
}

function divider(
  width: number,
  theme: PanelTheme,
  borderColor: PanelColor,
): string {
  return theme.fg(borderColor, `├${"─".repeat(Math.max(0, width - 2))}┤`);
}

function bottomBorder(
  width: number,
  theme: PanelTheme,
  borderColor: PanelColor,
): string {
  return theme.fg(borderColor, `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

function frameLine(
  content: string,
  width: number,
  theme: PanelTheme,
  borderColor: PanelColor,
  thumbColor: PanelColor | null = null,
): string {
  const inner = Math.max(1, width - 4);
  const body = truncateToWidth(content, inner, "…", true);
  const rightEdge =
    thumbColor === null
      ? theme.fg(borderColor, "│")
      : theme.fg(thumbColor, "┃");
  return `${theme.fg(borderColor, "│")} ${body} ${rightEdge}`;
}
