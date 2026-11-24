import type { ApprovalRequest } from "codepunk-protocol";
import type { Component } from "@earendil-works/pi-tui";
import { formatApproval, persistentApprovalPreview } from "../approval/text.ts";
import {
  BORDERED_MIN_WIDTH,
  frameLines,
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";
import { TextBlock } from "./text.ts";

export interface ApprovalChoice {
  readonly key: string;
  readonly label: string;
  readonly decision: "allow" | "deny";
  readonly scope: "once" | "session" | "persistent";
  readonly guidance?: boolean;
  readonly requiresTrust?: boolean;
}

export interface ApprovalCardOptions {
  readonly request: ApprovalRequest;
  readonly choices: readonly ApprovalChoice[];
  readonly workspaceTrusted: boolean;
}

interface ChoiceView {
  readonly choice: ApprovalChoice;
  readonly line: string;
}

const FOOTER_CHOICES = "↑/↓ move · enter confirm · esc cancel";
const FOOTER_PREVIEW = "enter/p confirm · esc back";

export class ApprovalCard implements Component {
  private readonly options: ApprovalCardOptions;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly done: (choice: ApprovalChoice | null) => void;
  private readonly choices: readonly ApprovalChoice[];
  private selectedIndex = 0;
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
    const canReuseExact =
      options.request.argv !== undefined &&
      options.request.argv.length > 0 &&
      options.request.cwd !== undefined;
    this.choices = options.choices.filter(
      (choice) =>
        choice.requiresTrust !== true ||
        (canReuseExact && options.workspaceTrusted),
    );
    const denyIndex = this.choices.findIndex(
      (choice) => choice.decision === "deny" && choice.guidance !== true,
    );
    this.selectedIndex = denyIndex === -1 ? 0 : denyIndex;
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const cacheKey = `${this.preview ? "preview" : "choices"}:${this.selectedIndex}:${safeWidth}`;
    if (this.cachedKey === cacheKey) {
      return this.cachedLines;
    }
    const inner = Math.max(
      1,
      safeWidth - (safeWidth < BORDERED_MIN_WIDTH ? 2 : 4),
    );
    const body = this.preview
      ? this.previewBody(inner)
      : this.choiceBody(inner);
    const rendered = frameLines(
      {
        title: "codepunk approval",
        body,
        footer: this.preview ? FOOTER_PREVIEW : FOOTER_CHOICES,
      },
      safeWidth,
      this.theme,
    );
    this.cachedKey = cacheKey;
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

  private choiceBody(inner: number): string[] {
    const body = [
      ...new TextBlock({
        lines: formatApproval(this.options.request).split("\n"),
      }).render(inner),
    ];
    body.push("");
    if (!this.options.workspaceTrusted) {
      body.push(
        'workspace is untrusted; only "Allow once" is available for this call.',
      );
    }
    for (const [index, view] of this.choiceViews().entries()) {
      const line = `${index === this.selectedIndex ? ">" : " "} ${view.line}`;
      body.push(
        index === this.selectedIndex
          ? this.theme.bold(this.theme.fg("accent", line))
          : this.theme.fg("muted", line),
      );
    }
    return body;
  }

  private previewBody(inner: number): string[] {
    return [
      ...new TextBlock({
        lines: persistentApprovalPreview(this.options.request).split("\n"),
      }).render(inner),
    ];
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
