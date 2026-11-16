# Architecture

## Scope

This document records package ownership, dependency direction, public entry
points, runtime ownership, and excluded surfaces.

## Package graph

```text
packages/cli
  imports -> @codepunk/core, @codepunk/protocol

packages/core
  imports -> @codepunk/protocol

packages/protocol
  imports -> no Codepunk package
```

The formal direction is `protocol <- core <- cli`. A package may use its
declared public entry point only. Relative paths that escape a package root and
subpath imports into another package are rejected.

## Ownership

| Package              | Owns                                                                                                             | Must not own                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `@codepunk/protocol` | Boundary schemas, record shapes, daemon envelopes, version constants                                             | Engine behavior, terminal behavior, host adapters                |
| `@codepunk/core`     | Runtime, policy boundary, approvals, sandbox, tools, evidence, sessions, delivery, workers, daemon server/client | Terminal rendering, command-line parsing, product surface policy |
| `@codepunk/cli`      | TUI, print/JSON output, daemon/view surfaces, approvals channel, arguments, exit codes                           | Policy decisions, direct tool execution, hidden business rules   |

## Public entry points

Each package declares a single `.` export with an ESM import and TypeScript
declaration target under `dist/`. The repository gate rejects wildcard or deep
subpath exports. The public entry points expose the supported product behavior;
internal modules are not importable across package boundaries.

## Dependency policy

The reviewed runtime set is:

| Dependency                        | Exact version | Owner     | License    |
| --------------------------------- | ------------- | --------- | ---------- |
| `@earendil-works/pi-ai`           | `1.5.2`       | core      | MIT        |
| `@earendil-works/pi-coding-agent` | `1.5.2`       | core, cli | MIT        |
| `@earendil-works/pi-mcp`          | `1.5.2`       | core      | MIT        |
| `@earendil-works/pi-tui`          | `1.5.2`       | cli       | MIT        |
| `@anthropic-ai/sandbox-runtime`   | `0.0.82`      | core      | Apache-2.0 |
| `typebox`                         | `1.3.27`      | protocol  | MIT        |

Internal workspace dependencies use the exact version declared in the root
`package.json`, and all three packages carry that same version. Any external
runtime dependency outside this table requires an ADR and a matching checker
update.

## Runtime data boundary

The product repository contains source, tests, product documentation, and
build configuration. It does not contain research, spikes, probes, screenshots,
archives, runtime state, sessions, evidence, logs, caches, editor state, or
local environment files. Generated dependencies and build output are local,
ignored, and never committed.

## Platform boundary

macOS and Linux are the supported development platforms. Windows 11 is not
currently supported or claimed as verified. See
[`PLATFORMS.md`](PLATFORMS.md).

## Change control

Changing package ownership, the dependency direction, the public export shape,
the reviewed runtime dependency set, the supported platform claim, or the
commit policy requires explicit review before implementation.

## Daemon protocol

The in-process v1 surface remains the execution path. A local daemon adds a
second observation surface plus one metadata write. `packages/protocol` owns
the envelopes, payload schemas, limits, and version; `packages/core` owns the
Unix-socket server and client; `packages/cli` exposes the `daemon` and `view`
surfaces. The wire surface accepts `daemon/hello`, `session/list`,
`session/read`, and `session/pin`; `session/pin` is the only method that mutates
stored state, and file writes, approvals, sign-off, append, and work methods
remain absent. Details are in [`PROTOCOL.md`](PROTOCOL.md).
