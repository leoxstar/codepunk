import type { Component } from "@earendil-works/pi-tui";
import {
  BORDERED_MIN_WIDTH,
  frameLines,
  isCloseInput,
  nextScrollOffset,
  parseScrollInput,
  scrollFooter,
  sliceViewport,
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";
import { Table, type TableOptions } from "./table.ts";

export interface TableScreenOptions {
  readonly title: string;
  readonly table: TableOptions;
  readonly footer?: string;
  readonly note?: string;
  readonly viewportHeight?: number;
}

/**
 * A closeable screen around a Table. The table stays a pure projection; this
 * wrapper owns the title, footer, viewport scrolling, and keyboard focus.
 */
export class TableScreen implements Component {
  private readonly options: TableScreenOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly onClose: () => void;
  private readonly table: Table;
  private scrollOffset = 0;
  private lastTotalLines = 0;
  private cachedKey = "";
  private cachedLines: readonly string[] = [];

  constructor(
    options: TableScreenOptions,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    onClose: () => void,
  ) {
    this.options = options;
    this.theme = theme;
    this.keybindings = keybindings;
    this.onClose = onClose;
    this.table = new Table(options.table);
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const cacheKey = `${safeWidth}:${this.scrollOffset}:${this.options.viewportHeight ?? "all"}`;
    if (this.cachedKey === cacheKey) {
      return this.cachedLines;
    }
    const inner = Math.max(
      1,
      safeWidth - (safeWidth < BORDERED_MIN_WIDTH ? 2 : 4),
    );
    const allBody = [
      ...(this.options.note === undefined ? [] : [this.options.note]),
      ...this.table.render(inner),
    ];
    this.lastTotalLines = allBody.length;
    const viewport = sliceViewport(
      allBody,
      this.scrollOffset,
      this.options.viewportHeight,
    );
    this.scrollOffset = viewport.offset;
    const footer = scrollFooter(this.options.footer ?? "esc close", viewport);
    const rendered = frameLines(
      {
        title: this.options.title,
        body: viewport.visible,
        ...(footer === undefined ? {} : { footer }),
      },
      safeWidth,
      this.theme,
    );
    this.cachedKey = `${safeWidth}:${this.scrollOffset}:${this.options.viewportHeight ?? "all"}`;
    this.cachedLines = rendered;
    return rendered;
  }

  handleInput(data: string): void {
    if (isCloseInput(data, this.keybindings)) {
      this.onClose();
      return;
    }
    if (this.options.viewportHeight === undefined) {
      return;
    }
    const direction = parseScrollInput(data);
    if (direction === null) {
      return;
    }
    this.scrollOffset = nextScrollOffset(
      this.scrollOffset,
      direction,
      this.lastTotalLines,
      this.options.viewportHeight,
    );
  }

  invalidate(): void {
    this.cachedKey = "";
    this.cachedLines = [];
    this.table.invalidate();
  }
}

export function createTableScreen(
  options: TableScreenOptions,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: () => void,
): TableScreen {
  return new TableScreen(options, theme, keybindings, done);
}
