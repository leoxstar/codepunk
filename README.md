# Codepunk

Local-first, supervised coding agent for teams.

Codepunk keeps the model, tool execution, approvals, and evidence on the local
machine. It provides an interactive terminal UI and a headless surface, with an
explicit policy boundary around file and shell actions.

## Highlights

- **Interactive TUI & headless surfaces**: Full terminal UI (`Alt+K` command
  palette, `Alt+M` work-mode cycle, `Alt+T` `/tasks` center, `Alt+R` `/rewind`
  picker, `Alt+G` `/editor`, `/copy`, `F1` searchable help, `F2` recent models,
  async non-blocking MCP startup), plus print/JSON modes, `--json-schema`
  output enforcement, and standard `codepunk acp` stdio integration.
- **Explicit safety boundaries**: Per-resource workspace trust (`config`,
  `policy`, `skills`, `instructions`), four-axis permission profiles
  (`read-only`, `standard`, `auto`, `auto-approve`, `full-access`), scoped
  exact-argv allowlists, `srt` OS shell sandboxing, session taint escalation
  after `web_fetch`/`web_search`, and isolated `plugin.toml` subprocess plugins.
- **Verifiable delivery & recovery**: Hash-chained append-only evidence
  (`codepunk attest` / `/attest`), file checkpoints (`/undo`, `/redo`) and
  Shadow Git atomic worktree snapshots (`/rewind shadow`), Codepunk-owned
  sessions (`/resume`, `/new`, `/fork`, `/clone`, `/tree`), backup/restore,
  and worktree-isolated subagents with human review and merge gates
  (`/agents review`, `/agents sign`, `/agents merge`, `/agents discard`,
  `/agents transcript`).

For exhaustive command flags, permission axis rules, background tasks, image
handling, and MCP/OAuth details, see [`docs/CLI_REFERENCE.md`](docs/CLI_REFERENCE.md).

## Install

Codepunk is published to the public npm registry as a single unified CLI
package (`codepunk-cli`, bundling internal `codepunk-protocol` and
`codepunk-core` plus the isolated plugin child runner):

```text
npm install -g codepunk-cli
```

Build and run from a local checkout:

```text
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
node packages/cli/dist/index.js --help
```

## Requirements & Platform Support

- Node.js `>=22.19.0`
- pnpm `12.18.0`
- macOS (Apple Silicon and Intel), Linux (Ubuntu 24.04/26.04 x64/arm64), or
  Windows 10 22H2 (build 19045+) x64 / Windows 11 x64

CI runners: `ubuntu-24.04`, `ubuntu-24.04-arm`, `ubuntu-26.04`, `macos-15`, `macos-15-intel`, `macos-26`, `windows-latest`.

Windows ARM64 is not supported. WSL2 Ubuntu x64 is manual-smoke only and is not
CI-covered. Hosted `windows-latest` (Windows Server 2025) covers non-privileged
CI checks and is not a substitute for real-machine Windows 10/11 verification.
See [`docs/PLATFORMS.md`](docs/PLATFORMS.md) for the exact support matrix.

## Quick start

Configure a provider and default model:

```text
codepunk setup
# or non-interactively:
codepunk setup --provider anthropic --api-key "$ANTHROPIC_API_KEY"
```

Start the interactive TUI or check your environment:

```text
codepunk
codepunk doctor
```

If no model is configured yet, the TUI opens an interactive setup menu for
direct API-key entry, OAuth `/login`, or `/model` selection. Custom
OpenAI-compatible endpoints can be imported with `codepunk models import`; see
[`docs/MODELS.md`](docs/MODELS.md).

## Core Workflows

| Workflow         | Entry points                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| Trust & config   | `codepunk trust [status\|grant\|revoke]`, `codepunk config`, `/trust`, `/settings`                        |
| Permissions      | `codepunk permissions [profile\|rules\|insights\|why]`, `/permissions`                                    |
| Goals & review   | `/goal`, `/review`, `/diff`, `/hooks status`, `/commit`                                                   |
| Sessions & undo  | `codepunk resume`, `/resume`, `/new`, `/fork`, `/tree`, `/undo`, `/redo`, `/rewind`                       |
| Subagents        | `/subagent`, `/agents review`, `/agents sign`, `/agents merge`, `/agents discard`, `/agents transcript`   |
| Extensions & MCP | `codepunk capabilities`, `codepunk mcp`, `codepunk skills`, `codepunk plugins add <file\|dir>`, `/reload` |
| Headless & CI    | `codepunk -p`, `--mode json`, `--json-schema`, `codepunk attest`, `codepunk acp`                          |

## Development

```text
corepack enable
corepack prepare pnpm@12.18.0 --activate
pnpm install --frozen-lockfile --ignore-scripts
pnpm run verify
pnpm run eval
```

Fast local check tiers:

```text
pnpm run format:check
pnpm run lint
pnpm run check
pnpm run typecheck
pnpm run test:unit
pnpm run test:pty
pnpm run test:compat
pnpm run test:repo
```

Package scripts, catalog dependency pins, ESLint/Prettier setup, CI contracts,
and testing conventions are documented in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Packages

| Package             | Responsibility                                                                  |
| ------------------- | ------------------------------------------------------------------------------- |
| `codepunk-protocol` | Private workspace package: boundary schemas, record shapes, shared constants    |
| `codepunk-core`     | Private workspace package: engine, host adapter, policy, sandbox, and evidence  |
| `codepunk-cli`      | Published npm package: terminal surface, bundled runtime, approvals, exit codes |

The dependency direction is `codepunk-protocol <- codepunk-core <- codepunk-cli`.

## Documentation

- [`docs/CLI_REFERENCE.md`](docs/CLI_REFERENCE.md) — full command, permissions, trust, subagent, and MCP reference
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) & [`docs/AGENT-ARCHITECTURE.md`](docs/AGENT-ARCHITECTURE.md)
- [`docs/MODELS.md`](docs/MODELS.md) — model providers, fallbacks, and auth storage
- [`docs/PLATFORMS.md`](docs/PLATFORMS.md) — OS and CI runner support boundary
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — toolchain, checks, and contributor workflow
- [`docs/RELEASING.md`](docs/RELEASING.md) — single-package npm release and verification runbook
- [`docs/MEMORY.md`](docs/MEMORY.md), [`docs/DELIVERY.md`](docs/DELIVERY.md), [`docs/PROTOCOL.md`](docs/PROTOCOL.md), [`docs/SKILLS-MCP.md`](docs/SKILLS-MCP.md), [`docs/SWARM.md`](docs/SWARM.md), [`docs/WORKERS.md`](docs/WORKERS.md), [`docs/COMPARISON.md`](docs/COMPARISON.md)

## License

MIT
