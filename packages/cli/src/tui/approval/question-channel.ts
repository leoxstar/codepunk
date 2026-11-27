import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AskUserAnswer,
  AskUserChannel,
  AskUserRequest,
} from "codepunk-core";
import { startAttentionBellTimer } from "./attention-bell.ts";

export class TuiQuestionChannel implements AskUserChannel {
  readonly isTTY: boolean;
  private context: ExtensionContext | null = null;

  constructor(isTTY = process.stdin.isTTY === true) {
    this.isTTY = isTTY;
  }

  attach(context: ExtensionContext): void {
    this.context = context;
  }

  async ask(request: AskUserRequest): Promise<AskUserAnswer | null> {
    if (!this.isTTY || this.context === null) {
      return null;
    }
    const stopBell = startAttentionBellTimer({ isTTY: this.isTTY });
    try {
      return await this.askInternal(request);
    } finally {
      stopBell();
    }
  }

  private async askInternal(
    request: AskUserRequest,
  ): Promise<AskUserAnswer | null> {
    if (this.context === null) {
      return null;
    }
    const ui = this.context.ui;
    if (typeof ui.custom === "function") {
      try {
        const { createQuestionCard } =
          await import("../components/question-card.ts");
        const answer = await ui.custom<AskUserAnswer>(
          (_tui, theme, keybindings, done) =>
            createQuestionCard(request, theme, keybindings, done),
        );
        if (answer !== undefined) {
          return answer;
        }
      } catch {
        // Fall back to select below.
      }
    }
    const labels = [
      ...request.options.map((opt, idx) =>
        opt.description
          ? `${idx + 1}. ${opt.label} — ${opt.description}`
          : `${idx + 1}. ${opt.label}`,
      ),
      ...(request.allowFreeform ? ["Other (type custom answer)…"] : []),
    ];
    const selected = await ui.select(request.question, labels);
    if (selected === undefined) {
      return {
        cancelled: true,
        selectedIndex: null,
        selectedLabel: null,
        freeformText: null,
      };
    }
    const index = labels.indexOf(selected);
    if (request.allowFreeform && index === request.options.length) {
      const text = (
        await ui.input(request.question, "Type your answer")
      )?.trim();
      if (text === undefined || text.length === 0) {
        return {
          cancelled: true,
          selectedIndex: null,
          selectedLabel: null,
          freeformText: null,
        };
      }
      return {
        cancelled: false,
        selectedIndex: null,
        selectedLabel: null,
        freeformText: text,
      };
    }
    const chosen = request.options[index];
    if (chosen === undefined) {
      return {
        cancelled: true,
        selectedIndex: null,
        selectedLabel: null,
        freeformText: null,
      };
    }
    return {
      cancelled: false,
      selectedIndex: index,
      selectedLabel: chosen.label,
      freeformText: null,
    };
  }
}
