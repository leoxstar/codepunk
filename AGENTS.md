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
- Windows support: Windows 10 22H2 (build 19045+) x64 and Windows 11 x64; do
  not claim ARM64, older builds, or unverified Windows OS behavior.
- Keep all paths in documentation and reports repository-relative.
- Governance freeze (from 2026-11-23): until the CLI module split (spec 0014)
  and the TUI component spec are both implemented, do not add new governance
  commands, approval surfaces, policy rule classes, sandbox modes, or trust
  modes. Security fixes, fail-closed defects, release-gate work, and
  behavior-preserving moves are allowed.
- Data compatibility (from 0.1.0, including during development): every release
  must read all persisted data written by earlier releases. Decide
  compatibility by each store's format version, never by the Codepunk, Pi, or
  srt package version. Changing a persisted shape bumps that store's version
  and ships a reader for every older version, a compat fixture, and a negative
  control. A reader that meets a newer version rejects that object without
  rewriting it. Do not remove or rename a config key without a deprecation
  entry. Never edit `tests/fixtures/compat/` to make a test pass.

## Required checks

Day-to-day changes use targeted checks. Before reporting completion, run:

- `pnpm run typecheck`
- `pnpm run check`
- `pnpm run format:check` (run `pnpm run format` first when it fails)
- `node --test` on the test files that cover the change, for example
  `node --test tests/session-resume.test.mjs tests/tui.test.mjs`

When a change affects build output (package manifests, bundling, or a CLI
entry point), or a targeted test runs the built CLI, also run `pnpm run build`
and `node scripts/check-repo.mjs --require-built`.

The full `pnpm run verify` chain runs only on a release commit, as described in
`docs/RELEASING.md`. It remains the single source for the full check chain in
`package.json`. The push-triggered fast CI still runs the full Ubuntu test
suite on `main`; a red fast CI run must be fixed before the next release.

Report which checks ran and which did not. Do not describe a targeted run as a
full verification.

Every check needs a negative control. A green run without a counterexample is
not evidence that the check can fail.
