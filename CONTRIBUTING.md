# Contributing

## Development setup

Use Node.js `>=22.19.0` and pnpm `12.18.0`.

```text
corepack enable
corepack prepare pnpm@12.18.0 --activate
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
```

Day-to-day changes run targeted checks: `pnpm run typecheck`,
`pnpm run check`, `pnpm run format:check`, and `node --test` on the test files
that cover the change. Rebuild with `pnpm run build` when a change affects
build output or a test runs the built CLI. The full `pnpm run verify` chain runs
on release commits; see [`docs/RELEASING.md`](docs/RELEASING.md).

The repository uses a pnpm workspace defined by `pnpm-workspace.yaml`, ESM, and
TypeScript strict mode. `pnpm-lock.yaml` is committed; CI installs with
`pnpm install --frozen-lockfile --ignore-scripts`.

## Package boundaries

The required dependency direction is:

```text
codepunk-protocol <- codepunk-core <- codepunk-cli
```

- `codepunk-protocol` owns boundary schemas, record shapes, and version
  constants. It does not import `core` or `cli`.
- `codepunk-core` owns the engine and host integration. It imports
  `codepunk-protocol` only.
- `codepunk-cli` owns terminal and headless surfaces. It imports `core` and
  `protocol`, and does not own policy or tool execution.

Cross-package imports must use public `exports` entry points. A boundary change
requires an architecture decision before implementation.

## Dependencies

Runtime dependencies are limited to the reviewed set in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). Versions are exact, not ranges. A
new runtime dependency requires a license check, a maintenance review, and a
reviewed lockfile change. Install scripts remain disabled in development and
CI.

## Tests and negative controls

Tests use behavior names and must not require a live model, network call, or
developer-specific path. Repository checks are exercised by
`tests/repository.test.mjs`; it copies the repository, plants one violation at a
time, asserts the intended rule fails, removes the violation, and asserts the
clean tree passes again.

New product behavior needs a test that can fail when the behavior is removed.
Checks that cannot fail are not evidence of correctness.

## Documentation

Keep required commands and exact pins synchronized with
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). Package READMEs state
responsibility, public API status, invariants, and testing. Documentation links
must be repository-relative and must resolve.

## Commits

Use Conventional Commits:

```text
type(english-scope): English result summary
```

Repository-facing documentation and commit messages use English. Keep one
independently reviewable change per commit. Do not add co-author or
machine-attribution trailers.
