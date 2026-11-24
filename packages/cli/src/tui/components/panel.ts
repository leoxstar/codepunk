import {
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { TextBlock } from "./text.ts";

export type PanelTone = "default" | "muted" | "warning" | "error";

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

export interface PanelTheme {
  bold(text: string): string;
  fg(
    color: "text" | "muted" | "warning" | "error" | "accent" | "border",
    text: string,
  ): string;
}

export interface PanelKeybindings {
  matches(data: string, keybinding: "tui.select.cancel"): boolean;
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
    const rendered =
      safeWidth < 12
        ? this.renderNarrow(safeWidth)
        : this.renderBordered(safeWidth);
    this.cachedWidth = safeWidth;
    this.cachedLines = rendered;
    return rendered;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel") || data === "q") {
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

  private renderBordered(width: number): string[] {
    const lines: string[] = [this.topBorder(width)];
    this.options.sections.forEach((section, index) => {
      if (index > 0) {
        lines.push(this.frameLine("", width));
      }
      lines.push(
        this.frameLine(
          this.theme.bold(this.theme.fg("accent", section.label)),
          width,
        ),
      );
      const block = this.blocks[index];
      if (block === undefined) {
        return;
      }
      const content = block.render(Math.max(1, width - 4));
      if (
        content.length === 0 ||
        content.every((line) => visibleWidth(line) === 0)
      ) {
        lines.push(this.frameLine(this.theme.fg("muted", "(none)"), width));
        return;
      }
      for (const line of content) {
        lines.push(this.frameLine(line, width));
      }
    });
    if (this.options.footer !== undefined) {
      lines.push(this.divider(width));
      lines.push(
        this.frameLine(this.theme.fg("muted", this.options.footer), width),
      );
    }
    lines.push(this.bottomBorder(width));
    return lines;
  }

  private renderNarrow(width: number): string[] {
    const lines: string[] = [
      truncateToWidth(
        this.theme.bold(this.theme.fg("accent", this.options.title)),
        width,
      ),
    ];
    this.options.sections.forEach((section, index) => {
      if (index > 0) {
        lines.push("");
      }
      lines.push(
        truncateToWidth(
          this.theme.bold(this.theme.fg("accent", section.label)),
          width,
        ),
      );
      const block = this.blocks[index];
      if (block === undefined) {
        return;
      }
      const content = block.render(Math.max(1, width - 2));
      if (
        content.length === 0 ||
        content.every((line) => visibleWidth(line) === 0)
      ) {
        lines.push(truncateToWidth(this.theme.fg("muted", "  (none)"), width));
        return;
      }
      for (const line of content) {
        lines.push(truncateToWidth(`  ${line}`, width));
      }
    });
    if (this.options.footer !== undefined) {
      lines.push("");
      lines.push(
        truncateToWidth(this.theme.fg("muted", this.options.footer), width),
      );
    }
    return lines.map((line) => truncateToWidth(line, width));
  }

  private topBorder(width: number): string {
    const label = truncateToWidth(
      `─ ${this.options.title} `,
      Math.max(1, width - 2),
      "…",
    );
    const fill = Math.max(0, width - 2 - visibleWidth(label));
    return this.theme.fg("border", `┌${label}${"─".repeat(fill)}┐`);
  }

  private divider(width: number): string {
    return this.theme.fg("border", `├${"─".repeat(Math.max(0, width - 2))}┤`);
  }

  private bottomBorder(width: number): string {
    return this.theme.fg("border", `└${"─".repeat(Math.max(0, width - 2))}┘`);
  }

  private frameLine(content: string, width: number): string {
    const inner = Math.max(1, width - 4);
    const body = truncateToWidth(content, inner, "…", true);
    return `${this.theme.fg("border", "│")} ${body} ${this.theme.fg("border", "│")}`;
  }
}
