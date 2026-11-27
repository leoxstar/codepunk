import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commandContext } from "../command-context.ts";
import { defineCommand, type TuiCommand } from "../define-command.ts";
import { notify } from "../format/notify.ts";
import type { TuiState } from "../state.ts";

export const MAX_PROMPT_STASH_ENTRIES = 20;

export interface PromptStashEntry {
  readonly text: string;
  readonly createdAt: string;
}

export type PromptStashOutcome =
  | {
      readonly kind: "pushed";
      readonly entry: PromptStashEntry;
      readonly total: number;
    }
  | {
      readonly kind: "popped";
      readonly entry: PromptStashEntry;
      readonly remaining: number;
    }
  | { readonly kind: "cleared"; readonly removed: number }
  | { readonly kind: "empty" }
  | { readonly kind: "out_of_range"; readonly total: number };

export function applyPromptStashAction(
  stack: PromptStashEntry[],
  action: "toggle" | "push" | "pop" | "clear",
  currentEditorText: string,
  options: { index?: number; now?: () => Date } = {},
): { nextEditorText: string | null; outcome: PromptStashOutcome } {
  const now = options.now ?? (() => new Date());
  const trimmed = currentEditorText.trim();
  if (action === "clear") {
    const removed = stack.length;
    stack.length = 0;
    return { nextEditorText: null, outcome: { kind: "cleared", removed } };
  }
  if (action === "push" || (action === "toggle" && trimmed.length > 0)) {
    if (trimmed.length === 0) {
      return { nextEditorText: null, outcome: { kind: "empty" } };
    }
    const entry: PromptStashEntry = {
      text: currentEditorText,
      createdAt: now().toISOString(),
    };
    stack.push(entry);
    if (stack.length > MAX_PROMPT_STASH_ENTRIES) {
      stack.splice(0, stack.length - MAX_PROMPT_STASH_ENTRIES);
    }
    return {
      nextEditorText: "",
      outcome: { kind: "pushed", entry, total: stack.length },
    };
  }
  if (stack.length === 0) {
    return { nextEditorText: null, outcome: { kind: "empty" } };
  }
  const targetIndex =
    options.index === undefined
      ? stack.length - 1
      : stack.length - options.index;
  if (targetIndex < 0 || targetIndex >= stack.length) {
    return {
      nextEditorText: null,
      outcome: { kind: "out_of_range", total: stack.length },
    };
  }
  const [picked] = stack.splice(targetIndex, 1);
  const combined =
    trimmed.length > 0 ? `${currentEditorText}\n${picked!.text}` : picked!.text;
  return {
    nextEditorText: combined,
    outcome: { kind: "popped", entry: picked!, remaining: stack.length },
  };
}

function summarizeDraft(text: string): string {
  const singleLine = text.replace(/\s+/gu, " ").trim();
  return singleLine.length <= 64 ? singleLine : `${singleLine.slice(0, 61)}...`;
}

export async function runPromptStashToggle(
  state: TuiState,
  context: ExtensionContext,
): Promise<void> {
  const stack = (state.promptStash ??= []);
  const current = context.ui.getEditorText?.() ?? "";
  const { nextEditorText, outcome } = applyPromptStashAction(
    stack,
    "toggle",
    current,
  );
  if (nextEditorText !== null) {
    context.ui.setEditorText(nextEditorText);
  }
  if (outcome.kind === "pushed") {
    context.ui.notify(
      `Stashed draft #${outcome.total} (${outcome.entry.text.length} chars). Press Alt+S or /stash pop to restore.`,
      "info",
    );
    return;
  }
  if (outcome.kind === "popped") {
    context.ui.notify(
      `Restored stashed draft (${outcome.entry.text.length} chars; ${outcome.remaining} remaining).`,
      "info",
    );
    return;
  }
  context.ui.notify(
    "Prompt stash is empty. Type a draft and press Alt+S to stash it.",
    "info",
  );
}

export async function runStashCommandAction(
  state: TuiState,
  context: ExtensionContext,
  rawArgs: string,
): Promise<void> {
  const stack = (state.promptStash ??= []);
  const tokens = rawArgs.trim().split(/\s+/u).filter(Boolean);
  const sub = tokens[0] ?? "";
  if (sub === "" || sub === "toggle") {
    await runPromptStashToggle(state, context);
    return;
  }
  if (sub === "list") {
    if (stack.length === 0) {
      context.ui.notify("Prompt stash is empty.", "info");
      return;
    }
    const labels = [...stack]
      .reverse()
      .map(
        (entry, idx) =>
          `#${idx + 1} (${entry.text.length} chars) · ${summarizeDraft(entry.text)}`,
      );
    if (typeof context.ui.select === "function") {
      const picked = await context.ui.select(
        "Prompt stash (Enter to restore)",
        [...labels, "Close"],
      );
      const pickedIdx = picked === undefined ? -1 : labels.indexOf(picked);
      if (pickedIdx >= 0) {
        const current = context.ui.getEditorText?.() ?? "";
        const res = applyPromptStashAction(stack, "pop", current, {
          index: pickedIdx + 1,
        });
        if (res.nextEditorText !== null) {
          context.ui.setEditorText(res.nextEditorText);
        }
        context.ui.notify(`Restored draft #${pickedIdx + 1}.`, "info");
      }
      return;
    }
    await notify(context, labels.join("\n"));
    return;
  }
  if (sub === "push") {
    const current = context.ui.getEditorText?.() ?? "";
    const res = applyPromptStashAction(stack, "push", current);
    if (res.nextEditorText !== null) {
      context.ui.setEditorText(res.nextEditorText);
    }
    context.ui.notify(
      res.outcome.kind === "pushed"
        ? `Stashed draft #${res.outcome.total} (${res.outcome.entry.text.length} chars).`
        : "Editor is empty; nothing to stash.",
      res.outcome.kind === "pushed" ? "info" : "warning",
    );
    return;
  }
  if (sub === "pop") {
    const requestedIndex =
      tokens[1] === undefined ? undefined : Number(tokens[1]);
    if (
      requestedIndex !== undefined &&
      (!Number.isSafeInteger(requestedIndex) || requestedIndex < 1)
    ) {
      context.ui.notify("usage: /stash [push|pop [n]|list|clear]", "warning");
      return;
    }
    const current = context.ui.getEditorText?.() ?? "";
    const res = applyPromptStashAction(stack, "pop", current, {
      ...(requestedIndex === undefined ? {} : { index: requestedIndex }),
    });
    if (res.nextEditorText !== null) {
      context.ui.setEditorText(res.nextEditorText);
    }
    if (res.outcome.kind === "popped") {
      context.ui.notify(
        `Restored stashed draft (${res.outcome.remaining} remaining).`,
        "info",
      );
      return;
    }
    context.ui.notify(
      res.outcome.kind === "out_of_range"
        ? `Stash index out of range (1..${res.outcome.total}).`
        : "Prompt stash is empty.",
      "warning",
    );
    return;
  }
  if (sub === "clear") {
    const res = applyPromptStashAction(stack, "clear", "");
    context.ui.notify(
      res.outcome.kind === "cleared"
        ? `Cleared ${res.outcome.removed} stashed draft(s).`
        : "Prompt stash is empty.",
      "info",
    );
    return;
  }
  context.ui.notify("usage: /stash [push|pop [n]|list|clear]", "warning");
}

export function stashCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "stash",
    description: "Stash or restore prompt drafts in the editor (Alt+S)",
    handler: commandContext(state, async (_runtime, context, args) => {
      await runStashCommandAction(state, context, args);
    }),
  });
}
