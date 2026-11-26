import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
  BORDERED_MIN_WIDTH,
  defaultViewportHeight,
  frameLines,
  isCloseInput,
  sliceViewport,
  viewportScrollbar,
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";
import { TextBlock } from "./text.ts";

export interface CapabilityItem {
  readonly label: string;
  readonly badge?: string;
  readonly detail?: string;
}

export type CapabilityPanelAction = "reload" | "toggle-plugins" | null;

export interface CapabilitiesPanelOptions {
  readonly title: string;
  readonly summary: string;
  readonly items: readonly CapabilityItem[];
  readonly emptyText: string;
  readonly notes: readonly string[];
  readonly allowPluginToggle?: boolean;
  readonly pluginsEnabled?: boolean;
  readonly viewportHeight?: number;
}

export class CapabilitiesPanel implements Component {
  private readonly options: CapabilitiesPanelOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly done: (action: CapabilityPanelAction) => void;
  private selectedIndex = 0;
  private scrollOffset = 0;
  private cachedKey = "";
  private cachedLines: readonly string[] = [];

  constructor(
    options: CapabilitiesPanelOptions,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    done: (action: CapabilityPanelAction) => void,
  ) {
    this.options = options;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const maxHeight = Math.max(
      8,
      this.options.viewportHeight ?? defaultViewportHeight(),
    );
    const cacheKey = `${safeWidth}:${this.selectedIndex}:${this.scrollOffset}:${maxHeight}`;
    if (this.cachedKey === cacheKey) {
      return this.cachedLines;
    }
    const inner = Math.max(
      1,
      safeWidth - (safeWidth < BORDERED_MIN_WIDTH ? 2 : 4),
    );
    const lines: string[] = [
      this.theme.bold(this.theme.fg("text", this.options.summary)),
      "",
    ];
    if (this.options.items.length === 0) {
      lines.push(this.theme.fg("muted", `  ${this.options.emptyText}`));
    } else {
      for (const [index, item] of this.options.items.entries()) {
        const active = index === this.selectedIndex;
        const prefix = active ? "▸ " : "  ";
        const badge = item.badge ? `[${item.badge}] ` : "";
        const headline = truncateToWidth(
          `${prefix}${badge}${item.label}`,
          inner,
          "…",
        );
        lines.push(
          active
            ? this.theme.bold(this.theme.fg("accent", headline))
            : this.theme.fg("text", headline),
        );
        if (item.detail !== undefined && item.detail.length > 0) {
          lines.push(
            truncateToWidth(
              this.theme.fg("muted", `    ${item.detail}`),
              inner,
              "…",
            ),
          );
        }
      }
    }
    if (this.options.notes.length > 0) {
      lines.push(
        "",
        ...new TextBlock({
          lines: [...this.options.notes],
          style: (line) => this.theme.fg("muted", line),
        }).render(inner),
      );
    }
    const viewport = sliceViewport(lines, this.scrollOffset, maxHeight);
    this.scrollOffset = viewport.offset;
    const scrollbar = viewportScrollbar(viewport);
    const toggleHint = this.options.allowPluginToggle
      ? this.options.pluginsEnabled
        ? "e disable plugins · "
        : "e enable plugins · "
      : "";
    const footer = `${toggleHint}r reload · esc close`;
    const rendered = frameLines(
      {
        title: this.options.title,
        body: viewport.visible,
        footer,
        tone: "accent",
        ...(scrollbar === undefined ? {} : { scrollbar }),
      },
      safeWidth,
      this.theme,
    );
    this.cachedKey = cacheKey;
    this.cachedLines = rendered;
    return rendered;
  }

  handleInput(data: string): void {
    if (isCloseInput(data, this.keybindings)) {
      this.done(null);
      return;
    }
    if (data === "r") {
      this.done("reload");
      return;
    }
    if (data === "e" && this.options.allowPluginToggle) {
      this.done("toggle-plugins");
      return;
    }
    const total = this.options.items.length;
    if (total === 0) {
      return;
    }
    if (data === "\u001b[B" || data === "\u001bOB" || data === "j") {
      this.selectedIndex = (this.selectedIndex + 1) % total;
      this.scrollOffset = Math.max(0, this.selectedIndex * 2);
      return;
    }
    if (data === "\u001b[A" || data === "\u001bOA" || data === "k") {
      this.selectedIndex = (this.selectedIndex - 1 + total) % total;
      this.scrollOffset = Math.max(0, this.selectedIndex * 2);
    }
  }

  invalidate(): void {
    this.cachedKey = "";
    this.cachedLines = [];
  }
}

export function createCapabilitiesPanel(
  options: CapabilitiesPanelOptions,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: (action: CapabilityPanelAction) => void,
): CapabilitiesPanel {
  return new CapabilitiesPanel(options, theme, keybindings, done);
}
