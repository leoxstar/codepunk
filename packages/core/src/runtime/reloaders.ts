import path from "node:path";
import type { SignOffRequest } from "codepunk-protocol";
import type { PiHost } from "../adapters/pi/index.ts";
import type { AutonomyController } from "../autonomy/index.ts";
import {
  loadConfig,
  type CodepunkConfig,
  type ConfigOverrides,
} from "../config/index.ts";
import { readEvidenceFile } from "../evidence/index.ts";
import {
  emptyMcpBundle,
  loadMcpTools,
  type McpBundle,
  type McpServerStart,
} from "../mcp/index.ts";
import { isFallbackModel } from "../model/fallback.ts";
import { sha256Text } from "../platform/hash.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import {
  emptyIsolatedPluginBundle,
  loadIsolatedPluginBundle,
  type IsolatedPluginBundle,
} from "../plugin/runtime-bridge.ts";
import type { SessionStore } from "../session/index.ts";
import { loadSkills, type SkillBundle } from "../skills/index.ts";
import type { WorkspaceTrust } from "../trust/index.ts";
import { prepareSignOff } from "../verdict/index.ts";
import { deriveAndWriteVerdict } from "../verdict/store.ts";
import {
  CONFIG_SECTIONS,
  configValuesEqual,
  latestSignOffId,
} from "./helpers.ts";
import type {
  CodepunkRuntime,
  ConfigReloadResult,
  McpReloadResult,
  McpReloadSkip,
  PluginReloadResult,
  RunLedger,
  RuntimeOptions,
  RuntimeSignResult,
  SkillReloadResult,
} from "./types.ts";

export interface RuntimeReloadersDeps {
  options: RuntimeOptions;
  paths: ProjectPaths;
  environment: NodeJS.ProcessEnv;
  config: CodepunkConfig;
  configOverrides: ConfigOverrides;
  workspaceTrust: WorkspaceTrust;
  host: PiHost;
  session: SessionStore;
  ledger: RunLedger;
  autonomy: AutonomyController;
  disableSkills: boolean;
  disablePlugins: boolean;
  disableMcp: boolean;
  projectMcpTrusted: boolean;
  readableSkillFiles: string[];
  skillState: { current: SkillBundle };
  pluginState: { current: IsolatedPluginBundle };
  getMcp: () => McpBundle;
  setMcp: (next: McpBundle) => void;
  getPrimaryModel: () => CodepunkRuntime["primaryModel"];
  applyApprovalMode: (mode: CodepunkConfig["approval"]["mode"]) => void;
  applyAutonomy: (next: CodepunkConfig["autonomy"]) => Promise<void>;
  wirePluginBundle: (bundle: IsolatedPluginBundle) => Promise<void>;
}

export function createRuntimeReloaders(deps: RuntimeReloadersDeps): {
  reloadConfig: () => Promise<ConfigReloadResult>;
  signInProcess: CodepunkRuntime["signInProcess"];
  recordMemoryWrite: CodepunkRuntime["recordMemoryWrite"];
  reloadSkills: () => Promise<SkillReloadResult>;
  reloadPlugins: () => Promise<PluginReloadResult>;
  reloadMcp: () => Promise<McpReloadResult>;
} {
  const {
    options,
    paths,
    environment,
    config,
    configOverrides,
    workspaceTrust,
    host,
    session,
    ledger,
    autonomy,
    disableSkills,
    disablePlugins,
    disableMcp,
    projectMcpTrusted,
    readableSkillFiles,
    skillState,
    pluginState,
  } = deps;

  return {
    async reloadConfig(): Promise<ConfigReloadResult> {
      if (host.session.isStreaming) {
        throw new Error(
          "Wait for the current response to finish before reloading.",
        );
      }
      if (host.session.isCompacting) {
        throw new Error("Wait for compaction to finish before reloading.");
      }
      const loaded = await loadConfig(paths, environment, configOverrides, {
        projectTrusted: workspaceTrust.grants.config,
      });
      const next = loaded.config;
      const changedSections = CONFIG_SECTIONS.filter(
        (section) => !configValuesEqual(config[section], next[section]),
      );
      if (changedSections.length === 0) {
        return {
          changed: false,
          changedSections: [],
          applied: [],
          nextSession: [],
          blocked: [],
          warnings: [...loaded.warnings],
          pluginsChanged: false,
        };
      }

      const applied: string[] = [];
      const nextSession: string[] = [];
      const blocked: string[] = [];
      let autonomyBlocked = false;
      if (config.approval.mode !== next.approval.mode) {
        deps.applyApprovalMode(next.approval.mode);
        applied.push(`approval.mode=${next.approval.mode}`);
      }

      if (!configValuesEqual(config.autonomy, next.autonomy)) {
        try {
          await deps.applyAutonomy(next.autonomy);
          applied.push(`autonomy=${next.autonomy.profile}`);
        } catch (error) {
          autonomyBlocked = true;
          blocked.push(
            `autonomy: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      const reviewerChanged =
        config.approval.reviewer !== next.approval.reviewer ||
        config.approval.reviewer_model !== next.approval.reviewer_model ||
        config.approval.reviewer_timeout_ms !==
          next.approval.reviewer_timeout_ms;

      const pluginsChanged = !configValuesEqual(config.plugins, next.plugins);
      if (pluginsChanged) {
        config.plugins.enabled = next.plugins.enabled;
        applied.push(`plugins.enabled=${next.plugins.enabled}`);
      }

      if (!configValuesEqual(config.sandbox, next.sandbox)) {
        config.sandbox = structuredClone(next.sandbox);
      }
      if (!configValuesEqual(config.filesystem, next.filesystem)) {
        config.filesystem = structuredClone(next.filesystem);
      }

      for (const section of changedSections) {
        if (section === "approval") {
          if (reviewerChanged) {
            nextSession.push("approval.reviewer");
          }
          continue;
        }
        if (section === "autonomy") {
          if (autonomyBlocked) {
            nextSession.push("autonomy");
          }
          continue;
        }
        if (section === "plugins") {
          continue;
        }
        nextSession.push(section);
      }

      return {
        changed: true,
        changedSections,
        applied,
        nextSession,
        blocked,
        warnings: [...loaded.warnings],
        pluginsChanged,
      };
    },

    async signInProcess(verdict, signOptions = {}): Promise<RuntimeSignResult> {
      const request: Omit<SignOffRequest, "run_id"> = {
        version: 1,
        evidence_head: ledger.head ?? "",
        signed_verdict: verdict,
        channel: signOptions.channel ?? "tui",
        actor: signOptions.actor ?? "local-user",
        is_tty: signOptions.tty ?? true,
        source: "human",
        previous_sign_off_id: latestSignOffId(
          session.allEvents,
          host.currentRunId,
        ),
      };
      const currentEvidence = await readEvidenceFile(ledger.filePath);
      const prepared = prepareSignOff({
        runId: host.currentRunId,
        records: currentEvidence.records,
        events: session.allEvents,
        request: { ...request, run_id: host.currentRunId },
        ...(options.now !== undefined ? { now: options.now() } : {}),
      });
      if (!prepared.ok) {
        throw new Error(`${prepared.code}: ${prepared.message}`);
      }
      await session.append("verdict/sign_off", prepared.prepared.data);
      const result = await deriveAndWriteVerdict({
        paths,
        sessionId: session.sessionId,
        runId: host.currentRunId,
        evidencePath: ledger.filePath,
        events: session.allEvents,
        ...(options.now !== undefined ? { now: options.now() } : {}),
      });
      return {
        verdict: result.derivation.verdict,
        artifactPath: result.path,
        issues: result.derivation.issues,
      };
    },

    async recordMemoryWrite(input) {
      await session.append("memory/write", {
        scope: input.scope,
        action: input.action,
        memory_id: input.memoryId,
        content_sha256: input.contentSha256,
        source_refs: [...input.sourceRefs],
        reason: input.reason,
      });
    },

    async reloadSkills(): Promise<SkillReloadResult> {
      if (host.session.isStreaming) {
        throw new Error(
          "Wait for the current response to finish before reloading.",
        );
      }
      if (host.session.isCompacting) {
        throw new Error("Wait for compaction to finish before reloading.");
      }
      const previous = skillState.current;
      let next: SkillBundle;
      try {
        next = disableSkills
          ? { skills: [], block: "", warnings: [] }
          : await loadSkills({
              deliveryRoot: paths.deliveryRoot,
              codepunkHome: paths.home,
              projectTrusted: workspaceTrust.grants.skills,
            });
      } catch (error) {
        return {
          skipped: disableSkills ? ("disabled" as const) : null,
          skills: previous.skills,
          blockSha256: sha256Text(previous.block),
          warnings: previous.warnings,
          error: `skill discovery failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      const previousReadable = [...readableSkillFiles];
      try {
        host.replaceExtraInstruction(next.block);
        readableSkillFiles.splice(
          0,
          readableSkillFiles.length,
          ...next.skills.map((skill) => skill.path),
        );
        await host.session.reload();
      } catch (error) {
        host.replaceExtraInstruction(previous.block);
        readableSkillFiles.splice(
          0,
          readableSkillFiles.length,
          ...previousReadable,
        );
        await host.session.reload().catch(() => undefined);
        return {
          skipped: disableSkills ? ("disabled" as const) : null,
          skills: previous.skills,
          blockSha256: sha256Text(previous.block),
          warnings: previous.warnings,
          error: `Pi skill reload failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      skillState.current = next;
      const blockSha256 = sha256Text(next.block);
      let error: string | null = null;
      try {
        await host.recordEvent("skill/loaded", {
          skills: next.skills.map((skill) => ({
            name: skill.name,
            scope: skill.scope,
            sha256: skill.sha256,
            bytes: skill.bytes,
          })),
          block_sha256: blockSha256,
        });
      } catch (recordError) {
        error = `skill/loaded event failed: ${
          recordError instanceof Error
            ? recordError.message
            : String(recordError)
        }`;
      }
      return {
        skipped: disableSkills ? ("disabled" as const) : null,
        skills: next.skills,
        blockSha256,
        warnings: next.warnings,
        error,
      };
    },

    async reloadPlugins(): Promise<PluginReloadResult> {
      if (host.session.isStreaming) {
        throw new Error(
          "Wait for the current response to finish before reloading.",
        );
      }
      if (host.session.isCompacting) {
        throw new Error("Wait for compaction to finish before reloading.");
      }
      const mcp = deps.getMcp();
      const skipped: PluginReloadResult["skipped"] = disablePlugins
        ? "disabled"
        : autonomy.profile === "read-only"
          ? "read-only"
          : options.headless === true
            ? "headless"
            : !(options.allowPlugins === true || config.plugins.enabled)
              ? "disabled"
              : null;
      if (skipped !== null) {
        const previous = pluginState.current;
        const disabled = emptyIsolatedPluginBundle(
          path.join(paths.home, "extensions"),
          false,
        );
        pluginState.current = disabled;
        host.replaceExtensionPaths([]);
        await host.replaceExtraTools([...mcp.tools, ...mcp.resourceTools]);
        await host.session.reload();
        host.validateToolRegistry();
        await previous.close().catch(() => undefined);
        return { skipped, plugins: disabled.summary, error: null };
      }

      const previous = pluginState.current;
      let next: IsolatedPluginBundle | null = null;
      try {
        next = await loadIsolatedPluginBundle({
          allowed: true,
          extensionDir: path.join(paths.home, "extensions"),
          ...(options.now !== undefined ? { now: options.now } : {}),
        });
        host.replaceExtensionPaths(next.legacyExtensionPaths);
        await host.replaceExtraTools([
          ...mcp.tools,
          ...mcp.resourceTools,
          ...next.tools,
        ]);
        await host.session.reload();
        host.validateToolRegistry();
      } catch (error) {
        if (next !== null) {
          await next.close().catch(() => undefined);
        }
        host.replaceExtensionPaths(previous.legacyExtensionPaths);
        await host
          .replaceExtraTools([
            ...mcp.tools,
            ...mcp.resourceTools,
            ...previous.tools,
          ])
          .catch(() => undefined);
        await host.session.reload().catch(() => undefined);
        try {
          host.validateToolRegistry();
        } catch {
          // Preserve reload error; next model turn fails closed if unrestored.
        }
        return {
          skipped: null,
          plugins: previous.summary,
          error: `plugin reload failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }

      pluginState.current = next;
      await deps.wirePluginBundle(next);
      await previous.close().catch(() => undefined);
      const error =
        next.summary.errors.length === 0
          ? null
          : next.summary.errors.join("; ");
      return { skipped: null, plugins: next.summary, error };
    },

    async reloadMcp(): Promise<McpReloadResult> {
      if (host.session.isStreaming) {
        throw new Error(
          "Wait for the current response to finish before reloading.",
        );
      }
      if (host.session.isCompacting) {
        throw new Error("Wait for compaction to finish before reloading.");
      }
      const previous = deps.getMcp();
      const previousTools = [
        ...previous.tools,
        ...previous.resourceTools,
        ...pluginState.current.tools,
      ];
      const sessionModel = host.session.model;
      const hasModel =
        deps.getPrimaryModel() !== undefined ||
        (sessionModel !== undefined && !isFallbackModel(sessionModel));
      const skipped: McpReloadSkip | null = disableMcp
        ? "disabled"
        : !hasModel
          ? "no-model"
          : autonomy.profile === "read-only"
            ? "read-only"
            : null;
      const warnings: string[] = [];
      const starts: McpServerStart[] = [];
      let next: McpBundle | null = null;
      let error: string | null = null;

      if (skipped !== null) {
        next = emptyMcpBundle();
      } else {
        try {
          next = await loadMcpTools({
            paths,
            projectTrusted: projectMcpTrusted,
            strict: false,
            onServerStart: (start) => {
              starts.push(start);
            },
          });
        } catch (loadError) {
          error = `MCP configuration could not be loaded: ${
            loadError instanceof Error ? loadError.message : String(loadError)
          }`;
        }
      }

      let applied = false;
      if (next !== null) {
        try {
          await host.replaceExtraTools([
            ...next.tools,
            ...next.resourceTools,
            ...pluginState.current.tools,
          ]);
          applied = true;
        } catch (replaceError) {
          error = `MCP tools could not be registered: ${
            replaceError instanceof Error
              ? replaceError.message
              : String(replaceError)
          }`;
          await next.close().catch(() => undefined);
          next = null;
        }
      }

      try {
        await host.session.reload();
      } catch (reloadError) {
        const message =
          reloadError instanceof Error
            ? reloadError.message
            : String(reloadError);
        error =
          error === null
            ? `Pi reload failed: ${message}`
            : `${error}; Pi reload failed: ${message}`;
        if (applied && next !== null) {
          try {
            await host.replaceExtraTools(previousTools);
          } catch {
            // Keep original error; caller is told to restart the process.
          }
          applied = false;
        }
      }

      if (next === null || !applied) {
        if (next !== null) {
          await next.close().catch(() => undefined);
        }
        return {
          skipped: null,
          servers: [...previous.servers],
          toolCounts: { ...previous.toolCounts },
          resourceServers: [...previous.resourceServers],
          failures: [...previous.failures],
          warnings,
          error: error ?? "MCP reload did not apply",
        };
      }

      deps.setMcp(next);
      try {
        await previous.close();
      } catch (closeError) {
        warnings.push(
          `previous MCP servers could not be closed: ${
            closeError instanceof Error
              ? closeError.message
              : String(closeError)
          }`,
        );
      }
      for (const start of starts) {
        await host.recordEvent("mcp/server_start", start);
      }
      return {
        skipped,
        servers: [...next.servers],
        toolCounts: { ...next.toolCounts },
        resourceServers: [...next.resourceServers],
        failures: [...next.failures],
        warnings,
        error,
      };
    },
  };
}
