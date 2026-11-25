import {
  fuzzyFilter,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  BORDERED_MIN_WIDTH,
  defaultViewportHeight,
  frameLines,
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";

export interface SessionPickerItem {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly pinned: boolean;
  readonly current: boolean;
  readonly label: string;
}

export interface SessionPickerOptions {
  readonly title: string;
  readonly items: readonly SessionPickerItem[];
  readonly viewportHeight?: number;
}

const FOOTER_TEXT = "type to filter · ↑/↓ move · enter resume · esc cancel";

export class SessionPicker implements Component {
  private readonly options: SessionPickerOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly done: (sessionId: string | null) => void;
  private query = "";
  private selectedIndex = 0;
  private scrollOffset = 0;
  private cachedKey = "";
  private cachedLines: readonly string[] = [];

  constructor(
    options: SessionPickerOptions,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    done: (sessionId: string | null) => void,
  ) {
    this.options = options;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
  }

  private filteredItems(): readonly SessionPickerItem[] {
    const trimmed = this.query.trim();
    if (trimmed.length === 0) {
      return this.options.items;
    }
    return fuzzyFilter(
      [...this.options.items],
      trimmed,
      (item) => `${item.title} ${item.id} ${item.label}`,
    );
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const key = `${safeWidth}:${this.query}:${this.selectedIndex}:${this.scrollOffset}`;
    if (this.cachedKey === key) {
      return this.cachedLines;
    }
    const inner = Math.max(
      1,
      safeWidth - (safeWidth < BORDERED_MIN_WIDTH ? 2 : 4),
    );
    const items = this.filteredItems();
    if (this.selectedIndex >= items.length) {
      this.selectedIndex = Math.max(0, items.length - 1);
    }
    const maxVisible = Math.max(
      3,
      (this.options.viewportHeight ?? defaultViewportHeight()) - 3,
    );
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + maxVisible) {
      this.scrollOffset = this.selectedIndex - maxVisible + 1;
    }
    const body: string[] = [
      truncateToWidth(
        `${this.theme.fg("accent", "Search:")} ${this.query || this.theme.fg("muted", "(all sessions)")}`,
        inner,
        "…",
      ),
      "",
    ];
    if (items.length === 0) {
      body.push(
        truncateToWidth(
          this.theme.fg("muted", "No matching sessions."),
          inner,
          "…",
        ),
      );
    } else {
      const slice = items.slice(
        this.scrollOffset,
        this.scrollOffset + maxVisible,
      );
      for (const [offset, item] of slice.entries()) {
        const index = this.scrollOffset + offset;
        const selected = index === this.selectedIndex;
        const prefix = selected ? "> " : "  ";
        const line = truncateToWidth(`${prefix}${item.label}`, inner, "…");
        body.push(
          selected
            ? this.theme.bold(this.theme.fg("accent", line))
            : item.current
              ? this.theme.fg("text", line)
              : this.theme.fg("muted", line),
        );
      }
      if (items.length > maxVisible) {
        const start = this.scrollOffset + 1;
        const end = Math.min(items.length, this.scrollOffset + slice.length);
        body.push(
          "",
          truncateToWidth(
            this.theme.fg(
              "muted",
              `showing ${start}-${end} of ${items.length}`,
            ),
            inner,
            "…",
          ),
        );
      }
    }
    const rendered = frameLines(
      {
        title: `${this.options.title} (${items.length})`,
        body,
        footer: FOOTER_TEXT,
      },
      safeWidth,
      this.theme,
    );
    this.cachedKey = key;
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
    const items = this.filteredItems();
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
    if (data === "\r" || data === "\n") {
      const selected = items[this.selectedIndex];
      this.done(selected?.id ?? null);
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

export function createSessionPicker(
  options: SessionPickerOptions,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: (sessionId: string | null) => void,
): SessionPicker {
  return new SessionPicker(options, theme, keybindings, done);
}
