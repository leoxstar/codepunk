import type { PiHost } from "../adapters/pi/index.ts";
import {
  ConfigError,
  type CodepunkConfig,
  type LoadedConfig,
} from "../config/index.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import {
  DeferredSandbox,
  SandboxManager,
  SrtSandbox,
  UnsandboxedShell,
  probeWindowsShell,
  type resolveWindowsShell,
  type ShellProvider,
} from "../sandbox/index.ts";
import type { RuntimeOptions } from "./types.ts";

type ResolvedWindowsShell = Awaited<ReturnType<typeof resolveWindowsShell>>;

export interface RuntimeSandboxSetupResult {
  getSandbox: () => ShellProvider | null;
  pendingSandboxProvider: () => ShellProvider | null;
  runtimeSandboxReady: Promise<ShellProvider | null>;
  shellPreflightSettled: Promise<void>;
  getShellPreflightIssue: () => string | null;
  isDegradedUnsandboxedFallback: () => boolean;
  canFallbackToHumanApprovedShell: () => boolean;
  closePendingSandbox: () => Promise<void>;
}

export function initializeRuntimeSandbox(input: {
  options: RuntimeOptions;
  paths: ProjectPaths;
  config: CodepunkConfig;
  loadedConfig: LoadedConfig;
  windowsShell: ResolvedWindowsShell;
  writeSetWithAdditionalRoots: readonly string[];
  hostRef: { current: PiHost | null };
  getInitialRunId: () => string;
  startupCleanup: { current: (() => Promise<void>) | null };
}): RuntimeSandboxSetupResult {
  const {
    options,
    paths,
    config,
    loadedConfig,
    windowsShell,
    writeSetWithAdditionalRoots,
    hostRef,
    startupCleanup,
  } = input;

  let sandbox: ShellProvider | null = null;
  let sandboxReady: Promise<ShellProvider | null> = Promise.resolve(null);
  let sandboxUnavailableReason: string | null = null;
  let shellPreflightIssue: string | null = null;
  let closePendingSandbox: () => Promise<void> = () => Promise.resolve();
  let pendingSandboxProvider: () => ShellProvider | null = () => sandbox;
  let resolveShellPreflight: () => void = () => undefined;
  const shellPreflightSettled = new Promise<void>((resolve) => {
    resolveShellPreflight = resolve;
  });
  if (process.platform !== "win32" || windowsShell.kind === "auto") {
    resolveShellPreflight();
  }

  let degradedUnsandboxedFallback = false;
  const canFallbackToHumanApprovedShell = (): boolean =>
    options.headless !== true &&
    options.approvalChannel !== undefined &&
    options.approvalChannel !== null &&
    options.approvalChannel.isTTY === true &&
    config.approval.mode === "ask" &&
    config.autonomy.profile === "ask" &&
    !(process.platform === "win32" && windowsShell.kind !== "auto");

  if (config.sandbox.mode === "required") {
    const sandboxFactory = options.createSandbox ?? SrtSandbox.create;
    const createPromise = sandboxFactory(
      {
        cwd: paths.cwd,
        workspaceRoot: paths.deliveryRoot,
        deliveryRoot: paths.deliveryRoot,
        codepunkHome: paths.home,
        writeSet: writeSetWithAdditionalRoots,
        additionalRoots: paths.additionalRoots,
        networkAllow: config.sandbox.network_allow,
        networkDeny: config.sandbox.network_deny,
        networkMaxRequests: config.sandbox.network_max_requests,
        networkMaxBytes: config.sandbox.network_max_bytes,
        readOnly: config.autonomy.profile === "read-only",
        ...(windowsShell.binShell === null
          ? {}
          : { windowsBinShell: windowsShell.binShell }),
      },
      {
        runId: () => hostRef.current?.currentRunId ?? input.getInitialRunId(),
        onNetworkEvent: async (kind, data) => {
          await hostRef.current?.recordEvent(kind, data);
        },
      },
    );
    sandboxReady = createPromise
      .then((createdSandbox) => {
        sandbox = createdSandbox;
        return createdSandbox;
      })
      .catch((error: unknown) => {
        sandboxUnavailableReason =
          error instanceof Error ? error.message : String(error);
        if (canFallbackToHumanApprovedShell()) {
          degradedUnsandboxedFallback = true;
          const fallbackShell = new UnsandboxedShell();
          sandbox = fallbackShell;
          loadedConfig.warnings.push(
            `srt sandbox is unavailable (${sandboxUnavailableReason}); standard interactive mode degraded to per-command human-approved unsandboxed shell (uncovered)`,
          );
          return fallbackShell;
        }
        sandbox = null;
        loadedConfig.warnings.push(
          `sandbox required but srt is unavailable; shell tools are disabled: ${sandboxUnavailableReason}; run codepunk doctor`,
        );
        return null;
      });
    const pendingSandbox = new DeferredSandbox(sandboxReady, {
      cancelPendingInitialization: async () => {
        if (process.platform !== "linux") {
          await SandboxManager.reset();
        }
      },
    });
    sandbox = pendingSandbox;
    pendingSandboxProvider = () => pendingSandbox;
    closePendingSandbox = async () => {
      if (startupCleanup.current === closePendingSandbox) {
        startupCleanup.current = null;
      }
      await pendingSandbox.close();
    };
  }

  const runtimeSandboxReady: Promise<ShellProvider | null> = sandboxReady;
  if (config.sandbox.mode === "required") {
    startupCleanup.current = closePendingSandbox;
  }

  if (process.platform === "win32" && windowsShell.kind !== "auto") {
    void runtimeSandboxReady
      .then(async (resolved) => {
        if (resolved === null) {
          throw new ConfigError(
            `tools.shell=${windowsShell.kind} requires the srt sandbox on Windows; shell tools stay disabled until srt is available`,
            "tools.shell",
          );
        }
        await probeWindowsShell(resolved, windowsShell, paths.cwd);
      })
      .catch(async (error: unknown) => {
        shellPreflightIssue =
          error instanceof Error ? error.message : String(error);
        sandbox = null;
        sandboxUnavailableReason = shellPreflightIssue;
      })
      .finally(() => {
        resolveShellPreflight();
      });
  } else {
    resolveShellPreflight();
  }

  if (
    sandbox === null &&
    config.sandbox.mode === "uncovered" &&
    options.allowUnsandboxedShell === true &&
    options.headless !== true
  ) {
    sandbox = new UnsandboxedShell();
  }
  if (sandbox === null) {
    loadedConfig.warnings.push(
      config.sandbox.mode === "uncovered"
        ? "sandbox mode is uncovered; shell tools are disabled unless this interactive process was started with --allow-unsandboxed-shell"
        : `sandbox required but srt is unavailable; shell tools are disabled${
            sandboxUnavailableReason === null
              ? ""
              : `: ${sandboxUnavailableReason}`
          }; run codepunk doctor`,
    );
  }

  return {
    getSandbox: () => sandbox,
    pendingSandboxProvider,
    runtimeSandboxReady,
    shellPreflightSettled,
    getShellPreflightIssue: () => shellPreflightIssue,
    isDegradedUnsandboxedFallback: () => degradedUnsandboxedFallback,
    canFallbackToHumanApprovedShell,
    closePendingSandbox,
  };
}
