import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

export interface TuiCommand {
  name: string;
  description: string;
  handler: (args: string, context: ExtensionCommandContext) => Promise<void>;
}

export function defineCommand(command: TuiCommand): TuiCommand {
  return command;
}

/**
 * Registers a command table in declaration order. Pi's completion and /help
 * follow registration order, so callers must not sort the table.
 */
export function registerCommandTable(
  pi: Pick<ExtensionAPI, "registerCommand">,
  commands: readonly TuiCommand[],
): void {
  for (const command of commands) {
    pi.registerCommand(command.name, {
      description: command.description,
      handler: command.handler,
    });
  }
}
