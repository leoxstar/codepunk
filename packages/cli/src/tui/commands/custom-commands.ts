import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  expandCustomCommand,
  formatCustomCommands,
  loadCustomCommands,
  type CodepunkRuntime,
} from "codepunk-core";
import { commandContext } from "../command-context.ts";
import { defineCommand, type TuiCommand } from "../define-command.ts";
import type { TuiState } from "../state.ts";

export async function executeCustomCommandAction(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
  argument: string,
): Promise<void> {
  const bundle = await loadCustomCommands({
    codepunkHome: runtime.paths.home,
    deliveryRoot: runtime.paths.deliveryRoot,
    projectTrusted: runtime.workspaceTrust.grants.config,
  });
  const trimmed = argument.trim();
  if (trimmed === "list") {
    context.ui.notify(formatCustomCommands(bundle), "info");
    return;
  }
  const agentSession = runtime.host.session;
  if (trimmed.length === 0) {
    if (bundle.commands.length === 0) {
      context.ui.notify(formatCustomCommands(bundle), "info");
      return;
    }
    const labels = bundle.commands.map(
      (cmd) => `${cmd.name} [${cmd.scope}] — ${cmd.description}`,
    );
    const chosen = await context.ui.select("Run custom template", labels);
    if (chosen === undefined) {
      return;
    }
    const picked = bundle.commands[labels.indexOf(chosen)];
    if (picked === undefined) {
      return;
    }
    const expanded = expandCustomCommand(picked, "");
    if (agentSession.isStreaming) {
      context.ui.setEditorText(expanded);
      context.ui.notify(
        `Session is busy; loaded expanded /run ${picked.name} into the editor.`,
        "info",
      );
      return;
    }
    await agentSession.prompt(expanded, { expandPromptTemplates: false });
    return;
  }
  const spaceIndex = trimmed.search(/\s/u);
  const name = spaceIndex < 0 ? trimmed : trimmed.slice(0, spaceIndex);
  const restArgs = spaceIndex < 0 ? "" : trimmed.slice(spaceIndex + 1);
  const command = bundle.commands.find((entry) => entry.name === name);
  if (command === undefined) {
    const names = bundle.commands.map((entry) => entry.name).join(", ");
    context.ui.notify(
      names.length === 0
        ? `unknown custom command "${name}" (no custom commands found; add $CODEPUNK_HOME/commands/${name}.md or trusted .codepunk/commands/${name}.md)`
        : `unknown custom command "${name}" (available: ${names})`,
      "warning",
    );
    return;
  }
  const expanded = expandCustomCommand(command, restArgs);
  if (agentSession.isStreaming) {
    context.ui.notify(
      "wait for the current turn to finish before running a custom command",
      "warning",
    );
    return;
  }
  await agentSession.prompt(expanded, { expandPromptTemplates: false });
}

export function runCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "run",
    description:
      "Run or list custom Markdown prompt templates (/run [list|<name> [args...]])",
    handler: commandContext(state, async (runtime, context, args) => {
      await executeCustomCommandAction(runtime, context, args);
    }),
  });
}
