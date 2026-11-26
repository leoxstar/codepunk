import type {
  AgentSession,
  AgentSessionServices,
  InlineExtension,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { EvidenceRecord, Verdict } from "codepunk-protocol";
import type { createPiHost, PiHost } from "../adapters/pi/index.ts";
import type { ApprovalBroker, ApprovalChannel } from "../approval/index.ts";
import type { AutonomyController } from "../autonomy/index.ts";
import type { CheckpointStore } from "../checkpoints/index.ts";
import type {
  CodepunkConfig,
  ConfigOverrides,
  FilesystemMode,
  LoadedConfig,
} from "../config/index.ts";
import type { PolicyFiles } from "../config/policy.ts";
import {
  EvidenceLedger,
  type EvidenceAppendInput,
  type EvidenceLedgerPort,
} from "../evidence/index.ts";
import type { MemoryManager } from "../memory/index.ts";
import type { McpServerFailure } from "../mcp/index.ts";
import type { ConfiguredModel, ModelUsageSummary } from "../model/index.ts";
import type { ProjectContext, ProjectPaths } from "../platform/paths.ts";
import type { PluginSummary } from "../plugin/index.ts";
import type { ShellProvider } from "../sandbox/index.ts";
import type { SessionStore } from "../session/index.ts";
import type { SkillSource } from "../skills/index.ts";
import type { AskUserChannel } from "../tools/ask-user.ts";
import type { SubagentToolExecutor } from "../tools/subagent.ts";
import type {
  WorkspaceTrust,
  WorkspaceTrustGrants,
  WorkspaceTrustSource,
} from "../trust/index.ts";
import { evidenceRunPath } from "../verdict/store.ts";
import type { PlanModeState } from "../work/index.ts";

export interface RuntimeOptions {
  cwd: string;
  additionalDirs?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  configOverrides?: ConfigOverrides;
  model?: NonNullable<Parameters<typeof createPiHost>[0]["model"]>;
  sessionId?: string;
  sessionPath?: string;
  newSessionId?: string;
  parentSessionId?: string;
  continueSession?: boolean;
  newSession?: boolean;
  allowPlugins?: boolean;
  allowFullFilesystem?: boolean;
  headless?: boolean;
  headlessPolicyPath?: string;
  allowUnsandboxedShell?: boolean;
  /**
   * Per-resource workspace decision captured before the host starts. It
   * overrides saved decisions for this runtime only. Consumers must read the
   * matching grant instead of a single boolean.
   */
  projectTrust?: WorkspaceTrustGrants;
  projectTrustSource?: WorkspaceTrustSource;
  allowMissingModel?: boolean;
  disableMcp?: boolean;
  deferMcp?: boolean;
  disableSkills?: boolean;
  disablePlugins?: boolean;
  bare?: boolean;
  approvalChannel?: ApprovalChannel | null;
  questionChannel?: AskUserChannel | null;
  subagentExecutor?: SubagentToolExecutor | null;
  bindMode?: "print" | "tui";
  runId?: string;
  additionalExtensionFactories?: readonly InlineExtension[];
  now?: () => Date;
  timeZone?: string;
}

export interface RuntimeSignResult {
  verdict: Verdict;
  artifactPath: string;
  issues: string[];
}

export class RunLedger implements EvidenceLedgerPort {
  private current: EvidenceLedger | null = null;
  private currentPath: string | null = null;
  private readonly paths: ProjectPaths;
  private readonly sessionId: string;
  private runId: string;

  constructor(paths: ProjectPaths, sessionId: string, runId: string) {
    this.paths = paths;
    this.sessionId = sessionId;
    this.runId = runId;
  }

  async prepare(runId: string): Promise<void> {
    this.runId = runId;
    this.currentPath = evidenceRunPath(this.paths, this.sessionId, runId);
    this.current = await EvidenceLedger.open(this.currentPath);
  }

  get filePath(): string {
    if (this.currentPath === null) {
      throw new Error("run ledger is not initialized");
    }
    return this.currentPath;
  }

  get all(): readonly EvidenceRecord[] {
    return this.current?.all ?? [];
  }

  get head(): string | null {
    return this.current?.head ?? null;
  }

  get hasTruncatedTail(): boolean {
    return this.current?.hasTruncatedTail ?? false;
  }

  async append(input: EvidenceAppendInput): Promise<EvidenceRecord> {
    if (this.current === null) {
      throw new Error("run ledger is not initialized");
    }
    return this.current.append(input);
  }

  get activeRunId(): string {
    return this.runId;
  }
}

export type McpReloadSkip = "disabled" | "no-model" | "read-only";

export interface McpReloadResult {
  skipped: McpReloadSkip | null;
  servers: readonly string[];
  toolCounts: Readonly<Record<string, number>>;
  resourceServers: readonly string[];
  failures: readonly McpServerFailure[];
  warnings: readonly string[];
  error: string | null;
}

export interface SkillReloadResult {
  skipped: "disabled" | null;
  skills: readonly SkillSource[];
  blockSha256: string;
  warnings: readonly string[];
  error: string | null;
}

export interface PluginReloadResult {
  skipped: "disabled" | "read-only" | "headless" | null;
  plugins: PluginSummary;
  error: string | null;
}

export interface ConfigReloadResult {
  changed: boolean;
  changedSections: readonly string[];
  applied: readonly string[];
  nextSession: readonly string[];
  blocked: readonly string[];
  warnings: readonly string[];
  pluginsChanged: boolean;
}

export interface CodepunkRuntime {
  project: ProjectContext;
  paths: ProjectPaths;
  config: CodepunkConfig;
  configOverrides: ConfigOverrides;
  loadedConfig: LoadedConfig;
  policy: PolicyFiles;
  plugins: PluginSummary;
  skills: readonly SkillSource[];
  isolation: {
    bare: boolean;
    context: boolean;
    skills: boolean;
    plugins: boolean;
    mcp: boolean;
    memory: boolean;
  };
  mcpServers: readonly string[];
  mcpStatus: "ready" | "connecting" | "skipped" | "failed";
  mcpReady: Promise<void>;
  mcpStartupWarnings: readonly string[];
  workspaceTrust: WorkspaceTrust;
  memory: MemoryManager;
  session: SessionStore;
  checkpoints: CheckpointStore;
  ledger: RunLedger;
  sandbox: ShellProvider | null;
  sandboxReady: Promise<ShellProvider | null>;
  shellPreflightIssue: string | null;
  shellPreflightSettled(): Promise<void>;
  autonomy: AutonomyController;
  approval: ApprovalBroker;
  host: PiHost;
  primaryModel: ConfiguredModel | undefined;
  fallbackModels: readonly string[];
  runId: string;
  evidencePath: string;
  /**
   * Execution settings bound when this host started. Approval and ordinary
   * autonomy changes apply live; entering or leaving read-only with an active
   * srt shell requires a restart, and sandbox/filesystem/network changes are
   * next-session settings. Explanations must not read the mutated config
   * snapshot for these values.
   */
  permissionSnapshot: {
    filesystem: FilesystemMode;
    readOnly: boolean;
    networkAllow: readonly string[];
    networkDeny: readonly string[];
  };
  usage(): ModelUsageSummary;
  setApprovalMode(mode: "ask" | "deny" | "auto" | "allow"): void;
  planMode: {
    state(): PlanModeState | null;
    enter(): Promise<PlanModeState>;
    approve(): Promise<PlanModeState>;
    exit(): Promise<PlanModeState>;
  };
  /**
   * Re-read the layered Codepunk config without replacing the session.
   * Approval mode, autonomy, and the plugin-enable switch can take effect
   * live. Settings bound into the Pi host or OS sandbox are reported for the
   * next session and are not applied to the active execution boundary.
   */
  reloadConfig(): Promise<ConfigReloadResult>;
  signInProcess(
    verdict: "complete" | "incomplete",
    options?: { channel?: "tui" | "cli"; actor?: string; tty?: boolean },
  ): Promise<RuntimeSignResult>;
  recordMemoryWrite(input: {
    scope: "user" | "project";
    action: "add" | "edit" | "delete" | "archive" | "reject";
    memoryId: string | null;
    contentSha256: string | null;
    sourceRefs: readonly string[];
    reason: string | null;
  }): Promise<void>;
  /**
   * Re-read `$CODEPUNK_HOME/mcp.toml`, replace the MCP tool surface, and let
   * Pi rebuild its extension/tool registry. This is the `/reload` path; it
   * does not recreate the Codepunk session or its evidence chain.
   */
  reloadMcp(): Promise<McpReloadResult>;
  /**
   * Re-discover user and trusted project skills, replace the injected skill
   * block and the readable-skill policy exception, then rebuild Pi's prompt
   * registry in place.
   */
  reloadSkills(): Promise<SkillReloadResult>;
  /**
   * Re-scan `$CODEPUNK_HOME/extensions`, replace Pi's extension path set, and
   * rebuild the extension/tool registry without recreating the session.
   * Disabled, read-only, and headless sessions keep plugins off.
   */
  reloadPlugins(): Promise<PluginReloadResult>;
  dispose(): Promise<void>;
}

export type { AgentSession, AgentSessionServices, SessionManager };
