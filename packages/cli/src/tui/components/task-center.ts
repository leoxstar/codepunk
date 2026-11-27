import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
  BORDERED_MIN_WIDTH,
  defaultViewportHeight,
  frameLines,
  isCloseInput,
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";

export type TaskKind = "subagent" | "background" | "side";

export interface TaskCenterEntry {
  readonly id: string;
  readonly kind: TaskKind;
  readonly status: string;
  readonly title: string;
  readonly detail: string;
  readonly running: boolean;
  readonly reviewable: boolean;
  readonly mergeable: boolean;
}

export type TaskCenterAction =
  | { readonly action: "inspect"; readonly entry: TaskCenterEntry }
  | { readonly action: "stop"; readonly entry: TaskCenterEntry }
  | { readonly action: "review"; readonly entry: TaskCenterEntry }
  | { readonly action: "merge"; readonly entry: TaskCenterEntry }
  | { readonly action: "discard"; readonly entry: TaskCenterEntry };

export interface TaskCenterOptions {
  readonly title: string;
  readonly entries: readonly TaskCenterEntry[];
  readonly viewportHeight?: number;
}

const FOOTER_EMPTY = "esc close";
const FOOTER_ACTIVE =
  "↑/↓ select · enter inspect · x stop · r review · m merge · d discard · esc close";

export class TaskCenter implements Component {
  private readonly options: TaskCenterOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly done: (result: TaskCenterAction | null) => void;
  private selectedIndex = 0;
  private scrollOffset = 0;
  private cachedKey = "";
  private cachedLines: readonly string[] = [];

  constructor(
    options: TaskCenterOptions,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    done: (result: TaskCenterAction | null) => void,
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
    const entries = this.options.entries;
    const body: string[] = [];
    if (entries.length === 0) {
      body.push(
        truncateToWidth(
          this.theme.fg(
            "muted",
            "No active or recent tasks. Start one with /subagent <task> or /btw <prompt>.",
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
      if (this.selectedIndex >= entries.length) {
        this.selectedIndex = entries.length - 1;
      }
      if (this.selectedIndex < this.scrollOffset) {
        this.scrollOffset = this.selectedIndex;
      } else if (this.selectedIndex >= this.scrollOffset + maxVisible) {
        this.scrollOffset = this.selectedIndex - maxVisible + 1;
      }
      const slice = entries.slice(
        this.scrollOffset,
        this.scrollOffset + maxVisible,
      );
      for (const [offset, entry] of slice.entries()) {
        const index = this.scrollOffset + offset;
        const selected = index === this.selectedIndex;
        const pointer = selected ? ">" : " ";
        const shortId = entry.id.slice(0, 10);
        const line = truncateToWidth(
          `${pointer} [${entry.kind}] ${shortId} · ${entry.status} · ${entry.title}`,
          inner,
          "…",
        );
        body.push(
          selected
            ? this.theme.bold(this.theme.fg("accent", line))
            : entry.running
              ? this.theme.fg("text", line)
              : this.theme.fg("muted", line),
        );
      }
      const current = entries[this.selectedIndex];
      if (current !== undefined && current.detail.length > 0) {
        body.push(
          "",
          truncateToWidth(
            this.theme.fg("muted", `next: ${current.detail}`),
            inner,
            "…",
          ),
        );
      }
    }
    const rendered = frameLines(
      {
        title: `${this.options.title} (${entries.length})`,
        body,
        footer: entries.length === 0 ? FOOTER_EMPTY : FOOTER_ACTIVE,
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
    const entries = this.options.entries;
    if (entries.length === 0) {
      return;
    }
    if (data === "\u001b[B" || data === "\u001bOB" || data === "j") {
      this.selectedIndex = (this.selectedIndex + 1) % entries.length;
      return;
    }
    if (data === "\u001b[A" || data === "\u001bOA" || data === "k") {
      this.selectedIndex =
        (this.selectedIndex - 1 + entries.length) % entries.length;
      return;
    }
    const current = entries[this.selectedIndex];
    if (current === undefined) {
      return;
    }
    if (data === "\r" || data === "\n" || data === "l") {
      this.done({ action: "inspect", entry: current });
      return;
    }
    if (data === "x") {
      this.done({ action: "stop", entry: current });
      return;
    }
    if (data === "r" && current.reviewable) {
      this.done({ action: "review", entry: current });
      return;
    }
    if (data === "m" && current.mergeable) {
      this.done({ action: "merge", entry: current });
      return;
    }
    if (data === "d" && current.kind === "subagent") {
      this.done({ action: "discard", entry: current });
    }
  }

  invalidate(): void {
    this.cachedKey = "";
    this.cachedLines = [];
  }
}

export function createTaskCenter(
  options: TaskCenterOptions,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: (result: TaskCenterAction | null) => void,
): TaskCenter {
  return new TaskCenter(options, theme, keybindings, done);
}
