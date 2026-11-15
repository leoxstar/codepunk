# Models

Codepunk resolves models through the pinned Pi host. Model configuration is
user state under the Codepunk home directory; it is never read from the project
repository.

## Files

| File          | Purpose                                                         |
| ------------- | --------------------------------------------------------------- |
| `config.toml` | User/CLI default `model.provider`, `model.id`, `model.thinking` |
| `models.json` | Custom providers, endpoints, model metadata, and key references |
| `auth.json`   | Credentials written by the Pi host's login flow                 |

`model.provider` and `model.id` are user/CLI-only. A project
`.codepunk/config.toml` that sets either one is rejected, so a repository
cannot pick the endpoint that receives its own code. The ignored-by-Git
`.codepunk/local.toml` is not an exception for this boundary: it may carry
machine-local preferences such as `model.thinking`, but `model.provider`,
`model.id`, `model.fallback`, and
`model.fallback_allow_cross_provider` are rejected there with the same
user-scope error as project config. A cloned repository cannot ship a
`local.toml` that redirects model traffic.

`CODEPUNK_HOME` overrides the home directory for tests and isolated runs.
`models.json` and `auth.json` are written with owner-only permissions.

## No model configured

An interactive session with no active model shows the setup notice at startup,
not only after the first prompt:

- `/model` opens Pi's searchable picker; with no credential it reports that no
  authenticated models are available.
- `/login` adds a built-in provider credential.
- `codepunk models import <base-url> --provider <id> --api openai-responses`
  adds an OpenAI-compatible endpoint, and `codepunk models set <id>/<model>`
  saves the default.

Ordinary input is gated only when no model is active, so the first prompt does
not silently fail inside the host. If Pi supplies a host default, that model is
usable immediately and the setup notice explains how to persist an explicit
default. Print mode has no picker: it exits `1` with the same import and set
hints. Codepunk does not ship a separate model wizard; the model catalog,
credentials, and picker are Pi's surfaces.

`/model` stays Pi's path on purpose. It is the only entry point that combines
the live authenticated catalog, fuzzy search, session-scoped selection, and the
`Ctrl+S` default save, and Pi emits `model_select` from it so the product status
line and fallback routing stay in sync. Codepunk only intercepts an exact
`provider/id` or unique bare id, which it validates and persists through its own
file-backed config. A partial query falls through to Pi's picker.

## Commands

List configured models. `auth` means the provider has a usable credential;
`selected` marks the default; `custom` means the model came from
`models.json`. It does not mean every upstream model is currently healthy.

```text
codepunk models list
```

Import an OpenAI-compatible endpoint by reading its `/models` response:

```text
codepunk models import http://127.0.0.1:4000/v1 \
  --provider local \
  --api openai-responses \
  --api-key local-dev
```

For a keyless local endpoint, the key is a placeholder that makes the provider
count as configured. With Pi 1.5.2, `authHeader: false` does not suppress the
OpenAI client's own Bearer credential, so the placeholder is still sent; the
local endpoint must accept or ignore that header.
For an authenticated endpoint, pass a literal key or `$ENV` reference and add
`--auth-header` so the value is sent as `Authorization: Bearer`.

Filter the imported models with `--model`:

```text
codepunk models import https://gateway.example/v1 \
  --provider gateway \
  --api openai-completions \
  --api-key '$GATEWAY_API_KEY' \
  --auth-header \
  --model 'team-*'
```

Choose a default and verify it:

```text
codepunk models set local/example-model --thinking max
codepunk doctor
codepunk models test
```

`--model <provider/model>` overrides the default for one run.
Remove a custom provider with:

```text
codepunk models remove <provider>
```

Removal refuses while the provider owns the selected default or appears in
`model.fallback`; choose another default and update the fallback chain first.
Other providers in `models.json` are preserved.

`models test [provider/id]` performs one small real request, so it separates a
configured credential from a working upstream model. It prints the provider,
model, stop reason, latency, token usage, and text, or the upstream error.

Model discovery currently supports OpenAI-style `/models` responses for
`openai-responses` and `openai-completions`. Other provider APIs can still be
declared by editing `models.json`, but `models import` does not discover them.

## Imported metadata

`models import` keeps the model ID, display name, reasoning capability,
thinking-level map when the endpoint reports one, context window, maximum
output, and text/image input support. Missing limits fall back to the host
defaults of 128000 context tokens and 16384 output tokens.

The import does not call every model. A model can be listed as `auth` while its
upstream provider is unavailable; the first real request reports that failure.
Use `models test` for that check. An import rewrites `models.json` as normalized
JSON: comments and trailing commas are accepted when reading, but are not
preserved after the import writes the file.

## TUI

`/model` is Pi's native path. A bare command opens the searchable picker;
typing filters provider, model ID, display name, and subsequences. Pi also
tries an exact `provider/id` or unique bare model ID before opening the picker
with the same query. Codepunk does not duplicate the fuzzy resolver.

Codepunk adds the persistence semantics around that host path:

- A unique exact `/model <provider/model>` or `/model <bare-id>` selection is
  handled by Codepunk so the choice is written to `config.toml`. If the query
  is ambiguous or partial, it falls through to Pi's searchable selector.
- In Pi's picker, Enter applies the highlighted model to the current session.
  `Ctrl+S` saves it as the default. Codepunk mirrors the `Ctrl+S` default into
  `config.toml`; it does not turn a session-only Enter into a saved default.
- `codepunk models list` is the non-interactive catalog for scripts and narrow
  terminals; it reports what the host currently considers authenticated.

`/thinking` keeps Pi's native selector and clamping. Codepunk writes the
resulting effective level to `model.thinking`, so a restart uses what the TUI
last displayed. `/scoped-models` is not opened because Pi's scoped-model
selector only updates the in-memory settings manager in this host. Scope is
file-backed instead:

```toml
[model]
enabled = ["gateway/primary-model", "openai/gpt-5"]
```

An empty or absent `enabled` list means no scope restriction.

## Approval reviewer

An optional model reviewer can resolve the two approval classes that the
static `auto` table intentionally leaves open: network commands and headless
argv `exec`. It is disabled by default and is configured in the user config,
not in a project file:

```toml
[approval]
mode = "auto"
reviewer = "model"
reviewer_model = "gateway/reviewer"
reviewer_timeout_ms = 20000
```

`reviewer_model` uses the exact `provider/model` catalog form. When omitted,
the selected session model is used. The concrete model and credential are
resolved on the first action that actually reaches the reviewer, not when an
ask/read-only session starts. A missing model or credential becomes an
abstain with evidence; interactive mode then asks a human, and headless mode
denies. This keeps an optional reviewer from blocking a session that never
needs it, without silently treating an unconfigured reviewer as approval.

The reviewer sees bounded, redacted action metadata such as the command,
argv, cwd, approval class, policy reason, and a diff or MCP argument hash. It
does not receive repository contents or a second agent loop, and it uses Pi's
`ModelRuntime.completeSimple`. A reviewer model from another provider means
that metadata crosses that provider boundary; configure it only when that is
acceptable.

The reviewer is not a blanket auto-approval mechanism. Hard policy denies,
sensitive paths, protected instruction/config writes, MCP side effects,
explicit policy asks, and unmatched scoped rules never reach it. A malformed
response, upstream error, or timeout becomes an abstain. Interactive mode then
asks a human; headless mode denies because no approval channel exists.
Reviewer evidence is recorded separately from human approval and carries the
model identity, decision, action hash, latency, and an abstain error when
present.

## Fallback

Fallback is a user-scope chain headed by the configured primary model:

```toml
[model]
provider = "gateway"
id = "primary-model"
fallback = ["gateway/backup-model"]
fallback_allow_cross_provider = false
```

`fallback` entries use exact `provider/model` references. Every member must be
in the catalog, resolve a real credential through Pi's `checkAuth`, and be
inside `model.enabled` when that scope is set. Duplicates, ambiguous
references, and virtual models are rejected before the session starts.

The host exposes this chain as `codepunk/auto` through Pi's virtual-model
router. A user turn starts at the first usable member; tool continuations stay
on the last successful model. A non-overflow request failure advances to the
next member. Context overflow does not switch providers: the current model is
kept with its router state so Pi can compact and retry. If every member fails,
routing stops with an explicit exhaustion error instead of retrying the last
failed model. Overflow detection also checks the pinned model's context window,
so silent `stop` responses and zero-output `length` responses are not mistaken
for ordinary provider failures.

The virtual model advertises the smallest context window and output limit in
the chain, the intersection of input modalities, and the intersection of
thinking levels reported by Pi's `getSupportedThinkingLevels`. This prevents
the model picker from offering a reasoning level that the routed member cannot
use.

Cross-provider or cross-endpoint fallback is off by default because it sends
the same conversation to a different provider. Enable
`fallback_allow_cross_provider = true` only after deciding that data boundary
is acceptable. Two models under one provider ID but different `baseUrl` values
are different endpoints. Same-endpoint routing groups do not need this flag.

On resume, the latest branch selection wins. If the user last selected a
physical model, restore keeps it rather than reinstating `codepunk/auto`. If
the latest selection was the virtual route, the pinned chain must still match
the configured chain or the session refuses to start.

`codepunk/auto` is not a selectable default. `/model` may show it as a runtime
route, but `Ctrl+S`, `/model`, `models set`, and `--model` reject saving it;
the next process must build the chain before the virtual model exists. A real
switch or exhaustion is recorded as a `model/fallback` event with the chain
hash, attempted models, and stop reason.

When no default model is configured, the TUI shows a startup warning with
`/login`, `/model`, and `codepunk models import` guidance. A Pi session may
still auto-select a catalog model; the warning names that session model so it
is not confused with a saved default. Print mode exits before starting a
session with the shell setup hints.

## Failure behavior

- A malformed `models.json` is reported and never overwritten by an import.
- An import failure leaves the existing `models.json` byte-identical.
- A selected model with no credential fails before the session makes a
  request.
- A model excluded by `model.enabled` cannot be selected.
