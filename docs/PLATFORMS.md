# Platforms

## Supported

| Platform  | Architecture | Shell           | Sandbox          |
| --------- | ------------ | --------------- | ---------------- |
| macOS 13+ | arm64, x64   | Bash/Zsh via Pi | `srt` Seatbelt   |
| Linux     | arm64, x64   | Bash            | `srt` bubblewrap |
| WSL2      | arm64, x64   | Bash            | `srt` bubblewrap |

Node.js `>=22.19.0` is required. Linux needs the dependencies required by the
pinned `srt` release, including bubblewrap, socat, and ripgrep. Run as a
non-root user.

Ubuntu 24.04 and later enable `kernel.apparmor_restrict_unprivileged_userns`,
which still allows unprivileged user namespaces but leaves them without
capabilities. `srt` needs capability-bearing namespaces, so every sandboxed
command fails until the restriction is lifted with
`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, or an AppArmor
profile grants `userns` to both bubblewrap and the bundled `apply-seccomp`
helper.

The table describes supported targets. Automated verification in this
repository has run on macOS arm64 and Linux arm64; macOS x64, Linux x64, and
WSL2 are not separately exercised by the repository test suite.

## Windows

Windows 11 is a target platform but is not currently supported or claimed as
verified. Support requires a real ConPTY TUI smoke test plus a manual `srt`
install and shell check on Windows hardware; hosted CI alone is insufficient.

Until those checks pass, Windows behavior is fail-closed:

- shell execution through the unsupported platform path is disabled;
- the local daemon does not start because it requires a Unix socket;
- the product reports that Windows support is not implemented.

No Windows support claim may be added without the manual verification evidence.

## Search prerequisites

`search` resolves local `rg` and `fd` binaries. It never downloads a binary at
tool-call time. A missing binary fails with an installation hint and a
`codepunk doctor` diagnostic.
