import {
  fuzzyFilter,
  truncateToWidth,
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

export interface MemoryEntryItem {
  readonly id: string;
  readonly scope: "user" | "project";
  readonly content: string;
  readonly updatedAt?: string;
}

export type MemoryBrowserAction =
  | {
      readonly action: "archive";
      readonly id: string;
      readonly scope: "user" | "project";
    }
  | {
      readonly action: "delete";
      readonly id: string;
      readonly scope: "user" | "project";
    }
  | { readonly action: "add" };

export interface MemoryBrowserOptions {
  readonly entries: readonly MemoryEntryItem[];
  readonly viewportHeight?: number;
}

export class MemoryBrowser implements Component {
  private readonly options: MemoryBrowserOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly done: (action: MemoryBrowserAction | null) => void;
  private query = "";
  private selectedIndex = 0;
  private scrollOffset = 0;
  private cachedKey = "";
  private cachedLines: readonly string[] = [];

  constructor(
    options: MemoryBrowserOptions,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    done: (action: MemoryBrowserAction | null) => void,
  ) {
    this.options = options;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
  }

  private filtered(): readonly MemoryEntryItem[] {
    const trimmed = this.query.trim();
    if (trimmed.length === 0) {
      return this.options.entries;
    }
    return fuzzyFilter(
      [...this.options.entries],
      trimmed,
      (item) => `${item.scope} ${item.id} ${item.content}`,
    );
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const listHeight = Math.max(
      4,
      (this.options.viewportHeight ?? defaultViewportHeight()) - 2,
    );
    const items = this.filtered();
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
      `${this.theme.fg("accent", "Filter:")} ${this.query || this.theme.fg("muted", "(type to filter; Ctrl+N add · Ctrl+A archive · Ctrl+D delete)")}`,
      inner,
      "…",
    );
    const rows =
      items.length === 0
        ? [
            this.theme.fg(
              "muted",
              this.options.entries.length === 0
                ? "No memory records saved. Use Ctrl+N or /remember <text>."
                : "No memory records matched.",
            ),
          ]
        : items.map((item, index) => {
            const active = index === this.selectedIndex;
            const prefix = active ? "▸ " : "  ";
            const badge = `[${item.scope}]`;
            const plain = `${prefix}${badge} ${item.content} (${item.id})`;
            const clipped = truncateToWidth(plain, inner, "…");
            if (active) {
              return this.theme.bold(this.theme.fg("accent", clipped));
            }
            const styledBadge = this.theme.fg(
              item.scope === "project" ? "accent" : "success",
              badge,
            );
            return truncateToWidth(
              `${prefix}${styledBadge} ${this.theme.fg("text", item.content)} ${this.theme.fg("muted", `(${item.id})`)}`,
              inner,
              "…",
            );
          });
    const viewport = sliceViewport(rows, this.scrollOffset, listHeight);
    this.scrollOffset = viewport.offset;
    const scrollbar = viewportScrollbar(viewport);
    const rendered = frameLines(
      {
        title: `codepunk memory (${items.length})`,
        body: [searchBar, "", ...viewport.visible],
        footer:
          items.length === 0
            ? "ctrl+n remember · esc close"
            : "↑/↓ select · ctrl+n add · ctrl+a archive · ctrl+d delete · esc close",
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

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      data === "\u001b"
    ) {
      this.done(null);
      return;
    }
    if (data === "\u000e") {
      this.done({ action: "add" });
      return;
    }
    const items = this.filtered();
    const selected = items[this.selectedIndex];
    if (data === "\u0001" && selected !== undefined) {
      this.done({ action: "archive", id: selected.id, scope: selected.scope });
      return;
    }
    if (data === "\u0004" && selected !== undefined) {
      this.done({ action: "delete", id: selected.id, scope: selected.scope });
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

export function createMemoryBrowser(
  options: MemoryBrowserOptions,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: (action: MemoryBrowserAction | null) => void,
): MemoryBrowser {
  return new MemoryBrowser(options, theme, keybindings, done);
}
