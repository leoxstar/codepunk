import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  collectCapabilities,
  configSummary,
  formatCapabilities,
  formatDoctor,
  listUserPluginFiles,
  runDoctor,
  writeUserPluginsEnabled,
  type CodepunkRuntime,
} from "codepunk-core";
import { appendBuildDoctorCheck, inspectCliBuild } from "../../build-info.ts";
import { commandContext } from "../command-context.ts";
import {
  createCapabilitiesPanel,
  type CapabilityPanelAction,
} from "../components/capabilities-panel.ts";
import {
  buildContextBreakdown,
  createContextPanel,
} from "../components/context-panel.ts";
import { createEvidenceInspector } from "../components/evidence-inspector.ts";
import { defaultViewportHeight } from "../components/frame.ts";
import {
  createDoctorPanel,
  createStructuredTextPanel,
} from "../components/inspect-panels.ts";
import { defineCommand, type TuiCommand } from "../define-command.ts";
import { notify } from "../format/notify.ts";
import { hookStatus } from "../format/plan.ts";
import {
  budgetSnapshot,
  formatBudgetCost,
  formatBudgetSummary,
} from "../format/status.ts";
import type { TuiState } from "../state.ts";

async function showStructuredOrNotify(
  context: ExtensionCommandContext,
  title: string,
  sections: {
    readonly label: string;
    readonly lines: readonly string[];
    readonly tone?: "default" | "muted" | "warning" | "error";
  }[],
  fallbackText: string,
  tone: "default" | "accent" | "warning" | "error" = "accent",
): Promise<void> {
  if (typeof context.ui.custom === "function") {
    try {
      await context.ui.custom<void>((_tui, theme, keybindings, done) =>
        createStructuredTextPanel(
          title,
          sections,
          theme,
          keybindings,
          done,
          tone,
        ),
      );
      return;
    } catch {
      // Fall back to plain notification below.
    }
  }
  await notify(context, fallbackText);
}

async function triggerReload(
  state: TuiState,
  runtime: CodepunkRuntime,
): Promise<void> {
  try {
    await runtime.reloadConfig();
    await runtime.reloadPlugins();
    await runtime.reloadSkills();
    await runtime.reloadMcp();
    state.context?.ui.notify(
      "Reloaded config, plugins, skills, and MCP configuration.",
      "info",
    );
  } catch (error) {
    state.context?.ui.notify(
      `Reload failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

export function contextCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "context",
    description: "Visualize context window token usage and breakdown",
    handler: commandContext(state, async (runtime, context) => {
      if (typeof context.ui.custom === "function") {
        const action = await context.ui.custom<"compact" | null>(
          (_tui, theme, keybindings, done) =>
            createContextPanel(runtime, theme, keybindings, done),
        );
        if (action === "compact") {
          await runtime.host.session.prompt("/compact");
        }
        return;
      }
      const b = buildContextBreakdown(runtime);
      const lines = [
        `Context usage: ${b.usedTokens} tokens${b.contextWindow ? ` / ${b.contextWindow}` : ""}${b.percent !== null ? ` (${b.percent}%)` : ""}`,
        ...b.categories.map(
          (cat) => `  ${cat.label}: ${cat.tokens} tokens (${cat.detail})`,
        ),
      ];
      await notify(context, lines.join("\n"));
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
      const text = hookStatus(runtime.session.allEvents);
      if (args.trim() === "status") {
        await notify(context, text);
        return;
      }
      await showStructuredOrNotify(
        context,
        "codepunk hooks",
        [{ label: "Lifecycle hooks", lines: text.split("\n") }],
        text,
      );
    }),
  });
}

export function evidenceCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "evidence",
    description: "Inspect current run evidence ledger",
    handler: commandContext(state, async (runtime, context) => {
      const records = runtime.ledger.all;
      if (typeof context.ui.custom === "function") {
        await context.ui.custom<void>((_tui, theme, keybindings, done) =>
          createEvidenceInspector(
            {
              records,
              head: runtime.ledger.head,
              viewportHeight: defaultViewportHeight(),
            },
            theme,
            keybindings,
            done,
          ),
        );
        return;
      }
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
      const lines = [
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
      ];
      await showStructuredOrNotify(
        context,
        "codepunk budget",
        [{ label: "Usage & limits", lines }],
        lines.join("\n"),
      );
    }),
  });
}

export function doctorCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "doctor",
    description: "Run codepunk doctor diagnostics",
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
      if (typeof context.ui.custom === "function") {
        await context.ui.custom<void>((_tui, theme, keybindings, done) =>
          createDoctorPanel(report, theme, keybindings, done),
        );
        return;
      }
      await notify(context, formatDoctor(report));
    }),
  });
}

export function policyCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "policy",
    description: "Show effective codepunk policy",
    handler: commandContext(state, async (runtime, context) => {
      const summary = configSummary(runtime.config, runtime.policy.writeSet);
      const meta = [
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
      ];
      await showStructuredOrNotify(
        context,
        "codepunk policy",
        [
          { label: "Effective configuration", lines: summary },
          { label: "Layers & isolation", lines: meta },
        ],
        [...summary, ...meta].join("\n"),
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
      const text = formatCapabilities(snapshot);
      await showStructuredOrNotify(
        context,
        "codepunk capabilities",
        [{ label: "Overview", lines: text.split("\n") }],
        text,
      );
    }),
  });
}

export function skillsCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "skills",
    description: "Inspect loaded skills and reload",
    handler: commandContext(state, async (runtime, context) => {
      const summary = runtime.isolation.skills
        ? "Skills (disabled for this session)"
        : `Skills (${runtime.skills.length})`;
      const notes = runtime.isolation.skills
        ? ["restart without --no-skills or --bare to load installed skills"]
        : [
            "add:    codepunk skills add <dir> [--scope user|project]",
            "remove: codepunk skills remove <name> [--scope user|project]",
            "run /reload after changing skills",
          ];
      if (typeof context.ui.custom === "function") {
        const action = await context.ui.custom<CapabilityPanelAction>(
          (_tui, theme, keybindings, done) =>
            createCapabilitiesPanel(
              {
                title: "codepunk skills",
                summary,
                items: runtime.isolation.skills
                  ? []
                  : runtime.skills.map((skill) => ({
                      label: `${skill.name}  (${skill.bytes} B)${skill.disable_model_invocation ? ` · manual-only (/skill:${skill.name})` : ""}`,
                      badge: skill.scope,
                      detail: skill.path,
                    })),
                emptyText: "none",
                notes,
                viewportHeight: defaultViewportHeight(),
              },
              theme,
              keybindings,
              done,
            ),
        );
        if (action === "reload") {
          await triggerReload(state, runtime);
        }
        return;
      }
      const lines = [
        summary,
        ...(runtime.skills.length === 0
          ? ["  none"]
          : runtime.skills.map(
              (skill) =>
                `  ${skill.scope.padEnd(7)} ${skill.name}  ${skill.bytes} B`,
            )),
        "",
        ...notes,
      ];
      await notify(context, lines.join("\n"));
    }),
  });
}

export function pluginsCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "plugins",
    description: "Inspect plugins, toggle enablement, or reload",
    handler: commandContext(state, async (runtime, context) => {
      const directory = path.join(runtime.paths.home, "extensions");
      const files = await listUserPluginFiles(directory);
      const summary = `Plugins (${runtime.plugins.enabled ? "enabled" : runtime.isolation.plugins ? "disabled for this session" : "disabled"}, ${files.length} file${files.length === 1 ? "" : "s"})`;
      const notes = [
        `directory: ${directory}`,
        "enable:  codepunk plugins enable",
        "disable: codepunk plugins disable",
        "add:     codepunk plugins add <file> [--force]",
        "remove:  codepunk plugins remove <file>",
        "run /reload after changes; plugin tools are rejected",
      ];
      if (typeof context.ui.custom === "function") {
        const action = await context.ui.custom<CapabilityPanelAction>(
          (_tui, theme, keybindings, done) =>
            createCapabilitiesPanel(
              {
                title: "codepunk plugins",
                summary,
                items: files.map((file) => ({ label: file })),
                emptyText: "none",
                notes,
                allowPluginToggle: !runtime.isolation.plugins,
                pluginsEnabled: runtime.plugins.enabled,
                viewportHeight: defaultViewportHeight(),
              },
              theme,
              keybindings,
              done,
            ),
        );
        if (action === "reload") {
          await triggerReload(state, runtime);
        } else if (action === "toggle-plugins") {
          const next = !runtime.plugins.enabled;
          if (next) {
            const confirmed = await context.ui.confirm(
              "Enable plugins?",
              "Plugins run trusted in-process code and can bypass policy, approval, sandbox, and evidence.",
            );
            if (!confirmed) {
              return;
            }
          }
          await writeUserPluginsEnabled(runtime.paths, next);
          await triggerReload(state, runtime);
        }
        return;
      }
      await notify(
        context,
        [
          summary,
          ...(files.length === 0 ? ["  none"] : files.map((f) => `  ${f}`)),
          "",
          ...notes,
        ].join("\n"),
      );
    }),
  });
}
