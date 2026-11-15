#!/usr/bin/env python3

import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: pty-run.py command [args ...]", file=sys.stderr)
        return 2

    master, slave = pty.openpty()
    fcntl.ioctl(
        slave,
        termios.TIOCSWINSZ,
        struct.pack("HHHH", 40, 120, 0, 0),
    )
    child = subprocess.Popen(
        sys.argv[1:],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
        env=os.environ,
    )
    os.close(slave)
    pid_file = os.environ.get("PTY_RUN_PID_FILE")
    if pid_file:
        with open(pid_file, "w", encoding="ascii") as handle:
            handle.write(f"{child.pid}\n")

    def terminate(signum: int, _frame: object) -> None:
        try:
            os.killpg(os.getpgid(child.pid), signal.SIGTERM)
        except OSError:
            pass
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)

    stdin_fd = sys.stdin.fileno()
    output = sys.stdout.buffer
    sources = [master, stdin_fd]
    timeout = float(os.environ.get("PTY_RUN_TIMEOUT", "0") or 0)
    started = time.monotonic()
    timed_out = False
    try:
        while child.poll() is None:
            if timeout > 0 and time.monotonic() - started > timeout:
                timed_out = True
                try:
                    os.killpg(os.getpgid(child.pid), 15)
                except OSError:
                    pass
                break
            readable, _, _ = select.select(sources, [], [], 0.2)
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                output.write(data)
                output.flush()
            if stdin_fd in readable:
                data = os.read(stdin_fd, 65536)
                if not data:
                    sources.remove(stdin_fd)
                else:
                    os.write(master, data)
        while True:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            output.write(data)
            output.flush()
    finally:
        try:
            os.killpg(os.getpgid(child.pid), signal.SIGTERM)
        except OSError:
            pass
        try:
            os.close(master)
        except OSError:
            pass

    try:
        code = child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(child.pid), signal.SIGKILL)
        except OSError:
            pass
        code = child.wait()
    if pid_file:
        try:
            os.unlink(pid_file)
        except OSError:
            pass
    return 0 if timed_out else code


if __name__ == "__main__":
    raise SystemExit(main())
