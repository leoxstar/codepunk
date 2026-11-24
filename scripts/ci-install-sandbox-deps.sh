#!/usr/bin/env bash
# Provision the dependencies the test suite exercises: the sandbox runtime on
# Linux and the search binaries on every runner.
#
# Ubuntu runners ship without ripgrep and socat, which `srt` requires before it
# will build a profile, so every sandbox-dependent test fails on a dependency
# check instead of testing the sandbox. macOS sandboxes through the built-in
# sandbox-exec and needs no sandbox packages, but the search tool resolves rg
# and fd from PATH. Windows hosted runners need the same two search binaries
# and do not provision the privileged srt runtime.
set -euo pipefail

if [ "${RUNNER_OS:-}" = "Windows" ]; then
  echo "sandbox provisioning is skipped on Windows hosted runners"
  dest="$(cygpath -u "${RUNNER_TEMP:-C:/tools}")/codepunk-search"
  dest_win="$(cygpath -m "$dest")"
  mkdir -p "$dest"
  curl -fsSL --retry 3 --retry-delay 2 \
    -o "$dest/ripgrep.zip" \
    "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip"
  curl -fsSL --retry 3 --retry-delay 2 \
    -o "$dest/fd.zip" \
    "https://github.com/sharkdp/fd/releases/download/v10.5.2/fd-v10.5.2-x86_64-pc-windows-msvc.zip"
  seven_zip="/c/Program Files/7-Zip/7z.exe"
  if [ ! -x "$seven_zip" ]; then
    echo "7-Zip is required to extract Windows sandbox dependencies: $seven_zip" >&2
    exit 1
  fi
  "$seven_zip" x -y "-o$dest_win/ripgrep" "$dest_win/ripgrep.zip" >/dev/null
  "$seven_zip" x -y "-o$dest_win/fd" "$dest_win/fd.zip" >/dev/null
  rg_bin="$(find "$dest/ripgrep" -type f -name rg.exe -print -quit)"
  fd_bin="$(find "$dest/fd" -type f -name fd.exe -print -quit)"
  test -n "$rg_bin"
  test -n "$fd_bin"
  cp "$rg_bin" "$dest/rg.exe"
  cp "$fd_bin" "$dest/fd.exe"
  chmod 755 "$dest/rg.exe" "$dest/fd.exe"
  if [ -n "${GITHUB_PATH:-}" ]; then
    printf '%s\n' "$dest_win" >> "$GITHUB_PATH"
  fi
  export PATH="$dest:$PATH"
  "$dest/rg.exe" --version | head -n 1
  "$dest/fd.exe" --version
  exit 0
fi

case "$(uname -s 2>/dev/null || true)" in
  MINGW* | MSYS* | CYGWIN*)
    echo "sandbox dependency provisioning is skipped on Windows shells"
    exit 0
    ;;
esac

if [ "$(uname -s)" = "Darwin" ]; then
  if ! command -v rg >/dev/null 2>&1; then
    HOMEBREW_NO_AUTO_UPDATE=1 brew install ripgrep
  fi
  if ! command -v fd >/dev/null 2>&1; then
    HOMEBREW_NO_AUTO_UPDATE=1 brew install fd
  fi
  rg --version | head -n 1
  fd --version
  exit 0
fi

if [ "$(uname -s)" != "Linux" ]; then
  exit 0
fi

sudo apt-get update
sudo apt-get install -y --no-install-recommends bubblewrap ripgrep socat

# Two AppArmor defaults on Ubuntu 24.04 and later leave unprivileged user
# namespaces without capabilities. `srt` needs a capability-bearing namespace
# twice over: bubblewrap makes one for the command, and the bundled
# apply-seccomp helper makes a nested one for its uid map and
# /proc/self/setgroups. Both controls are lifted here because the suite runs
# with the same sandbox settings a user gets.

# 24.04+: creation still succeeds, but the namespace carries no capabilities.
# The `_unconfined` knob restricts the same creation for processes the distro
# leaves unconfined.
for name in apparmor_restrict_unprivileged_userns \
  apparmor_restrict_unprivileged_unconfined; do
  if [ "$(sysctl -n "kernel.$name" 2>/dev/null || true)" = "1" ]; then
    sudo sysctl -w "kernel.$name=0"
  fi
done

# 25.04+: bwrap-userns-restrict lets bubblewrap create its namespace but
# stacks every child into unpriv_bwrap, which denies all capabilities. The
# sysctl above does not undo a profile transition, and the profile is not tied
# to a boot, so unload it on this ephemeral runner and keep it unloaded.
if [ -f /etc/apparmor.d/bwrap-userns-restrict ]; then
  sudo mkdir -p /etc/apparmor.d/disable
  sudo ln -sf /etc/apparmor.d/bwrap-userns-restrict /etc/apparmor.d/disable/
  sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict || true
fi

# Probe the capability in the context that uses it: a nested user namespace
# inside bubblewrap must be able to take CAP_SYS_ADMIN, which the mount below
# requires. A plain namespace-creation probe passes under both restrictions,
# so it cannot stand in for this one.
if ! bwrap --unshare-user --cap-drop ALL --dev-bind / / -- \
  unshare --user --map-root-user --mount true; then
  echo "nested user namespaces cannot carry capabilities here; srt cannot sandbox" >&2
  exit 1
fi

echo "bwrap: $(bwrap --version)"
echo "ripgrep: $(rg --version | head -n 1)"
echo "socat: $(socat -V 2>&1 | head -n 1)"
