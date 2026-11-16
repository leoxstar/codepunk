#!/usr/bin/env bash
# Provision the sandbox runtime the test suite exercises on Linux.
#
# Ubuntu runners ship without ripgrep and socat, which `srt` requires before it
# will build a profile, so every sandbox-dependent test fails on a dependency
# check instead of testing the sandbox. Ubuntu 24.04 additionally restricts
# unprivileged user namespaces through AppArmor, which strips the capabilities
# bubblewrap needs; `srt` documents this sysctl as the supported CI fix.
# macOS sandboxes through the built-in sandbox-exec and needs nothing here.
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  exit 0
fi

sudo apt-get update
sudo apt-get install -y --no-install-recommends bubblewrap ripgrep socat

# The same probe srt runs before it trusts bubblewrap. If the namespace cannot
# be created, lift the AppArmor restriction and probe once more so a failure
# here names the real cause instead of surfacing as unexplained test errors.
if ! bwrap --unshare-user --dev-bind / / true 2>/dev/null; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  bwrap --unshare-user --dev-bind / / true
fi

echo "bwrap: $(bwrap --version)"
echo "ripgrep: $(rg --version | head -n 1)"
echo "socat: $(socat -V 2>&1 | head -n 1)"
