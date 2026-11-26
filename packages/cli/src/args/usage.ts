import { DAEMON_SCOPES } from "codepunk-protocol";
import { APPROVAL_MODE_NAMES, PERMISSION_PROFILE_NAMES } from "codepunk-core";
import { COMPLETION_SHELLS } from "../completion.ts";

function usageNavigation(): string[] {
  return [
    "codepunk [options] [prompt]",
    "",
    "Surfaces:",
    "  codepunk                 interactive TUI when stdin is a TTY",
    "  codepunk -p <prompt>     print mode; read-only by default",
    "  codepunk --mode json -p  JSON event stream",
    "  --new-session-id <id>  create a new session with an explicit id",
    "  --parent-session-id <id>  record the parent of a new child session",
    "",
    "Session commands:",
    "  codepunk resume [session-id|latest|text]",
    "      open a picker, the newest session, an id or prefix, or a search match",
    "  codepunk sessions [--include-archived]",
    "  codepunk sessions [prune] [--apply]",
    "      sessions prune is dry-run only; --apply is refused, use codepunk gc --apply",
    "  codepunk sessions tree [session-id] [--json]",
    "  codepunk sessions graph [--json]",
    "  codepunk sessions search <query> [--limit n] [--all-projects] [--json]",
    "  codepunk sessions rename <session-id> <title>",
    "  codepunk sessions archive|unarchive <session-id>",
    "  codepunk sessions delete <session-id> --confirm",
    "  codepunk sessions export <session-id> [--output path]",
    "  codepunk sessions import <bundle.json>",
    "  codepunk export [session-id] [--output path]",
    "  codepunk pin <session-id>",
    "  codepunk pin <session-id> --unpin",
    "  codepunk sign <run-id> --verdict complete|incomplete",
    "  codepunk daemon [--socket path] [--scopes daemon:read,...]",
    "  codepunk view [session-id] [--json] [--socket path]",
    "  codepunk acp",
    "",
  ];
}

function usageData(): string[] {
  return [
    "Retention commands:",
    "  codepunk gc [--dry-run|--apply]",
    "      dry-run lists artifact candidates; apply backs up before deleting",
    "  codepunk migrate [--check|--apply]",
    "      check reports the state version; apply backs up before migrating",
    "  codepunk backup create|list|restore <id>",
    "      create snapshots projects, config, and state version without credentials",
    "",
    "Memory commands:",
    "  codepunk memory list [--scope user|project]",
    "  codepunk memory search <query> [--scope user|project]",
    "  codepunk memory add <text> [--scope user|project]",
    "  codepunk memory edit <id> <text> [--scope user|project]",
    "  codepunk memory delete <id> [--scope user|project]",
    "  codepunk memory archive <id> [--scope user|project]",
    "  codepunk memory export [--scope user|project] [--output path]",
    "",
    "Model commands:",
    "  codepunk setup [--provider <id>] [--api-key <key>] [--model <id>]",
    "      guided provider/API-key setup wizard (or one-command non-interactive setup)",
    "  codepunk models [list]",
    "  codepunk models test [provider/id]",
    "  codepunk models set <provider/id> [--thinking <level>]",
    "  codepunk models remove <provider>",
    "  codepunk models import <base-url> --provider <id>",
    "      [--api openai-responses|openai-completions] [--api-key <key>]",
    "      [--auth-header] [--model <ids>]",
    "",
  ];
}

function usageCapabilityPermission(): string[] {
  return [
    "Permission commands:",
    "  codepunk permissions",
    `  codepunk permissions profile ${PERMISSION_PROFILE_NAMES.join("|")}`,
    `  codepunk permissions approval ${APPROVAL_MODE_NAMES.join("|")}`,
    "  codepunk permissions reviewer show|off|model [provider/model]|timeout <ms>",
    "  codepunk permissions autonomy read-only|ask|scoped",
    "  codepunk permissions sandbox required|uncovered",
    "  codepunk permissions sandbox network [allow|deny <domain>...|clear]",
    "  codepunk permissions filesystem workspace|full",
    "  codepunk permissions rules [--json]",
    "  codepunk permissions why -- <shell command>",
    "  codepunk trust [status|grant|revoke] [path] [--resources config,policy,skills,instructions] [--json]",
    "",
    "Capability commands:",
    "  codepunk capabilities [--json]",
    "      list user MCP servers, skills, and opt-in plugins",
    "  codepunk mcp [list] [--json]",
    "  codepunk mcp add <name> [--cwd <dir>] [--env KEY=VALUE] [--force]",
    "      -- <command> [args...]",
    "  codepunk mcp add <name> --url <url> [--header 'Name: value'] [--force]",
    "  codepunk mcp remove <name>",
    "  codepunk mcp test [name]",
    "  codepunk mcp login [name]",
    "  codepunk mcp logout <name>",
    "  codepunk mcp status [name] [--json]",
    "      connect, list tools, and exit non-zero on failure",
    "  codepunk skills [list] [--json]",
    "  codepunk skills add <dir> [--scope user|project] [--force]",
    "  codepunk skills remove <name> [--scope user|project]",
    "  codepunk plugins [list] [--json]",
    "  codepunk plugins enable|disable",
    "  codepunk plugins add <file> [--force]",
    "  codepunk plugins remove <file>",
    "",
    "Configuration:",
    "  codepunk config [show] [--json] [--trust|--no-trust]",
    "  codepunk config path [--json]",
    "",
    "Operations:",
    "  codepunk doctor",
    "  codepunk completion <bash|zsh|fish>",
    "  codepunk install|upgrade|uninstall",
    "  codepunk install [--prefix <dir>] [--package-version <v>] [--dry-run]",
    "",
  ];
}

function usageOptions(): string[] {
  return [
    "Options:",
    "  -p, --print              single-shot print mode",
    "      --mode text|json     print output mode",
    "      --continue           resume the latest project session",
    "      --session <id>       resume a session by id",
    "      --fork <id>          clone a session into a new child session",
    "      --new-session        force a new session",
    "      --model <provider/id>",
    "      --provider <id>",
    "      --thinking <level>",
    "      --tools <read,search,write,edit,shell>",
    "      --model-fallback <provider/id,...>",
    "      --fallback-allow-cross-provider",
    `      --permission-mode ${PERMISSION_PROFILE_NAMES.join("|")}`,
    `      --approval ${APPROVAL_MODE_NAMES.join("|")}`,
    "      --approval-reviewer off|model   model review for auto-mode asks",
    "      --reviewer-model <provider/id>  default: the session model",
    "      --reviewer-timeout-ms <ms>      default: 20000",
    "      --autonomy read-only|ask|scoped",
    "      --scoped-rules <path>   exact argv allowlist for scoped autonomy",
    "      --sandbox required|uncovered",
    "      --filesystem workspace|full   full requires the dangerous flag",
    "      --network-allow <domains>     per-process egress allowlist for child hosts",
    "      --network-deny <domains>      per-process egress deny list for child hosts",
    "      --add-dir <dir>      extra file root; never loads its project config",
    "      --allow-unsandboxed-shell  interactive only; requires --sandbox uncovered",
    "      --dangerously-bypass-approvals-and-sandbox",
    "                           approval=allow, sandbox=uncovered, filesystem=full",
    "      --trust / --no-trust one-run workspace trust decision",
    "      --trust-resources <kinds>  load only config,policy,skills,instructions for this run",
    "      --memory <true|false>",
    "      --allow-plugins",
    "      --bare               disable instructions, skills, plugins, MCP, memory for this session",
    "      --no-skills          do not load skills for this session",
    "      --no-plugins         do not load user plugins for this session",
    "      --no-mcp             do not start user MCP servers in this session",
    "      --headless-policy <path>",
    "      --verdict complete|incomplete",
    "      --actor <name>       sign-off label (default: local-user)",
    "      --prefix <dir>       npm global prefix for package commands",
    "      --package-version <v>",
    "      --base-url <url>     model endpoint for models import",
    "      --api <name>         provider API for models import",
    "      --api-key <value>    literal, $ENV, or !command key",
    "      --auth-header        send the key as Authorization: Bearer",
    "      --dry-run            print the package command without running it",
    "      --json               emit machine-readable command output",
    "      --limit <n>          search result limit (1-100, default 20)",
    "      --all-projects       search every project under CODEPUNK_HOME",
    "      --socket <path>      daemon socket under CODEPUNK_HOME",
    "      --scopes <list>      daemon scopes, comma separated",
    "  -h, --help",
    "  -v, --version",
  ];
}

export function usage(): string {
  return [
    ...usageNavigation(),
    ...usageData(),
    ...usageCapabilityPermission(),
    ...usageOptions(),
  ].join("\n");
}

function sessionSubcommandUsage(
  command: string | undefined,
): string[] | undefined {
  switch (command) {
    case "resume":
      return [
        "usage:",
        "  codepunk resume                 pick from this project's sessions",
        "  codepunk resume latest          reopen the newest session",
        "  codepunk resume <id|prefix>     reopen a session by id or unique prefix",
        "  codepunk resume <text>          reopen the session whose title or events match",
        "      interactive only; options such as --model or --permission-mode still apply",
        "      cannot be combined with --print, --session, --continue, --fork, or --new-session",
      ];
    case "sessions":
    case "prune":
      return [
        "usage:",
        "  codepunk sessions [--include-archived]",
        "  codepunk sessions prune [--apply]",
        "      prune is dry-run only; --apply is refused, use codepunk gc --apply",
        "  codepunk sessions tree [session-id] [--json]",
        "  codepunk sessions graph [--json]",
        "  codepunk sessions search <query> [--limit n] [--all-projects] [--json]",
        "  codepunk sessions rename <session-id> <title>",
        "  codepunk sessions archive|unarchive <session-id>",
        "  codepunk sessions delete <session-id> --confirm",
        "  codepunk sessions export <session-id> [--output path]",
        "  codepunk sessions import <bundle.json>",
        "  codepunk export [session-id] [--output path]",
        "  codepunk pin <session-id>",
        "  codepunk pin <session-id> --unpin",
        "  codepunk sign <run-id> --verdict complete|incomplete",
        "  codepunk daemon [--socket path]",
        "  codepunk view [session-id] [--json] [--socket path]",
      ];
    case "gc":
      return [
        "usage:",
        "  codepunk gc [--dry-run|--apply]",
        "      dry-run is the default; --apply backs up candidates before deleting",
        "      only artifacts are deleted; sessions, evidence, verdicts, and checkpoints stay",
      ];
    case "migrate":
      return [
        "usage:",
        "  codepunk migrate [--check|--apply]",
        "      --check is the default and exits 1 when a migration is required",
        "      --apply backs up state-version.json and restores it on failure",
      ];
    case "backup":
      return [
        "usage:",
        "  codepunk backup create",
        "  codepunk backup list [--json]",
        "  codepunk backup restore <id>",
        "      backups include projects, config.toml, and state-version.json",
        "      auth.json and models.json are never included",
      ];
    case "export":
      return ["usage:", "  codepunk export [session-id] [--output path]"];
    case "pin":
      return ["usage:", "  codepunk pin <session-id> [--unpin]"];
    case "sign":
      return [
        "usage:",
        "  codepunk sign <run-id> --verdict complete|incomplete [--actor <name>]",
      ];
    default:
      return undefined;
  }
}

function runtimeSubcommandUsage(
  command: string | undefined,
): string[] | undefined {
  switch (command) {
    case "daemon":
      return [
        "usage:",
        "  codepunk daemon [--socket path] [--scopes daemon:read,...]",
        `      default: daemon:read,sessions:read,sessions:write`,
        `      available: ${DAEMON_SCOPES.join(",")}`,
      ];
    case "acp":
      return ["usage:", "  codepunk acp"];
    case "view":
      return [
        "usage:",
        "  codepunk view [session-id] [--json] [--socket path]",
      ];
    case "completion":
      return ["usage:", `  codepunk completion ${COMPLETION_SHELLS.join("|")}`];
    case "memory":
      return [
        "usage:",
        "  codepunk memory list [--scope user|project]",
        "  codepunk memory search <query> [--scope user|project]",
        "  codepunk memory add <text> [--scope user|project]",
        "  codepunk memory edit <id> <text> [--scope user|project]",
        "  codepunk memory delete <id> [--scope user|project]",
        "  codepunk memory archive <id> [--scope user|project]",
        "  codepunk memory export [--scope user|project] [--output path]",
      ];
    case "setup":
      return [
        "usage:",
        "  codepunk setup",
        "      interactive provider, API key, and default model setup wizard",
        "  codepunk setup --provider <id> [--api-key <key>] [--model <id>] [--thinking <level>]",
        "  codepunk setup --base-url <url> --provider <id> [--api <flavor>] [--api-key <key>] [--model <id>]",
      ];
    case "models":
      return [
        "usage:",
        "  codepunk models [list]",
        "  codepunk models test [provider/id]",
        "  codepunk models set <provider/id> [--thinking <level>]",
        "  codepunk models remove <provider>",
        "  codepunk models import <base-url> --provider <id>",
        "      [--api openai-responses|openai-completions] [--api-key <key>]",
        "      [--auth-header] [--model <ids>]",
      ];
    default:
      return undefined;
  }
}

function configurationSubcommandUsage(
  command: string | undefined,
): string[] | undefined {
  switch (command) {
    case "permissions":
    case "permission":
      return [
        "usage:",
        "  codepunk permissions",
        `  codepunk permissions profile ${PERMISSION_PROFILE_NAMES.join("|")}`,
        `  codepunk permissions approval ${APPROVAL_MODE_NAMES.join("|")}`,
        "  codepunk permissions reviewer show|off|model [provider/model]|timeout <ms>",
        "  codepunk permissions autonomy read-only|ask|scoped",
        "  codepunk permissions sandbox required|uncovered",
        "  codepunk permissions sandbox network [allow|deny <domain>...|clear]",
        "  codepunk permissions filesystem workspace|full",
        "  codepunk permissions rules [--json]",
        "  codepunk permissions why -- <shell command>",
      ];
    case "trust":
      return [
        "usage:",
        "  codepunk trust [status|grant|revoke] [path] [--resources config,policy,skills,instructions] [--json]",
        "  status is the default; grant and revoke save a decision for future sessions",
      ];
    case "capabilities":
      return [
        "usage:",
        "  codepunk capabilities [--json]",
        "      list user MCP servers, skills, and opt-in plugins",
      ];
    case "mcp":
      return [
        "usage:",
        "  codepunk mcp [list] [--json]",
        "  codepunk mcp add <name> [--cwd <dir>] [--env KEY=VALUE] [--force]",
        "      -- <command> [args...]",
        "  codepunk mcp add <name> --url <url> [--header 'Name: value'] [--force]",
        "  codepunk mcp remove <name>",
        "  codepunk mcp test [name]",
        "  codepunk mcp login [name]",
        "  codepunk mcp logout <name>",
        "  codepunk mcp status [name] [--json]",
      ];
    case "skills":
      return [
        "usage:",
        "  codepunk skills [list] [--json]",
        "  codepunk skills add <dir> [--scope user|project] [--force]",
        "  codepunk skills remove <name> [--scope user|project]",
      ];
    case "plugins":
      return [
        "usage:",
        "  codepunk plugins [list] [--json]",
        "  codepunk plugins enable|disable",
        "  codepunk plugins add <file> [--force]",
        "  codepunk plugins remove <file>",
      ];
    case "config":
      return [
        "usage:",
        "  codepunk config [show] [--json] [--trust|--no-trust]",
        "  codepunk config path [--json]",
      ];
    case "doctor":
      return ["usage:", "  codepunk doctor"];
    case "install":
    case "upgrade":
    case "uninstall":
      return [
        "usage:",
        "  codepunk install [--prefix <dir>] [--package-version <v>] [--dry-run]",
        "  codepunk upgrade [--prefix <dir>] [--dry-run]",
        "  codepunk uninstall [--prefix <dir>] [--dry-run]",
      ];
    default:
      return undefined;
  }
}

export function subcommandUsage(
  command: string | undefined,
): string | undefined {
  const lines =
    sessionSubcommandUsage(command) ??
    runtimeSubcommandUsage(command) ??
    configurationSubcommandUsage(command);
  return lines === undefined ? undefined : `${lines.join("\n")}\n`;
}
