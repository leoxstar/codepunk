# Daemon protocol v1

A local daemon provides a second, read-only surface. The wire contract is owned
by `packages/protocol`; the CLI remains a client and does not implement policy
or tool execution.

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

## Read-only methods

| Method         | Parameters                                           | Result                                     |
| -------------- | ---------------------------------------------------- | ------------------------------------------ |
| `daemon/hello` | none                                                 | protocol version, methods, pid, start time |
| `session/list` | none                                                 | session summaries for this project         |
| `session/read` | `session_id`, optional `after_seq`, optional `limit` | one ordered page of session events         |

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
    "message": "daemon method session/append is not available; the wire surface is read-only"
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
