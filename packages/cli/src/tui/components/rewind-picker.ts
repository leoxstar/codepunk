import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
  BORDERED_MIN_WIDTH,
  defaultViewportHeight,
  frameLines,
  isCloseInput,
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";

export interface RewindCheckpointItem {
  readonly id: string;
  readonly tool: "write" | "edit" | "bash" | "shadow";
  readonly displayTarget: string;
  readonly createdAt: string;
  readonly stepsBack: number;
  readonly source?: "checkpoint" | "shadow";
}

export type RewindSelection =
  | {
      readonly mode: "files";
      readonly stepsBack: number;
      readonly source?: "checkpoint" | "shadow";
    }
  | { readonly mode: "tree" }
  | {
      readonly mode: "both";
      readonly stepsBack: number;
      readonly source?: "checkpoint" | "shadow";
    };

export interface RewindPickerOptions {
  readonly title: string;
  readonly items: readonly RewindCheckpointItem[];
  readonly viewportHeight?: number;
}

const FOOTER_ITEMS =
  "↑/↓ select · enter/f restore files · b restore files + open branch tree · t branch tree only · esc close";
const FOOTER_EMPTY = "t open branch tree · esc close";

export class RewindPicker implements Component {
  private readonly options: RewindPickerOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly done: (selection: RewindSelection | null) => void;
  private selectedIndex = 0;
  private scrollOffset = 0;
  private cachedKey = "";
  private cachedLines: readonly string[] = [];

  constructor(
    options: RewindPickerOptions,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    done: (selection: RewindSelection | null) => void,
  ) {
    this.options = options;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const key = `${safeWidth}:${this.selectedIndex}:${this.scrollOffset}`;
    if (this.cachedKey === key) {
      return this.cachedLines;
    }
    const inner = Math.max(
      1,
      safeWidth - (safeWidth < BORDERED_MIN_WIDTH ? 2 : 4),
    );
    const items = this.options.items;
    const body: string[] = [];
    if (items.length === 0) {
      body.push(
        truncateToWidth(
          this.theme.fg(
            "muted",
            "No applied file checkpoints in this session. Press t to open the session branch tree.",
          ),
          inner,
          "…",
        ),
      );
    } else {
      const maxVisible = Math.max(
        3,
        (this.options.viewportHeight ?? defaultViewportHeight()) - 2,
      );
      if (this.selectedIndex >= items.length) {
        this.selectedIndex = items.length - 1;
      }
      if (this.selectedIndex < this.scrollOffset) {
        this.scrollOffset = this.selectedIndex;
      } else if (this.selectedIndex >= this.scrollOffset + maxVisible) {
        this.scrollOffset = this.selectedIndex - maxVisible + 1;
      }
      const slice = items.slice(
        this.scrollOffset,
        this.scrollOffset + maxVisible,
      );
      for (const [offset, item] of slice.entries()) {
        const index = this.scrollOffset + offset;
        const selected = index === this.selectedIndex;
        const pointer = selected ? ">" : " ";
        const stamp = item.createdAt.slice(11, 19);
        const line = truncateToWidth(
          `${pointer} -${item.stepsBack}  [${item.tool}] ${item.displayTarget} · ${stamp}`,
          inner,
          "…",
        );
        body.push(
          selected
            ? this.theme.bold(this.theme.fg("accent", line))
            : this.theme.fg("text", line),
        );
      }
    }
    const rendered = frameLines(
      {
        title: `${this.options.title} (${items.length})`,
        body,
        footer: items.length === 0 ? FOOTER_EMPTY : FOOTER_ITEMS,
      },
      safeWidth,
      this.theme,
    );
    this.cachedKey = key;
    this.cachedLines = rendered;
    return rendered;
  }

  handleInput(data: string): void {
    if (isCloseInput(data, this.keybindings)) {
      this.done(null);
      return;
    }
    if (data === "t") {
      this.done({ mode: "tree" });
      return;
    }
    const items = this.options.items;
    if (items.length === 0) {
      return;
    }
    if (data === "\u001b[B" || data === "\u001bOB" || data === "j") {
      this.selectedIndex = (this.selectedIndex + 1) % items.length;
      return;
    }
    if (data === "\u001b[A" || data === "\u001bOA" || data === "k") {
      this.selectedIndex =
        (this.selectedIndex - 1 + items.length) % items.length;
      return;
    }
    const chosen = items[this.selectedIndex];
    if (chosen === undefined) {
      return;
    }
    if (data === "\r" || data === "\n" || data === "f") {
      this.done({
        mode: "files",
        stepsBack: chosen.stepsBack,
        ...(chosen.source === undefined ? {} : { source: chosen.source }),
      });
      return;
    }
    if (data === "b") {
      this.done({
        mode: "both",
        stepsBack: chosen.stepsBack,
        ...(chosen.source === undefined ? {} : { source: chosen.source }),
      });
    }
  }

  invalidate(): void {
    this.cachedKey = "";
    this.cachedLines = [];
  }
}

export function createRewindPicker(
  options: RewindPickerOptions,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: (selection: RewindSelection | null) => void,
): RewindPicker {
  return new RewindPicker(options, theme, keybindings, done);
}
