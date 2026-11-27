import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { permissionProfileFor } from "codepunk-core";
import { openInteractiveHelp } from "../chrome/help-action.ts";
import { setupChrome } from "../chrome/setup.ts";
import { applyTuiTheme, availableThemeChoices } from "../chrome/theme.ts";
import {
  createCommandPalette,
  type CommandPaletteItem,
} from "../components/command-palette.ts";
import { defaultViewportHeight } from "../components/frame.ts";
import { configureCommit } from "../format/commit.ts";
import { cycleWorkMode } from "../format/mode-cycle.ts";
import type { TuiState } from "../state.ts";
import { runCopyAction } from "./copy.ts";
import { executeCustomCommandAction } from "./custom-commands.ts";
import { openExternalPromptEditor } from "./editor.ts";
import {
  openAttestOverlay,
  openContextOverlay,
  openDoctorOverlay,
  openEvidenceOverlay,
  openPluginsOverlay,
  openSkillsOverlay,
} from "./inspect.ts";
import { openInteractiveMcpPanel } from "./mcp.ts";
import { configurePermissions } from "./permission-actions.ts";
import { openMemoryBrowserLoop } from "./permissions.ts";
import { openDiffOverlay, openStatusOverlay } from "./project.ts";
import { openRewindPicker } from "./rewind.ts";
import { resumeSession, startNewSession } from "./session.ts";
import { showInteractiveSettingsMenu } from "./settings.ts";
import { showTaskCenter } from "./tasks.ts";
import { configureTrust } from "./trust-actions.ts";

const STATIC_PALETTE_ITEMS: readonly CommandPaletteItem[] = [
  {
    id: "git:diff",
    category: "Git",
    label: "Working tree diff",
    hint: "inspect staged, unstaged, and stat views",
    shortcut: "/diff",
    keywords: "changes patch git status",
  },
  {
    id: "git:commit",
    category: "Git",
    label: "Create Git commit",
    hint: "review files, pick scope, and commit",
    shortcut: "/commit",
    keywords: "git stage message",
  },
  {
    id: "inspect:context",
    category: "Inspect",
    label: "Context breakdown",
    hint: "token usage by system, instructions, skills, memory, turns",
    shortcut: "/context",
    keywords: "tokens window compact budget",
  },
  {
    id: "inspect:status",
    category: "Inspect",
    label: "Session status",
    hint: "model, permissions, trust, usage, evidence",
    shortcut: "/status",
    keywords: "summary info",
  },
  {
    id: "inspect:doctor",
    category: "Inspect",
    label: "Run diagnostics",
    hint: "check sandbox, build, auth, and config health",
    shortcut: "/doctor",
    keywords: "health check srt",
  },
  {
    id: "inspect:attest",
    category: "Inspect",
    label: "Verification summary",
    hint: "generate PR-ready Markdown summary from evidence chain",
    shortcut: "/attest",
    keywords: "pr summary audit sign verification",
  },
  {
    id: "work:tasks",
    category: "Work",
    label: "Task & subagent center",
    hint: "inspect, steer, or stop background work",
    shortcut: "Alt+T",
    keywords: "agents ps logs background",
  },
  {
    id: "work:rewind",
    category: "Work",
    label: "Rewind checkpoints or branch",
    hint: "undo file edits or restore session state",
    shortcut: "Alt+R",
    keywords: "undo redo checkpoint tree",
  },
  {
    id: "config:trust",
    category: "Config",
    label: "Workspace trust grants",
    hint: "toggle config, policy, skills, instructions",
    shortcut: "/trust",
    keywords: "grant revoke untrusted project",
  },
  {
    id: "config:settings",
    category: "Config",
    label: "TUI & runtime settings",
    hint: "thinking, header, status bar, widgets, compaction",
    shortcut: "/settings",
    keywords: "preferences config",
  },
  {
    id: "model:pick",
    category: "Model",
    label: "Switch model",
    hint: "open searchable model picker",
    shortcut: "/model",
    keywords: "provider recent favorite f2",
  },
  {
    id: "session:resume",
    category: "Session",
    label: "Resume session",
    hint: "fuzzy-search project sessions",
    shortcut: "/resume",
    keywords: "history switch",
  },
  {
    id: "session:new",
    category: "Session",
    label: "Start new session",
    hint: "begin a fresh session in this project",
    shortcut: "/new",
    keywords: "reset clear",
  },
  {
    id: "caps:mcp",
    category: "Tools",
    label: "MCP servers",
    hint: "list, add, login, reload, or remove servers",
    shortcut: "/mcp",
    keywords: "servers tools oauth",
  },
  {
    id: "caps:skills",
    category: "Tools",
    label: "Installed skills",
    hint: "inspect loaded skills or reload",
    shortcut: "/skills",
    keywords: "capabilities",
  },
  {
    id: "caps:plugins",
    category: "Tools",
    label: "Plugins",
    hint: "inspect plugins or enable/disable",
    shortcut: "/plugins",
    keywords: "extensions",
  },
  {
    id: "caps:memory",
    category: "Tools",
    label: "Memory browser",
    hint: "search, add, archive, or delete saved facts",
    shortcut: "/memory",
    keywords: "remember notes facts",
  },
  {
    id: "copy:last",
    category: "Work",
    label: "Copy last assistant reply",
    hint: "copy latest reply or use /copy code for fenced code",
    shortcut: "/copy",
    keywords: "clipboard yank snippet output",
  },
  {
    id: "editor:open",
    category: "Work",
    label: "Compose prompt in external editor",
    hint: "open $VISUAL or $EDITOR for multi-line prompt editing",
    shortcut: "Alt+G",
    keywords: "vim nvim vscode editor draft",
  },
  {
    id: "custom:run",
    category: "Tools",
    label: "Run custom template command",
    hint: "pick from $CODEPUNK_HOME/commands or trusted .codepunk/commands",
    shortcut: "/run",
    keywords: "template prompt slash markdown",
  },
  {
    id: "help:browse",
    category: "Help",
    label: "Command help browser",
    hint: "search and run any slash command",
    shortcut: "F1",
    keywords: "commands manual shortcuts",
  },
];

export function buildPaletteItems(state: TuiState): CommandPaletteItem[] {
  const runtime = state.runtime;
  const profile =
    runtime === null ? "standard" : permissionProfileFor(runtime.config);
  const theme = runtime?.config.tui.theme ?? "codepunk";
  const evidence = runtime?.ledger.all.length ?? 0;
  return [
    {
      id: "mode:cycle",
      category: "Mode",
      label: "Cycle work mode",
      hint: `current: ${runtime?.planMode.state()?.mode === "planning" ? "plan" : profile}`,
      shortcut: "Alt+M",
      keywords: "plan standard auto approve permissions",
    },
    {
      id: "inspect:evidence",
      category: "Inspect",
      label: "Evidence inspector",
      hint: `${evidence} record(s) in current run`,
      shortcut: "/evidence",
      keywords: "audit ledger log hash",
    },
    {
      id: "config:permissions",
      category: "Config",
      label: "Permissions & sandbox",
      hint: `profile: ${profile}`,
      shortcut: "/permissions",
      keywords: "approval autonomy sandbox network rules",
    },
    {
      id: "config:theme",
      category: "Config",
      label: "Switch TUI theme",
      hint: `current: ${theme}`,
      shortcut: "/settings",
      keywords: "dark light system appearance colors",
    },
    ...STATIC_PALETTE_ITEMS,
  ];
}

async function switchThemeInteractive(
  state: TuiState,
  context: ExtensionContext,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    return;
  }
  const choices = availableThemeChoices(context);
  const labels = choices.map(
    (choice) =>
      `${choice.id === runtime.config.tui.theme ? "\u2713" : " "} ${choice.label}`,
  );
  const picked = await context.ui.select("TUI theme", labels);
  if (picked === undefined) {
    return;
  }
  const chosen = choices[labels.indexOf(picked)];
  if (chosen === undefined) {
    return;
  }
  const applied = await applyTuiTheme(runtime, context, chosen.id);
  if (applied.ok) {
    setupChrome(state, context);
    context.ui.notify(`Theme saved as ${chosen.id}.`, "info");
  } else {
    context.ui.notify(
      `Theme switch failed: ${applied.error ?? chosen.id}`,
      "warning",
    );
  }
}

export async function openCommandPalette(
  state: TuiState,
  context: ExtensionContext,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  const items = buildPaletteItems(state);
  let selectedId: string | null = null;
  if (typeof context.ui.custom === "function") {
    selectedId = await context.ui.custom<string | null>(
      (_tui, theme, keybindings, done) =>
        createCommandPalette(
          {
            title: "Codepunk command palette",
            items,
            viewportHeight: defaultViewportHeight(),
          },
          theme,
          keybindings,
          done,
        ),
    );
  } else {
    const labels = items.map(
      (item) =>
        `[${item.category}] ${item.label}${item.shortcut ? ` (${item.shortcut})` : ""}`,
    );
    const chosen = await context.ui.select("Codepunk command palette", labels);
    selectedId =
      chosen === undefined ? null : (items[labels.indexOf(chosen)]?.id ?? null);
  }
  if (selectedId === null || selectedId === undefined) {
    return;
  }
  switch (selectedId) {
    case "mode:cycle":
      await cycleWorkMode(state, context);
      return;
    case "config:permissions":
      await configurePermissions(state, context, "");
      return;
    case "config:trust":
      await configureTrust(state, context, "");
      return;
    case "config:theme":
      await switchThemeInteractive(state, context);
      return;
    case "config:settings":
      await showInteractiveSettingsMenu(state, context, "");
      return;
    case "work:tasks":
      await showTaskCenter(state, runtime, context as never);
      return;
    case "work:rewind":
      await openRewindPicker(state, context as never);
      return;
    case "session:resume":
      await resumeSession(state, context, "");
      return;
    case "session:new":
      await startNewSession(state, context);
      return;
    case "help:browse":
      await openInteractiveHelp(state, context);
      return;
    case "model:pick":
      context.ui.setEditorText("/model");
      context.ui.notify(
        "Prepared /model in the editor — press Enter to open the model picker.",
        "info",
      );
      return;
    case "git:diff":
      await openDiffOverlay(state, runtime, context);
      return;
    case "git:commit":
      await configureCommit(state, context as ExtensionCommandContext, "");
      return;
    case "inspect:context":
      await openContextOverlay(runtime, context);
      return;
    case "inspect:status":
      await openStatusOverlay(runtime, context);
      return;
    case "inspect:evidence":
      await openEvidenceOverlay(runtime, context);
      return;
    case "inspect:doctor":
      await openDoctorOverlay(runtime, context);
      return;
    case "inspect:attest":
      await openAttestOverlay(runtime, context);
      return;
    case "caps:mcp":
      await openInteractiveMcpPanel(state, runtime, context);
      return;
    case "caps:skills":
      await openSkillsOverlay(state, runtime, context);
      return;
    case "caps:plugins":
      await openPluginsOverlay(state, runtime, context);
      return;
    case "caps:memory":
      await openMemoryBrowserLoop(runtime, context);
      return;
    case "copy:last":
      await runCopyAction(runtime, context, "");
      return;
    case "editor:open":
      await openExternalPromptEditor(runtime, context, "");
      return;
    case "custom:run":
      await executeCustomCommandAction(runtime, context, "");
      return;
  }
}
