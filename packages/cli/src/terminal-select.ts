import {
  Container,
  type SelectItem,
  type SelectListTheme,
  SelectList,
  Text,
  ProcessTerminal,
  TuiMainScreen,
} from "@earendil-works/pi-tui";

export interface TerminalChoice<T> {
  label: string;
  value: T;
  description?: string;
}

export class TerminalSelectCancelledError extends Error {
  constructor() {
    super("selection cancelled");
    this.name = "TerminalSelectCancelledError";
  }
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

/**
 * Arrow-key selector for prompts that must run before Pi's interactive mode
 * exists, such as workspace trust. It reuses Pi's terminal components instead
 * of maintaining a second key parser, renderer, and selection model.
 */
export async function selectTerminalChoice<T>(
  title: string,
  choices: readonly TerminalChoice<T>[],
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
  const items: SelectItem[] = choices.map((choice, index) => ({
    value: String(index),
    label: choice.label,
    ...(choice.description === undefined
      ? {}
      : { description: choice.description }),
  }));
  const list = new SelectList(items, choices.length, selectionTheme(color), {
    minPrimaryColumnWidth: 34,
    maxPrimaryColumnWidth: 52,
  });
  container.addChild(list);
  container.addChild(
    new Text(
      `${dim}\u2191\u2193 navigate  enter select  esc/ctrl+c cancel${reset}`,
      0,
      0,
    ),
  );
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
