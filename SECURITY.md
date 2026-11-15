# Security policy

## Reporting

Report vulnerabilities through the repository host's private vulnerability
reporting channel. Do not open a public issue containing credentials, personal
data, local paths, or a working exploit.

## Supported platforms

macOS and Linux are the supported development platforms. Windows 11 is not
currently supported or claimed as verified. See
[`docs/PLATFORMS.md`](docs/PLATFORMS.md).

## Security model

Codepunk separates policy from sandboxing:

- Policy decides what an action is allowed to attempt.
- A sandbox backend enforces filesystem, process, and network confinement for
  the surfaces that use it.
- Coverage is reported per surface. File tools are app-layer constrained unless
  a kernel-level file sandbox is added.
- Plugins, MCP servers, extensions, and explicit unsandboxed shell commands are
  trusted local code. Direct execution surfaces are reported as uncovered.

Approvals are local, short-lived, and bound to the request context. An IM
message, plugin, or model response cannot approve a tool call.

## Secrets and local data

- Credentials, tokens, private keys, environment values, session state,
  evidence, logs, and local paths are not committed.
- Runtime user data belongs under the user Codepunk home, never this repository.
- Raw records may contain data printed by a command; local state is owner-only,
  evidence stores hashes and redacted previews, and exports apply redaction.
- `scripts/check-repo.mjs` performs repository hygiene and credential-shape
  checks. It is not a complete secret scanner. Release work requires a separate
  secret-scanning pass.

## Extensions and direct execution

Extension code, plugins, MCP servers, browsers, and other direct execution
surfaces are not automatically covered by the policy or sandbox. Any new
execution surface must update the coverage matrix in the same change.

## Dependency and supply-chain review

Runtime dependencies are exact-pinned and license-reviewed. The lockfile is
committed. Development and CI install with
`pnpm install --frozen-lockfile --ignore-scripts`; an install script needs
explicit review and a documented exception before it may run.

The current dependency audit is not clean. One high finding remains in
`zod@3.25.76` through the pinned Pi packages and
`@anthropic-ai/sandbox-runtime@0.0.82`. The finding is recorded in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) and is not converted into a clean
audit result or silently accepted.

`srt` is Apache-2.0. Its notices must ship with any distribution that includes
it. Do not replace a missing sandbox with an unsandboxed fallback.
