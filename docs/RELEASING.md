# Releasing Codepunk

This runbook describes the manual `0.1.0` npm release. Release from a clean
checkout after the release commit has passed the repository checks and the
platform statement in `docs/PLATFORMS.md` agrees with the matrix in
`.github/workflows/ci.yml`.

## Prerequisites

- Use Node.js `>=22.19.0`, pnpm `12.18.0`, and npm from the active Node.js
  installation.
- Confirm the working tree is clean and the three packages all report version
  `0.1.0`.
- Confirm the package contents, metadata, and dependency versions with
  `pnpm run verify` and the package checks below.
- On Linux, install the sandbox dependencies required by
  `scripts/ci-install-sandbox-deps.sh`; macOS uses the built-in Seatbelt
  sandbox.
- Confirm npm authentication and `@codepunk` publish access:

  ```text
  npm whoami
  ```

  `npm whoami` is the authentication check. `npm publish --dry-run` does not
  prove that the current npm session is authenticated.

## Preflight

Check the package versions and tarball contents before publishing:

```text
for package in protocol core cli; do
  npm pkg get version --prefix "packages/$package"
  (cd "packages/$package" && npm pack --dry-run --json)
done
```

Run the publish preview for each package. Use npm for this check; a pnpm dry
run does not produce the npm publish output required here:

```text
(cd packages/protocol && npm publish --dry-run --access public)
(cd packages/core && npm publish --dry-run --access public)
(cd packages/cli && npm publish --dry-run --access public)
```

Each preview must report the package name and `0.1.0`, include `public access
(dry-run)`, and exit successfully. A preview does not publish anything.

## Publish order

Publish the packages in dependency order. After each package succeeds, wait for
the registry lookup to return `0.1.0` before continuing:

```text
(cd packages/protocol && npm publish --access public)
npm view @codepunk/protocol@0.1.0 version

(cd packages/core && npm publish --access public)
npm view @codepunk/core@0.1.0 version

(cd packages/cli && npm publish --access public)
npm view @codepunk/cli@0.1.0 version
```

The order is `@codepunk/protocol`, then `@codepunk/core`, then
`@codepunk/cli`. If a lookup returns `E404`, retry the lookup at bounded
intervals for up to 60 seconds; do not repeat a successful publish.

## Verify the release

Verify versions, internal dependencies, and the registry tarballs:

```text
test "$(npm view @codepunk/cli@0.1.0 version)" = "0.1.0"
npm view @codepunk/core@0.1.0 dependencies --json
npm view @codepunk/cli@0.1.0 dependencies --json

for package in protocol core cli; do
  temp_dir="$(mktemp -d)"
  curl -fsSL "$(npm view "@codepunk/$package@0.1.0" dist.tarball)" -o "$temp_dir/package.tgz"
  tar -tzf "$temp_dir/package.tgz"
  rm -rf "$temp_dir"
done
```

Perform a clean global-install smoke test with no Codepunk state in the
temporary home:

```text
temp_dir="$(mktemp -d)"
HOME="$temp_dir/home" npm install --global --prefix "$temp_dir/prefix" @codepunk/cli@0.1.0
HOME="$temp_dir/home" "$temp_dir/prefix/bin/codepunk" --version
HOME="$temp_dir/home" "$temp_dir/prefix/bin/codepunk" doctor
rm -rf "$temp_dir"
```

The version command must report `0.1.0`. `doctor` should report the package
version and identify the missing model configuration in the clean home.

## Tag the release

Create an annotated tag on the release commit, then push the tag and verify the
remote ref:

```text
git tag -a v0.1.0 -m "Release v0.1.0"
test "$(git cat-file -t v0.1.0)" = "tag"
test "$(git rev-list -n1 v0.1.0)" = "$(git rev-parse HEAD)"
git push origin v0.1.0
git ls-remote --tags origin refs/tags/v0.1.0
```

Confirm that `CHANGELOG.md` contains `## [0.1.0]` and
`GHSA-mrhx-c7xc-m3w5` before considering the release recorded.

## Rollback

Before publishing, revert the release commit if the verification fails; the
registry has no side effects at that point. After a package is published, npm
versions are immutable:

- Do not republish the same version or delete the tag.
- If a published package is defective, deprecate the affected version:

  ```text
  npm deprecate @codepunk/protocol@0.1.0 "Use the corrected release instead."
  ```

  Repeat for each affected package.

- Publish the corrected package set as `0.1.1`, update `CHANGELOG.md`, and
  create an annotated `v0.1.1` tag.
- If only part of the ordered publish completed, do not republish the packages
  that already succeeded. Fix the remaining packages and continue with the
  original version only when their contents do not need to change; otherwise
  release the corrected set as `0.1.1`.
