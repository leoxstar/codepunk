# Changelog

All notable changes to Codepunk are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2]

### Added

- Captured the `0.1.1` single-package compatibility corpus
  (`tests/fixtures/compat/0.1.1/`, 20 files + `MANIFEST.json`) and generalized
  `checkCompatCorpus` / `tests/compat.test.mjs` to validate every versioned
  corpus directory (D81).
- Added ESLint 10 Flat Config (`eslint.config.mjs`) with type-aware
  `typescript-eslint` and `eslint-plugin-import-x` rules (`pnpm run lint`),
  wired into `pnpm run verify`, `ci.yml`, and `full-ci.yml` (D84).
- Added `.node-version` (`22.19.0`), `scripts/bump-version.mjs`,
  `packages/cli/build.mjs`, `tsconfig.base.json` (TypeScript Project
  References), tiered test scripts (`test:unit`, `test:pty`, `test:compat`,
  `test:repo`, `test:coverage`) with `--test-timeout=300000`, composite
  `.github/actions/setup`, tag-triggered `.github/workflows/release.yml`,
  `.editorconfig`, `CODEOWNERS`, `dependabot.yml`, PR/issue templates, and
  `docs/CLI_REFERENCE.md`.

### Changed

- Centralized product constants, schema versions, environment variable names,
  state filenames, and exit codes in `packages/protocol/src/constants.ts`, and
  injected `__CODEPUNK_VERSION__` / `__SRT_VERSION__` / `__BUILD_COMMIT__` via
  `packages/core/src/build-meta.ts` to eliminate scattered hardcoded version
  literals (D84).
- Migrated shared dependency pins to exact-pinned `pnpm-workspace.yaml`
  `catalog:` entries and `"workspace:*"` internal links; modularized
  `scripts/check-repo.mjs` into `scripts/checks/*.mjs` with structural CI,
  lockfile, and control-corpus checks (D84).
- Split monolithic `tests/tui.test.mjs` into `tests/support/tui-pty.mjs` and
  four focused suites (`tui-unit`, `tui-pty-core`, `tui-pty-trust`,
  `tui-pty-workflow`), upgraded GitHub Actions workflows to Node 24 actions
  (`actions/checkout@v7`, `actions/setup-node@v7`, `pnpm/action-setup@v6`),
  and streamlined root `README.md` by moving exhaustive command details to
  `docs/CLI_REFERENCE.md`.

### Fixed

- **W-01**: `codepunk backup restore` and its rollback path now clear read-only
  file attributes before replacing targets (such as Windows Shadow Git objects)
  and remove temporary `*.restore-*` files cleanly.
- **W-02**: `createRuntime` now cleans up startup resources on stale-session
  resume errors so `codepunk -p --session <stale-id>` exits promptly instead of
  hanging, and `DeferredSandbox.close()` deduplicates concurrent close calls.
- **W-03**: Mapped `memory_search` tool results in the Pi adapter to the
  `memory/retrieve` event schema (`ids`, `hashes`, `truncated`,
  `digest_sha256`).
- **W-04**: Serialized TUI session transitions (`/new`, `/resume`, `/fork`,
  `/clone`) and bound deferred MCP reloads to live command context, eliminating
  first-command `stale ctx` errors after session replacement.
- **W-05**: Unified `state-version.json` initialization before creating runtime
  or trust state directories and narrowed legacy home markers so fresh
  print-only homes no longer trigger false `migrate --check` warnings (D83).
- **W-06**: Extended `codepunk plugins add` and `plugins remove` to install and
  remove `plugin.toml` manifest directories with symlink, escape, NUL, and size
  validation.
- **W-07**: Intercepted built-in `/copy` in `handlePiSlashCommand` instead of
  registering a conflicting extension command.
- **W-08**: Reported an explicit platform limitation for `/btw` on Windows
  without falling back to a foreground blocking turn.
- **W-09**: Improved scoped rule rejection messages with actionable executable
  resolution guidance for Windows built-ins and interpreters.
- **W-10**: Skipped writing empty or placeholder (`NONE`) automatic session
  summaries to memory.
- **W-11**: Resolved linked worktree `.git` pointer files (`gitdir` and
  `commondir`) in `srtProfile` `denyWrite` rules so `-w` worktrees no longer
  emit `srt-win` `.git exists as a FILE` partial warnings.
- **W-12**: `doctor` now accepts Windows 10 22H2 (build 19045+) x64 with the
  same platform boundary as Windows 11 x64. Builds below 19045 and Windows
  ARM64 remain rejected, and an unprovisioned `srt` sandbox remains blocking.
- Fixed 8 Windows `full-ci` test failures (path normalization, CRLF handling,
  and shell quoting) and hardened Windows ConPTY process-tree and HTTP mock
  server teardown.

### Security

- Retains the documented accepted risk for `GHSA-mrhx-c7xc-m3w5`
  (`zod@3.25.76` `<4.6.6` via pinned Pi and `@anthropic-ai/sandbox-runtime`
  transitive dependencies) pending an upstream compatible release.

## [0.1.1]

### Added

- Headless `--json-schema <schema-or-file>` output contract gate for print mode
  (validating assistant JSON before emitting canonical `stdout` and exiting `1`
  with JSON-Path diagnostics on `stderr` when violated), `codepunk attest
[session-id] [--output path] [--json]` and TUI `/attest [copy]` PR-ready
  verification summaries, and local zero-LLM `codepunk permissions insights
[--json]` / `/permissions insights` diagnostics.
- Dynamic session-level taint escalation after `web_fetch`/`web_search`
  ingestion (skipping model auto-review and requiring human approval for
  non-read-only shell and MCP calls), exact `(cwd, command)` session-grant reuse
  for complex shell pipelines, and test-runner passing-line output folding that
  preserves bottom failures and raw evidence SHA-256 digests.
- TUI daily-ergonomics upgrades: non-blocking direct overlay dispatch in the
  `Alt+K` command palette, `/copy [last|<n>|code [n]]` (native clipboard plus
  SSH OSC 52 fallback), `/editor [--reply]` (`Alt+G`) external prompt composition
  with `$VISUAL`/`$EDITOR` validation, unified `/plan [status|on|approve|off]`
  lifecycle actions, and a delayed terminal attention bell (`CODEPUNK_NO_BELL=1`
  opt-out) for pending approvals and user questions.
- `codepunk setup` guided provider/API-key/model onboarding wizard (interactive
  TTY picker with masked key entry, ambient credential detection, and
  one-command `--provider` / `--base-url` non-interactive mode), plus direct
  in-TUI API-key configuration when starting without a model.
- Built-in `ask_user` structured question tool (`QuestionCard`), controlled
  depth-1 read-only `subagent` tool, and hardened `web_search` tool (enforcing
  `sandbox.network_deny`, private-host SSRF blocks, manual redirect checking,
  bounded streaming reads, bot-challenge detection, and `TAVILY_API_KEY` /
  `BRAVE_API_KEY` / `CODEPUNK_SEARCH_ENDPOINT` backends).
- `web_fetch` tool: model-initiated HTTP GET through an approval-gated,
  in-process path that enforces the sandbox `network_deny` domain list and
  refuses private, loopback, and link-local hosts. Every call opens an
  approval card that names the exact URL; approving grants only that call.
- Zero-execution post-write syntax diagnostics for `.json`, `.toml`,
  `.ts`/`.tsx`/`.mts`/`.cts`, and `.js`/`.mjs`/`.cjs`, plus `L<line>:<hash4>`
  anchor hints when `edit` matching fails.
- Interactive TUI upgrades: scrollable `Panel`/`TableScreen`/`DiffView` with
  colored diffs and `.codepunk/` internal untracked file folding, compact
  4-group `/status`, live fuzzy `SessionPicker` (`/resume`), unified
  `TaskCenter` (`/tasks`, `Alt+T`), interactive `RewindPicker` (`/rewind`,
  `Alt+R`), searchable `HelpBrowser` (`F1` / `/help [query]`), work-mode cycle
  (`Alt+M`), Plan/Todo progress widget, interactive `/settings` menu with
  persistent `config.toml` preferences, `/image --clipboard|paste` and
  drag-and-drop workspace image path attachment, live statusline context gauge
  (`ctx XX%`), and custom tool renderers for `web_fetch`, `web_search`,
  `ask_user`, `subagent`, and `memory_search`.
- `/plan <request>` enters read-only plan mode and submits the request as a
  planning round; `/plan` without arguments still shows the recorded plan.
- Terminal-safe crash guards that restore raw mode/cursor and run bounded
  runtime cleanup on unexpected fatal errors, plus platform-specific `doctor`
  remediation hints and `uninstall` local-state preservation notices.
- `codepunk "prompt"` interactive initial-prompt handoff, combined piped
  stdin + positional print prompts (`git diff | codepunk -p "review"`), and
  `codepunk upgrade --check [--json]` offline-safe version checking.
- Interactive `/mcp` management overlay (`McpPanel`) with single-key add,
  reload, status, login, logout, and remove actions (while `/mcp list` retains
  plain-text output).
- Parallel read-only `subagent` batch execution (up to 4 tasks in one tool
  call) wired into TUI `state.subagents` and `/tasks` visibility.
- Enhanced `edit` tool with unique indentation-preserving fallback and unified
  diff preview/anchor hints across `edits[]`, enhanced `read` tool with
  zero-dependency top-level symbol outlines (`[file outline]`) on large code
  files read without `offset`/`limit`, and 20 deterministic coding-loop cases in
  `eval/` (20/20 passing).
- Single-call human-approved `unsandboxed_once` shell escape in trusted
  interactive workspaces (enforced in both `TuiApprovalChannel` and
  `ApprovalBroker` with `[policy, unsandboxed-once]` evidence), `sandbox.user_bash`
  host-direct option, TUI `/stash` (`Alt+S`) draft stashing, and `/learn`
  session rule distillation.
- Shadow Git atomic worktree snapshots (`ShadowGitStore` + `/rewind shadow`)
  covering `write`, `edit`, and `bash` worktree mutations without touching the
  project `.git` history, plus zero-dependency read-only `lsp_query`
  (`definitions`, `references`, `diagnostics`, `outline`).
- Standard Agent Client Protocol (`codepunk acp`) wire support (`initialize`,
  `session/new`, `session/load`, content-block `session/prompt`,
  `session/update`, `session/cancel`), `codepunk --worktree [name]` (`-w`)
  isolated branch/worktree launch, OS keychain credential store
  (`model.credential_store = "file" | "keychain" | "auto"`, `codepunk models
auth`), `codepunk doctor` `policy` v1/v2 self-check diagnostics, and
  isolated subprocess `PluginHost` (`plugin.toml`) bidirectional product-tool
  bridging with `plugin/started`, `plugin/tool_call`, and `plugin/stopped`
  session events.

### Changed

- Consolidated public npm distribution into the single `codepunk-cli` package
  (inlining `codepunk-protocol` and `codepunk-core` into `dist/index.js` and
  shipping `dist/host-child.js` for isolated plugins); `codepunk-protocol` and
  `codepunk-core` are now `"private": true` workspace packages and their `0.1.0`
  npm artifacts are superseded.
- Expanded read-only shell pipeline auto-allow filters (`sort`, `uniq`, `cut`,
  `tr`, `nl`, `fd`, `basename`, `dirname`) with strict mutation-flag and
  workspace read-target guards.
- Split all 8 oversized `packages/core/src/` monoliths (`model`, `policy`,
  `config`, `wrap`, `sandbox`, `mcp`, `adapters/pi`, `runtime`) into cohesive
  internal submodules behind each module's `index.ts` barrel and added a
  `1,500`-line `[core.size]` repository check gate with zero public API changes.

- Non-blocking async MCP startup in TUI (`deferMcp`) so the first interactive
  frame renders immediately while MCP connects in the background and hot-reloads
  tools upon readiness.
- The TUI now uses Pi's built-in cwd/model/context footer plus one compact
  Codepunk status line. `tui.statusline` defaults to `policy`, adding `budget`
  only when a limit is configured; the duplicated startup status block is gone.
- Removed remaining user-visible host branding leaks across model setup and
  command messages, and expanded `packages/cli/README.md` for npm users.

### Fixed

- `srt` sandbox profiles now permit normal `git add` and `git commit` inside
  writable workspaces while continuing to deny `.git/config`, `.git/hooks`,
  `.git/info`, and `.git/objects/info|pack`, and now add POSIX user home secret
  directories (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`) to
  `denyRead` when outside workspace roots.
- `/agents merge` now supports three-way merges (`allowTargetAdvance`) when the
  parent `HEAD` advanced cleanly on non-conflicting files while a worktree
  subagent ran in parallel, re-checking `write_set` and `protected_paths`
  against the merged diff.
- Default read-only headless print mode excludes `web_search` unless granted via
  `--headless-policy`, keeping the headless read-only tool surface minimal.

## [0.1.0]

> Superseded by single-package `codepunk-cli@0.1.1`.

### Added

- First public npm release of the Codepunk protocol, core, and CLI packages,
  published as `codepunk-protocol`, `codepunk-core`, and `codepunk-cli` at
  `0.1.0`.

### Fixed

- Fresh or empty `CODEPUNK_HOME` directories, including symlinks to empty
  directories, initialize the current state version instead of reporting a
  pending migration.
- CLI help lists the implemented reviewer show/timeout commands and the trust
  resource-grant flag.
- The published CLI shim resolves from `dist/index.js` under npm 11.

### Security

- Documented the accepted risk for `GHSA-mrhx-c7xc-m3w5`, which affects
  versions `<4.6.6` across 17 transitive dependency paths. Remove this entry
  only after every affected path resolves to a supported version at or above
  `4.6.6` and a fresh audit confirms that the advisory no longer applies.
