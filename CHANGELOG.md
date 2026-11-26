# Changelog

All notable changes to Codepunk are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
  files read without `offset`/`limit`, and 5 deterministic coding-loop cases in
  `eval/` (17/17 passing).

### Changed

- Expanded read-only shell pipeline auto-allow filters (`sort`, `uniq`, `cut`,
  `tr`, `nl`, `fd`, `basename`, `dirname`) with strict mutation-flag and
  workspace read-target guards.
- Split the 6 largest `packages/core/src/` monoliths (`model`, `policy`,
  `config`, `wrap`, `adapters/pi`, `runtime`) into cohesive internal submodules
  behind each module's `index.ts` barrel with zero public API changes.

- Non-blocking async MCP startup in TUI (`deferMcp`) so the first interactive
  frame renders immediately while MCP connects in the background and hot-reloads
  tools upon readiness.
- The TUI now uses Pi's built-in cwd/model/context footer plus one compact
  Codepunk status line. `tui.statusline` defaults to `policy`, adding `budget`
  only when a limit is configured; the duplicated startup status block is gone.
- Removed remaining user-visible host branding leaks across model setup and
  command messages, and expanded `packages/cli/README.md` for npm users.

### Fixed

- Default read-only headless print mode excludes `web_search` unless granted via
  `--headless-policy`, keeping the headless read-only tool surface minimal.

## [0.1.0]

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
