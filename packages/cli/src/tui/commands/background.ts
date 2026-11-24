import {
  backgroundManager,
  formatBackgroundLogs,
  runSideTask,
  showBackgroundTasks,
} from "../format/background.ts";
import { notify } from "../format/notify.ts";
import { listPresets, usePreset } from "../format/presets.ts";
import { recapRange, formatRecap } from "../format/recap.ts";
import { runSubagent, manageSubagents } from "../format/subagents.ts";
import { createSessionRecap } from "codepunk-core";
import type { TuiCommand } from "../define-command.ts";
import { commandContext } from "../command-context.ts";
import type { TuiState } from "../state.ts";
import { defineCommand } from "../define-command.ts";

export function presetCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "preset",
    description: "List or apply a user preset to this session",
    handler: commandContext(state, async (runtime, context, args) => {
      const [subcommand, ...rest] = args.trim().split(/\s+/u);
      if (
        subcommand === undefined ||
        subcommand === "" ||
        subcommand === "list"
      ) {
        await listPresets(runtime, context);
        return;
      }
      if (subcommand === "use") {
        await usePreset(state, runtime, context, rest.join(" ").trim());
        return;
      }
      context.ui.notify("usage: /preset [list|use <name>]", "warning");
    }),
  });
}

export function btwCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "btw",
    description: "Run a read-only side question without stopping the main task",
    handler: commandContext(state, async (runtime, context, args) => {
      await runSideTask(state, runtime, context, "btw", args);
    }),
  });
}

export function sideCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "side",
    description: "Run a background side task without stopping the main task",
    handler: commandContext(state, async (runtime, context, args) => {
      await runSideTask(state, runtime, context, "side", args);
    }),
  });
}

export function recapCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "recap",
    description: "Show a derived recap for a contiguous session range",
    handler: commandContext(state, async (runtime, context, args) => {
      const events = runtime.session.allEvents;
      if (events.length === 0) {
        context.ui.notify("No events in this session.", "info");
        return;
      }
      try {
        const range = recapRange(args, events.at(-1)!.seq);
        const recap = createSessionRecap(events, range.from, range.to);
        await notify(context, formatRecap(recap));
      } catch (error) {
        context.ui.notify(
          error instanceof Error ? error.message : String(error),
          "warning",
        );
      }
    }),
  });
}

export function subagentCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "subagent",
    description: "Start a background child Pi session",
    handler: commandContext(state, async (runtime, context, args) => {
      await runSubagent(state, runtime, context, args);
    }),
  });
}

export function agentsCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "agents",
    description: "Review, sign, merge, or discard background subagents",
    handler: commandContext(state, async (runtime, context, args) => {
      await manageSubagents(state, runtime, context, args);
    }),
  });
}

export function psCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "ps",
    description: "List background tasks",
    handler: commandContext(state, async (runtime, context, args) => {
      if (args.trim().length > 0) {
        context.ui.notify("usage: /ps", "warning");
        return;
      }
      await showBackgroundTasks(state, runtime, context);
    }),
  });
}

export function logsCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "logs",
    description: "Show bounded background task logs",
    handler: commandContext(state, async (runtime, context, args) => {
      const id = args.trim();
      if (id.length === 0) {
        context.ui.notify("usage: /logs <id>", "warning");
        return;
      }
      try {
        const manager = backgroundManager(state, runtime);
        await manager.hydrate();
        await notify(context, formatBackgroundLogs(id, await manager.logs(id)));
      } catch (error) {
        context.ui.notify(
          `/logs failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
      }
    }),
  });
}

export function stopCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "stop",
    description: "Stop a background task",
    handler: commandContext(state, async (runtime, context, args) => {
      const id = args.trim();
      if (id.length === 0) {
        context.ui.notify("usage: /stop <id>", "warning");
        return;
      }
      try {
        const manager = backgroundManager(state, runtime);
        await manager.hydrate();
        const task = await manager.stop(id);
        await notify(
          context,
          [
            `Background task ${task.id}: ${task.status}`,
            `evidence: ${task.evidence_ref}`,
            ...(task.error === null ? [] : [`error: ${task.error}`]),
          ].join("\n"),
        );
      } catch (error) {
        context.ui.notify(
          `/stop failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
      }
    }),
  });
}
