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

`/subagent [--profile <name>] [--model <provider/model>] [--worktree|--shared]
<task>` in the TUI starts a separate Codepunk/Pi process through the same
guarded-host path. The child receives a new explicit Codepunk session id,
records the parent session id in its own session header, and records its own
session events and evidence. The parent records a `subagent/result` event with
both session ids, the child run id when an evidence run exists, the evidence
head, exit code, status, profile digest, isolation, worktree, and changed-file
count. A completed child also returns the path to its full stdout transcript.

### Agent profiles

Agent profiles are Markdown files. User profiles live in
`$CODEPUNK_HOME/agents/*.md`; project profiles live in
`.codepunk/agents/*.md` and load only from a trusted workspace. A project
profile overrides a user profile with the same name. Files must be regular
files, no larger than 64 KiB, with a lowercase name and a non-empty
description and body.

The supported frontmatter is:

```markdown
---
name: reviewer
description: Review a bounded change set
tools: read, search
model: local/primary
fallback: local/secondary, local/tertiary
thinking: high
---

Return findings with file and line references.
```

`tools` accepts `read`, `search`, `write`, and `edit`. `shell` is rejected
until a profile can declare an exact command allowlist; the child does not
receive `memory_search`. `model` and every fallback use exact
`provider/model` references. A fallback requires a primary model and cannot
repeat it. A per-run `--model` must be in the profile's model pool.

### Isolation and lifecycle

- A read-only child (the default, or a profile containing only read/search)
  shares the parent checkout and runs with `--approval deny`.
- A profile that enables `write` or `edit` always runs in a detached worktree
  and uses `--approval allow`, `--autonomy ask`, `--sandbox required`, and
  `--filesystem workspace`. The write set is the worktree root; protected
  instruction and `.codepunk` paths still fail closed.
- `--shared` is rejected for a mutating profile. `--worktree` forces a
  detached worktree for a read-only profile.
- `/subagent` returns immediately. Up to four children run at once;
  `/agents`, `/agents profiles`, `/agents result <id>`, `/agents wait <id>`,
  `/agents stop <id>`, `/agents review <id>`, `/agents sign <id>`,
  `/agents merge <id>`, and `/agents discard <id>` manage the handles.
- A worktree child receives the parent's explicit trust decision because it
  is created from the same base commit. The child does not inherit the
  parent's scoped rules or `filesystem = full`.
- The child inherits the active host model and thinking level unless the
  profile or `--model` selects another. The model pool is resolved before the
  child starts.
- A mutating result stays in its worktree for inspection. The completion
  notice and `subagent/result` event record the absolute worktree path and
  the next review/sign/merge commands. Codepunk never merges child changes
  automatically.
- `/agents review <id>` shows the worktree status, changed files, bounded
  patch, and summary. `/agents sign <id>` asks the human for a
  complete/incomplete verdict and writes a real sign-off into the child
  session's own project store.
- `/agents merge <id>` is accepted only for a child signed complete. It
  freezes the dirty worktree into an exact commit, writes the handoff, merges
  that commit with `git merge --no-ff`, and removes the worktree only after
  proving the child head is contained in the merge commit. The
  `/agents discard <id>` command removes an unmerged registered worktree
  after explicit confirmation; neither path can target the main checkout.
- The child needs a repository with at least one commit so its task spec has
  a real base commit.

If the child answers without calling a tool, the result has no evidence run and
the event carries `evidence_head: null`. If a tool did run but its evidence is
missing, the subagent fails closed instead of returning an unlinked summary.
The child host charges each `tool_execution_start` against the task's
tool-call budget; the wall-clock budget aborts the child as well. This
read-only path has no disk-write surface, so it does not charge disk bytes.
The prompt is delivered over the child's standard input rather than its
command-line arguments.

Child progress is streamed to the parent TUI as bounded `assistant_delta`,
`tool_start`, and `tool_end` events. The raw child stdout JSONL is written to
`artifacts/subagents/<child-session>/transcript.jsonl` with mode `0600`;
`/agents transcript <id>` renders the assistant messages, tool calls, and tool
results, and prints the full artifact path when the preview is truncated. A
child failure reports the transcript path together with any worktree path in
the error and `subagent/result`; a failed run with no changes may still leave
a clean worktree for inspection.
