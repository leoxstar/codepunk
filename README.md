# Codepunk

Local-first, supervised coding agent for teams.

Codepunk keeps the model, tool execution, approvals, and evidence on the local
machine. It provides an interactive terminal UI and a headless surface, with an
explicit policy boundary around file and shell actions.

## Features

- Interactive TUI plus print and JSON modes.
- Exact, short-lived approvals bound to the session, worker, tool call, and
  request nonce, with once, session, and persistent exact-action choices.
- Scoped autonomy rules and an explicit interactive unsandboxed-shell path.
- Pi-backed workspace trust that gates project config, policy, skills, and
  project instruction files; project MCP files are inert, not trust inputs.
- `--add-dir` extra file roots that extend read/write paths without loading
  the extra directory's project config, skills, MCP, or instructions.
- Shell confinement through `srt`, with coverage reported per execution surface.
- Append-only evidence with a hash chain and human sign-off.
- Codepunk-owned sessions with live `/resume`, `/new`, `/fork`, `/clone`, and
  `/tree` in the TUI, plus CLI listing, export, retention, and compaction
  checkpoints. A checkpoint is evidence about the compaction boundary, not a
  user-visible session rewind. The first prompt seeds a redacted title, later
  Pi title changes are mirrored, and `pin <id> [--unpin]` controls retention.
- Project context from `AGENTS.md`, local memory, skills, and gated MCP
  servers, including resource listing and reads through Pi's MCP tools.
- Library-level delivery primitives for detached worktrees, handoffs,
  exact-commit merges, and bounded workers; there is no `codepunk work` CLI
  yet. The local daemon is read-only.

## Workspace trust

Codepunk reuses Pi's `ProjectTrustStore` and keeps its own canonical decision
file at `~/.codepunk/trust.json`. A project must be trusted before Codepunk
loads `.codepunk/config.toml`, `.codepunk/local.toml`,
`.codepunk/policy.toml`, project `skills`, or any instruction file discovered
between the invocation directory and the delivery root. A bare `.codepunk`
directory does not trigger the prompt; Codepunk creates one for its own state.
Project MCP files are inert: Codepunk never loads them and warns that MCP
configuration is user-scope only. `--no-mcp` skips user-scope MCP servers for
one session. `--no-skills` and `--no-plugins` isolate those surfaces
individually. `--bare` is the aggregate session switch: it disables discovered
instruction files, skills, user plugins, MCP servers, and memory while leaving
model auth, trust, policy, approval, and sandbox settings in force.
Project `extensions`/`hooks` are not loaded in this build, so they do not
produce a misleading trust prompt. User-level instructions in Codepunk home
still load when the workspace is untrusted.

`trust.json` is Pi's fixed trust-store filename, not a per-machine random value;
`codepunk trust status` prints the exact path in use.

Project config is not just gated by trust, it is also floored by the user
layer. `.codepunk/config.toml` may narrow tools, memory, model scope, and
telemetry, but `model.provider`, `model.id`, `context.append`, approval,
autonomy, sandbox, and budget keys are user/CLI-only. A repository cannot
choose which endpoint receives the request or append text to the system
prompt. `.codepunk/local.toml` is a machine-local exception for non-user-scope
preferences such as the TUI and `model.thinking`: it is ignored by Git and
still skipped until the workspace is trusted, but every user-scope key is
rejected there, including
`model.provider`, `model.id`, model fallback, approval, reviewer, autonomy,
sandbox, filesystem, plugin, budget, session lease, and context-injection
keys. A cloned repository cannot redirect model traffic by shipping a
`local.toml`.

```text
codepunk trust [status|grant|revoke] [path] [--json]
--trust | --no-trust        one-run override
```

An interactive start asks once when project resources exist and no saved
decision applies. Print mode cannot prompt, so it refuses to start while the
decision is unresolved and project resources exist; pass `--trust`,
`--no-trust`, or save a decision first. An untrusted session skips project
config, policy, skills, and project instruction files; user-level instructions
in Codepunk home still load. `/trust` shows the current decision, `/trust
grant` and `/trust revoke` save a decision for future sessions; they do not
hot-reload the current one. The trust prompt and `/trust` list each protected
resource with its class, type, size, and a bounded SHA-256 content preview;
symlinks are identified as symlinks rather than followed.

Trust is scoped to the current Git checkout. A linked worktree is a separate
canonical root and therefore needs its own decision; a decision saved for the
main checkout does not silently cover it. `--add-dir` is also not a trust
grant: it only adds an explicit file root for the current process. No
configuration, policy, skills, MCP server, or instruction file is discovered
from an extra root.

```text
codepunk --add-dir ../shared-lib [--add-dir ../another-root]
```

Extra roots are canonicalized, deduplicated, and checked to stay outside the
user home and Codepunk home. They broaden file-tool containment and the policy
write set; the active autonomy and approval modes still decide whether a read
or write is allowed. The `srt` profile protects every root's `.codepunk` and
Git control paths. `codepunk permissions` and `permissions why` show the same
extra roots, and a path outside every root remains denied.

## Permissions

`/permissions` (also `/permission`) shows the effective
profile, trust decision, approval, autonomy, and sandbox modes and the user
config path.

```text
/permissions profile read-only|standard|auto|auto-approve|full-access
/permissions approval ask|deny|auto|allow
/permissions reviewer off|model [provider/model]|timeout <ms>
/permissions autonomy read-only|ask|scoped
/permissions sandbox required|uncovered
/permissions sandbox network [allow|deny <domain>...|clear]
/permissions filesystem workspace|full
/permissions rules
/permissions why -- <shell command>
/trust [status|grant|revoke]
--add-dir <dir>               extra file root for this session (repeatable)
--bare                        disable instructions, skills, plugins, MCP, memory for this session
--no-skills                   do not load skills for this session
--no-plugins                  do not load user plugins for this session
--no-mcp                      do not start user-scope MCP servers
```

The same reviewer settings are available for one run as
`--approval-reviewer off|model`, `--reviewer-model provider/id`, and
`--reviewer-timeout-ms <ms>`. Reviewer configuration is user/CLI-only and is
not accepted from `.codepunk/config.toml` or `.codepunk/local.toml`.

The named profiles bind four independent axes:

- `read-only`: reads and read-only workspace inspection run; file mutations
  and every ask-level action are denied. The `srt` profile also drops the
  workspace write grant, so a policy regression cannot become a write. User
  MCP servers are not started and user plugins are not loaded in this profile,
  because both execute outside the shell sandbox. A running session that has
  already loaded user plugins, connected MCP servers, or started a writable
  `srt` profile cannot switch to `read-only`; restart with
  `--permission-mode read-only` (disable user plugins and add `--no-mcp` where
  applicable) instead. The OS write grant is bound at startup, so changing
  only autonomy would not produce the two-layer guarantee. In the other
  direction, a session started read-only with `srt` cannot widen to `ask` or
  `scoped` live, because its OS profile has an empty `allowWrite` list for the
  life of the process; restart with the desired writable profile.
- `standard`: reads and writes inside the policy write set run; unknown shell,
  instruction-file edits, sensitive paths, and MCP actions ask.
- `auto`: auto-approves routine reads and ordinary shell commands that survive
  policy; hard denies still deny. Dynamic launchers and interpreters
  (`sh -c`, `python -c`, `node -e`, `env`, `xargs`, and similar), destructive
  shell actions (deletion, history rewrites, in-place edits, and opaque
  pipelines/redirections), explicit policy asks, protected instruction/config
  writes, sensitive reads, network and package-index commands, MCP tools, and
  unknown non-shell classes still ask. The `srt` sandbox stays required.
- `auto-approve`: every policy `ask` except MCP becomes `allow`; hard denies
  remain. MCP calls stay at the human gate because the server executes outside
  the shell sandbox. The sandbox stays required for shell tools and policy
  keeps direct file writes workspace-scoped.
- `full-access`: `auto-approve` plus an unsandboxed shell and the full
  filesystem. Every start, including one from persisted config, must pass
  `--dangerously-bypass-approvals-and-sandbox`; otherwise startup fails closed.
  It requires `autonomy = "ask"` and still keeps MCP calls at the human gate,
  `.codepunk`/Codepunk home hard-denied, and Git control-path checks active.

`trusted` is not a permission profile. Workspace trust answers whether a
repository may contribute project config, policy, skills, and instructions;
use `/trust` for that decision. `auto-approve` is the blanket-approval
profile.

The approval axis has four modes: `ask` prompts, `deny` refuses every policy
`ask`, `auto` approves routine and ordinary shell classes but keeps dynamic
launchers/interpreters, destructive, explicit-policy, protected, sensitive,
MCP, and unknown classes asking, and `allow` approves every non-MCP policy
`ask`. MCP stays at the human gate.
`approval.reviewer = "model"` adds an optional user-scope model reviewer
under `auto`. It only resolves network commands and headless argv `exec`;
hard denies, sensitive paths, protected control-plane writes, MCP calls,
explicit policy asks, and unmatched scoped rules remain human-only. Malformed
responses, errors, and timeouts abstain; interactive mode falls back to a
human, and headless mode denies. Reviewer is off by default. Its bounded
metadata is sent to the selected reviewer model, which may be a different
provider from the session model.
`scoped` autonomy is an exact-argv allowlist: an unmatched action asks (or is
denied in headless mode) even when approval is `allow`.

`sandbox = "required"` never falls back to an unsandboxed shell. If `srt`
cannot start, shell tools are disabled. `sandbox = "uncovered"` runs a shell
only when the interactive process also passes `--allow-unsandboxed-shell` or
the dangerous flag. `filesystem = "full"` likewise requires the dangerous
flag.

`srt` enforces the write set and a no-network default; it is not a read
boundary. Egress is opened per host through the user-scope
`sandbox.network_allow` list and carved out with `sandbox.network_deny`
(`codepunk permissions sandbox network allow|deny <domain>`); a project
config cannot set either list, an entry cannot be both allowed and denied,
and an approved network command still needs its own approval per call. Deny
wins inside `srt`, so a broad wildcard allow can be narrowed. Reads outside
the workspace are denied by the policy layer for file tools and for shell
commands the classifier can resolve. Unclassified shell commands still ask,
and `read-only` denies them.

Print and worker sessions have no approval channel. They still honor the
configured approval mode for pre-approved classes: `auto` runs routine and
ordinary shell work, `allow` (or `auto-approve`) runs every non-MCP policy ask,
and `ask`/`deny` refuse. MCP is never promoted by blanket approval and is
refused without a human channel. Network and headless `exec` can be resolved
only by an explicitly enabled reviewer; otherwise they stay refused under
`auto`. Destructive and other human-only classes always stay refused when no
approval channel exists.
Print mode's tool set is read-only unless `--headless-policy` grants `write`
or `shell`, so an explicit mutating `--permission-mode` is rejected there
instead of being accepted without effect.

Git execution and configuration surfaces are not ordinary workspace files.
File tools and shell redirects cannot write `.git/config`,
`.git/config.worktree`, `.git/hooks`, `.git/info`, `.git/objects/info`, or
`.git/objects/pack`; reads of git metadata ask. `srt` denies the same direct
writes, while normal git commands can still update the index, objects, and
refs through the git process. Existing hooks in a repository run inside that
sandbox; Codepunk does not disable them or pretend the repository is trusted.

The status line shows the profile, workspace trust, the current shell, and the
sandbox and filesystem modes requested for the next session. Those are separate
because a live shell provider cannot be replaced in place.

Approval changes apply to the current session. Autonomy changes also apply
live except when entering or leaving `read-only` with an active `srt` shell:
the OS write grant is bound at startup, so those transitions require a
restart. All changes are written to `~/.codepunk/config.toml`. Sandbox mode is
saved for the next session because the shell provider is bound when the host
starts. Other TOML sections and comments are preserved.

The approval selector offers `Allow once`, `Allow this exact command for the
session`, `Always allow this exact command`, and `Deny` when the action is a
simple shell argv. Session approval applies only to the same tool, argv, and
working directory. Persistent approval first opens a separate rule preview
showing the exact argv, cwd, match scope, and storage location; cancelling the
preview writes nothing. Confirming rewrites the scoped rule file with the same
argv, cwd, and executable digest, then selects the `scoped` autonomy profile
for the next session. The current session receives an exact grant; the written
rule is visible through `/permissions rules`. Switching to `ask` preserves the
rules file, and switching back to `scoped` reloads and revalidates the rules
from disk. Shell launchers, globs, variable expansion, redirections, and
complex shell syntax are not eligible for reuse.

`/permissions why -- <command>` is an execution-free policy check. It runs the
same policy, scoped-rule, approval, and shell-availability chain as a real
command, without executing it. It prints the effective decision, raw policy
decision, approval decision, rule IDs and reasons, whether approval is
required, shell availability, and the policy layer. A `sandbox.unavailable`
result means the command would be denied even if its policy decision was
`allow`.
`uncovered` is a sandbox mode, not permission to spawn a shell: the next
interactive session has no shell unless it is started with
`--allow-unsandboxed-shell` or
`--dangerously-bypass-approvals-and-sandbox`, and those executions are
recorded as uncovered. The dangerous flag also forces approval mode to
`allow` and the filesystem to `full`; it is never accepted by headless print
mode or by the management commands. If `srt` is unavailable in `required`
mode, startup warns that shell tools are disabled and points at
`codepunk doctor`; it does not downgrade to an unsandboxed shell.
The same view is available without the TUI:

```text
codepunk permissions
codepunk permissions profile read-only|standard|auto|auto-approve|full-access
codepunk permissions rules [--json]
codepunk permissions why -- git status
```

The model receives the session start time and timezone in an `environment`
section injected through Pi's `before_agent_start` section hook. Pi 1.5.2
does not provide a built-in clock section; Codepunk supplies one timestamp
and IANA timezone string. It is a clock fact, not a weekday or locale
adapter. `date`, `uname`, `whoami`, `hostname` read forms, `id`,
`sw_vers`, common filesystem inspection commands, and read-only `git status`,
`git diff --stat`, `git log --oneline`, `git branch`, and `git rev-parse`
forms are classified as read-only. Clock-setting and hostname-setting forms
still ask. Shell pipelines, redirections, substitutions, path escapes, and
unknown commands still require approval; Codepunk does not treat a pipeline as
safe just because its first word is safe.
Every `rg --files` operand and every `rg -f/--file` pattern file is treated as
a read path, and `find` output primaries such as `-fprint0` are side effects
that ask. Agent shell commands run with `GIT_OPTIONAL_LOCKS=0`, so an allowed
`git status` cannot rewrite `.git/index`.

## Requirements

- Node.js `>=22.19.0`
- pnpm `12.18.0`
- macOS or Linux

Windows 11 is not currently supported or claimed as verified. Real ConPTY and
manual sandbox checks are still required before support can be announced. See
[`docs/PLATFORMS.md`](docs/PLATFORMS.md).

## Models

Codepunk reads provider credentials and custom endpoints from the user home,
not from the repository:

- `~/.codepunk/config.toml` selects the default `model.provider` and `model.id`.
- `~/.codepunk/models.json` declares custom providers and their models.
- `~/.codepunk/auth.json` stores credentials managed by the Pi host.

List what is configured, import an OpenAI-compatible endpoint, and choose a
default:

```text
codepunk models list
codepunk models import http://127.0.0.1:4000/v1 --provider local --api openai-responses --api-key local-dev
codepunk models set local/example-model --thinking max
codepunk models remove local
codepunk models test
codepunk doctor
```

`models import` reads the endpoint's `/models` response and writes only
metadata plus the configured key reference. A local endpoint that ignores
authentication still needs a placeholder key so the host reports the provider
as configured; leave `--auth-header` off in that case. With Pi 1.5.2 the
placeholder is still emitted as a Bearer credential by the OpenAI client, so
the local endpoint must accept or ignore that header. For an authenticated
endpoint, pass the real key or an `$ENV` reference and add `--auth-header`.
`models test` makes one small real request and reports the stop reason,
latency, token usage, and response text; `doctor` checks configuration and MCP
connectivity, but does not send a model request.

In the TUI, `/model` is Pi's native path. A bare `/model` opens the searchable
picker; `/model <provider/model>` or a unique bare model ID selects exactly.
Typing in the picker filters across provider, ID, display name, and
subsequences. Pi's picker applies Enter to the current session; `Ctrl+S` saves
the highlighted model as the default. Codepunk persists exact selections and
`Ctrl+S` defaults to `config.toml`. For a non-interactive catalog, use
`codepunk models list`. Native `/thinking`
changes also persist. Model scope is file-backed through
`model.enabled`; `/scoped-models` explains that instead of opening a selector
whose save action would only update in-memory host state. A run can override
the default with `--model <provider/model>`. When no model is configured, the
TUI points at `/login`, `/model`, and `codepunk models import` instead of
starting a request with an unusable model. The
[model guide](docs/MODELS.md) covers the file formats and failure behavior.

`/help` lists the usable Codepunk and Pi commands. Pi builtins that would
bypass the product session, evidence, or redaction boundary are removed from
autocomplete and explained if typed anyway. Unregistered slash commands are
rejected before they can enter the prompt; the accepted set comes from Pi's
host command list plus the installed builtin table loaded through
`getPackageDir()`, so a command added by a future Pi release is not silently
swallowed and a moved module fails loudly.

`model.fallback` adds an ordered recovery chain through Pi's virtual-model
router. The primary and every fallback are validated before the first request;
a non-overflow failure advances, overflow stays on the current model for Pi to
compact, and exhaustion stops instead of retrying the last failed model.
Pi's automatic retry attempts are recorded as `model/retry_start` and
`model/retry_end` events with the model, attempt count, delay, and a bounded
redacted error preview; the retry timing itself still belongs to Pi.
Cross-provider or cross-endpoint fallback requires an explicit opt-in because
it changes the data boundary.

## Subagents

`/subagent [--profile <name>] [--model <provider/model>] [--worktree|--shared]
<task>` starts a separate Codepunk/Pi child process. The child has its own
session id and evidence namespace; the parent records a `subagent/result`
event linking both sessions, the child run and evidence head, the effective
profile, isolation, worktree, and exit status.

An agent profile is a Markdown file with `name`, `description`, `tools`,
`model`, `fallback`, and `thinking` frontmatter. Profiles load from
`$CODEPUNK_HOME/agents/*.md`; project profiles load from
`.codepunk/agents/*.md` only after the workspace is trusted, and override a
user profile with the same name. `tools` accepts `read`, `search`, `write`,
and `edit`. `shell` is rejected until a profile can declare an exact command
allowlist. `model` and `fallback` use exact `provider/model` references; a
per-run `--model` must belong to the profile's pool.

Without a profile, the child is a read-only `read`/`search` session in the
parent checkout. A profile that enables `write` or `edit` always runs in a
detached worktree; `--shared` is rejected for that profile. `--worktree` can
also isolate a read-only profile. The child inherits the parent's model and
thinking level unless the profile or `--model` selects another. An explicit
parent trust decision is propagated as `--trust` or `--no-trust`; a worktree
child receives the parent's decision because it is created from the same
commit.

Up to four children run in the background. `/agents` lists them,
`/agents profiles` lists the available profiles, and `/agents result <id>`,
`/agents wait <id>`, and `/agents stop <id>` manage a handle. A child needs a
git repository with at least one commit. If it answers without calling a tool,
the result reports no evidence run rather than inventing a hash.

A mutating result stays in its worktree for inspection; the completion notice
and `subagent/result` event record the absolute worktree path. Codepunk does
not merge child changes automatically.

## Capabilities

`codepunk capabilities` (and `/capabilities` in the TUI) is a read-only
inventory of the extension surface:

- user-scope MCP servers, including command, argument list, working directory,
  and environment variable names;
- user and project skills with scope, description, size, and content hash;
- opt-in plugin files under the user extensions directory.

Secret-shaped values in MCP commands, arguments, skill descriptions, and
errors are redacted; environment values are never printed, only their keys.
The command does not start MCP servers or plugins, so it has no side effects.
`--json` is available for scripts:

```text
codepunk capabilities
codepunk capabilities --json
```

Plugins are trusted in-process code, not sandboxed tool calls. Enabling a
plugin lets it use the Pi extension surface directly, including process
execution and filesystem access, so it can bypass Codepunk policy, approval,
sandbox coverage, and evidence. Enable only plugins you have reviewed.

User-scope MCP servers are managed without hand-editing TOML:

```text
codepunk mcp list
codepunk mcp add echo --cwd . --env API_KEY='${API_KEY}' -- node server.mjs
codepunk mcp add remote --url https://example.invalid/mcp --header 'Authorization: Bearer ${MCP_TOKEN}'
codepunk mcp remove echo
codepunk mcp test echo
codepunk mcp status
```

`mcp add/remove` preserve unrelated configuration, `mcp list` does not start
servers, and `mcp test` performs a real initialize/tools-list connection.
Session startup is tolerant of one broken server: it records a configuration
warning and keeps the other servers, while `mcp test` remains the fail-closed
check for the broken entry.
In the TUI, `/reload` re-reads `mcp.toml`, starts the new server set, stops the
old processes, and rebuilds the wrapped tool surface without replacing the
Codepunk session. Codepunk config, skills, and plugin inventory still require a
restart.
Transport comes from Pi's MCP client; Codepunk still approval-gates every
server tool and records uncovered execution. `/mcp` shows the same inventory
inside the TUI.

An HTTP server without an `Authorization` header uses OAuth. Codepunk reuses
Pi's `@earendil-works/pi-mcp/oauth` implementation for PKCE, dynamic client
registration, and token refresh; the explicit product command is:

```text
codepunk mcp login remote
codepunk mcp status remote
codepunk mcp logout remote
```

Optional OAuth settings live under `[servers.remote.oauth]`: `clientId`,
`clientSecret`, `callbackPort`, `callbackUrl`, `scope`, `clientName`,
`clientRegistration = "auto"|"dcr"`, and `authServerMetadataUrl`.
`clientSecret` expands `${ENV}` only; `!command` expansion is rejected.
`clientRegistration = "cimd"` is rejected because Codepunk publishes no Client
ID Metadata Document. Tokens are stored in `~/.codepunk/mcp-auth.json` with
owner-only permissions, never printed by `status` or copied into evidence.
Session startup never opens a browser: an unauthenticated server is reported
as `mcp.auth_required` with the exact login command. A revoked refresh token
also requires a new explicit login.

## Development

```text
corepack enable
corepack prepare pnpm@12.18.0 --activate
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
node packages/cli/dist/index.js --help
```

Run the full local verification with:

```text
pnpm run verify
```

The repository is a pnpm workspace. Package scripts, dependency pins, CI, and
testing conventions are documented in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).
The product CLI's published `install`, `upgrade`, and `uninstall` commands use npm
as the user-facing package manager; that is separate from repository
development.

## Packages

| Package              | Responsibility                                                |
| -------------------- | ------------------------------------------------------------- |
| `@codepunk/protocol` | Boundary schemas, record shapes, and version constants        |
| `@codepunk/core`     | Engine, host adapter, policy, sandbox, evidence, and sessions |
| `@codepunk/cli`      | Terminal surface, approvals, arguments, and exit codes        |

The dependency direction is `@codepunk/protocol <- @codepunk/core <- @codepunk/cli`.

## Documentation

- [`docs/AGENT-ARCHITECTURE.md`](docs/AGENT-ARCHITECTURE.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/COMPARISON.md`](docs/COMPARISON.md)
- [`docs/MODELS.md`](docs/MODELS.md)
- [`docs/PLATFORMS.md`](docs/PLATFORMS.md)
- [`docs/MEMORY.md`](docs/MEMORY.md)
- [`docs/DELIVERY.md`](docs/DELIVERY.md)
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- [`docs/SKILLS-MCP.md`](docs/SKILLS-MCP.md)
- [`docs/SWARM.md`](docs/SWARM.md)
- [`docs/WORKERS.md`](docs/WORKERS.md)
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)

## License

MIT
