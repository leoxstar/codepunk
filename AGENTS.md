# Agent instructions

## Scope

This repository is the Codepunk product repository. Work only in the requested
goal and product path. Research notes, spikes, probes, verification artifacts,
runtime state, evidence, and local environment files stay outside this
repository.

## Boundaries

- `packages/protocol` has no imports from `core` or `cli`.
- `packages/core` imports `codepunk-protocol` only.
- `packages/cli` may import `codepunk-core` and `codepunk-protocol`.
- Imports between packages use public entry points, never a deep subpath or a
  relative path into another package.
- The CLI does not implement policy or execute tools directly.

## Change rules

- Use English for commit messages and repository-facing documentation.
- Do not add agent behavior outside the active goal.
- Do not add a runtime dependency without license and maintenance review.
- Keep every dependency exact-pinned, including transitive lock entries.
- Do not create a Git commit unless the task explicitly authorizes it.
- Do not claim Windows support.
- Keep all paths in documentation and reports repository-relative.

## Required checks

Run `pnpm run verify` before reporting completion. It is the single source for the full check chain in
`package.json`.

Every check needs a negative control. A green run without a counterexample is
not evidence that the check can fail.
