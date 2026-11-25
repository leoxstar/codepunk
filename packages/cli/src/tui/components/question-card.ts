import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { AskUserAnswer, AskUserRequest } from "codepunk-core";
import {
  BORDERED_MIN_WIDTH,
  frameLines,
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";
import { TextBlock } from "./text.ts";

const FOOTER_OPTIONS = "↑/↓ or 1-9 select · enter confirm · esc cancel";
const FOOTER_FREEFORM = "type answer · enter submit · esc back";

export class QuestionCard implements Component {
  private readonly request: AskUserRequest;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly done: (answer: AskUserAnswer) => void;
  private selectedIndex = 0;
  private editingFreeform = false;
  private freeformText = "";
  private cachedKey = "";
  private cachedLines: readonly string[] = [];

  constructor(
    request: AskUserRequest,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    done: (answer: AskUserAnswer) => void,
  ) {
    this.request = request;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
  }

  private totalChoices(): number {
    return this.request.options.length + (this.request.allowFreeform ? 1 : 0);
  }

  private isFreeformRow(index: number): boolean {
    return this.request.allowFreeform && index === this.request.options.length;
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const key = `${safeWidth}:${this.selectedIndex}:${this.editingFreeform}:${this.freeformText}`;
    if (this.cachedKey === key) {
      return this.cachedLines;
    }
    const inner = Math.max(
      1,
      safeWidth - (safeWidth < BORDERED_MIN_WIDTH ? 2 : 4),
    );
    const body = [
      ...new TextBlock({
        lines: this.request.question.split("\n"),
        style: (line) => this.theme.bold(this.theme.fg("text", line)),
      }).render(inner),
      "",
    ];
    if (this.editingFreeform) {
      body.push(
        truncateToWidth(
          `${this.theme.fg("accent", "Answer:")} ${this.freeformText || this.theme.fg("muted", "(type your response)")}`,
          inner,
          "…",
        ),
      );
    } else {
      this.request.options.forEach((option, index) => {
        const selected = index === this.selectedIndex;
        const prefix = selected ? ">" : " ";
        const headline = truncateToWidth(
          `${prefix} ${index + 1}. ${option.label}`,
          inner,
          "…",
        );
        body.push(
          selected
            ? this.theme.bold(this.theme.fg("accent", headline))
            : this.theme.fg("text", headline),
        );
        if (option.description !== undefined) {
          body.push(
            truncateToWidth(
              this.theme.fg("muted", `     ${option.description}`),
              inner,
              "…",
            ),
          );
        }
      });
      if (this.request.allowFreeform) {
        const freeformIndex = this.request.options.length;
        const selected = freeformIndex === this.selectedIndex;
        const prefix = selected ? ">" : " ";
        const label = truncateToWidth(
          `${prefix} ${freeformIndex + 1}. Other (type custom answer)…`,
          inner,
          "…",
        );
        body.push(
          selected
            ? this.theme.bold(this.theme.fg("accent", label))
            : this.theme.fg("muted", label),
        );
      }
    }
    const rendered = frameLines(
      {
        title: "codepunk question",
        body,
        footer: this.editingFreeform ? FOOTER_FREEFORM : FOOTER_OPTIONS,
      },
      safeWidth,
      this.theme,
    );
    this.cachedKey = key;
    this.cachedLines = rendered;
    return rendered;
  }

  handleInput(data: string): void {
    if (this.editingFreeform) {
      this.handleFreeformInput(data);
      return;
    }
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      data === "\u001b"
    ) {
      this.done({
        cancelled: true,
        selectedIndex: null,
        selectedLabel: null,
        freeformText: null,
      });
      return;
    }
    const total = this.totalChoices();
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
      this.confirmIndex(this.selectedIndex);
      return;
    }
    if (/^[1-9]$/u.test(data)) {
      const index = Number(data) - 1;
      if (index < total) {
        this.confirmIndex(index);
      }
    }
  }

  invalidate(): void {
    this.cachedKey = "";
    this.cachedLines = [];
  }

  private confirmIndex(index: number): void {
    if (this.isFreeformRow(index)) {
      this.editingFreeform = true;
      return;
    }
    const option = this.request.options[index];
    if (option === undefined) {
      return;
    }
    this.done({
      cancelled: false,
      selectedIndex: index,
      selectedLabel: option.label,
      freeformText: null,
    });
  }

  private handleFreeformInput(data: string): void {
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      data === "\u001b"
    ) {
      this.editingFreeform = false;
      return;
    }
    if (data === "\r" || data === "\n") {
      const text = this.freeformText.trim();
      if (text.length === 0) {
        return;
      }
      this.done({
        cancelled: false,
        selectedIndex: null,
        selectedLabel: null,
        freeformText: text,
      });
      return;
    }
    if (data === "\u007f" || data === "\b") {
      this.freeformText = this.freeformText.slice(0, -1);
      return;
    }
    if (
      data.length > 0 &&
      !data.startsWith("\u001b") &&
      !/[\u0000-\u001f\u007f]/u.test(data)
    ) {
      this.freeformText += data;
    }
  }
}

export function createQuestionCard(
  request: AskUserRequest,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: (answer: AskUserAnswer) => void,
): QuestionCard {
  return new QuestionCard(request, theme, keybindings, done);
}
