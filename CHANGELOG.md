# Changelog

All notable changes to Codepunk are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `web_fetch` tool: model-initiated HTTP GET through an approval-gated,
  in-process path that enforces the sandbox `network_deny` domain list and
  refuses private, loopback, and link-local hosts. Every call opens an
  approval card that names the exact URL; approving grants only that call.
- `/plan <request>` enters read-only plan mode and submits the request as a
  planning round; `/plan` without arguments still shows the recorded plan.

## [0.1.0]

### Added

- First public npm release of the Codepunk protocol, core, and CLI packages,
  published as `codepunk-protocol`, `codepunk-core`, and `codepunk-cli` at
  `0.1.0`.

### Fixed

- Fresh or empty `CODEPUNK_HOME` directories, including symlinks to empty
  directories, initialize the current state version instead of reporting a
  pending migration.
- CLI help lists the implemented reviewer show/timeout commands and the trust
  resource-grant flag.
- The published CLI shim resolves from `dist/index.js` under npm 11.

### Security

- Documented the accepted risk for `GHSA-mrhx-c7xc-m3w5`, which affects
  versions `<4.6.6` across 17 transitive dependency paths. Remove this entry
  only after every affected path resolves to a supported version at or above
  `4.6.6` and a fresh audit confirms that the advisory no longer applies.
