import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";

export interface TableColumn {
  readonly label: string;
  readonly align?: "left" | "right";
  readonly minWidth?: number;
  readonly maxWidth?: number;
}

export interface TableOptions {
  readonly columns: readonly TableColumn[];
  readonly rows: readonly (readonly string[])[];
  readonly emptyText?: string;
  readonly overflowText?: string;
}

const COLUMN_SEPARATOR = " │ ";
const COLUMN_SEPARATOR_WIDTH = 3;
const MIN_COLUMN_WIDTH = 1;
const COMPACT_MIN_WIDTH = 12;

export class Table implements Component {
  private readonly options: TableOptions;
  private cachedWidth = -1;
  private cachedLines: readonly string[] = [];

  constructor(options: TableOptions) {
    this.options = options;
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    if (this.cachedWidth === safeWidth) {
      return this.cachedLines;
    }
    const rendered = this.renderLines(safeWidth);
    this.cachedWidth = safeWidth;
    this.cachedLines = rendered;
    return rendered;
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = [];
  }

  private renderLines(width: number): string[] {
    const columns = this.options.columns;
    if (columns.length === 0) {
      return [];
    }
    const rows = this.options.rows.filter((row) => row.length > 0);
    if (rows.length === 0) {
      return this.renderEmpty(width);
    }
    const minimumTableWidth =
      columns.length * 4 + (columns.length - 1) * COLUMN_SEPARATOR_WIDTH;
    if (width < COMPACT_MIN_WIDTH || width < minimumTableWidth) {
      return this.renderList(width, rows);
    }
    const widths = this.columnWidths(width, rows);
    const available = width - (columns.length - 1) * COLUMN_SEPARATOR_WIDTH;
    if (widths.reduce((total, entry) => total + entry, 0) > available) {
      return this.renderList(width, rows);
    }
    const lines = [
      this.formatRow(
        columns.map((column) => column.label.toUpperCase()),
        widths,
      ),
      widths.map((entry) => "─".repeat(entry)).join("─┼─"),
    ];
    for (const row of rows) {
      lines.push(this.formatRow(row, widths));
    }
    if (this.options.overflowText !== undefined) {
      for (const wrapped of wrapTextWithAnsi(
        this.options.overflowText,
        width,
      )) {
        lines.push(truncateToWidth(wrapped, width));
      }
    }
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderEmpty(width: number): string[] {
    const text = this.options.emptyText ?? "(none)";
    const lines: string[] = [];
    for (const paragraph of text.split("\n")) {
      if (visibleWidth(paragraph) === 0) {
        lines.push("");
        continue;
      }
      for (const wrapped of wrapTextWithAnsi(paragraph, width)) {
        lines.push(truncateToWidth(wrapped, width));
      }
    }
    return lines;
  }

  private renderList(
    width: number,
    rows: readonly (readonly string[])[],
  ): string[] {
    const lines: string[] = [];
    rows.forEach((row, rowIndex) => {
      if (rowIndex > 0) {
        lines.push("");
      }
      this.options.columns.forEach((column, columnIndex) => {
        const label = column.label.toLowerCase();
        for (const wrapped of wrapTextWithAnsi(
          `${label}: ${row[columnIndex] ?? ""}`,
          width,
        )) {
          lines.push(truncateToWidth(wrapped, width));
        }
      });
    });
    if (this.options.overflowText !== undefined) {
      lines.push("");
      for (const wrapped of wrapTextWithAnsi(
        this.options.overflowText,
        width,
      )) {
        lines.push(truncateToWidth(wrapped, width));
      }
    }
    return lines;
  }

  private columnWidths(
    width: number,
    rows: readonly (readonly string[])[],
  ): number[] {
    const minimums = this.options.columns.map((column) =>
      Math.max(
        MIN_COLUMN_WIDTH,
        Math.floor(column.minWidth ?? MIN_COLUMN_WIDTH),
      ),
    );
    const maximums = this.options.columns.map((column, index) => {
      const maximum =
        column.maxWidth === undefined
          ? Number.MAX_SAFE_INTEGER
          : Math.max(
              minimums[index] ?? MIN_COLUMN_WIDTH,
              Math.floor(column.maxWidth),
            );
      return maximum;
    });
    const widths = this.options.columns.map((column, index) => {
      const content = rows.reduce(
        (widest, row) => Math.max(widest, visibleWidth(row[index] ?? "")),
        visibleWidth(column.label),
      );
      return Math.max(
        minimums[index] ?? MIN_COLUMN_WIDTH,
        Math.min(content, maximums[index] ?? Number.MAX_SAFE_INTEGER),
      );
    });
    let total =
      widths.reduce((sum, entry) => sum + entry, 0) +
      (widths.length - 1) * COLUMN_SEPARATOR_WIDTH;
    while (total > width) {
      let widestIndex = -1;
      let widest = 0;
      widths.forEach((entry, index) => {
        if (entry > (minimums[index] ?? MIN_COLUMN_WIDTH) && entry > widest) {
          widest = entry;
          widestIndex = index;
        }
      });
      if (widestIndex === -1) {
        break;
      }
      widths[widestIndex] = (widths[widestIndex] ?? MIN_COLUMN_WIDTH) - 1;
      total -= 1;
    }
    return widths;
  }

  private formatRow(
    cells: readonly string[],
    widths: readonly number[],
  ): string {
    const parts = this.options.columns.map((column, index) => {
      const columnWidth = widths[index] ?? MIN_COLUMN_WIDTH;
      const clipped = truncateToWidth(cells[index] ?? "", columnWidth, "…");
      const padding = " ".repeat(
        Math.max(0, columnWidth - visibleWidth(clipped)),
      );
      return column.align === "right"
        ? `${padding}${clipped}`
        : `${clipped}${padding}`;
    });
    return parts.join(COLUMN_SEPARATOR).replace(/\s+$/u, "");
  }
}
