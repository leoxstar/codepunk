import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import {
  checkWindowsDependenciesAsync,
  resolveSrtWin,
  SandboxManager,
  VENDORED_SRT_WIN_EXE,
  type SandboxDependencyCheck,
  type SandboxRuntimeConfig,
  type WindowsBinShell,
} from "@anthropic-ai/sandbox-runtime";
import type { SandboxDescriptor } from "codepunk-protocol";
import { NetworkGuard } from "../network/index.ts";
import { sha256Value } from "../platform/hash.ts";
import { normalizeAbsolute } from "../platform/path.ts";
import { srtProfile } from "./profile.ts";
import {
  DIRECT_EXECUTOR,
  SANDBOX_EXECUTOR,
  SRT_VERSION,
  SandboxUnavailableError,
  agentShellEnvironment,
  type CreateSrtSandboxOptions,
  type SandboxLifecycle,
  type ShellExecutionOptions,
  type ShellExecutionResult,
  type ShellProvider,
  type SrtManager,
  type SrtProfileInput,
  type WindowsShellSelection,
} from "./types.ts";
import {
  WINDOWS_ARGV_MARKER,
  WINDOWS_ARGV_SENTINEL,
  WINDOWS_SCRIPT,
  assertWindowsSandboxRootsAreScoped,
  decodeShellOutput,
  probeWindowsShell,
  protectWindowsCodepunkHome,
  resolveWindowsExecutable,
  resolveWindowsShell,
  windowsCodepunkHomeIsOutsideWriteRoots,
  withoutWindowsCodepunkHomeDenies,
} from "./windows.ts";

export { SandboxManager };
export type { WindowsBinShell } from "@anthropic-ai/sandbox-runtime";
export {
  DIRECT_EXECUTOR,
  SANDBOX_EXECUTOR,
  SRT_VERSION,
  SandboxUnavailableError,
  agentShellEnvironment,
  decodeShellOutput,
  probeWindowsShell,
  protectWindowsCodepunkHome,
  resolveWindowsExecutable,
  resolveWindowsShell,
  srtProfile,
  type CreateSrtSandboxOptions,
  type SandboxLifecycle,
  type ShellExecutionOptions,
  type ShellExecutionResult,
  type ShellProvider,
  type SrtProfileInput,
  type WindowsShellSelection,
};

export class DeferredSandbox implements ShellProvider {
  private provider: ShellProvider | null;
  private readonly ready: Promise<ShellProvider | null>;
  private readonly lifecycle: SandboxLifecycle | null;
  private state: "pending" | "closed" = "pending";
  private closePromise: Promise<void> | null = null;
  private lateClosePromise: Promise<void> | null = null;

  constructor(
    ready: Promise<ShellProvider | null>,
    lifecycle?: SandboxLifecycle,
  ) {
    this.ready = ready;
    this.lifecycle = lifecycle ?? null;
    this.provider = null;
    ready.then(
      (resolved) => {
        if (this.provider === null) {
          this.provider = resolved;
        }
        if (this.state === "closed") {
          this.lateClosePromise = resolved?.close?.() ?? null;
          return this.lateClosePromise?.catch(() => undefined);
        }
      },
      () => undefined,
    );
  }

  get sandboxed(): boolean {
    return this.provider === null ? true : this.provider.sandboxed;
  }

  async awaitReady(): Promise<ShellProvider | null> {
    if (this.state === "closed") {
      return null;
    }
    const resolved = this.provider ?? (await this.ready);
    return (this.state as "pending" | "closed") === "closed" ? null : resolved;
  }

  private async resolve(): Promise<ShellProvider> {
    if (this.state === "closed") {
      throw new SandboxUnavailableError("srt provider is closed");
    }
    const sandbox = this.provider ?? (await this.ready);
    if (sandbox === null) {
      throw new SandboxUnavailableError(
        "srt sandbox is not ready; shell tools are disabled",
      );
    }
    return sandbox;
  }

  async execCommand(
    command: string,
    cwd: string,
    options?: ShellExecutionOptions,
  ): Promise<ShellExecutionResult> {
    const sandbox = await this.resolve();
    return await sandbox.execCommand(command, cwd, {
      ...options,
      descriptor: sandbox.descriptor,
    });
  }

  async execArgv(
    argv: readonly string[],
    cwd: string,
    options?: ShellExecutionOptions,
  ): Promise<ShellExecutionResult> {
    const sandbox = await this.resolve();
    return await sandbox.execArgv(argv, cwd, {
      ...options,
      descriptor: sandbox.descriptor,
    });
  }

  get descriptor(): SandboxDescriptor {
    return (
      this.provider?.descriptor ?? {
        backend: "srt",
        version: SRT_VERSION,
        profile_sha256: null,
        network_allowed_domains: [],
        network_denied_domains: [],
      }
    );
  }

  async close(): Promise<void> {
    if (this.state === "closed") {
      return this.closePromise ?? this.lateClosePromise ?? Promise.resolve();
    }
    this.state = "closed";
    this.closePromise = (async () => {
      this.lifecycle?.cancelPendingInitialization();
      if (this.provider !== null) {
        await this.provider.close?.().catch(() => undefined);
        return;
      }
    })();
    return this.closePromise;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runtimeConfigFor(
  config: SandboxRuntimeConfig,
  platform: NodeJS.Platform,
  windowsSrtWinPath?: string,
): SandboxRuntimeConfig {
  if (platform !== "win32") {
    return config;
  }
  return {
    ...config,
    windows: {
      ...config.windows,
      srtWin: {
        path: windowsSrtWinPath ?? VENDORED_SRT_WIN_EXE,
      },
    },
  };
}

async function checkWindowsDependencies(
  config: SandboxRuntimeConfig,
): Promise<SandboxDependencyCheck> {
  if (config.windows?.srtWin === undefined) {
    return {
      errors: ["no srt-win path configured for the Windows dependency probe"],
      warnings: [],
    };
  }
  return checkWindowsDependenciesAsync({
    srtWin: resolveSrtWin(config.windows.srtWin),
  });
}

async function checkDependenciesFor(
  manager: SrtManager,
  config: SandboxRuntimeConfig,
  platform: NodeJS.Platform,
  windowsDependencyCheck: CreateSrtSandboxOptions["windowsDependencyCheck"],
): Promise<SandboxDependencyCheck> {
  if (platform === "win32") {
    return (windowsDependencyCheck ?? checkWindowsDependencies)(config);
  }
  return manager.checkDependencies();
}

function isAddressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ("code" in error && error.code === "EADDRINUSE") {
    return true;
  }
  return "cause" in error && isAddressInUse(error.cause);
}

function terminateProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32" && child.pid !== undefined) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const killDirect = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    };
    killer.once("error", killDirect);
    killer.once("exit", (code) => {
      if (code !== 0) {
        killDirect();
      }
    });
    killer.unref();
    return;
  }
  child.kill("SIGKILL");
}

export async function probeSrtSandbox(
  input: SrtProfileInput,
  options: CreateSrtSandboxOptions = {},
): Promise<string | null> {
  const manager = options.manager ?? SandboxManager;
  const platform = options.platform ?? process.platform;
  if (!manager.isSupportedPlatform()) {
    return "srt does not support this platform; shell execution is disabled";
  }
  try {
    const config = runtimeConfigFor(
      srtProfile({
        ...input,
        ...(platform !== "win32" && input.userHome === undefined
          ? { userHome: options.userHome ?? os.homedir() }
          : {}),
      }),
      platform,
      options.windowsSrtWinPath,
    );
    const dependencies = await checkDependenciesFor(
      manager,
      config,
      platform,
      options.windowsDependencyCheck,
    );
    return dependencies.errors.length > 0
      ? `srt dependency check failed: ${dependencies.errors.join("; ")}`
      : null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export class SrtSandbox implements ShellProvider {
  readonly descriptor: SandboxDescriptor;
  readonly sandboxed = true;
  readonly warnings: readonly string[];
  readonly networkGuard: NetworkGuard | null;
  private readonly manager: SrtManager;
  private readonly platform: NodeJS.Platform;
  private readonly windowsBinShell: WindowsBinShell | undefined;
  private disposed = false;

  private constructor(
    manager: SrtManager,
    config: SandboxRuntimeConfig,
    warnings: readonly string[],
    platform: NodeJS.Platform,
    windowsBinShell: WindowsBinShell | undefined,
    networkGuard: NetworkGuard | null,
  ) {
    this.manager = manager;
    this.warnings = warnings;
    this.platform = platform;
    this.windowsBinShell = windowsBinShell;
    this.networkGuard = networkGuard;
    this.descriptor = {
      backend: "srt",
      version: SRT_VERSION,
      profile_sha256: sha256Value(config),
      network_allowed_domains: [...config.network.allowedDomains],
      network_denied_domains: [...config.network.deniedDomains],
    };
  }

  static async create(
    input: SrtProfileInput,
    options: CreateSrtSandboxOptions = {},
  ): Promise<SrtSandbox> {
    const manager = options.manager ?? SandboxManager;
    const platform = options.platform ?? process.platform;
    if (!manager.isSupportedPlatform()) {
      throw new SandboxUnavailableError(
        "srt does not support this platform; shell execution is disabled",
      );
    }
    if (platform === "win32") {
      assertWindowsSandboxRootsAreScoped(
        input,
        options.userHome ?? os.homedir(),
      );
    }
    const networkGuard =
      options.onNetworkEvent !== undefined ||
      (input.networkMaxRequests !== undefined &&
        input.networkMaxRequests !== null) ||
      (input.networkMaxBytes !== undefined && input.networkMaxBytes !== null)
        ? new NetworkGuard({
            runId: options.runId ?? "sandbox",
            allow: [...new Set(input.networkAllow ?? [])].sort(),
            deny: [...new Set(input.networkDeny ?? [])].sort(),
            maxRequests: input.networkMaxRequests ?? null,
            maxBytes: input.networkMaxBytes ?? null,
            onEvent: options.onNetworkEvent,
          })
        : null;
    const profileInput: SrtProfileInput = {
      ...input,
      ...(platform !== "win32" && input.userHome === undefined
        ? { userHome: options.userHome ?? os.homedir() }
        : {}),
      ...(networkGuard !== null ? { networkGuard } : {}),
    };
    let config = srtProfile(profileInput);
    let runtimeConfig = runtimeConfigFor(
      config,
      platform,
      options.windowsSrtWinPath,
    );
    const dependencies = await checkDependenciesFor(
      manager,
      runtimeConfig,
      platform,
      options.windowsDependencyCheck,
    );
    if (dependencies.errors.length > 0) {
      throw new SandboxUnavailableError(
        `srt dependency check failed: ${dependencies.errors.join("; ")}`,
      );
    }
    if (platform === "win32" && windowsCodepunkHomeIsOutsideWriteRoots(input)) {
      const codepunkHome = normalizeAbsolute(input.codepunkHome);
      await (options.protectWindowsCodepunkHome ?? protectWindowsCodepunkHome)(
        codepunkHome,
        options.windowsSrtWinPath,
      );
      config = withoutWindowsCodepunkHomeDenies(config, codepunkHome);
      runtimeConfig = runtimeConfigFor(
        config,
        platform,
        options.windowsSrtWinPath,
      );
    }
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await manager.initialize(runtimeConfig);
          break;
        } catch (error) {
          if (platform !== "win32" || !isAddressInUse(error) || attempt >= 5) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        }
      }
    } catch (error) {
      throw new SandboxUnavailableError(
        `srt initialization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    return new SrtSandbox(
      manager,
      config,
      dependencies.warnings,
      platform,
      options.windowsBinShell,
      networkGuard,
    );
  }

  private assertAvailable(): void {
    if (this.disposed) {
      throw new SandboxUnavailableError("srt provider is closed");
    }
  }

  private async runProcess(
    argv: string[],
    cwd: string,
    options: ShellExecutionOptions,
    useShell: boolean,
  ): Promise<ShellExecutionResult> {
    this.assertAvailable();
    const commandId = options.commandId ?? randomUUID();
    const outputChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let cancelled = false;
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: useShell,
      windowsHide: true,
    });
    const onAbort = () => {
      cancelled = true;
      terminateProcessTree(child, this.platform);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }
    let timer: NodeJS.Timeout | undefined;
    if (options.timeout !== undefined && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child, this.platform);
      }, options.timeout);
      timer.unref();
    }
    child.stdout.on("data", (chunk: Buffer) => {
      outputChunks.push(chunk);
      options.onData?.(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      outputChunks.push(chunk);
      options.onData?.(chunk);
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    }).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener("abort", onAbort);
    });
    const stderr = decodeShellOutput(
      Buffer.concat(stderrChunks),
      this.platform,
    );
    let output = decodeShellOutput(Buffer.concat(outputChunks), this.platform);
    const annotated = this.manager.annotateStderrWithSandboxFailures(
      commandId,
      stderr,
    );
    if (annotated !== stderr) {
      output += annotated.slice(stderr.length);
    }
    return {
      output,
      exitCode: timedOut ? 124 : cancelled ? null : exitCode,
      cancelled,
      timedOut,
      executor: SANDBOX_EXECUTOR,
      descriptor: options.descriptor ?? this.descriptor,
    };
  }

  async execCommand(
    command: string,
    cwd: string,
    options: ShellExecutionOptions = {},
  ): Promise<ShellExecutionResult> {
    this.assertAvailable();
    if (command.length === 0) {
      throw new SandboxUnavailableError("shell command is empty");
    }
    const commandId = options.commandId ?? randomUUID();
    if (this.platform === "win32") {
      const wrapped = await this.manager.wrapWithSandboxArgv(
        command,
        this.windowsBinShell,
        undefined,
        options.signal,
        cwd,
        { commandId },
      );
      return this.runProcess(
        wrapped.argv,
        cwd,
        {
          ...options,
          commandId,
          env: { ...wrapped.env, ...(options.env ?? {}) },
        },
        false,
      );
    }
    const wrapped = await this.manager.wrapWithSandbox(
      command,
      undefined,
      undefined,
      options.signal,
      { commandId },
    );
    return this.runProcess([wrapped], cwd, { ...options, commandId }, true);
  }

  async execArgv(
    commandArgv: readonly string[],
    cwd: string,
    options: ShellExecutionOptions = {},
  ): Promise<ShellExecutionResult> {
    this.assertAvailable();
    const executableName = commandArgv[0];
    if (executableName === undefined || executableName.length === 0) {
      throw new SandboxUnavailableError("argv executable is missing");
    }
    if (this.platform === "win32") {
      const executable = resolveWindowsExecutable(executableName);
      if (WINDOWS_SCRIPT.test(executable)) {
        throw new SandboxUnavailableError(
          "argv-only execution cannot start a Windows script; invoke cmd.exe or powershell.exe explicitly",
        );
      }
      const targetArgv = [executable, ...commandArgv.slice(1)];
      const commandId = options.commandId ?? randomUUID();
      const wrapped = await this.manager.wrapWithSandboxArgv(
        WINDOWS_ARGV_SENTINEL,
        { exe: WINDOWS_ARGV_MARKER, args: [] },
        undefined,
        options.signal,
        cwd,
        { commandId, commandText: targetArgv.join(" ") },
      );
      const tail = wrapped.argv.slice(-2);
      if (
        tail[0] !== WINDOWS_ARGV_MARKER ||
        tail[1] !== WINDOWS_ARGV_SENTINEL
      ) {
        throw new SandboxUnavailableError(
          "the pinned srt runtime changed its Windows argv layout; argv-only execution is disabled",
        );
      }
      return this.runProcess(
        [...wrapped.argv.slice(0, -2), ...targetArgv],
        cwd,
        {
          ...options,
          commandId,
          env: { ...wrapped.env, ...(options.env ?? {}) },
        },
        false,
      );
    }
    const commandId = options.commandId ?? randomUUID();
    const command = commandArgv.map(shellQuote).join(" ");
    const wrapped = await this.manager.wrapWithSandboxArgv(
      command,
      undefined,
      undefined,
      options.signal,
      cwd,
      { commandId },
    );
    return this.runProcess(
      wrapped.argv,
      cwd,
      {
        ...options,
        commandId,
        env: { ...wrapped.env, ...(options.env ?? {}) },
      },
      false,
    );
  }

  dispose(): void {
    this.disposed = true;
  }

  async close(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.manager.cleanupAfterCommand?.();
    await this.manager.reset?.();
  }
}

export class UnsandboxedShell implements ShellProvider {
  readonly descriptor: SandboxDescriptor = {
    backend: "none",
    version: null,
    profile_sha256: null,
  };
  readonly sandboxed = false;
  private disposed = false;

  private assertAvailable(): void {
    if (this.disposed) {
      throw new SandboxUnavailableError("unsandboxed shell provider is closed");
    }
  }

  private async runProcess(
    argv: string[],
    cwd: string,
    options: ShellExecutionOptions,
    useShell: boolean,
  ): Promise<ShellExecutionResult> {
    this.assertAvailable();
    const outputChunks: Buffer[] = [];
    let timedOut = false;
    let cancelled = false;
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: useShell,
      windowsHide: true,
    });
    const onAbort = () => {
      cancelled = true;
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }
    let timer: NodeJS.Timeout | undefined;
    if (options.timeout !== undefined && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeout);
      timer.unref();
    }
    child.stdout.on("data", (chunk: Buffer) => {
      outputChunks.push(chunk);
      options.onData?.(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputChunks.push(chunk);
      options.onData?.(chunk);
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    }).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener("abort", onAbort);
    });
    const output = decodeShellOutput(Buffer.concat(outputChunks));
    return {
      output,
      exitCode: timedOut ? 124 : cancelled ? null : exitCode,
      cancelled,
      timedOut,
      executor: DIRECT_EXECUTOR,
      descriptor: this.descriptor,
    };
  }

  async execCommand(
    command: string,
    cwd: string,
    options: ShellExecutionOptions = {},
  ): Promise<ShellExecutionResult> {
    this.assertAvailable();
    if (command.length === 0) {
      throw new SandboxUnavailableError("shell command is empty");
    }
    return this.runProcess([command], cwd, options, true);
  }

  async execArgv(
    commandArgv: readonly string[],
    cwd: string,
    options: ShellExecutionOptions = {},
  ): Promise<ShellExecutionResult> {
    this.assertAvailable();
    if (commandArgv.length === 0 || commandArgv[0]?.length === 0) {
      throw new SandboxUnavailableError("argv executable is missing");
    }
    return this.runProcess([...commandArgv], cwd, options, false);
  }

  async close(): Promise<void> {
    this.disposed = true;
  }
}
