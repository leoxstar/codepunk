import type {
  ExtensionAPI,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { TuiApprovalChannel } from "./approval/channel.ts";
import {
  recapCommand,
  sideCommand,
  subagentCommand,
  agentsCommand,
  psCommand,
  logsCommand,
  stopCommand,
  btwCommand,
  presetCommand,
} from "./commands/background.ts";
import { imageCommand, image_genCommand } from "./commands/images.ts";
import {
  rolesCommand,
  reviewCommand,
  modelsCommand,
  favoriteCommand,
} from "./commands/models.ts";
import { mcpCommand } from "./commands/mcp.ts";
import { rewindCommand } from "./commands/rewind.ts";
import { tasksCommand } from "./commands/tasks.ts";
import {
  permissionsCommand,
  permissionCommand,
  cp_exportCommand,
  signCommand,
  rememberCommand,
  memoryCommand,
} from "./commands/permissions.ts";
import {
  helpCommand,
  initCommand,
  diffCommand,
  undoCommand,
  redoCommand,
  commitCommand,
  statusCommand,
  cp_sessionsCommand,
  planCommand,
  plan_modeCommand,
  goalCommand,
  hooksCommand,
  todosCommand,
  evidenceCommand,
  budgetCommand,
  doctorCommand,
  policyCommand,
  capabilitiesCommand,
  skillsCommand,
  pluginsCommand,
} from "./commands/project.ts";
import type { TuiCommand } from "./define-command.ts";
import { registerTuiEvents } from "./events.ts";
import { codepunkToolRendererResolver } from "./renderers/index.ts";
import type { TuiState } from "./state.ts";

const COMMAND_FACTORIES: readonly ((state: TuiState) => TuiCommand)[] = [
  helpCommand,
  initCommand,
  diffCommand,
  undoCommand,
  redoCommand,
  commitCommand,
  statusCommand,
  cp_sessionsCommand,
  planCommand,
  plan_modeCommand,
  goalCommand,
  hooksCommand,
  presetCommand,
  btwCommand,
  sideCommand,
  recapCommand,
  imageCommand,
  image_genCommand,
  rolesCommand,
  reviewCommand,
  todosCommand,
  evidenceCommand,
  modelsCommand,
  favoriteCommand,
  budgetCommand,
  doctorCommand,
  policyCommand,
  capabilitiesCommand,
  skillsCommand,
  pluginsCommand,
  mcpCommand,
  permissionsCommand,
  permissionCommand,
  cp_exportCommand,
  subagentCommand,
  agentsCommand,
  tasksCommand,
  rewindCommand,
  psCommand,
  logsCommand,
  stopCommand,
  signCommand,
  rememberCommand,
  memoryCommand,
];

export function createTuiExtension(
  state: TuiState,
  channel: TuiApprovalChannel,
): InlineExtension {
  state.channel = channel;
  return {
    name: "codepunk-tui",
    hidden: true,
    factory: (pi) => {
      registerTuiEvents(pi, state, channel);
      pi.registerToolRenderer(codepunkToolRendererResolver());
      const commands = COMMAND_FACTORIES.map((factory) => factory(state));
      for (const command of commands) {
        pi.registerCommand(command.name, {
          description: command.description,
          handler: command.handler,
        });
        if (command.name === "favorite") {
          registerShortcuts(pi, state);
        }
      }
      if (commands.length !== COMMAND_FACTORIES.length) {
        throw new Error("codepunk TUI command table was incomplete");
      }
    },
  };
}

function registerShortcuts(
  pi: Pick<ExtensionAPI, "registerShortcut">,
  state: TuiState,
): void {
  const keymap = state.runtime?.config.tui.keymap ?? {
    model_cycle: "f2",
    background: "off",
  };
  if (keymap.model_cycle !== "off") {
    pi.registerShortcut(
      keymap.model_cycle as Parameters<typeof pi.registerShortcut>[0],
      {
        description: "Cycle through recent models",
        handler: async (context) => {
          const { cycleRecentModel } = await import("./format/model.ts");
          await cycleRecentModel(state, context);
        },
      },
    );
  }
  if (keymap.background !== "off") {
    pi.registerShortcut(
      keymap.background as Parameters<typeof pi.registerShortcut>[0],
      {
        description: "List background tasks",
        handler: async (context) => {
          const runtime = state.runtime;
          if (runtime === null) {
            context.ui.notify("codepunk runtime is not ready", "error");
            return;
          }
          const { showBackgroundTasks } =
            await import("./format/background.ts");
          await showBackgroundTasks(state, runtime, context);
        },
      },
    );
  }
  pi.registerShortcut("alt+m" as Parameters<typeof pi.registerShortcut>[0], {
    description: "Cycle work mode (plan/standard/auto/auto-approve)",
    handler: async (context) => {
      const { cycleWorkMode } = await import("./format/mode-cycle.ts");
      await cycleWorkMode(state, context);
    },
  });
  pi.registerShortcut("alt+t" as Parameters<typeof pi.registerShortcut>[0], {
    description: "Open the unified task and subagent center",
    handler: async (context) => {
      const runtime = state.runtime;
      if (runtime === null) {
        context.ui.notify("codepunk runtime is not ready", "error");
        return;
      }
      const { showTaskCenter } = await import("./commands/tasks.ts");
      await showTaskCenter(state, runtime, context as never);
    },
  });
  pi.registerShortcut("alt+r" as Parameters<typeof pi.registerShortcut>[0], {
    description: "Open the interactive rewind picker",
    handler: async (context) => {
      const { openRewindPicker } = await import("./commands/rewind.ts");
      await openRewindPicker(state, context as never);
    },
  });
  pi.registerShortcut("f1" as Parameters<typeof pi.registerShortcut>[0], {
    description: "Open searchable command help",
    handler: async (context) => {
      const [
        { createHelpBrowser },
        { codepunkHelp },
        { defaultViewportHeight },
      ] = await Promise.all([
        import("./components/help-browser.ts"),
        import("./chrome/help.ts"),
        import("./components/frame.ts"),
      ]);
      await context.ui.custom<void>((_tui, theme, keybindings, done) =>
        createHelpBrowser(
          {
            title: "Codepunk help",
            text: codepunkHelp(),
            viewportHeight: defaultViewportHeight(),
          },
          theme,
          keybindings,
          done,
        ),
      );
    },
  });
}
