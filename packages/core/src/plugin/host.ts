import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  PluginError as PluginErrorFrame,
  PluginErrorCode,
  PluginMethod,
  PluginResponse,
} from "codepunk-protocol";
import {
  PLUGIN_MAX_FRAME_BYTES,
  PLUGIN_PROTOCOL_VERSION,
  validateSchema,
  PluginResponseSchema,
} from "codepunk-protocol";
import { spawnGuardedHost } from "../workers/sandbox.ts";
import { PluginError } from "./index.ts";
import type { PluginManifest } from "./manifest.ts";

export interface PluginHostOptions {
  manifest: PluginManifest;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  onEvent?: (
    kind: "plugin/started" | "plugin/stopped",
    data: Record<string, unknown>,
  ) => Promise<void> | void;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: PluginErrorFrame) => void;
  timer: NodeJS.Timeout;
}

function childEntry(): string {
  const url = new URL(
    import.meta.url.endsWith(".ts") ? "./host-child.ts" : "./host-child.js",
    import.meta.url,
  );
  return fileURLToPath(url);
}

function pluginEnv(
  overrides: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  if (overrides !== undefined) {
    return { ...overrides };
  }
  const keep = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of keep) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

function terminateTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => undefined);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
  }
}

function protocolError(
  code: PluginErrorCode,
  message: string,
  retryable = false,
): PluginErrorFrame {
  return { code, message, retryable };
}

function frameBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8");
}

export class PluginHost {
  readonly manifest: PluginManifest;
  readonly pid: number;
  tools: readonly string[];
  commands: readonly string[];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly onEvent: PluginHostOptions["onEvent"];
  private readonly now: () => Date;
  private readonly defaultTimeoutMs: number;
  private stopped = false;
  private stopEventSent = false;
  private readonly exited: Promise<void>;

  private constructor(
    manifest: PluginManifest,
    child: ChildProcessWithoutNullStreams,
    tools: readonly string[],
    commands: readonly string[],
    options: PluginHostOptions,
  ) {
    this.manifest = manifest;
    this.child = child;
    this.pid = child.pid ?? 0;
    this.tools = tools;
    this.commands = commands;
    this.onEvent = options.onEvent;
    this.now = options.now ?? (() => new Date());
    this.defaultTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.exited = new Promise((resolve) => {
      child.once("exit", () => resolve());
    });
  }

  static async start(options: PluginHostOptions): Promise<PluginHost> {
    const manifest = options.manifest;
    const token = randomBytes(16).toString("hex");
    const child = spawnGuardedHost({
      argv: [
        process.execPath,
        childEntry(),
        manifest.dir,
        manifest.entry,
        manifest.id,
      ],
      cwd: manifest.dir,
      token,
      interactive: true,
      detached: true,
      env: pluginEnv(options.env),
    });
    const host = new PluginHost(manifest, child, [], [], options);
    host.attach();
    try {
      const health = await host.request(
        "health",
        {},
        {
          timeoutMs: options.startupTimeoutMs ?? 5_000,
          callId: "startup",
        },
      );
      if (
        health === null ||
        typeof health !== "object" ||
        (health as { launch_verified?: unknown }).launch_verified !== true
      ) {
        terminateTree(child, "SIGKILL");
        throw new PluginError(
          "plugin host did not prove the launch credential",
          "plugin.credential_mismatch",
        );
      }
      const listed = health as {
        tools?: unknown;
        commands?: unknown;
      };
      const tools = Array.isArray(listed.tools)
        ? listed.tools.filter(
            (name): name is string => typeof name === "string",
          )
        : [];
      const commands = Array.isArray(listed.commands)
        ? listed.commands.filter(
            (name): name is string => typeof name === "string",
          )
        : [];
      host.tools = tools;
      host.commands = commands;
      await options.onEvent?.("plugin/started", {
        plugin_id: manifest.id,
        version: manifest.version,
        manifest_sha256: manifest.manifestSha256,
        pid: host.pid,
        credential_verified: true,
        started_at: host.now().toISOString(),
      });
      return host;
    } catch (error) {
      terminateTree(child, "SIGKILL");
      if (error instanceof PluginError) {
        throw error;
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code: unknown }).code === "string"
      ) {
        throw new PluginError(
          (error as { message?: string }).message ?? "plugin host failed",
          (error as { code: string }).code,
        );
      }
      throw new PluginError(
        error instanceof Error ? error.message : String(error),
        "plugin.start_failed",
      );
    }
  }

  private attach(): void {
    const lineReader = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    lineReader.on("error", () => undefined);
    lineReader.on("line", (line) => {
      if (line.trim().length === 0) {
        return;
      }
      if (Buffer.byteLength(line, "utf8") > PLUGIN_MAX_FRAME_BYTES) {
        this.failAll(
          protocolError(
            "plugin.frame_too_large",
            `plugin frame exceeds ${PLUGIN_MAX_FRAME_BYTES} bytes`,
          ),
        );
        terminateTree(this.child, "SIGKILL");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.failAll(
          protocolError("plugin.invalid_request", "plugin emitted non-JSON"),
        );
        terminateTree(this.child, "SIGKILL");
        return;
      }
      const validation = validateSchema(PluginResponseSchema, parsed);
      if (!validation.ok) {
        this.failAll(
          protocolError(
            "plugin.invalid_request",
            "plugin response failed schema validation",
          ),
        );
        terminateTree(this.child, "SIGKILL");
        return;
      }
      const response = validation.value as PluginResponse;
      const request = this.pending.get(response.call_id);
      if (request === undefined) {
        return;
      }
      clearTimeout(request.timer);
      this.pending.delete(response.call_id);
      if (response.ok) {
        request.resolve(response.result);
      } else {
        request.reject(response.error);
      }
    });
    this.child.once("exit", (code, signal) => {
      const reason =
        signal === "SIGTERM" || signal === "SIGKILL"
          ? "cancel"
          : code === 0
            ? "exit"
            : "crash";
      this.failAll(
        protocolError(
          "plugin.crashed",
          `plugin host exited with code ${code ?? "null"} signal ${signal ?? "null"}`,
        ),
      );
      if (!this.stopped) {
        this.stopped = true;
        this.reportStopped(reason, code);
      }
    });
    this.child.stdin.on("error", () => undefined);
  }

  private failAll(error: PluginErrorFrame): void {
    for (const [callId, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
      this.pending.delete(callId);
    }
  }

  private reportStopped(reason: string, exitCode: number | null): void {
    if (this.stopEventSent) {
      return;
    }
    this.stopEventSent = true;
    void this.onEvent?.("plugin/stopped", {
      plugin_id: this.manifest.id,
      pid: this.pid,
      credential_verified: true,
      reason,
      exit_code: exitCode,
      stopped_at: this.now().toISOString(),
    });
  }

  private write(frame: unknown): void {
    if (frameBytes(frame) > PLUGIN_MAX_FRAME_BYTES) {
      throw new PluginError(
        `plugin frame exceeds ${PLUGIN_MAX_FRAME_BYTES} bytes`,
        "plugin.frame_too_large",
      );
    }
    if (this.stopped) {
      throw new PluginError("plugin host is stopped", "plugin.crashed");
    }
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  async request(
    method: PluginMethod,
    params: unknown,
    options: { timeoutMs?: number; callId?: string } = {},
  ): Promise<unknown> {
    const callId = options.callId ?? randomBytes(12).toString("hex");
    if (this.pending.has(callId)) {
      throw new PluginError(
        `call id ${callId} is already in flight`,
        "plugin.duplicate_call",
      );
    }
    const frame = {
      type: "codepunk/plugin-request",
      version: PLUGIN_PROTOCOL_VERSION,
      call_id: callId,
      plugin_id: this.manifest.id,
      method,
      params,
      timeout_ms: options.timeoutMs ?? this.defaultTimeoutMs,
    };
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(
          protocolError(
            "plugin.timeout",
            `plugin method ${method} timed out`,
            true,
          ),
        );
      }, frame.timeout_ms);
      timer.unref();
      this.pending.set(callId, {
        resolve,
        reject: (error) => reject(error),
        timer,
      });
      try {
        this.write(frame);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(callId);
        reject(error as PluginErrorFrame);
      }
    });
  }

  async callTool(
    name: string,
    params: unknown,
    options: { timeoutMs?: number; callId?: string } = {},
  ): Promise<unknown> {
    return await this.request(
      "tools/call",
      { name, arguments: params },
      options,
    );
  }

  async cancel(callId: string): Promise<void> {
    await this.request(
      "tools/cancel",
      { call_id: callId },
      { timeoutMs: 5_000 },
    );
  }

  async stop(
    reason: "shutdown" | "cancel" | "error" = "shutdown",
  ): Promise<void> {
    if (this.stopped) {
      await this.exited;
      return;
    }
    const shutdown = this.request("shutdown", {}, { timeoutMs: 1_000 }).catch(
      () => undefined,
    );
    this.stopped = true;
    const exitCode = await Promise.race([
      shutdown.then(async () => {
        await this.exited;
        return this.child.exitCode;
      }),
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 1_000);
        timer.unref();
      }),
    ]);
    if (exitCode === null) {
      terminateTree(this.child, "SIGTERM");
      const forced = await Promise.race([
        this.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 2_000);
          timer.unref();
        }),
      ]);
      if (!forced) {
        terminateTree(this.child, "SIGKILL");
        await this.exited;
      }
    }
    // A graceful plugin exit does not reap detached grandchildren that stayed
    // in the plugin process group. Sweep the group after the direct child.
    terminateTree(this.child, "SIGTERM");
    this.failAll(protocolError("plugin.cancelled", "plugin host stopped"));
    this.reportStopped(reason, this.child.exitCode);
  }
}
