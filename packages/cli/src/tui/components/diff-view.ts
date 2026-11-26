import type { Component } from "@earendil-works/pi-tui";
import {
  BORDERED_MIN_WIDTH,
  frameLines,
  isCloseInput,
  nextScrollOffset,
  parseScrollInput,
  scrollFooter,
  sliceViewport,
  viewportScrollbar,
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

export type DiffViewMode = "all" | "staged" | "unstaged" | "stat";

export type DiffViewAction = "commit" | "undo" | "review";

export interface DiffViewOptions {
  readonly title: string;
  readonly source: DiffViewSource;
  readonly maxLines?: number;
  readonly viewportHeight?: number;
  readonly initialMode?: DiffViewMode;
  readonly onAction?: (action: DiffViewAction) => void;
}

const DEFAULT_MAX_LINES = 240;
const MAX_UNTRACKED_PATHS = 30;
const DIFF_MODES: readonly DiffViewMode[] = [
  "all",
  "staged",
  "unstaged",
  "stat",
];

function styleDiffLine(line: string, theme: PanelTheme): string {
  if (
    line.startsWith("diff --git ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  ) {
    return theme.bold(theme.fg("text", line));
  }
  if (line.startsWith("@@")) {
    return theme.fg("accent", line);
  }
  if (line.startsWith("+")) {
    return theme.fg("success", line);
  }
  if (line.startsWith("-")) {
    return theme.fg("error", line);
  }
  if (line.startsWith("… diff truncated")) {
    return theme.fg("warning", line);
  }
  return line;
}

function cleanLine(line: string): string {
  return line.replaceAll("\t", "  ");
}

function textLines(value: string): string[] {
  const trimmed = value.trimEnd();
  return trimmed.length === 0
    ? []
    : trimmed.split("\n").map((line) => cleanLine(line));
}

function isInternalCodepunkPath(entry: string): boolean {
  const normalized = entry.replaceAll("\\", "/").replace(/^\.\//u, "");
  return normalized === ".codepunk" || normalized.startsWith(".codepunk/");
}

function filterStatusLines(status: string): {
  readonly visible: string[];
  readonly internalCount: number;
} {
  const visible: string[] = [];
  let internalCount = 0;
  for (const line of textLines(status)) {
    const match = /^\?\?\s+(.+)$/u.exec(line.trim());
    if (match !== null && isInternalCodepunkPath(match[1] ?? "")) {
      internalCount += 1;
      continue;
    }
    visible.push(line);
  }
  return { visible, internalCount };
}

/**
 * Project a WorkspaceDiff into display lines for the requested view mode.
 * The component deliberately does not import codepunk-core types; the command
 * side owns that projection.
 */
export function diffViewLines(
  options: DiffViewOptions,
  mode: DiffViewMode = options.initialMode ?? "all",
): string[] {
  const source = options.source;
  if (source.status.trim().length === 0) {
    return ["No changes."];
  }
  if (mode === "staged") {
    const staged = source.staged.trimEnd();
    if (staged.length === 0) {
      return ["No staged changes."];
    }
    const patchLines = staged.split("\n").map((line) => cleanLine(line));
    const limit = Math.max(
      1,
      Math.floor(options.maxLines ?? DEFAULT_MAX_LINES),
    );
    const lines = patchLines.slice(0, limit);
    if (patchLines.length > limit) {
      lines.push("", `… diff truncated (${patchLines.length - limit} lines)`);
    }
    return lines;
  }
  if (mode === "unstaged") {
    const unstaged = source.unstaged.trimEnd();
    if (unstaged.length === 0) {
      return ["No unstaged tracked changes."];
    }
    const patchLines = unstaged.split("\n").map((line) => cleanLine(line));
    const limit = Math.max(
      1,
      Math.floor(options.maxLines ?? DEFAULT_MAX_LINES),
    );
    const lines = patchLines.slice(0, limit);
    if (patchLines.length > limit) {
      lines.push("", `… diff truncated (${patchLines.length - limit} lines)`);
    }
    return lines;
  }

  const statusInfo = filterStatusLines(source.status);
  const lines = [...statusInfo.visible];
  const stat = textLines(source.stat);
  if (stat.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(...stat);
  }
  const allUntracked = source.untracked
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const workspaceUntracked = allUntracked.filter(
    (entry) => !isInternalCodepunkPath(entry),
  );
  const internalUntrackedCount =
    allUntracked.length - workspaceUntracked.length;
  if (workspaceUntracked.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(
      `untracked files (${workspaceUntracked.length}; no patch until staged):`,
    );
    const visible = workspaceUntracked.slice(0, MAX_UNTRACKED_PATHS);
    lines.push(...visible.map((file) => `  ${cleanLine(file)}`));
    if (workspaceUntracked.length > visible.length) {
      lines.push(`  … ${workspaceUntracked.length - visible.length} more`);
    }
  }
  const hiddenInternal = Math.max(
    statusInfo.internalCount,
    internalUntrackedCount,
  );
  if (mode === "stat") {
    if (lines.length === 0 && hiddenInternal > 0) {
      return [
        "No workspace changes.",
        `(${hiddenInternal} internal .codepunk/ file(s) omitted)`,
      ];
    }
    if (hiddenInternal > 0) {
      lines.push("", `(${hiddenInternal} internal .codepunk/ file(s) omitted)`);
    }
    return lines;
  }

  const patch = [source.staged.trimEnd(), source.unstaged.trimEnd()]
    .filter((entry) => entry.length > 0)
    .join("\n\n");
  if (patch.length === 0) {
    if (lines.length === 0 && hiddenInternal > 0) {
      return [
        "No workspace changes.",
        `(${hiddenInternal} internal .codepunk/ file(s) omitted)`,
      ];
    }
    if (hiddenInternal > 0) {
      lines.push("", `(${hiddenInternal} internal .codepunk/ file(s) omitted)`);
    }
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
  if (hiddenInternal > 0) {
    lines.push("", `(${hiddenInternal} internal .codepunk/ file(s) omitted)`);
  }
  return lines;
}

export class DiffView implements Component {
  private readonly options: DiffViewOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly onClose: () => void;
  private mode: DiffViewMode;
  private block: TextBlock;
  private rawLines: string[];
  private scrollOffset = 0;
  private lastTotalLines = 0;
  private lastRenderedBody: readonly string[] = [];
  private cachedKey = "";
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
    this.mode = options.initialMode ?? "all";
    this.rawLines = diffViewLines(options, this.mode);
    this.block = new TextBlock({
      lines: this.rawLines,
      style: (line) => styleDiffLine(line, this.theme),
    });
  }

  private setMode(nextMode: DiffViewMode): void {
    if (this.mode === nextMode) {
      return;
    }
    this.mode = nextMode;
    this.scrollOffset = 0;
    this.rawLines = diffViewLines(this.options, this.mode);
    this.block = new TextBlock({
      lines: this.rawLines,
      style: (line) => styleDiffLine(line, this.theme),
    });
    this.invalidate();
  }

  private renderTabBar(): string {
    const labels: Record<DiffViewMode, string> = {
      all: "All",
      staged: "Staged",
      unstaged: "Unstaged",
      stat: "Stat",
    };
    return DIFF_MODES.map((mode) =>
      mode === this.mode
        ? this.theme.bold(this.theme.fg("accent", `[${labels[mode]}]`))
        : this.theme.fg("muted", ` ${labels[mode]} `),
    ).join(" ");
  }

  private jumpSection(direction: 1 | -1): void {
    const targets: number[] = [];
    for (let i = 0; i < this.lastRenderedBody.length; i += 1) {
      const plain = this.lastRenderedBody[i]!.replace(/\u001b\[[0-9;]*m/gu, "");
      if (plain.startsWith("diff --git ") || plain.startsWith("@@")) {
        targets.push(i);
      }
    }
    if (targets.length === 0) {
      return;
    }
    if (direction > 0) {
      const next = targets.find((idx) => idx > this.scrollOffset);
      if (next !== undefined) {
        this.scrollOffset = next;
      }
    } else {
      for (let i = targets.length - 1; i >= 0; i -= 1) {
        if (targets[i]! < this.scrollOffset) {
          this.scrollOffset = targets[i]!;
          break;
        }
      }
    }
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const cacheKey = `${safeWidth}:${this.mode}:${this.scrollOffset}:${this.options.viewportHeight ?? "all"}`;
    if (this.cachedKey === cacheKey) {
      return this.cachedLines;
    }
    const inner = Math.max(
      1,
      safeWidth - (safeWidth < BORDERED_MIN_WIDTH ? 2 : 4),
    );
    const allBody = this.block.render(inner);
    this.lastRenderedBody = allBody;
    this.lastTotalLines = allBody.length;
    const viewport = sliceViewport(
      allBody,
      this.scrollOffset,
      this.options.viewportHeight,
    );
    this.scrollOffset = viewport.offset;
    const actionHints =
      this.options.onAction === undefined
        ? "tab view · [/] hunk · esc close"
        : "tab view · [/] hunk · c commit · r review · u undo · esc close";
    const footer = scrollFooter(actionHints, viewport) ?? actionHints;
    const scrollbar = viewportScrollbar(viewport);
    const rendered = frameLines(
      {
        title: this.options.title,
        body: [this.renderTabBar(), ...viewport.visible],
        footer,
        ...(scrollbar === undefined ? {} : { scrollbar }),
      },
      safeWidth,
      this.theme,
    );
    this.cachedKey = `${safeWidth}:${this.mode}:${this.scrollOffset}:${this.options.viewportHeight ?? "all"}`;
    this.cachedLines = rendered;
    return rendered;
  }

  handleInput(data: string): void {
    if (isCloseInput(data, this.keybindings)) {
      this.onClose();
      return;
    }
    if (data === "\t") {
      const next =
        DIFF_MODES[(DIFF_MODES.indexOf(this.mode) + 1) % DIFF_MODES.length] ??
        "all";
      this.setMode(next);
      return;
    }
    if (data === "]" || data === "n") {
      this.jumpSection(1);
      return;
    }
    if (data === "[" || data === "p") {
      this.jumpSection(-1);
      return;
    }
    if (this.options.onAction !== undefined) {
      if (data === "c") {
        this.options.onAction("commit");
        return;
      }
      if (data === "r") {
        this.options.onAction("review");
        return;
      }
      if (data === "u") {
        this.options.onAction("undo");
        return;
      }
    }
    if (this.options.viewportHeight === undefined) {
      return;
    }
    const direction = parseScrollInput(data);
    if (direction === null) {
      return;
    }
    this.scrollOffset = nextScrollOffset(
      this.scrollOffset,
      direction,
      this.lastTotalLines,
      this.options.viewportHeight,
    );
  }

  invalidate(): void {
    this.cachedKey = "";
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
