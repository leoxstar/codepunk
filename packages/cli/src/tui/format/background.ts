import {
  BackgroundTaskManager,
  SideTaskQueue,
  type BackgroundTaskSnapshot,
  type CodepunkRuntime,
  type SideTaskRecord,
} from "codepunk-core";
import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TuiState } from "../state.ts";
export { notify } from "./notify.ts";
import { physicalModel } from "../chrome/model.ts";

export function backgroundManager(
  state: TuiState,
  runtime: CodepunkRuntime,
): BackgroundTaskManager {
  if (state.backgroundTasks === undefined) {
    state.backgroundTasks = new BackgroundTaskManager({
      paths: runtime.paths,
      sessionId: runtime.session.sessionId,
    });
  } else {
    state.backgroundTasks.setSessionId(runtime.session.sessionId);
  }
  return state.backgroundTasks;
}

export async function showBackgroundTasks(
  state: TuiState,
  runtime: CodepunkRuntime,
  context: Pick<ExtensionContext, "ui">,
): Promise<void> {
  try {
    const manager = backgroundManager(state, runtime);
    await manager.hydrate();
    const queue = sideQueueFor(state, runtime);
    await queue.hydrate();
    context.ui.notify(
      [
        formatBackgroundTasks(manager.ps()),
        "",
        formatSideTasks(queue.all),
      ].join("\n"),
      "info",
    );
  } catch (error) {
    context.ui.notify(
      `/ps failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

export function formatBackgroundTasks(
  tasks: readonly BackgroundTaskSnapshot[],
): string {
  if (tasks.length === 0) {
    return "No background tasks.";
  }
  const now = Date.now();
  return [
    `Background tasks (${tasks.length})`,
    ...tasks.map((task) => {
      const started =
        task.started_at === null ? null : Date.parse(task.started_at);
      const ended = task.ended_at === null ? now : Date.parse(task.ended_at);
      const seconds =
        started === null || !Number.isFinite(started)
          ? 0
          : Math.max(0, Math.round((ended - started) / 1000));
      return `${task.id}  ${task.status.padEnd(9)}  pid=${
        task.pid ?? "-"
      }  ${seconds}s  ${task.title}`;
    }),
  ].join("\n");
}

export function formatBackgroundLogs(
  id: string,
  logs: Awaited<ReturnType<BackgroundTaskManager["logs"]>>,
): string {
  return [
    `Background task ${id} logs`,
    `evidence: ${logs.evidence_ref}`,
    "",
    `stdout${logs.stdout_truncated ? " (truncated)" : ""}:`,
    logs.stdout.length === 0 ? "(empty)" : logs.stdout.trimEnd(),
    "",
    `stderr${logs.stderr_truncated ? " (truncated)" : ""}:`,
    logs.stderr.length === 0 ? "(empty)" : logs.stderr.trimEnd(),
  ].join("\n");
}

export function sideQueueFor(
  state: TuiState,
  runtime: CodepunkRuntime,
): SideTaskQueue {
  if (
    state.sideQueue === undefined ||
    state.sideQueueSessionId !== runtime.session.sessionId
  ) {
    state.sideQueue = new SideTaskQueue({
      paths: runtime.paths,
      sessionId: runtime.session.sessionId,
    });
    state.sideQueueSessionId = runtime.session.sessionId;
  }
  return state.sideQueue;
}

export function formatSideTasks(tasks: readonly SideTaskRecord[]): string {
  if (tasks.length === 0) {
    return "No side tasks.";
  }
  return [
    `Side tasks (${tasks.length})`,
    ...tasks.map(
      (task) =>
        `${task.id}  ${task.status.padEnd(11)}  ${task.kind}  budget=${task.budget}  ${task.prompt.slice(0, 80)}`,
    ),
  ].join("\n");
}

export async function runSideTask(
  state: TuiState,
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  kind: "btw" | "side",
  prompt: string,
): Promise<void> {
  if (prompt.trim().length === 0) {
    context.ui.notify(`usage: /${kind} <prompt>`, "warning");
    return;
  }
  if (state.childHostArgv.length === 0) {
    context.ui.notify("side task host is not available", "error");
    return;
  }
  const queue = sideQueueFor(state, runtime);
  try {
    await queue.hydrate();
    const queued = await queue.enqueue(kind, prompt);
    const taken = await queue.take(queued.id);
    if (taken === null) {
      throw new Error(`side task ${queued.id} could not be claimed`);
    }
    const manager = backgroundManager(state, runtime);
    const model = physicalModel(runtime);
    const args = [
      ...state.childHostArgv.slice(1),
      "--print",
      "--new-session-id",
      queued.id,
      "--parent-session-id",
      runtime.session.sessionId,
      ...(model === undefined
        ? []
        : ["--model", `${model.provider}/${model.id}`]),
      ...(kind === "btw"
        ? [
            "--autonomy",
            "read-only",
            "--approval",
            "ask",
            "--tools",
            "read,search",
          ]
        : []),
      queued.prompt,
    ];
    try {
      const snapshot = await manager.start({
        id: queued.id,
        title: `${kind}: ${queued.prompt.slice(0, 60)}`,
        command: state.childHostArgv[0]!,
        args,
        cwd: runtime.paths.cwd,
      });
      context.ui.notify(
        [
          `${kind} task queued: ${queued.id}`,
          `status: ${snapshot.status}`,
          `follow with /ps, /logs ${queued.id}, or /stop ${queued.id}`,
        ].join("\n"),
        "info",
      );
      void manager
        .wait(snapshot.id)
        .then((finished) =>
          queue.finish(
            queued.id,
            finished.status === "completed"
              ? "completed"
              : finished.status === "stopped"
                ? "cancelled"
                : "failed",
          ),
        )
        .catch(() => queue.finish(queued.id, "failed"))
        .catch(() => undefined);
    } catch (error) {
      await queue.finish(queued.id, "failed").catch(() => undefined);
      throw error;
    }
  } catch (error) {
    context.ui.notify(
      `/${kind} failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}
