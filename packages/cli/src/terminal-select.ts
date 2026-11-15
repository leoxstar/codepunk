import { emitKeypressEvents, type Key } from "node:readline";

export interface TerminalChoice<T> {
  label: string;
  value: T;
}

export interface TerminalSelectOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export class TerminalSelectCancelledError extends Error {
  constructor() {
    super("selection cancelled");
    this.name = "TerminalSelectCancelledError";
  }
}

function supportsColor(output: NodeJS.WriteStream): boolean {
  return (
    output.isTTY === true &&
    process.env["NO_COLOR"] === undefined &&
    process.env["TERM"] !== "dumb"
  );
}

function clearLines(output: NodeJS.WriteStream, count: number): void {
  output.write(`\u001b[${count}A`);
  for (let index = 0; index < count; index += 1) {
    output.write("\r\u001b[2K\n");
  }
  output.write(`\u001b[${count}A`);
}

/**
 * Arrow-key selector for prompts that must run before Pi's interactive mode
 * exists, such as workspace trust. Keeping this pre-host preserves the rule
 * that no project resource is loaded before the trust decision.
 */
export async function selectTerminalChoice<T>(
  title: string,
  choices: readonly TerminalChoice<T>[],
  options: TerminalSelectOptions = {},
): Promise<T> {
  if (choices.length === 0) {
    throw new Error("selection requires at least one choice");
  }
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  if (input.isTTY !== true || typeof input.setRawMode !== "function") {
    throw new Error("interactive selection requires a TTY");
  }

  const wasRaw = input.isRaw === true;
  const color = supportsColor(output);
  const selected = color ? "\u001b[36m" : "";
  const bold = color ? "\u001b[1m" : "";
  const reset = color ? "\u001b[0m" : "";
  const dim = color ? "\u001b[2m" : "";
  const lineCount = choices.length + 1;
  let index = 0;
  let settled = false;

  emitKeypressEvents(input);

  return await new Promise<T>((resolve, reject) => {
    const writeLine = (text: string): void => {
      output.write(`\r\u001b[2K${text}\n`);
    };

    const render = (initial: boolean): void => {
      if (!initial) {
        output.write(`\u001b[${lineCount}A`);
      }
      for (const [choiceIndex, choice] of choices.entries()) {
        writeLine(
          choiceIndex === index
            ? `${selected}${bold}\u2192 ${choice.label}${reset}`
            : `  ${choice.label}`,
        );
      }
      writeLine(
        `${dim}Up/Down to move | Enter to select | Esc to cancel${reset}`,
      );
    };

    const cleanup = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      input.removeListener("keypress", onKeypress);
      if (!wasRaw) {
        input.setRawMode(false);
      }
    };

    const finish = (choice: TerminalChoice<T>): void => {
      if (settled) {
        return;
      }
      clearLines(output, lineCount);
      writeLine(`  selected: ${choice.label}`);
      cleanup();
      resolve(choice.value);
    };

    const cancel = (): void => {
      if (settled) {
        return;
      }
      clearLines(output, lineCount);
      writeLine("  cancelled");
      cleanup();
      reject(new TerminalSelectCancelledError());
    };

    const move = (delta: number): void => {
      index = (index + delta + choices.length) % choices.length;
      render(false);
    };

    const onKeypress = (_sequence: string, key: Key = {}): void => {
      if (key.ctrl === true && key.name === "c") {
        cancel();
        return;
      }
      if (key.name === "escape") {
        cancel();
        return;
      }
      if (key.name === "up" || key.name === "k") {
        move(-1);
        return;
      }
      if (key.name === "down" || key.name === "j") {
        move(1);
        return;
      }
      if (key.name === "home") {
        index = 0;
        render(false);
        return;
      }
      if (key.name === "end") {
        index = choices.length - 1;
        render(false);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish(choices[index]!);
      }
    };

    output.write(`\r\u001b[2K${bold}? ${title}${reset}\n`);
    render(true);
    input.on("keypress", onKeypress);
    input.setRawMode(true);
    input.resume();
  });
}
