export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(value);
}

const COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["resume", "reopen a saved session"],
  ["sessions", "list, graph, inspect, or prune sessions"],
  ["export", "export a session transcript"],
  ["pin", "pin or unpin a session"],
  ["sign", "sign a run verdict"],
  ["memory", "manage user and project memory"],
  ["setup", "guided provider, API key, and default model setup"],
  ["models", "list, test, select, import, or remove models"],
  ["config", "inspect effective configuration and paths"],
  ["doctor", "check runtime dependencies"],
  ["permissions", "inspect or change policy settings"],
  ["trust", "inspect or change workspace trust"],
  ["capabilities", "list MCP servers, skills, and plugins"],
  ["mcp", "manage user-scope MCP servers"],
  ["skills", "manage skills"],
  ["plugins", "manage opt-in plugins"],
  ["daemon", "serve the read-only local protocol"],
  ["view", "read sessions through the daemon"],
  ["completion", "print shell completion"],
  ["install", "install the package"],
  ["upgrade", "upgrade the package"],
  ["uninstall", "uninstall the package"],
];

const OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["--print", "single-shot print mode"],
  ["--mode", "text or json print output"],
  ["--continue", "resume the latest session"],
  ["--session", "resume a session by id"],
  ["--fork", "clone a session into a child"],
  ["--new-session", "force a new session"],
  ["--model", "select provider/model"],
  ["--provider", "select a provider"],
  ["--thinking", "set the thinking level"],
  ["--tools", "limit enabled tools"],
  ["--model-fallback", "set a fallback chain"],
  ["--permission-mode", "set the permission profile"],
  ["--approval", "set the approval mode"],
  ["--approval-reviewer", "configure the model reviewer"],
  ["--reviewer-model", "select the reviewer model"],
  ["--autonomy", "set the autonomy mode"],
  ["--sandbox", "set sandbox coverage"],
  ["--filesystem", "set the filesystem scope"],
  ["--add-dir", "add an extra file root"],
  ["--allow-unsandboxed-shell", "allow explicit unsandboxed shell"],
  ["--dangerously-bypass-approvals-and-sandbox", "bypass all guards"],
  ["--trust", "trust all resources for one run"],
  ["--no-trust", "deny all resources for one run"],
  ["--trust-resources", "trust named resource groups for one run"],
  ["--bare", "disable optional context surfaces"],
  ["--no-skills", "skip skills"],
  ["--no-plugins", "skip user plugins"],
  ["--no-mcp", "skip user MCP servers"],
  ["--memory", "enable or disable memory"],
  ["--headless-policy", "load a headless exec policy"],
  ["--verdict", "set the sign-off verdict"],
  ["--actor", "set the sign-off label"],
  ["--json", "emit machine-readable output"],
  ["--limit", "search result limit"],
  ["--all-projects", "search every project store"],
  ["--socket", "set the daemon socket"],
  ["--help", "show help"],
  ["--version", "show version and build identity"],
];

const VALUE_OPTIONS = new Set([
  "--mode",
  "--session",
  "--fork",
  "--new-session-id",
  "--parent-session-id",
  "--model",
  "--provider",
  "--thinking",
  "--tools",
  "--model-fallback",
  "--permission-mode",
  "--approval",
  "--approval-reviewer",
  "--reviewer-model",
  "--reviewer-timeout-ms",
  "--autonomy",
  "--scoped-rules",
  "--sandbox",
  "--filesystem",
  "--add-dir",
  "--trust-resources",
  "--memory",
  "--headless-policy",
  "--verdict",
  "--actor",
  "--output",
  "--scope",
  "--prefix",
  "--package-version",
  "--base-url",
  "--api",
  "--api-key",
  "--socket",
  "--limit",
  "--url",
  "--header",
  "--cwd",
  "--env",
]);

const FILE_OPTIONS = new Set([
  "--add-dir",
  "--scoped-rules",
  "--headless-policy",
  "--output",
  "--socket",
  "--prefix",
]);

function bashWords(values: ReadonlyArray<readonly [string, string]>): string {
  return values.map(([value]) => value).join(" ");
}

function bashScript(): string {
  return `# bash completion for codepunk
_codepunk_completion() {
  local cur prev command
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  command="\${COMP_WORDS[1]}"
  case "$prev" in
    completion)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
      return 0
      ;;
    sessions)
      COMPREPLY=( $(compgen -W "tree graph prune search" -- "$cur") )
      return 0
      ;;
    trust)
      COMPREPLY=( $(compgen -W "status grant revoke" -- "$cur") )
      return 0
      ;;
    permissions)
      COMPREPLY=( $(compgen -W "profile approval reviewer autonomy sandbox filesystem rules why" -- "$cur") )
      return 0
      ;;
    mcp)
      COMPREPLY=( $(compgen -W "list add remove test login logout status" -- "$cur") )
      return 0
      ;;
    skills)
      COMPREPLY=( $(compgen -W "list add remove" -- "$cur") )
      return 0
      ;;
    plugins)
      COMPREPLY=( $(compgen -W "list add remove enable disable" -- "$cur") )
      return 0
      ;;
    memory)
      COMPREPLY=( $(compgen -W "list search add edit delete archive export" -- "$cur") )
      return 0
      ;;
    models)
      COMPREPLY=( $(compgen -W "list test set remove import" -- "$cur") )
      return 0
      ;;
    config)
      COMPREPLY=( $(compgen -W "show path" -- "$cur") )
      return 0
      ;;
    --mode)
      COMPREPLY=( $(compgen -W "text json" -- "$cur") )
      return 0
      ;;
    --permission-mode)
      COMPREPLY=( $(compgen -W "read-only standard auto auto-approve full-access" -- "$cur") )
      return 0
      ;;
    --approval)
      COMPREPLY=( $(compgen -W "ask deny auto allow" -- "$cur") )
      return 0
      ;;
    --autonomy)
      COMPREPLY=( $(compgen -W "read-only ask scoped" -- "$cur") )
      return 0
      ;;
    --sandbox)
      COMPREPLY=( $(compgen -W "required uncovered" -- "$cur") )
      return 0
      ;;
    --filesystem)
      COMPREPLY=( $(compgen -W "workspace full" -- "$cur") )
      return 0
      ;;
    --thinking)
      COMPREPLY=( $(compgen -W "off low medium high xhigh" -- "$cur") )
      return 0
      ;;
    --verdict)
      COMPREPLY=( $(compgen -W "complete incomplete" -- "$cur") )
      return 0
      ;;
    --add-dir|--scoped-rules|--headless-policy|--output|--socket|--prefix)
      COMPREPLY=( $(compgen -f -- "$cur") )
      return 0
      ;;
    ${[...VALUE_OPTIONS].join("|")})
      COMPREPLY=()
      return 0
      ;;
  esac
  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "${bashWords(OPTIONS)}" -- "$cur") )
  else
    COMPREPLY=( $(compgen -W "${bashWords(COMMANDS)}" -- "$cur") )
  fi
}
complete -F _codepunk_completion codepunk
`;
}

function zshScript(): string {
  const commands = COMMANDS.map(
    ([command, description]) => `'${command}:${description}'`,
  ).join("\n    ");
  const options = OPTIONS.map(
    ([option, description]) =>
      `'${option}[${description}]${
        FILE_OPTIONS.has(option)
          ? ":file:_files"
          : VALUE_OPTIONS.has(option)
            ? ":value:"
            : ""
      }'`,
  ).join("\n    ");
  return `#compdef codepunk
_codepunk() {
  local -a commands
  commands=(
    ${commands}
  )
  _arguments -s -C \\
    ${options} \\
    '1:command:->command' \\
    '*::arg:->args'
  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        completion) _values 'shell' bash zsh fish ;;
        sessions) _values 'session command' tree graph prune search ;;
        trust) _values 'trust command' status grant revoke ;;
        permissions) _values 'permission command' profile approval reviewer autonomy sandbox filesystem rules why ;;
        mcp) _values 'mcp command' list add remove test login logout status ;;
        skills) _values 'skills command' list add remove ;;
        plugins) _values 'plugins command' list add remove enable disable ;;
        memory) _values 'memory command' list search add edit delete archive export ;;
        models) _values 'models command' list test set remove import ;;
        config) _values 'config command' show path ;;
      esac
      ;;
  esac
}
_codepunk "$@"
`;
}

function fishScript(): string {
  const lines = ["# fish completion for codepunk", "complete -c codepunk -f"];
  for (const [command, description] of COMMANDS) {
    lines.push(
      `complete -c codepunk -n '__fish_use_subcommand' -a '${command}' -d '${description}'`,
    );
  }
  const nested: ReadonlyArray<readonly [string, string]> = [
    ["completion", "bash zsh fish"],
    ["sessions", "tree graph prune search"],
    ["trust", "status grant revoke"],
    [
      "permissions",
      "profile approval reviewer autonomy sandbox filesystem rules why",
    ],
    ["mcp", "list add remove test login logout status"],
    ["skills", "list add remove"],
    ["plugins", "list add remove enable disable"],
    ["memory", "list search add edit delete archive export"],
    ["models", "list test set remove import"],
    ["config", "show path"],
  ];
  for (const [command, values] of nested) {
    lines.push(
      `complete -c codepunk -n '__fish_seen_subcommand_from ${command}' -a '${values}'`,
    );
  }
  for (const [option, description] of OPTIONS) {
    if (option.startsWith("--")) {
      lines.push(
        `complete -c codepunk -l '${option.slice(2)}'${
          VALUE_OPTIONS.has(option) ? " -r" : ""
        } -d '${description}'`,
      );
    }
  }
  lines.push("complete -c codepunk -s h -l help -d 'show help'");
  lines.push("complete -c codepunk -s v -l version -d 'show version'");
  return `${lines.join("\n")}\n`;
}

export function completionScript(shell: CompletionShell): string {
  if (shell === "bash") {
    return bashScript();
  }
  if (shell === "zsh") {
    return zshScript();
  }
  return fishScript();
}
