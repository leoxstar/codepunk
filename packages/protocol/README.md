# codepunk-protocol

Owns schemas, record shapes, version constants, and the public types that cross
package boundaries.

## Status

The public entry point contains the versioned boundary schemas, including the
local read-only daemon protocol in `src/daemon.ts`.

## Invariants

- No dependency on `codepunk-core` or `codepunk-cli`.
- Only the reviewed TypeBox dependency is permitted at runtime.
- Consumers import the package entry point, never an internal file.

## Testing

Schema compatibility is exercised by the tests, including daemon protocol
version refusal.
