# codepunk-core

Owns the engine, host adapter, policy, approval broker, sandbox, tools,
evidence, context, model integration, platform adapters, sessions, delivery,
workers, swarm bridge, and the local read-only daemon.

## Status

The package provides the supervised runtime, policy and approval boundary,
sandbox coverage reporting, evidence, Codepunk-owned sessions, supervised
delivery, bounded workers, and the local daemon server and client.

## Invariants

- Imports `codepunk-protocol` only at the package boundary.
- Does not import a terminal surface or `codepunk-cli`.
- Pi, srt, and other host dependencies are accessed through adapters.
- No rendering, argument parsing, or global singleton state.

## Testing

Core tests cover the runtime and security boundaries. The daemon tests exercise
real Unix sockets, concurrent read clients, version refusal, and mutation
refusal.
