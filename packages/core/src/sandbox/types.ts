import type {
  SandboxDependencyCheck,
  SandboxRuntimeConfig,
  WindowsBinShell,
  WrapWithSandboxOptions,
} from "@anthropic-ai/sandbox-runtime";
import type { SandboxDescriptor } from "codepunk-protocol";
import type { NetworkEventSink, NetworkGuard } from "../network/index.ts";

export type { WindowsBinShell } from "@anthropic-ai/sandbox-runtime";

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

export interface SandboxLifecycle {
  cancelPendingInitialization(): void;
}

export interface SrtProfileInput {
  cwd: string;
  workspaceRoot: string;
  deliveryRoot: string;
  additionalRoots?: readonly string[];
  codepunkHome: string;
  userHome?: string;
  writeSet?: readonly string[];
  networkAllow?: readonly string[];
  networkDeny?: readonly string[];
  networkMaxRequests?: number | null;
  networkMaxBytes?: number | null;
  readOnly?: boolean;
  networkGuard?: NetworkGuard;
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
  descriptor?: SandboxDescriptor;
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
  awaitReady?(): Promise<ShellProvider | null>;
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

export interface SrtManager {
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
    binShell?: string | WindowsBinShell,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
    cwd?: string,
    options?: WrapWithSandboxOptions,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  annotateStderrWithSandboxFailures(command: string, stderr: string): string;
  cleanupAfterCommand?(): void;
  reset?(): Promise<void>;
}

export interface WindowsShellSelection {
  readonly kind: "auto" | "bash" | "pwsh";
  readonly executable: string | null;
  readonly binShell: WindowsBinShell | null;
}

export interface CreateSrtSandboxOptions {
  manager?: SrtManager;
  platform?: NodeJS.Platform;
  windowsSrtWinPath?: string;
  windowsDependencyCheck?: (
    config: SandboxRuntimeConfig,
  ) => Promise<SandboxDependencyCheck>;
  userHome?: string;
  protectWindowsCodepunkHome?: (
    codepunkHome: string,
    srtWinPath: string | undefined,
  ) => Promise<void>;
  windowsBinShell?: WindowsBinShell;
  runId?: string | (() => string);
  onNetworkEvent?: NetworkEventSink;
}
