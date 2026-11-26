import type { Component } from "@earendil-works/pi-tui";
import {
  WORKSPACE_TRUST_RESOURCE_KINDS,
  type WorkspaceTrustResourceKind,
} from "codepunk-core";
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

export type TrustGrantsMap = Record<WorkspaceTrustResourceKind, boolean>;

export interface TrustPanelOptions {
  readonly summaryLines: readonly string[];
  readonly initialGrants: TrustGrantsMap;
  readonly viewportHeight?: number;
}

const RESOURCE_DESCRIPTIONS: Record<WorkspaceTrustResourceKind, string> = {
  config: "project configuration overrides",
  policy: "project policy rules",
  skills: "project skill definitions",
  instructions: "repository instruction files",
};

export class TrustPanel implements Component {
  private readonly options: TrustPanelOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly done: (grants: TrustGrantsMap | null) => void;
  private readonly grants: TrustGrantsMap;
  private selectedIndex = 0;
  private cachedKey = "";
  private cachedLines: readonly string[] = [];

  constructor(
    options: TrustPanelOptions,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    done: (grants: TrustGrantsMap | null) => void,
  ) {
    this.options = options;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.grants = { ...options.initialGrants };
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const stateHash = WORKSPACE_TRUST_RESOURCE_KINDS.map((k) =>
      this.grants[k] ? "1" : "0",
    ).join("");
    const cacheKey = `${safeWidth}:${this.selectedIndex}:${stateHash}`;
    if (this.cachedKey === cacheKey) {
      return this.cachedLines;
    }
    const inner = Math.max(
      1,
      safeWidth - (safeWidth < BORDERED_MIN_WIDTH ? 2 : 4),
    );
    const summaryBlock = new TextBlock({
      lines: [...this.options.summaryLines],
      style: (line) => this.theme.fg("text", line),
    }).render(inner);

    const toggleRows: string[] = [
      "",
      this.theme.bold(
        this.theme.fg(
          "accent",
          "Saved resource grants (applies on next session)",
        ),
      ),
    ];
    for (const [index, kind] of WORKSPACE_TRUST_RESOURCE_KINDS.entries()) {
      const active = index === this.selectedIndex;
      const enabled = this.grants[kind];
      const prefix = active ? "▸ " : "  ";
      const box = enabled ? "[x]" : "[ ]";
      const stateText = enabled ? "allowed" : "skipped";
      const plain = `${prefix}${box} ${kind.padEnd(13)} ${stateText.padEnd(8)} · ${RESOURCE_DESCRIPTIONS[kind]}`;
      if (active) {
        toggleRows.push(this.theme.bold(this.theme.fg("accent", plain)));
      } else {
        const styledBox = this.theme.fg(enabled ? "success" : "muted", box);
        toggleRows.push(
          `${prefix}${styledBox} ${this.theme.fg("text", kind.padEnd(13))} ${this.theme.fg(enabled ? "success" : "warning", stateText.padEnd(8))} ${this.theme.fg("muted", `· ${RESOURCE_DESCRIPTIONS[kind]}`)}`,
        );
      }
    }

    const maxHeight = Math.max(
      10,
      this.options.viewportHeight ?? defaultViewportHeight(),
    );
    const summaryBudget = Math.max(4, maxHeight - toggleRows.length);
    const viewport = sliceViewport(summaryBlock, 0, summaryBudget);
    const scrollbar = viewportScrollbar(viewport);
    const rendered = frameLines(
      {
        title: "workspace trust",
        body: [...viewport.visible, ...toggleRows],
        footer:
          "↑/↓ move · space toggle · a all · n none · enter save · esc close",
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
    const total = WORKSPACE_TRUST_RESOURCE_KINDS.length;
    if (data === "\u001b[B" || data === "\u001bOB" || data === "j") {
      this.selectedIndex = (this.selectedIndex + 1) % total;
      return;
    }
    if (data === "\u001b[A" || data === "\u001bOA" || data === "k") {
      this.selectedIndex = (this.selectedIndex - 1 + total) % total;
      return;
    }
    if (data === " ") {
      const kind = WORKSPACE_TRUST_RESOURCE_KINDS[this.selectedIndex];
      if (kind !== undefined) {
        this.grants[kind] = !this.grants[kind];
      }
      return;
    }
    if (data === "a") {
      for (const kind of WORKSPACE_TRUST_RESOURCE_KINDS) {
        this.grants[kind] = true;
      }
      return;
    }
    if (data === "n") {
      for (const kind of WORKSPACE_TRUST_RESOURCE_KINDS) {
        this.grants[kind] = false;
      }
      return;
    }
    if (data === "\r" || data === "\n") {
      this.done({ ...this.grants });
    }
  }

  invalidate(): void {
    this.cachedKey = "";
    this.cachedLines = [];
  }
}

export function createTrustPanel(
  options: TrustPanelOptions,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: (grants: TrustGrantsMap | null) => void,
): TrustPanel {
  return new TrustPanel(options, theme, keybindings, done);
}
