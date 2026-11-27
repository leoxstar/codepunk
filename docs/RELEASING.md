# Releasing Codepunk

This runbook describes the manual `0.1.1` single-package npm release. Release
from a clean checkout after the release commit has passed the repository checks
and the platform statement in `docs/PLATFORMS.md` agrees with the matrix in
`.github/workflows/ci.yml`.

## Architecture of the npm distribution

Codepunk keeps three workspace packages in Git (`codepunk-protocol`,
`codepunk-core`, `codepunk-cli`) to enforce compile-time layer boundaries, while
publishing **only `codepunk-cli`** to the public npm registry:

- `packages/protocol` and `packages/core` are `"private": true` internal
  workspace packages and are never published to npm.
- `packages/cli` bundles `codepunk-protocol`, `codepunk-core`, and `typebox`
  into `dist/index.js` and emits `dist/host-child.js` for isolated subprocess
  plugins.

## Prerequisites

- Use Node.js `>=22.19.0`, pnpm `12.18.0`, and npm from the active Node.js
  installation.
- Confirm the working tree is clean and the root and workspace manifests all
  report version `0.1.1`.
- Confirm the package contents, metadata, and dependency versions with
  `pnpm run verify` and the package checks below.
- On Linux, install the sandbox dependencies required by
  `scripts/ci-install-sandbox-deps.sh`; macOS uses the built-in Seatbelt
  sandbox.
- Confirm npm authentication and publish access for `codepunk-cli`:

  ```text
  npm whoami
  ```

  `npm whoami` is the authentication check. `npm publish --dry-run` does not
  prove that the current npm session is authenticated.

## Preflight

Run the following Bash commands from the repository root. Check versions,
metadata, private workspace flags, and the `codepunk-cli` tarball contents
before publishing:

```bash
(
  set -euo pipefail
  for internal_pkg in protocol core; do
    jq -e '.version == "0.1.1" and .private == true and
      (.publishConfig == null) and (.files == null)' \
      "packages/$internal_pkg/package.json"
  done
  jq -e '.version == "0.1.1" and
    .repository.url == "git+https://github.com/leoxstar/codepunk.git" and
    .publishConfig.access == "public" and
    (.dependencies["codepunk-core"] == null) and
    (.dependencies["codepunk-protocol"] == null)' "packages/cli/package.json"
  (cd "packages/cli" && npm pack --dry-run --json) | jq -e '
    .[0].files | map(.path) |
    all(test("^(dist/|README\\.md$|LICENSE$|package\\.json$)")) and
    any(. == "README.md") and any(. == "LICENSE") and
    any(. == "package.json") and any(. == "dist/index.js") and
    any(. == "dist/host-child.js")'
)
```

Run `pnpm run verify` on the release commit. Audit the current dependency tree
and retain the JSON output and exit code with the release evidence:

```bash
(
  set -euo pipefail
  audit_file="$(mktemp)"
  audit_status=0
  pnpm audit --json > "$audit_file" || audit_status=$?
  printf 'Audit output: %s; exit: %s\n' "$audit_file" "$audit_status"
  test "$audit_status" -eq 1
  jq -e --arg ghsa 'GHSA-mrhx-c7xc-m3w5' '
    .metadata.vulnerabilities.high == 1 and
    .metadata.vulnerabilities.critical == 0 and
    ([.advisories[] | select(.severity == "high")] | length == 1) and
    ([.advisories[] | select(.severity == "high" and
      (.url | endswith("/" + $ghsa)))] | length == 1)' "$audit_file"
)
```

The expected result is exit `1` with one high advisory,
`GHSA-mrhx-c7xc-m3w5`. Stop if a new high advisory appears and review it before
releasing. If an upstream version now supports a safe `zod >=4.6.6` path,
upgrade, rerun all release checks, and remove the accepted-risk statement from
`CHANGELOG.md` before publishing.

Run the publish preview for `codepunk-cli`. Use npm for this check; a pnpm dry
run does not produce the npm publish output required here. The command must exit
`0`:

```bash
(cd packages/cli && npm publish --dry-run --access public)
```

The preview must report `codepunk-cli@0.1.1`, include `public access (dry-run)`,
and exit successfully. A preview does not publish anything.

## Publish and retire superseded 0.1.0 packages

Publish `codepunk-cli@0.1.1` **before** unpublishing `codepunk-cli@0.1.0` and
`codepunk-cli@0.0.0-stage` so `codepunk-cli` is never left with zero published
versions (avoiding npm's 24-hour empty-package cooldown). Once
`codepunk-cli@0.1.1` is live, remove `codepunk-cli@0.1.0`,
`codepunk-cli@0.0.0-stage`, and the retired `codepunk-core` and
`codepunk-protocol` packages completely:

```bash
(
  set -euo pipefail
  trap 'status=$?; printf "Release stopped with exit %s; record the disposition.\n" "$status" >&2' ERR

  require_absent() {
    local spec="$1" output status=0
    output="$(npm view "$spec" version 2>&1)" || status=$?
    printf '%s: exit %s\n%s\n' "$spec" "$status" "$output"
    if [ "$status" -eq 0 ] || ! grep -Fq 'E404' <<< "$output"; then
      return 1
    fi
  }

  wait_for_registry() {
    local spec="$1" expected="$2" start="$SECONDS" attempt=0 elapsed remaining timeout
    local attempt_start output status wait_seconds
    while :; do
      elapsed=$((SECONDS - start))
      if [ "$elapsed" -ge 60 ]; then break; fi
      remaining=$((60 - elapsed))
      timeout=$((remaining * 1000))
      if [ "$timeout" -gt 5000 ]; then timeout=5000; fi
      attempt_start="$SECONDS"
      attempt=$((attempt + 1))
      status=0
      output="$(npm view "$spec" version \
        --fetch-retries=0 --fetch-timeout="$timeout" 2>&1)" || status=$?
      printf '%s attempt %s: exit %s\n%s\n' \
        "$spec" "$attempt" "$status" "$output"
      if [ "$status" -eq 0 ] && [ "$output" = "$expected" ]; then return 0; fi
      if [ "$status" -eq 0 ] || ! grep -Fq 'E404' <<< "$output"; then
        return 1
      fi
      wait_seconds=$((attempt_start + 5 - SECONDS))
      if [ "$wait_seconds" -gt 0 ]; then sleep "$wait_seconds"; fi
    done
    printf 'No registry confirmation within 60 seconds after %s attempts.\n' "$attempt" >&2
    return 1
  }

  require_absent "codepunk-cli@0.1.1"
  (cd packages/cli && npm publish --access public)
  wait_for_registry "codepunk-cli@0.1.1" "0.1.1"

  # Remove superseded CLI versions while 0.1.1 remains live on latest
  npm unpublish codepunk-cli@0.1.0
  npm unpublish codepunk-cli@0.0.0-stage

  # Retire standalone internal packages in reverse dependency order
  npm unpublish codepunk-core --force
  npm unpublish codepunk-protocol --force
)
```

## Verify the release

Verify the published CLI version, absence of internal runtime dependencies, and
the registry tarball:

```bash
(
  set -euo pipefail
  temp_dir="$(mktemp -d)"
  trap 'rm -rf -- "$temp_dir"' EXIT
  test "$(npm view codepunk-cli@0.1.1 version)" = "0.1.1"
  npm view codepunk-cli@0.1.1 dependencies --json | jq -e \
    '(.["codepunk-core"] == null) and (.["codepunk-protocol"] == null)'

  tarball="$(npm view "codepunk-cli@0.1.1" dist.tarball)"
  curl -fsSL "$tarball" -o "$temp_dir/cli.tgz"
  tar -tzf "$temp_dir/cli.tgz" > "$temp_dir/cli.entries"
  for entry in package/LICENSE package/README.md package/package.json package/dist/index.js package/dist/host-child.js; do
    count="$(grep -Fxc "$entry" "$temp_dir/cli.entries" || true)"
    test "$count" -eq 1
  done
)
```

After the CLI release is visible in npm, collect the next compatibility corpus
from the exact published version. Use a temporary `CODEPUNK_HOME` and a
temporary project outside this repository; do not generate or edit fixture bytes
by hand. Cover the current compatibility contract's required session and store
scenarios, write every JSON and TOML store that release can produce, replace
local absolute paths with `{{PROJECT}}` and `{{HOME}}`, and record every file
digest plus the capture commands, npm integrity, OS, and Node version in
`tests/fixtures/compat/<version>/MANIFEST.json`.

The corpus must come from the real published package. If a required capability
can only be exercised interactively, record the exact PTY command and inputs in
the manifest. Do not backfill missing data from the development checkout or
change the corpus to make a failing test pass; regenerate it from the published
release instead.

For stores that the published CLI cannot write directly but the published
`codepunk-core` exports, collect them with a repository script that imports the
exact published core package and a fixed clock. Keep capture scratch state under
the system temporary directory, replace local absolute paths with manifest
placeholders, and append only newly generated files to the corpus. Record
transient or non-writing stores in `excludedStores` with the actual probe
command or lifecycle evidence. Record capture-only files that are not stores in
`excludedCaptureArtifacts`; do not leave either kind in `notCovered`.

Perform a clean global-install smoke test with no Codepunk state in the
temporary home. Run it on each release target with the sandbox dependencies
installed. The only expected `doctor` error is the missing model; another
error, including a missing sandbox dependency, fails the smoke test.

```bash
(
  set -euo pipefail
  temp_dir="$(mktemp -d)"
  trap 'rm -rf -- "$temp_dir"' EXIT
  mkdir "$temp_dir/home"
  cd "$temp_dir"

  install_status=0
  HOME="$temp_dir/home" npm install -g --prefix "$temp_dir/prefix" codepunk-cli@0.1.1 || install_status=$?
  printf 'npm install exit: %s\n' "$install_status"
  test "$install_status" -eq 0

  version_status=0
  version_output="$(HOME="$temp_dir/home" "$temp_dir/prefix/bin/codepunk" --version 2>&1)" || version_status=$?
  printf '%s\nversion exit: %s\n' "$version_output" "$version_status"
  test "$version_status" -eq 0
  test "$(printf '%s\n' "$version_output" | sed -n '1p')" = 'codepunk 0.1.1'
  grep -Fq 'source: not installed (cannot compare)' <<< "$version_output"
  ! grep -Fq 'STALE' <<< "$version_output"

  doctor_status=0
  doctor_output="$(HOME="$temp_dir/home" "$temp_dir/prefix/bin/codepunk" doctor 2>&1)" || doctor_status=$?
  printf '%s\ndoctor exit: %s\n' "$doctor_output" "$doctor_status"
  test "$doctor_status" -eq 1
  grep -Fq '[ok] distribution: package version 0.1.1' <<< "$doctor_output"
  error_lines="$(grep -F '[error]' <<< "$doctor_output" || true)"
  test "$error_lines" = '[error] model: no model configured'

  self_install_status=0
  self_install_output="$(HOME="$temp_dir/home" "$temp_dir/prefix/bin/codepunk" install \
    --package-version 0.1.1 --dry-run 2>&1)" || self_install_status=$?
  printf '%s\nself-install exit: %s\n' "$self_install_output" "$self_install_status"
  test "$self_install_status" -eq 0
  grep -Fq 'npm install --global --no-audit --no-fund codepunk-cli@0.1.1' <<< "$self_install_output"
)
```

## Windows release smoke

Run this section only on a real Windows 11 x64 machine with Node.js
`22.19.0`, npm from that Node.js installation, and one administrator-run srt-win
provisioning completed. `windows-latest` is Windows Server 2025 hosted CI; it
is not Windows 11 evidence and cannot replace this smoke test. If the machine,
the provisioning step, or an independent acceptance reviewer is missing, record
the Windows result as `unverified` and do not claim Windows support in the
release notes.

Install the single local `codepunk-cli` tarball with one `npm install` command,
keep the `--loglevel=http` output with the release evidence, and verify the
installed entry resolves under the local prefix (`codepunk --version` and
`npm ls --global --prefix <prefix> --json`):

```powershell
$ErrorActionPreference = "Stop"
$pack = Join-Path $env:TEMP "codepunk-pack"
$prefix = Join-Path $env:TEMP "codepunk-prefix"
$cpHome = Join-Path $env:TEMP "codepunk-home"
Remove-Item -Recurse -Force $pack, $prefix, $cpHome -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $pack, $prefix, $cpHome | Out-Null
$env:CODEPUNK_HOME = $cpHome
$env:USERPROFILE = $cpHome

npm pack --pack-destination $pack .\packages\cli
npm install -g --prefix $prefix --no-audit --no-fund --loglevel=http `
  (Join-Path $pack "codepunk-cli-0.1.1.tgz")

$bin = Join-Path $prefix "codepunk.cmd"
if (-not (Test-Path $bin)) { throw "codepunk shim missing: $bin" }
& $bin --version
if ($LASTEXITCODE -ne 0) { throw "--version exited $LASTEXITCODE" }
```

On the provisioned snapshot, `doctor` must exit `1` with `platform` and `srt`
both `[ok]`, and the only error must be the missing model:

```powershell
$doctor = & $bin doctor 2>&1 | Out-String
$doctorCode = $LASTEXITCODE
$doctor
if ($doctorCode -ne 1) { throw "doctor exited $doctorCode" }
$errors = [regex]::Matches($doctor, '(?m)^\[error\] ([a-z-]+):') |
  ForEach-Object { $_.Groups[1].Value } | Sort-Object
if (($errors -join ",") -ne "model") { throw "unexpected errors: $($errors -join ",")" }
if ($doctor -notmatch '(?m)^\[ok\] platform: win32 x64$') { throw "platform is not ok" }
if ($doctor -notmatch '(?m)^\[ok\] srt:') { throw "srt is not ok" }
```

On an unprovisioned Windows 11 x64 snapshot, `platform` must stay `[ok]` while
`srt` and `model` are `[error]`, and the srt hint must print the one-time
`npx --yes @anthropic-ai/sandbox-runtime@0.0.82 windows-install` instruction
without elevating automatically.

Check the local install, upgrade, and uninstall command semantics, then remove
the local install. Registry upgrade remains part of spec 0004 and is not
covered here.

```powershell
& $bin install --package-version 0.1.1 --dry-run
if ($LASTEXITCODE -ne 0) { throw "install dry-run exited $LASTEXITCODE" }
& $bin upgrade --dry-run
if ($LASTEXITCODE -ne 0) { throw "upgrade dry-run exited $LASTEXITCODE" }
& $bin uninstall --prefix $prefix --dry-run
if ($LASTEXITCODE -ne 0) { throw "uninstall dry-run exited $LASTEXITCODE" }
& $bin uninstall --prefix $prefix
if ($LASTEXITCODE -ne 0) { throw "uninstall exited $LASTEXITCODE" }
if (Test-Path $bin) { throw "codepunk shim remains after uninstall" }
```

Record the Windows version and build, architecture, Node/npm versions, srt-win
version, provisioning exit code, `icacls` output for the private files, ConPTY
exit code, and every command exit code in the release evidence. The Windows
release claim stays blocked until the spec 0007 acceptance records exist for
all of these checks.

## Tag the release

Create an annotated tag on the release commit, then push the tag and verify the
remote ref:

```text
git tag -a v0.1.1 -m "Release v0.1.1"
test "$(git cat-file -t v0.1.1)" = "tag"
test "$(git rev-list -n1 v0.1.1)" = "$(git rev-parse HEAD)"
git push origin v0.1.1
git ls-remote --tags origin refs/tags/v0.1.1 | grep -q 'refs/tags/v0.1.1$'
grep -q '^## \[0.1.1\]' CHANGELOG.md
grep -q 'GHSA-mrhx-c7xc-m3w5' CHANGELOG.md
```

Confirm that `CHANGELOG.md` contains `## [0.1.1]` and
`GHSA-mrhx-c7xc-m3w5` before considering the release recorded.

## Failures and rollback

Before publishing, revert the release commit if the verification fails; the
registry has no side effects at that point. After a package is published, npm
versions are immutable. Record the exact exit code and disposition for every
failure; do not silently retry:

- Do not republish the same version or delete the tag.
- If only part of the ordered publish completed, do not republish the packages
  that already succeeded. Fix the remaining packages and continue with the
  original version only when already published contents do not need to change.
  If published contents must change, deprecate `0.1.0` and release the corrected
  package set as `0.1.1`.
- If the tag or its push fails after publishing, fix or push the tag. If the
  release commit cannot be tagged, publish a patch release and record the
  correction in `CHANGELOG.md`.
- If the clean-install smoke test fails, immediately deprecate every affected
  version and publish a patch. For example:

  ```text
  npm deprecate codepunk-protocol@0.1.0 "Use the corrected release instead."
  ```

  Repeat for each affected package.

- If native dependency installation fails, stop and fix the installation path;
  never use `--ignore-scripts` to conceal it. Stop as well if authentication,
  scope access, or platform statements are inconsistent.
- For a patch release, update `CHANGELOG.md` and create an annotated `v0.1.1`
  tag.
