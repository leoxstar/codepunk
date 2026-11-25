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
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";

export interface HelpBrowserOptions {
  readonly title: string;
  readonly text: string;
  readonly viewportHeight?: number;
}

const FOOTER_TEXT = "type to filter · esc close";

export class HelpBrowser implements Component {
  private readonly options: HelpBrowserOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly onClose: () => void;
  private readonly allLines: readonly string[];
  private query = "";
  private scrollOffset = 0;
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
  }

  private matchingLines(): readonly string[] {
    const trimmed = this.query.trim();
    if (trimmed.length === 0) {
      return this.allLines;
    }
    const nonEmpty = this.allLines.filter((line) => line.trim().length > 0);
    return fuzzyFilter(nonEmpty, trimmed, (line) => line);
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const key = `${safeWidth}:${this.query}:${this.scrollOffset}`;
    if (this.cachedKey === key) {
      return this.cachedLines;
    }
    const inner = Math.max(
      1,
      safeWidth - (safeWidth < BORDERED_MIN_WIDTH ? 2 : 4),
    );
    const matched = this.matchingLines();
    const styled =
      matched.length === 0
        ? [this.theme.fg("muted", "No matching commands.")]
        : matched.map((line) => {
            const clipped = truncateToWidth(line, inner, "…");
            if (line.length > 0 && !line.startsWith(" ")) {
              return this.theme.bold(this.theme.fg("accent", clipped));
            }
            return this.theme.fg("text", clipped);
          });
    const listHeight = Math.max(
      3,
      (this.options.viewportHeight ?? defaultViewportHeight()) - 2,
    );
    this.lastTotal = styled.length;
    const viewport = sliceViewport(styled, this.scrollOffset, listHeight);
    this.scrollOffset = viewport.offset;
    const searchBar = truncateToWidth(
      `${this.theme.fg("accent", "Filter:")} ${this.query || this.theme.fg("muted", "(type to filter commands)")}`,
      inner,
      "…",
    );
    const body = [searchBar, "", ...viewport.visible];
    const footer = scrollFooter(FOOTER_TEXT, viewport) ?? FOOTER_TEXT;
    const rendered = frameLines(
      {
        title: this.options.title,
        body,
        footer,
      },
      safeWidth,
      this.theme,
    );
    this.cachedKey = `${safeWidth}:${this.query}:${this.scrollOffset}`;
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
    if (data === "\u007f" || data === "\b") {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.scrollOffset = 0;
      }
      return;
    }
    if (data === "\u0015") {
      this.query = "";
      this.scrollOffset = 0;
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
