import { CustomEditor } from "@earendil-works/pi-coding-agent";

export class InterceptingEditor extends CustomEditor {
  private readonly intercept: (text: string) => Promise<boolean> | boolean;

  constructor(
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    intercept: (text: string) => Promise<boolean> | boolean,
  ) {
    super(tui as never, theme as never, keybindings as never);
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
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    intercept: (text: string) => Promise<boolean> | boolean,
  ) {
    super(tui, theme, keybindings, intercept);
  }
}
