import { appendBuildDoctorCheck, inspectCliBuild } from "../../build-info.ts";
import { notify } from "../format/notify.ts";
import {
  budgetSnapshot,
  formatBudgetCost,
  formatBudgetSummary,
} from "../format/status.ts";
import { buildPlanRoundPrompt } from "../format/init.ts";
import {
  formatPlanModeStatus,
  formatGoalStatus,
  hookStatus,
} from "../format/plan.ts";
import {
  configureCommit,
  formatWorkspaceDiff,
  restoreCheckpoint,
} from "../format/commit.ts";
import { formatSessionList } from "codepunk-core";
import { formatStatusSummary } from "../format/status-summary.ts";
import { physicalModel, modelOnboardingMessage } from "../chrome/model.ts";
import { codepunkHelp } from "../chrome/help.ts";
import { initializeProjectInstructions } from "../format/init.ts";
import {
  GoalController,
  GoalCorruptError,
  collectCapabilities,
  configSummary,
  formatCapabilities,
  formatDoctor,
  formatPlan,
  formatTodos,
  listProjectSessions,
  listUserPluginFiles,
  planContentHash,
  readWorkspaceDiff,
  readWorkState,
  runDoctor,
} from "codepunk-core";
import path from "node:path";
import type { TuiCommand } from "../define-command.ts";
import { commandContext } from "../command-context.ts";
import type { TuiState } from "../state.ts";
import { defineCommand } from "../define-command.ts";

export function helpCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "help",
    description: "Show the Codepunk command list",
    handler: commandContext(state, async (_runtime, context) => {
      await notify(context, codepunkHelp());
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
        try {
          const { createDiffView } = await import("../components/diff-view.ts");
          await context.ui.custom<void>((_tui, theme, keybindings, done) =>
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
              },
              theme,
              keybindings,
              done,
            ),
          );
        } catch {
          await notify(context, formatWorkspaceDiff(diff));
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
          await notify(
            context,
            formatPlanModeStatus(
              runtime.planMode.state(),
              readWorkState(runtime.session.allEvents).plan,
            ),
          );
          return;
        }
        if (subcommand === "on") {
          const state = await runtime.planMode.enter();
          await notify(
            context,
            [
              `Plan mode: ${state.mode}`,
              "Only read-only tools are available. Record a plan, then run /plan-mode approve.",
            ].join("\n"),
          );
          return;
        }
        if (subcommand === "approve") {
          const state = await runtime.planMode.approve();
          const planHash =
            state.plan_sha256 ??
            planContentHash(readWorkState(runtime.session.allEvents).plan);
          await notify(
            context,
            [
              `Plan mode: ${state.mode}`,
              planHash === null
                ? "No plan hash is bound."
                : `Approved plan hash: ${planHash}`,
            ].join("\n"),
          );
          return;
        }
        if (subcommand === "off") {
          const state = await runtime.planMode.exit();
          await notify(context, `Plan mode: ${state.mode}`);
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

export function hooksCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "hooks",
    description: "Show lifecycle hook evidence",
    handler: commandContext(state, async (runtime, context, args) => {
      if (args.trim() !== "" && args.trim() !== "status") {
        context.ui.notify("usage: /hooks [status]", "warning");
        return;
      }
      await notify(context, hookStatus(runtime.session.allEvents));
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

export function evidenceCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "evidence",
    description: "Show current run evidence count",
    handler: commandContext(state, async (runtime, context) => {
      const records = runtime.ledger.all;
      await notify(
        context,
        records.length === 0
          ? "No evidence in the current run."
          : `${records.length} evidence record(s); head ${runtime.ledger.head ?? "none"}`,
      );
    }),
  });
}

export function budgetCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "budget",
    description: "Show model token and cost usage against the budget",
    handler: commandContext(state, async (runtime, context) => {
      const usage = runtime.usage();
      const budget = budgetSnapshot(runtime);
      await notify(
        context,
        [
          `tokens: ${budget.usedTokens}${
            budget.maxTokens === null ? "" : ` / ${budget.maxTokens}`
          }`,
          `cost: ${formatBudgetCost(budget.usedCostUsd)}${
            budget.maxCostUsd === null
              ? ""
              : ` / ${formatBudgetCost(budget.maxCostUsd)}`
          }`,
          `calls: ${usage.calls}`,
          `budget: ${formatBudgetSummary(budget)}`,
          ...(budget.maxTokens === null && budget.maxCostUsd === null
            ? []
            : [
                "guard: enforced from recorded model usage; exceeding it aborts the run",
              ]),
        ].join("\n"),
      );
    }),
  });
}

export function doctorCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "doctor",
    description: "Run codepunk doctor",
    handler: commandContext(state, async (runtime, context) => {
      const build = await inspectCliBuild();
      const report = appendBuildDoctorCheck(
        await runDoctor({
          paths: runtime.paths,
          config: runtime.config,
          pluginEnabled: runtime.plugins.enabled,
          packageVersion: build.version,
        }),
        build,
      );
      await notify(context, formatDoctor(report));
    }),
  });
}

export function policyCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "policy",
    description: "Show effective codepunk policy",
    handler: commandContext(state, async (runtime, context) => {
      await notify(
        context,
        [
          ...configSummary(runtime.config, runtime.policy.writeSet),
          `policy layers: ${runtime.policy.layers.map((layer) => layer.layer).join(", ") || "default"}`,
          `plugins: ${runtime.plugins.enabled ? "enabled" : "disabled"}`,
          `isolation: ${
            [
              runtime.isolation.context ? "context" : null,
              runtime.isolation.skills ? "skills" : null,
              runtime.isolation.plugins ? "plugins" : null,
              runtime.isolation.mcp ? "mcp" : null,
              runtime.isolation.memory ? "memory" : null,
            ]
              .filter((entry): entry is string => entry !== null)
              .join(", ") || "none"
          }`,
        ].join("\n"),
      );
    }),
  });
}

export function capabilitiesCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "capabilities",
    description: "List MCP servers, skills, and plugins",
    handler: commandContext(state, async (runtime, context) => {
      const snapshot = await collectCapabilities(runtime.paths, {
        pluginEnabled: runtime.plugins.enabled,
        skills: runtime.skills,
        ...(runtime.plugins.paths.length > 0
          ? { pluginFiles: runtime.plugins.paths }
          : {}),
      });
      await notify(context, formatCapabilities(snapshot));
    }),
  });
}

export function skillsCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "skills",
    description: "List loaded skills and management commands",
    handler: commandContext(state, async (runtime, context) => {
      const lines = [
        runtime.isolation.skills
          ? "Skills (disabled for this session)"
          : `Skills (${runtime.skills.length})`,
      ];
      if (runtime.isolation.skills) {
        lines.push(
          "  restart without --no-skills or --bare to load installed skills",
        );
        await notify(context, lines.join("\n"));
        return;
      }
      if (runtime.skills.length === 0) {
        lines.push("  none");
      } else {
        for (const skill of runtime.skills) {
          lines.push(
            `  ${skill.scope.padEnd(7)} ${skill.name}  ${skill.bytes} B${skill.disable_model_invocation ? `  manual-only (/skill:${skill.name})` : ""}`,
          );
          lines.push(`          ${skill.path}`);
        }
      }
      lines.push(
        "",
        "add:    codepunk skills add <dir> [--scope user|project]",
        "remove: codepunk skills remove <name> [--scope user|project]",
        "run /reload after changing skills",
      );
      await notify(context, lines.join("\n"));
    }),
  });
}

export function pluginsCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "plugins",
    description: "List plugin files and management commands",
    handler: commandContext(state, async (runtime, context) => {
      const directory = path.join(runtime.paths.home, "extensions");
      const files = await listUserPluginFiles(directory);
      await notify(
        context,
        [
          `Plugins (${runtime.plugins.enabled ? "enabled" : runtime.isolation.plugins ? "disabled for this session" : "disabled"}, ${files.length} file${files.length === 1 ? "" : "s"})`,
          `directory: ${directory}`,
          ...(files.length === 0
            ? ["  none"]
            : files.map((file) => `  ${file}`)),
          "",
          "enable:  codepunk plugins enable",
          "disable: codepunk plugins disable",
          "add:     codepunk plugins add <file> [--force]",
          "remove:  codepunk plugins remove <file>",
          "run /reload after changes; plugin tools are rejected",
        ].join("\n"),
      );
    }),
  });
}
