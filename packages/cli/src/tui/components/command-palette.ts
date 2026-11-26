import {
  fuzzyFilter,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  BORDERED_MIN_WIDTH,
  defaultViewportHeight,
  frameLines,
  sliceViewport,
  viewportScrollbar,
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";

export interface CommandPaletteItem {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly hint?: string;
  readonly shortcut?: string;
  readonly keywords?: string;
}

export interface CommandPaletteOptions {
  readonly title?: string;
  readonly items: readonly CommandPaletteItem[];
  readonly viewportHeight?: number;
}

const FOOTER_TEXT = "type to filter · ↑/↓ select · enter run · esc close";

export class CommandPalette implements Component {
  private readonly options: CommandPaletteOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly done: (id: string | null) => void;
  private query = "";
  private selectedIndex = 0;
  private scrollOffset = 0;
  private cachedKey = "";
  private cachedLines: readonly string[] = [];

  constructor(
    options: CommandPaletteOptions,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    done: (id: string | null) => void,
  ) {
    this.options = options;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
  }

  private filteredItems(): readonly CommandPaletteItem[] {
    const trimmed = this.query.trim();
    if (trimmed.length === 0) {
      return this.options.items;
    }
    return fuzzyFilter(
      [...this.options.items],
      trimmed,
      (item) =>
        `${item.category} ${item.label} ${item.hint ?? ""} ${item.shortcut ?? ""} ${item.keywords ?? ""}`,
    );
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const listHeight = Math.max(
      4,
      (this.options.viewportHeight ?? defaultViewportHeight()) - 2,
    );
    const items = this.filteredItems();
    if (this.selectedIndex >= items.length) {
      this.selectedIndex = Math.max(0, items.length - 1);
    }
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + listHeight) {
      this.scrollOffset = this.selectedIndex - listHeight + 1;
    }
    const cacheKey = `${safeWidth}:${this.query}:${this.selectedIndex}:${this.scrollOffset}:${listHeight}`;
    if (this.cachedKey === cacheKey) {
      return this.cachedLines;
    }
    const inner = Math.max(
      1,
      safeWidth - (safeWidth < BORDERED_MIN_WIDTH ? 2 : 4),
    );
    const searchBar = truncateToWidth(
      `${this.theme.bold(this.theme.fg("accent", "›"))} ${this.query || this.theme.fg("muted", "Type to search actions…")}`,
      inner,
      "…",
    );
    const rows =
      items.length === 0
        ? [this.theme.fg("muted", "No matching actions.")]
        : items.map((item, index) =>
            this.renderRow(item, index === this.selectedIndex, inner),
          );
    const viewport = sliceViewport(rows, this.scrollOffset, listHeight);
    this.scrollOffset = viewport.offset;
    const countBadge =
      items.length === this.options.items.length
        ? `${items.length} actions`
        : `${items.length}/${this.options.items.length} matches`;
    const footer = `${countBadge} · ${FOOTER_TEXT}`;
    const scrollbar = viewportScrollbar(viewport);
    const rendered = frameLines(
      {
        title: this.options.title ?? "Command palette",
        body: [searchBar, "", ...viewport.visible],
        footer,
        tone: "accent",
        ...(scrollbar === undefined ? {} : { scrollbar }),
      },
      safeWidth,
      this.theme,
    );
    this.cachedKey = `${safeWidth}:${this.query}:${this.selectedIndex}:${this.scrollOffset}:${listHeight}`;
    this.cachedLines = rendered;
    return rendered;
  }

  private renderRow(
    item: CommandPaletteItem,
    active: boolean,
    inner: number,
  ): string {
    const prefix = active ? "▸ " : "  ";
    const category = `[${item.category}]`;
    const shortcut = item.shortcut ?? "";
    const hint = item.hint ? ` — ${item.hint}` : "";
    const shortcutWidth = shortcut.length > 0 ? visibleWidth(shortcut) + 2 : 0;
    const leftBudget = Math.max(8, inner - shortcutWidth);
    const leftPlain = truncateToWidth(
      `${prefix}${category} ${item.label}${hint}`,
      leftBudget,
      "…",
    );
    const styledLeft = active
      ? this.theme.bold(this.theme.fg("accent", leftPlain))
      : `${this.theme.fg("muted", `${prefix}${category} `)}${this.theme.fg("text", truncateToWidth(`${item.label}${hint}`, Math.max(1, leftBudget - visibleWidth(`${prefix}${category} `)), "…"))}`;
    if (shortcut.length === 0 || inner < 24) {
      return truncateToWidth(styledLeft, inner, "…");
    }
    const pad = Math.max(
      1,
      inner - visibleWidth(styledLeft) - visibleWidth(shortcut),
    );
    return truncateToWidth(
      `${styledLeft}${" ".repeat(pad)}${this.theme.fg("muted", shortcut)}`,
      inner,
      "…",
    );
  }

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      data === "\u001b"
    ) {
      this.done(null);
      return;
    }
    const items = this.filteredItems();
    if (data === "\r" || data === "\n") {
      const selected = items[this.selectedIndex];
      this.done(selected?.id ?? null);
      return;
    }
    if (data === "\u001b[B" || data === "\u001bOB") {
      if (items.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % items.length;
      }
      return;
    }
    if (data === "\u001b[A" || data === "\u001bOA") {
      if (items.length > 0) {
        this.selectedIndex =
          (this.selectedIndex - 1 + items.length) % items.length;
      }
      return;
    }
    if (data === "\u007f" || data === "\b") {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.selectedIndex = 0;
        this.scrollOffset = 0;
      }
      return;
    }
    if (data === "\u0015") {
      this.query = "";
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      return;
    }
    if (
      data.length > 0 &&
      !data.startsWith("\u001b") &&
      !/[\u0000-\u001f\u007f]/u.test(data)
    ) {
      this.query += data;
      this.selectedIndex = 0;
      this.scrollOffset = 0;
    }
  }

  invalidate(): void {
    this.cachedKey = "";
    this.cachedLines = [];
  }
}

export function createCommandPalette(
  options: CommandPaletteOptions,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: (id: string | null) => void,
): CommandPalette {
  return new CommandPalette(options, theme, keybindings, done);
}
