# Single-worker delivery

Delivery starts with a deliberately single-worker path: a task is specified, a
worker gets a detached worktree, the worker produces a handoff, and a human
merges the exact commit. The product never auto-merges.

## Task specification

`createTaskSpec` records the task id, objective, base commit, write set,
protected paths, acceptance criteria, and budget. The returned spec is frozen
and carries `spec_sha256`; a worker cannot rewrite it. The default protected
paths are `AGENTS.md`, `CLAUDE.md`, and `.codepunk/`.

`TaskGraph` is the task-state projection. Its allowed path is:

```text
queued -> claimed -> running -> submitted -> review_passed -> merged -> closed
```

`blocked`, `failed`, and `abandoned` are terminal or retry states; an invalid
transition throws instead of silently changing state.

## Worktree and handoff

`createDetachedWorktree` creates a detached Git worktree under the system
temporary directory, outside the delivery root, with mode `0700` and an
owner check. It does not create a worker branch. Cleanup only succeeds when the
worktree is clean and still at the base commit, so unpushed worker commits are
preserved.

`createHandoff` requires a clean worktree and a non-empty evidence chain. It
records:

- base and head commits, tree, and a sha256 of the full binary diff;
- changed paths and per-file before/after hashes read from the two commit
  trees;
- the evidence session, sequence range, and head;
- the immutable task spec and write set;
- the review verdict and any open issues.

Single-worker handoffs have empty claim, fence, and lease fields. The
multi-worker path adds persistent claims.

## Human merge

`mergeHandoff` rejects a merge unless:

- the caller supplies an explicit human actor;
- the task is review-passed and has a human sign-off;
- the source worktree still points at the handoff head;
- the base, tree, changed paths, file hashes, diff hash, and evidence chain all
  match the exact commit;
- every changed path is inside the write set and outside protected paths;
- the target repository is clean and still at the task base.

The merge uses the exact commit id with `git merge --no-ff`. A merge record is
written under `projects/<project-id>/merges/<task>/<merge-id>.json`; a branch
name is never used as the merge source.

`verifyPostMerge` only returns `complete` when the post-merge run is bound to
the merge commit and tree, the handoff head is an ancestor of the merge, the
merged path set stays within the write set, and the post-merge evidence chain
matches the signed verdict. A run on another commit is `unverifiable`.

## Human-gated subagent delivery

The TUI exposes the same checks for profile-driven `/subagent` work:

```text
/agents review <id>   show status, changed files, bounded patch, and summary
/agents transcript <id>
                      render assistant messages, tool calls, and tool results
/agents sign <id>     record a human complete/incomplete verdict
/agents merge <id>    freeze, hand off, merge the exact commit, then clean up
/agents discard <id>  remove an unmerged registered worktree after confirmation
```

`/agents sign` writes the sign-off through the child session's project store,
because its project id can differ from the parent checkout. The sign-off is
bound to the child evidence head; a model summary is not a verdict.
`/agents transcript <id>` renders the complete `0600` child stdout artifact.

`/agents merge` additionally requires the parent `HEAD` to equal the child's
recorded base commit, a parent working tree clean outside Codepunk's generated
`.codepunk/.gitignore`, and a human confirmation. The dirty child worktree is
frozen into a commit inside `freezeWorktree`; protected instruction and
`.codepunk` paths fail closed. The handoff is written under the parent
project's `handoffs/` directory and the merge record under `merges/`.

The worktree path must be a registered linked worktree of the parent
repository. Cleanup verifies that the child `HEAD` is an ancestor of the merge
commit before using a bounded forced removal for the generated Codepunk state;
discard requires a separate human confirmation. The main checkout is never a
valid target for either operation.

## RequirementTeam

`runRequirementTeam` accepts three or four reviewers with distinct angles
(product, engineering, security, cost). Reviewers get only `read` and `search`
tools. A local human TTY chair must confirm the requirement; model output
cannot self-approve. The confirmed requirement becomes the hash-bound
`TaskSpec` used by delivery.
