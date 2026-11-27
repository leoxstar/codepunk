import type { ApprovalRequest } from "codepunk-protocol";
import type { Component } from "@earendil-works/pi-tui";
import { formatApproval, persistentApprovalPreview } from "../approval/text.ts";
import {
  BORDERED_MIN_WIDTH,
  frameLines,
  nextScrollOffset,
  parseScrollInput,
  sliceViewport,
  viewportScrollbar,
  type FrameTone,
  type PanelColor,
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";
import { TextBlock } from "./text.ts";

export interface ApprovalChoice {
  readonly key: string;
  readonly label: string;
  readonly decision: "allow" | "deny";
  readonly scope: "once" | "session" | "persistent";
  readonly unsandboxedOnce?: boolean;
  readonly guidance?: boolean;
}

export interface ApprovalCardOptions {
  readonly request: ApprovalRequest;
  readonly choices: readonly ApprovalChoice[];
  readonly workspaceTrusted: boolean;
  readonly viewportHeight?: number;
}

export type ApprovalRiskLevel = "low" | "medium" | "high";

interface ChoiceView {
  readonly choice: ApprovalChoice;
  readonly line: string;
}

const FOOTER_CHOICES = "↑/↓ move · enter confirm · esc cancel";
const FOOTER_PREVIEW = "enter/p confirm · esc back";
const HIGH_RISK_COMMAND =
  /\b(?:rm\s+-rf|sudo|mkfs|dd\s+if=|chmod\s+-R|chown\s+-R|curl\b|wget\b|git\s+(?:reset\s+--hard|push\s+.*--force|clean\s+-fd))\b/iu;

export function approvalRiskLevel(request: ApprovalRequest): ApprovalRiskLevel {
  const coverage = request.coverage_preview ?? "";
  const tool = request.tool ?? "";
  const command = request.command ?? "";
  if (
    tool.startsWith("mcp:") ||
    /no srt sandbox|uncovered/iu.test(coverage) ||
    HIGH_RISK_COMMAND.test(command)
  ) {
    return "high";
  }
  if (
    tool === "bash" ||
    command.length > 0 ||
    /outside|protected|sensitive|network|policy/iu.test(request.reason ?? "")
  ) {
    return "medium";
  }
  return "low";
}

function riskBadgeText(
  request: ApprovalRequest,
  risk: ApprovalRiskLevel,
): string {
  if (risk === "high") {
    if ((request.tool ?? "").startsWith("mcp:")) {
      return "[HIGH · MCP]";
    }
    if (/no srt sandbox|uncovered/iu.test(request.coverage_preview ?? "")) {
      return "[HIGH · UNCOVERED]";
    }
    return "[HIGH · SENSITIVE]";
  }
  if (risk === "medium") {
    return (request.command ?? "").length > 0
      ? "[MEDIUM · SHELL]"
      : "[MEDIUM · REVIEW]";
  }
  return "[LOW · WORKSPACE]";
}

function riskTone(risk: ApprovalRiskLevel): FrameTone {
  return risk === "high" ? "error" : risk === "medium" ? "warning" : "accent";
}

function riskColor(risk: ApprovalRiskLevel): PanelColor {
  return risk === "high" ? "error" : risk === "medium" ? "warning" : "success";
}

function choiceColor(choice: ApprovalChoice): PanelColor {
  if (choice.decision === "deny") {
    return choice.guidance ? "warning" : "error";
  }
  if (choice.unsandboxedOnce === true) {
    return "warning";
  }
  if (choice.scope === "persistent") {
    return "warning";
  }
  if (choice.scope === "session") {
    return "accent";
  }
  return "success";
}

function styleDetailLine(line: string, theme: PanelTheme): string {
  if (line === "Approval required") {
    return theme.bold(theme.fg("text", line));
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return theme.fg("success", line);
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return theme.fg("error", line);
  }
  if (line.startsWith("@@")) {
    return theme.fg("accent", line);
  }
  const keyMatch =
    /^(action|command|exact argv|cwd|path|why|coverage|arguments|proposed diff):(.*)$/u.exec(
      line,
    );
  if (keyMatch !== null) {
    const key = keyMatch[1];
    const value = keyMatch[2] ?? "";
    if (key === "coverage" && /no srt sandbox|uncovered/iu.test(value)) {
      return theme.fg("error", line);
    }
    if (key === "why") {
      return theme.fg("warning", line);
    }
    if (key === "command" || key === "path") {
      return theme.bold(theme.fg("text", line));
    }
    return theme.fg("text", line);
  }
  return line;
}

export class ApprovalCard implements Component {
  private readonly options: ApprovalCardOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly done: (choice: ApprovalChoice | null) => void;
  private readonly choices: readonly ApprovalChoice[];
  private readonly risk: ApprovalRiskLevel;
  private selectedIndex = 0;
  private detailScrollOffset = 0;
  private lastDetailTotal = 0;
  private lastDetailHeight = 0;
  private preview = false;
  private previewChoice: ApprovalChoice | null = null;
  private cachedKey = "";
  private cachedLines: readonly string[] = [];

  constructor(
    options: ApprovalCardOptions,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    done: (choice: ApprovalChoice | null) => void,
  ) {
    this.options = options;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.risk = approvalRiskLevel(options.request);
    const canPersistExact =
      options.request.argv !== undefined &&
      options.request.argv.length > 0 &&
      options.request.cwd !== undefined;
    this.choices = options.choices.filter((choice) =>
      choice.scope === "persistent"
        ? canPersistExact && options.workspaceTrusted
        : true,
    );
    this.selectedIndex = 0;
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const cacheKey = `${this.preview ? "preview" : "choices"}:${this.selectedIndex}:${this.detailScrollOffset}:${this.options.viewportHeight ?? "all"}:${safeWidth}`;
    if (this.cachedKey === cacheKey) {
      return this.cachedLines;
    }
    const inner = Math.max(
      1,
      safeWidth - (safeWidth < BORDERED_MIN_WIDTH ? 2 : 4),
    );
    const { body, footer, scrollbar } = this.preview
      ? this.previewView(inner)
      : this.choiceView(inner);
    const rendered = frameLines(
      {
        title: "codepunk approval",
        body,
        footer,
        tone: this.preview ? "warning" : riskTone(this.risk),
        ...(scrollbar === undefined ? {} : { scrollbar }),
      },
      safeWidth,
      this.theme,
    );
    this.cachedKey = `${this.preview ? "preview" : "choices"}:${this.selectedIndex}:${this.detailScrollOffset}:${this.options.viewportHeight ?? "all"}:${safeWidth}`;
    this.cachedLines = rendered;
    return rendered;
  }

  handleInput(data: string): void {
    if (this.preview) {
      if (data === "p" || data === "\r" || data === "\n") {
        this.done(this.previewChoice);
        return;
      }
      if (
        this.keybindings.matches(data, "tui.select.cancel") ||
        data === "\u001b"
      ) {
        this.preview = false;
        this.previewChoice = null;
      }
      return;
    }
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      data === "\u001b"
    ) {
      this.done(null);
      return;
    }
    if (
      this.lastDetailHeight > 0 &&
      this.lastDetailTotal > this.lastDetailHeight &&
      (data === "\u001b[5~" ||
        data === "\u001b[6~" ||
        data === "\u0015" ||
        data === "\u0004")
    ) {
      const direction = parseScrollInput(data);
      if (direction !== null) {
        this.detailScrollOffset = nextScrollOffset(
          this.detailScrollOffset,
          direction,
          this.lastDetailTotal,
          this.lastDetailHeight,
        );
        return;
      }
    }
    if (data === "\u001b[B" || data === "\u001bOB" || data === "j") {
      this.move(1);
      return;
    }
    if (data === "\u001b[A" || data === "\u001bOA" || data === "k") {
      this.move(-1);
      return;
    }
    if (data === "\r" || data === "\n") {
      const choice = this.choices[this.selectedIndex];
      if (choice !== undefined) {
        this.choose(choice);
      }
      return;
    }
    const direct = this.choices.find((choice) => choice.key === data);
    if (direct !== undefined) {
      this.choose(direct);
    }
  }

  invalidate(): void {
    this.cachedKey = "";
    this.cachedLines = [];
  }

  private move(delta: number): void {
    if (this.choices.length === 0) {
      return;
    }
    this.selectedIndex =
      (this.selectedIndex + delta + this.choices.length) % this.choices.length;
  }

  private choose(choice: ApprovalChoice): void {
    if (choice.scope === "persistent") {
      this.preview = true;
      this.previewChoice = choice;
      return;
    }
    this.done(choice);
  }

  private choiceView(inner: number): {
    readonly body: string[];
    readonly footer: string;
    readonly scrollbar: ReturnType<typeof viewportScrollbar>;
  } {
    const badge = this.theme.bold(
      this.theme.fg(
        riskColor(this.risk),
        riskBadgeText(this.options.request, this.risk),
      ),
    );
    const detailLines = [
      badge,
      ...new TextBlock({
        lines: formatApproval(this.options.request).split("\n"),
        style: (line) => styleDetailLine(line, this.theme),
      }).render(inner),
    ];
    const choiceSection: string[] = [""];
    if (!this.options.workspaceTrusted) {
      choiceSection.push(
        this.theme.fg(
          "warning",
          "workspace is untrusted; session approval stays in memory, persistent rules need /trust grant.",
        ),
      );
    }
    for (const [index, view] of this.choiceViews().entries()) {
      const active = index === this.selectedIndex;
      const color = choiceColor(view.choice);
      const prefix = active ? ">" : " ";
      if (active) {
        const line = `${prefix} ${view.line}`;
        choiceSection.push(this.theme.bold(this.theme.fg("accent", line)));
      } else {
        const styledKey = this.theme.bold(
          this.theme.fg(color, view.choice.key),
        );
        choiceSection.push(
          `${prefix} ${styledKey}  ${this.theme.fg("muted", view.choice.label)}`,
        );
      }
    }

    const totalBudget = this.options.viewportHeight;
    const detailBudget =
      totalBudget === undefined
        ? undefined
        : Math.max(4, totalBudget - choiceSection.length);
    const viewport = sliceViewport(
      detailLines,
      this.detailScrollOffset,
      detailBudget,
    );
    this.detailScrollOffset = viewport.offset;
    this.lastDetailTotal = viewport.total;
    this.lastDetailHeight = detailBudget ?? viewport.total;
    const footer = viewport.scrollable
      ? `details ${viewport.offset + 1}-${viewport.offset + viewport.visible.length}/${viewport.total} · PgUp/PgDn scroll · ${FOOTER_CHOICES}`
      : FOOTER_CHOICES;
    return {
      body: [...viewport.visible, ...choiceSection],
      footer,
      scrollbar: viewportScrollbar(viewport),
    };
  }

  private previewView(inner: number): {
    readonly body: string[];
    readonly footer: string;
    readonly scrollbar: undefined;
  } {
    return {
      body: [
        ...new TextBlock({
          lines: persistentApprovalPreview(this.options.request).split("\n"),
          style: (line) => styleDetailLine(line, this.theme),
        }).render(inner),
      ],
      footer: FOOTER_PREVIEW,
      scrollbar: undefined,
    };
  }

  private choiceViews(): ChoiceView[] {
    return this.choices.map((choice) => ({
      choice,
      line: `${choice.key}  ${choice.label}`,
    }));
  }
}

export function createApprovalCard(
  options: ApprovalCardOptions,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: (choice: ApprovalChoice | null) => void,
): ApprovalCard {
  return new ApprovalCard(options, theme, keybindings, done);
}
