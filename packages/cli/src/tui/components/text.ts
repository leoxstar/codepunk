import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";

export interface TextBlockOptions {
  readonly lines: readonly string[];
  readonly style?: (line: string) => string;
}

/**
 * A width-safe text block. It wraps each logical line before styling so a
 * caller cannot accidentally produce a line wider than the viewport.
 */
export class TextBlock implements Component {
  private readonly options: TextBlockOptions;
  private cachedWidth = -1;
  private cachedLines: readonly string[] = [];

  constructor(options: TextBlockOptions) {
    this.options = options;
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    if (this.cachedWidth === safeWidth) {
      return this.cachedLines;
    }
    const rendered: string[] = [];
    for (const line of this.options.lines) {
      for (const logical of line.split("\n")) {
        if (visibleWidth(logical) === 0) {
          rendered.push("");
          continue;
        }
        for (const wrapped of wrapTextWithAnsi(logical, safeWidth)) {
          const clipped = truncateToWidth(wrapped, safeWidth);
          rendered.push(
            this.options.style === undefined
              ? clipped
              : this.options.style(clipped),
          );
        }
      }
    }
    this.cachedWidth = safeWidth;
    this.cachedLines = rendered;
    return rendered;
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = [];
  }
}
