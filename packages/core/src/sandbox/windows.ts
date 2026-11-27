import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  parseWindowsBinShell,
  resolveSrtWin,
  VENDORED_SRT_WIN_EXE,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { ConfigError } from "../config/index.ts";
import { isInsidePath, normalizeAbsolute } from "../platform/path.ts";
import {
  SandboxUnavailableError,
  type ShellExecutionResult,
  type ShellProvider,
  type SrtProfileInput,
  type WindowsShellSelection,
} from "./types.ts";

export const WINDOWS_ARGV_MARKER = "C:\\__codepunk_argv__\\runner.exe";
export const WINDOWS_ARGV_SENTINEL = "__CODEPUNK_ARGV_SENTINEL__";
export const WINDOWS_SCRIPT = /\.(?:cmd|bat|ps1)$/iu;

function looksUtf16Le(buffer: Buffer): boolean {
  if (buffer.length < 4) {
    return false;
  }
  let zeroHighBytes = 0;
  const pairs = Math.floor(buffer.length / 2);
  for (let index = 1; index < buffer.length; index += 2) {
    if (buffer[index] === 0) {
      zeroHighBytes += 1;
    }
  }
  return zeroHighBytes / pairs >= 0.6;
}

export function decodeShellOutput(
  buffer: Buffer,
  platform: NodeJS.Platform = process.platform,
): string {
  if (buffer.length === 0) {
    return "";
  }
  if (platform !== "win32") {
    return buffer.toString("utf8");
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  }
  if (looksUtf16Le(buffer)) {
    return new TextDecoder("utf-16le").decode(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder("gb18030", { fatal: true }).decode(buffer);
    } catch {
      // Fall through to replacement-character decode.
    }
    return buffer.toString("utf8");
  }
}

function windowsEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const direct = environment[name];
  if (direct !== undefined) {
    return direct;
  }
  const target = name.toUpperCase();
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() === target) {
      return value;
    }
  }
  return undefined;
}

export function resolveWindowsExecutable(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const candidate = name.trim();
  if (candidate.length === 0) {
    throw new SandboxUnavailableError("argv executable is missing");
  }
  if (path.win32.isAbsolute(candidate)) {
    return candidate;
  }
  if (candidate.includes("\\") || candidate.includes("/")) {
    const resolved = path.win32.resolve(candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
    throw new SandboxUnavailableError(`executable not found at ${resolved}`);
  }
  const searchPath = windowsEnvironmentValue(environment, "PATH") ?? "";
  const extensions = (
    windowsEnvironmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD"
  )
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const names = path.win32.extname(candidate)
    ? [candidate]
    : [candidate, ...extensions.map((extension) => candidate + extension)];
  for (const entry of searchPath.split(";")) {
    const directory = entry.trim().replace(/^"(.*)"$/u, "$1");
    if (directory.length === 0) {
      continue;
    }
    for (const fileName of names) {
      const fullPath = path.win32.join(directory, fileName);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }
  throw new SandboxUnavailableError(
    `executable not found on PATH: ${candidate}`,
  );
}

function windowsSystemBashPath(environment: NodeJS.ProcessEnv): string {
  const systemRoot =
    environment["SystemRoot"] ??
    environment["windir"] ??
    process.env["SystemRoot"] ??
    process.env["windir"] ??
    "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "bash.exe");
}

interface WindowsCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runWindowsCommand(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WindowsCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `${path.win32.basename(executable)} timed out after 30 seconds`,
        ),
      );
    }, 30_000);
    timer.unref();
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: decodeShellOutput(Buffer.concat(stdout), "win32"),
        stderr: decodeShellOutput(Buffer.concat(stderr), "win32"),
      });
    });
  });
}

export async function resolveWindowsShell(
  choice: "auto" | "bash" | "pwsh",
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<WindowsShellSelection> {
  if (platform !== "win32" || choice === "auto") {
    return { kind: choice, executable: null, binShell: null };
  }
  if (choice === "pwsh") {
    for (const name of ["pwsh.exe", "powershell.exe"]) {
      try {
        const executable = resolveWindowsExecutable(name, environment);
        return {
          kind: choice,
          executable,
          binShell: parseWindowsBinShell(executable),
        };
      } catch {
        // Try powershell.exe after pwsh.exe.
      }
    }
    throw new ConfigError(
      "tools.shell=pwsh requires pwsh.exe or powershell.exe on PATH",
      "tools.shell",
    );
  }
  let executable: string;
  try {
    executable = resolveWindowsExecutable("bash.exe", environment);
  } catch {
    throw new ConfigError(
      "tools.shell=bash requires bash.exe from Git for Windows or MSYS2 on PATH",
      "tools.shell",
    );
  }
  if (
    path.win32.resolve(executable).toLowerCase() ===
    path.win32.resolve(windowsSystemBashPath(environment)).toLowerCase()
  ) {
    throw new ConfigError(
      "tools.shell=bash refuses %SystemRoot%\\System32\\bash.exe (WSL); use Git for Windows or MSYS2 bash",
      "tools.shell",
    );
  }
  let version: WindowsCommandResult;
  try {
    version = await runWindowsCommand(executable, ["--version"], environment);
  } catch (error) {
    throw new ConfigError(
      `tools.shell=bash version preflight failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "tools.shell",
    );
  }
  const firstLine = version.stdout.split(/\r?\n/u)[0]?.trim() ?? "";
  if (
    version.code !== 0 ||
    !/pc-msys/iu.test(firstLine) ||
    /pc-cygwin|pc-linux-gnu/iu.test(firstLine)
  ) {
    throw new ConfigError(
      `tools.shell=bash requires an MSYS bash (pc-msys); got ${firstLine || `exit ${version.code}`}`,
      "tools.shell",
    );
  }
  return {
    kind: choice,
    executable,
    binShell: parseWindowsBinShell(executable),
  };
}

export async function probeWindowsShell(
  sandbox: ShellProvider,
  selection: WindowsShellSelection,
  cwd: string,
): Promise<void> {
  if (selection.kind === "auto" || selection.executable === null) {
    return;
  }
  const argv =
    selection.kind === "pwsh"
      ? [selection.executable, "-NoProfile", "-Command", "exit 0"]
      : [selection.executable, "-lc", "exit 0"];
  let result: ShellExecutionResult;
  try {
    result = await sandbox.execArgv(argv, cwd, { timeout: 30_000 });
  } catch (error) {
    throw new ConfigError(
      `tools.shell=${selection.kind} srt preflight failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "tools.shell",
    );
  }
  if (result.exitCode !== 0) {
    throw new ConfigError(
      `tools.shell=${selection.kind} srt preflight exited ${result.exitCode}: ${result.output.trim()}`,
      "tools.shell",
    );
  }
}

export function writeRoots(input: SrtProfileInput): string[] {
  const roots = new Set<string>();
  const allowedRoots = [
    normalizeAbsolute(input.workspaceRoot),
    ...(input.additionalRoots ?? []).map((entry) => normalizeAbsolute(entry)),
  ];
  for (const entry of input.writeSet ?? []) {
    const candidate = normalizeAbsolute(
      path.isAbsolute(entry) ? entry : path.resolve(input.cwd, entry),
    );
    if (allowedRoots.some((root) => isInsidePath(root, candidate))) {
      roots.add(candidate);
    }
  }
  return [...roots].sort();
}

export function assertWindowsSandboxRootsAreScoped(
  input: SrtProfileInput,
  userHome: string,
): void {
  const roots = new Set<string>();
  if (input.readOnly === true) {
    for (const entry of [
      input.workspaceRoot,
      ...(input.additionalRoots ?? []),
    ]) {
      roots.add(path.win32.resolve(entry));
    }
  } else {
    const allowedRoots = [
      path.win32.resolve(input.workspaceRoot),
      ...(input.additionalRoots ?? []).map((entry) =>
        path.win32.resolve(entry),
      ),
    ];
    for (const entry of input.writeSet ?? []) {
      const candidate = path.win32.resolve(input.cwd, entry);
      if (
        allowedRoots.some((root) => {
          const relative = path.win32.relative(root, candidate);
          return (
            relative === "" ||
            (!relative.startsWith("..") && !path.win32.isAbsolute(relative))
          );
        })
      ) {
        roots.add(candidate);
      }
    }
  }
  const home = path.win32.resolve(userHome);
  for (const root of roots) {
    const volumeRoot = path.win32.parse(root).root;
    const relativeToRoot = path.win32.relative(root, home);
    const containsHome =
      relativeToRoot === "" ||
      (!relativeToRoot.startsWith("..") &&
        !path.win32.isAbsolute(relativeToRoot));
    if (root === volumeRoot || containsHome) {
      if (input.readOnly === true) {
        throw new SandboxUnavailableError(
          `Windows read-only sandbox refuses to stamp the user profile or a volume root (${root}); start codepunk from a project directory, or pass --sandbox uncovered to start without shell sandboxing`,
        );
      }
      throw new SandboxUnavailableError(
        `Windows sandbox refuses to grant persistent access to the user profile or a volume root (${root}); start codepunk from a project directory, or pass --sandbox uncovered to start without shell sandboxing`,
      );
    }
  }
}

function windowsSystemExecutable(name: string): string {
  const systemRoot =
    process.env["SystemRoot"] ?? process.env["windir"] ?? "C:\\Windows";
  const candidate = path.win32.join(systemRoot, "System32", name);
  return existsSync(candidate) ? candidate : name;
}

function windowsPathKey(value: string): string {
  return path.win32.resolve(value).toLowerCase();
}

function hasInheritableSandboxDeny(
  aclOutput: string,
  sid: string,
  name: string | undefined,
): boolean {
  return aclOutput.split(/\r?\n/u).some((line) => {
    const namesSandboxUser =
      line.includes(sid) || (name !== undefined && line.includes(name));
    return (
      namesSandboxUser &&
      line.includes("(N)") &&
      line.includes("(OI)") &&
      line.includes("(CI)")
    );
  });
}

export async function protectWindowsCodepunkHome(
  codepunkHome: string,
  srtWinPath?: string,
): Promise<void> {
  const srtWin = resolveSrtWin({
    path: srtWinPath ?? VENDORED_SRT_WIN_EXE,
  });
  const status = await runWindowsCommand(srtWin.exe, [
    ...srtWin.prependArgs,
    "user",
    "status",
  ]);
  if (status.code !== 0) {
    throw new SandboxUnavailableError(
      `cannot protect ${codepunkHome}: srt-win user status exited ${status.code}: ${status.stderr.trim() || status.stdout.trim()}`,
    );
  }
  let sid: string | undefined;
  let name: string | undefined;
  try {
    const parsed = JSON.parse(status.stdout) as {
      user?: { sid?: unknown; name?: unknown };
    };
    if (typeof parsed.user?.sid === "string" && parsed.user.sid.length > 0) {
      sid = parsed.user.sid;
    }
    if (typeof parsed.user?.name === "string") {
      name = parsed.user.name;
    }
  } catch (error) {
    throw new SandboxUnavailableError(
      `cannot protect ${codepunkHome}: srt-win user status did not return JSON`,
      { cause: error },
    );
  }
  if (sid === undefined) {
    throw new SandboxUnavailableError(
      `cannot protect ${codepunkHome}: srt-win user status did not return the sandbox user SID`,
    );
  }
  const icacls = windowsSystemExecutable("icacls.exe");
  const current = await runWindowsCommand(icacls, [codepunkHome]);
  if (current.code !== 0) {
    throw new SandboxUnavailableError(
      `cannot inspect the access list of ${codepunkHome}: ${current.stderr.trim() || `icacls exited ${current.code}`}`,
    );
  }
  if (hasInheritableSandboxDeny(current.stdout, sid, name)) {
    return;
  }
  const removed = await runWindowsCommand(icacls, [
    codepunkHome,
    "/remove:d",
    `*${sid}`,
  ]);
  if (removed.code !== 0) {
    throw new SandboxUnavailableError(
      `cannot replace the access list of ${codepunkHome}: ${removed.stderr.trim() || `icacls exited ${removed.code}`}`,
    );
  }
  const denied = await runWindowsCommand(icacls, [
    codepunkHome,
    "/deny",
    `*${sid}:(OI)(CI)(F)`,
  ]);
  if (denied.code !== 0) {
    throw new SandboxUnavailableError(
      `cannot deny the sandbox user access to ${codepunkHome}: ${denied.stderr.trim() || `icacls exited ${denied.code}`}`,
    );
  }
  const verified = await runWindowsCommand(icacls, [codepunkHome]);
  if (
    verified.code !== 0 ||
    !hasInheritableSandboxDeny(verified.stdout, sid, name)
  ) {
    throw new SandboxUnavailableError(
      `the sandbox user deny ACE did not appear on ${codepunkHome}`,
    );
  }
}

export function windowsCodepunkHomeIsOutsideWriteRoots(
  input: SrtProfileInput,
): boolean {
  const home = windowsPathKey(input.codepunkHome);
  return !writeRoots(input).some((root) => {
    const relative = path.win32.relative(windowsPathKey(root), home);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.win32.isAbsolute(relative))
    );
  });
}

export function withoutWindowsCodepunkHomeDenies(
  config: SandboxRuntimeConfig,
  codepunkHome: string,
): SandboxRuntimeConfig {
  const home = windowsPathKey(codepunkHome);
  const keep = (entry: string | { path: string; literal: true }): boolean =>
    typeof entry !== "string" || windowsPathKey(entry) !== home;
  return {
    ...config,
    filesystem: {
      ...config.filesystem,
      denyRead: config.filesystem.denyRead.filter(keep),
      denyWrite: config.filesystem.denyWrite.filter(keep),
    },
  };
}
