import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

export class InterceptingEditor extends CustomEditor {
  private readonly intercept: (text: string) => Promise<boolean> | boolean;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    intercept: (text: string) => Promise<boolean> | boolean,
  ) {
    super(tui, theme, keybindings);
    this.intercept = intercept;
    let assigned: ((text: string) => Promise<void> | void) | undefined;
    Object.defineProperty(this, "onSubmit", {
      configurable: true,
      get:
        () =>
        async (text: string): Promise<void> => {
          if (await this.intercept(text)) {
            this.setText("");
            return;
          }
          await assigned?.(text);
        },
      set: (handler: ((text: string) => Promise<void> | void) | undefined) => {
        assigned = handler;
      },
    });
  }
}

export class EditorBridge extends InterceptingEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    intercept: (text: string) => Promise<boolean> | boolean,
  ) {
    super(tui, theme, keybindings, intercept);
  }
}
