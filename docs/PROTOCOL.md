# Daemon protocol v1

A local daemon provides a second observation surface plus scoped control of an
existing Codepunk runtime. The wire contract is owned by `packages/protocol`;
the CLI remains a client and does not implement policy or tool execution.

## Transport

- Unix `SOCK_STREAM` socket on macOS and Linux.
- One newline-delimited JSON request and one newline-delimited JSON response
  per connection. The server closes the connection after the response.
- The default socket is `$CODEPUNK_HOME/run/<project-id>.sock`. If that path
  exceeds the platform Unix-socket limit, the daemon uses the short,
  user-private fallback `/tmp/codepunk-<uid>/<project-id>.sock`.
- The socket directory is mode `0700` and the socket is mode `0600`.
- Existing non-socket paths and symlinks are refused. A stale socket is
  replaced only after a connection probe fails and the socket is owned by the
  current user.
- The request body is limited to 64 KiB, the response to 1 MiB, each session
  page to 100 events, an idle request to 5 seconds, and the server to 32
  concurrent connections.

The wire surface is intentionally local. It has no remote listener, HTTP
upgrade, hosted identity, or cross-user authentication.

## Version

The only accepted version is `1`. Every request and response carries
`version: 1`.

A request with version `0` or `2` receives a
`protocol.version_mismatch` error and is not dispatched. Clients validate the
same envelope and payload schemas before sending and after receiving.

The schemas and limits are exported from `packages/protocol/src/daemon.ts`.
Generated artifacts are never hand-edited.

## Methods

| Method            | Scope             | Parameters                                           | Result                                      |
| ----------------- | ----------------- | ---------------------------------------------------- | ------------------------------------------- |
| `daemon/hello`    | `daemon:read`     | none                                                 | advertised methods, scopes, pid, start time |
| `session/list`    | `sessions:read`   | none                                                 | session summaries for this project          |
| `session/read`    | `sessions:read`   | `session_id`, optional `after_seq`, optional `limit` | one ordered page of session events          |
| `session/pin`     | `sessions:write`  | `session_id`, `pinned`                               | the session's stored `pinned` value         |
| `session/new`     | `sessions:write`  | none                                                 | new session id and its writer lease         |
| `session/run`     | `runs:write`      | session id, prompt, reason, writer lease             | accepted/start/finish control events        |
| `session/steer`   | `runs:write`      | session id, message, reason, writer lease            | accepted/message control events             |
| `session/stop`    | `runs:write`      | session id, reason, writer lease                     | stopped control event                       |
| `session/approve` | `approvals:write` | session id, approval id, nonce hash, decision        | accepted control event or a mismatch error  |
| `session/plan`    | `plan:write`      | session id, plan, reason, writer lease               | accepted/message control events             |
| `session/goal`    | `goal:write`      | session id, goal, reason, writer lease               | accepted/message control events             |

The default `codepunk daemon` surface grants `daemon:read`, `sessions:read`,
and `sessions:write`. Use `--scopes` to grant only the methods required by a
client. `hello.methods` is derived from the granted scopes;
`hello.read_only` is `true` only when every advertised method is a read.
Every method, including `daemon/hello`, `session/list`, `session/read`, and
`session/pin`, is checked against its scope before dispatch. Omitting a scope
removes the method from `hello.methods` and a direct request receives
`daemon.scope_denied`; a read-only scope set cannot pin sessions.
`session/read` keeps its own `read_only: true`, describing that snapshot rather
than the whole wire surface.

There is no method for an arbitrary file write, session append, verdict
sign-off, work dispatch, or merge. A request using one of those method names
receives `daemon.read_only`. Control methods do not bypass policy, sandbox,
evidence, or human approval; `session/run` invokes the same runtime host as an
interactive prompt.

`session/pin` rewrites one session's `pinned` metadata without appending an
event or acquiring the session writer lock.

`session/new` creates one runtime owned by the daemon and returns the session
id plus the writer lease needed by `session/run` or ACP. A client that only
holds `sessions:write` can create and pin but cannot run; a client with
`runs:write` must still supply the exact lease. `session/new` is additive
v1 and does not change the four original read/pin method shapes.

`session/read` returns the header, stored metadata, ordered events, the
requested `after_seq`, the last returned `next_seq`, `has_more`, and
`read_only: true`. Iterate with `after_seq = next_seq` until `has_more` is
false.

Reading does not acquire the session writer lock and does not create or repair
session files. A missing metadata file is represented in memory and remains
absent on disk.

## Envelopes

Request:

```json
{
  "type": "codepunk/daemon-request",
  "version": 1,
  "request_id": "client-request-id",
  "method": "session/list",
  "params": {}
}
```

Successful response:

```json
{
  "type": "codepunk/daemon-response",
  "version": 1,
  "request_id": "client-request-id",
  "ok": true,
  "result": {
    "sessions": []
  }
}
```

Error response:

```json
{
  "type": "codepunk/daemon-response",
  "version": 1,
  "request_id": "client-request-id",
  "ok": false,
  "error": {
    "code": "daemon.read_only",
    "message": "daemon method session/append is not available; it is not one of the advertised methods"
  }
}
```

Stable error codes are `protocol.invalid_request`,
`protocol.version_mismatch`, `daemon.read_only`, `daemon.scope_denied`,
`daemon.write_conflict`, `daemon.approval_mismatch`, `daemon.run_failed`,
`daemon.not_found`, `daemon.request_too_large`, `daemon.response_too_large`,
`daemon.timeout`, and `daemon.internal`.

Control requests carry the `writer_lease` returned by `session/new` or an
already-owned session.
The lease binds session, run, token, and channel. An idle lease expires after
`DAEMON_WRITE_LEASE_TTL_MS`; a running task refreshes its server-side lease
without rotating the token. A stale, mismatched, or expired lease is refused
before any mutation. Only one `session/run` may be active per session.

A failed prompt is a `daemon.run_failed` error, never an `ok: true` result.
`session/stop` remains available for a running prompt and returns a
`control/stopped` event. `session/approve` reuses the original approval
correlation and exact nonce hash; a mismatch is `daemon.approval_mismatch`.

## Clients

`DaemonClient` in `packages/core` is the protocol client. The CLI has two
surfaces:

```text
codepunk daemon [--socket path] [--scopes daemon:read,...]
codepunk view [session-id] [--json] [--socket path]
```

`codepunk daemon` serves one project and stays in the foreground.
`codepunk view` is the second client: without a session id it lists sessions;
with one it reads all pages and prints a human-readable or JSON view. It cannot
approve, sign, or modify a session through this protocol.

The two-client acceptance test is `tests/daemon.test.mjs`.

## ACP v1

`codepunk acp` is a newline-delimited JSON-RPC 2.0 endpoint on stdio. It wraps
the same daemon v1 control operations without changing their scope or lease
semantics. The supported methods are:

| Method           | Purpose                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `initialize`     | select the client-declared scope set and read method-scope mapping   |
| `session/new`    | create one runtime and return its writer lease                       |
| `session/prompt` | run a prompt and stream `session/event` notifications                |
| `session/cancel` | stop the active prompt; the prompt then fails with ACP error `49007` |

Requests are limited to 64 KiB and responses to 1 MiB. JSON-RPC errors are
ACP-only: `-32700`, `-32600`, `-32601`, `-32602`, and `-32603` for standard
errors; `49001` scope denied, `49002` writer conflict, `49003` approval
mismatch, `49004` response limit, `49005` session missing, `49006` backend
failure, and `49007` run cancelled.

`session/prompt` and `session/cancel` execute concurrently: cancel is not
queued behind a blocked model call. A failed or cancelled prompt is always a
JSON-RPC error after its control events; it is never reported as a successful
result. Pipelined setup is ordered, so a `session/new` completes before a later
prompt or cancel resolves its session.

ACP uses the normal runtime capability set (skills, MCP servers, and trusted
plugins) subject to the same policy, sandbox, approval, and evidence gates. It
is not a bare/headless reduced loadout. A second prompt on a session with an
active run is refused as `49002`; it cannot replace the first run's cancel
state.

The ACP acceptance and mutation tests are `tests/acp.test.mjs`.

## Background tasks

Background tasks are a local process lifecycle, not a new daemon method or
session-event kind. A task is identified by a path-safe id and stored with:

- `background/<id>/task.json`: the latest bounded snapshot;
- `background/<id>/evidence.jsonl`: start, steer, stop, spawn refusal,
  stale-lease, and end evidence;
- `artifacts/background/<id>/stdout.log` and `stderr.log`: owner-only bounded
  output.

Terminal states are `completed`, `failed`, `stopped`, and `rejected`; active
states are `queued`, `running`, and `stopping`. Queue, concurrency, steering,
log-size, and stop-time limits are finite. A full queue is rejected with
`background.queue_full` and evidence. A spawn is refused if the task id is
unsafe, the claim is stale, or the log artifact cannot be opened; no child is
started for those failures.

`/stop` sends `SIGTERM` to the detached process group, escalates to `SIGKILL`,
and verifies the group is gone. A stop that cannot converge is `failed`, and
later child-close handling cannot overwrite that failure as `stopped`. A
reclaimed lease cannot stop a task or be mistaken for the original owner.
Steering submitted while a task is queued is delivered to stdin once the task
starts; it is never dropped. A fresh manager may read durable task records,
but a task that was active when its owning process disappeared is surfaced as
failed for inspection rather than silently adopted.

The TUI surface is `/ps`, `/logs <id>`, and `/stop <id>`. The manager-level
acceptance test is `tests/background.test.mjs`.

## Session events

The session log is an append-only JSONL stream. Every event carries
`type: "codepunk/event"`, `version: 1`, a monotonic `seq`, and an ISO-8601
`at` timestamp. The schemas are frozen in `packages/protocol/src/session.ts`.
Additive event kinds remain on schema version `1`; changing the envelope or
the shape or meaning of an existing event requires a new session-event schema
version and an explicit compatibility note.

### Execution side effects and budgets

`loop_guard` records a denied repeated shell call:

```json
{
  "kind": "loop_guard",
  "data": {
    "run_id": "run-1",
    "tool": "bash",
    "canonical_argv": ["printf", "ok"],
    "cwd": "/workspace",
    "repeat_count": 4,
    "threshold": 3,
    "decision": "deny"
  }
}
```

`budget/exceeded` uses the unified `BudgetExceeded` object:

```json
{
  "kind": "budget/exceeded",
  "data": {
    "run_id": "run-1",
    "limit_kind": "tool_calls",
    "limit": 2,
    "used": 2,
    "action": "reject_call"
  }
}
```

`limit_kind` is one of `tool_calls`, `wall_ms`, `tokens`, or `cost`.
`action` is `reject_call` for a pre-call refusal and `abort_run` when the
wall-clock timer interrupts an in-flight run.

### Network egress

`network/request` records one proxy decision:

```json
{
  "kind": "network/request",
  "data": {
    "run_id": "run-1",
    "domain": "allowed.example",
    "requests": 1,
    "bytes": 4,
    "limit": { "max_requests": 10, "max_bytes": 1024 },
    "decision": "allow"
  }
}
```

`network/redirect` records a redirect hop and its fresh domain decision:

```json
{
  "kind": "network/redirect",
  "data": {
    "run_id": "run-1",
    "from": "allowed.example",
    "to": "denied.example",
    "status": 302,
    "decision": "deny"
  }
}
```

`network/rejected` records a refused request:

```json
{
  "kind": "network/rejected",
  "data": {
    "run_id": "run-1",
    "domain": "denied.example",
    "reason": "domain_not_allowed",
    "limit": { "max_requests": 10, "max_bytes": 1024 }
  }
}
```

The sandbox proxy only calls the hook for requests it parses. Plain HTTP
goes through the hook; HTTPS that is not TLS-terminated is tunnelled through
CONNECT and is governed by the runtime allowlist alone.

### Evidence extensions

`EvidenceRecord` gains optional fields for idempotent writes (`idempotency_key`,
`reused`), verify/retry (`verify`, `retry`), and budget exhaustion
(`budget_exceeded`). All fields are declared in
`packages/protocol/src/evidence.ts`; undeclared top-level keys are rejected.

### Product P0 events

The product P0 capabilities add five event kinds without changing the session
envelope or any existing event:

| Event           | Payload and invariant                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal/update`   | `action`, `previous_sha256`, `goal`, and `event_sha256`; revisions form a validated hash chain, and identity fields stay fixed until `clear` |
| `goal/error`    | `version: 1`, a bounded `code` (`goal.corrupt` or `goal.inject_failed`), a bounded `reason`, and `created_at`                                |
| `review/result` | A `StructuredReview` bound to `diff_sha256`, with session/run IDs, changed paths, and bounded severity/file/line findings                    |
| `review/error`  | `version: 1`, session/run IDs, a bounded `reason`, and `created_at`                                                                          |
| `hook/result`   | Sanitized hook evidence: scope, lifecycle event, outcome, exit code, duration, stdout/stderr SHA-256, and a bounded reason                   |

`hook/result` never stores raw hook output. A rejected configuration or a
failed evidence write is part of the failure result, not an ignored warning.
Review findings are recommendations only; the event does not grant write,
approval, merge, or sign-off authority.

These additions keep `SESSION_EVENT_SCHEMA_VERSION` at `1`. A reader built
before a kind existed validates the shared envelope and fails closed with
`SessionUnsupportedEventError` when it encounters that kind. A current reader
accepts older v1 sessions that do not contain the new kinds. No event
migration is required. Any change to an existing kind's fields or semantics
must bump the version instead of being folded into this additive freeze.

### Unknown events

Readers must not silently drop an unknown event kind. `SessionStore` throws
`SessionUnsupportedEventError` with the offending kind so an old binary fails
closed instead of treating a new event as a no-op.

## Plugin isolation

Plugins run in a separate child host. The main process and the plugin host
exchange newline-delimited JSON frames defined in
`packages/protocol/src/plugin.ts`. A frame is one request or one response;
the maximum frame size is `PLUGIN_MAX_FRAME_BYTES`.

Every request carries a unique `call_id`, the `plugin_id`, the method, JSON
parameters, a timeout, and an optional cancellation token. A response carries
the same `call_id` and either a result or a typed `PluginError`. The stable
error codes include `plugin.invalid_request`, `plugin.unknown_method`,
`plugin.duplicate_call`, `plugin.timeout`, `plugin.cancelled`,
`plugin.frame_too_large`, `plugin.crashed`, `plugin.capability_denied`,
`plugin.policy_denied`, and `plugin.approval_denied`.

The main process owns policy, approval, sandboxing, and evidence. A plugin
cannot receive the parent approval broker or evidence ledger. Approval is
routed back by the request's `call_id`; an answer for one call never applies
to another.

### Plugin events

`plugin/started` records the manifest hash, child PID, startup credential
verification, and start time:

```json
{
  "kind": "plugin/started",
  "data": {
    "plugin_id": "example",
    "version": "1.0.0",
    "manifest_sha256": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "pid": 1234,
    "credential_verified": true,
    "started_at": "2026-11-18T00:00:00.000Z"
  }
}
```

`plugin/tool_call` binds a tool call to the plugin and its manifest:

```json
{
  "kind": "plugin/tool_call",
  "data": {
    "run_id": "run-1",
    "tool_call_id": "call-1",
    "plugin_id": "example",
    "plugin_manifest_sha256": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "executor": "child-host",
    "decision": "allow",
    "approval": null,
    "outcome": "completed",
    "reason": null
  }
}
```

`plugin/stopped` records the child PID, startup credential verification,
reason, exit code, and stop time. If isolation is unavailable, the plugin is
not loaded; there is no in-process fallback.

## Context requests

`context/request` is written before every model call, with or without
compaction. It carries `run_id`, a unique `request_id`, the ordered
`message_ids` sent to the model, `omitted` ids and contiguous ranges in the
transcript order, `truncation_sha256`, `provider`, `model`,
`token_estimate`, and the last `compaction_id` when one exists. Message bodies
stay in the session and artifacts; the event stores ids and hashes only.

`truncation_sha256` covers the canonical `{message_ids, omitted}` descriptor.
An empty `omitted.ids` is valid and means the full context was sent.

## Retention operations

`gc`, `migrate`, and `backup` append `RetentionOperation` records to
`CODEPUNK_HOME/retention/operations.jsonl`. This is an independent log with
its own contiguous `seq` and `prev_sha256`; it is never written inside a
session that the operation may delete. Each record names the action, mode,
affected relative paths with before/after hashes and byte counts, the backup
id, exit code, and failure reason. The schema lives in
`packages/protocol/src/retention.ts` and is not part of `SessionEventSchema`.
