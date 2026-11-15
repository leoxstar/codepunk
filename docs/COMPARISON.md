# Comparison

This note records a local, version-pinned comparison of common coding-agent
surfaces. It is a discussion aid, not a claim that every feature of every
product was exercised.

Observed on 2026-11-15 from the binaries installed on this machine:

| Product      | Version   | Basis                                                                          |
| ------------ | --------- | ------------------------------------------------------------------------------ |
| Codepunk     | `0.0.0`   | `--help`, full `pnpm run verify`, real gateway request, real PTY               |
| Codex CLI    | `0.169.0` | `--help`, `--version`, `codex sandbox -P :read-only`; docs for rules/approvals |
| Gemini CLI   | `0.68.0`  | `--help`                                                                       |
| OpenCode     | `2.3.0`   | `--help`; source at tag `v2.3.0`                                               |
| Pi           | `1.5.2`   | `--help`; Codepunk's pinned host, read from `node_modules`                     |
| OMP          | `18.12.6` | `--help`; embedded source strings in the installed binary                      |
| Kimi Code    | `2.6.0`   | `--help`; TUI strings from the installed binary, docs cross-check              |
| MiniMax Code | `0.7.7`   | `--help`; readable JS bundle plus public repo                                  |
| Claude Code  | `2.1.323` | `--help`, `--permission-mode manual` probe; commercial reference               |

`not exposed` means the installed help surface did not expose the capability.
It does not prove the product lacks an undocumented path. `not verified` means
this comparison did not exercise it.

The source-backed rows below come from three independent reads of the installed
products: Codex CLI and Claude Code; OpenCode, Pi, and OMP; Kimi Code and
MiniMax Code. Each read inspected commands or source tied to a specific
version, not marketing pages. Where a claim rests on product documentation
rather than executed behavior, it is marked.

## Core matrix

| Surface                     | Codepunk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Codex CLI                                     | Gemini CLI                                                                                 | OpenCode                           | Claude Code                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------- |
| Interactive TUI             | yes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | yes                                           | yes                                                                                        | yes                                | yes                                                                                |
| Headless prompt             | yes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `exec`                                        | `-p`                                                                                       | `run`                              | `-p`                                                                               |
| Machine-readable output     | text; JSONL events in print `--mode json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | not verified                                  | text/JSON/stream JSON                                                                      | not verified                       | JSON/stream JSON/schema                                                            |
| Model selection             | Pi-native fuzzy `/model`, exact `provider/id`/bare ID, `--model`, validated fallback chain                                                                                                                                                                                                                                                                                                                                                                                                                                              | `-m`, `/model` popup                          | `-m`                                                                                       | `/models` picker                   | `/model <alias-or-name>`, picker                                                   |
| Model catalog command       | `models list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | not exposed in top-level help                 | `models`, `--list-models`                                                                  | `models`                           | not exposed in help                                                                |
| Custom endpoint import      | `models import` / `models remove`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | config                                        | config/env                                                                                 | config                             | provider config                                                                    |
| Real model request check    | `models test`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `doctor` checks runtime/auth                  | not verified                                                                               | not verified                       | not verified                                                                       |
| Approval modes              | `read-only`/`standard`/`auto`/`auto-approve`/`full-access` presets over separate approval (`ask`/`deny`/`auto`/`allow`), autonomy, sandbox, and filesystem axes; scoped exact-argv allowlist; once/session/persistent approvals; `allow` keeps MCP at the human gate                                                                                                                                                                                                                                                                    | sandbox + approval are separate; prefix rules | default/auto-edit/yolo/plan                                                                | allow/ask/deny rules               | permission mode + rules; deny > ask > allow                                        |
| Workspace trust             | Pi `ProjectTrustStore`; Pi `SelectList` prompt with a `→` pointer, Up/Down, Enter, and Escape/Ctrl+C (no numbered menu), persistent trust highlighted by default, saved decision, `--trust`/`--no-trust`; exact checkout root, so a linked worktree needs its own decision; gates project config/policy/skills and project instruction files (`AGENTS.md`/`CLAUDE.md`); project MCP files are inert and only produce a user-scope warning; an untrusted project is skipped with a warning and print mode refuses an unresolved decision | project trust in config                       | not verified                                                                               | not exposed in help                | directory trust dialog                                                             |
| Extra file roots            | `--add-dir`; canonicalized, symlink-rechecked, no project resource loading, protected `.codepunk`/Git paths in every root                                                                                                                                                                                                                                                                                                                                                                                                               | `--add-dir` writable root                     | not verified                                                                               | not exposed in help                | `--add-dir` / `additionalDirectories`                                              |
| File undo/redo              | `/undo [count]` and `/redo [count]` restore bounded before/after snapshots from successful Codepunk `write`/`edit` calls; current digest and regular-file checks reject external edits; shell/MCP/plugin effects are excluded and the session records `checkpoint/restore`                                                                                                                                                                                                                                                              | conversation rewind only; files unchanged     | `/rewind`/`/restore` with checkpointing and smart patch fallback; default restore disabled | `/undo`/`/redo` with Git snapshots | `/rewind` / Esc Esc restores files and/or conversation; Bash-made changes excluded |
| Approval shows action+why   | yes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | not verified                                  | not verified                                                                               | not verified                       | not verified                                                                       |
| Sandbox                     | `srt` with coverage; mode change next session; user-scope `sandbox.network_allow`/`network_deny` are the only egress controls, a project config cannot set either, and `srt` applies deny before allow; host reads are allowed except Codepunk home and `.codepunk`, writes stay in the policy set                                                                                                                                                                                                                                      | read-only/workspace-write/danger-full-access  | `--sandbox`                                                                                | not exposed in help                | permission rules plus optional sandbox settings; `--add-dir` is not an OS sandbox  |
| Current date/time context   | `environment` section injected through Pi's `before_agent_start` hook (Pi 1.5.2 has no built-in clock section); timestamp plus IANA timezone, no weekday table; the model derives the weekday                                                                                                                                                                                                                                                                                                                                           | not verified                                  | not verified                                                                               | not verified                       | not verified                                                                       |
| MCP management              | user-scope `mcp.toml`; project MCP files inert; list/add/remove/test/login/logout/status over Pi MCP; real connection checks in `mcp test` and `doctor`; OAuth sign-in and refresh through `pi-mcp/oauth`; a failed server is skipped at session start with a warning; `--no-mcp` skips all servers for one session; stdio + Streamable HTTP; Pi resource tools with the same approval/evidence gate                                                                                                                                    | `mcp`                                         | `mcp`                                                                                      | `mcp`                              | `--mcp-config`                                                                     |
| Plugins/extensions          | opt-in user plugins; list/add/remove/enable/disable CLI; `/reload` re-scans the plugin directory and swaps the extension/tool registry in place; `--no-plugins` and `--bare` isolate plugin loading                                                                                                                                                                                                                                                                                                                                     | `plugin`                                      | `extensions`                                                                               | `plugin`                           | plugins                                                                            |
| Skills                      | discovered from user/project skills; `/reload` re-discovers and swaps the injected block; `--no-skills` and `--bare` isolate skill loading                                                                                                                                                                                                                                                                                                                                                                                              | not verified                                  | `skills`                                                                                   | not verified                       | skills in help                                                                     |
| Hooks                       | not exposed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | hook trust controls in help                   | `hooks`                                                                                    | not verified                       | hooks in help                                                                      |
| Session list/resume         | CLI list/resume plus live TUI `/resume` that rebuilds the host                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | yes                                           | yes                                                                                        | `session`                          | yes                                                                                |
| Session fork/clone          | settled CLI `--fork` plus live TUI `/fork`/`/clone` into a child product session                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `fork`                                        | not exposed in help                                                                        | `--fork`                           | `--fork-session`                                                                   |
| Sub-agent delegation        | `/subagent` child Pi session with its own session and evidence; optional profile supplies read/search/write/edit mask, model pool, thinking level, prompt, and worktree isolation                                                                                                                                                                                                                                                                                                                                                       | not verified                                  | not exposed in help                                                                        | not exposed in help                | not verified                                                                       |
| Worktree isolation          | mutable `/subagent` profiles run in detached worktrees; library-level delivery worktrees (`WorkerSandbox`/`WorkerPool`); no worker CLI command yet                                                                                                                                                                                                                                                                                                                                                                                      | `--worktree`                                  | `-w`                                                                                       | not exposed in help                | not exposed in help                                                                |
| Evidence chain and sign-off | yes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | no equivalent observed                        | no equivalent observed                                                                     | no equivalent observed             | no equivalent observed                                                             |
| Local read-only daemon      | yes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | app server/remote control                     | ACP                                                                                        | server/service API                 | background sessions                                                                |
| Web search                  | no                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `--search`                                    | not verified                                                                               | not verified                       | not verified                                                                       |
| Shell completion            | no                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `completion`                                  | not exposed in help                                                                        | `--completions`                    | not exposed in help                                                                |
| Screen-reader mode          | no                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | not exposed in help                           | `--screen-reader`                                                                          | not exposed in help                | `--ax-screen-reader`                                                               |
| Windows support             | not claimed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | not verified                                  | not verified                                                                               | not verified                       | not verified                                                                       |

Codepunk's `auto` row has one deliberate opt-in beyond the static table: a
user-scope model reviewer can resolve only network commands and headless argv
`exec`. It is off by default, never sees hard denies, sensitive paths,
protected writes, MCP calls, explicit policy asks, or scoped misses, and
fails closed on malformed output, timeout, or upstream error. This is narrower
than Codex's reviewer and is not a second agent loop.

## Additional installed agents

These rows combine installed help with source or binary-string inspection.
They are included because the surface differences are useful for Codepunk's
design review.

| Surface            | Pi `1.5.2`                                                                                                   | OMP `18.12.6`                                                                | Kimi Code `2.6.0`                                                                                                                                     | MiniMax Code `0.7.7`                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Model search       | `/model` exact-first then fuzzy; search covers provider, `provider/id`, bare id, name; Ctrl+S saves default  | `/model` ignores query; `/switch` fuzzy and session-only; `--model` fuzzy    | `/model` picker with search, provider tabs, capability chips, favorites                                                                               | `/model` picker with search; `←/→` changes thinking effort                                                                                  |
| Workspace trust    | project trust gates settings, MCP, extensions, and skills; `AGENTS.md`/`CLAUDE.md` still load when untrusted | not exposed in help                                                          | `workspace.requireTrust` defaults true; project MCP and permission rules stay off until trusted; other project resources not seen under the same gate | directory trust and project `.mcp.json` behavior not verified in this version                                                               |
| Approval surface   | Project trust, `--tools`/`--no-tools`; no per-call approval                                                  | `always-ask`, `always-ask-cached`, `write`, `yolo`; schema default is `yolo` | Always Ask (`manual`) / `yolo` / `auto` / plan; session approval; sensitive files still ask                                                           | runtime `default` / `auto` (default) / `off` / `bypassPermissions`; headless `smart/full/off`; allow-once, always-allow, deny-with-guidance |
| Isolation          | none built in                                                                                                | not exposed in help                                                          | prompt states the environment is not a sandbox; no OS sandbox found in the inspected surface                                                          | optional sandbox; source default is disabled/full-access, with `allow_all` network                                                          |
| Session continuity | `--resume`, `--continue`, `--fork`                                                                           | `--resume`, `--restore`, import from Claude/Codex                            | `fork`, `import-sessions`, archive, search, visualizer                                                                                                | `/sessions` rename/archive/search; lightweight context mode                                                                                 |
| Delegation         | none first-class                                                                                             | role models; no user-visible child sessions in help                          | `coder`/`explore`/`plan`, bounded `subagents` allowlist, secondary model pool                                                                         | `task` child sessions, agent personas, side conversation (`/btw`)                                                                           |
| Protocol/server    | `--mode rpc`                                                                                                 | `acp`                                                                        | `acp`, local web UI                                                                                                                                   | `acp`, app-server, SSH app-server                                                                                                           |
| Extensibility      | install/remove extensions; `mcp`; skills                                                                     | extension, plugin, skill registry                                            | agent profiles, plugins, MCP                                                                                                                          | `plugin`, `mcp`, provider/key management                                                                                                    |
| Distinctive idea   | small host with explicit tool and context surfaces                                                           | role-specific models, goal/plan modes                                        | strongest session import/fork and sub-agent model pool                                                                                                | strongest approval panel and configurable status line                                                                                       |

Kimi separates two questions: whether the workspace may contribute project MCP
and permission rules, and whether a particular tool call may run. Its trust
record is per workspace; `KIMI_CODE_TRUST_WORKSPACE=1` bypasses the prompt, so
that environment variable must be treated as a dangerous switch. The static
paths do not show the same trust gate for instructions, project skills, project
agent profiles, or `additional_dir`; the UI text and those code paths disagree,
so Kimi's trust boundary is partial rather than a blanket "untrusted project is
inert" guarantee. MiniMax has a strong action-approval panel, but this audit
did not verify a workspace-trust store or headless trust behavior; its runtime
approval default is `auto`, `mcode exec --permission full` maps directly to
`bypassPermissions`, and its optional sandbox default is not a verified
whole-process fs/network boundary. These are different trust models, not
variations of one preset name.

## Codepunk coverage on this machine

The local gate covers print and JSON modes, approvals, scoped autonomy, `srt`,
evidence and sign-off, sessions and retention, context and memory, skills and
MCP gating, daemon/view, delivery worktrees, merge and handoff checks, workers,
plugins, TUI behavior, real child Pi sessions in `/subagent`, package
install/upgrade/uninstall, an execution-level read-only/standard/auto/
auto-approve/full-access matrix, one-session `--no-skills`/`--no-plugins`/
`--bare` isolation, PTY tests for both read-only live-switch directions,
live `/resume`/`/new`/`/tree`/`/fork` and streaming steering, and repository
negative controls. The TUI also covers `/init` guard and model-prompt
injection, `/status`, skill hot reload, and the Pi-native trust selector.
On 2026-11-16, the local suite reported 566 tests and the repository check
reported 506 files across 3 packages.

The real PTY also covers the model semantics directly: `/model oth` opens
Pi's fuzzy selector with no usage warning, an exact `provider/id` selection
persists, picker Enter remains session-only, and `Ctrl+S` persists the
highlighted default. The permission PTY covers `/permissions` profiles,
both `/permissions why date +%A` and `/permissions why -- date +%A`, and a
`touch` decision without executing either command.

Real model setup was also exercised outside the repository:

```text
codepunk models list
selected: magpie/group/never-stuck
36 custom models visible through the local Magpie gateway

codepunk doctor
doctor: ready

codepunk models test
model: magpie/group/never-stuck
status: ok
stop: stop
latency: 1868 ms
tokens: input 625, output 30, total 655
text: CODEPUNK_MODEL_OK

codepunk --trust -p '今天星期几？只回答星期几，不要调用工具。'
星期日
```

The Magpie gateway is configured with `authHeader: false`; its placeholder key
marks the provider as configured, but Pi 1.5.2's OpenAI client still sends it
as a Bearer credential. The weekday answer is model-derived from the injected
host time and timezone; there is no weekday lookup table in Codepunk, and the
environment section is recomputed for each turn.

A real PTY against the same Magpie catalog also checked the two UX complaints
directly. Typing `g` into `/model` filtered the selector to the `group/*`
models through its search input. A no-tool print request on 2026-11-15 returned
`星期日` with no approval prompt and no Codepunk weekday table. A separate TUI
clock-command probe is required before claiming shell execution; print mode has
no shell by default.

## Trust and permission mode matrix

The useful distinction is between four questions: does the product trust
workspace-supplied resources, what capability does the mode grant, when does it
ask, and what isolation survives after approval? The rows below come from the
installed help or version-pinned source described in the basis table; this is
not a sandbox-escape test.

| Product      | Workspace trust                                                                                                                                                                                                                                                                                   | Named modes / policy                                                                                                                                                                                                                                                                                                                                                                                                | Isolation                                                                                                                          | Switch semantics                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex CLI    | `[projects."path"] trust_level`; `exec --trust` persists an explicit decision. Headless shows no prompt: project config/hooks/execpolicy/MCP are disabled, but `AGENTS.md` still loads unless the project is explicitly `untrusted`                                                               | sandbox `read-only` / `workspace-write` / `danger-full-access`; approval `on-request` / `never`; config-only `granular`; internal `untrusted`; `--approve-for-me` routes to the Guardian reviewer                                                                                                                                                                                                                   | OS sandbox independent of approval; network denied except an explicit workspace-write opt-in; MCP runs outside the shell sandbox   | danger is a separate `--dangerously-bypass-approvals-and-sandbox`; `exec --trust` raises the default sandbox to workspace-write while headless approvals stay `never`                      |
| Claude Code  | `projects[path].hasTrustDialogAccepted`. `-p`/non-TTY skips the dialog and records nothing; project allow rules/additional dirs are ignored, but project `.mcp.json` servers still connect without asking; `CLAUDE.md` is not trust-gated                                                         | `default` / `manual` / `acceptEdits` / `plan` / `dontAsk` / `auto` / `bypassPermissions`; `deny > ask > allow`; `--restricted` is a separate hardening flag                                                                                                                                                                                                                                                         | permission rules plus optional sandbox, disabled by default; `--add-dir` is not an OS sandbox; bypass writes `.git`/`.claude`      | bypass requires `--dangerously-skip-permissions` or user/policy `defaultMode`; `--permission-prompts=none` auto-denies; `auto` fails closed                                                |
| Gemini CLI   | Folder Trust setting is `security.folderTrust.enabled`; schema/reference default `true` conflicts with the trusted-folders doc default off, so the effective default is unverified. Saved in `~/.gemini/trustedFolders.json`; headless unknown/untrusted exits 55; `--skip-trust` covers one run  | `default` / `auto_edit` / `yolo` / `plan`; headless `ask` becomes `deny`; `yolo` is not persistable via settings                                                                                                                                                                                                                                                                                                    | `--sandbox` is separate and default off; `plan` is policy-level, not an OS read-only boundary                                      | `yolo` is a mode, sandbox stays separate                                                                                                                                                   |
| OpenCode     | no independent workspace-trust gate found; project/ancestor config, `.claude`, `.agents`, and `AGENTS.md` load unconditionally                                                                                                                                                                    | allow / ask / deny rules, last match wins; baseline `*:* allow`; only `*.env` files default ask; `plan` only disables edit, shell/network/external paths can still run                                                                                                                                                                                                                                              | shell uses host user filesystem/process/network permissions; there is no OS sandbox                                                | `--auto` (aliases `--yolo`, `--dangerously-skip-permissions`) approves every `ask`; explicit/managed deny still wins; can persist `autoaccept`                                             |
| OMP          | not exposed in help                                                                                                                                                                                                                                                                               | `always-ask` / `always-ask-cached` / `write` / `yolo`; schema default `yolo`                                                                                                                                                                                                                                                                                                                                        | not exposed in help                                                                                                                | `--auto-approve`                                                                                                                                                                           |
| Kimi Code    | `workspace.requireTrust` defaults true; gates project MCP and project permission rules. Project instructions, project skills, agent profiles, and `additional_dir` were not seen under the same gate; `KIMI_CODE_TRUST_WORKSPACE=1` covers one process                                            | Always Ask (`manual`) / `yolo` (Ask When Needed) / `auto` (Never Ask) / plan. `auto` is the broadest: it skips the dangerous-command policy and approves before sensitive/Git checks. `yolo` still asks a recognized dangerous Bash command; an unanalyzable command is approved. Normal file tools hard-block sensitive paths before policy, but Bash has no file-access list, so `cat .env` is approved by `yolo` | no OS sandbox found; system prompt states the environment is not a sandbox; Bash does not reuse the file-tool sensitive-path check | `--yolo`, `--auto`, `--plan`; `-p` forbids those flags and uses the saved default. Non-interactive omits the dangerous-command policy; a remaining ask fails the run                       |
| MiniMax Code | no directory-trust surface verified; workspace-root `.mcp.json` is read and started without a trust gate                                                                                                                                                                                          | runtime accepts `default` / `auto` / `off` / `bypassPermissions`, default `auto`; TUI `/permission` maps ask→default, auto→auto, full→bypass; headless `exec --permission smart/full/off`                                                                                                                                                                                                                           | optional sandbox is a separate switch, default off; Bash path checks are not a whole-process fs/network boundary                   | mode picker; `mcode exec --permission full` maps to `bypassPermissions`; headless pending interaction is unavailable                                                                       |
| Pi `1.5.2`   | `defaultProjectTrust: "ask"` only fires when protected resources exist (`.pi` settings/MCP/extensions/skills/prompts, ancestor `.agents/skills`, project packages); store `~/.pi/agent/trust.json`; nearest parent decision wins; headless `ask`/`never` skip protected resources, `always` loads | no named approval modes and no pre-execution prompt; default tools `read,bash,edit,write`; `--tools` is a tool allowlist and does not remove MCP tools                                                                                                                                                                                                                                                              | none built in; tools inherit the host user's filesystem/process/network permissions                                                | `/trust` affects future Pi processes; `--approve`/`--no-approve` are one-run resource-load decisions, not tool approvals                                                                   |
| **Codepunk** | Pi `ProjectTrustStore` at `~/.codepunk/trust.json`; exact checkout-root decisions; gates project config/policy/skills and instruction files discovered only from the session cwd to the root; project MCP files are inert; `--add-dir` adds file roots without trusting or loading them           | `read-only` / `standard` / `auto` / `auto-approve` / `full-access`; `auto` approves routine/shell only, not dynamic launchers/interpreters or network; headless honors the same pre-approval table; `allow` still leaves MCP at the human gate                                                                                                                                                                      | `srt` for `required`, no silent fallback; `read-only` removes `allowWrite` at the OS layer                                         | `full-access` and `filesystem=full` need the dangerous flag at every start; print mode cannot use `full-access`; entering or leaving read-only with an active srt shell requires a restart |

Two conclusions matter for Codepunk. First, workspace trust and action
approval are separate in every product that exposes both; collapsing them
would make an untrusted repository look safer than it is. Kimi's trust gate is
partial and MiniMax has no directory-trust surface, so a strong approval panel
is not a trust boundary. Second, the products that offer a full-access mode
keep a separate dangerous switch instead of silently promoting a normal
session. Codepunk follows both patterns. A third difference is intentional:
Codex and Pi load `AGENTS.md` even in an untrusted project, while Codepunk
gates instruction files with the rest of the project-controlled input. The
gate covers every instruction file Pi discovers between the session cwd and
the delivery root, not only a file at the root. Gemini and Kimi are closer to
Codepunk here; the stricter choice closes a path where an untrusted repository
could still steer the agent through prose.

`.codepunk/local.toml` stays trust-gated but is not a second permission
authority: only non-user-scope machine-local preferences such as the TUI and
`model.thinking` are accepted there. Model endpoint/fallback, approval,
reviewer, autonomy, sandbox, filesystem, plugin, budget, session lease, and
context-injection keys are user/CLI-only.

### Trust bypass surfaces

Folder trust is not one switch. These are the surfaces where the audited
products differ, and the Codepunk stance for each:

| Surface                          | Audit finding                                                                                                                                                                                                                     | Codepunk stance                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Project instructions             | Codex loads `AGENTS.md` unless the project is explicitly `untrusted`; Claude's `CLAUDE.md` is ordinary context; Pi loads it; Gemini and Kimi gate it; OpenCode loads it unconditionally                                           | Trust-gated, including nested instruction files between the invocation cwd and the delivery root                                           |
| Project skills/agent profiles    | Codex states skills still load in an untrusted project; Claude uses a project skill's hooks/`allowed-tools`; Kimi profiles were outside its trust gate; Pi gates project skills but also discovers ancestor `.agents/skills`      | Project skills load only from a trusted root; no ancestor skill discovery                                                                  |
| Project MCP                      | Codex disables project MCP without trust; Gemini and Kimi gate it; Claude headless still connects project `.mcp.json`; MiniMax starts it; OpenCode auto-loads and spawns it; Pi starts it after trust                             | Project MCP files are inert at every trust level; only user-scope servers with an explicit command can start                               |
| Project plugins/hooks/extensions | Codex hash-trusts hooks; Claude gates plugin hooks but settings hooks can run headless; Gemini extensions load before the headless trust failure; OpenCode auto-discovers project plugins; Pi always loads user/global extensions | Project extension/hook directories are not loaded; user plugins are opt-in, disabled in read-only, and reported as trusted in-process code |
| Pre-trust preview                | Codex shows project trust controls; Gemini can show a discovery list; other audited products vary between a yes/no prompt and no prompt                                                                                           | Lists each project resource's class, type, size, bounded SHA-256 digest, and truncated state before the workspace decision                 |
| Headless trust                   | Codex disables project config/MCP but still reads instructions; Claude skips the dialog and connects MCP; Gemini exits 55 on an unresolved workspace; Kimi uses a saved record/env; Pi skips protected resources                  | No prompt in print mode: saved decision or explicit `--trust`/`--no-trust`, otherwise fail closed when resources exist                     |
| Extra roots                      | Claude `--add-dir` adds tool roots; Codex adds writable roots; neither is a project-trust grant                                                                                                                                   | `--add-dir` adds file/sandbox roots only; it never discovers or loads project resources                                                    |
| Nested repos / worktrees         | Claude shares trust by canonical Git root; Codex treats a managed worktree as a new key; Gemini checks only cwd; Pi's nearest parent decision wins                                                                                | Exact checkout root: a nested repo or linked worktree needs its own decision                                                               |
| User-level full access           | Codex and Claude can persist full access in user config without a per-folder signal                                                                                                                                               | Persisted `full-access` still requires the dangerous flag at every start; print mode cannot select it                                      |

## Pi SDK reuse boundary

Codepunk is a product layer over the pinned Pi `1.5.2` host, not a second
agent implementation. The boundary below is the one the code follows; the
per-capability rationale is in `docs/AGENT-ARCHITECTURE.md`.

| Surface                     | Supplied by Pi                                                                                                                         | Owned by Codepunk                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent loop and turns        | `createAgentSessionFromServices`, `AgentSession`                                                                                       | product events, run ledger, termination and sign-off                                                                                          |
| Core tools                  | `createReadToolDefinition`, `createWriteToolDefinition`, `createEditToolDefinition`, `createBashToolDefinition`                        | policy/approval/sandbox wrapper, evidence, artifacts, `exec` for headless                                                                     |
| Model catalog, auth, login  | `ModelRuntime`, Pi credentials, `getSupportedThinkingLevels`                                                                           | provisioning commands, exact model selection, fallback chain, probe                                                                           |
| Context discovery           | Pi's filename precedence and instruction parsing; bounded cwd-to-root walk in Codepunk                                                 | instruction envelope, authority order, hashes, trust gate, no read above the delivery root                                                    |
| Workspace trust store       | `ProjectTrustStore`                                                                                                                    | exact-root policy, protected-resource list, bounded pre-trust preview, skipped-class reporting                                                |
| Skills                      | `loadSkillsFromDir`, `parseFrontmatter`, `formatSkillsForPrompt`                                                                       | containment, symlink/NUL checks, byte caps, identity and hash checks                                                                          |
| MCP                         | `@earendil-works/pi-mcp` client, transports, schema normalization, resource methods, `limitMcpContent`, `pi-mcp/oauth` sign-in/refresh | user-scope config, inert project MCP, wrapped-tool requirement, resource-tool approval/evidence, credential store, explicit login, `--no-mcp` |
| Compaction                  | host context window and summary                                                                                                        | checkpoint hashes and durable Pi branch persistence                                                                                           |
| TUI                         | Pi editor and pickers                                                                                                                  | header/footer, product commands, approval channel                                                                                             |
| Search, plan/todo, memory   | grep/find inputs and `truncateHead`/`truncateLine`; Pi's tools may download and cannot hash the binary                                 | `search`, `plan`, `todo`, `memory_search` with a pinned binary and sensitive-path gate                                                        |
| Policy, approval, autonomy  | `ModelRuntime.completeSimple` for the optional reviewer; no approval loop                                                              | presets, scoped exact-argv rules, approval broker, reviewer eligibility, explanations                                                         |
| Sandbox                     | none                                                                                                                                   | `srt` profiles, coverage descriptors, read-only write removal                                                                                 |
| File roots                  | tool `cwd` for relative paths; no project trust side effect for extra roots                                                            | `--add-dir` canonical roots, path containment, symlink recheck, srt write set                                                                 |
| Sessions, evidence, workers | Pi's in-memory branch tree and `navigateTree`; Codepunk records tree moves and snapshots the active branch                             | durable product session log, cold and live forks, evidence chain, worktrees                                                                   |

## Architecture observations

These are the parts of Codepunk that still differ from the strongest patterns
in the comparison.

1. Permissions are one UX over four independent axes plus workspace trust:
   profile preset, approval policy, autonomy, and execution scope (sandbox and
   filesystem). The presets are `read-only`, `standard`, `auto`, `auto-approve`,
   and `full-access`. Approval and ordinary autonomy changes apply live, but
   entering or leaving `read-only` while an `srt` shell is active requires a
   restart because the OS write grant is bound at startup. Sandbox and
   filesystem changes are next-session settings. The status line and
   `/permissions` show trust, the current shell, and the next-session sandbox
   separately instead of implying one atomic switch. `trusted` is not a
   profile.
2. The safe read-only class now covers date, environment queries, common
   filesystem inspection, and read-only `git status`, `git diff --stat`,
   `git log --oneline`, `git branch`, and `git rev-parse` forms.
   `/permissions why -- <command>` replays the policy, scoped-rule, approval,
   and shell-availability chain without executing the command. A command whose
   policy is allowed can still report `decision: deny` with
   `rule: sandbox.unavailable` when no shell would exist.
   Pipelines, redirections, substitutions, destructive commands, explicit
   policy asks, path escapes, and unknown commands still ask. Every
   `rg --files` operand and `rg -f/--file` pattern file is
   checked as a read path, `find` output primaries ask, and agent shell
   commands run with `GIT_OPTIONAL_LOCKS=0` so `git status` cannot rewrite
   `.git/index`. `read-only` removes `allowWrite` from the `srt` profile, so
   the claim is enforced by the OS sandbox and not only by the classifier.
   Network and package-index commands carry their own approval class, and
   shell launchers/interpreters carry `dynamic`; `auto` does not pre-approve
   either. The sandbox still denies egress in `required` mode, so the network
   class is a UX and evidence distinction rather than a grant.
   Print/worker sessions consult the same pre-approval table instead of
   converting every policy `ask` into a refusal.
3. Session start time and timezone are supplied as an `environment` section
   through Pi's `before_agent_start` hook, not as a product-specific weekday
   adapter. Pi 1.5.2 has no built-in clock section, so this is the minimum
   host fact Codepunk must add. A session left open across midnight can use
   the approved `date` command for a fresh reading.
4. Workspace trust gates project config, policy, skills, and instruction files
   discovered from the session cwd to the delivery root. Codex and Pi load
   `AGENTS.md` regardless of trust; Codepunk chooses the stricter
   Gemini/Kimi-like boundary because a prose file can steer tool choice as
   directly as a policy file. User-level instructions still load, and project
   instructions are skipped with an explicit warning until the workspace is
   trusted.
5. Manual and automatic compaction produce a product checkpoint. The event
   binds the compaction entry, first kept entry, summary hash, model, tool
   loadout, and before/after message counts, and the Pi branch is persisted
   immediately so resume sees the same boundary.
6. Approval prompts now show the exact argv, cwd, and a hashed proposed diff,
   and offer allow-once, allow-for-session, always-allow-exact-argv, and
   deny-with-guidance choices. Persistent grants reuse the existing scoped
   rule file and executable digest, with a second confirmation that previews
   the exact argv, cwd, match scope, and storage before saving. Cancelling
   writes nothing. Kimi and MiniMax Code still lead on richer permission-mode
   visualization and sandbox-coverage controls.
7. Model selection is searchable across provider, id, display name, and
   subsequences; exact selection and Ctrl+S defaults persist, while a
   session-only picker choice does not. Fallback is implemented as a
   pre-validated chain through Pi's virtual-model router, with context overflow
   kept on the current model, a `model/fallback` evidence event, and
   `model/retry_start`/`model/retry_end` records for Pi's automatic retries.
   A session token/USD ceiling is implemented over assistant usage events plus
   Pi's session totals. Recent-model and pinned-favorite metadata are still
   missing.
8. MCP servers now have user-scope list, add, remove, real connection test,
   explicit OAuth login/logout/status, and token refresh through Pi's MCP
   client and `pi-mcp/oauth`, with `/mcp` in the TUI and both stdio and
   Streamable HTTP transports. Tokens live in `$CODEPUNK_HOME/mcp-auth.json`;
   session startup never opens a browser. Project MCP files are inert and
   produce a user-scope warning; the model and session are resolved before
   MCP startup; `--no-mcp` skips every server for one session, and `--bare`
   also removes skills, user plugins, discovered instructions, and memory.
   Read-only
   sessions neither start MCP servers nor load user plugins; blanket approval
   still leaves every MCP call at a human gate because both execute outside
   the shell sandbox.
   `/reload` re-reads `mcp.toml`, stops the old server processes, swaps the
   wrapped tool surface, and lets Pi rebuild its registry without creating a
   new Codepunk session. A reload that lands while no model is selected or
   autonomy is read-only keeps MCP stopped and says why.
   Skills and plugins have file-based add/remove, plugins have enable/disable,
   and `/reload` re-discovers both. The TUI `/mcp` command covers OAuth login,
   status, logout, add, and remove. The TUI add form covers stdio and
   Streamable HTTP and uses the same validated writer as the CLI.
9. Session continuity is live: `/resume` and `/new` rebuild the host,
   `/fork` and `/clone` write a child product session and switch to it, and
   `/tree` lists or navigates Pi's branch. Codepunk records `session/forked`
   and `session/tree` and snapshots the active branch. Sibling branches are
   still in-memory only, so there is no durable cross-session branch graph.
   `/export` aliases `/cp-export`.
10. `/subagent` gives a child Pi process its own Codepunk session, run id, and
    evidence head, linked from the parent through a `subagent/result` event.
    A child without a profile is read-only (`read`, `search`) and shares the
    parent checkout. A Markdown agent profile can add write/edit tools, a
    model pool, a thinking level, and a system prompt; a mutating profile runs
    in a detached worktree, and `--worktree` can isolate a read-only profile.
    Up to four children run in the background and are managed with `/agents`.
    Bounded child progress (`assistant_delta` and `tool_start`) reaches the
    parent TUI; full child transcripts/tool output and automatic worktree
    merge are not implemented.
11. Pi emits OSC 7501 program status, and Codepunk inherits it because it runs
    Pi's interactive runtime. The reported app identity is still Pi's
    `APP_NAME`, Codepunk adds no per-event notifications, and the status line
    is fixed.
12. Codepunk is local-first and has no web-search tool. That is a deliberate
    product boundary, not an implementation accident.
13. Unknown slash commands are now rejected before prompt dispatch against
    Pi's reported command list plus the builtin table loaded from the installed
    package. Uncovered sandbox mode no longer implies a working shell: startup
    warns, and the interactive flag is required to create the explicitly
    unsandboxed path.
14. Scoped autonomy is an allowlist, not an overlay: an unmatched action asks
    even when approval is `allow`. Workspace trust is exact-root, so a parent
    decision does not trust a nested repository. `sandbox=required` never
    downgrades when `srt` fails, and a persisted `filesystem=full` session
    fails closed unless the dangerous flag is present.
15. The optional reviewer is deliberately narrower than Codex's reviewer:
    it only handles network and headless `exec` asks, cannot override a
    human-only class, and fails closed. This keeps a second model from
    becoming an unreviewed permission authority.
16. Session metadata now mirrors Pi's title changes, seeds an empty title from
    the first user prompt after redaction and whitespace normalization, and
    writes the redacted title. `codepunk pin <id>` and `pin <id> --unpin`
    control retention, and TUI `/session` reports the id, effective model,
    thinking level, Pi context usage, run id, evidence count, and session
    directory. `/tree` exposes Pi's live branch tree and records each move, but
    only the active branch is snapshotted into the product store.
17. `--add-dir` adds explicit file roots without treating them as trusted
    project roots. Each root is canonicalized and symlink-rechecked; `.codepunk`
    and Git control paths stay protected in every root; project config, policy,
    skills, MCP servers, and instructions are never loaded from an extra root.

## Discussion candidates

Ordered by expected value for the next iteration:

1. Full child transcripts/tool output and an explicit worktree
   cleanup/handoff command for profile-driven `/subagent` sessions.
2. Codepunk configuration hot reload with the same policy gating as runtime
   tool calls. MCP, skill, and plugin reload, OAuth login, and token refresh
   are implemented.
3. Surface the existing session budget stop more clearly in the status line
   and session summary. The budget guard and virtual-model fallback are done.
4. Session fork/clone with explicit parent-child evidence links, and one
   visible session command surface.
5. Product-branded out-of-terminal run state and notifications.
6. Windows ConPTY and sandbox verification before any support claim.

## Limits

- Some rows rest on installed help or product documentation rather than live
  keystroke automation; those are marked in the basis table.
- No other agent's real model request, approval prompt, sandbox escape
  resistance, MCP runtime, plugin isolation, or Windows behavior was exercised
  here except the Codex read-only sandbox and Claude manual-permission probes.
- Codepunk's macOS/Linux behavior is covered by the local suite; Linux CI is
  configured but was not re-run from this macOS session.
