# codepunk-cli

Owns the terminal and headless surfaces, approval channel, argument handling,
output modes, and exit codes.

## Status

The package provides the TUI, print and JSON modes, operational commands,
interactive approvals, the foreground daemon, and the read-only `view` surface.

## Invariants

- Imports `codepunk-core` and `codepunk-protocol` through public entry points.
- Does not implement policy or execute tools directly.
- Core behavior remains testable without a terminal.
- Windows 11 is not currently supported or claimed as verified.

## Testing

Surface tests cover the terminal, headless output, approvals, commands, and
exit codes. The daemon tests use the built CLI against a real daemon process.
