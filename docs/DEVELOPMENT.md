# Development

## Toolchain

| Item       | Requirement                  |
| ---------- | ---------------------------- |
| Node.js    | `>=22.19.0`                  |
| pnpm       | `12.18.0`                    |
| language   | ESM                          |
| TypeScript | strict, `NodeNext`, `7.0.2`  |
| Node types | `@types/node` `22.19.1`      |
| formatter  | Prettier `3.10.1`            |
| tests      | Node.js built-in test runner |

The repository pins pnpm through `packageManager` and
`pnpm-workspace.yaml`. The workspace glob is `packages/*`.

## Commands

| Purpose                     | Command                                           |
| --------------------------- | ------------------------------------------------- |
| clean install               | `pnpm install --frozen-lockfile --ignore-scripts` |
| format                      | `pnpm run format`                                 |
| format check                | `pnpm run format:check`                           |
| repository checks           | `pnpm run check`                                  |
| typecheck                   | `pnpm run typecheck`                              |
| tests and negative controls | `pnpm test`                                       |
| deterministic eval          | `pnpm run eval`                                   |
| build                       | `pnpm run build`                                  |
| built entry points          | `node scripts/check-repo.mjs --require-built`     |
| full local verification     | `pnpm run verify`                                 |

`pnpm run verify` runs formatting, repository checks, type checking, tests, the
build, and the built-entry-point check.

Check tiers:

- Day-to-day changes run `pnpm run typecheck`, `pnpm run check`,
  `pnpm run format:check`, and `node --test` on the test files that cover the
  change. Changes that affect build output also run `pnpm run build` and
  `node scripts/check-repo.mjs --require-built`.
- Release commits run `pnpm run verify` and the release checklist below.
- The push-triggered fast CI runs the full Ubuntu test suite on `main`.

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

The installed `codepunk` entry runs `packages/cli/dist/index.js`. Editing
`packages/*/src` without rebuilding leaves the terminal on the previous trust
prompt and command surface. `codepunk --version` therefore reports:

- the CLI package version;
- the absolute `dist/index.js` entry being executed;
- the newest dist build time;
- whether every `dist` JavaScript file is current with its TypeScript source.

`codepunk doctor` and the TUI `/doctor` command include the same comparison as
a `build` check. An interactive startup also warns when `dist` is stale, and
the pre-host `Project trust` footer shows the same build identity before the
decision is made. An installed package without `src` reports the source
comparison as unavailable rather than claiming the build is current.

The same check compares the newest `dist` mtime with the running process start.
If `codepunk --version`/`/doctor` reports `restart required`, this process is
still executing the JavaScript it loaded before a rebuild. Quit that TUI and
start `codepunk` again; a running process does not hot-swap modules after
`pnpm build`.

## Workspace

The dependency direction is:

```text
codepunk-protocol <- codepunk-core <- codepunk-cli
```

Cross-package imports use the public `exports` entry points. Internal packages
(`codepunk-protocol` and `codepunk-core`) are private workspace packages linked
through `pnpm-workspace.yaml` and bundled into the single published
`codepunk-cli` package at build time.

## Dependencies

Runtime dependencies are exact and limited to:

| Package                           | Version  | Manifest                        |
| --------------------------------- | -------- | ------------------------------- |
| `@earendil-works/pi-ai`           | `1.6.0`  | `packages/core`                 |
| `@earendil-works/pi-coding-agent` | `1.6.0`  | `packages/core`, `packages/cli` |
| `@earendil-works/pi-mcp`          | `1.6.0`  | `packages/core`                 |
| `@anthropic-ai/sandbox-runtime`   | `0.0.82` | `packages/core`                 |
| `typebox`                         | `1.3.27` | `packages/protocol`             |

Root development dependencies are exact and limited to the Pi test harness
packages `@earendil-works/pi-ai` `1.6.0` and
`@earendil-works/pi-coding-agent` `1.6.0`, Prettier `3.10.1`, TypeScript
`7.0.2`, and Node.js type definitions `@types/node` `22.19.1`. The checker
rejects ranges, tags, URLs, Git specs, untracked runtime packages, unapproved
overrides, and lifecycle scripts. Dependency changes require a reviewed
lockfile diff.

Install and CI commands use `--ignore-scripts`. The dependency tree contains
four transitive packages with install scripts: `@google/genai@2.32.0`,
`koffi@3.3.8`, `node-pty@1.1.0`, and `protobufjs@7.6.6`. None of those scripts
run in this repository's install or CI flow. The workspace names all four in
`ignoredBuiltDependencies`, so pnpm 12 records the reviewed denial instead of
failing the install and never treats a build as approved. `strictDepBuilds` is
off only because those four denials are explicit and the reviewed lockfile
digest prevents an unreviewed package from entering the tree.

The workspace applies pnpm's 24-hour minimum release age to new resolutions.
The exact `koffi@3.3.8` family, its `@koromix/koffi-*` platform packages, and
`ws@8.23.0` are explicitly excluded because the current lockfile was reviewed
and pinned before those publication windows closed. The lockfile still records
every version and integrity value. Removing an exclusion requires a reviewed
dependency update and a fresh lockfile check in CI.

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
require a live model, network call, or developer-specific path.

`tests/repository.test.mjs` copies the repository into an isolated temporary
directory, plants one violation at a time, and requires the repository checker
to fail with the intended rule. The same file also covers positive controls so
Markdown examples, source strings, and environment templates do not produce
false positives.

Compatibility fixtures under `tests/fixtures/compat/` are release evidence.
They must be generated by the exact published `codepunk-cli` version, and
`MANIFEST.json` records their capture commands, file digests, npm integrity, and
host versions. Tests restore these fixtures to a temporary workspace and
recompute path-derived identifiers and path-bound hashes; they never edit the
fixture itself to make a test pass. A format check must not reformat corpus
bytes, because that would invalidate the manifest digests.

## Continuous integration

`.github/workflows/ci.yml` is the routine push and pull-request gate. It
ignores docs-only changes, runs the full repository gate on Ubuntu 24.04, and
build-checks the macOS 15 and Windows Server 2025 runners. The full
seven-target matrix is in `.github/workflows/full-ci.yml` and runs only from
manual dispatch or a `v*` tag. It is not scheduled, so routine pushes do not
repeat the Windows test suite. Fast run `44480731591` passed all four jobs:
lint 29 s, Ubuntu test 5m46s, macOS build 37 s, and Windows build 54 s. The
current local baseline at `main` (`2ca8739`) reports 820 tests, 811 passing,
0 failing, and 9 skipped; `pnpm run eval` passes 12/12 cases. The release
candidate `c0383fa` reports 818 tests, 809 passing, 0 failing, and 9 skipped,
and full CI run `44473437813` passed all seven targets. `windows-latest`
covers non-privileged Windows checks and is not a real-machine Windows support
claim:

CI runners: `ubuntu-24.04`, `ubuntu-24.04-arm`, `ubuntu-26.04`, `macos-15`, `macos-15-intel`, `macos-26`, `windows-latest`.

Each full-matrix target runs install, formatting, repository, typecheck,
test, eval, build, and built-entry checks. The routine build jobs install and
check only the built entry points; the Ubuntu test job still runs the full
gate. The workflows use `pnpm/action-setup` and a frozen lockfile. WSL2 Ubuntu x64
is manual-smoke only and is not CI-covered. Windows 10 22H2 (build 19045+) and
Windows 11 x64 are supported; the 0007 code and hosted gate are complete, and
ordinary Windows 10 19045 x64 CLI/TUI acceptance completed on 2026-11-28.
Windows-specific OS behavior remains unverified.
Before the test step, `scripts/ci-install-sandbox-deps.sh` installs the Linux
packages `srt` needs (bubblewrap, socat, ripgrep), lifts the two AppArmor
controls on Ubuntu that leave unprivileged user namespaces without
capabilities (`kernel.apparmor_restrict_unprivileged_userns` on 24.04 and
later, and the `bwrap-userns-restrict` profile on 25.04 and later, which the
sysctl does not affect), and probes a nested capability-bearing namespace
inside bubblewrap, the operation `srt`'s seccomp helper performs. On macOS the
script installs missing `rg` and `fd` but needs no sandbox packages because
`srt` uses the built-in Seatbelt sandbox. On Windows it installs `rg` and `fd`
from pinned GitHub release archives and skips privileged `srt` provisioning.

## Repository checks

`scripts/check-repo.mjs` reports stable rule identifiers:

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
| `pkg.manifest`             | Identity, module type, license, Node engine, and exact script commands    |
| `pkg.exports`              | One public entry point with import/type targets and no deep exports       |
| `pkg.built`                | Built entry points exist and are newer than source                        |
| `deps.direction`           | Internal dependencies follow the package direction                        |
| `deps.pin`                 | Direct dependency versions are exact and match the reviewed set           |
| `deps.review`              | No unreviewed dependency, override, or lifecycle hook                     |
| `deps.lock`                | Reviewed digest, workspace links, resolved versions, and integrity        |
| `source.import`            | No upward, deep, escaping, computed, or research import                   |
| `ci.contract`              | Exact workflow digest, triggers, actions, runners, and blocking steps     |
| `repo.controls`            | The reviewed negative-control corpus is present and unchanged             |
| `hygiene.forbidden`        | No research, runtime, generated, log, or editor artifact                  |
| `hygiene.env`              | No local environment or credential file; templates remain allowed         |
| `hygiene.binary`           | No binary or NUL-containing file in the product tree                      |
| `security.absolute-path`   | No local personal absolute path                                           |
| `security.credential`      | No obvious credential-shaped value                                        |
| `security.research-import` | No import from verification or research material                          |

## Release checklist

```text
pnpm install --frozen-lockfile --ignore-scripts
pnpm run verify
pnpm audit --json
git diff --check
git status --short
```

`pnpm audit --json` is expected to exit non-zero while the upstream `zod`
advisory remains unfixed. That known result must not be reported as a clean
audit.
