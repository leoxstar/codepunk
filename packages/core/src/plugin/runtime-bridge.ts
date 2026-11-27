import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PluginRequest } from "codepunk-protocol";
import { normalizeAbsolute } from "../platform/path.ts";
import type { AnyToolResult, PluginExecutionMetadata } from "../wrap/types.ts";
import {
  PluginHost,
  type PluginHostOptions,
  type RemotePluginToolSchema,
} from "./host.ts";
import { PluginError, type PluginSummary } from "./index.ts";
import { loadPluginManifest, type PluginManifest } from "./manifest.ts";

const LEGACY_EXTENSION_FILE = /^[A-Za-z0-9._-]+\.(?:mjs|cjs|js|ts)$/u;

const ALLOWED_HOST_CALLBACK_TOOLS = new Set([
  "read",
  "search",
  "lsp_query",
  "write",
  "edit",
  "bash",
  "web_fetch",
  "web_search",
  "memory_search",
  "plan",
  "todo",
]);

export interface BufferedPluginLifecycleEvent {
  kind: "plugin/started" | "plugin/stopped";
  data: Record<string, unknown>;
}

export type PluginProductToolExecutor = (input: {
  manifest: PluginManifest;
  toolCallId: string;
  toolName: string;
  params: Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<{
  result: AnyToolResult;
  decision: "allow" | "deny";
  rule: string;
  reason: string | null;
}>;

export interface IsolatedPluginBundle {
  enabled: boolean;
  legacyExtensionPaths: string[];
  manifests: PluginManifest[];
  hosts: PluginHost[];
  tools: Array<
    ToolDefinition<any, any, any> & { pluginMeta: PluginExecutionMetadata }
  >;
  summary: PluginSummary;
  flushLifecycleEvents(
    sink: (
      kind: "plugin/started" | "plugin/stopped",
      data: Record<string, unknown>,
    ) => Promise<void> | void,
  ): Promise<void>;
  bindProductToolExecutor(executor: PluginProductToolExecutor): void;
  close(): Promise<void>;
}

export interface LoadIsolatedPluginsOptions {
  allowed: boolean;
  extensionDir: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export function pluginToolName(pluginId: string, toolName: string): string {
  return `plugin__${pluginId.replaceAll("-", "_")}__${toolName.replace(/[^A-Za-z0-9_]/gu, "_")}`;
}

export function emptyIsolatedPluginBundle(
  extensionDir: string,
  enabled = false,
): IsolatedPluginBundle {
  const dir = normalizeAbsolute(extensionDir);
  return {
    enabled,
    legacyExtensionPaths: [],
    manifests: [],
    hosts: [],
    tools: [],
    summary: {
      enabled,
      dir,
      paths: [],
      errors: [],
      warnings: [],
    },
    async flushLifecycleEvents() {},
    bindProductToolExecutor() {},
    async close() {},
  };
}

function matchesAllowedDomain(hostname: string, allowlist: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowlist.some((pattern) => {
    const normalized = pattern.replace(/:\d+$/u, "").toLowerCase();
    if (normalized.startsWith("*.")) {
      const suffix = normalized.slice(2);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    return host === normalized;
  });
}

function buildRemoteToolDefinition(
  host: PluginHost,
  toolName: string,
  schema: RemotePluginToolSchema | undefined,
): ToolDefinition<any, any, any> & { pluginMeta: PluginExecutionMetadata } {
  const exposedName = pluginToolName(host.manifest.id, toolName);
  const rawParameters = (schema?.parameters ?? {
    type: "object",
    properties: {},
    additionalProperties: true,
  }) as ToolDefinition<any, any, any>["parameters"];
  return {
    name: exposedName,
    label: schema?.label ?? `${host.manifest.id}:${toolName}`,
    description:
      schema?.description ??
      `Isolated plugin ${host.manifest.id} tool ${toolName}`,
    parameters: rawParameters,
    pluginMeta: {
      pluginId: host.manifest.id,
      pluginManifestSha256: host.manifest.manifestSha256,
    },
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
    ): Promise<AnyToolResult> {
      const onAbort = () => {
        void host.cancel(toolCallId).catch(() => undefined);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const raw = await host.callTool(toolName, params, {
          callId: toolCallId,
        });
        if (
          raw !== null &&
          typeof raw === "object" &&
          Array.isArray((raw as { content?: unknown }).content)
        ) {
          const candidate = raw as AnyToolResult;
          return {
            content: candidate.content,
            details: candidate.details ?? {},
            ...(candidate.structuredContent !== undefined
              ? { structuredContent: candidate.structuredContent }
              : {}),
            ...(candidate.isError === true ? { isError: true } : {}),
          };
        }
        const text =
          typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
        return {
          content: [{ type: "text", text }],
          details: {},
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "object" &&
                error !== null &&
                "message" in error &&
                typeof (error as { message: unknown }).message === "string"
              ? (error as { message: string }).message
              : String(error);
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof (error as { code: unknown }).code === "string"
            ? (error as { code: string }).code
            : undefined;
        if (code === "plugin.cancelled" || signal?.aborted === true) {
          const abortError = new Error(message);
          abortError.name = "AbortError";
          throw abortError;
        }
        return {
          content: [
            {
              type: "text",
              text:
                code === undefined
                  ? `plugin tool failed: ${message}`
                  : `plugin tool failed (${code}): ${message}`,
            },
          ],
          details: { ...(code === undefined ? {} : { code }) },
          isError: true,
        };
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function createHostRequestBridge(
  manifest: PluginManifest,
  getExecutor: () => PluginProductToolExecutor | null,
): (request: PluginRequest) => Promise<unknown> {
  return async (request: PluginRequest): Promise<unknown> => {
    const executor = getExecutor();
    if (executor === null) {
      throw new PluginError(
        "product tool executor is not available",
        "plugin.capability_denied",
      );
    }
    if (request.method === "tools/list") {
      return [...ALLOWED_HOST_CALLBACK_TOOLS].sort();
    }
    if (request.method !== "tools/call") {
      throw new PluginError(
        `unsupported host request method ${request.method}`,
        "plugin.unknown_method",
      );
    }
    const params = request.params;
    if (typeof params !== "object" || params === null) {
      throw new PluginError(
        "tools/call requires name and arguments",
        "plugin.invalid_request",
      );
    }
    const rawName = (params as { name?: unknown }).name;
    const rawArgs = (params as { arguments?: unknown }).arguments;
    if (typeof rawName !== "string" || rawName.length === 0) {
      throw new PluginError(
        "tools/call requires a non-empty tool name",
        "plugin.invalid_request",
      );
    }
    if (!ALLOWED_HOST_CALLBACK_TOOLS.has(rawName)) {
      throw new PluginError(
        `tool ${rawName} is not exposed to isolated plugins`,
        "plugin.capability_denied",
      );
    }
    if (
      (rawName === "web_fetch" || rawName === "web_search") &&
      !manifest.capabilities.includes("network")
    ) {
      throw new PluginError(
        `plugin ${manifest.id} did not declare the network capability`,
        "plugin.capability_denied",
      );
    }
    const argsRecord =
      rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    if (
      rawName === "web_fetch" &&
      manifest.networkAllow.length > 0 &&
      typeof argsRecord["url"] === "string"
    ) {
      let hostname = "";
      try {
        hostname = new URL(argsRecord["url"]).hostname;
      } catch {
        hostname = "";
      }
      if (
        hostname.length === 0 ||
        !matchesAllowedDomain(hostname, manifest.networkAllow)
      ) {
        throw new PluginError(
          `plugin ${manifest.id} network.allow does not permit ${argsRecord["url"]}`,
          "plugin.capability_denied",
        );
      }
    }
    const outcome = await executor({
      manifest,
      toolCallId: request.call_id,
      toolName: rawName,
      params: argsRecord,
    });
    if (outcome.decision === "deny") {
      const code = outcome.rule.startsWith("approval.")
        ? "plugin.approval_denied"
        : "plugin.policy_denied";
      const error = new PluginError(
        outcome.reason ?? `denied by ${outcome.rule}`,
        code,
      ) as PluginError & { details?: unknown };
      error.details = {
        rule: outcome.rule,
        decision: "deny",
      };
      throw error;
    }
    return outcome.result;
  };
}

export async function loadIsolatedPluginBundle(
  options: LoadIsolatedPluginsOptions,
): Promise<IsolatedPluginBundle> {
  const dir = normalizeAbsolute(options.extensionDir);
  if (!options.allowed) {
    return emptyIsolatedPluginBundle(dir, false);
  }
  const summary: PluginSummary = {
    enabled: true,
    dir,
    paths: [],
    errors: [],
    warnings: [],
  };
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyIsolatedPluginBundle(dir, true);
    }
    throw new PluginError(
      `cannot read plugin directory: ${(error as Error).message}`,
      "plugin.root",
    );
  }

  const legacyExtensionPaths: string[] = [];
  const candidateDirs: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = normalizeAbsolute(path.join(dir, entry.name));
    if (entry.isSymbolicLink()) {
      summary.errors.push(
        `[plugin.manifest_invalid] ${entry.name}: symlinked plugin entries are refused`,
      );
      continue;
    }
    if (entry.isFile()) {
      if (LEGACY_EXTENSION_FILE.test(entry.name)) {
        legacyExtensionPaths.push(fullPath);
        summary.warnings.push(
          `legacy extension ${entry.name} has no plugin.toml; command-only compatibility is active and tool registration remains blocked`,
        );
      } else {
        summary.errors.push(
          `[plugin.manifest_missing] ${entry.name}: unsupported file in extensions directory`,
        );
      }
      continue;
    }
    if (entry.isDirectory()) {
      candidateDirs.push(fullPath);
    }
  }

  const manifests: PluginManifest[] = [];
  const seenIds = new Map<string, string>();
  for (const candidateDir of candidateDirs) {
    try {
      const manifest = await loadPluginManifest(candidateDir);
      const existing = seenIds.get(manifest.id);
      if (existing !== undefined) {
        summary.errors.push(
          `[plugin.manifest_duplicate_id] ${manifest.id}: already declared in ${existing}`,
        );
        continue;
      }
      seenIds.set(manifest.id, candidateDir);
      manifests.push(manifest);
    } catch (error) {
      const code =
        error instanceof PluginError ? error.code : "plugin.manifest_invalid";
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push(
        `[${code}] ${path.basename(candidateDir)}: ${message}`,
      );
    }
  }

  const bufferedEvents: BufferedPluginLifecycleEvent[] = [];
  let liveSink:
    | ((
        kind: "plugin/started" | "plugin/stopped",
        data: Record<string, unknown>,
      ) => Promise<void> | void)
    | null = null;
  let executorRef: PluginProductToolExecutor | null = null;

  const emitLifecycle = async (
    kind: "plugin/started" | "plugin/stopped",
    data: Record<string, unknown>,
  ): Promise<void> => {
    if (liveSink !== null) {
      await liveSink(kind, data);
      return;
    }
    bufferedEvents.push({ kind, data });
  };

  const hosts: PluginHost[] = [];
  const startedManifests: PluginManifest[] = [];
  const tools: Array<
    ToolDefinition<any, any, any> & { pluginMeta: PluginExecutionMetadata }
  > = [];

  for (const manifest of manifests) {
    try {
      const hostOptions: PluginHostOptions = {
        manifest,
        onEvent: emitLifecycle,
        onHostRequest: createHostRequestBridge(manifest, () => executorRef),
        ...(options.startupTimeoutMs !== undefined
          ? { startupTimeoutMs: options.startupTimeoutMs }
          : {}),
        ...(options.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: options.requestTimeoutMs }
          : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
      };
      const host = await PluginHost.start(hostOptions);
      hosts.push(host);
      startedManifests.push(manifest);
      const schemaByName = new Map(
        host.toolDefinitions.map((item) => [item.name, item]),
      );
      const registeredTools = new Set(host.tools);
      for (const declaredTool of manifest.tools) {
        if (!registeredTools.has(declaredTool)) {
          summary.warnings.push(
            `plugin ${manifest.id} declared tool ${declaredTool} in plugin.toml, but entry did not register it`,
          );
          continue;
        }
        tools.push(
          buildRemoteToolDefinition(
            host,
            declaredTool,
            schemaByName.get(declaredTool),
          ),
        );
      }
      for (const extraTool of registeredTools) {
        if (!manifest.tools.includes(extraTool)) {
          summary.warnings.push(
            `plugin ${manifest.id} registered undeclared tool ${extraTool}; omitted by capability ceiling`,
          );
        }
      }
    } catch (error) {
      const code =
        error instanceof PluginError ? error.code : "plugin.start_failed";
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push(`[${code}] ${manifest.id}: ${message}`);
    }
  }

  summary.paths = [
    ...legacyExtensionPaths,
    ...startedManifests.map((manifest) => manifest.manifestPath),
  ].sort();

  return {
    enabled: true,
    legacyExtensionPaths,
    manifests: startedManifests,
    hosts,
    tools,
    summary,
    async flushLifecycleEvents(sink) {
      liveSink = sink;
      while (bufferedEvents.length > 0) {
        const next = bufferedEvents.shift()!;
        await sink(next.kind, next.data);
      }
    },
    bindProductToolExecutor(executor) {
      executorRef = executor;
    },
    async close() {
      await Promise.allSettled(hosts.map((host) => host.stop("shutdown")));
    },
  };
}
