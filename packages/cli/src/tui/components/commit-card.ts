import type { Component } from "@earendil-works/pi-tui";
import type { GitCommitStage, WorkspaceCommitPreview } from "codepunk-core";
import {
  BORDERED_MIN_WIDTH,
  defaultViewportHeight,
  frameLines,
  sliceViewport,
  viewportScrollbar,
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";
import { TextBlock } from "./text.ts";

export interface CommitScopeChoice {
  readonly label: string;
  readonly value: GitCommitStage;
}

export interface CommitCardOptions {
  readonly message: string;
  readonly preview: WorkspaceCommitPreview;
  readonly choices: readonly CommitScopeChoice[];
  readonly viewportHeight?: number;
}

export class CommitCard implements Component {
  private readonly options: CommitCardOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly done: (stage: GitCommitStage | null) => void;
  private selectedIndex = 0;
  private step: "scope" | "confirm" = "scope";
  private cachedKey = "";
  private cachedLines: readonly string[] = [];

  constructor(
    options: CommitCardOptions,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    done: (stage: GitCommitStage | null) => void,
  ) {
    this.options = options;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
  }

  private previewSummaryLines(): string[] {
    const p = this.options.preview;
    const head = p.head === null ? "(unborn)" : p.head.slice(0, 12);
    const lines = [
      `branch: ${p.branch ?? "(detached)"} · HEAD: ${head}`,
      `subject: ${this.options.message.split(/\r?\n/u)[0] ?? this.options.message}`,
      `files: staged ${p.staged.length} · unstaged ${p.unstaged.length} · untracked ${p.untracked.length}`,
    ];
    const shown = [
      ...p.staged.slice(0, 5).map((f) => `  + staged     ${f}`),
      ...p.unstaged.slice(0, 5).map((f) => `  ~ unstaged   ${f}`),
      ...p.untracked.slice(0, 5).map((f) => `  ? untracked  ${f}`),
    ];
    if (shown.length > 0) {
      lines.push("", ...shown);
    }
    const stat = [p.staged_stat, p.unstaged_stat]
      .filter((s) => s.trim().length > 0)
      .join("\n");
    if (stat.length > 0) {
      lines.push("", ...stat.split("\n").slice(0, 8));
    }
    return lines;
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const cacheKey = `${safeWidth}:${this.step}:${this.selectedIndex}`;
    if (this.cachedKey === cacheKey) {
      return this.cachedLines;
    }
    const inner = Math.max(
      1,
      safeWidth - (safeWidth < BORDERED_MIN_WIDTH ? 2 : 4),
    );
    const summaryLines = new TextBlock({
      lines: this.previewSummaryLines(),
      style: (line) => {
        if (line.startsWith("  + staged")) {
          return this.theme.fg("success", line);
        }
        if (line.startsWith("  ~ unstaged")) {
          return this.theme.fg("warning", line);
        }
        if (line.startsWith("  ? untracked")) {
          return this.theme.fg("muted", line);
        }
        if (line.startsWith("subject:")) {
          return this.theme.bold(this.theme.fg("text", line));
        }
        return this.theme.fg("text", line);
      },
    }).render(inner);
    const maxHeight = Math.max(
      10,
      this.options.viewportHeight ?? defaultViewportHeight(),
    );
    const footerLines: string[] = [""];
    if (this.step === "scope") {
      for (const [index, choice] of this.options.choices.entries()) {
        const active = index === this.selectedIndex;
        const prefix = active ? "▸ " : "  ";
        footerLines.push(
          active
            ? this.theme.bold(
                this.theme.fg("accent", `${prefix}${choice.label}`),
              )
            : this.theme.fg("muted", `${prefix}${choice.label}`),
        );
      }
    } else {
      const chosen = this.options.choices[this.selectedIndex];
      footerLines.push(
        this.theme.bold(
          this.theme.fg(
            "warning",
            `Create this commit? (${chosen?.label ?? "selected"})`,
          ),
        ),
        this.theme.fg("muted", "  Enter to create commit · Esc to go back"),
      );
    }
    const detailBudget = Math.max(4, maxHeight - footerLines.length);
    const viewport = sliceViewport(summaryLines, 0, detailBudget);
    const scrollbar = viewportScrollbar(viewport);
    const rendered = frameLines(
      {
        title: this.step === "scope" ? "Commit scope" : "Create this commit?",
        body: [...viewport.visible, ...footerLines],
        footer:
          this.step === "scope"
            ? "↑/↓ select scope · enter continue · esc cancel"
            : "enter create commit · esc back",
        tone: this.step === "scope" ? "accent" : "warning",
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
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      data === "\u001b" ||
      data === "q"
    ) {
      if (this.step === "confirm") {
        this.step = "scope";
        return;
      }
      this.done(null);
      return;
    }
    if (this.step === "confirm") {
      if (data === "\r" || data === "\n" || data === "y") {
        this.done(this.options.choices[this.selectedIndex]?.value ?? null);
      }
      return;
    }
    const total = this.options.choices.length;
    if (total === 0) {
      return;
    }
    if (data === "\u001b[B" || data === "\u001bOB" || data === "j") {
      this.selectedIndex = (this.selectedIndex + 1) % total;
      return;
    }
    if (data === "\u001b[A" || data === "\u001bOA" || data === "k") {
      this.selectedIndex = (this.selectedIndex - 1 + total) % total;
      return;
    }
    if (data === "\r" || data === "\n") {
      this.step = "confirm";
    }
  }

  invalidate(): void {
    this.cachedKey = "";
    this.cachedLines = [];
  }
}

export function createCommitCard(
  options: CommitCardOptions,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: (stage: GitCommitStage | null) => void,
): CommitCard {
  return new CommitCard(options, theme, keybindings, done);
}
