import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

function loadNodePty() {
  const candidates = [
    "node-pty",
    path.join(
      import.meta.dirname,
      "..",
      "..",
      "node_modules",
      ".pnpm",
      "node_modules",
      "node-pty",
    ),
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      if (
        error === null ||
        typeof error !== "object" ||
        error.code !== "MODULE_NOT_FOUND"
      ) {
        throw error;
      }
    }
  }
  throw new Error(
    "node-pty is required for the Windows PTY test runner; run pnpm install",
  );
}

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  process.stderr.write("usage: pty-run.mjs command [args ...]\n");
  process.exit(2);
}

const pty = loadNodePty();
const requestedColumns = Number(process.env["PTY_RUN_COLS"] ?? "120");
const requestedRows = Number(process.env["PTY_RUN_ROWS"] ?? "40");
const child = pty.spawn(command, args, {
  name: "xterm-256color",
  cols:
    Number.isInteger(requestedColumns) && requestedColumns > 0
      ? requestedColumns
      : 120,
  rows:
    Number.isInteger(requestedRows) && requestedRows > 0 ? requestedRows : 40,
  cwd: process.cwd(),
  env: process.env,
});

const pidFile = process.env["PTY_RUN_PID_FILE"];
if (pidFile !== undefined && pidFile !== "") {
  await fs.writeFile(pidFile, `${child.pid}\n`, "ascii");
}

let timedOut = false;
let exiting = false;
let timeoutTimer;

function killChildTree() {
  try {
    child.kill();
  } catch {
    // Ignore errors when the PTY child has already exited.
  }
  if (process.platform === "win32" && Number.isSafeInteger(child.pid) && child.pid > 0) {
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 5_000,
      });
    } catch {
      // Ignore taskkill errors if the process tree is already gone.
    }
  }
}

const timeoutSeconds = Number(process.env["PTY_RUN_TIMEOUT"] ?? "0");
if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
  timeoutTimer = setTimeout(() => {
    timedOut = true;
    killChildTree();
    setTimeout(() => {
      cleanup();
      process.exit(0);
    }, 1_000).unref();
  }, timeoutSeconds * 1_000);
  timeoutTimer.unref();
}

function cleanup() {
  if (timeoutTimer !== undefined) {
    clearTimeout(timeoutTimer);
  }
  process.stdin.pause();
  process.stdin.unref?.();
  if (pidFile !== undefined && pidFile !== "") {
    void fs.rm(pidFile, { force: true });
  }
}

function stop(signal) {
  if (exiting) {
    return;
  }
  exiting = true;
  cleanup();
  killChildTree();
  process.exit(128 + (signal === "SIGINT" ? 2 : 15));
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
process.stdout.on("error", (error) => {
  if (error.code !== "EPIPE") {
    throw error;
  }
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => child.write(chunk));
process.stdin.resume();

child.onData((chunk) => process.stdout.write(chunk));
child.onExit(({ exitCode }) => {
  if (exiting) {
    return;
  }
  exiting = true;
  cleanup();
  process.exit(timedOut ? 0 : exitCode);
});
