import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { EvidenceRecord } from "codepunk-protocol";
import {
  BORDERED_MIN_WIDTH,
  defaultViewportHeight,
  frameLines,
  isCloseInput,
  sliceViewport,
  viewportScrollbar,
  type PanelColor,
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";
import { TextBlock } from "./text.ts";

export type EvidenceFilter = "all" | "denied" | "uncovered";

export interface EvidenceInspectorOptions {
  readonly records: readonly EvidenceRecord[];
  readonly head: string | null;
  readonly viewportHeight?: number;
}

const FILTERS: readonly EvidenceFilter[] = ["all", "denied", "uncovered"];

function decisionColor(decision: string): PanelColor {
  if (decision === "deny") {
    return "error";
  }
  if (decision === "ask") {
    return "warning";
  }
  return "success";
}

function recordSummary(record: EvidenceRecord): string {
  if (record.command !== null && record.command.length > 0) {
    return record.command;
  }
  if (
    record.path_check.target !== null &&
    record.path_check.target.length > 0
  ) {
    return record.path_check.target;
  }
  return record.rule;
}

export class EvidenceInspector implements Component {
  private readonly options: EvidenceInspectorOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly onClose: () => void;
  private filter: EvidenceFilter = "all";
  private selectedIndex = 0;
  private scrollOffset = 0;
  private inspecting = false;
  private cachedKey = "";
  private cachedLines: readonly string[] = [];

  constructor(
    options: EvidenceInspectorOptions,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    onClose: () => void,
  ) {
    this.options = options;
    this.theme = theme;
    this.keybindings = keybindings;
    this.onClose = onClose;
  }

  private filtered(): readonly EvidenceRecord[] {
    if (this.filter === "denied") {
      return this.options.records.filter(
        (record) => record.decision === "deny" || record.outcome === "denied",
      );
    }
    if (this.filter === "uncovered") {
      return this.options.records.filter(
        (record) => record.coverage === "uncovered",
      );
    }
    return this.options.records;
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const records = this.filtered();
    if (this.selectedIndex >= records.length) {
      this.selectedIndex = Math.max(0, records.length - 1);
    }
    const maxHeight = Math.max(
      6,
      this.options.viewportHeight ?? defaultViewportHeight(),
    );
    const cacheKey = `${safeWidth}:${this.filter}:${this.selectedIndex}:${this.scrollOffset}:${this.inspecting}:${maxHeight}`;
    if (this.cachedKey === cacheKey) {
      return this.cachedLines;
    }
    const inner = Math.max(
      1,
      safeWidth - (safeWidth < BORDERED_MIN_WIDTH ? 2 : 4),
    );
    if (this.inspecting && records[this.selectedIndex] !== undefined) {
      const rendered = this.renderDetail(
        records[this.selectedIndex]!,
        safeWidth,
        inner,
        maxHeight,
      );
      this.cachedKey = cacheKey;
      this.cachedLines = rendered;
      return rendered;
    }

    const header =
      this.options.records.length === 0
        ? this.theme.fg("muted", "No evidence in the current run.")
        : this.theme.fg(
            "muted",
            `${this.options.records.length} evidence record(s); head ${this.options.head ? this.options.head.slice(0, 16) : "none"} · filter: ${this.filter}`,
          );
    const listHeight = Math.max(3, maxHeight - 2);
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + listHeight) {
      this.scrollOffset = this.selectedIndex - listHeight + 1;
    }
    const rows =
      records.length === 0
        ? this.options.records.length === 0
          ? []
          : [this.theme.fg("muted", `No ${this.filter} evidence records.`)]
        : records.map((record, index) => {
            const active = index === this.selectedIndex;
            const prefix = active ? "▸ " : "  ";
            const seq = `#${String(record.seq).padStart(3, "0")}`;
            const dec = record.decision.padEnd(5);
            const cov =
              record.coverage === "uncovered" ? "uncovered" : record.coverage;
            const summary = recordSummary(record).replace(/\s+/gu, " ");
            const text = `${prefix}${seq} ${record.tool.padEnd(10)} ${dec} ${cov.padEnd(9)} ${summary}`;
            const clipped = truncateToWidth(text, inner, "…");
            if (active) {
              return this.theme.bold(this.theme.fg("accent", clipped));
            }
            const styledDec = this.theme.fg(
              decisionColor(record.decision),
              dec,
            );
            const styledCov =
              record.coverage === "uncovered"
                ? this.theme.fg("warning", cov.padEnd(9))
                : this.theme.fg("muted", cov.padEnd(9));
            return truncateToWidth(
              `${this.theme.fg("muted", `${prefix}${seq}`)} ${this.theme.fg("text", record.tool.padEnd(10))} ${styledDec} ${styledCov} ${this.theme.fg("muted", summary)}`,
              inner,
              "…",
            );
          });
    const viewport = sliceViewport(rows, this.scrollOffset, listHeight);
    this.scrollOffset = viewport.offset;
    const scrollbar = viewportScrollbar(viewport);
    const footer =
      this.options.records.length === 0
        ? "esc close"
        : "↑/↓ select · enter details · f filter · esc close";
    const rendered = frameLines(
      {
        title: "codepunk evidence",
        body: [header, ...(rows.length > 0 ? ["", ...viewport.visible] : [])],
        footer,
        tone: "accent",
        ...(scrollbar === undefined ? {} : { scrollbar }),
      },
      safeWidth,
      this.theme,
    );
    this.cachedKey = `${safeWidth}:${this.filter}:${this.selectedIndex}:${this.scrollOffset}:${this.inspecting}:${maxHeight}`;
    this.cachedLines = rendered;
    return rendered;
  }

  private renderDetail(
    record: EvidenceRecord,
    safeWidth: number,
    inner: number,
    maxHeight: number,
  ): readonly string[] {
    const lines = [
      `seq: #${record.seq} · tool: ${record.tool} · outcome: ${record.outcome ?? "recorded"}`,
      `decision: ${record.decision} · rule: ${record.rule}`,
      `coverage: ${record.coverage} (${record.coverage_basis.join(", ") || "none"})`,
      `sandbox: ${record.sandbox.backend} · duration: ${record.duration_ms ?? 0} ms · exit: ${record.exit_code ?? "n/a"}`,
      ...(record.command !== null ? [`command: ${record.command}`] : []),
      ...(record.path_check.target !== null
        ? [`target: ${record.path_check.target}`]
        : []),
      `cwd: ${record.cwd}`,
      `id: ${record.id}${record.output_sha256 ? ` · output: ${record.output_sha256.slice(0, 20)}` : ""}`,
      ...(record.output_preview.length > 0
        ? [
            "",
            "output preview:",
            ...record.output_preview.split("\n").slice(0, 12),
          ]
        : []),
    ];
    const body = new TextBlock({
      lines,
      style: (line) => {
        if (line.startsWith("decision: deny")) {
          return this.theme.fg("error", line);
        }
        if (line.startsWith("coverage: uncovered")) {
          return this.theme.fg("warning", line);
        }
        return this.theme.fg("text", line);
      },
    }).render(inner);
    const viewport = sliceViewport(body, 0, maxHeight);
    const scrollbar = viewportScrollbar(viewport);
    return frameLines(
      {
        title: `Evidence #${record.seq} · ${record.tool}`,
        body: viewport.visible,
        footer: "esc back to list",
        tone: record.decision === "deny" ? "error" : "accent",
        ...(scrollbar === undefined ? {} : { scrollbar }),
      },
      safeWidth,
      this.theme,
    );
  }

  handleInput(data: string): void {
    if (isCloseInput(data, this.keybindings)) {
      if (this.inspecting) {
        this.inspecting = false;
        return;
      }
      this.onClose();
      return;
    }
    if (this.inspecting) {
      return;
    }
    if (data === "f" || data === "\t") {
      this.filter =
        FILTERS[(FILTERS.indexOf(this.filter) + 1) % FILTERS.length] ?? "all";
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      return;
    }
    const records = this.filtered();
    if (records.length === 0) {
      return;
    }
    if (data === "\u001b[B" || data === "\u001bOB" || data === "j") {
      this.selectedIndex = (this.selectedIndex + 1) % records.length;
      return;
    }
    if (data === "\u001b[A" || data === "\u001bOA" || data === "k") {
      this.selectedIndex =
        (this.selectedIndex - 1 + records.length) % records.length;
      return;
    }
    if (data === "\r" || data === "\n") {
      this.inspecting = true;
    }
  }

  invalidate(): void {
    this.cachedKey = "";
    this.cachedLines = [];
  }
}

export function createEvidenceInspector(
  options: EvidenceInspectorOptions,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: () => void,
): EvidenceInspector {
  return new EvidenceInspector(options, theme, keybindings, done);
}
