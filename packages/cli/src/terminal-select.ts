import {
  type Component,
  Container,
  type SelectItem,
  type SelectListTheme,
  SelectList,
  Text,
  ProcessTerminal,
  TuiMainScreen,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";

export interface TerminalChoice<T> {
  label: string;
  value: T;
  description?: string;
}

export interface TerminalSelectOptions {
  /**
   * Row to highlight before the first keypress. The trust prompt uses this to
   * keep the safest decision visible when a caller has already chosen one.
   */
  initialIndex?: number;
  /**
   * Short facts rendered between the title and the choices. They give a
   * consequential prompt its scope without adding another selection step.
   */
  contextLines?: readonly string[];
  /**
   * Build identity is shown for pre-host prompts so a stale process is visible
   * in the same screen instead of being mistaken for a current menu.
   */
  footerNote?: string;
}

export class TerminalSelectCancelledError extends Error {
  constructor() {
    super("selection cancelled");
    this.name = "TerminalSelectCancelledError";
  }
}

export interface TerminalCheckboxChoice<T> {
  label: string;
  value: T;
  description?: string;
  checked: boolean;
}

export interface TerminalCheckboxOptions {
  contextLines?: readonly string[];
  footerNote?: string;
}

function supportsColor(): boolean {
  return (
    process.stdout.isTTY === true &&
    process.env["NO_COLOR"] === undefined &&
    process.env["TERM"] !== "dumb"
  );
}

function selectionTheme(color: boolean): SelectListTheme {
  const accent = color ? "\u001b[36m" : "";
  const dim = color ? "\u001b[2m" : "";
  const reset = color ? "\u001b[0m" : "";
  return {
    selectedPrefix: (text) => `${accent}${text}${reset}`,
    selectedText: (text) => `${accent}${text}${reset}`,
    description: (text) => `${dim}${text}${reset}`,
    scrollInfo: (text) => `${dim}${text}${reset}`,
    noMatch: (text) => `${dim}${text}${reset}`,
  };
}

class CheckboxList<T> implements Component {
  private readonly choices: readonly TerminalCheckboxChoice<T>[];
  private readonly color: boolean;
  private index = 0;
  private readonly selected: boolean[];
  onConfirm?: (values: T[]) => void;
  onCancel?: () => void;

  constructor(choices: readonly TerminalCheckboxChoice<T>[], color: boolean) {
    this.choices = choices;
    this.color = color;
    this.selected = choices.map((choice) => choice.checked);
  }

  invalidate(): void {}

  private paint(text: string, code: string): string {
    return this.color ? `${code}${text}\u001b[0m` : text;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (const [index, choice] of this.choices.entries()) {
      const focused = index === this.index;
      const prefix = focused ? this.paint("\u2192 ", "\u001b[36m") : "  ";
      const box = this.selected[index] ? "[x]" : "[ ]";
      const label = `${box} ${choice.label}`;
      lines.push(
        truncateToWidth(
          `${prefix}${focused ? this.paint(label, "\u001b[36m") : label}`,
          width,
        ),
      );
      if (choice.description !== undefined) {
        lines.push(
          truncateToWidth(
            `      ${
              this.color
                ? `\u001b[2m${choice.description}\u001b[0m`
                : choice.description
            }`,
            width,
          ),
        );
      }
    }
    return lines;
  }

  handleInput(keyData: string): void {
    if (matchesKey(keyData, "up") || keyData === "k") {
      this.index = Math.max(0, this.index - 1);
      return;
    }
    if (matchesKey(keyData, "down") || keyData === "j") {
      this.index = Math.min(this.choices.length - 1, this.index + 1);
      return;
    }
    if (matchesKey(keyData, "space")) {
      this.selected[this.index] = !this.selected[this.index];
      return;
    }
    if (matchesKey(keyData, "enter")) {
      this.onConfirm?.(
        this.choices
          .filter((_choice, index) => this.selected[index])
          .map((choice) => choice.value),
      );
      return;
    }
    if (matchesKey(keyData, "escape") || matchesKey(keyData, "ctrl+c")) {
      this.onCancel?.();
    }
  }
}

/**
 * Multi-select used by workspace trust customization. Keys mirror the
 * single-select prompt: arrows move, space toggles, Enter confirms, Esc
 * returns to the caller without a decision.
 */
export async function selectTerminalCheckboxes<T>(
  title: string,
  choices: readonly TerminalCheckboxChoice<T>[],
  options: TerminalCheckboxOptions = {},
): Promise<T[] | null> {
  if (choices.length === 0) {
    throw new Error("checkbox selection requires at least one choice");
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("interactive selection requires a TTY");
  }

  const color = supportsColor();
  const bold = color ? "\u001b[1m" : "";
  const dim = color ? "\u001b[2m" : "";
  const reset = color ? "\u001b[0m" : "";
  const terminal = new ProcessTerminal();
  const ui = new TuiMainScreen(terminal, false);
  const container = new Container();
  container.addChild(new Text(`${bold}? ${title}${reset}`, 0, 0));
  if (options.contextLines !== undefined && options.contextLines.length > 0) {
    container.addChild(
      new Text(
        options.contextLines
          .flatMap((line) => line.split("\n"))
          .map((line) => `${dim}${line}${reset}`)
          .join("\n"),
        0,
        0,
      ),
    );
  }
  const list = new CheckboxList(choices, color);
  container.addChild(list);
  container.addChild(
    new Text(
      `${dim}\u2191\u2193 navigate  space toggle  enter apply  esc back${reset}`,
      0,
      0,
    ),
  );
  if (options.footerNote !== undefined && options.footerNote.length > 0) {
    container.addChild(new Text(`${dim}${options.footerNote}${reset}`, 0, 0));
  }
  ui.addChild(container);
  ui.setFocus(list);
  let settled = false;

  return await new Promise<T[] | null>((resolve) => {
    const finish = (selected: T[] | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      ui.stop();
      resolve(selected);
    };
    list.onConfirm = (selected) => finish(selected);
    list.onCancel = () => finish(null);
    ui.start();
  });
}

/**
 * Arrow-key selector for prompts that must run before Pi's interactive mode
 * exists, such as workspace trust. It reuses Pi's terminal components instead
 * of maintaining a second key parser, renderer, and selection model.
 */
export async function selectTerminalChoice<T>(
  title: string,
  choices: readonly TerminalChoice<T>[],
  options: TerminalSelectOptions = {},
): Promise<T> {
  if (choices.length === 0) {
    throw new Error("selection requires at least one choice");
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("interactive selection requires a TTY");
  }

  const color = supportsColor();
  const bold = color ? "\u001b[1m" : "";
  const dim = color ? "\u001b[2m" : "";
  const reset = color ? "\u001b[0m" : "";
  const terminal = new ProcessTerminal();
  const ui = new TuiMainScreen(terminal, false);
  // Keep the prompt in scrollback. Pi's interactive mode starts after this
  // selector closes and owns the next full-screen render; erasing here would
  // also discard the trust preview printed immediately before the prompt.
  const container = new Container();
  container.addChild(new Text(`${bold}? ${title}${reset}`, 0, 0));
  if (options.contextLines !== undefined && options.contextLines.length > 0) {
    container.addChild(
      new Text(
        options.contextLines
          .flatMap((line) => line.split("\n"))
          .map((line) => `${dim}${line}${reset}`)
          .join("\n"),
        0,
        0,
      ),
    );
  }
  const items: SelectItem[] = choices.map((choice, index) => ({
    value: String(index),
    label: choice.label,
    ...(choice.description === undefined
      ? {}
      : { description: choice.description }),
  }));
  const list = new SelectList(items, choices.length, selectionTheme(color), {
    minPrimaryColumnWidth: 30,
    maxPrimaryColumnWidth: 42,
  });
  list.setSelectedIndex(options.initialIndex ?? 0);
  container.addChild(list);
  container.addChild(
    new Text(
      `${dim}\u2191\u2193 navigate  enter select  esc/ctrl+c cancel${reset}`,
      0,
      0,
    ),
  );
  if (options.footerNote !== undefined && options.footerNote.length > 0) {
    container.addChild(new Text(`${dim}${options.footerNote}${reset}`, 0, 0));
  }
  ui.addChild(container);
  ui.setFocus(list);
  let settled = false;

  return await new Promise<T>((resolve, reject) => {
    const finish = (selected: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      void (async () => {
        ui.stop();
        if (selected === null) {
          reject(new TerminalSelectCancelledError());
          return;
        }
        resolve(choices[selected]!.value);
      })();
    };

    list.onSelect = (item) => finish(Number(item.value));
    list.onCancel = () => finish(null);
    ui.start();
  });
}
