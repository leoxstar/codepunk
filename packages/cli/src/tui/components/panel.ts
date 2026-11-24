import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  BORDERED_MIN_WIDTH,
  frameLines,
  isCloseInput,
  type PanelKeybindings,
  type PanelTheme,
  type PanelTone,
} from "./frame.ts";
import { TextBlock } from "./text.ts";

export type { PanelKeybindings, PanelTheme, PanelTone } from "./frame.ts";

export interface PanelSection {
  readonly label: string;
  readonly lines: readonly string[];
  readonly tone?: PanelTone;
}

export interface PanelOptions {
  readonly title: string;
  readonly sections: readonly PanelSection[];
  readonly footer?: string;
}

const TONE_COLOR: Record<PanelTone, "text" | "muted" | "warning" | "error"> = {
  default: "text",
  muted: "muted",
  warning: "warning",
  error: "error",
};

export class Panel implements Component {
  private readonly options: PanelOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly onClose: () => void;
  private readonly blocks: readonly TextBlock[];
  private cachedWidth = -1;
  private cachedLines: readonly string[] = [];

  constructor(
    options: PanelOptions,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    onClose: () => void,
  ) {
    this.options = options;
    this.theme = theme;
    this.keybindings = keybindings;
    this.onClose = onClose;
    this.blocks = options.sections.map((section) => {
      const color = TONE_COLOR[section.tone ?? "default"];
      return new TextBlock({
        lines: section.lines,
        style: (line) => this.theme.fg(color, line),
      });
    });
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    if (this.cachedWidth === safeWidth) {
      return this.cachedLines;
    }
    const rendered = frameLines(
      {
        title: this.options.title,
        body: this.bodyLines(safeWidth),
        ...(this.options.footer === undefined
          ? {}
          : { footer: this.options.footer }),
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
    for (const block of this.blocks) {
      block.invalidate();
    }
  }

  private bodyLines(width: number): string[] {
    const inner = Math.max(1, width - (width < BORDERED_MIN_WIDTH ? 2 : 4));
    const lines: string[] = [];
    for (const [index, section] of this.options.sections.entries()) {
      lines.push(this.theme.bold(this.theme.fg("accent", section.label)));
      const block = this.blocks[index];
      if (block === undefined) {
        continue;
      }
      const content = block.render(inner);
      if (
        content.length === 0 ||
        content.every((line) => visibleWidth(line) === 0)
      ) {
        lines.push(this.theme.fg("muted", "(none)"));
        continue;
      }
      lines.push(...content);
    }
    return lines;
  }
}
