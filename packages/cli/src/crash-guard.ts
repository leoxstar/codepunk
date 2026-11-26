import { ConfigError } from "codepunk-core";

export type FatalCleanup = () => Promise<void> | void;

const cleanupHandlers = new Set<FatalCleanup>();
let handlingFatal = false;
let guardsInstalled = false;

const FATAL_CLEANUP_TIMEOUT_MS = 3_000;

export function registerFatalCleanup(handler: FatalCleanup): () => void {
  cleanupHandlers.add(handler);
  return () => {
    cleanupHandlers.delete(handler);
  };
}

export function restoreTerminalOnCrash(): void {
  try {
    if (
      process.stdin.isTTY === true &&
      typeof process.stdin.setRawMode === "function"
    ) {
      process.stdin.setRawMode(false);
    }
  } catch {
    // Ignore terminal restoration failures when stdin is already closed.
  }
  try {
    if (process.stdout.isTTY === true) {
      // Show cursor, leave alternate screen if active, and reset attributes.
      process.stdout.write("\x1b[?25h\x1b[?1049l\x1b[0m\n");
    }
  } catch {
    // Best effort only.
  }
}

export async function runFatalCleanups(
  timeoutMs = FATAL_CLEANUP_TIMEOUT_MS,
): Promise<void> {
  if (cleanupHandlers.size === 0) {
    return;
  }
  const tasks = [...cleanupHandlers].map((handler) =>
    Promise.resolve()
      .then(() => handler())
      .catch(() => undefined),
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function installCrashGuards(): void {
  if (guardsInstalled) {
    return;
  }
  guardsInstalled = true;
  const reportFatal = (
    label: string,
    error: unknown,
    terminate: boolean,
  ): void => {
    if (handlingFatal) {
      return;
    }
    handlingFatal = true;
    restoreTerminalOnCrash();
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof ConfigError ? 2 : 1;
    process.stderr.write(
      `codepunk: ${label}: ${message}\n` +
        "Run `codepunk doctor` to inspect local configuration and environment state.\n",
    );
    process.exitCode = code;
    if (!terminate) {
      handlingFatal = false;
      return;
    }
    const watchdog = setTimeout(() => {
      process.exit(code);
    }, FATAL_CLEANUP_TIMEOUT_MS + 500);
    watchdog.unref();
    void runFatalCleanups().finally(() => {
      clearTimeout(watchdog);
      process.exit(code);
    });
  };
  process.on("uncaughtException", (error) => {
    reportFatal("unexpected error", error, true);
  });
  process.on("unhandledRejection", (reason) => {
    reportFatal("unhandled rejection", reason, true);
  });
}
