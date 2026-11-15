# Agent Architecture Review

This note answers a narrower question than a feature list: which parts of a
coding agent should Codepunk own, and which parts should come from the Pi host
that Codepunk already depends on?

The review is source-backed. It uses the pinned Pi `1.5.2` package shipped in
this repository, plus source inspection or installed help for Codex CLI
`0.169.0`, Claude Code `2.1.323`, OpenCode `2.3.0`, Gemini CLI `0.68.0`, OMP
`18.12.6`, Kimi Code `2.6.0`, and MiniMax Code `0.7.7`. The local gate and real
gateway requests were also exercised; see Local evidence. The comparison is
not a security test of the other products.

The concrete host dependency is
`@earendil-works/pi-coding-agent@1.5.2`; `pi-agent-core` and `pi-tui` are
transitive packages at the same version. Codepunk pins this surface rather
than vendoring or forking the Pi execution engine.

## The agent loop

A coding agent is not one feature. It is a pipeline with distinct failure
domains:

| Layer                 | Question it answers                                        | Typical owner                |
| --------------------- | ---------------------------------------------------------- | ---------------------------- |
| Session store         | What happened, and can it be replayed?                     | product                      |
| Context assembly      | Which instructions and files are authoritative now?        | host plus product policy     |
| Tool dispatch         | Which capability is exposed, with which schema?            | host                         |
| Policy and approval   | May this exact action run, and who said so?                | product                      |
| Sandbox               | What can the process actually reach after approval?        | product                      |
| Model runtime         | Which model is authenticated and selected?                 | host                         |
| Compaction and memory | What survives when the context window fills?               | host plus product checkpoint |
| Extension ingress     | What code or MCP server can add capability?                | product gate                 |
| Protocol and TUI      | How does a human or another client observe and control it? | product surface              |

Treating these as one layer is what produces accidental reimplementation. Pi
already provides the middle of the pipeline: the agent loop, model catalog and
auth, tool loop, context assembly, compaction mechanics, extension events, and
terminal components. Codepunk should own the trust boundary and the durable
product record, not a second copy of Pi's execution engine.

## Current boundary

Codepunk is a governance product on top of the Pi host:

```text
Codepunk CLI / print / daemon
        |
        v
Codepunk policy -> approval -> sandbox -> wrapped tools -> evidence
        |
        v
Pi host: agent loop, model runtime, context discovery, compaction, extensions
        |
        v
Provider endpoint
```

The authoritative product record is Codepunk's append-only session event log.
Pi's session manager is deliberately in memory in this adapter; Codepunk does
not write a second Pi session file. That avoids two competing session truths,
so the Pi branch is an execution surface, not a second durable product tree.
Codepunk records `/tree` navigation and snapshots the active branch.

The Pi runtime factory admits only explicit Codepunk session targets. `/resume`
and `/new` dispose the old host, build a new Codepunk runtime for the selected
or newly created session, and rebind the product extension context. `/fork` and
`/clone` first write a live child session, then switch to it through the same
replacement path. A Pi session replacement without a Codepunk target fails
closed, as do `/import`, `/share`, and `/bug`. `/reload` keeps the same
Codepunk session but re-reads `$CODEPUNK_HOME/mcp.toml`, closes the old server
processes, and lets Pi rebuild its extension and tool registry; Codepunk
config, skills, and user-plugin inventory remain startup-bound. `/settings`
and `/scoped-models` keep their file-backed product guidance.

`/subagent` reuses that same stack in a guarded child Codepunk process. The
child gets its own product session and evidence; the parent records the link.
This is not a second agent loop or a role prompt inside the parent context.

## Workspace trust

Codepunk reuses Pi's `ProjectTrustStore` instead of inventing a trust file
format. The store lives at `~/.codepunk/trust.json`, uses canonical paths, and
accepts only a decision saved for the exact canonical project root. A parent
repository's decision does not cover a nested repository, because the nested
root can carry its own `.codepunk` configuration. The product adds its own
protected-resource list because Codepunk owns `.codepunk` rather than `.pi`:

- `.codepunk/config.toml`, `local.toml`, `policy.toml`
- non-empty `.codepunk/skills`
- every `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or
  `CLAUDE.MD` that Pi discovers between the invocation directory and the
  delivery root (first match per directory, the same precedence Pi uses)

Instruction filenames are copied once into `PI_INSTRUCTION_FILE_NAMES`, and
`platform/context-files.ts` walks only from the invocation cwd to the delivery
root. Codepunk does not call Pi's `loadProjectContextFiles` for project
discovery: that public helper walks to the filesystem root and reads each
candidate before Codepunk can apply its trust decision. The bounded walk keeps
Pi's first-match-per-directory precedence, never reads above the delivery
root, and never reads an untrusted project instruction. A contract test covers
the candidate list and precedence against the pinned host.
The context reader streams each file, hashes every byte for the full-file
digest, and retains only the bounded prefix in memory. A large instruction
file therefore cannot turn the byte cap into an unbounded allocation, while
the truncation record still names the full size and hash.

A bare `.codepunk` directory is not protected because Codepunk creates one for
its own project registration. An untrusted session skips project config,
project policy, and project skills. Project MCP files are inert: they are not
trust resources because Codepunk never loads them, and startup reports a
user-scope-only warning at any trust level. Project extension/hook directories
are not loaded by this build; because those paths are never consumed, they are
not reported as trust resources. User-scope config, credentials, MCP servers,
memory, and evidence still load because they do not come from the workspace.
Pi also discovers ancestor `.agents/skills` as a protected resource; Codepunk's
skill loader reads only `$CODEPUNK_HOME/skills` and
`<delivery-root>/.codepunk/skills`, so that ancestor path is never consumed and
does not need a separate trust prompt.
Project instruction files are agent input, not passive documentation: they can
steer tool choice as directly as a project policy. An untrusted session
therefore skips `project-instructions` as well as project config, policy, and
skills; `loadContext` records a `context.untrusted_project_instruction`
warning. User-level instructions in Codepunk home still load, so the person's
standing rules are not lost. An instruction file between the session cwd and
the delivery root triggers the prompt, whether it is the root file or a nested
`src/AGENTS.md`; the untrusted warning names the relative resource and says
how to grant trust.

This is deliberately stricter than Codex CLI and Pi, which load `AGENTS.md`
regardless of project trust, and closer to Gemini CLI (directory trust covers
memory/instructions) and Kimi Code (`workspace.requireTrust`). The comparison
is recorded in `docs/COMPARISON.md`; Codepunk does not claim those products
share one trust model.

A linked Git worktree is its own checkout root. `findDeliveryRoot` uses
`git rev-parse --show-toplevel`, not `--git-common-dir`, so trust,
instruction discovery, session registration, and path containment all use the
worktree that was actually opened. The trade-off is that a worktree needs its
own trust decision even when the main checkout is trusted. That is deliberate:
worktree-local instructions and `.codepunk` files are still project input.

`--add-dir` is not a second trust root. It expands only the file-root set used
by file tools and `srt`; project resources are never discovered from an extra
root. Extra roots are canonicalized and rejected when they are missing, equal
to or inside the primary root, contain the primary root, contain user home, or
overlap Codepunk home.

Trust is not the only project-layer limit. `loadConfig` applies a user floor
before the project layer is merged. Project config can narrow `tools.enabled`,
`model.enabled`, memory, and telemetry, but `model.provider`, `model.id`,
`context.append`, `context.append_files`, `approval.mode`, `autonomy.*`,
`sandbox.mode`, and `budget.*` are user/CLI-only and are rejected in project
config. A trusted repository still cannot redirect the model endpoint or
append text to the product instruction block by itself. `.codepunk/local.toml`
is a machine-local exception for non-user-scope preferences such as the TUI
and `model.thinking`: it is ignored by Git and still trust-gated, but every
user-scope key is rejected there too, including model endpoint/fallback,
approval, reviewer, autonomy, sandbox, filesystem, plugin, budget, session
lease, and context-injection keys.
The user config or an explicit CLI flag remains the only place to change a
permission boundary.

The interactive TUI prompts when protected resources exist and no saved
decision applies. The choices are trust once, always trust, or do not trust.
The prompt lists each protected resource with its class, file type, size, and
SHA-256 preview before the decision. Digests are bounded to 1 MiB of content
and 512 directory entries per resource, and symlinks are hashed as links
rather than followed. The same detail is available through
`codepunk trust status`, `/trust`, and the `resource_details` JSON field.
The pre-host selector uses the same affordances as Pi's in-session
`SelectList`: a `→` pointer, Up/Down movement, Enter to confirm, and Escape to
cancel. It deliberately has no numbered menu. The adapter is small because
Pi's TUI does not exist until after the trust decision; every later selection
(resume, approvals, new-session confirmation) goes through `context.ui.select`
instead of a second picker implementation.
Print mode cannot prompt: it uses a saved decision or an explicit
`--trust`/`--no-trust`, and otherwise refuses to start when project resources
exist instead of silently running without the project layer. This is the same
fail-closed posture as Gemini CLI's headless trust check.
`codepunk trust status|grant|revoke` and `/trust` expose the same decision;
`/trust` changes future sessions rather than hot-reloading the current one.
Every runtime records a `trust/decision` event with the source, root, resource
list, and skipped classes so the evidence chain explains why a project layer
was absent.

Trust is intentionally separate from action approval. Trust answers "may this
workspace contribute configuration, policy, and skills?" Approval answers "may
this exact action run now?" A trusted workspace can still require approval, and
an untrusted workspace cannot become full-access through project config.

## Permission model

Codepunk keeps four axes, because collapsing them produces misleading profile
names across products:

| Axis      | Values                                                         | Question it answers                        |
| --------- | -------------------------------------------------------------- | ------------------------------------------ |
| Profile   | `read-only`, `standard`, `auto`, `auto-approve`, `full-access` | Which preset should a person start from?   |
| Approval  | `ask`, `deny`, `auto`, `allow`                                 | When policy says `ask`, what happens?      |
| Autonomy  | `read-only`, `ask`, `scoped`                                   | Does the agent have a standing allowlist?  |
| Execution | sandbox `required`/`uncovered`; filesystem `workspace`/`full`  | What can the process reach after approval? |

`auto` is risk-tiered: routine and ordinary shell classes are approved, while
dynamic launchers and interpreters (`sh -c`, `python -c`, `node -e`, `env`,
`xargs`, and similar), destructive shell actions (deletion, history rewrites,
in-place edits, and opaque pipelines or redirections), explicit policy asks,
protected instruction/config writes, sensitive reads, network and
package-index commands, MCP tools, and unknown non-shell classes still ask.
Network
classification covers `curl`/`wget`/`ssh`-style clients, remote git
subcommands, and package-manager install/add/publish families. The class is a
risk tier; the grant is separate. `sandbox.network_allow` adds hosts to the
sandbox's `network.allowedDomains`, and an approved network command runs
inside that allowlist rather than with open egress. `sandbox.network_deny`
fills `network.deniedDomains`, which `srt` checks before the allowlist, so a
broad wildcard can be narrowed for one host. Both lists are user-scope and
CLI-only: a project config that tries to set either is rejected, so a
repository cannot grant itself egress or hide a host from the operator. An
entry that appears in both lists is a config error.
`codepunk permissions sandbox network allow|deny <domain>` and
`/permissions sandbox network allow|deny <domain>` write them; `clear`
restores deny-by-default. An explicit user or project `ask` rule keeps its
own approval class instead of being silently upgraded by auto mode. `allow`
is the blanket mode for sandbox-covered asks; MCP remains at the human gate
because the server executes outside the shell sandbox. `scoped` is an
exact-argv allowlist, so an unmatched action asks even when approval is
`allow`.
An optional reviewer sits under `approval.mode = "auto"`; it is not a fifth
axis and cannot replace the human gate. It is user/CLI-only and only sees
bounded action metadata. The static policy chain runs first; only unresolved
`network` and headless `exec` asks reach the reviewer. Hard denies, sensitive
paths, protected control-plane writes, MCP side effects, explicit policy asks,
and unmatched scoped rules stay human-only. The reviewer is resolved lazily
on first use: a stale model reference or missing credential cannot block an
`ask`/read-only session, and becomes an abstain with evidence when the action
actually reaches it.
Approval outcomes are recorded as distinct evidence rules instead of one deny
bucket. A matching human denial is `approval.denied`; a missing channel is
`approval.unavailable`; a channel exception is `approval.channel_failed`; an
expired request is `approval.expired`; a correlated-field mismatch is
`approval.mismatch`; and a replayed answer is `approval.already_answered`.
Every path is fail-closed and the action never executes. The distinction
matters because "the user refused" and "the approval surface could not be
reached" are different operational facts.
`sandbox = "required"` never downgrades to an unsandboxed shell when `srt`
fails. `filesystem = "full"` and `full-access` both require
`--dangerously-bypass-approvals-and-sandbox` on every start, including a start
from persisted config.

`read-only` is enforced twice. Policy denies mutations and every ask-level
action, and the `srt` profile is created with an empty `allowWrite` list plus
a `denyWrite` entry for the workspace root. The second layer exists so a
classifier gap cannot turn "read-only" into a writable sandbox; the sandbox
test writes directly through `execCommand` to prove the negative control.
User MCP servers and user plugins are not started in read-only mode: both
execute outside the shell sandbox, so a later approval could otherwise turn a
read-only session into an external write. That startup rule also bounds the
live switch: a running session that already loaded user plugins or connected
an MCP server cannot switch to `read-only`, because changing the autonomy
label cannot unload code that has already executed or revoke capabilities that
are already connected. The same applies when the session started with a
writable `srt` profile: its `allowWrite` grant is bound when the sandbox is
initialized, so changing autonomy alone would leave the OS layer writable
while the UI claimed a second enforcement layer. The TUI refuses every such
switch and asks for a restart with `--permission-mode read-only` (disable
user plugins and add `--no-mcp` when those were active). A session started
read-only cannot widen to `ask` or `scoped` for the same reason in reverse:
its `srt` profile was created with an empty `allowWrite` list, so changing
autonomy alone would make the UI claim a writable session that the OS still
denies. Widening also requires a restart. Only a session whose shell is
disabled or explicitly unsandboxed can change autonomy in both directions
without rebuilding the shell provider.

`full-access` is not an unqualified "no policy" mode. It requires
`autonomy = "ask"`; combining the dangerous start flag with `read-only` or
`scoped` autonomy is rejected instead of silently choosing which boundary
wins. MCP calls remain at the human gate even though approval is `allow`, the
`.codepunk` control plane and Codepunk home remain hard-denied, and Git
metadata writes keep their separate checks. `--allow-unsandboxed-shell` is
explained as a no-op when `sandbox = "required"`, because a flag that cannot
take effect should not look as if it widened the boundary.

`--no-skills`, `--no-plugins`, and `--no-mcp` remove one local surface for a
single session. `--bare` is the aggregate isolation switch: it suppresses
discovered instruction files, Codepunk skills, user plugins, MCP servers, and
memory. It deliberately keeps model authentication, workspace trust, config,
policy, approval, autonomy, and sandbox settings; a bare prompt session is not
an unsandboxed or unapproved session.

Print and worker sessions have no approval channel. They consult the same
`effectiveApprovalDecision` table as the interactive gate instead of treating
every `ask` as a refusal: `auto` pre-approves routine/shell classes, `allow`
pre-approves every non-MCP ask, and `ask`/`deny` refuse. MCP remains denied
without a human channel. `exec` argv carries its own `exec` class, so `auto`
still requires an explicit exact-argv rule (or blanket `allow`) rather than
treating arbitrary argv as ordinary shell.

Blanket `--approval allow` in print mode is therefore not the same claim as
`full-access`. It is the Codex `exec` shape: unattended approvals with
`sandbox = required` still limiting writes to the policy write set and egress
to the configured allowlist. Print mode cannot select `sandbox = uncovered`
(the shell stays disabled) and a persisted `filesystem = full` fails before
the session opens unless the interactive dangerous flag was supplied. The
residual read boundary is deliberate and documented below: `srt` denies
Codepunk home and `.codepunk`, but otherwise permits host reads because build
tools, package managers, and language servers need them. A host-wide
`grep -r` can therefore read files outside the workspace in `auto`; it cannot
write them or send them over the network from inside the sandbox.

The project `.codepunk` directory and Codepunk home are hard-denied to file
tools and shell write-target checks, including in `full-access`. The control
plane is not part of the agent's writable world.

Git's execution and configuration files are a separate control plane.
`.git/config`, `.git/config.worktree`, `.git/hooks`, `.git/info`,
`.git/objects/info`, and `.git/objects/pack` are hard-denied to direct file
and shell-redirection writes; reads of git metadata ask. The `srt` profile
denies the same direct writes, but ordinary `git` processes may update the
index, objects, and refs. Repository hooks still execute when a git command
triggers them, inside the same sandbox; the product reports that boundary
instead of claiming hooks are disabled.

## Pi SDK surface actually used

The boundary is not an informal diagram; the product imports a small Pi
surface and wraps it at two points:

Current pin: `@earendil-works/pi-coding-agent@1.5.2`, with `pi-agent-core`
and `pi-tui` at the same version transitively. The imports live in
`packages/core/src/adapters/pi/index.ts`,
`packages/core/src/model/index.ts`, `packages/cli/src/tui.ts`, and
`packages/cli/src/index.ts`.

| Pi surface                                                      | Where Codepunk uses it                       | What Codepunk does not duplicate                                                                                                                                   |
| --------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createAgentSessionServices` / `createAgentSessionFromServices` | Core host adapter                            | Agent loop, turn lifecycle, model request streaming, tool loop                                                                                                     |
| `SessionManager.inMemory`                                       | Core host adapter                            | A second Pi transcript file; the Codepunk event log is authoritative                                                                                               |
| `SettingsManager.inMemory`                                      | Core host adapter                            | A second Pi settings store; Codepunk writes its own TOML                                                                                                           |
| `ModelRuntime` through host services                            | Model selection, auth state, catalog refresh | Provider registry, credential storage, fuzzy selector                                                                                                              |
| `McpClient` / `StdioTransport` from `pi-mcp`                    | User-scope MCP adapter                       | JSON-RPC framing, initialize, tool listing/call, resource listing/read, process cleanup                                                                            |
| `limitMcpContent` from `pi-mcp`                                 | Model-visible MCP tool results               | Provider-facing MCP truncation; Codepunk does not invent a second MCP output cap                                                                                   |
| `pi-mcp/oauth` sign-in and refresh                              | Remote MCP authentication                    | User-scope credential store, explicit `mcp login/logout/status`, no browser at session start                                                                       |
| `generateUnifiedPatch`                                          | Tool wrap approval preview and diff hash     | Unified diff generation; Codepunk does not ship a second diff engine                                                                                               |
| `truncateHead` / `truncateLine`                                 | Search tool output and grep match lines      | Byte/line-aware truncation that never splits a line; the search wrapper still owns the pinned binary and sensitive-path filter                                     |
| `VERSION` / `CURRENT_SESSION_VERSION`                           | Core session and Pi adapter                  | Pi package version and session-format version in `agent-state.json`; no hardcoded version copies                                                                   |
| `getPackageDir()` + installed builtin slash table               | CLI TUI command inventory                    | The host's accepted builtin slash commands; no mirrored command table                                                                                              |
| `ExtensionFactory` events                                       | Core product extension and CLI TUI extension | Lifecycle interception, context sections, compaction hooks                                                                                                         |
| `before_agent_start` prompt sections                            | Product contract and environment facts       | Section rendering, prompt diffing, and replay; Codepunk adds sections through the host instead of forking the prompt                                               |
| `ToolDefinition`                                                | Core tool adapter                            | Tool schema/execution ABI                                                                                                                                          |
| `createAgentSessionRuntime` + `InteractiveMode`                 | CLI TUI entry                                | Terminal renderer, editor, fuzzy model picker, slash-command parsing; Codepunk loads the host command inventory for pre-routing and owns unknown-command rejection |
| `CustomEditor`                                                  | CLI input interception                       | Key handling and multiline editor                                                                                                                                  |

The wrappers are deliberate: Codepunk policy, approvals, sandbox, evidence,
and product commands sit around these calls. If a proposed feature needs a new
agent loop, model resolver, transcript format, or fuzzy picker, it is probably
in the wrong layer.

The MCP bundle closes through a single connection helper. It waits for Pi's
OAuth provider `settled()` after closing the transport, so a refresh that
rotated the refresh token finishes writing before the process drops the
provider. Closing only the client would leave the old grant on disk when a
shutdown races a token rotation.

### Delegation audit

A full read of the pinned `pi-coding-agent`, `pi-ai`, `pi-mcp`, `pi-tui`, and
`pi-agent-core` packages found three capabilities Pi does not provide as a
first-class, guarded product surface, plus a small number of places where
Codepunk still carries a second implementation. These boundaries are the
product:

| Pi gap                | Why it cannot be delegated                                                                                                                                                                                                                   | Codepunk owner                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Per-call approval     | Pi documents that it does not ask before tool calls; it only exposes a `tool_call` veto                                                                                                                                                      | `policy/`, `approval/`, `permissions/`, `wrap/`    |
| OS sandbox and egress | Pi has no sandbox for `bash`; its WASM sandbox is code-mode-only                                                                                                                                                                             | `sandbox/` over `@anthropic-ai/sandbox-runtime`    |
| Child agents          | Pi 1.5.2 ships a `subagent` example extension, but no first-class SDK export. The example spawns a separate `pi` process and its own agent loop, so it does not carry Codepunk's guarded-host, policy, sandbox, evidence, or trust boundary. | `workers/subagent.ts` with a guarded child process |

The subagent example is useful evidence for the process boundary, but it is
not an exported API and its child is a plain Pi process. Reusing it directly
would bypass the wrapper that makes the child auditable, so Codepunk keeps the
same process shape while owning the guarded host.

Everything else in Pi is already sufficient and should not be re-derived:
`SessionManager` (JSONL entry tree, branch, `branchWithSummary`),
`compact`/`shouldCompact`/`calculateContextTokens`,
`loadSkills`/`formatSkillsForPrompt`, `createToolDefinition`, `McpClient` and
both transports, including resource and template listing plus resource reads,
`ExtensionRunner`, `ModelRuntime`/`ModelRegistry`/
`registerVirtualModel`, `ProjectTrustStore`, `pi-tui`, and
`runPrintMode`/`runRpcMode`.

Five apparent duplications remain. Four are justified; one is a documented
trade-off rather than an oversight:

| Surface               | Codepunk implementation                                | Verdict                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config storage        | TOML `user -> project -> local -> CLI`                 | Justified. Pi's `SettingsManager` is JSON and has no approval, autonomy, sandbox, filesystem, budget, or retention fields.                                                                                                                                                                              |
| Session store         | Event log with `seq`/`prev_sha256`, leases             | Justified. Pi can persist transcripts and custom entries, but not Codepunk's separate evidence contract. Codepunk deliberately supplies an in-memory Pi manager and persists its own event/state pair with a writer lease.                                                                              |
| MCP tool layer        | `pi-mcp` client plus a Codepunk wrapper                | Justified. Every MCP call must pass policy, approval, sandbox, and evidence before it can run. `createMcpExtension` registers tools directly and is intentionally not used. OAuth protocol work is delegated to `pi-mcp/oauth`; only the credential store and explicit login command are Codepunk code. |
| Instruction discovery | Bounded cwd-to-root walk with Pi's filename precedence | Justified. Pi's public helper reads every ancestor before returning, which defeats the exact-root trust gate. The copy is one filename list plus a directory walk; it exists to avoid reading untrusted input, not to reimplement parsing or context assembly.                                          |
| Search tools          | `rg`/`fd` pinned by absolute path + sha256             | Trade-off. Pi's grep/find tools cannot record the binary hash or enforce Codepunk's sensitive-path list.                                                                                                                                                                                                |

The last row is the only place where delegation would remove real code at the
cost of a security property, so it stays. The wrapper now forwards Pi's grep
inputs (`glob`, `ignoreCase`, `literal`, `context`) and reuses Pi's truncation
helpers, so the remaining code is the security boundary rather than a second
search parser. Codepunk does not use Pi's RPC mode: the daemon is a narrower
read-only projection protocol, not a second execution channel. That is a
surface choice, not a claim that every other Pi export is consumed.

### Duplication audit corrections

The Pi 1.5.2 read also found two accidental copies that were not execution
engines and could be removed without changing behaviour:

| Finding                                                                                                          | Resolution                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifacts.estimateTokens` had the same exported name as Pi's message estimator but counted raw characters       | Renamed to `estimateTextTokens`; Pi's `estimateTokens(AgentMessage)` remains the only message/context estimate. Artifact accounting is now visibly a different unit.                                             |
| The five instruction filenames were repeated in delivery protection, worker `denyWrite`, and the path classifier | `platform/path.ts` exports one `PI_INSTRUCTION_FILE_NAMES`; delivery, worker sandbox, trust discovery, and bounded context discovery consume it. A contract test keeps the list aligned with the pinned Pi host. |

Two other audit suggestions were rejected after checking the pinned types:

- `calculateContextTokens` accepts a `Usage` record, not a message array, and
  `findTurnStartIndex` accepts Pi `SessionEntry` records, not Codepunk's
  projection messages. Wiring either into `truncateContextAtTurnBoundary`
  would be a type error or a second session model, not reuse.
- `createMcpExtension` registers MCP tools directly in Pi's extension runtime.
  Codepunk deliberately keeps the outer tool definition so policy, approval,
  artifacts, and evidence run before `tools/call`. OAuth, the MCP client, the
  transports, schema normalization, and output limiting are delegated; the
  wrapper is the product boundary.

Pi does not re-export its builtin slash table. Codepunk reads the installed
package's real module through `getPackageDir()` instead of copying the table;
an upgrade that moves the module fails at session start with a concrete path,
not by silently rejecting a legal command.

## Fallback routing boundary

Fallback uses Pi's `registerVirtualModel` and `ModelRouteRequest`; it is not a
retry loop in Codepunk:

1. Codepunk resolves and validates every physical chain member before the
   session starts: exact catalog entry, a real Pi `checkAuth` credential
   resolution (not a provider snapshot), `model.enabled` scope, no virtual
   model, no duplicate or ambiguous reference, and no provider/endpoint hop
   unless `model.fallback_allow_cross_provider = true`.
2. Pi exposes the chain as `codepunk/auto`. A user request starts at the first
   usable member; continuations stay on the last successful model.
3. A non-overflow failure advances to the next member. Codepunk uses
   `isContextOverflow` from `@earendil-works/pi-ai`, so provider-specific
   overflow detection is not duplicated. Overflow keeps the failed physical
   model and its router state, then lets Pi compact before retrying.
4. The router state records the pinned chain and every attempted member. When
   the chain is exhausted, routing fails instead of retrying the last failed
   model. A changed chain is rejected on a restored session, and a later
   physical selection is restored instead of being replaced by `codepunk/auto`.
   The virtual model advertises the chain's smallest context and output limits,
   the intersection of input modalities, and the intersection of thinking
   levels returned by Pi's `getSupportedThinkingLevels`.
5. A real switch or exhaustion appends `model/fallback` with the failed/next
   model, stop reason, attempted set, and chain hash. Credentials and upstream
   error bodies are not copied into the event.
6. Pi's public session stream, not its extension event set, carries
   `auto_retry_start` and `auto_retry_end`. Codepunk subscribes to that stream
   and appends `model/retry_start` / `model/retry_end` with the current model,
   attempt, maximum attempts, delay, and a SHA-256 plus bounded redacted error
   preview. The retry loop stays in Pi; Codepunk only records it.

The virtual model is a runtime route, not a default selection. `models list`,
`/model <provider/model>`, and `--model` reject `codepunk/auto`; saving it
would leave the next process with a route that has not been registered yet.

## Decision table

| Capability                       | Decision                             | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent loop and turn lifecycle    | Delegate to Pi                       | Reimplementing the loop would not add product value and would drift from host fixes.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Model catalog, auth, and login   | Delegate to Pi                       | `ModelRuntime`, `/login`, `/logout`, and credential storage already exist and are tested upstream.                                                                                                                                                                                                                                                                                                                                                                                            |
| Interactive model picker         | Delegate to Pi                       | Pi owns fuzzy search, refresh, current/default display, and keyboard handling. Codepunk adds exact `provider/id` and unique bare-ID persistence on the same command.                                                                                                                                                                                                                                                                                                                          |
| Provider import and model probe  | Keep in Codepunk                     | These are product setup commands that turn an arbitrary OpenAI-compatible endpoint into a usable Pi catalog entry, with a real request check.                                                                                                                                                                                                                                                                                                                                                 |
| Tool execution                   | Wrap, do not replace                 | Pi supplies the tool API and the read/write/edit/bash definitions; Codepunk wraps every tool with policy, approval, sandbox, artifacts, and evidence.                                                                                                                                                                                                                                                                                                                                         |
| Unified `search` tool            | Keep as a narrow product exception   | Pi's grep/find definitions call `ensureTool`, which may download rg/fd, and neither enforces Codepunk's workspace root. Codepunk keeps one no-download `search` tool instead of exposing a second tool loop. The tool resolves `rg`/`fd` once per instance from absolute `PATH` entries, records the path and SHA-256, never re-reads `PATH` mid-session, forwards Pi's grep inputs, and reuses Pi's `truncateHead`/`truncateLine`.                                                           |
| Workspace trust                  | Reuse Pi, extend the resource set    | Pi's `ProjectTrustStore` supplies the canonical path lookup and lock-safe JSON format. Codepunk restricts it to the exact canonical root (no inherited parent decision), adds its `.codepunk` resource list plus instruction files discovered from the real cwd to that root, the skipped-class mapping for the `trust/decision` event, and a user floor over `model.provider`/`model.id`/`context.append`. An untrusted workspace cannot contribute instructions, config, policy, or skills. |
| Approval and autonomy            | Keep in Codepunk                     | Pi has project trust, not per-call action approval. Codepunk binds the nonce, TTL, tool call, exact argv, and cwd, then offers once/session/persistent choices. Presets are `read-only`, `standard`, `auto`, `auto-approve`, and `full-access`; the last one requires the dangerous start flag.                                                                                                                                                                                               |
| Permission explanation           | Keep in Codepunk                     | The wrapper and `/permissions why` share `resolvePermissionGate`: policy, scoped exact rules, approval mode, then shell availability. The explanation exposes both the raw policy decision and the effective result without executing the action.                                                                                                                                                                                                                                             |
| Sandbox                          | Keep in Codepunk                     | Pi has no built-in containment. `srt` coverage must remain a Codepunk claim.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Session event log and evidence   | Keep in Codepunk                     | Pi can persist a JSONL session and custom entries, but its ordering and format are not a tamper-evident product ledger. Hash-linked events, writer leases, redaction boundaries, and sign-off are Codepunk requirements, so the Pi manager runs in memory and Codepunk persists the event/state pair.                                                                                                                                                                                         |
| Compaction mechanics             | Delegate to Pi                       | The host owns the context window and summary format. Codepunk should record a checkpoint reference, not invent a second compactor.                                                                                                                                                                                                                                                                                                                                                            |
| Compaction checkpoint and memory | Keep in Codepunk                     | Pi appends the summary and kept boundary; Codepunk records hashes, counts, model, and tool loadout, then persists the Pi branch immediately.                                                                                                                                                                                                                                                                                                                                                  |
| Turn-boundary tool omission      | Keep in Codepunk, bounded            | Codepunk may replace an old tool result with a hash marker at `context.truncation_threshold`, independently of Pi's `context.compaction_threshold`. Pi still decides when to summarize; this is an artifact-retention rule, not a second compactor.                                                                                                                                                                                                                                           |
| Context file discovery           | Bounded discovery in Codepunk        | Pi's `loadProjectContextFiles` walks to the filesystem root and reads before Codepunk can filter. `platform/context-files.ts` keeps Pi's filename precedence but walks only cwd-to-delivery-root, so an untrusted or ancestor file is never read. Codepunk sets `noContextFiles` and assembles the final instruction block, authority order, and hashes itself.                                                                                                                               |
| Skill discovery                  | Pi discovery, hardened by Codepunk   | Codepunk uses Pi's `loadSkillsFromDir`, `parseFrontmatter`, and `formatSkillsForPrompt`, then rechecks containment, symlinks, regular files, NUL bytes, byte caps, frontmatter identity, duplicate names, and hashes before building the untrusted envelope. The prompt lists name, description, and location only; the body is read on demand. Pi remains the discovery walker and formatter; Codepunk remains the trust gate.                                                               |
| Plugins and extensions           | Opt-in trusted code                  | Pi loads extensions in-process; an enabled plugin can call `pi.exec` and filesystem APIs directly, outside Codepunk policy, approval, sandbox, and evidence. Only reviewed plugins should be enabled.                                                                                                                                                                                                                                                                                         |
| MCP                              | Gate in Codepunk                     | Pi supplies the protocol client, `createMcpToolName`, `normalizeMcpInputSchema`, and the OAuth sign-in/refresh flow; Codepunk keeps user-scope config only, ignores project MCP files with a warning at every trust level, stores credentials at `mcp-auth.json`, requires explicit login, fails closed on unwrapped tools, and offers `--no-mcp`/`--bare` as one-session escape hatches. Startup resolves the model and session before any stdio server runs.                                |
| TUI layout and editor            | Delegate to Pi                       | Codepunk registers an extension and adds header/footer/status/commands; it does not render a second TUI.                                                                                                                                                                                                                                                                                                                                                                                      |
| Session fork/clone               | Codepunk state, Pi branch            | `codepunk --fork <id>` is the settled cold path: it takes the parent writer lock and refuses a live writer or `state_covers_seq != last_seq` before copying the Pi branch. In the TUI, `/fork [entry]` and `/clone` validate the live agent state, write a child product session plus `session/forked` (`mode: "live"`), and switch to it. The product header carries the parent id and state hash; Pi's `parentSession` path field is not reused as a product link.                          |
| Session tree navigation          | Pi branch, recorded by Codepunk      | `/tree` lists the in-memory branch tree; `/tree <entry-id>` calls Pi's `navigateTree`, writes `session/tree` with the from/to entry ids and active branch length, and saves the agent-state snapshot. This is live navigation inside one session, not a second durable event tree: only the active branch is snapshotted, so sibling branches do not survive a process restart as separate product sessions.                                                                                  |
| User-visible sub-agents          | Profile-driven child Pi sessions     | `/subagent` launches a separate Codepunk/Pi child with its own session, parent session id, evidence namespace, tool mask, model pool, and optional detached worktree. Pi has no first-class delegation surface, so Codepunk supplies the link, not a second loop.                                                                                                                                                                                                                             |
| Model fallback                   | Pi virtual model, policy in Codepunk | Pi owns request routing and retry timing; Codepunk supplies the ordered chain, provider boundary, fallback event, and `model/retry_start`/`model/retry_end` evidence for Pi's automatic retries. No second request loop.                                                                                                                                                                                                                                                                      |
| Cost budget                      | Keep in Codepunk, implemented        | `config.budget.max_tokens` / `max_cost_usd` combine assistant and compaction usage with Pi's `getSessionStats()` totals, then add direct summary calls separately by `model/usage.source`. A larger Pi total can no longer hide summary tokens. The host aborts and blocks further input with a `budget/exceeded` event. This is product policy over the host's accounting, not a second retry loop.                                                                                          |

## What other agents do

The useful comparison is not the number of slash commands. It is where each
product puts the model, context, and trust boundaries.

| Product      | Model search                                                                                                                                     | Model persistence                                                                                  | Read-only shell posture                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI    | `/model` popup and `-m`; free-text search inside the popup is not documented.                                                                    | Local settings persist; sandbox and approval are separate knobs.                                   | Sandbox decides capability; `on-request` approval only for escalation. Read-only sandbox runs clock reads without asking.                                                                                  |
| Claude Code  | `/model <alias-or-name>` with a picker; Enter saves the default, `s` applies to the session.                                                     | Enter persists the default; `s` is session-only; `/permissions` lists effective rules with source. | Permission mode plus rules; `deny > ask > allow`. A clock read ran in `manual` mode with no approval surface.                                                                                              |
| OpenCode     | `/models` opens a picker; `fuzzysort` over display name and provider, no query argument.                                                         | Picker selection changes the session; recent/favorite metadata is separate.                        | Base policy is `*: allow`; routine reads and shell commands do not prompt without user rules.                                                                                                              |
| OMP          | `/model [query]` ignores the query; `/switch <query>` is the fuzzy, session-only path.                                                           | `/switch` is explicitly temporary; CLI `--model` is fuzzy.                                         | Schema default is `yolo`; `always-ask` auto-approves read-only tools and asks for write/exec.                                                                                                              |
| Kimi Code    | `/model` picker with search, provider tabs, capability chips, and favorites.                                                                     | Selection persists per session; `[secondary_model]` holds a sub-agent pool.                        | Three named modes. `auto` (Never Ask) is the broadest; `yolo` (Ask When Needed) still asks a recognized dangerous Bash command. File tools hard-block sensitive paths, but Bash does not reuse that check. |
| MiniMax Code | `/model` picker with search and an add-provider row; `←/→` changes thinking effort.                                                              | Picker persists; `mcode provider` manages keys with rotation.                                      | `ask / auto / full`, with a warning glyph on full access; the approval panel offers allow-once, always-allow, and deny-with-guidance.                                                                      |
| Pi `1.5.2`   | Blank `/model` opens the picker; a query tries exact first, else pre-fills the picker. Search covers provider, `provider/id`, bare id, and name. | Picker Enter changes the session; Ctrl+S writes the global default.                                | No built-in per-call approval; `read,bash,edit,write` run without asking unless the project is untrusted or tools are restricted.                                                                          |

Five conclusions follow:

1. Codepunk should not invent a weekday formatter. Pi 1.5.2 has no built-in
   clock section, so Codepunk injects one `environment` section through Pi's
   `before_agent_start` hook. Supplying date, time, and IANA timezone is
   enough; a model can derive the weekday, and the approved `date` command
   handles a later reading.
2. Codepunk should not duplicate the model picker. A native picker plus a thin
   exact-selection adapter is the same shape used by the strongest products,
   without creating a second search implementation.
3. Codepunk should not add a second shell parser just to match another product's
   allowlist. It should expand the existing classifier with testable read-only
   classes (`git status`, `git diff --stat`, filesystem inspection) and keep
   pipelines, substitutions, redirects, and unknown commands behind approval.
4. Codepunk should not fake sub-agents with role prompts in one context. Kimi
   and MiniMax Code both use isolated child sessions. Codepunk now uses
   profile-driven child sessions with read/search/write/edit tool masks, a
   per-child model pool, and detached worktrees for mutating profiles.
5. Workspace trust and action approval are separate axes. Kimi's
   `workspace.requireTrust` gates project MCP and project permission rules
   before a tool call exists, but the inspected paths do not show the same gate
   for instructions, project skills, project agent profiles, or
   `additional_dir`; its permission mode then decides whether that call runs.
   MiniMax exposes action approval but no directory-trust surface in the
   inspected build, auto-loads project `.mcp.json`, and maps headless `full` to
   `bypassPermissions`. Codepunk keeps both axes explicit instead of treating
   "trusted" as a permission profile.

### What `auto` means in each product

The products that expose something called "auto" do not implement it the same
way, and the difference matters more than the label:

| Product      | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                | Failure posture                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI    | Separate reviewer model (`approvals_reviewer = "auto_review"`) plus a static approved-prefix table                                                                                                                                                                                                                                                                                                       | Reviewer rejection is final; the model is told not to route around it                                                                       |
| Claude Code  | Server-side classifier with a local safe fast path                                                                                                                                                                                                                                                                                                                                                       | Fail-closed when the classifier is unreachable or the context is too long                                                                   |
| Gemini CLI   | Static Policy Engine rules; the model classifier is a separate opt-in feature                                                                                                                                                                                                                                                                                                                            | Static rules only                                                                                                                           |
| Kimi Code    | Ordered, first-match static policy chain. `auto` skips the dangerous-command policy and reaches blanket approval before sensitive/Git checks, so it is the broadest mode. `yolo` reaches the dangerous-command policy first: a recognized dangerous Bash command asks, while an unanalyzable command approves. Normal file tools hard-block sensitive paths before policy; Bash has no file-access list. | Non-interactive omits the dangerous-command policy; a remaining ask fails closed because nobody can answer.                                 |
| **Codepunk** | Static approval-class table: `routine` and `shell` are approved; destructive, network, MCP, policy, protected, sensitive, and unknown still ask. An optional user-scope model reviewer resolves only `network` and headless `exec`.                                                                                                                                                                      | Reviewer failure abstains; interactive falls back to a human, headless denies. Hard denies and human-only classes never reach the reviewer. |

Codepunk's `auto` starts with the static policy chain, then optionally asks a
model reviewer only for the two classes the table leaves unresolved by
design: network commands and headless `exec`. The reviewer is off by default
and is user/CLI-only. It may not overrule a hard deny, a sensitive path, a
protected instruction/config write, an MCP side effect, a policy author's
explicit ask, or an unmatched scoped allowlist. A malformed response,
upstream error, or timeout abstains; interactive mode then asks a human and
headless mode denies.

### First run without a model

The first-run question is separate from the model picker. The comparison below
only covers what each product does when no default model has been saved yet.

| Product      | First-run behavior                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI    | Completes authentication and directory trust without asking for a model; a catalog default is selected and `/model` remains available later.                                                                                                                                                                                                          |
| Claude Code  | Completes login and directory trust without a model question; the provider's default model is used until `/model` changes it.                                                                                                                                                                                                                         |
| Gemini CLI   | Interactive mode opens an auth selector; headless mode with no auth exits non-zero with setup instructions.                                                                                                                                                                                                                                           |
| OpenCode     | Enables a free hosted catalog when no credential exists, so the CLI is usable without a login; the free model is not a stable product default.                                                                                                                                                                                                        |
| Pi `1.5.2`   | Relies on the configured provider/catalog and its native picker; it does not add a product onboarding policy.                                                                                                                                                                                                                                         |
| **Codepunk** | Shows an explicit model onboarding message and names `/login`, `/model`, and `models import`. If Pi has no active model, ordinary input is blocked. If Pi supplies a host default, that model is usable immediately and the message explains how to persist an explicit default. Print mode exits with the same setup hints if no model is available. |

Codepunk's explicit gate is a deliberate product choice, not a missing host
integration. It avoids silently sending a request through a catalog default
that the user did not choose, while delegating the actual login, catalog, and
picker mechanics to Pi.

## Command ownership

The TUI owns or intercepts a slash command when Pi's behavior would be wrong,
misleading, or incomplete for Codepunk:

| Command                          | Owner                        | Behavior                                                                                                                                                                         |
| -------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/model`                         | Pi, with Codepunk adapter    | Bare command opens Pi's picker. An exact `provider/id` or unique bare ID is resolved by Codepunk and persisted. Partial queries fall through to Pi's fuzzy picker.               |
| `/help`                          | Codepunk                     | Registered command that lists the usable product and Pi surface instead of exposing intercepted builtins as normal commands.                                                     |
| `/permissions`                   | Codepunk                     | Registered command. Shows the profile, current shell, and next-session sandbox; `/permissions why -- <command>` replays the real decision chain without executing it.            |
| `/plan`, `/evidence`, `/budget`  | Codepunk                     | Read the durable plan, evidence head, and token/USD usage from the Codepunk store.                                                                                               |
| `/doctor`, `/policy`             | Codepunk                     | Run product diagnostics or print the effective layered policy and isolation flags.                                                                                               |
| `/sign`                          | Codepunk                     | Record a human sign-off bound to a settled run head.                                                                                                                             |
| `/login`, `/logout`              | Pi                           | Credentials and provider auth stay in the host.                                                                                                                                  |
| `/compact`                       | Pi, checkpointed by Codepunk | Pi owns cutting and summarization. Codepunk records the resulting keeps boundary and persists the restorable branch.                                                             |
| `/thinking`                      | Pi, persisted by Codepunk    | Pi owns the selector and clamping; Codepunk writes the resulting effective level to `config.toml`.                                                                               |
| `/scoped-models`                 | Codepunk                     | Refused with file-backed guidance because Pi's selector would only change in-memory host state in this host.                                                                     |
| `/settings`                      | Codepunk                     | Explain the file-backed Codepunk config and the policy boundary instead of opening Pi settings.                                                                                  |
| `/trust`                         | Codepunk                     | Show the current and saved workspace decision; `grant` and `revoke` write the Pi project trust store under `$CODEPUNK_HOME` for future sessions.                                 |
| `/resume`, `/export`, `/session` | Codepunk                     | `/resume [id\|latest]` rebuilds the host for a Codepunk session in the TUI; `/export` and `/session` operate on the Codepunk session/evidence store, not Pi's in-memory session. |
| `/new`                           | Codepunk                     | Confirms, then creates a new Codepunk session and switches the live TUI host to it.                                                                                              |
| `/fork`, `/clone`, `/tree`       | Codepunk + Pi                | `/fork [entry]` and `/clone` create and switch to a live child product session; `/tree` lists or navigates Pi's branch and records the move in the Codepunk log.                 |
| `/import`, `/share`              | Codepunk refusal             | Pi import/share would bypass the Codepunk evidence and redaction boundary.                                                                                                       |
| `/bug`                           | Codepunk refusal             | Pi's bug report can upload a session transcript; Codepunk points at `/cp-export` for a local redacted transcript instead.                                                        |
| `/reload`                        | Codepunk + Pi                | Re-reads user-scope MCP, restarts its servers, and asks Pi to reload the tool registry and Pi resources; Codepunk config, skills, and plugin inventory stay startup-bound.       |

The `cp-` prefix is not a copy of Pi. It marks a Codepunk-owned command whose
name would otherwise collide with a Pi builtin. Only two commands need it:

| Codepunk command | Why it stays separate from the Pi surface                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/cp-sessions`   | Lists Codepunk product sessions from the durable store. Pi `/session` reports the current host session.          |
| `/cp-export`     | Writes the redacted transcript and manifest; `/export` forwards here because Pi's export bypasses that boundary. |

`/cp-model` was removed as a pure duplicate: `/model <provider/id>` already
resolves, switches, and persists an exact model, and bare `/model` already
lists the catalog through Pi's picker.

`/cp-permissions` was removed as a pure duplicate. `/permissions` remains the
canonical name because it already owns profile, approval, autonomy, sandbox,
rules, reviewer, and network configuration; `/permission` is the singular
compatibility alias.

The TUI wraps Pi's autocomplete provider so unsupported Pi builtins do not
appear as normal choices. Supported session commands (`/resume`, `/new`,
`/fork`, `/clone`, `/tree`) stay visible; `/help` lists the usable surface,
while typing a refused command still produces the product-specific explanation.

Unknown slash commands are rejected in the editor bridge before Pi can treat
them as model input. The accepted set is composed at `session_start` from
`pi.getCommands()` (extensions, prompt templates, and skills) plus Pi's builtin
interactive command table. That table is not exported from the Pi package
root, so Codepunk loads `dist/core/slash-commands.js` from `getPackageDir()`
instead of keeping a copy; if a Pi upgrade moves the module, the session start
fails with the expected path rather than silently rejecting a legal command.

## Gaps after this iteration

These are real gaps, not hidden fallbacks:

1. Live `/resume`, `/new`, `/fork`, `/clone`, and `/tree` now run through Pi's
   session replacement and branch APIs. The remaining branch gap is durability:
   the agent-state snapshot stores the active branch, while sibling branches
   exist only in the in-memory Pi session for the current process. There is no
   queryable cross-session branch graph yet.
2. MCP has user-scope `list/add/remove/test/login/logout/status` and `/mcp`
   over Pi's MCP client; both stdio and Streamable HTTP transports are wired.
   Session startup skips one failed server with a configuration warning, while
   `mcp test` and `doctor` perform real connection checks. OAuth sign-in and
   refresh reuse `pi-mcp/oauth`; credentials live in
   `$CODEPUNK_HOME/mcp-auth.json` with owner-only permissions, and a session
   start never opens a browser. `/reload` swaps MCP servers and tools in place,
   including the model-selection and read-only gates, and records each newly
   started server. Skills and plugins have add/remove, and plugins have
   enable/disable, but their hot reload and TUI-based OAuth management are
   still missing.
3. Approval prompts show action, command/path, reason, exact argv, sandbox
   coverage, a hashed proposed diff, and a redacted MCP argument preview bound
   by SHA-256. They support once/session/persistent exact-action choices plus
   deny-with-guidance. A persistent choice opens a second preview of the exact
   argv, cwd, match scope, and storage before writing anything. If the write
   fails, the call falls back to allow-once, never a session grant. Remote
   approval channels remain unimplemented.
4. The headless protocol is read-only observation, not bidirectional control.
5. Model fallback is implemented through Pi's virtual-model router with a
   pinned chain and a `model/fallback` evidence event. The token/USD budget
   guard consumes assistant usage events plus Pi's session totals and stops the
   session; remaining work is reporting the stop more clearly, not
   reimplementing accounting.
6. `/subagent` runs profile-driven child Pi sessions with up to four
   background handles (`/agents`, `/agents profiles`, `/agents result <id>`,
   `/agents wait <id>`, `/agents stop <id>`); the child product session header
   records the parent id. Pi's `parentSession` path field is not used for this
   link. Without a profile the child is `read`/`search` only and shares the
   parent checkout. A profile that enables `write` or `edit` runs in a
   detached worktree, and `--worktree` can isolate a read-only profile. The
   child is pinned to `sandbox = required`, `filesystem = workspace`, and
   either `approval = deny` for read-only work or `approval = allow` with
   `autonomy = ask` for a mutating profile, regardless of the parent's
   persisted config. An explicit parent trust decision is inherited in both
   directions; a worktree child receives the parent's decision because it is
   created from the same base commit. The child does not inherit the parent's
   scoped rules or full filesystem. A child worktree is preserved for
   inspection and is never merged automatically. Streamed child output is
   still missing.
7. Session surfaces are live: `/resume` and `/new` rebuild the TUI host,
   `/fork` and `/clone` create child product sessions, `/tree` navigates the
   Pi branch, `/export` forwards to `/cp-export`, and the aliases do not appear
   in help.
8. Pi 1.5.2 emits OSC 7501 program status through its interactive runtime, and
   Codepunk keeps that path enabled. The status app identity still comes from
   Pi's `APP_NAME`, and Codepunk adds no per-event desktop notifications, so a
   fully product-branded external status surface is still missing.
9. `auto` now has a deliberately narrow optional reviewer for network and
   headless `exec` asks. It is off by default and cannot overrule human-only
   classes. There is still no per-category toggle such as "never prompt for
   ordinary shell but always prompt for MCP"; the named profiles remain
   coarse-grained presets over the four permission axes.
10. Workspace trust is still all-or-nothing across project config, policy,
    skills, and instructions. `--no-skills`, `--no-plugins`, `--no-mcp`, and
    the aggregate `--bare` switch provide a one-session escape hatch, but
    they are not a per-resource trust decision. Codex keeps skills loading
    while disabling project config; Claude's `--bare` keeps skills; Gemini
    shows a discovery list before the decision. Codepunk now shows a bounded
    type, size, and digest preview before the decision, but still lacks
    per-resource choices such as "trust instructions but skip project config".
11. Subagents use a declared tool mask rather than a privilege ladder. A
    profile can enable read/search/write/edit, but cannot express "inherit my
    mode, but never exceed `standard`". Claude resolves child modes against a
    ladder; Codex carries a per-agent sandbox policy. Codepunk keeps the
    profile declaration inside the child process policy instead of treating
    the profile as authority.
12. The five named profiles carry no network dimension. `network_allow` and
    `network_deny` are independent user-scope lists, so switching
    `--permission-mode` never changes egress. Codex folds network into
    `permissions.network`; Codepunk keeps it as a separate operator setting
    until a profile-level network choice is designed.
13. Delivery worktrees, the worker pool, and swarm policy are library-level
    only: there is no `codepunk work` command, so no user path creates a
    worker or merges its worktree. `WorkerSandbox` now accepts
    `networkAllow`/`networkDeny` and defaults to deny-all, but nothing reads
    the config for it yet. Either wire the surface or stop presenting
    worktree isolation as a user capability; `docs/COMPARISON.md` says which
    one it currently is.

## Boundary audit results

The Pi 1.5.2 integration was re-audited against the installed host source after
the first architecture pass. The audit looked for places where a host failure
would be recorded as a product success, or where Codepunk kept a second copy of
host state. The current status of each finding is:

| Finding                                                                  | Status | Current guard                                                                                                                                  |
| ------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi could discover `SYSTEM.md` outside the Codepunk context authority     | Closed | `systemPrompt: ""` suppresses discovery, `assertHostResources` rejects any discovered source, and a host test uses sentinel files.             |
| Pi's extension runner could swallow a product handler failure            | Closed | `bindExtensions({ onError })` records the failure; `before_agent_start`, `input`, `tool_call`, and `transformContext` fail closed.             |
| Resume could restore a Pi branch older than the append-only event log    | Closed | `SessionStore.resume()` rejects any nonzero `uncommittedEvents` instead of silently discarding the crash window.                               |
| A failed or cancelled tool call was recorded as `decision: "allow"`      | Closed | Evidence now carries `outcome: completed/failed/cancelled/denied`; verdict treats failed and cancelled records as incomplete.                  |
| Artifact truncation replaced image or multi-block tool results with text | Closed | Bounded output replaces text blocks only; non-text content and other structured fields survive.                                                |
| The host and the startup model resolver used different `ModelRuntime`s   | Closed | `createRuntime` creates one runtime, passes it through model/fallback resolution, and hands the same instance to `createAgentSessionServices`. |
| An invalid configured model left a header-only session behind            | Closed | Model resolution happens before `openSession`; print mode now fails before writing a session.                                                  |

The plugin boundary remains intentionally separate: enabled plugins are trusted
in-process code and can call host filesystem or process APIs without passing
through the tool wrapper. Plugin use stays opt-in, and the TUI reports that
boundary instead of claiming all actions are policy-covered.

## Next order

The next work should follow the trust boundary, not the feature count:

1. Extend the `/reload` path to plugins, skills, and Codepunk configuration
   with the same policy gate as runtime use. MCP hot reload and OAuth sign-in
   already exist.
2. Make session identity first-class: one visible command name per surface,
   and a fork flow with explicit parent-child evidence links.
3. Extend the child-session path with streamed output and an explicit
   worktree cleanup/handoff command, then a bidirectional protocol and
   out-of-terminal status signals.

## Local evidence

The current iteration was checked with:

```text
pnpm run verify
# 531 tests, 531 pass
# repository check: 479 files, 3 packages
```

The permission boundary has execution-level coverage rather than only
`permissions why` output: `tests/permission-modes.test.mjs` runs real wrapped
commands for read-only, standard allow/deny, auto, auto-approve, and
full-access. Two PTY tests start real `srt` sessions and prove that a writable
profile cannot switch into read-only and a read-only profile cannot widen, so
the UI cannot claim an OS grant that the sandbox did not make.
Four PTY tests cover the session lifecycle end to end: live `/resume`,
in-place `/new`, `/tree` navigation followed by `/fork`, and Enter during a
streaming turn recorded as steering.
`tests/isolation.test.mjs` separately proves that `--no-skills` suppresses
skill discovery, `--no-plugins` prevents user plugin code from executing, and
`--bare` removes instructions, skills, plugins, MCP startup, and memory in one
session. `tests/child-host.test.mjs` also uses a positive control to prove that
a read-only subagent inherits `--bare`, so neither trusted project
instructions nor user skill metadata reach the child model.

The repository root check was also exercised against a concurrent `pnpm pack`.
Pnpm creates `_tmp_<pid>_<hash>` in the repository root and removes it again;
the checker waits for that transient entry to settle and ignores it during the
tree scan, then re-runs the root-entry check. A persistent directory with the
same shape still fails with `repo.root`, and both directions are covered in
`tests/repository.test.mjs`.

The model path was exercised through a real PTY: `/model <partial>` opened
Pi's fuzzy selector without the old usage warning, exact selection persisted,
a picker Enter stayed session-only, and `Ctrl+S` persisted the default.
Fallback registration was separately checked: when no fallback is configured,
Pi's picker does not list the virtual route, and `codepunk/auto` cannot be
saved as the default through the exact-selection path. The
automatic-retry path is covered in both directions: a transient failure that
recovers and an exhausted retry. Both assert `model/retry_start` /
`model/retry_end`, the original error hash, the redacted 512-character
preview, and the absence of the planted secret from session events. The
repository check also rejects loose `auth.json` and `models-store.json` files
at the repository root; those are runtime state, not product source.

Manual compaction is exercised through Pi's real `compact()` path. The test
checks the `compaction/decision` checkpoint fields, the summary hash, the
persisted `agent-state.json`, and a reopen that restores the same compaction
entry and kept boundary. Automatic overflow compaction and compact-and-retry
cover the separate automatic path.

The model PTY test also selects a thinking level through Pi, then reads the
effective value from `config.toml`. `/scoped-models` is separately checked to
show file-backed guidance rather than Pi's in-memory "saved" message.

The read-only child confinement claim was run as a negative control: with the
pinned `--sandbox required --filesystem workspace --autonomy read-only` flags
removed, the child reads a file above the workspace and the test fails; with
them restored it passes and the file body never reaches the model. A real
gateway request (`codepunk --trust -p ...`) also completes with the product
system section in place.

The first-run PTY starts with an empty `CODEPUNK_HOME`, checks that `/model`
reports no authenticated models without the old Pi-only warning, and checks
that ordinary input is gated when no active model exists. Print mode with the
same empty home exits `1` and prints `codepunk models import` and
`codepunk models set`. `/help` is covered separately, and the autocomplete
wrapper is tested to hide intercepted builtins. A legacy session whose Pi
header used a generated UUID resumes by migrating that header id to the
Codepunk session id; an arbitrary mismatched header id is still rejected.
