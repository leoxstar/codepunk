import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

const SUMMARY_WIDTH = 180;

export interface RendererResultContext {
  readonly args: unknown;
  readonly cwd: string;
  readonly isError: boolean;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function oneLine(value: string, width = SUMMARY_WIDTH): string {
  const line = value.replace(/\s+/gu, " ").trim();
  return line.length === 0 ? "" : truncateToWidth(line, width, "…");
}

export function textContent(result: AgentToolResult<unknown>): string {
  for (const item of result.content) {
    if (item.type === "text") {
      return item.text;
    }
  }
  return "";
}

export function structuredResult(
  result: AgentToolResult<unknown>,
): Record<string, unknown> | null {
  return asRecord(result.structuredContent) ?? asRecord(result.details);
}

export function markerSummary(text: string): {
  readonly total: number;
  readonly completed: number;
  readonly inProgress: number;
} {
  let total = 0;
  let completed = 0;
  let inProgress = 0;
  for (const line of text.split(/\r?\n/u)) {
    const marker = /^\[([x> ])\]\s+/u.exec(line.trim());
    if (marker === null) {
      continue;
    }
    total += 1;
    if (marker[1] === "x") {
      completed += 1;
    } else if (marker[1] === ">") {
      inProgress += 1;
    }
  }
  return { total, completed, inProgress };
}

export function shortHash(value: unknown): string | null {
  const raw = stringValue(value);
  if (raw.length === 0) {
    return null;
  }
  const hash = raw.startsWith("sha256:") ? raw.slice("sha256:".length) : raw;
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

export function setComponentText(
  context: { readonly lastComponent: Component | undefined },
  content: string,
): Component {
  if (context.lastComponent instanceof RendererText) {
    context.lastComponent.setText(content);
    return context.lastComponent;
  }
  const text = new RendererText();
  text.setText(content);
  return text;
}

class RendererText implements Component {
  private readonly text = new Text("", 0, 0);
  private cachedWidth = -1;
  private cachedLines: readonly string[] = [];

  setText(content: string): void {
    this.text.setText(content);
    this.cachedWidth = -1;
    this.cachedLines = [];
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    if (this.cachedWidth === safeWidth) {
      return this.cachedLines;
    }
    const rendered = this.text
      .render(safeWidth)
      .map((line) => truncateToWidth(line, safeWidth));
    this.cachedWidth = safeWidth;
    this.cachedLines = rendered;
    return rendered;
  }

  invalidate(): void {
    this.text.invalidate();
    this.cachedWidth = -1;
    this.cachedLines = [];
  }
}

export function heading(theme: Theme, name: string): string {
  return theme.fg("toolTitle", theme.bold(name));
}

export function muted(theme: Theme, text: string): string {
  return theme.fg("muted", text);
}

export function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function failureText(
  theme: Theme,
  name: string,
  result: AgentToolResult<unknown>,
): string {
  const message = oneLine(textContent(result)) || "tool failed";
  return `${heading(theme, name)} ${theme.fg("error", "failed")} · ${muted(theme, message)}`;
}
