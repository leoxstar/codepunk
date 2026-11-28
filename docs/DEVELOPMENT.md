# Development

## Toolchain

| Item       | Requirement                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Node.js    | `>=22.19.0` (`.node-version` pins `22.19.0`)                                                     |
| pnpm       | `12.18.0` (`packageManager` + `pnpm-workspace.yaml` `catalog:`)                                  |
| language   | ESM                                                                                              |
| TypeScript | strict, `NodeNext`, `7.0.2` (`@typescript/native` for `tsc`; TS `6.0.2` for ESLint/scanner APIs) |
| Node types | `@types/node` `22.19.1`                                                                          |
| linter     | ESLint `10.15.0` Flat Config (`typescript-eslint` `8.74.0`, `eslint-plugin-import-x` `4.18.1`)   |
| formatter  | Prettier `3.10.1`                                                                                |
| tests      | Node.js built-in test runner (`node --test --test-timeout=300000`)                               |

The repository pins Node.js in `.node-version`, pnpm in `packageManager`, and
all shared dependencies in the exact-pinned `catalog:` section of
`pnpm-workspace.yaml`. The workspace glob is `packages/*`, and internal
workspace packages link via `"workspace:*"`.

## Commands

| Purpose                     | Command                                           |
| --------------------------- | ------------------------------------------------- |
| clean install               | `pnpm install --frozen-lockfile --ignore-scripts` |
| format                      | `pnpm run format`                                 |
| format check                | `pnpm run format:check`                           |
| static lint                 | `pnpm run lint`                                   |
| repository checks           | `pnpm run check`                                  |
| typecheck                   | `pnpm run typecheck`                              |
| full tests and controls     | `pnpm test`                                       |
| unit tests (non-PTY)        | `pnpm run test:unit`                              |
| PTY integration tests       | `pnpm run test:pty`                               |
| compatibility corpus tests  | `pnpm run test:compat`                            |
| repository & surface checks | `pnpm run test:repo`                              |
| coverage report             | `pnpm run test:coverage`                          |
| deterministic eval          | `pnpm run eval`                                   |
| build                       | `pnpm run build`                                  |
| built entry points          | `node scripts/check-repo.mjs --require-built`     |
| full local verification     | `pnpm run verify`                                 |

`pnpm run verify` runs formatting, ESLint, repository checks, type checking,
tests, the build, and the built-entry-point check.

Check tiers:

- Day-to-day changes run `pnpm run typecheck`, `pnpm run lint`,
  `pnpm run check`, `pnpm run format:check`, and `node --test` on the relevant
  files (or `pnpm run test:unit`). Changes that affect build output also run
  `pnpm run build` and `node scripts/check-repo.mjs --require-built`.
- Release commits run `pnpm run verify`, `pnpm run eval`, and the release
  checklist below.
- Push/PR fast CI runs lint + full Ubuntu tests plus macOS and Windows builds.

## Deterministic eval

`pnpm run eval` runs `eval/run.mjs`, the single entry point for deterministic
behavior regression. It loads cases from `eval/cases.jsonl`, executes them
against the committed code, and compares the pass/fail result to
`eval/baseline.json`.

The baseline is human-reviewed. The runner never rewrites it. Changing a case
expectation or making the baseline threshold vacuous causes a non-zero exit.

The eval proves deterministic regression, not model quality. It does not
replace external benchmarks, and it does not prove that every platform passes.
Ordinary Windows 10 19045 x64 CLI/TUI acceptance completed on 2026-11-28;
Windows-specific OS behavior is still unverified.

## Build identity and stale checkouts

The workspace uses TypeScript Project References (`tsconfig.base.json` +
`tsc -b`) paired with [`packages/cli/build.mjs`](../packages/cli/build.mjs),
which bundles `packages/cli/dist/index.js` and `packages/cli/dist/host-child.js`
with esbuild and injects `__CODEPUNK_VERSION__`, `__SRT_VERSION__`, and
`__BUILD_COMMIT__`. Shared protocol/product constants live in
`packages/protocol/src/constants.ts`, and runtime build metadata lives in
`packages/core/src/build-meta.ts`.

The installed `codepunk` entry runs `packages/cli/dist/index.js`. Editing
`packages/*/src` without rebuilding leaves the terminal on the previous trust
prompt and command surface. `codepunk --version` therefore reports:

- the CLI package version;
- the absolute `dist/index.js` entry being executed;
- the newest dist build time;
- whether every `dist` JavaScript file is current with its TypeScript source.

`codepunk doctor` and the TUI `/doctor` command include the same comparison as
a `build` check. If `codepunk --version`/`/doctor` reports `restart required`,
the running process predates the rebuild; quit and start `codepunk` again.

## Workspace

The dependency direction is:

```text
codepunk-protocol <- codepunk-core <- codepunk-cli
```

Cross-package imports use the public `exports` entry points (enforced by both
`eslint.config.mjs` and `scripts/checks/architecture.mjs`). Internal packages
(`codepunk-protocol` and `codepunk-core`) are private workspace packages linked
through `pnpm-workspace.yaml` and bundled into the single published
`codepunk-cli` package at build time.

## Dependencies

All shared dependencies are pinned to exact versions (no `^` or `~`) in the
`catalog:` block of `pnpm-workspace.yaml`, and package manifests reference
`"catalog:"` and `"workspace:*"`.

Runtime dependencies are exact and limited to:

| Package                           | Version  | Manifest                        |
| --------------------------------- | -------- | ------------------------------- |
| `@earendil-works/pi-ai`           | `1.6.0`  | `packages/core`, `packages/cli` |
| `@earendil-works/pi-coding-agent` | `1.6.0`  | `packages/core`, `packages/cli` |
| `@earendil-works/pi-mcp`          | `1.6.0`  | `packages/core`, `packages/cli` |
| `@earendil-works/pi-tui`          | `1.6.0`  | `packages/cli`                  |
| `@anthropic-ai/sandbox-runtime`   | `0.0.82` | `packages/core`, `packages/cli` |
| `typebox`                         | `1.3.27` | `packages/protocol`             |

Root development dependencies are exact and limited to the Pi test harness
packages (`1.6.0`), `node-pty` (`1.1.0`), ESLint (`10.15.0`) with `@eslint/js`
(`10.0.1`), `typescript-eslint` (`8.74.0`), and `eslint-plugin-import-x`
(`4.18.1`), Prettier (`3.10.1`), TypeScript `7.0.2` (`@typescript/native`) plus
side-by-side TS `6.0.2` (`typescript`) for ESLint/scanner APIs, and
`@types/node` (`22.19.1`). The checker rejects ranges, tags, URLs, Git specs,
untracked runtime packages, unapproved overrides, and lifecycle scripts.
Dependency changes require a reviewed lockfile diff.

Install and CI commands use `--ignore-scripts`. The dependency tree contains
four transitive packages with install scripts: `@google/genai@2.32.0`,
`koffi@3.3.8`, `node-pty@1.1.0`, and `protobufjs@7.6.6`. None of those scripts
run in this repository's install or CI flow. The workspace names all four in
`ignoredBuiltDependencies`, and `deps.lock` structurally verifies every locked
catalog entry, workspace link, and SHA-512 integrity hash across all lockfile
documents.

The workspace applies pnpm's 24-hour minimum release age to new resolutions.
The exact `koffi@3.3.8` family, its `@koromix/koffi-*` platform packages, and
`ws@8.23.0` are explicitly excluded because the current lockfile was reviewed
and pinned before those publication windows closed.

### Dependency review snapshot

The dependency audit is not clean. `pnpm audit --json` exits `1` with one high
finding for `zod@3.25.76` under advisory `GHSA-mrhx-c7xc-m3w5`. The vulnerable
package is reachable through the pinned Pi packages and
`@anthropic-ai/sandbox-runtime@0.0.82`. The reviewed direct pins do not provide
a compatible patched version. This is an accepted-for-development review item,
not a clean audit result. A release requires a reviewed dependency change or
explicit risk acceptance.

## Tests and negative controls

Tests use behavior names rather than internal delivery phases. They must not
require a live model, network call, or developer-specific path. Every test run
applies `--test-timeout=300000` so a hung test cannot stall CI.

`tests/repository.test.mjs` copies the repository into an isolated temporary
directory, plants one violation at a time, and requires the repository checker
to fail with the intended rule. The same file covers positive controls so
Markdown examples, source strings, and environment templates do not produce
false positives.

Compatibility fixtures under `tests/fixtures/compat/<version>/` (covering
`0.1.0` and `0.1.1`) are release evidence generated by exact published
`codepunk-cli` packages. `MANIFEST.json` records capture commands, file
digests, npm integrity, and host versions. Tests never edit fixture bytes to
make a test pass, and Prettier ignores `tests/fixtures/compat/**`.

## Continuous integration

`.github/workflows/ci.yml` is the routine push and pull-request gate. It
ignores docs-only changes, runs formatting, ESLint, repository checks,
typecheck, build, full tests, and eval on Ubuntu 24.04, and build-checks
macOS 15 and Windows Server 2025. The full seven-target matrix lives in
`.github/workflows/full-ci.yml` (manual dispatch or `v*` tags only). Both
workflows share `.github/actions/setup` (Node 24-native actions reading
`.node-version` and `packageManager` and running
`pnpm install --frozen-lockfile --ignore-scripts`). `.github/workflows/release.yml`
creates a GitHub Release from `CHANGELOG.md` on `v*` tag pushes and never
publishes to npm.

CI runners: `ubuntu-24.04`, `ubuntu-24.04-arm`, `ubuntu-26.04`, `macos-15`, `macos-15-intel`, `macos-26`, `windows-latest`.

Before the test step, `scripts/ci-install-sandbox-deps.sh` installs the Linux
packages `srt` needs (bubblewrap, socat, ripgrep), lifts Ubuntu AppArmor
userns restrictions, and verifies bubblewrap nesting; on macOS it installs
missing `rg`/`fd` (using built-in Seatbelt); on Windows it installs pinned
`rg`/`fd` archives.

## Repository checks

`scripts/check-repo.mjs` orchestrates modular checkers under
`scripts/checks/{shared,hygiene,security,packages,architecture,ci,docs,compat}.mjs`
and reports stable rule identifiers:

| Rule                       | Guards                                                                    |
| -------------------------- | ------------------------------------------------------------------------- |
| `repo.root`                | Only reviewed root entries are present                                    |
| `repo.docs`                | Required product documentation exists                                     |
| `repo.lineEndings`         | LF policy and no carriage returns in repository text files                |
| `docs.link`                | Local Markdown links resolve inside the repository                        |
| `docs.absolute`            | Markdown does not link to an absolute path                                |
| `docs.contract`            | Documentation records reviewed commands, pins, and dependency risk        |
| `docs.platforms`           | Exact runner line in three docs and the ordered seven-row CI target table |
| `pkg.layout`               | Exactly the three product packages exist                                  |
| `pkg.manifest`             | Identity, module type, license, `.node-version`, `build.mjs`, scripts     |
| `pkg.exports`              | One public entry point with import/type targets and no deep exports       |
| `pkg.built`                | Built entry points exist and are newer than source (`tsc -b` aware)       |
| `deps.direction`           | Internal dependencies follow the package direction                        |
| `deps.pin`                 | Exact `catalog:` pins and `catalog:` / `workspace:*` manifest references  |
| `deps.review`              | No unreviewed dependency, override, or lifecycle hook                     |
| `deps.lock`                | Structural lockfile version, catalog, workspace links, SHA-512 integrity  |
| `source.import`            | No upward, deep, escaping, computed, or research import                   |
| `cli.size` / `cli.import`  | CLI file/function size caps and lazy TUI boundary                         |
| `core.size`                | Core source file size cap (`<= 1,500` lines)                              |
| `ci.contract`              | Structural workflow triggers, composite setup, actions, runners, gates    |
| `release-smoke`            | Structural `workflow_dispatch`, 6 Unix runners, actions, forbidden steps  |
| `repo.controls`            | Negative-control corpus covers every required rule ID                     |
| `hygiene.forbidden`        | No research, runtime, generated, log, or editor artifact                  |
| `hygiene.env`              | No local environment or credential file; templates remain allowed         |
| `hygiene.binary`           | No binary or NUL-containing file in the product tree                      |
| `security.absolute-path`   | No local personal absolute path                                           |
| `security.credential`      | No obvious credential-shaped value                                        |
| `security.research-import` | No import from verification or research material                          |

## Release checklist

```text
node scripts/bump-version.mjs <version>
pnpm install --frozen-lockfile --ignore-scripts
pnpm run verify
pnpm run eval
pnpm audit --json
git diff --check
git status --short
```

`pnpm audit --json` is expected to exit non-zero while the upstream `zod`
advisory remains unfixed. That known result must not be reported as a clean
audit.
