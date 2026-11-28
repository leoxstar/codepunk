# CLI & TUI Reference

This document collects the full command, trust, permissions, background task,
image, model, subagent, and MCP reference previously embedded in the root
[`README.md`](../README.md).

## Workspace trust

Codepunk keeps Pi's whole-workspace boolean in `~/.codepunk/trust.json` and a
per-resource decision file at `~/.codepunk/workspace-trust.json`. The
decision has four independent grants: `config` (`.codepunk/config.toml`,
`local.toml`, and `agents`), `policy` (`.codepunk/policy.toml`), `skills`
(`.codepunk/skills`), and `instructions` (every instruction file discovered
between the invocation directory and the delivery root). Loading one group
never authorizes another. A bare `.codepunk` directory does not trigger the
prompt; Codepunk creates one for its own state.

Project MCP files in `.mcp.json` load only when explicitly trusted; `--no-mcp`
skips user-scope MCP servers for one session. `--no-skills` and `--no-plugins`
isolate those surfaces individually. `--bare` is the aggregate session switch:
it disables discovered instruction files, skills, user plugins, MCP servers,
and memory while leaving model auth, trust, policy, approval, and sandbox
settings in force.

User lifecycle hooks live in `$CODEPUNK_HOME/hooks.toml`. Project hooks in
`.codepunk/hooks.toml` remain inert unless the workspace has the `config`
trust grant and the user file explicitly sets `project_enabled = true`.
Project hook files cannot authorize themselves. Hook timeout, nonzero exit,
spawn failure, malformed configuration, and evidence-write failure all fail
closed.

The two trust stores use canonical paths and exact-root lookup. A parent
repository's decision never covers a nested repository. A malformed
per-resource file aborts startup instead of becoming "no decision". Partial
decisions also write `false` to Pi's store, so removing the sidecar cannot
silently widen trust in another Pi entry point. `codepunk trust status` prints
both paths in use.

Project config is floored by the user layer. `.codepunk/config.toml` may narrow
tools, memory, model scope, and telemetry, but `model.provider`, `model.id`,
`context.append`, approval, autonomy, sandbox, and budget keys are
user/CLI-only. `.codepunk/local.toml` is a machine-local exception for
non-user-scope preferences such as TUI settings and `model.thinking`; it is
ignored by Git, skipped until the workspace is trusted, and rejects every
user-scope key.

```text
codepunk trust [status|grant|revoke] [path] [--resources config,policy,skills,instructions] [--json]
--trust | --no-trust        one-run override for all resource groups
--trust-resources <kinds>   one-run override for named groups
--add-dir <dir>             extra file root for this session (repeatable)
```

Trust is scoped to the current Git checkout. A linked worktree is a separate
canonical root and needs its own decision. `--add-dir` only adds an explicit
file root for the current process without discovering config, policy, skills,
MCP servers, or instructions from the extra root.

## File checkpoints & rewind

Codepunk records a bounded checkpoint after every successful `write` or `edit`
tool call under `$CODEPUNK_HOME/projects/<project>/sessions/<session>/checkpoints`,
and maintains Shadow Git snapshots (`ShadowGitStore`) for `/rewind shadow`.

```text
/undo [count]   restore applied file checkpoints (verifies current file digest first)
/redo [count]   reapply undone file checkpoints
/rewind         open the interactive checkpoint, shadow-git, and branch picker (Alt+R)
```

Each file checkpoint is capped at 1 MiB, the session store at 32 MiB and 100
entries. `.git` and `.codepunk` are never checkpointed. A restore is refused
when the current file digest differs from the checkpoint, so manual or external
edits are never silently overwritten.

## Project instructions

```text
/init [--update]
/status
```

`/init` asks the selected model to inspect the repository and create
`AGENTS.md` at the delivery root through the normal approval, sandbox, and
evidence gate. It requires a trusted workspace, a non-read-only autonomy
profile, and a selected model, and refuses to overwrite an existing root
instruction file unless `--update` is given.

## Configuration

```text
codepunk config [--json]
codepunk config path [--json]
```

`codepunk config` is the read-only, non-interactive counterpart to TUI
`/settings`. An environment variable may tighten a trust axis silently, while
a value that loosens `approval.mode`, `autonomy.profile`, `filesystem.mode`, or
`sandbox.mode` adds a config warning. Every evidence record carries the
effective `approval_mode`.

## Permissions

```text
/permissions profile read-only|standard|auto|auto-approve|full-access
/permissions approval ask|deny|auto|allow
/permissions reviewer off|model [provider/model]|timeout <ms>
/permissions autonomy read-only|ask|scoped
/permissions sandbox required|uncovered
/permissions sandbox network [allow|deny <domain>...|clear]
/permissions filesystem workspace|full
/permissions rules
/permissions insights
/permissions why -- <shell command>
```

CLI counterparts:

```text
codepunk permissions
codepunk permissions profile read-only|standard|auto|auto-approve|full-access
codepunk permissions rules [--json]
codepunk permissions insights [--json]
codepunk permissions why -- git status
```

Named profiles bind four independent axes:

- `read-only`: reads and read-only workspace inspection run; file mutations
  and ask-level actions are denied; `srt` drops workspace write grants; user
  MCP servers and plugins stay off.
- `standard`: reads and writes inside the policy write set run; unknown shell,
  instruction-file edits, sensitive paths, and MCP actions ask.
- `auto`: auto-approves routine reads and ordinary shell commands that survive
  policy; dynamic launchers/interpreters (`sh -c`, `python -c`, `node -e`,
  `env`, `xargs`), destructive actions, explicit policy asks, protected writes,
  sensitive reads, network/package-index commands, and MCP tools still ask.
- `auto-approve`: every non-MCP policy `ask` becomes `allow`; hard denies and
  the human MCP gate remain, and `srt` stays required.
- `full-access`: `auto-approve` plus an unsandboxed shell and full filesystem;
  every start requires `--dangerously-bypass-approvals-and-sandbox`.

`approval.reviewer = "model"` adds an optional user-scope model reviewer under
`auto` (CLI flags `--approval-reviewer off|model`, `--reviewer-model provider/id`,
`--reviewer-timeout-ms <ms>`). It only resolves network commands and headless
argv `exec`; malformed responses, errors, and timeouts abstain.

`scoped` autonomy is an exact-argv allowlist pinned to executable digests.
Shells and interpreters (`sh`, `cmd.exe`, `powershell`, `node`, `python`) are
rejected as scoped-rule targets; resolve a concrete non-shell executable (such
as `git`, `rg`, or `whoami` on Windows) instead.

`srt` enforces the write set and a no-network default. Egress is opened per
host through user-scope `sandbox.network_allow` and carved out with
`sandbox.network_deny`. Git control surfaces (`.git/config`, `.git/hooks`,
`.git/info`, `.git/objects/info`, `.git/objects/pack`, and worktree `.git`
pointer files plus their resolved gitdir/commondir targets) are protected from
direct writes while permitting normal `git add`/`git commit`.

## Goals, review, and hooks

```text
/goal [text|status|pause|resume|clear]
/review
/hooks [status]
```

`/goal` stores a hash-chained goal event injected as untrusted data across
turns, compaction, and resume. `/review` binds structured findings to a working
tree diff SHA-256 without editing files or creating allow rules. User hooks live
in `$CODEPUNK_HOME/hooks.toml` (`before_tool`, `after_tool`, `before_stop`,
`session_start`, `session_end`).

## Background tasks & side tasks

```text
/tasks          unified task center for subagents, background tasks, and side tasks (Alt+T)
/ps             list durable background tasks
/logs <id>      bounded tail of task stdout/stderr
/stop <id>      terminate a background task process group
/btw <prompt>   read-only background side task (POSIX only; reports platform limitation on Windows)
```

Background tasks run in detached POSIX process groups with durable `task.json`,
`evidence.jsonl`, and bounded log files. On Windows, `/btw` reports an explicit
platform limitation without falling back to a blocking foreground call.

## Images

```text
/image <path> [prompt]
/image --clipboard [prompt]
/image-gen [--model <provider/model>] <prompt>
```

`/image` validates PNG, JPEG, GIF, or WebP files inside the workspace (up to
10 MiB), rejects symlinks and credential-shaped plaintext in raw bytes, asks
for confirmation, and records content hashes in evidence. `/image-gen` uses an
authenticated image model behind the policy/approval gate.

## Models

Provider credentials and custom endpoints live in `$CODEPUNK_HOME`:
`config.toml`, `models.json`, `auth.json` (or OS keychain via
`model.credential_store`), and `model-history.json`.

```text
codepunk setup
codepunk models list
codepunk models import http://127.0.0.1:4000/v1 --provider local --api openai-responses --api-key local-dev
codepunk models set local/example-model --thinking max
codepunk models remove local
codepunk models test
codepunk models auth
```

In the TUI: `/model` opens Pi's fuzzy model picker (`Ctrl+S` persists the
default to `config.toml`), `/models` opens recent/favorites, `/favorite`
toggles favorites, `F2` cycles recent models, and `Shift+Tab` cycles thinking
levels. `model.fallback` configures an ordered recovery chain; cross-provider
fallback requires explicit opt-in. See [`docs/MODELS.md`](MODELS.md).

## Subagents

```text
/subagent [--profile <name>] [--model <provider/model>] [--worktree|--shared] <task>
/agents [profiles|result <id>|wait <id>|stop <id>|review <id>|transcript <id>|sign <id>|merge <id>|discard <id>]
```

Agent profiles load from `$CODEPUNK_HOME/agents/*.md` and trusted
`.codepunk/agents/*.md`. Children cannot widen the parent's tool or execution
boundary; mutating profiles always run in a detached Git worktree and require
human `/agents review`, `/agents sign`, and `/agents merge` (supporting clean
three-way merges) or `/agents discard`.

## Capabilities, plugins, skills, and MCP

```text
codepunk capabilities [--json]
codepunk plugins list [--json]
codepunk plugins add <file|dir> [--force]
codepunk plugins remove <file|id>
codepunk plugins enable|disable <id>
codepunk skills list|add|remove
codepunk mcp list|add|remove|test|status|login|logout
```

In the TUI, `/mcp` opens the interactive MCP panel, `/reload` refreshes skills,
MCP servers, and plugins in place, and `/capabilities` shows the redacted
extension inventory. Plugins packaged with `plugin.toml` run inside an isolated
child host (`dist/host-child.js`) with bidirectional product-tool bridging and
`plugin/*` session events. See [`docs/SKILLS-MCP.md`](SKILLS-MCP.md).

## Sessions, evidence, and maintenance

```text
codepunk resume [id|latest|text]
codepunk sessions list|tree|graph|search|rename|pin|archive|delete|export|import
codepunk attest [session-id] [--output path] [--json]
codepunk backup create|list|restore
codepunk migrate --check|--apply
codepunk gc [--apply]
codepunk acp
codepunk completion bash|zsh|fish
```
