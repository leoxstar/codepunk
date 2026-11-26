import {
  fuzzyFilter,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  BORDERED_MIN_WIDTH,
  defaultViewportHeight,
  frameLines,
  nextScrollOffset,
  parseScrollInput,
  scrollFooter,
  sliceViewport,
  viewportScrollbar,
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";

export interface HelpBrowserOptions {
  readonly title: string;
  readonly text: string;
  readonly viewportHeight?: number;
  readonly initialQuery?: string;
  readonly onSelectCommand?: (command: string) => void;
}

const FOOTER_TEXT = "type to filter · ↑/↓ select · enter run · esc close";
const FOOTER_VIEW_ONLY = "type to filter · esc close";

export function extractHelpSlashCommand(line: string): string | null {
  const match = /^\s+(\/[a-z0-9][a-z0-9-]*)/u.exec(line);
  return match?.[1] ?? null;
}

export class HelpBrowser implements Component {
  private readonly options: HelpBrowserOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly onClose: () => void;
  private readonly allLines: readonly string[];
  private query: string;
  private scrollOffset = 0;
  private selectedIndex = 0;
  private lastTotal = 0;
  private cachedKey = "";
  private cachedLines: readonly string[] = [];

  constructor(
    options: HelpBrowserOptions,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    onClose: () => void,
  ) {
    this.options = options;
    this.theme = theme;
    this.keybindings = keybindings;
    this.onClose = onClose;
    this.allLines = options.text.split("\n");
    this.query = options.initialQuery ?? "";
  }

  private matchingLines(): readonly string[] {
    const trimmed = this.query.trim();
    if (trimmed.length === 0) {
      return this.allLines;
    }
    const nonEmpty = this.allLines.filter((line) => line.trim().length > 0);
    return fuzzyFilter(nonEmpty, trimmed, (line) => line);
  }

  private selectableIndices(lines: readonly string[]): number[] {
    const indices: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (extractHelpSlashCommand(lines[i]!) !== null) {
        indices.push(i);
      }
    }
    return indices;
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const listHeight = Math.max(
      3,
      (this.options.viewportHeight ?? defaultViewportHeight()) - 2,
    );
    const matched = this.matchingLines();
    const selectable = this.selectableIndices(matched);
    const interactive = this.options.onSelectCommand !== undefined;
    if (interactive && selectable.length > 0) {
      if (this.selectedIndex >= selectable.length) {
        this.selectedIndex = selectable.length - 1;
      }
      const activeLine = selectable[this.selectedIndex] ?? 0;
      if (activeLine < this.scrollOffset) {
        this.scrollOffset = activeLine;
      } else if (activeLine >= this.scrollOffset + listHeight) {
        this.scrollOffset = activeLine - listHeight + 1;
      }
    }
    const key = `${safeWidth}:${this.query}:${this.scrollOffset}:${this.selectedIndex}:${interactive}`;
    if (this.cachedKey === key) {
      return this.cachedLines;
    }
    const inner = Math.max(
      1,
      safeWidth - (safeWidth < BORDERED_MIN_WIDTH ? 2 : 4),
    );
    const activeLineIndex =
      interactive && selectable.length > 0
        ? (selectable[this.selectedIndex] ?? -1)
        : -1;
    const styled =
      matched.length === 0
        ? [this.theme.fg("muted", "No matching commands.")]
        : matched.map((line, index) => {
            const isSelected = index === activeLineIndex;
            const displayLine = isSelected ? `▸ ${line.trimStart()}` : line;
            const clipped = truncateToWidth(displayLine, inner, "…");
            if (isSelected) {
              return this.theme.bold(this.theme.fg("accent", clipped));
            }
            if (line.length > 0 && !line.startsWith(" ")) {
              return this.theme.bold(this.theme.fg("accent", clipped));
            }
            return this.theme.fg("text", clipped);
          });
    this.lastTotal = styled.length;
    const viewport = sliceViewport(styled, this.scrollOffset, listHeight);
    this.scrollOffset = viewport.offset;
    const searchBar = truncateToWidth(
      `${this.theme.fg("accent", "Filter:")} ${this.query || this.theme.fg("muted", "(type to filter commands)")}`,
      inner,
      "…",
    );
    const body = [searchBar, "", ...viewport.visible];
    const baseFooter = interactive ? FOOTER_TEXT : FOOTER_VIEW_ONLY;
    const footer = scrollFooter(baseFooter, viewport) ?? baseFooter;
    const scrollbar = viewportScrollbar(viewport);
    const rendered = frameLines(
      {
        title: this.options.title,
        body,
        footer,
        tone: "accent",
        ...(scrollbar === undefined ? {} : { scrollbar }),
      },
      safeWidth,
      this.theme,
    );
    this.cachedKey = `${safeWidth}:${this.query}:${this.scrollOffset}:${this.selectedIndex}:${interactive}`;
    this.cachedLines = rendered;
    return rendered;
  }

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      data === "\u001b"
    ) {
      this.onClose();
      return;
    }
    if (
      (data === "\r" || data === "\n") &&
      this.options.onSelectCommand !== undefined
    ) {
      const matched = this.matchingLines();
      const selectable = this.selectableIndices(matched);
      const lineIndex = selectable[this.selectedIndex];
      const command =
        lineIndex === undefined
          ? null
          : extractHelpSlashCommand(matched[lineIndex]!);
      if (command !== null) {
        this.options.onSelectCommand(command);
        return;
      }
      this.onClose();
      return;
    }
    if (data === "\u007f" || data === "\b") {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.scrollOffset = 0;
        this.selectedIndex = 0;
      }
      return;
    }
    if (data === "\u0015") {
      this.query = "";
      this.scrollOffset = 0;
      this.selectedIndex = 0;
      return;
    }
    if (
      this.options.onSelectCommand !== undefined &&
      (data === "\u001b[A" ||
        data === "\u001bOA" ||
        data === "\u001b[B" ||
        data === "\u001bOB")
    ) {
      const selectable = this.selectableIndices(this.matchingLines());
      if (selectable.length > 0) {
        const delta = data === "\u001b[B" || data === "\u001bOB" ? 1 : -1;
        this.selectedIndex =
          (this.selectedIndex + delta + selectable.length) % selectable.length;
      }
      return;
    }
    const scroll =
      data === "\u001b[A" ||
      data === "\u001bOA" ||
      data === "\u001b[B" ||
      data === "\u001bOB" ||
      data === "\u001b[5~" ||
      data === "\u001b[6~" ||
      data === "\u001b[H" ||
      data === "\u001b[F"
        ? parseScrollInput(data)
        : null;
    if (scroll !== null) {
      const listHeight = Math.max(
        3,
        (this.options.viewportHeight ?? defaultViewportHeight()) - 2,
      );
      this.scrollOffset = nextScrollOffset(
        this.scrollOffset,
        scroll,
        this.lastTotal,
        listHeight,
      );
      return;
    }
    if (
      data.length > 0 &&
      !data.startsWith("\u001b") &&
      !/[\u0000-\u001f\u007f]/u.test(data)
    ) {
      this.query += data;
      this.scrollOffset = 0;
      this.selectedIndex = 0;
    }
  }

  invalidate(): void {
    this.cachedKey = "";
    this.cachedLines = [];
  }
}

export function createHelpBrowser(
  options: HelpBrowserOptions,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  onClose: () => void,
): HelpBrowser {
  return new HelpBrowser(options, theme, keybindings, onClose);
}
