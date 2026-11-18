# Platforms

## Supported and CI-covered

| Platform     | Architecture | CI runner          | Shell           | Sandbox          |
| ------------ | ------------ | ------------------ | --------------- | ---------------- |
| Ubuntu 24.04 | x64          | `ubuntu-24.04`     | Bash            | `srt` bubblewrap |
| Ubuntu 24.04 | arm64        | `ubuntu-24.04-arm` | Bash            | `srt` bubblewrap |
| macOS 15     | x64          | `macos-15-intel`   | Bash/Zsh via Pi | `srt` Seatbelt   |
| macOS 26     | arm64        | `macos-26`         | Bash/Zsh via Pi | `srt` Seatbelt   |

These four targets are the only platform and architecture combinations the
project currently claims. The CI matrix runs the full repository gate on each
target: install, formatting, repository checks, typecheck, tests, build, and
built-entry checks. The release runbook additionally requires a clean global
install and `codepunk doctor` smoke test on each release target.

Node.js `>=22.19.0` is required. Linux needs the dependencies required by the
pinned `srt` release, including bubblewrap, socat, and ripgrep. Run as a
non-root user.

Ubuntu 24.04 and later enable `kernel.apparmor_restrict_unprivileged_userns`,
which still allows unprivileged user namespaces but leaves them without
capabilities. Ubuntu 25.04 and later also ship and enable the
`bwrap-userns-restrict` AppArmor profile, which lets bubblewrap create its
namespace but stacks every process it launches into `unpriv_bwrap` and denies
all capabilities there. `srt` needs capability-bearing namespaces for
bubblewrap and for its bundled `apply-seccomp` helper, so every sandboxed
command fails until both controls are lifted:
`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` and either
disabling `bwrap-userns-restrict` or granting `capability sys_admin` through
its `local/unpriv_bwrap` include.

## Documented but not verified

The following environments are documented targets, not verified support
claims. A support claim requires a CI job or a recorded clean-install smoke
test with the exact platform, architecture, Node version, sandbox dependency
state, and exit codes.

- macOS 13 and 14 on arm64 or x64.
- Linux distributions other than Ubuntu 24.04.
- WSL2 on arm64 or x64.
- Windows 11 on arm64 or x64.

WSL2 has no CI job today. Linux x64 and arm64 runners exercise the Linux code
path, but they do not exercise WSL2's kernel, filesystem interop, or Windows
host integration, so they cannot stand in for a WSL2 smoke test.

## Windows

Windows 11 is a target platform but is not currently supported or claimed as
verified. Support requires a real ConPTY TUI smoke test plus a manual `srt`
install, shell check, ACL check, and process-tree termination check on Windows
hardware; hosted CI alone is insufficient.

Until those checks pass, Windows behavior is fail-closed:

- `codepunk doctor` reports a blocking platform error and cannot report
  `doctor: ready`;
- the sandbox probe resolves the pinned `srt-win` helper and reports the
  one-time elevated install needed to provision `srt-sandbox`;
- shell execution stays disabled until that install exists; initialization
  failures never fall back to an unsandboxed shell;
- the local daemon does not start because it requires a Unix socket;
- the product reports that Windows support is not implemented.

No Windows support claim may be added without the manual verification evidence.

## Search prerequisites

`search` resolves local `rg` and `fd` binaries. It never downloads a binary at
tool-call time. A missing binary fails with an installation hint and a
`codepunk doctor` diagnostic.
