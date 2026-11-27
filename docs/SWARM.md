# Swarm protocol schemas and bounded workers

Wire schemas for swarm notifications and work items remain in
`codepunk-protocol` (`WorkItemSchema`, `NotificationSchema`) for
compatibility, while active execution runs through `WorkerPool`, `Board`, and
isolated `SubagentDispatcher` worktrees in `codepunk-core`.

Approvals remain strictly bound to a local human surface (`TUI` or local TTY),
and merging child worktrees always requires the human-only `mergeHandoff` path.
