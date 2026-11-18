# Daemon protocol v1

A local daemon provides a second observation surface plus one metadata write.
The wire contract is owned by `packages/protocol`; the CLI remains a client and
does not implement policy or tool execution.

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

| Method         | Parameters                                           | Result                                     |
| -------------- | ---------------------------------------------------- | ------------------------------------------ |
| `daemon/hello` | none                                                 | protocol version, methods, pid, start time |
| `session/list` | none                                                 | session summaries for this project         |
| `session/read` | `session_id`, optional `after_seq`, optional `limit` | one ordered page of session events         |
| `session/pin`  | `session_id`, `pinned`                               | the session's stored `pinned` value        |

`session/pin` is the only method that mutates stored state. It rewrites the
`pinned` flag of one session's metadata and nothing else: it does not append
events, write files, or acquire the session writer lock. `hello.read_only`
therefore reports `false` while the `session/read` result keeps its own
`read_only: true`, which describes that snapshot rather than the wire surface.

There is no method for a file write, session append, approval answer, verdict
sign-off, work dispatch, or merge. A request using one of those method names
receives `daemon.read_only`.

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
`protocol.version_mismatch`, `daemon.read_only`, `daemon.not_found`,
`daemon.request_too_large`, `daemon.response_too_large`, `daemon.timeout`, and
`daemon.internal`.

## Clients

`DaemonClient` in `packages/core` is the protocol client. The CLI has two
surfaces:

```text
codepunk daemon [--socket path]
codepunk view [session-id] [--json] [--socket path]
```

`codepunk daemon` serves one project and stays in the foreground.
`codepunk view` is the second client: without a session id it lists sessions;
with one it reads all pages and prints a human-readable or JSON view. It cannot
approve, sign, or modify a session through this protocol.

The two-client acceptance test is `tests/daemon.test.mjs`.

## Session events

The session log is an append-only JSONL stream. Every event carries
`type: "codepunk/event"`, `version: 1`, a monotonic `seq`, and an ISO-8601
`at` timestamp. The schemas are frozen in `packages/protocol/src/session.ts`.

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
