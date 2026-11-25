import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CodepunkRuntime } from "codepunk-core";
import { commandContext } from "../command-context.ts";
import { defineCommand, type TuiCommand } from "../define-command.ts";
import {
  backgroundManager,
  formatBackgroundLogs,
  sideQueueFor,
  showBackgroundTasks,
} from "../format/background.ts";
import { notify } from "../format/notify.ts";
import { manageSubagents } from "../format/subagents.ts";
import type { TuiState } from "../state.ts";
import type {
  TaskCenterAction,
  TaskCenterEntry,
} from "../components/task-center.ts";
import { defaultViewportHeight } from "../components/frame.ts";

export async function collectTaskCenterEntries(
  state: TuiState,
  runtime: CodepunkRuntime,
): Promise<TaskCenterEntry[]> {
  const entries: TaskCenterEntry[] = [];
  for (const record of state.subagents?.values() ?? []) {
    const isWorktree = record.isolation === "worktree";
    const status =
      record.delivery !== null
        ? `${record.status} · ${record.delivery.state}`
        : record.status;
    entries.push({
      id: record.childSessionId,
      kind: "subagent",
      status,
      title: record.prompt.slice(0, 80),
      detail:
        record.status === "running"
          ? `enter live transcript · x stop`
          : isWorktree
            ? `enter result · r review · m merge · d discard`
            : `enter result · d discard`,
      running: record.status === "running",
      reviewable: record.status !== "running" && isWorktree,
      mergeable:
        record.status !== "running" &&
        isWorktree &&
        record.delivery?.state !== "merged",
    });
  }
  const manager = backgroundManager(state, runtime);
  await manager.hydrate().catch(() => undefined);
  for (const task of manager.ps()) {
    entries.push({
      id: task.id,
      kind: "background",
      status: task.status,
      title: task.title,
      detail: task.status === "running" ? `enter logs · x stop` : `enter logs`,
      running: task.status === "running",
      reviewable: false,
      mergeable: false,
    });
  }
  const queue = sideQueueFor(state, runtime);
  await queue.hydrate().catch(() => undefined);
  for (const side of queue.all) {
    if (entries.some((entry) => entry.id === side.id)) {
      continue;
    }
    entries.push({
      id: side.id,
      kind: "side",
      status: `${side.kind} · ${side.status}`,
      title: side.prompt.slice(0, 80),
      detail: side.status === "running" ? `enter logs · x stop` : `enter logs`,
      running: side.status === "running",
      reviewable: false,
      mergeable: false,
    });
  }
  entries.sort((left, right) => {
    if (left.running !== right.running) {
      return left.running ? -1 : 1;
    }
    return right.id.localeCompare(left.id);
  });
  return entries;
}

async function runTaskCenterAction(
  state: TuiState,
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  selected: TaskCenterAction,
): Promise<void> {
  const { action, entry } = selected;
  if (entry.kind === "subagent") {
    const subcommand =
      action === "inspect" ? (entry.running ? "transcript" : "result") : action;
    await manageSubagents(state, runtime, context, `${subcommand} ${entry.id}`);
    return;
  }
  const manager = backgroundManager(state, runtime);
  await manager.hydrate();
  if (action === "stop") {
    const stopped = await manager.stop(entry.id);
    await notify(context, `Background task ${stopped.id}: ${stopped.status}`);
    return;
  }
  await notify(
    context,
    formatBackgroundLogs(entry.id, await manager.logs(entry.id)),
  );
}

export async function showTaskCenter(
  state: TuiState,
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
): Promise<void> {
  const entries = await collectTaskCenterEntries(state, runtime);
  try {
    const { createTaskCenter } = await import("../components/task-center.ts");
    const chosen = await context.ui.custom<TaskCenterAction | null>(
      (_tui, theme, keybindings, done) =>
        createTaskCenter(
          {
            title: "Task center",
            entries,
            viewportHeight: defaultViewportHeight(),
          },
          theme,
          keybindings,
          done,
        ),
    );
    if (chosen !== null && chosen !== undefined) {
      await runTaskCenterAction(state, runtime, context, chosen);
    }
  } catch {
    await showBackgroundTasks(state, runtime, context);
  }
}

export function tasksCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "tasks",
    description: "Open the unified interactive task and subagent center",
    handler: commandContext(state, async (runtime, context) => {
      await showTaskCenter(state, runtime, context);
    }),
  });
}
