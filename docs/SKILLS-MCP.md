# Skills and MCP

Skills and MCP servers extend the model context and tool surface, but they do
not extend authority. Both are loaded at runtime startup and every tool call
still passes through the codepunk policy gate, approval broker, and evidence
ledger.

## Skills

Skills are discovered with Pi's recursive `loadSkillsFromDir`. The supported
locations are:

- user scope: `$CODEPUNK_HOME/skills/**/SKILL.md`;
- project scope: `<delivery-root>/.codepunk/skills/**/SKILL.md`.

A nested directory is allowed as long as the immediate parent directory name
matches the `name` frontmatter field and matches
`[a-z0-9][a-z0-9-]{0,63}`. Skill files must be regular files, stay inside their
scope root, contain no NUL bytes, and be at most 32 KiB.

A project skill with the same name replaces the user skill. Duplicate names
inside one scope are refused with a warning instead of becoming
order-dependent.

After Pi discovers the files, Codepunk rechecks the resolved path, rejects
symlinked roots or path components, and recomputes the content hash before
accepting a skill. Loaded skills are inserted as reference data inside an
`<untrusted_skills>` block. The block states that skills cannot change policy,
approval mode, available tools, write sets, or sandbox coverage. Text in a
skill that claims otherwise is model input, not configuration.

Skills with `disable-model-invocation: true` are omitted from that prompt block
and can only be invoked explicitly with `/skill:<name>`. Model-invocable skills
are listed by name, description, and file location through Pi's
`formatSkillsForPrompt`. The body is loaded with the read tool only when the
task matches, so the prompt does not grow with every skill's full text.

The runtime records `skill/loaded` with each skill's name, scope, content hash,
and byte count. Rejected skills are reported as warnings and are not loaded.

## MCP

The only supported MCP configuration is the user-scope file
`$CODEPUNK_HOME/mcp.toml`:

```toml
[servers.echo]
command = "node"
args = ["/absolute/path/to/server.mjs"]
cwd = "."

[servers.echo.env]
EXAMPLE = "value"

[servers.remote]
url = "https://example.invalid/mcp"

[servers.remote.headers]
Authorization = "Bearer ${MCP_TOKEN}"
```

An HTTP server without an `Authorization` header uses OAuth instead. The
optional settings mirror Pi's shared `McpOAuthConfig`:

```toml
[servers.remote]
url = "https://example.invalid/mcp"

[servers.remote.oauth]
scope = "mcp.read"
# clientId = "pre-registered-client"
# clientSecret = "${MCP_CLIENT_SECRET}"
# callbackPort = 43123
# callbackUrl = "http://127.0.0.1:43123/callback"
# clientName = "Codepunk"
# clientRegistration = "auto" # or "dcr"
# authServerMetadataUrl = "https://auth.example.invalid/.well-known/oauth-authorization-server"
```

`clientSecret` supports `${ENV}` expansion only. A `!command` value is
rejected rather than executed. `clientRegistration = "cimd"` is rejected
because Codepunk publishes no Client ID Metadata Document; use `auto` or
`dcr`. A server cannot combine an `Authorization` header with an `oauth`
block.

For a stdio server, `cwd` is resolved from the delivery root and must stay
inside it. For a remote server, `url` selects Streamable HTTP and `headers`
carries authentication; `command`, `cwd`, and `env` are rejected for that
transport. Each configured server must answer `initialize`, `tools/list`, and
`tools/call` within 15 seconds.

MCP transport and JSON-RPC framing come from `@earendil-works/pi-mcp` through
`McpClient`, `StdioTransport`, and `StreamableHttpTransport`. Codepunk does not
implement its own MCP protocol client. It owns the user-scope configuration
file, server-name validation, `cwd` containment, header/environment-reference
expansion, policy/approval wrapping, and evidence. Tool names and input schemas
use Pi's `createMcpToolName` and `normalizeMcpInputSchema`; this covers
sanitization, the 64-character provider limit, collision hashing, and object
schemas that omit `type` or `properties`.

Environment values may reference process variables as `${NAME}`. Unset
variables fail the whole MCP startup with the missing names instead of passing
an empty secret to the server.

Manage the user-scope file without editing TOML by hand:

```text
codepunk mcp list [--json]
codepunk mcp add echo --cwd . --env API_KEY='${API_KEY}' -- node server.mjs
codepunk mcp add echo --force -- node replacement.mjs
codepunk mcp add remote --url https://example.invalid/mcp --header 'Authorization: Bearer ${MCP_TOKEN}'
codepunk mcp remove echo
codepunk mcp test [echo] [--json]
codepunk mcp login [remote]
codepunk mcp status [remote] [--json]
codepunk mcp logout remote
```

`add` refuses to replace an existing name unless `--force` is present.
`add` and `remove` preserve unrelated servers, comments, and tables in the
file. `test` is the connection check: it starts the selected server or all
servers, lists tools, and exits non-zero on a missing environment variable,
startup failure, or timeout. It prints each server's result to stdout and
writes failures to stderr. `list` is read-only and does not start servers.
`test --json` also reports `resource_servers` and the shared `resource_tools`
list when a connected server advertises resources.
The TUI `/mcp` command shows the same configured list and lifecycle guidance.
In the TUI, `/reload` re-reads `$CODEPUNK_HOME/mcp.toml` without replacing the
Codepunk session: it starts the new server set, swaps the wrapped MCP tools,
stops the previous server processes, and asks Pi to rebuild its tool registry.
Codepunk config, skills, and plugin inventory are still read at process start,
so those changes still need a restart.

`login` is the only browser entry point. It runs Pi's sign-in flow against a
loopback callback and stores the resulting client registration and tokens in
`$CODEPUNK_HOME/mcp-auth.json` (`0600`, directory `0700`). A stored refresh
token is used first, so mcp login is idempotent when the grant is still
valid. Session startup never starts a browser: an unauthenticated server is
reported as `mcp.auth_required` with the exact `codepunk mcp login <name>`
command. Pi refreshes a token that is within 30 seconds of expiry or after a
401, rotating the refresh token under a per-server cross-process lock.
`logout` removes the stored state; a revoked refresh token also requires a
new explicit login. `status` reports only whether a token exists, its scope,
and its expiry — never the token or client secret.

Project MCP files are inert and are never active configuration:

- `<delivery-root>/.codepunk/mcp.toml` is ignored at any trust level with a
  startup warning;
- `<delivery-root>/.codepunk/mcp.json` is ignored at any trust level with the
  same warning;
- `$CODEPUNK_HOME/mcp.json` fails closed with a migration message;
- `<delivery-root>/.pi/mcp.json` is ignored and never spawns a server.

Each server tool is exposed as `mcp__<server>__<tool>` with Pi's collision and
length rules. When a connected server advertises the MCP `resources`
capability, Codepunk also registers the three tools used by Codex and Pi:

- `list_mcp_resources` lists resources, optionally for one server and with a
  cursor; it returns JSON and omits MCP App resources (`ui://` or
  `profile=mcp-app`).
- `list_mcp_resource_templates` lists parameterized resource templates with
  the same server/cursor shape.
- `read_mcp_resource` reads one `server` + `uri` pair. Text becomes text,
  images become image blocks, and other binary resources become an omitted
  placeholder. Multiple returned contents are labelled with their URIs.

The resource implementation calls `McpClient.listResources`,
`listResourceTemplates`, and `readResource` from `@earendil-works/pi-mcp`; it
does not add a second MCP JSON-RPC client. Model-visible text is capped by Pi's
`limitMcpContent`; Codepunk does not apply a second MCP output limit. Resource
tools are separate from each server's `mcp__<server>__<tool>` registry, but
they are registered through the same Pi custom-tool path and therefore pass
through Codepunk's policy, approval, evidence, and output-artifact wrappers.
Pi 1.5.2 does not expose MCP prompt operations as a product tool surface, so
Codepunk does not invent a private raw-RPC prompt command; resource access is
the supported context surface in this build.

The policy default for `mcp__*` and the three resource tools is `ask`;
headless and worker modes convert that to `deny`.
Blanket `approval = "allow"` does not erase this gate: MCP remains a human
decision because the server process is outside the shell sandbox. A
`read-only` autonomy profile does not start MCP servers at all, so their code
cannot run before the first tool call. Resource reads have the same
`coverage: "uncovered"` evidence, and their approval preview binds the
server/URI arguments by `args_sha256`.
Approval cannot be supplied by a plugin or IM channel. Evidence records the
MCP source, the approval decision, and `coverage: "uncovered"` because codepunk
does not sandbox the MCP server process. For `mcp__*` calls the approval panel
shows a bounded, secret-redacted JSON preview of the arguments and binds the
full argument set by `args_sha256`. This hash is present even when the approval
mode auto-allows the call, so the evidence still identifies what was sent.

Server starts are recorded as `mcp/server_start` with the command hash, PID,
and uncovered coverage. Session startup loads servers tolerantly: a server
that fails to initialize is reported as a configuration warning and the other
servers stay available, so one broken optional integration cannot make the
whole session unusable. Explicit `mcp test` remains fail-closed and exits
non-zero; the strict loader used by management and test paths still stops
already-started servers and reports the failure.
`/reload` uses the same tolerant loader and records a `mcp/server_start` event
for every server it starts. If the new configuration is invalid, the previous
server processes and tools stay active and the TUI reports the error instead
of half-applying the change.

`--no-mcp` skips every user-scope server for one session and records that
choice in the startup warnings. The model and session are resolved before MCP
startup. When no model is selected, every mode skips MCP startup and reports
that the user must select a model and run `/reload` in the TUI (or restart) to
load MCP tools; no user-scope stdio server runs during model onboarding.

For a deliberately isolated run, `--no-skills`, `--no-plugins`, and
`--no-mcp` remove one surface each. `--bare` removes all three together and
also suppresses discovered instruction files and memory for that process. It
does not disable model authentication, workspace trust, policy, approval,
autonomy, or the sandbox; those remain explicit execution controls. The
choices are reported in startup warnings, and the TUI `/skills`, `/plugins`,
and `/policy` views report the effective isolation instead of implying that
an empty list means no resources are installed.

## Inventory

`codepunk capabilities` and the TUI `/capabilities` command summarize the
configured surface without loading it:

- MCP server names, commands, arguments, working directories, and environment
  variable names;
- user and project skills with scope, description, size, and content hash;
- plugin files under `$CODEPUNK_HOME/extensions` and whether the current
  process loaded them.

The inventory does not start MCP servers or plugins. MCP environment values are
not printed. Commands, arguments, descriptions, and errors pass through the
same secret-shaped redaction used for evidence previews. `--json` emits the
same snapshot for scripts.

Remote Streamable HTTP MCP servers are connected with either explicit headers
or OAuth. OAuth sign-in, token refresh, and logout are implemented; the
protocol work (PKCE, DCR, discovery, refresh, loopback callback) comes from
Pi's `@earendil-works/pi-mcp/oauth`, while Codepunk owns the user-scope store,
the explicit login command, and the no-auto-browser rule.
