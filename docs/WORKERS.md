# Multi-worker and subagents

The default remains one worker; parallel execution requires disjoint write sets
and a `WorkerSandbox`.

## Claims

`ClaimStore` persists claims under the project runtime directory. A claim has a
monotonic fence, owner, acquisition time, renewal time, and expiry. Fences are
stored with the claim file and never reused after restart.

- A live claim rejects a second owner.
- An expired claim can be replaced, but the old claim cannot renew.
- `assertLive` is the merge-admission check; a stale or mismatched claim is
  rejected before the exact commit is merged.
- Claims are advisory exclusion and evidence input, not tool-call
  authorization.

## Worker pool

`WorkerPool` clamps concurrency to 1-4 workers, rejects overlapping write sets
before any worker starts, and keeps queued/running/completed results. The
effective budget is the smaller of the pool budget and the task budget for wall
time, tool calls, and disk bytes. Wall-clock expiry aborts the worker signal;
tool-call exhaustion aborts and records the error; other workers continue.

`Board` is a human-facing projection only. `decideSwarm` is a pure routing
decision: overlapping write sets are rejected, insufficient budget stays
single-worker, and disjoint work with high uncertainty can become a team.

## Worker sandbox

`WorkerSandbox` creates a worker-scoped srt profile around a detached worktree
and run directory. It permits writes only in the worktree, run directory, loose
Git objects, and the worker's Git metadata. The parent checkout, sibling
worktrees, and `$CODEPUNK_HOME` are denied.

On Linux, `srt` presents a `denyRead` directory as an empty writable tmpfs. A
command can therefore exit `0` after writing to a denied path while the host
directory remains unchanged and the write disappears when the sandbox exits.
Worker tests and operator checks must assert the host content and absence of
new paths; an exit code alone is not a confinement signal.

The worktree-root `AGENTS.md`, `CLAUDE.md`, and `.codepunk/` are protected:
both the srt shell profile and `assertWriteTarget` reject changes even when a
caller includes those paths in the declared write set.

It additionally rejects:

- `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, and index redirects;
- `git update-index`, `hash-object`, `commit-tree`, `mktree`, and `write-tree`;
- `git push`, `update-ref`, `reset --hard`, forced branch refs, and `gh` merges;
- host launches by worker shells, including launches hidden behind `env`,
  `command`, `exec`, `nohup`, `time`, `sudo`, `doas`, `xargs`, or a shell `-c`;
- copied or renamed hosts whose executable or Node script contains the Pi host
  markers, subject to a 5 MB scan limit;
- file writes outside the task write set through `assertWriteTarget`.

Normal `git status`, `git add`, and `git commit` work in the detached
worktree. Git hook, config, info, refs, packed-refs, and packed object writes
remain denied.

## Subagents

`Subagent` has a distinct parent and child session, an explicit
`parent_session_id`/`child_session_id`, inherited run isolation, an
action-level tool mask, a permission mode, and a depth of at most one. Workers
never receive `memory_search`. A second spawn returns the typed
`subagent.depth_exceeded` error. `ask` does not approve child mutations;
`read-only` removes mutation/shell; `scoped` requires an explicit mutating
capability and write set. A child does not inherit the parent's scoped
autonomy rules; the default child autonomy stays `ask`.

`WorkerSandbox.assertHostLaunchToken` validates a 128-bit inherited launch
token. The CLI's private `--guarded-host-launch` entry reads the candidate
token from fd 3 and the expected token from fd 4 before loading config or any
model surface, and rejects a missing or mismatched token. This is a launch
handshake, not a recursion limit: a depth-1 child is the normal case, and
recursion is bounded by `Subagent`'s one-level rule. `spawnGuardedHost` writes
both descriptors and closes them after the write; `env -u CODEPUNK_DEPTH`
cannot bypass the check. A normal interactive `codepunk` launch does not use
the guarded entry.

## Child Pi sessions

`/subagent <task>` in the TUI starts a separate Codepunk/Pi process through the
same guarded-host path. The child receives a new explicit Codepunk session id,
records the parent session id in its own session header, runs in the parent
working directory, and records its own session events and evidence. The parent
records a `subagent/result` event with both session ids, the child run id when
an evidence run exists, the evidence head, exit code, and status.

The current surface is deliberately narrow:

- background: `/subagent` returns immediately, up to four children run at
  once, and `/agents`, `/agents result <id>`, and `/agents stop <id>` manage
  the handles;
- read-only: the child policy exposes only `read` and `search`, with
  `--approval deny`; write, edit, shell, and `memory_search` are absent;
- shared cwd: no worktree is created, so a read-only child sees the same
  checkout as the parent;
- inherited trust: a saved workspace trust decision is resolved by the child;
  an explicit parent decision is passed through in both directions with
  `--trust` or `--no-trust`. The child does not inherit the parent's scoped
  rules or `filesystem = full`;
- inherited model: the child receives the active host model and thinking level
  when one is selected;
- git-only: the child needs a repository with at least one commit so its task
  spec has a real base commit.

If the child answers without calling a tool, the result has no evidence run and
the event carries `evidence_head: null`. If a tool did run but its evidence is
missing, the subagent fails closed instead of returning an unlinked summary.
The child host charges each `tool_execution_start` against the task's
tool-call budget; the wall-clock budget aborts the child as well. This
read-only path has no disk-write surface, so it does not charge disk bytes.
The prompt is delivered over the child's standard input rather than its
command-line arguments.
This is not yet mutable delegation: there are no agent profiles, per-child
model pools, isolated worktrees, or streamed child output.
