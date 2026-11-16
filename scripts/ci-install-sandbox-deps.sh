#!/usr/bin/env bash
# Provision the sandbox runtime the test suite exercises on Linux.
#
# Ubuntu runners ship without ripgrep and socat, which `srt` requires before it
# will build a profile, so every sandbox-dependent test fails on a dependency
# check instead of testing the sandbox. macOS sandboxes through the built-in
# sandbox-exec and needs nothing here.
set -euo pipefail

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
