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
| build                       | `pnpm run build`                                  |
| built entry points          | `node scripts/check-repo.mjs --require-built`     |
| full local verification     | `pnpm run verify`                                 |

`pnpm run verify` runs formatting, repository checks, type checking, tests, the
build, and the built-entry-point check.

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
@codepunk/protocol <- @codepunk/core <- @codepunk/cli
```

Cross-package imports use the public `exports` entry points. Internal packages
are linked from the workspace through `pnpm-workspace.yaml`; their manifests
remain installable with npm when a release is packed.

## Dependencies

Runtime dependencies are exact and limited to:

| Package                           | Version  | Manifest                        |
| --------------------------------- | -------- | ------------------------------- |
| `@earendil-works/pi-ai`           | `1.5.2`  | `packages/core`                 |
| `@earendil-works/pi-coding-agent` | `1.5.2`  | `packages/core`, `packages/cli` |
| `@earendil-works/pi-mcp`          | `1.5.2`  | `packages/core`                 |
| `@anthropic-ai/sandbox-runtime`   | `0.0.82` | `packages/core`                 |
| `typebox`                         | `1.3.27` | `packages/protocol`             |

Root development dependencies are exact and limited to the Pi test harness
packages `@earendil-works/pi-ai` `1.5.2` and
`@earendil-works/pi-coding-agent` `1.5.2`, Prettier `3.10.1`, TypeScript
`7.0.2`, and Node.js type definitions `@types/node` `22.19.1`. The checker
rejects ranges, tags, URLs, Git specs, untracked runtime packages, unapproved
overrides, and lifecycle scripts. Dependency changes require a reviewed
lockfile diff.

Install and CI commands use `--ignore-scripts`. The dependency tree contains
four transitive packages with install scripts: `@google/genai@2.21.0`,
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

## Continuous integration

`.github/workflows/ci.yml` is configured to run the same install, formatting,
repository, typecheck, test, build, and built-entry checks on `ubuntu-latest`
and `macos-latest`. The workflow uses `pnpm/action-setup` and a frozen lockfile.
Before the test step, `scripts/ci-install-sandbox-deps.sh` installs the Linux
packages `srt` needs (bubblewrap, socat, ripgrep), lifts the two AppArmor
controls on Ubuntu that leave unprivileged user namespaces without
capabilities (`kernel.apparmor_restrict_unprivileged_userns` on 24.04 and
later, and the `bwrap-userns-restrict` profile on 25.04 and later, which the
sysctl does not affect), and probes a nested capability-bearing namespace
inside bubblewrap, the operation `srt`'s seccomp helper performs. On macOS the
script is a no-op because `srt` uses the built-in Seatbelt sandbox. Windows is not a
supported CI platform.

## Repository checks

`scripts/check-repo.mjs` reports stable rule identifiers:

| Rule                       | Guards                                                                 |
| -------------------------- | ---------------------------------------------------------------------- |
| `repo.root`                | Only reviewed root entries are present                                 |
| `repo.docs`                | Required product documentation exists                                  |
| `docs.link`                | Local Markdown links resolve inside the repository                     |
| `docs.absolute`            | Markdown does not link to an absolute path                             |
| `docs.contract`            | Documentation records reviewed commands, pins, and dependency risk     |
| `pkg.layout`               | Exactly the three product packages exist                               |
| `pkg.manifest`             | Identity, module type, license, Node engine, and exact script commands |
| `pkg.exports`              | One public entry point with import/type targets and no deep exports    |
| `pkg.built`                | Built entry points exist and are newer than source                     |
| `deps.direction`           | Internal dependencies follow the package direction                     |
| `deps.pin`                 | Direct dependency versions are exact and match the reviewed set        |
| `deps.review`              | No unreviewed dependency, override, or lifecycle hook                  |
| `deps.lock`                | Reviewed digest, workspace links, resolved versions, and integrity     |
| `source.import`            | No upward, deep, escaping, computed, or research import                |
| `ci.contract`              | Exact workflow digest, triggers, actions, runners, and blocking steps  |
| `repo.controls`            | The reviewed negative-control corpus is present and unchanged          |
| `hygiene.forbidden`        | No research, runtime, generated, log, or editor artifact               |
| `hygiene.env`              | No local environment or credential file; templates remain allowed      |
| `hygiene.binary`           | No binary or NUL-containing file in the product tree                   |
| `security.absolute-path`   | No local personal absolute path                                        |
| `security.credential`      | No obvious credential-shaped value                                     |
| `security.research-import` | No import from verification or research material                       |

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
