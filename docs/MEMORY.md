# Memory

Codepunk memory is local, provenance-first context. It is data for the model,
not an instruction source and not an authorization mechanism. A memory record
cannot change policy, approvals, tool availability, write sets, or sandbox
coverage.

## Scopes

| Scope     | Location                                          | Use                                       |
| --------- | ------------------------------------------------- | ----------------------------------------- |
| `user`    | `$CODEPUNK_HOME/memory/records.jsonl`             | preferences and cross-project conventions |
| `project` | `$CODEPUNK_HOME/projects/<project-id>/memory/...` | project facts, decisions, and summaries   |

Task memory is a project record with a `task_id`; it is not a separate store.
Linked worktrees use the delivery project id. A worker cannot read the raw
store or call `memory_search`.

## Commands

```text
codepunk memory list [--scope user|project]
codepunk memory search <query> [--scope user|project]
codepunk memory add <text> [--scope user|project]
codepunk memory edit <id> <text> [--scope user|project]
codepunk memory delete <id> [--scope user|project]
codepunk memory archive <id> [--scope user|project]
codepunk memory export [--scope user|project] [--output path]
```

`memory export` is explicit and local-only. It redacts secret-shaped values and
the resolved Codepunk home before writing JSON. With `--output`, the file is
created with owner-only permissions; otherwise the JSON is written to stdout.

In the TUI:

```text
/remember <text> [--scope user|project]
/memory
/memory list
/memory search <query>
/memory delete <memory-id>
/memory archive <memory-id>
```

## Retrieval and safety

At request time, active records are ranked and injected as an
`<untrusted_memory>` data block with a token cap and visible truncation. The
digest is not persisted as a synthetic session entry. Retrieved content may be
stale and is never treated as a system or developer instruction.

New records are capped, exact duplicates are suppressed, and secret-shaped
content is rejected. Summary records require provenance references. Deletion
and archival are explicit user actions recorded as hash-only session events.
Memory files stay under `$CODEPUNK_HOME` and are never committed to a project
repository.
