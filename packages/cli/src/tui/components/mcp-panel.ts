import type { Component } from "@earendil-works/pi-tui";
import {
  BORDERED_MIN_WIDTH,
  frameLines,
  sliceViewport,
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";
import { TextBlock } from "./text.ts";

export interface McpPanelEntry {
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly target: string;
  readonly authState: string;
  readonly connected: boolean;
  readonly toolCount?: number;
}

export type McpPanelAction =
  | { readonly action: "add" }
  | { readonly action: "reload" }
  | { readonly action: "status"; readonly name?: string }
  | { readonly action: "login"; readonly name: string }
  | { readonly action: "logout"; readonly name: string }
  | { readonly action: "remove"; readonly name: string };

export interface McpPanelOptions {
  readonly title: string;
  readonly mcpStatus: string;
  readonly entries: readonly McpPanelEntry[];
  readonly viewportHeight?: number;
}

const DEFAULT_VIEWPORT_HEIGHT = 14;

export class McpPanel implements Component {
  private readonly options: McpPanelOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly done: (result: McpPanelAction | null) => void;
  private selectedIndex = 0;
  private scrollOffset = 0;
  private cachedKey = "";
  private cachedLines: readonly string[] = [];

  constructor(
    options: McpPanelOptions,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    done: (result: McpPanelAction | null) => void,
  ) {
    this.options = options;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const maxLines = Math.max(
      6,
      this.options.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT,
    );
    const cacheKey = `${safeWidth}:${this.selectedIndex}:${this.scrollOffset}:${maxLines}`;
    if (this.cachedKey === cacheKey) {
      return this.cachedLines;
    }
    const inner = Math.max(
      1,
      safeWidth - (safeWidth < BORDERED_MIN_WIDTH ? 2 : 4),
    );
    const bodyLines: string[] = [
      this.theme.fg(
        "muted",
        `runtime status: ${this.options.mcpStatus} · servers: ${this.options.entries.length}`,
      ),
      "",
    ];
    if (this.options.entries.length === 0) {
      bodyLines.push(
        ...new TextBlock({
          lines: [
            "No user MCP servers configured. Press 'a' to add one, or run `codepunk mcp add`.",
          ],
        }).render(inner),
      );
    } else {
      for (let i = 0; i < this.options.entries.length; i += 1) {
        const entry = this.options.entries[i]!;
        const active = i === this.selectedIndex;
        const prefix = active ? "→ " : "  ";
        const stateBadge = entry.connected
          ? entry.toolCount !== undefined
            ? `connected (${entry.toolCount} tools)`
            : "connected"
          : "configured";
        const line1 = `${prefix}${entry.name} [${entry.transport}] · ${stateBadge}`;
        const line2 = `    ${entry.target} · ${entry.authState}`;
        bodyLines.push(
          ...new TextBlock({
            lines: [line1],
            ...(active
              ? {
                  style: (line: string) =>
                    this.theme.bold(this.theme.fg("accent", line)),
                }
              : {}),
          }).render(inner),
        );
        bodyLines.push(
          ...new TextBlock({
            lines: [line2],
            style: (line: string) => this.theme.fg("muted", line),
          }).render(inner),
        );
      }
    }
    const viewport = sliceViewport(bodyLines, this.scrollOffset, maxLines);
    this.scrollOffset = viewport.offset;
    const scrollHint = viewport.scrollable
      ? `lines ${viewport.offset + 1}-${viewport.offset + viewport.visible.length}/${viewport.total} · `
      : "";
    const selected = this.options.entries[this.selectedIndex];
    const footer =
      selected === undefined
        ? "a add · r reload · esc close"
        : `${scrollHint}↑/↓ select · a add · r reload · s status${
            selected.transport === "http" ? " · l login · o logout" : ""
          } · d remove · esc close`;
    const rendered = frameLines(
      {
        title: this.options.title,
        body: viewport.visible,
        footer,
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
      this.done(null);
      return;
    }
    if (data === "a") {
      this.done({ action: "add" });
      return;
    }
    if (data === "r") {
      this.done({ action: "reload" });
      return;
    }
    const entries = this.options.entries;
    if (entries.length === 0) {
      return;
    }
    if (data === "\u001b[B" || data === "\u001bOB" || data === "j") {
      this.selectedIndex = (this.selectedIndex + 1) % entries.length;
      this.scrollOffset = Math.max(0, this.selectedIndex * 2);
      this.invalidate();
      return;
    }
    if (data === "\u001b[A" || data === "\u001bOA" || data === "k") {
      this.selectedIndex =
        (this.selectedIndex - 1 + entries.length) % entries.length;
      this.scrollOffset = Math.max(0, this.selectedIndex * 2);
      this.invalidate();
      return;
    }
    const current = entries[this.selectedIndex];
    if (current === undefined) {
      return;
    }
    if (data === "s" || data === "\r" || data === "\n") {
      this.done({ action: "status", name: current.name });
      return;
    }
    if (data === "l" && current.transport === "http") {
      this.done({ action: "login", name: current.name });
      return;
    }
    if (data === "o" && current.transport === "http") {
      this.done({ action: "logout", name: current.name });
      return;
    }
    if (data === "d" || data === "x") {
      this.done({ action: "remove", name: current.name });
    }
  }

  invalidate(): void {
    this.cachedKey = "";
    this.cachedLines = [];
  }
}

export function createMcpPanel(
  options: McpPanelOptions,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: (result: McpPanelAction | null) => void,
): McpPanel {
  return new McpPanel(options, theme, keybindings, done);
}
