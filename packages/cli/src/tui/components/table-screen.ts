import type { Component } from "@earendil-works/pi-tui";
import {
  BORDERED_MIN_WIDTH,
  frameLines,
  isCloseInput,
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";
import { Table, type TableOptions } from "./table.ts";

export interface TableScreenOptions {
  readonly title: string;
  readonly table: TableOptions;
  readonly footer?: string;
  readonly note?: string;
}

/**
 * A closeable screen around a Table. The table stays a pure projection; this
 * wrapper owns the title, footer and keyboard focus.
 */
export class TableScreen implements Component {
  private readonly options: TableScreenOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly onClose: () => void;
  private readonly table: Table;
  private cachedWidth = -1;
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
    if (this.cachedWidth === safeWidth) {
      return this.cachedLines;
    }
    const inner = Math.max(
      1,
      safeWidth - (safeWidth < BORDERED_MIN_WIDTH ? 2 : 4),
    );
    const rendered = frameLines(
      {
        title: this.options.title,
        body: [
          ...(this.options.note === undefined ? [] : [this.options.note]),
          ...this.table.render(inner),
        ],
        footer: this.options.footer ?? "esc close",
      },
      safeWidth,
      this.theme,
    );
    this.cachedWidth = safeWidth;
    this.cachedLines = rendered;
    return rendered;
  }

  handleInput(data: string): void {
    if (isCloseInput(data, this.keybindings)) {
      this.onClose();
    }
  }

  invalidate(): void {
    this.cachedWidth = -1;
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
