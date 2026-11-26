import { notify } from "../format/notify.ts";
import {
  buildPlanRoundPrompt,
  initializeProjectInstructions,
} from "../format/init.ts";
import { formatPlanModeStatus, formatGoalStatus } from "../format/plan.ts";
import {
  configureCommit,
  formatWorkspaceDiff,
  restoreCheckpoint,
} from "../format/commit.ts";
import { formatSessionList } from "codepunk-core";
import { formatStatusSummary } from "../format/status-summary.ts";
import { physicalModel, modelOnboardingMessage } from "../chrome/model.ts";
import { refreshStatus } from "../chrome/statusline.ts";
import { refreshWorkWidget } from "../chrome/work-widget.ts";
import { openInteractiveHelp } from "../chrome/help-action.ts";
import {
  GoalController,
  GoalCorruptError,
  formatPlan,
  formatTodos,
  listProjectSessions,
  planContentHash,
  readWorkspaceDiff,
  readWorkState,
} from "codepunk-core";
import type { DiffViewAction } from "../components/diff-view.ts";
import type { TuiCommand } from "../define-command.ts";
import { commandContext } from "../command-context.ts";
import type { TuiState } from "../state.ts";
import { defineCommand } from "../define-command.ts";

export {
  budgetCommand,
  capabilitiesCommand,
  contextCommand,
  doctorCommand,
  evidenceCommand,
  hooksCommand,
  pluginsCommand,
  policyCommand,
  skillsCommand,
} from "./inspect.ts";

export function helpCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "help",
    description: "Search, browse, and run Codepunk commands",
    handler: commandContext(state, async (_runtime, context, args) => {
      await openInteractiveHelp(state, context, args.trim());
    }),
  });
}

export function initCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "init",
    description: "Create or update AGENTS.md from repository evidence",
    handler: commandContext(state, async (runtime, context, args) => {
      await initializeProjectInstructions(runtime, context, args);
    }),
  });
}

export function diffCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "diff",
    description: "Show staged and unstaged working tree changes",
    handler: commandContext(state, async (runtime, context, args) => {
      if (args.trim().length > 0) {
        context.ui.notify("usage: /diff", "warning");
        return;
      }
      try {
        const diff = await readWorkspaceDiff({
          root: runtime.paths.deliveryRoot,
        });
        let action: DiffViewAction | null = null;
        try {
          const [{ createDiffView }, { defaultViewportHeight }] =
            await Promise.all([
              import("../components/diff-view.ts"),
              import("../components/frame.ts"),
            ]);
          action = await context.ui.custom<DiffViewAction | null>(
            (_tui, theme, keybindings, done) =>
              createDiffView(
                {
                  title: `Working tree diff · ${diff.root}`,
                  source: {
                    root: diff.root,
                    status: diff.status,
                    stat: diff.stat,
                    staged: diff.staged,
                    unstaged: diff.unstaged,
                    untracked: diff.untracked
                      .split(/\r?\n/u)
                      .map((entry) => entry.trim())
                      .filter((entry) => entry.length > 0),
                    truncated: diff.truncated,
                  },
                  viewportHeight: Math.max(6, defaultViewportHeight() - 1),
                  onAction: (next) => done(next),
                },
                theme,
                keybindings,
                () => done(null),
              ),
          );
        } catch {
          await notify(context, formatWorkspaceDiff(diff));
          return;
        }
        if (action === "commit") {
          await configureCommit(state, context, "");
        } else if (action === "undo") {
          await restoreCheckpoint(state, context, "undo", "");
        } else if (action === "review") {
          await runtime.host.session.prompt("/review");
        }
      } catch (error) {
        context.ui.notify(
          `/diff failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
      }
    }),
  });
}

export function undoCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "undo",
    description: "Restore recent Codepunk write/edit changes",
    handler: commandContext(state, async (_runtime, context, args) => {
      await restoreCheckpoint(state, context, "undo", args);
    }),
  });
}

export function redoCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "redo",
    description: "Reapply changes removed by /undo",
    handler: commandContext(state, async (_runtime, context, args) => {
      await restoreCheckpoint(state, context, "redo", args);
    }),
  });
}

export function commitCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "commit",
    description: "Review and create a Git commit as a human action",
    handler: commandContext(state, async (_runtime, context, args) => {
      await configureCommit(state, context, args);
    }),
  });
}

export function statusCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "status",
    description: "Show model, session, permission, trust, and usage status",
    handler: commandContext(state, async (runtime, context) => {
      try {
        const { createStatusPanel } =
          await import("../components/status-panel.ts");
        await context.ui.custom<void>((_tui, theme, keybindings, done) =>
          createStatusPanel(runtime, theme, keybindings, done),
        );
      } catch {
        await notify(context, formatStatusSummary(runtime));
      }
    }),
  });
}

export function cp_sessionsCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "cp-sessions",
    description: "List codepunk sessions",
    handler: commandContext(state, async (runtime, context) => {
      const sessions = await listProjectSessions(
        runtime.paths.home,
        runtime.paths.projectId,
      );
      await notify(context, formatSessionList(sessions));
    }),
  });
}

export function planCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "plan",
    description:
      "Show the current plan, or plan a request in read-only plan mode",
    handler: commandContext(state, async (runtime, context, args) => {
      const request = args.trim();
      if (request.length === 0) {
        const work = readWorkState(runtime.session.allEvents);
        await notify(context, formatPlan(work.plan));
        return;
      }
      if (physicalModel(runtime) === undefined) {
        context.ui.notify(
          modelOnboardingMessage(runtime) ??
            "No model selected. Use /model to choose one.",
          "warning",
        );
        return;
      }
      try {
        if (runtime.planMode.state()?.mode !== "planning") {
          await runtime.planMode.enter();
          context.ui.notify(
            [
              "Plan mode: planning",
              "Only read-only tools are available. Approve the recorded plan with /plan-mode approve.",
            ].join("\n"),
            "info",
          );
        }
        await runtime.host.session.prompt(buildPlanRoundPrompt(request));
      } catch (error) {
        context.ui.notify(
          `/plan failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
      }
    }),
  });
}

export function plan_modeCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "plan-mode",
    description: "Show, enter, approve, or exit plan mode",
    handler: commandContext(state, async (runtime, context, args) => {
      const subcommand = args.trim();
      try {
        if (subcommand === "" || subcommand === "status") {
          const current = runtime.planMode.state();
          const plan = readWorkState(runtime.session.allEvents).plan;
          if (
            subcommand === "" &&
            current?.mode === "planning" &&
            plan !== null &&
            plan.steps.length > 0 &&
            typeof context.ui.select === "function"
          ) {
            const action = await context.ui.select(
              formatPlanModeStatus(current, plan),
              ["Approve and execute plan", "Keep planning", "Exit plan mode"],
            );
            if (action === "Approve and execute plan") {
              const next = await runtime.planMode.approve();
              refreshWorkWidget(state, context);
              refreshStatus(state, context);
              await notify(context, `Plan mode: ${next.mode}`);
              return;
            }
            if (action === "Exit plan mode") {
              const next = await runtime.planMode.exit();
              refreshWorkWidget(state, context);
              refreshStatus(state, context);
              await notify(context, `Plan mode: ${next.mode}`);
              return;
            }
            return;
          }
          await notify(context, formatPlanModeStatus(current, plan));
          return;
        }
        if (subcommand === "on") {
          const next = await runtime.planMode.enter();
          refreshWorkWidget(state, context);
          refreshStatus(state, context);
          await notify(
            context,
            [
              `Plan mode: ${next.mode}`,
              "Only read-only tools are available. Record a plan, then run /plan-mode approve.",
            ].join("\n"),
          );
          return;
        }
        if (subcommand === "approve") {
          const next = await runtime.planMode.approve();
          refreshWorkWidget(state, context);
          refreshStatus(state, context);
          const planHash =
            next.plan_sha256 ??
            planContentHash(readWorkState(runtime.session.allEvents).plan);
          await notify(
            context,
            [
              `Plan mode: ${next.mode}`,
              planHash === null
                ? "No plan hash is bound."
                : `Approved plan hash: ${planHash}`,
            ].join("\n"),
          );
          return;
        }
        if (subcommand === "off") {
          const next = await runtime.planMode.exit();
          refreshWorkWidget(state, context);
          refreshStatus(state, context);
          await notify(context, `Plan mode: ${next.mode}`);
          return;
        }
        context.ui.notify(
          "usage: /plan-mode [status|on|approve|off]",
          "warning",
        );
      } catch (error) {
        context.ui.notify(
          `/plan-mode failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
      }
    }),
  });
}

export function goalCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "goal",
    description: "Create or manage the goal that survives turns",
    handler: commandContext(state, async (runtime, context, args) => {
      const controller = new GoalController(runtime.session);
      const subcommand = args.trim();
      try {
        if (subcommand === "" || subcommand === "status") {
          await notify(context, formatGoalStatus(controller.state));
          return;
        }
        if (subcommand === "pause") {
          await controller.pause();
        } else if (subcommand === "resume") {
          await controller.resume();
        } else if (subcommand === "clear") {
          await controller.clear();
        } else {
          await controller.set(subcommand);
        }
        await notify(context, formatGoalStatus(controller.state));
      } catch (error) {
        context.ui.notify(
          `/goal failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error instanceof GoalCorruptError ? "error" : "warning",
        );
      }
    }),
  });
}

export function todosCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "todos",
    description: "Show the current todo list",
    handler: commandContext(state, async (runtime, context) => {
      const work = readWorkState(runtime.session.allEvents);
      await notify(context, formatTodos(work.todos));
    }),
  });
}
