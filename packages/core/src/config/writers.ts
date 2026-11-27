import { promises as fs } from "node:fs";
import path from "node:path";
import type { AutonomyProfile } from "codepunk-protocol";
import {
  CLAIM_LOCK_STALE_MS,
  CLAIM_LOCK_TIMEOUT_MS,
  withClaimFileLock,
} from "../platform/file-lock.ts";
import { atomicWriteFile } from "../platform/fs.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import {
  APPROVAL_MODE_NAMES,
  CONFIG_FILE_NAME,
  ConfigError,
  PERMISSION_PROFILES,
  PERMISSION_PROFILE_NAMES,
  THEME_NAME,
  type ApprovalClass,
  type ApprovalMode,
  type CodepunkConfig,
  type CredentialStoreMode,
  type PermissionConfigUpdate,
  type PermissionProfile,
  type SandboxMode,
  type ThinkingLevel,
  type TuiPreferencesUpdate,
} from "./types.ts";
import { normalizeNetworkAllow, normalizeNetworkDeny } from "./validate.ts";

const CANONICAL_PROFILE_ORDER: readonly PermissionProfile[] =
  PERMISSION_PROFILE_NAMES;

const APPROVAL_MODES: readonly ApprovalMode[] = APPROVAL_MODE_NAMES;
const AUTONOMY_PROFILES: readonly AutonomyProfile[] = [
  "read-only",
  "ask",
  "scoped",
];
const SANDBOX_MODES: readonly SandboxMode[] = ["required", "uncovered"];

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => tomlString(value)).join(", ")}]`;
}

function isSectionHeader(line: string): boolean {
  return /^\s*\[/u.test(line);
}

function isSectionHeaderNamed(line: string, section: string): boolean {
  const match = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line);
  return match?.[1] === section;
}

function upsertSectionValues(
  content: string,
  section: string,
  requested: ReadonlyMap<string, string>,
): string {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  const start = lines.findIndex((line) => isSectionHeaderNamed(line, section));
  if (start < 0) {
    if (lines.length > 0 && lines.at(-1) !== "") {
      lines.push("");
    }
    lines.push(`[${section}]`);
    for (const [key, value] of requested) {
      lines.push(`${key} = ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isSectionHeader(lines[index]!)) {
      end = index;
      break;
    }
  }
  const seen = new Set<string>();
  const kept: string[] = [];
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]!;
    const match = /^\s*([A-Za-z0-9_-]+)\s*=/u.exec(line);
    const key = match?.[1];
    if (key !== undefined && requested.has(key)) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      kept.push(`${key} = ${requested.get(key)}`);
      continue;
    }
    kept.push(line);
  }
  const missing = [...requested].filter(([key]) => !seen.has(key));
  if (missing.length > 0) {
    let insertion = kept.length;
    while (insertion > 0 && kept[insertion - 1]!.trim() === "") {
      insertion -= 1;
    }
    kept.splice(
      insertion,
      0,
      ...missing.map(([key, value]) => `${key} = ${value}`),
    );
  }
  const output = [...lines.slice(0, start + 1), ...kept, ...lines.slice(end)];
  return `${output.join("\n").replace(/\n+$/u, "")}\n`;
}

function upsertModelSection(
  content: string,
  values: { provider: string; id: string; thinking?: ThinkingLevel },
): string {
  const requested = new Map<string, string>([
    ["provider", tomlString(values.provider)],
    ["id", tomlString(values.id)],
  ]);
  if (values.thinking !== undefined) {
    requested.set("thinking", tomlString(values.thinking));
  }
  return upsertSectionValues(content, "model", requested);
}

/**
 * Serialize read-modify-write of the user config so concurrent writes cannot
 * lose each other's updates. Fails closed when the wait times out.
 */
async function withUserConfigLock<T>(
  paths: ProjectPaths,
  operation: () => Promise<T>,
): Promise<T> {
  const lockDir = path.join(paths.home, `${CONFIG_FILE_NAME}.lock.d`);
  return withClaimFileLock(
    {
      lockDir,
      timeoutMs: CLAIM_LOCK_TIMEOUT_MS,
      staleMs: CLAIM_LOCK_STALE_MS,
      busyError: () =>
        new ConfigError(`user config is locked by another process`),
    },
    operation,
  );
}

async function readUserConfigContent(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw new ConfigError(
      `cannot read ${filePath}: ${(error as Error).message}`,
    );
  }
}

export async function writeUserModelSelection(
  paths: ProjectPaths,
  provider: string,
  id: string,
  thinking?: ThinkingLevel,
): Promise<string> {
  const filePath = path.join(paths.home, CONFIG_FILE_NAME);
  return withUserConfigLock(paths, async () => {
    const content = await readUserConfigContent(filePath);
    await atomicWriteFile(
      filePath,
      upsertModelSection(content, {
        provider,
        id,
        ...(thinking === undefined ? {} : { thinking }),
      }),
      0o600,
    );
    return filePath;
  });
}

export async function writeUserThinkingSelection(
  paths: ProjectPaths,
  thinking: ThinkingLevel,
): Promise<string> {
  const levels: readonly ThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  if (!levels.includes(thinking)) {
    throw new ConfigError(
      `thinking must be one of ${levels.join(", ")}`,
      "model.thinking",
    );
  }
  const filePath = path.join(paths.home, CONFIG_FILE_NAME);
  return withUserConfigLock(paths, async () => {
    const content = await readUserConfigContent(filePath);
    await atomicWriteFile(
      filePath,
      upsertSectionValues(
        content,
        "model",
        new Map([["thinking", tomlString(thinking)]]),
      ),
      0o600,
    );
    return filePath;
  });
}

export async function writeUserTuiPreferences(
  paths: ProjectPaths,
  update: TuiPreferencesUpdate,
): Promise<string> {
  const tuiValues = new Map<string, string>();
  if (update.theme !== undefined) {
    if (!THEME_NAME.test(update.theme)) {
      throw new ConfigError(
        "tui.theme must be a valid theme name",
        "tui.theme",
      );
    }
    tuiValues.set("theme", tomlString(update.theme));
  }
  if (update.hideThinking !== undefined) {
    tuiValues.set("hide_thinking", update.hideThinking ? "true" : "false");
  }
  if (update.header !== undefined) {
    tuiValues.set("header", update.header ? "true" : "false");
  }
  if (update.status !== undefined) {
    tuiValues.set("status", update.status ? "true" : "false");
  }
  if (update.widgets !== undefined) {
    tuiValues.set("widgets", update.widgets ? "true" : "false");
  }
  const contextValues = new Map<string, string>();
  if (update.compaction !== undefined) {
    if (update.compaction !== "auto" && update.compaction !== "manual") {
      throw new ConfigError(
        "context.compaction must be auto or manual",
        "context.compaction",
      );
    }
    contextValues.set("compaction", tomlString(update.compaction));
  }
  const filePath = path.join(paths.home, CONFIG_FILE_NAME);
  if (tuiValues.size === 0 && contextValues.size === 0) {
    return filePath;
  }
  return withUserConfigLock(paths, async () => {
    let content = await readUserConfigContent(filePath);
    if (tuiValues.size > 0) {
      content = upsertSectionValues(content, "tui", tuiValues);
    }
    if (contextValues.size > 0) {
      content = upsertSectionValues(content, "context", contextValues);
    }
    await atomicWriteFile(filePath, content, 0o600);
    return filePath;
  });
}

export function isPermissionProfile(value: string): value is PermissionProfile {
  return Object.hasOwn(PERMISSION_PROFILES, value);
}

export function permissionProfileFor(
  config: Pick<
    CodepunkConfig,
    "approval" | "autonomy" | "sandbox" | "filesystem"
  >,
): PermissionProfile | "custom" {
  for (const name of CANONICAL_PROFILE_ORDER) {
    const settings = PERMISSION_PROFILES[name];
    if (
      config.approval.mode === settings.approval &&
      config.autonomy.profile === settings.autonomy &&
      config.sandbox.mode === settings.sandbox &&
      config.filesystem.mode === settings.filesystem
    ) {
      return name;
    }
  }
  return "custom";
}

export function permissionBehaviorSummary(
  config: Pick<
    CodepunkConfig,
    "approval" | "autonomy" | "sandbox" | "filesystem"
  >,
): string {
  const parts: string[] = [];
  if (config.autonomy.profile === "read-only") {
    parts.push(
      "read-only denies file mutations and ask-level actions; safe reads stay available",
    );
  } else if (config.approval.mode === "allow") {
    parts.push(
      "allow approves every non-MCP ask; MCP calls still need a human",
    );
  } else if (config.approval.mode === "auto") {
    parts.push(
      "auto approves routine and ordinary shell classes; destructive, network, dynamic, protected, sensitive, unknown, and MCP asks stay gated",
    );
  } else if (config.approval.mode === "deny") {
    parts.push("deny refuses ask-level actions");
  } else {
    parts.push("ask prompts for ask-level actions");
  }
  if (config.autonomy.profile === "scoped") {
    parts.push(
      "scoped autonomy is an exact-argv allowlist; unmatched actions never fall through to blanket approval",
    );
  }
  if (config.sandbox.mode === "required") {
    parts.push(
      config.sandbox.network_allow.length === 0
        ? "sandbox is required (srt); network egress is deny-by-default"
        : `sandbox is required (srt); network egress allows ${config.sandbox.network_allow.join(", ")}`,
    );
  } else {
    parts.push("sandbox is uncovered (shell follows host permissions)");
  }
  parts.push(
    config.filesystem.mode === "full"
      ? "filesystem is full and needs the dangerous start flag"
      : "filesystem is limited to the workspace",
  );
  return parts.join("; ");
}

/**
 * The effective shell-approval behavior of a decision, given the configured
 * approval mode. `decidePolicy` reports the policy intent; with
 * `approval.mode = "allow"` every sandbox-covered `ask` decision runs without
 * a prompt, with `auto` only routine and shell classes do, and with `deny`
 * every `ask` is refused. Dynamic launchers/interpreters, network, destructive,
 * explicit-policy, protected, sensitive, MCP, and unknown classes still ask in
 * auto mode. `allow` covers every sandbox-covered action, but MCP stays at the
 * human gate because the server and its side effects run outside the shell
 * sandbox. Reporting the raw policy
 * decision alone would misdescribe that.
 */
export function effectiveApprovalDecision(
  decision: "allow" | "ask" | "deny",
  approvalMode: ApprovalMode,
  approvalClass: ApprovalClass = "unknown",
): { decision: "allow" | "ask" | "deny"; requiresApproval: boolean } {
  if (decision !== "ask") {
    return { decision, requiresApproval: false };
  }
  if (approvalMode === "allow" && approvalClass !== "mcp") {
    return { decision: "allow", requiresApproval: false };
  }
  if (
    approvalMode === "auto" &&
    (approvalClass === "routine" || approvalClass === "shell")
  ) {
    return { decision: "allow", requiresApproval: false };
  }
  if (approvalMode === "deny") {
    return { decision: "deny", requiresApproval: false };
  }
  return { decision: "ask", requiresApproval: true };
}

export async function writeUserPermissionProfile(
  paths: ProjectPaths,
  profile: PermissionProfile,
): Promise<string> {
  if (!isPermissionProfile(profile)) {
    throw new ConfigError(
      `permission profile must be one of ${PERMISSION_PROFILE_NAMES.join(", ")}; workspace trust is a separate /trust decision`,
      "permissions.profile",
    );
  }
  return writeUserPermissionSelection(paths, PERMISSION_PROFILES[profile]);
}

export async function writeUserPermissionSelection(
  paths: ProjectPaths,
  update: PermissionConfigUpdate,
): Promise<string> {
  if (
    update.approval !== undefined &&
    !APPROVAL_MODES.includes(update.approval)
  ) {
    throw new ConfigError("invalid approval mode", "approval.mode");
  }
  if (
    update.reviewer !== undefined &&
    update.reviewer !== "off" &&
    update.reviewer !== "model"
  ) {
    throw new ConfigError("invalid approval reviewer", "approval.reviewer");
  }
  if (update.reviewerModel !== undefined && update.reviewerModel !== null) {
    const separator = update.reviewerModel.indexOf("/");
    if (
      separator <= 0 ||
      separator === update.reviewerModel.length - 1 ||
      /\s/u.test(update.reviewerModel)
    ) {
      throw new ConfigError(
        "reviewer model must use provider/model",
        "approval.reviewer_model",
      );
    }
  }
  if (
    update.reviewerTimeoutMs !== undefined &&
    (!Number.isSafeInteger(update.reviewerTimeoutMs) ||
      update.reviewerTimeoutMs < 1_000)
  ) {
    throw new ConfigError(
      "reviewer timeout must be an integer of at least 1000 ms",
      "approval.reviewer_timeout_ms",
    );
  }
  if (
    update.autonomy !== undefined &&
    !AUTONOMY_PROFILES.includes(update.autonomy)
  ) {
    throw new ConfigError("invalid autonomy profile", "autonomy.profile");
  }
  if (
    update.scopedRules !== undefined &&
    (update.autonomy !== "scoped" || !path.isAbsolute(update.scopedRules))
  ) {
    throw new ConfigError(
      "scoped rules require the scoped autonomy profile and an absolute path",
      "autonomy.scoped_rules",
    );
  }
  if (update.sandbox !== undefined && !SANDBOX_MODES.includes(update.sandbox)) {
    throw new ConfigError("invalid sandbox mode", "sandbox.mode");
  }
  if (
    update.filesystem !== undefined &&
    update.filesystem !== "workspace" &&
    update.filesystem !== "full"
  ) {
    throw new ConfigError("invalid filesystem mode", "filesystem.mode");
  }
  const networkAllow =
    update.networkAllow === undefined
      ? undefined
      : normalizeNetworkAllow(update.networkAllow);
  const networkDeny =
    update.networkDeny === undefined
      ? undefined
      : normalizeNetworkDeny(update.networkDeny);
  const filePath = path.join(paths.home, CONFIG_FILE_NAME);
  return withUserConfigLock(paths, async () => {
    let content = await readUserConfigContent(filePath);
    if (
      update.approval !== undefined ||
      update.reviewer !== undefined ||
      update.reviewerModel !== undefined ||
      update.reviewerTimeoutMs !== undefined
    ) {
      const approval = new Map<string, string>();
      if (update.approval !== undefined) {
        approval.set("mode", tomlString(update.approval));
      }
      if (update.reviewer !== undefined) {
        approval.set("reviewer", tomlString(update.reviewer));
        if (update.reviewer === "off" && update.reviewerModel === undefined) {
          // Leaving a model reference behind would make the next loadConfig
          // reject `reviewer = "off"` as an inconsistent configuration.
          approval.set("reviewer_model", tomlString("null"));
        }
      }
      if (update.reviewerModel !== undefined) {
        approval.set(
          "reviewer_model",
          update.reviewerModel === null
            ? tomlString("null")
            : tomlString(update.reviewerModel),
        );
      }
      if (update.reviewerTimeoutMs !== undefined) {
        approval.set("reviewer_timeout_ms", String(update.reviewerTimeoutMs));
      }
      content = upsertSectionValues(content, "approval", approval);
    }
    if (update.autonomy !== undefined) {
      const autonomy = new Map([["profile", tomlString(update.autonomy)]]);
      if (update.scopedRules !== undefined) {
        autonomy.set("scoped_rules", tomlString(update.scopedRules));
      }
      content = upsertSectionValues(content, "autonomy", autonomy);
    }
    if (update.sandbox !== undefined) {
      content = upsertSectionValues(
        content,
        "sandbox",
        new Map([["mode", tomlString(update.sandbox)]]),
      );
    }
    if (networkAllow !== undefined) {
      content = upsertSectionValues(
        content,
        "sandbox",
        new Map([["network_allow", tomlStringArray(networkAllow)]]),
      );
    }
    if (networkDeny !== undefined) {
      content = upsertSectionValues(
        content,
        "sandbox",
        new Map([["network_deny", tomlStringArray(networkDeny)]]),
      );
    }
    if (update.filesystem !== undefined) {
      content = upsertSectionValues(
        content,
        "filesystem",
        new Map([["mode", tomlString(update.filesystem)]]),
      );
    }
    await atomicWriteFile(filePath, content, 0o600);
    return filePath;
  });
}

export async function writeUserCredentialStoreSelection(
  paths: ProjectPaths,
  mode: CredentialStoreMode,
): Promise<string> {
  if (mode !== "file" && mode !== "keychain" && mode !== "auto") {
    throw new ConfigError(
      "model.credential_store must be file, keychain, or auto",
      "model.credential_store",
    );
  }
  const filePath = path.join(paths.home, CONFIG_FILE_NAME);
  return withUserConfigLock(paths, async () => {
    const content = await readUserConfigContent(filePath);
    await atomicWriteFile(
      filePath,
      upsertSectionValues(
        content,
        "model",
        new Map([["credential_store", tomlString(mode)]]),
      ),
      0o600,
    );
    return filePath;
  });
}

export async function writeUserPluginsEnabled(
  paths: ProjectPaths,
  enabled: boolean,
): Promise<string> {
  if (typeof enabled !== "boolean") {
    throw new ConfigError(
      "plugins.enabled must be a boolean",
      "plugins.enabled",
    );
  }
  const filePath = path.join(paths.home, CONFIG_FILE_NAME);
  return withUserConfigLock(paths, async () => {
    const content = await readUserConfigContent(filePath);
    await atomicWriteFile(
      filePath,
      upsertSectionValues(
        content,
        "plugins",
        new Map([["enabled", enabled ? "true" : "false"]]),
      ),
      0o600,
    );
    return filePath;
  });
}
