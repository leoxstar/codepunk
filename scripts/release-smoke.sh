#!/usr/bin/env bash
# Install the published codepunk-cli package into an empty prefix and verify
# the package identity, doctor contract, and absence of a silent fallback.
set -euo pipefail

version="${1:-${CODEPUNK_RELEASE_SMOKE_VERSION:-0.1.2}}"
if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  printf 'release-smoke: invalid version %s\n' "$version" >&2
  exit 2
fi

expected_node="${CODEPUNK_RELEASE_SMOKE_NODE_VERSION:-v22.19.0}"
actual_node="$(node --version)"
if [ "$actual_node" != "$expected_node" ]; then
  printf 'release-smoke: node %s does not match %s\n' \
    "$actual_node" "$expected_node" >&2
  exit 1
fi

export NO_COLOR=1
temp="$(mktemp -d "${TMPDIR:-/tmp}/codepunk-release-smoke.XXXXXX")"
cleanup() {
  rm -rf -- "$temp"
}
trap cleanup EXIT

mkdir -p "$temp/home" "$temp/prefix"
export HOME="$temp/home"
unset CODEPUNK_HOME

npm_bin="${CODEPUNK_RELEASE_SMOKE_NPM:-npm}"
"$npm_bin" install -g --prefix "$temp/prefix" --no-audit --no-fund \
  "codepunk-cli@$version" >"$temp/install.log" 2>&1

bin="$temp/prefix/bin/codepunk"
if [ ! -x "$bin" ]; then
  printf 'release-smoke: installed codepunk shim is missing at %s\n' "$bin" >&2
  exit 1
fi

version_output="$("$bin" --version)"
first_line="${version_output%%$'\n'*}"
if [ "$first_line" != "codepunk $version" ]; then
  printf 'release-smoke: unexpected --version first line: %s\n' \
    "$first_line" >&2
  exit 1
fi
if printf '%s\n' "$version_output" | grep -q 'STALE'; then
  printf 'release-smoke: installed package reported a stale build\n' >&2
  exit 1
fi
if ! printf '%s\n' "$version_output" |
  grep -Fq 'source: not installed (cannot compare)'; then
  printf 'release-smoke: installed package did not report its source status\n' >&2
  exit 1
fi

doctor_code=0
"$bin" doctor >"$temp/doctor.log" 2>&1 || doctor_code=$?
if [ "$doctor_code" -ne 1 ]; then
  printf 'release-smoke: doctor exited %s, expected 1\n' "$doctor_code" >&2
  sed -n '1,160p' "$temp/doctor.log" >&2
  exit 1
fi

doctor_expect() {
  if ! grep -Fq "$1" "$temp/doctor.log"; then
    printf 'release-smoke: doctor output is missing: %s\n' "$1" >&2
    sed -n '1,160p' "$temp/doctor.log" >&2
    exit 1
  fi
}

doctor_expect "[ok] distribution: package version $version"
doctor_expect "[ok] platform:"
doctor_expect "[ok] srt:"
doctor_expect "[error] model: no model configured"
error_count="$(grep -c '^\[error\] ' "$temp/doctor.log" || true)"
if [ "$error_count" -ne 1 ]; then
  printf 'release-smoke: doctor reported %s errors, expected exactly 1\n' \
    "$error_count" >&2
  sed -n '1,160p' "$temp/doctor.log" >&2
  exit 1
fi

printf 'release-smoke: version=%s\n' "$version"
printf 'release-smoke: node=%s\n' "$actual_node"
printf 'release-smoke: npm=%s\n' "$(npm --version)"
printf 'release-smoke: os=%s %s\n' "$(uname -s)" "$(uname -m)"
printf 'release-smoke: doctor=%s errors=%s\n' "$doctor_code" "$error_count"
printf 'release-smoke: runtime smoke unverified (no model configured)\n'
