import type { Component } from "@earendil-works/pi-tui";
import {
  BORDERED_MIN_WIDTH,
  frameLines,
  isCloseInput,
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";
import { TextBlock } from "./text.ts";

export interface DiffViewSource {
  readonly root: string;
  readonly status: string;
  readonly stat: string;
  readonly staged: string;
  readonly unstaged: string;
  readonly untracked: readonly string[];
  readonly truncated: boolean;
}

export interface DiffViewOptions {
  readonly title: string;
  readonly source: DiffViewSource;
  readonly maxLines?: number;
}

const DEFAULT_MAX_LINES = 240;
const MAX_UNTRACKED_PATHS = 30;

function cleanLine(line: string): string {
  return line.replaceAll("\t", "  ");
}

function textLines(value: string): string[] {
  const trimmed = value.trimEnd();
  return trimmed.length === 0
    ? []
    : trimmed.split("\n").map((line) => cleanLine(line));
}

/**
 * Project a WorkspaceDiff into display lines. The component deliberately does
 * not import codepunk-core types; the command side owns that projection.
 */
export function diffViewLines(options: DiffViewOptions): string[] {
  const source = options.source;
  if (source.status.trim().length === 0) {
    return ["No changes."];
  }
  const lines = textLines(source.status);
  const stat = textLines(source.stat);
  if (stat.length > 0) {
    lines.push("", ...stat);
  }
  const untracked = source.untracked
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (untracked.length > 0) {
    lines.push(
      "",
      `untracked files (${untracked.length}; no patch until staged):`,
    );
    const visible = untracked.slice(0, MAX_UNTRACKED_PATHS);
    lines.push(...visible.map((file) => `  ${cleanLine(file)}`));
    if (untracked.length > visible.length) {
      lines.push(`  … ${untracked.length - visible.length} more`);
    }
  }
  const patch = [source.staged.trimEnd(), source.unstaged.trimEnd()]
    .filter((entry) => entry.length > 0)
    .join("\n\n");
  if (patch.length === 0) {
    if (source.truncated) {
      lines.push("", "… diff truncated (output limit reached)");
    }
    return lines;
  }
  const patchLines = patch.split("\n").map((line) => cleanLine(line));
  const limit = Math.max(1, Math.floor(options.maxLines ?? DEFAULT_MAX_LINES));
  lines.push("", ...patchLines.slice(0, limit));
  if (patchLines.length > limit) {
    lines.push("", `… diff truncated (${patchLines.length - limit} lines)`);
  } else if (source.truncated) {
    lines.push("", "… diff truncated (output limit reached)");
  }
  return lines;
}

export class DiffView implements Component {
  private readonly options: DiffViewOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly onClose: () => void;
  private readonly block: TextBlock;
  private cachedWidth = -1;
  private cachedLines: readonly string[] = [];

  constructor(
    options: DiffViewOptions,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    onClose: () => void,
  ) {
    this.options = options;
    this.theme = theme;
    this.keybindings = keybindings;
    this.onClose = onClose;
    this.block = new TextBlock({ lines: diffViewLines(options) });
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
        body: this.block.render(inner),
        footer: "esc close",
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
    this.block.invalidate();
  }
}

export function createDiffView(
  options: DiffViewOptions,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: () => void,
): DiffView {
  return new DiffView(options, theme, keybindings, done);
}
