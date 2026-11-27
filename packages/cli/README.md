# codepunk-cli

Local-first, supervised coding agent for your terminal — with OS-level shell sandboxing, exact-action approvals, workspace trust boundaries, and hash-chained execution evidence.

## Requirements

- **Node.js `>=22.19.0`**
- **Supported platforms**: macOS (arm64 / x64) and Ubuntu 24.04+ (x64 / arm64)
  - On Linux, install sandbox prerequisites first: `sudo apt-get install -y bubblewrap socat ripgrep`
  - Windows 11 x64 is currently **experimental / unverified** (fail-closed until real-machine acceptance completes).

## Quick Start

Install globally from npm:

```bash
npm install -g codepunk-cli
```

Configure a model provider (interactive wizard or one-line setup):

```bash
# Guided interactive setup (Anthropic, OpenAI, Google, DeepSeek, OpenRouter, or custom endpoint)
codepunk setup

# Or non-interactive one-liner
codepunk setup --provider anthropic --api-key "$ANTHROPIC_API_KEY"
```

Verify your environment and launch the interactive TUI:

```bash
codepunk doctor
codepunk
```

Or run a single-shot read-only print query:

```bash
codepunk -p "Summarize the architecture of this repository"
codepunk -p --json-schema '{"type":"object","required":["summary"],"properties":{"summary":{"type":"string"}}}' "Summarize this repo as JSON"
```

## Everyday Shortcuts & Commands

| Shortcut / Command         | What it does                                                          |
| -------------------------- | --------------------------------------------------------------------- |
| `Alt+K`                    | Open the non-blocking fuzzy command palette                           |
| `Alt+M`                    | Cycle work mode (`plan` → `standard` → `auto` → `auto-approve`)       |
| `Alt+T` / `/tasks`         | Open the unified interactive task & subagent center                   |
| `Alt+R` / `/rewind`        | Rewind file checkpoints or switch session branches                    |
| `Alt+G` / `/editor`        | Compose or edit the prompt in `$VISUAL` / `$EDITOR`                   |
| `/copy [last\|<n>\|code]`  | Copy latest assistant reply or fenced code block (native + OSC 52)    |
| `F1` / `/help [query]`     | Open the searchable, scrollable command browser                       |
| `F2` / `/models`           | Cycle recent models or pick from favorites                            |
| `Shift+Tab`                | Cycle model reasoning/thinking level                                  |
| `/permissions [insights]`  | Interactive permission menu and local approval/denial insights        |
| `/settings`                | Interactive TUI & compaction preferences (persisted to `config.toml`) |
| `/diff` / `/commit`        | Scrollable colored diff viewer and human-gated Git commit             |
| `/attest [copy]`           | Generate or copy a PR-ready Markdown verification summary             |
| `/resume`                  | Live fuzzy-searchable session picker                                  |
| `/plan [request\|approve]` | Read-only planning mode and unified plan lifecycle controls           |
| `/review`                  | Structured diff-bound code review findings                            |
| `/image --clipboard`       | Attach clipboard screenshots (or drag-and-drop workspace image paths) |

## Security & Supervision Model

- **OS Shell Sandboxing (`srt`)**: Shell commands run confined to the workspace with network egress denied by default (`sandbox.network_allow` / `sandbox.network_deny`).
- **Exact Approvals**: Interactive approval cards (`a` once / `s` session / `p` persistent / `d` deny / `g` deny with guidance) bind to exact commands or file paths — never opaque wildcard allows.
- **Per-Resource Workspace Trust**: Project config, policy, skills, and instruction files (`AGENTS.md` / `CLAUDE.md`) require explicit checkout-scoped trust before loading.
- **Tamper-Evident Logs & Checkpoints**: Every tool call writes hash-chained evidence; file writes/edits record per-session snapshots for safe `/undo` and `/rewind`.
- **Optional Web Search Backends**: `web_search` respects `sandbox.network_deny` and refuses private hosts; set `TAVILY_API_KEY`, `BRAVE_API_KEY`, or `CODEPUNK_SEARCH_ENDPOINT` for dedicated search APIs.

## Uninstall

```bash
codepunk uninstall
```

Uninstalling removes the CLI package while preserving your local sessions, config, credentials, and evidence under `~/.codepunk`.

## Links

- Source & full documentation: <https://github.com/leoxstar/codepunk>
- Security policy & advisory disclosures: see `SECURITY.md` and `CHANGELOG.md` in the repository.
