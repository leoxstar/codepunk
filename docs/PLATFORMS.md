# Platforms

## CI targets

These are the seven targets in the full release matrix. Full CI run
`44473437813` passed all seven jobs, including the hosted Windows suite.
The routine push gate runs the full test gate only on Ubuntu 24.04 and
build-checks macOS 15 and Windows Server 2025; the seven-target matrix runs
only from manual dispatch or a `v*` tag. `windows-latest` is hosted-CI
evidence only and is not a real-machine Windows 10 or Windows 11 support
claim:

CI runners: `ubuntu-24.04`, `ubuntu-24.04-arm`, `ubuntu-26.04`, `macos-15`, `macos-15-intel`, `macos-26`, `windows-latest`.

<!-- ci-targets:start -->

| Platform            | Architecture | CI runner          | Shell                      | Sandbox                |
| ------------------- | ------------ | ------------------ | -------------------------- | ---------------------- |
| Ubuntu 24.04        | x64          | `ubuntu-24.04`     | Bash                       | `srt` bubblewrap       |
| Ubuntu 24.04        | arm64        | `ubuntu-24.04-arm` | Bash                       | `srt` bubblewrap       |
| Ubuntu 26.04        | x64          | `ubuntu-26.04`     | Bash                       | `srt` bubblewrap       |
| macOS 15            | arm64        | `macos-15`         | Bash/Zsh via Pi            | `srt` Seatbelt         |
| macOS 15            | x64          | `macos-15-intel`   | Bash/Zsh via Pi            | `srt` Seatbelt         |
| macOS 26            | arm64        | `macos-26`         | Bash/Zsh via Pi            | `srt` Seatbelt         |
| Windows Server 2025 | x64          | `windows-latest`   | cmd/PowerShell via srt-win | `srt-win` (unverified) |

<!-- ci-targets:end -->

The full matrix runs install, formatting, repository checks, typecheck,
tests, eval, build, and built-entry checks on each target. The current local
baseline at `main` (`2ca8739`) is
`# tests 820 / # pass 811 / # fail 0 / # skipped 9`; `pnpm run eval` passes
12/12 cases. Fast run `44480731591` passed all four routine jobs. The release
candidate `c0383fa` reports 818 tests, 809 passing, 0 failing, and 9 skipped,
and run `44473437813` passed all seven full-matrix jobs.
`windows-latest` is Windows Server 2025 (`10.0.26100`, image
`windows-2025-vs2026`), not Windows 10 or Windows 11, and does not replace the
real-machine acceptance in spec 0007. The release runbook additionally
requires a clean global install and `codepunk doctor` smoke test on each
release target.

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

## Manual smoke and exclusions

A support claim requires CI evidence or a recorded clean-install smoke test
with the exact platform, architecture, Node version, sandbox dependency state,
and exit codes.

- macOS 13 and 14 on arm64 or x64.
- Linux distributions other than Ubuntu 24.04 and 26.04.
- Windows ARM64 and macOS 26 x64 are not declared targets.

WSL2 Ubuntu x64 is manual-smoke only and is not CI-covered. Linux x64 and arm64
runners exercise the Linux code path, but they do not exercise WSL2's kernel,
filesystem interop, or Windows host integration, so they cannot stand in for a
WSL2 smoke test.

## Windows

Windows 10 22H2 (build 19045 or newer) and Windows 11 on x64 are supported
targets with the same product boundary. The 2026-11-28 real-machine
acceptance on Windows 10 `10.0.19045` x64 ran the ordinary CLI/TUI surface
against both a local tarball and the published `codepunk-cli@0.1.1`; its
confirmed defects are tracked in spec 0030. Windows ARM64 is not supported.

The 0007 code path and the hosted `windows-latest` job are implemented. Run
`44352649879` does not provide Windows gate evidence; its
unprovisioned-`srt` failure is fixed for the release. Full CI run
`44473437813` passed the hosted gate at `818 tests / 774 pass / 0 fail / 44
skipped`. That hosted gate includes explicit skips for 10 daemon/view tests
because the daemon requires a Unix socket and Windows is fail-closed, 23 tests
that use POSIX executables, shell syntax, permission bits, or mount types, and
tests that require the one-time elevated `srt-win` provisioning. Hosted CI is
not a real-machine Windows acceptance and does not cover ConPTY, DACL, or
process-tree behavior.

Windows-specific OS checks remain fail-closed where prerequisites are absent:

- `codepunk doctor` accepts `win32 x64` on build 19045 or newer, and still
  reports a blocking `srt` error until the sandbox is provisioned;
- the sandbox probe resolves the pinned `srt-win` helper and reports the
  one-time elevated install needed to provision `srt-sandbox`;
- shell execution stays disabled until that install exists; initialization
  failures never fall back to an unsandboxed shell;
- npm's PowerShell shim forwards arguments through PowerShell's script binder,
  which drops a bare `--` before the arguments reach Node. When the payload
  after `--` starts with `-`, use `codepunk.cmd` or pass one quoted command
  string, such as `codepunk permissions why "pwsh -NoProfile"`; the `.cmd` and
  Node entry points receive the documented separator unchanged;
- the local daemon does not start because it requires a Unix socket.

Windows-specific OS behavior (elevated `srt-win` provisioning, DACL
enforcement, ConPTY process trees, and daemon named pipes) has not been
independently verified on Windows 11 hardware. The Windows 10 acceptance does
not stand in for that separate evidence. Any extension beyond Windows 10
19045+ or Windows 11 on x64 still requires its own real-machine evidence.

## Search prerequisites

`search` resolves local `rg` and `fd` binaries. It never downloads a binary at
tool-call time. A missing binary fails with an installation hint and a
`codepunk doctor` diagnostic. `scripts/ci-install-sandbox-deps.sh` provisions
both binaries on hosted Unix and Windows runners.
