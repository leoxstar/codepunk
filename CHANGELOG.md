# Changelog

All notable changes to Codepunk are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

No changes have been recorded yet.

## [0.1.0]

### Added

- Release candidate for the Codepunk protocol, core, and CLI packages. The
  candidate is not published to npm until the release runbook completes.

### Security

- Documented the accepted risk for `GHSA-mrhx-c7xc-m3w5`, which affects
  versions `<4.6.6` across 17 transitive dependency paths. Remove this entry
  only after every affected path resolves to a supported version at or above
  `4.6.6` and a fresh audit confirms that the advisory no longer applies.
