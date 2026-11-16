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

# Ubuntu 24.04 and later enable kernel.apparmor_restrict_unprivileged_userns.
# The restriction still permits unshare(CLONE_NEWUSER), so a plain bubblewrap
# probe passes, but the namespace it creates carries no capabilities. `srt`
# needs a capability-bearing namespace twice over: bubblewrap's own, and the
# nested one its bundled apply-seccomp helper makes. Under the restriction
# every sandboxed command exits 1 with "nested userns is capability-restricted;
# caller must provide CAP_SYS_ADMIN" while writing /proc/self/setgroups. `srt`
# documents this sysctl as the supported fix and the test suite runs with the
# same sandbox settings a user gets, so disable the restriction on the runner.
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || true)" = "1" ]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi

# Probe the capability itself, not just namespace creation: --mount inside a
# fresh user namespace needs CAP_SYS_ADMIN in it, the same capability the
# seccomp helper is stripped of. This fails where the sandbox would, and names
# the cause instead of leaving it to fourteen unexplained test errors.
if ! unshare --user --map-root-user --mount true; then
  echo "unprivileged user namespaces here cannot carry capabilities; srt cannot sandbox" >&2
  exit 1
fi

echo "bwrap: $(bwrap --version)"
echo "ripgrep: $(rg --version | head -n 1)"
echo "socat: $(socat -V 2>&1 | head -n 1)"
