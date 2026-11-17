# Codepunk

Local-first, supervised coding agent for teams.

Codepunk keeps the model, tool execution, approvals, and evidence on the local
machine. It provides an interactive terminal UI and a headless surface, with an
explicit policy boundary around file and shell actions.

## Features

- Interactive TUI plus print and JSON modes.
- Exact, short-lived approvals correlated by request nonce, session, worker, and
  tool call, with once, session, and persistent exact-action choices; a reused
  session or persistent grant names the request that created it.
- Scoped autonomy rules and an explicit interactive unsandboxed-shell path.
- Per-resource workspace trust for project config, policy, skills, and
  instruction files, with Pi's boolean store as the exact-root fallback;
  project MCP files are inert, not trust inputs.
- `--add-dir` extra file roots that extend read/write paths without loading
  the extra directory's project config, skills, MCP, or instructions.
- Shell confinement through `srt`, with coverage reported per execution surface.
- Append-only evidence with a hash chain and human sign-off.
- Codepunk-owned sessions with live `/resume`, `/new`, `/fork`, `/clone`, and
  `/tree` in the TUI, where the bare command opens Pi's searchable branch
  selector and `/tree list` prints the full tree, plus CLI listing, export,
  retention, and compaction
  checkpoints. `codepunk sessions tree [id]` projects the saved Pi entries as a
  branch graph with labels and the active leaf; `codepunk sessions graph` links
  product sessions by parent and fork point; `codepunk sessions search <query>`
  searches saved titles and bounded event excerpts in the current project,
  redacts secrets before output, and accepts `--limit` and `--json`.
  `--all-projects` scans every project store under `CODEPUNK_HOME`, labels each
  match with its project id, and applies the same bounded result cap. In the TUI,
  `/resume <id|latest|text>` falls back to the same search, shows a chooser when
  several sessions match, and resumes the selected session in place. A
  checkpoint is evidence about the compaction boundary, not a user-visible
  session rewind. The first prompt seeds a redacted title, later Pi title
  changes are mirrored, and `pin <id> [--unpin]` controls retention. The
  `/tree` snapshot stores every Pi entry and the active leaf, so sibling
  branches survive resume without a separate Pi session file.
- Project context from `AGENTS.md`, local memory, skills, and gated MCP
  servers, including resource listing and reads through Pi's MCP tools.
- `/init` bootstraps `AGENTS.md` from repository evidence through a normal
  model turn, and `/status` summarizes the model, session, permissions, trust,
  capabilities, evidence, and token usage.
- `/models` picks from recent or favorite models, `/favorite` toggles the
  current model, and F2 cycles recent models. Pi's `/model` fuzzy search is
  unchanged.
- `/diff` shows the working-tree status, staged and unstaged stats, and a
  bounded patch without sending a model request or writing the index.
- `/commit [message]` previews staged, unstaged, and untracked files, asks for
  an explicit scope and confirmation, then creates a Git commit outside the
  model sandbox and records its base/result commit hashes in evidence.
- `/undo [count]` and `/redo [count]` restore or reapply bounded per-session
  snapshots of successful Codepunk `write`/`edit` calls. A restore is refused
  when the current file digest differs from the checkpoint, so a manual or
  shell edit is never silently overwritten. Shell, MCP, and plugin effects are
  outside this boundary.
- Library-level delivery primitives for detached worktrees, handoffs,
  exact-commit merges, and bounded workers; there is no `codepunk work` CLI
  yet. The local daemon serves session list and read, plus one metadata write
  (`session/pin`); it never appends session events, so `hello.read_only` is
  false while `session/read` results stay read-only snapshots.
- `codepunk completion bash|zsh|fish` prints a static completion script for
  the product commands, nested subcommands, and main permission/trust options.

## Install

Install the published CLI with npm:

```text
npm install --global @codepunk/cli@0.1.0
```

The CI matrix verifies Linux x64 on `ubuntu-latest` and macOS arm64 on
`macos-latest`. macOS x64, Linux arm64, and WSL2 are not separately verified.
Windows is not a verified platform.

## Quick start

Start Codepunk after installation:

```text
codepunk
```

On the first start, when no model is configured, Codepunk opens a model setup
menu. Choose `/login` for a built-in provider or `/model` to select an
authenticated model. You can also configure a default from the command line
with `codepunk models import ...` followed by `codepunk models set
<provider/model>`; see [`docs/MODELS.md`](docs/MODELS.md) for the provider
options.

Run the installation diagnostic at any time:

```text
codepunk doctor
```

## Workspace trust

Codepunk keeps Pi's whole-workspace boolean in `~/.codepunk/trust.json` and a
per-resource decision file at `~/.codepunk/workspace-trust.json`. The
decision has four independent grants: `config` (`.codepunk/config.toml`,
`local.toml`, and `agents`), `policy` (`.codepunk/policy.toml`), `skills`
(`.codepunk/skills`), and `instructions` (every instruction file discovered
between the invocation directory and the delivery root). Loading one group
never authorizes another. A bare `.codepunk` directory does not trigger the
prompt; Codepunk creates one for its own state.
Project MCP files are inert: Codepunk never loads them and warns that MCP
configuration is user-scope only. `--no-mcp` skips user-scope MCP servers for
one session. `--no-skills` and `--no-plugins` isolate those surfaces
individually. `--bare` is the aggregate session switch: it disables discovered
instruction files, skills, user plugins, MCP servers, and memory while leaving
model auth, trust, policy, approval, and sandbox settings in force.
Project `extensions`/`hooks` are not loaded in this build, so they do not
produce a misleading trust prompt. User-level instructions in Codepunk home
still load when the workspace is untrusted.

The two stores use canonical paths and exact-root lookup. A parent
repository's decision never covers a nested repository. A malformed
per-resource file aborts startup instead of becoming "no decision". Partial
decisions also write `false` to Pi's store, so removing the sidecar cannot
silently widen trust in another Pi entry point. `codepunk trust status` prints
both paths in use.

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
codepunk trust [status|grant|revoke] [path] [--resources config,policy,skills,instructions] [--json]
--trust | --no-trust        one-run override for all resource groups
--trust-resources <kinds>   one-run override for named groups
```

An interactive start asks when project resources exist and no saved decision
applies. The prompt is titled `Project trust` and is Pi's own `SelectList`:
Up/Down moves the pointer, Enter confirms, and Escape or Ctrl+C cancels. It has
no numbered menu. When more than one resource group exists, `Customize
resources…` opens a checkbox screen: Space toggles one group, Enter continues,
and Escape goes back. The next screen applies the selection to this session or
remembers it. The prompt states whether this exact checkout already has a
saved decision, or whether an ancestor decision exists but is deliberately
not inherited. It shows the invocation cwd and exact checkout root. Each row
states what it loads and whether the decision persists.
The startup resource preview uses a shortened SHA-256; `/trust status` and
`codepunk trust status --json` retain the full digest. The prompt explains that
workspace trust does not change approval, sandbox, or filesystem permissions.
A session-only or one-run decision is named in the TUI status line instead of
being reported as an ordinary saved decision.
The prompt footer appears when `dist` is stale or the running process predates
a rebuild, and `codepunk --version` always prints the running package version,
dist build time, entry path, and whether `dist` matches the package sources.
The footer also reports `restart required` when the running process started
before the current `dist`; a long-lived terminal must be restarted to load a
rebuilt UI. `/doctor` reports the same condition.
`codepunk doctor` and `/doctor` add the same result as a `build` check, so a
stale checkout cannot silently keep serving an older trust or command UI.
Print mode cannot prompt, so it refuses to start while the decision is
unresolved and project resources exist; pass `--trust`, `--no-trust`,
`--trust-resources`, or save a decision first. A denied resource group is
skipped independently; user-level instructions in Codepunk home still load.
`/trust` shows the current decision, `/trust grant` and `/trust revoke` save a
decision for future sessions; they do not hot-reload the current one. Both
commands accept an optional kind list, for example `/trust grant
instructions,config`. The trust prompt and `/trust` list each protected
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

Extra roots are canonicalized, deduplicated, and rejected when they contain
the user home or Codepunk home. They broaden file-tool containment and the policy
write set; the active autonomy and approval modes still decide whether a read
or write is allowed. The `srt` profile protects every root's `.codepunk` and
Git control paths. `codepunk permissions` and `permissions why` show the same
extra roots, and a path outside every root remains denied.

## File checkpoints

Codepunk records a bounded checkpoint after every successful `write` or `edit`
tool call. The checkpoint lives with the session under
`$CODEPUNK_HOME/projects/<project>/sessions/<session>/checkpoints`; the model
never sees this directory through a file tool.

```text
/undo          restore the latest applied checkpoint
/undo 3        restore up to three applied checkpoints
/redo          reapply the latest undone checkpoint
/redo 2        reapply up to two undone checkpoints
```

Each file is capped at 1 MiB, the session store at 32 MiB and 100 entries;
larger or over-budget mutations proceed normally but are not undoable. A
checkpoint is eligible only for a regular file inside the workspace or an
explicit `--add-dir` root; `.git` and `.codepunk` are never checkpointed.
Before writing, Codepunk compares the current file digest with the checkpoint's
expected before/after digest and refuses a mismatch. It restores the original
file mode and deletes a file that did not exist before the mutation.
`checkpoint/restore` is appended to the session log after each undo or redo.

This is not a Git reset and not Pi's editor text undo. Manual edits, shell
commands, MCP servers, plugins, and other processes are not captured; if one
of them changed the file after the checkpoint, `/undo` stops instead of
overwriting it.

## Project instructions

`/init` asks the selected model to inspect the repository and create
`AGENTS.md` at the delivery root. The prompt requires verified commands and
repository-specific conventions; Codepunk does not ship a fixed project
template. The model's write goes through the same approval, sandbox, and
evidence gate as any other write. The new file applies when the next session
starts; the current session keeps the instruction block it loaded at startup.

`/init` requires a trusted workspace, a non-read-only autonomy profile, and a
selected model. It refuses to overwrite an existing root instruction file
(`AGENTS.md`, `AGENTS.override.md`, or `CLAUDE.md`) unless `--update` is
given. It also refuses to write through an instruction-file symlink.

```text
/init
/init --update
/status
```

## Configuration

`codepunk config` is the read-only, non-interactive counterpart to the TUI
`/settings` command. It prints the user, project, and local config paths, the
trust decision, the effective layered values, and any config warnings. It does
not send a model request and does not create project or home state.

An environment variable may tighten a trust axis silently, but a value that
loosens `approval.mode`, `autonomy.profile`, `filesystem.mode`, or
`sandbox.mode` relative to the file layers adds a config warning, and every
evidence record carries the effective `approval_mode`.

```text
codepunk config
codepunk config --json
codepunk config path
codepunk config path --json
```

When workspace trust is unresolved, `codepunk config` still shows user-scope
configuration but marks the project and local layers `(not loaded)`. Pass
`--trust` or `--no-trust` for one inspection, or save a decision with
`codepunk trust grant` before inspecting the project layer. `config path` only
prints locations and does not resolve trust or read configuration.

## Permissions

`/permissions` (also `/permission`) shows the effective
profile, trust decision, approval, autonomy, and sandbox modes and the user
config path. Omitting the value after `profile`, `approval`, `autonomy`,
`sandbox`, or `filesystem` opens an arrow-key picker with the current value
marked.

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
instead of being accepted without effect. Headless `exec` matches one exact
`argv`; an interpreter such as `node` or `python` is accepted only when the
policy also pins `script_sha256` for the single script argument, and a flag in
the script position stays refused.

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
session`, `Always allow this exact command`, `Deny`, and `Deny with guidance
for the model` when the action is a simple shell argv. If the request has no
reusable argv and cwd, the two exact-command options are hidden. Session
approval applies only to the same tool, argv, and working directory.
Persistent approval first opens a separate rule preview
showing the exact argv, cwd, match scope, and storage location; cancelling the
preview writes nothing. Confirming rewrites the scoped rule file with the same
argv, cwd, and executable digest, then selects the `scoped` autonomy profile
for the next session. The current session receives an exact grant; a reused
grant records `reused_from_request_id` in its approval evidence, and the
written rule is visible through `/permissions rules`. Switching to `ask`
preserves the rules file, and switching back to `scoped` reloads and
revalidates the rules from disk. Shell launchers, globs, variable expansion,
redirections, and complex shell syntax are not eligible for reuse.

A file mutation takes its before-snapshot before the approval prompt and
re-snapshots the same target immediately before execution. If the target
changed content, changed mode, or became a symbolic link while the caller was
deciding, the call is denied as `path.recheck` and the tool does not run. This
closes the approval window. It is not an atomic no-follow write: the pinned
host's writer uses a plain file write, so a swap in the microseconds between
the recheck and the write is outside this guarantee.

`/permissions why -- <command>` is an execution-free policy check. It runs the
same policy, scoped-rule, approval, and shell-availability chain as a real
command, without executing it. It prints the effective decision, raw policy
decision, approval decision, rule IDs and reasons, whether approval is
required, shell availability, and the policy layer. It also prints the stages
it replayed and the stages it did not: the optional model reviewer, a human
approval response, and the agent's own shell environment are outside the
check. A `sandbox.unavailable` result means the command would be denied even
if its policy decision was `allow`.
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
- `~/.codepunk/model-history.json` stores recent and favorite model references
  with owner-only permissions; it contains no credentials.

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
TUI opens an arrow-key setup menu and points at `/login`, `/model`, and
`codepunk models import` instead of starting a request with an unusable model.
The
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
`permission`, `shell-allow`, `network-allow`, `network-deny`, `model`,
`fallback`, and `thinking` frontmatter. Profiles load from
`$CODEPUNK_HOME/agents/*.md`; project profiles load from
`.codepunk/agents/*.md` only after the workspace is trusted, and override a
user profile with the same name. `tools` accepts `read`, `search`, `write`,
`edit`, and `shell`. A shell profile must declare an exact argv
`shell-allow`; shells, interpreters, globs, and shell fragments are rejected.
The child host pins each program's digest and runs unmatched argv with
`approval = "deny"`. `model` and `fallback` use exact `provider/model`
references; a per-run `--model` must belong to the profile's pool.

The child cannot widen the parent's declared tool or execution boundary. A
read-only parent, or one with `approval = "deny"`, cannot spawn a mutating
profile; every enabled child tool must also be present in the parent's
`tools.enabled` list, and `permission: standard` requires a standard parent.
A child's `network-allow` must be a subset of the parent operator allowlist;
profile deny entries are merged with the parent deny list. The child always
runs with `sandbox = "required"`, `filesystem = "workspace"`, no MCP, no
plugins, and no memory. A write/edit child uses `--approval allow` inside its
detached worktree. A shell child uses `--approval deny` with exact scoped argv
rules, so unmatched commands fail closed. Worktree isolation and the explicit
review/sign/merge gate are the compensating human boundary.

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

A mutating child is reviewed before it reaches the parent branch.
`/agents review <id>` shows its status, changed files, bounded patch, and
summary; `/agents transcript <id>` renders the stored child transcript;
`/agents sign <id>` records the human complete or incomplete verdict;
`/agents merge <id>` freezes the worktree, writes the handoff, and merges the
signed exact commit; and `/agents discard <id>` removes an unmerged worktree
after a separate confirmation. Codepunk never merges a child automatically.

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
In the TUI, `/mcp` lists servers; `/mcp login [name]` runs OAuth with an
arrow-key server choice, `/mcp status [name]` reports stored credentials, and
`/mcp logout [name]` removes them, offering the same arrow-key choice when no
name is given. `/mcp add [name]` and `/mcp remove [name]` create or remove
user-scope entries through the same validated writer as the CLI; the add form
covers stdio commands and Streamable HTTP URLs, then reloads the server set.
Session startup is tolerant of one broken server: it records a configuration
warning and keeps the other servers, while `mcp test` remains the fail-closed
check for the broken entry.
In the TUI, `/reload` re-discovers skills, re-reads `mcp.toml`, starts the new
server set, stops the old processes, and rebuilds the wrapped tool surface
without replacing the Codepunk session. It also re-scans user plugins and
swaps Pi's extension/tool registry in place. Approval mode, ordinary autonomy
and scoped rules, and plugin enablement apply live; sandbox, filesystem, and
network grants, model routing, context and tool loadout, session/budget/memory
policy, TUI chrome, and the reviewer binding are next-session settings, and
`/reload` reports which is which.
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
The CLI's `install`, `upgrade`, and `uninstall` commands use npm as the
user-facing package manager; that is separate from repository development.
This checkout is version `0.1.0`. `install` still refuses the `0.0.0`
placeholder, which no registry can resolve, and names the version it would
fetch otherwise.

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
