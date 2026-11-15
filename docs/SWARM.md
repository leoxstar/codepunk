# Swarm notifications and work sources

Bounded swarm notifications and a read-only GitHub work source are available
without remote approvals or auto-merge.

## MessageBridge

`MessageBridge` has one job: send notifications to an IM adapter. The
notification shape allows task, worker, review, merge, and system messages.
An `approval` kind or an approval payload is rejected before any adapter call.
Approvals remain bound to a local human surface.

If the adapter is unavailable, notifications are appended to
`projects/<project-id>/notifications.jsonl` and core keeps running. `flush`
drains the queue in order and leaves unsent entries intact on the first
adapter failure. The queue is bounded; a full queue reports
`bridge.queue_full` instead of silently dropping evidence.

## GitHub WorkSource

`GitHubWorkSource` calls `gh issue list` with an `owner/name` repository, an
explicit open-state filter, a limit bounded to 100, and JSON fields for number,
title, URL, labels, body, and creation time. It never creates, edits, closes,
or merges an issue/PR. Tests inject the `gh` runner, so no network is used.

`LocalWorkSource` exposes a small in-memory item list for local board use.

## Bounded swarm

`BoundedSwarm` drives the existing `WorkerPool` and updates the human-facing
`Board`. It keeps the pool at four active workers or fewer, sends worker
notifications through `MessageBridge` when configured, and has no merge
operation. A merge still requires the human-only `mergeHandoff` path.
