import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  SandboxManager,
  VENDORED_SRT_WIN_EXE,
  type SandboxDependencyCheck,
  type SandboxRuntimeConfig,
  type WrapWithSandboxOptions,
} from "@anthropic-ai/sandbox-runtime";
import type { SandboxDescriptor } from "@codepunk/protocol";
import { sha256Value } from "../platform/hash.ts";
import {
  isInsidePath,
  normalizeAbsolute,
  PI_INSTRUCTION_FILE_NAMES,
} from "../platform/path.ts";

export const SRT_VERSION = "0.0.82";
export const SANDBOX_EXECUTOR = "srt";
export const DIRECT_EXECUTOR = "direct";

/**
 * Read-only git inspection (for example `git status`) refreshes the index
 * unless optional locks are disabled. Agent shell commands always run with
 * optional locks off so an allowed inspection cannot rewrite `.git/index`.
 * Required locks for real mutations are unaffected.
 */
export function agentShellEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...environment, GIT_OPTIONAL_LOCKS: "0" };
}

export class SandboxUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxUnavailableError";
  }
}

export interface SrtProfileInput {
  cwd: string;
  workspaceRoot: string;
  deliveryRoot: string;
  additionalRoots?: readonly string[];
  codepunkHome: string;
  writeSet?: readonly string[];
  /**
   * Domains the sandboxed process may reach. Empty means no egress. This is
   * operator configuration, not something an approval can widen at runtime;
   * `srt` applies the allowlist when the sandbox is initialized.
   */
  networkAllow?: readonly string[];
  /**
   * Domains the sandbox must never reach, even when a wildcard allow entry
   * would match. Operator configuration like the allowlist; a project config
   * cannot set it.
   */
  networkDeny?: readonly string[];
  /**
   * Remove the workspace write grant entirely. Policy already denies
   * mutations under read-only autonomy; this makes the same claim at the
   * sandbox layer so a policy regression cannot become a filesystem write.
   */
  readOnly?: boolean;
  worker?: {
    worktree: string;
    runDir: string;
    parentRoot: string;
    siblingRoot: string;
    commonGitDir: string;
    worktreeGitDir: string;
    installRoots?: readonly string[];
  };
}

export interface ShellExecutionOptions {
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  onData?: (chunk: Buffer) => void;
  commandId?: string;
}

export interface ShellExecutionResult {
  output: string;
  exitCode: number | null;
  cancelled: boolean;
  timedOut: boolean;
  executor: typeof SANDBOX_EXECUTOR | typeof DIRECT_EXECUTOR;
  descriptor: SandboxDescriptor;
}

export interface ShellProvider {
  readonly descriptor: SandboxDescriptor;
  readonly sandboxed: boolean;
  execCommand(
    command: string,
    cwd: string,
    options?: ShellExecutionOptions,
  ): Promise<ShellExecutionResult>;
  execArgv(
    argv: readonly string[],
    cwd: string,
    options?: ShellExecutionOptions,
  ): Promise<ShellExecutionResult>;
  close?(): Promise<void>;
}

interface SrtManager {
  initialize(
    runtimeConfig: SandboxRuntimeConfig,
    sandboxAskCallback?: undefined,
    enableLogMonitor?: boolean,
  ): Promise<void>;
  isSupportedPlatform(): boolean;
  checkDependencies(): SandboxDependencyCheck;
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
    options?: WrapWithSandboxOptions,
  ): Promise<string>;
  wrapWithSandboxArgv(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
    cwd?: string,
    options?: WrapWithSandboxOptions,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  annotateStderrWithSandboxFailures(command: string, stderr: string): string;
  cleanupAfterCommand?(): void;
  reset?(): Promise<void>;
}

export interface CreateSrtSandboxOptions {
  manager?: SrtManager;
  /**
   * Test seam and embedding override. Production uses the running platform
   * and the pinned runtime's vendored Windows helper.
   */
  platform?: NodeJS.Platform;
  windowsSrtWinPath?: string;
}

function writeRoots(input: SrtProfileInput): string[] {
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

export function srtProfile(input: SrtProfileInput): SandboxRuntimeConfig {
  const codepunkHome = normalizeAbsolute(input.codepunkHome);
  const allowedDomains = [...new Set(input.networkAllow ?? [])].sort();
  const deniedDomains = [...new Set(input.networkDeny ?? [])].sort();
  const projectConfig = path.join(
    normalizeAbsolute(input.deliveryRoot),
    ".codepunk",
  );
  if (input.worker !== undefined) {
    const worker = input.worker;
    const commonGitDir = normalizeAbsolute(worker.commonGitDir);
    return {
      network: {
        allowedDomains,
        deniedDomains,
      },
      filesystem: {
        denyRead: [
          normalizeAbsolute(worker.parentRoot),
          normalizeAbsolute(worker.siblingRoot),
          codepunkHome,
          projectConfig,
          ...(worker.installRoots ?? []).map((entry) =>
            normalizeAbsolute(entry),
          ),
        ],
        allowRead: [
          normalizeAbsolute(worker.worktree),
          normalizeAbsolute(worker.runDir),
          path.join(commonGitDir, "objects"),
          path.join(commonGitDir, "config"),
          path.join(commonGitDir, "HEAD"),
          path.join(commonGitDir, "refs"),
          normalizeAbsolute(worker.worktreeGitDir),
        ],
        allowWrite: [
          normalizeAbsolute(worker.worktree),
          normalizeAbsolute(worker.runDir),
          path.join(commonGitDir, "objects"),
          normalizeAbsolute(worker.worktreeGitDir),
        ],
        denyWrite: [
          ...PI_INSTRUCTION_FILE_NAMES.map((name) =>
            path.join(normalizeAbsolute(worker.worktree), name),
          ),
          path.join(normalizeAbsolute(worker.worktree), ".codepunk"),
          path.join(commonGitDir, "hooks"),
          path.join(commonGitDir, "config"),
          path.join(commonGitDir, "info"),
          path.join(commonGitDir, "packed-refs"),
          path.join(commonGitDir, "refs"),
          path.join(commonGitDir, "objects", "info"),
          path.join(commonGitDir, "objects", "pack"),
        ],
      },
    };
  }
  const workspaceRoot = normalizeAbsolute(input.workspaceRoot);
  const additionalRoots = (input.additionalRoots ?? []).map((entry) =>
    normalizeAbsolute(entry),
  );
  const allRoots = [workspaceRoot, ...additionalRoots];
  const protectedConfigDirs = [
    projectConfig,
    ...additionalRoots.map((root) => path.join(root, ".codepunk")),
  ];
  const protectedGitPaths = allRoots.flatMap((root) => {
    const rootGitDir = path.join(root, ".git");
    return [
      rootGitDir,
      path.join(rootGitDir, "config"),
      path.join(rootGitDir, "config.worktree"),
      path.join(rootGitDir, "hooks"),
      path.join(rootGitDir, "info"),
      path.join(rootGitDir, "objects", "info"),
      path.join(rootGitDir, "objects", "pack"),
    ];
  });
  const readOnly = input.readOnly === true;
  return {
    network: {
      allowedDomains,
      deniedDomains,
    },
    filesystem: {
      denyRead: [codepunkHome, ...protectedConfigDirs],
      allowWrite: readOnly ? [] : writeRoots(input),
      denyWrite: [
        ...(readOnly ? allRoots : []),
        codepunkHome,
        ...protectedConfigDirs,
        ...protectedGitPaths,
      ],
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export class SrtSandbox implements ShellProvider {
  readonly descriptor: SandboxDescriptor;
  readonly sandboxed = true;
  readonly warnings: readonly string[];
  private readonly manager: SrtManager;
  private disposed = false;

  private constructor(
    manager: SrtManager,
    config: SandboxRuntimeConfig,
    warnings: readonly string[],
  ) {
    this.manager = manager;
    this.warnings = warnings;
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
    const config = srtProfile(input);
    const runtimeConfig: SandboxRuntimeConfig =
      platform === "win32"
        ? {
            ...config,
            windows: {
              ...config.windows,
              srtWin: {
                path: options.windowsSrtWinPath ?? VENDORED_SRT_WIN_EXE,
              },
            },
          }
        : config;
    // The runtime resolves srt-win from the configuration stored by
    // initialize(), so a pre-initialize dependency check on Windows can
    // only report "no srt-win path configured" even when the caller
    // supplied one. Let initialize() perform the Windows probe; the
    // post-initialize check below only collects its warnings.
    let dependencies: SandboxDependencyCheck | null = null;
    if (platform !== "win32") {
      dependencies = manager.checkDependencies();
      if (dependencies.errors.length > 0) {
        throw new SandboxUnavailableError(
          `srt dependency check failed: ${dependencies.errors.join("; ")}`,
        );
      }
    }
    try {
      await manager.initialize(runtimeConfig);
    } catch (error) {
      throw new SandboxUnavailableError(
        `srt initialization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (platform === "win32") {
      dependencies = manager.checkDependencies();
      if (dependencies.errors.length > 0) {
        await manager.reset?.();
        throw new SandboxUnavailableError(
          `srt dependency check failed: ${dependencies.errors.join("; ")}`,
        );
      }
    }
    return new SrtSandbox(manager, config, dependencies?.warnings ?? []);
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
    let output = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: useShell,
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
      output += chunk.toString("utf8");
      options.onData?.(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      output += chunk.toString("utf8");
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
    const commandId = options.commandId ?? randomUUID();
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
    if (commandArgv.length === 0 || commandArgv[0]?.length === 0) {
      throw new SandboxUnavailableError("argv executable is missing");
    }
    if (process.platform === "win32") {
      throw new SandboxUnavailableError(
        "argv-only headless execution is not supported on Windows",
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
    let output = "";
    let timedOut = false;
    let cancelled = false;
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: useShell,
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
      output += chunk.toString("utf8");
      options.onData?.(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
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
