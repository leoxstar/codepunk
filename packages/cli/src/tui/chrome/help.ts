import {
  APPROVAL_MODE_NAMES,
  PERMISSION_PROFILE_NAMES,
  permissionProfileFor,
  type CodepunkRuntime,
} from "codepunk-core";

const AUTONOMY_PROFILES = ["read-only", "ask", "scoped"] as const;
const SANDBOX_MODES = ["required", "uncovered"] as const;
const FILESYSTEM_MODES = ["workspace", "full"] as const;

export function permissionUsage(): string {
  return [
    "usage:",
    "  /permissions profile|approval|autonomy|sandbox|filesystem  choose with arrows",
    `  /permissions profile ${PERMISSION_PROFILE_NAMES.join("|")}`,
    `  /permissions approval ${APPROVAL_MODE_NAMES.join("|")} · reviewer off|model`,
    "  /permissions autonomy read-only|ask|scoped",
    "  /permissions sandbox required|uncovered",
    "  /permissions sandbox network [allow|deny <domain>...|clear]",
    "  /permissions filesystem workspace|full",
    "  /permissions rules",
    "  /permissions why -- <shell command>",
    "  /trust [status|grant|revoke] [config,policy,skills,instructions]",
  ].join("\n");
}

export function permissionPicker(
  runtime: CodepunkRuntime,
  group: string,
): { values: readonly string[]; current: string } | null {
  switch (group) {
    case "profile":
      return {
        values: PERMISSION_PROFILE_NAMES,
        current: permissionProfileFor(runtime.config),
      };
    case "approval":
      return {
        values: APPROVAL_MODE_NAMES,
        current: runtime.config.approval.mode,
      };
    case "autonomy":
      return {
        values: AUTONOMY_PROFILES,
        current: runtime.config.autonomy.profile,
      };
    case "sandbox":
      return {
        values: SANDBOX_MODES,
        current: runtime.config.sandbox.mode,
      };
    case "filesystem":
      return {
        values: FILESYSTEM_MODES,
        current: runtime.config.filesystem.mode,
      };
    default:
      return null;
  }
}

export function parsePermissionWhyCommand(argument: string): string | null {
  const trimmed = argument.trim();
  if (trimmed !== "why" && !trimmed.startsWith("why ")) {
    return null;
  }
  let command = trimmed.slice("why".length).trim();
  if (command === "--") {
    command = "";
  } else if (command.startsWith("-- ")) {
    command = command.slice(3).trim();
  }
  return command.length === 0 ? null : command;
}
export function codepunkHelp(): string {
  return [
    "Codepunk commands",
    "Press Alt+K for the command palette, F1 or /help [query] to search and run commands.",
    "",
    "Daily essentials",
    "  Alt+K                      open the fuzzy command palette for quick actions",
    "  Alt+M                      cycle work mode (plan/standard/auto/auto-approve)",
    "  Alt+T / /tasks             open the unified interactive task & subagent center",
    "  Alt+R / /rewind            rewind file checkpoints or switch session branches",
    "  Alt+G / /editor [--reply]  compose or edit the prompt in $VISUAL/$EDITOR",
    "  F1 / /help [query]         search, browse, and run commands interactively",
    "  F2 / /model                cycle recent models or search all models",
    "  Shift+Tab                  cycle reasoning/thinking level",
    "  /copy [last|<n>|code [n]]  copy latest assistant reply or fenced code block",
    "  /permissions, /settings    configure approvals, sandbox, theme, and TUI options",
    "  /diff, /commit, /context   inspect diff, commit changes, or view context budget",
    "  /resume                    fuzzy-search and switch project sessions",
    "",
    "Models and providers",
    "  /model [query]             open the searchable model picker",
    "                             Enter is session-only; Ctrl+S saves the default",
    "                             an exact provider/id or unique bare id saves immediately",
    "  /models                    pick from recent or favorite models",
    "  /favorite                  toggle the current model in favorites",
    "                             F2 cycles through recent models",
    "  /login, /logout            manage provider credentials",
    "  /thinking                  choose the reasoning level; saved to config",
    "  /scoped-models             explain the file-backed model scope",
    "  /roles [status]            show role models and subagent model pools",
    "",
    "Permissions and work",
    "  Alt+M                      cycle work mode (plan/standard/auto/auto-approve)",
    "  Alt+T / Alt+R / F1         open task center / rewind picker / searchable help",
    "  Shift+Tab                  cycle reasoning/thinking level",
    "  /permissions               open the interactive permission menu",
    "  /permissions status        show the read-only permission summary",
    "  /permissions <group>       jump straight to one picker",
    "  /permissions reviewer [off|model [provider/model]|timeout <ms>]  configure auto-mode review",
    "  /permissions sandbox network [allow|deny <domain>...|clear]  set the sandbox egress lists",
    "  /permissions rules         list persisted exact-command rules",
    "  /permissions why -- <cmd>  explain a policy decision without running it",
    "  /trust [status|grant|revoke] [kinds]  show or save per-resource workspace trust",
    "  !<command>                 run a shell command through the same policy gate",
    "  /subagent [--profile <name>] [--role plan|smol|slow] [--pool <name>]",
    "            [--model <provider/model>] [--worktree|--shared] <task>",
    "                             start a child session from a profile, role, or pool",
    "  /agents [profiles|result|transcript|wait|stop|review|sign|merge|discard <id>]",
    "                             list profiles or manage child sessions",
    "                             transcript opens a full-screen live tool-output view",
    "  /tasks                     open the unified interactive task and subagent center",
    "  /ps                        list background tasks",
    "  /logs <id>                 show bounded background task logs",
    "  /stop <id>                 stop a background task",
    "  /plan [request|status|on|approve|off]",
    "                             show/approve/exit plan mode or plan a request read-only",
    "  /plan-mode [status|on|approve|off]",
    "                             alias for plan mode lifecycle controls",
    "  /preset [list|use <name>]  apply a user preset to this session",
    "  /btw <prompt>              run a read-only side question in the background",
    "  /side <prompt>             run a background side task",
    "  /recap [all|<from>..<to>]  show a derived recap for a session range",
    "  /image <path|--clipboard> [prompt]  confirm and send an image as untrusted input",
    "  /image-gen [--model <ref>] <prompt>",
    "                             generate an image through a configured image model",
    "  /goal [text|status|pause|resume|clear]",
    "                             create or manage the goal that survives turns",
    "  /hooks [status]            show user and project hook evidence",
    "  /review                    review the current diff with structured findings",
    "  /todos                     show the current todo list",
    "",
    "Project",
    "  /init [--update]           create or update AGENTS.md from repository evidence",
    "  /settings, /setting       open interactive settings; permissions and config paths",
    "  /diff                      show staged and unstaged working tree changes",
    "  /commit [message]          review and create a Git commit as a human action",
    "  /undo [count]              restore recent Codepunk write/edit changes",
    "  /redo [count]              reapply changes removed by /undo",
    "  /rewind [count]            interactively rewind file checkpoints or branches",
    "  /status                    show model, session, permissions, trust, and usage",
    "",
    "Sessions and evidence",
    "  /cp-sessions, /session     list sessions or show the current one",
    "  /resume [id|latest|text]   switch by id, latest, or a title/content match",
    "  /fork [entry-id], /clone   fork at the leaf or entry and switch to the child",
    "  /tree                      open the session branch selector",
    "  /tree list|<entry-id>      print the tree or move directly to an entry",
    "  /evidence, /budget         inspect run evidence and model usage",
    "  /context                   visualize context window token breakdown",
    "  /cp-export, /export        write a redacted transcript and manifest",
    "  /sign                      sign the current settled run",
    "  /new                       start a new session in this TUI",
    "",
    "Local capabilities",
    "  /skills, /plugins          list installed capabilities",
    "  /mcp [list|add [name]|remove [name]|login [name]|status [name]|logout [name]]",
    "                             manage user MCP servers",
    "  /capabilities              summarize skills, MCP servers, and plugins",
    "  /remember, /memory         write, search, archive, or delete memory",
    "  /doctor, /policy           run diagnostics or print effective policy",
    "  /compact                   compact the current context",
    "  /reload                    reload config, plugins, skills, and user MCP servers",
    "  /help                      show this command list (/help <query> filters; F1 browses)",
    "  /quit                      exit",
    "",
    "Commands prefixed with cp- preserve Codepunk session and evidence semantics where a built-in name overlaps.",
    "Host commands that would bypass the Codepunk session, evidence, or redaction boundary are intercepted with guidance.",
  ].join("\n");
}
