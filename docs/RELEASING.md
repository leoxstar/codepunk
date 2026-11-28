# Releasing Codepunk

This runbook describes the manual single-package npm release of `codepunk-cli`.
Release from a clean checkout after the release commit passes all local
verification gates and the platform matrix in `docs/PLATFORMS.md` agrees with
`.github/workflows/full-ci.yml`.

## Architecture of the npm distribution

Codepunk keeps three workspace packages in Git (`codepunk-protocol`,
`codepunk-core`, `codepunk-cli`) to enforce compile-time layer boundaries while
publishing **only `codepunk-cli`** to the public npm registry:

- `packages/protocol` and `packages/core` are `"private": true` internal
  workspace packages and are never published to npm.
- `packages/cli` bundles `codepunk-protocol`, `codepunk-core`, and `typebox`
  into `dist/index.js` and emits `dist/host-child.js` for isolated subprocess
  plugins via `packages/cli/build.mjs`.
- Because `packages/cli/package.json` uses pnpm's `"catalog:"` and
  `"workspace:*"` protocols, **always pack and publish with `pnpm`**
  (`pnpm --filter codepunk-cli pack` / `pnpm --filter codepunk-cli publish`) so
  pnpm rewrites `"catalog:"` and `"workspace:*"` to exact pinned versions in
  the published tarball. Never run raw `npm publish` directly from
  `packages/cli`.

## Prerequisites

- Node.js `>=22.19.0` (`.node-version` pins `22.19.0`), pnpm `12.18.0`, and npm
  from the active Node.js installation.
- Clean working tree with all four manifests bumped to `<version>` via:

  ```bash
  node scripts/bump-version.mjs <version>
  ```

- `CHANGELOG.md` updated with `## [<version>]` (including the current security
  advisory disposition for `GHSA-mrhx-c7xc-m3w5` if still applicable).
- Confirm npm authentication and publish access for `codepunk-cli`:

  ```bash
  npm whoami
  ```

  `npm whoami` is the authentication check. A dry-run publish does not prove
  that the active npm session is authenticated.

## Preflight

Run from the repository root with `VERSION=0.1.2` (substitute the target
version):

```bash
(
  set -euo pipefail
  VERSION="${VERSION:?set VERSION, e.g. 0.1.2}"
  for internal_pkg in protocol core; do
    jq -e --arg v "$VERSION" '.version == $v and .private == true and
      (.publishConfig == null) and (.files == null)' \
      "packages/$internal_pkg/package.json"
  done
  jq -e --arg v "$VERSION" '.version == $v and
    .repository.url == "git+https://github.com/leoxstar/codepunk.git" and
    .publishConfig.access == "public" and
    (.dependencies["codepunk-core"] == null) and
    (.dependencies["codepunk-protocol"] == null)' "packages/cli/package.json"

  # Verify pnpm pack resolves every catalog:/workspace:* reference to exact versions
  temp_dir="$(mktemp -d)"
  trap 'rm -rf -- "$temp_dir"' EXIT
  pnpm --filter codepunk-cli pack --pack-destination "$temp_dir"
  tarball="$temp_dir/codepunk-cli-$VERSION.tgz"
  tar -tzf "$tarball" > "$temp_dir/entries.txt"
  for entry in package/LICENSE package/README.md package/package.json package/dist/index.js package/dist/host-child.js; do
    test "$(grep -Fxc "$entry" "$temp_dir/entries.txt" || true)" -eq 1
  done
  tar -xOzf "$tarball" package/package.json | jq -e '
    ([.dependencies[]?] | all(test("^(catalog:|workspace:)") | not)) and
    ([.dependencies[]?] | all(test("^[0-9]+\\.[0-9]+\\.[0-9]+$")))'
)
```

Run the full verification gate and record the dependency audit:

```bash
pnpm run verify
pnpm run eval
pnpm audit --json > /tmp/codepunk-audit.json || true
```

Confirm that only the reviewed `GHSA-mrhx-c7xc-m3w5` high advisory appears. If
any new high or critical advisory appears, stop and review before releasing.

Preview publishing with pnpm:

```bash
pnpm --filter codepunk-cli publish --access public --dry-run --no-git-checks
```

## Publish to npm

Verify `<version>` does not yet exist on npm, publish with pnpm, and wait for
registry visibility:

```bash
(
  set -euo pipefail
  VERSION="${VERSION:?set VERSION, e.g. 0.1.2}"
  if npm view "codepunk-cli@$VERSION" version >/dev/null 2>&1; then
    printf 'codepunk-cli@%s already exists on npm\n' "$VERSION" >&2
    exit 1
  fi
  pnpm --filter codepunk-cli publish --access public --no-git-checks
  for attempt in $(seq 1 12); do
    if [ "$(npm view "codepunk-cli@$VERSION" version 2>/dev/null || true)" = "$VERSION" ]; then
      printf 'Confirmed codepunk-cli@%s on attempt %s\n' "$VERSION" "$attempt"
      exit 0
    fi
    sleep 5
  done
  printf 'Timed out waiting for codepunk-cli@%s on npm\n' "$VERSION" >&2
  exit 1
)
```

## Tag and GitHub Release

Create an annotated tag on the verified release commit and push it. Pushing
`v<version>` automatically triggers `.github/workflows/full-ci.yml` (7-target
matrix) and `.github/workflows/release.yml` (creates the GitHub Release from
`CHANGELOG.md`; never publishes to npm):

```bash
VERSION="${VERSION:?set VERSION, e.g. 0.1.2}"
git tag -a "v$VERSION" -m "Release v$VERSION"
test "$(git cat-file -t "v$VERSION")" = "tag"
test "$(git rev-list -n1 "v$VERSION")" = "$(git rev-parse HEAD)"
git push origin main "v$VERSION"
git ls-remote --tags origin "refs/tags/v$VERSION" | grep -q "refs/tags/v$VERSION\$"
```

## Post-release verification

1. **Registry tarball check**: download the published tarball and confirm exact
   resolved dependencies (no `"catalog:"` / `"workspace:*"`), identical `LICENSE`,
   and both `dist/index.js` and `dist/host-child.js`.
2. **Six-target Unix `release-smoke`**: dispatch the hosted workflow against
   the published version:

   ```bash
   gh workflow run release-smoke.yml -f version="$VERSION"
   ```

3. **Real upgrade smoke**: install the previous published version into a
   temporary prefix, run `codepunk upgrade --prefix "$prefix"`, verify
   `codepunk --version` reports `<version>`, and verify `CODEPUNK_HOME` state
   survives intact.
4. **Compatibility corpus**: capture `tests/fixtures/compat/<version>/` from
   the exact published `codepunk-cli@<version>` package in an isolated temporary
   workspace using `scripts/collect-compat-0.1.0.mjs` (or successor collector)
   and commit it on the next development commit (D81).
5. **Windows release smoke**: run real-machine installation, `--version`,
   `doctor`, upgrade, and uninstall checks on Windows 10 22H2 (build 19045+) or
   Windows 11 x64. Hosted `windows-latest` (Windows Server 2025) does not
   replace real-machine Windows evidence.

## Failures and rollback

Before publishing, revert or amend the local release commit if any check fails;
the registry has no side effects. After publishing, npm versions are immutable:

- Never republish the same version or move/delete a pushed `v*` tag.
- If a published release fails clean-install or upgrade verification, deprecate
  the broken version immediately and release a patch version:

  ```bash
  npm deprecate "codepunk-cli@$VERSION" "Use the corrected patch release instead."
  ```

- Record exact exit codes and remediation notes in `CHANGELOG.md`.
