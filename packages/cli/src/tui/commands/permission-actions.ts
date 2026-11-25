import {
  APPROVAL_MODE_NAMES,
  PERMISSION_PROFILES,
  decidePolicy,
  explainPermission,
  formatPermissionExplanation,
  isPermissionProfile,
  loadScopedRules,
  writeUserPermissionProfile,
  writeUserPermissionSelection,
  type CodepunkRuntime,
  type FilesystemMode,
  type PermissionProfile,
  type ScopedRule,
} from "codepunk-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AUTONOMY_PROFILES,
  FILESYSTEM_MODES,
  SANDBOX_MODES,
  permissionPicker,
  permissionUsage,
} from "../format/permissions.ts";
import { parsePermissionWhyCommand } from "../chrome/help.ts";
import { setupChrome } from "../chrome/setup.ts";
import type { TuiState } from "../state.ts";
import { permissionSummary } from "../format/status.ts";
import { setAutonomyProfile } from "./trust-actions.ts";
import { handleSandboxNetwork } from "./permission-network.ts";
import { handleReviewer } from "./permission-reviewer.ts";

async function configurePermissionProfile(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
  value: string,
): Promise<void> {
  if (!isPermissionProfile(value)) {
    if (value === "trusted") {
      context.ui.notify(
        [
          "permission profile trusted was removed because it collides with workspace trust.",
          "Use /permissions profile auto-approve for blanket approval.",
          "Use /trust grant [kinds] to trust this workspace's project resources.",
        ].join("\n"),
        "warning",
      );
      return;
    }
    context.ui.notify(permissionUsage(), "warning");
    return;
  }
  const profile = value as PermissionProfile;
  if (profile === "full-access") {
    context.ui.notify(
      [
        "full-access cannot be enabled from a running session.",
        "Exit and restart with:",
        "  codepunk --permission-mode full-access --dangerously-bypass-approvals-and-sandbox",
        "Or persist it with `codepunk permissions profile full-access` and start the next session with the dangerous flag.",
      ].join("\n"),
      "warning",
    );
    return;
  }
  const settings = PERMISSION_PROFILES[profile];
  const previousApproval = runtime.config.approval.mode;
  const previousAutonomy = runtime.autonomy.profile;
  runtime.setApprovalMode(settings.approval);
  try {
    await setAutonomyProfile(runtime, settings.autonomy);
  } catch (error) {
    runtime.setApprovalMode(previousApproval);
    context.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
    return;
  }
  try {
    await writeUserPermissionProfile(runtime.paths, profile);
  } catch (error) {
    runtime.setApprovalMode(previousApproval);
    await setAutonomyProfile(runtime, previousAutonomy);
    context.ui.notify(
      `permission was not saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
    return;
  }
  runtime.config.sandbox.mode = settings.sandbox;
  runtime.config.filesystem.mode = settings.filesystem;
  runtime.config.approval.mode = settings.approval;
  runtime.config.autonomy.profile = settings.autonomy;
  context.ui.notify(
    [
      `permission profile set to ${profile}`,
      `approvals ${settings.approval} · autonomy ${settings.autonomy} · sandbox ${settings.sandbox} · filesystem ${settings.filesystem}`,
      "approvals and autonomy apply to this session; sandbox and filesystem apply to the next session",
      settings.sandbox === "required"
        ? "next session requests srt; run codepunk doctor if the sandbox is unavailable"
        : "next session has no shell unless started with --allow-unsandboxed-shell; executions are recorded as uncovered",
      `config: ${runtime.paths.home}/config.toml`,
    ].join("\n"),
    "info",
  );
}

async function configureApprovalMode(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
  value: string,
): Promise<void> {
  if (!(APPROVAL_MODE_NAMES as readonly string[]).includes(value)) {
    context.ui.notify(permissionUsage(), "warning");
    return;
  }
  const previous = runtime.config.approval.mode;
  runtime.setApprovalMode(value as (typeof APPROVAL_MODE_NAMES)[number]);
  try {
    await writeUserPermissionSelection(runtime.paths, {
      approval: value as (typeof APPROVAL_MODE_NAMES)[number],
    });
  } catch (error) {
    runtime.setApprovalMode(previous);
    context.ui.notify(
      `permission was not saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
    return;
  }
  context.ui.notify(
    `approvals set to ${value}\nconfig: ${runtime.paths.home}/config.toml`,
    "info",
  );
}

async function configureAutonomyProfile(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
  value: string,
): Promise<void> {
  if (!(AUTONOMY_PROFILES as readonly string[]).includes(value)) {
    context.ui.notify(permissionUsage(), "warning");
    return;
  }
  const previous = runtime.autonomy.profile;
  try {
    await setAutonomyProfile(
      runtime,
      value as (typeof AUTONOMY_PROFILES)[number],
    );
  } catch (error) {
    context.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
    return;
  }
  try {
    await writeUserPermissionSelection(runtime.paths, {
      autonomy: value as (typeof AUTONOMY_PROFILES)[number],
    });
  } catch (error) {
    await setAutonomyProfile(runtime, previous);
    context.ui.notify(
      `permission was not saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
    return;
  }
  runtime.config.autonomy.profile = value as (typeof AUTONOMY_PROFILES)[number];
  context.ui.notify(
    `autonomy set to ${value}\nconfig: ${runtime.paths.home}/config.toml`,
    "info",
  );
}

async function configureSandboxMode(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
  value: string,
): Promise<void> {
  if (!(SANDBOX_MODES as readonly string[]).includes(value)) {
    context.ui.notify(permissionUsage(), "warning");
    return;
  }
  try {
    await writeUserPermissionSelection(runtime.paths, {
      sandbox: value as (typeof SANDBOX_MODES)[number],
    });
  } catch (error) {
    context.ui.notify(
      `permission was not saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
    return;
  }
  runtime.config.sandbox.mode = value as (typeof SANDBOX_MODES)[number];
  context.ui.notify(
    [
      `sandbox set to ${value} for the next session`,
      `current session: ${runtime.sandbox?.sandboxed === true ? "srt" : runtime.sandbox === null ? "no shell" : "explicit unsandboxed shell"}`,
      value === "required"
        ? "next session requests srt; run codepunk doctor if the sandbox is unavailable"
        : "next session has no shell unless started with --allow-unsandboxed-shell; executions are recorded as uncovered",
    ].join("\n"),
    "warning",
  );
}

async function configureFilesystemMode(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
  value: string,
): Promise<void> {
  if (!(FILESYSTEM_MODES as readonly string[]).includes(value)) {
    context.ui.notify(permissionUsage(), "warning");
    return;
  }
  try {
    await writeUserPermissionSelection(runtime.paths, {
      filesystem: value as FilesystemMode,
    });
  } catch (error) {
    context.ui.notify(
      `permission was not saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
    return;
  }
  runtime.config.filesystem.mode = value as FilesystemMode;
  context.ui.notify(
    [
      `filesystem set to ${value} for the next session`,
      value === "full"
        ? "next session removes the workspace boundary; start it with --dangerously-bypass-approvals-and-sandbox"
        : "next session is confined to the workspace and write set",
    ].join("\n"),
    "warning",
  );
}

export async function scopedRulesSummary(
  runtime: CodepunkRuntime,
): Promise<string> {
  const filePath = runtime.config.autonomy.scoped_rules;
  if (filePath === null) {
    return [
      "Scoped rules: none.",
      'Approval choices that say "Always allow exact" write here.',
    ].join("\n");
  }
  try {
    const loaded = await loadScopedRules(filePath, runtime.paths);
    return [
      `Scoped rules: ${loaded.rules.length} (profile ${runtime.autonomy.profile})`,
      `file: ${loaded.path}`,
      ...loaded.rules.map((rule) => `  ${rule.id}: ${rule.argv.join(" ")}`),
    ].join("\n");
  } catch (error) {
    return `Scoped rules could not be read: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function showPermissionPanel(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
): Promise<boolean> {
  try {
    const { createPermissionPanel } =
      await import("../components/permission-panel.ts");
    await context.ui.custom<void>((_tui, theme, keybindings, done) =>
      createPermissionPanel(runtime, theme, keybindings, done),
    );
    return true;
  } catch {
    return false;
  }
}

async function showScopedRulesTable(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
): Promise<boolean> {
  let view: { filePath: string | null; rules: readonly ScopedRule[] };
  const filePath = runtime.config.autonomy.scoped_rules;
  if (filePath === null) {
    view = { filePath: null, rules: [] };
  } else {
    try {
      const loaded = await loadScopedRules(filePath, runtime.paths);
      view = { filePath: loaded.path, rules: loaded.rules };
    } catch {
      return false;
    }
  }
  try {
    const [
      { createTableScreen },
      { scopedRulesTableOptions, scopedRulesTitle },
    ] = await Promise.all([
      import("../components/table-screen.ts"),
      import("../components/scoped-rules-table.ts"),
    ]);
    await context.ui.custom<void>((_tui, theme, keybindings, done) =>
      createTableScreen(
        {
          title: scopedRulesTitle(view, runtime.autonomy.profile),
          table: scopedRulesTableOptions(view),
          footer: "esc close",
          ...(view.filePath === null ? {} : { note: `file: ${view.filePath}` }),
        },
        theme,
        keybindings,
        done,
      ),
    );
    return true;
  } catch {
    return false;
  }
}

export async function explainCommandPolicy(
  runtime: CodepunkRuntime,
  command: string,
): Promise<string> {
  const decision = decidePolicy({
    tool: "bash",
    command,
    cwd: runtime.paths.cwd,
    workspaceRoot: runtime.paths.deliveryRoot,
    additionalRoots: runtime.paths.additionalRoots,
    deliveryRoot: runtime.paths.deliveryRoot,
    codepunkHome: runtime.paths.home,
    autonomy: runtime.autonomy.profile,
    filesystem: runtime.permissionSnapshot.filesystem,
    writeSet: [
      ...new Set([
        ...(runtime.policy.writeSet.length > 0
          ? runtime.policy.writeSet
          : [runtime.paths.cwd]),
        ...runtime.paths.additionalRoots,
      ]),
    ],
    userRules: runtime.policy.userRules,
    projectRules: runtime.policy.projectRules,
    layers: runtime.policy.layers,
  });
  return formatPermissionExplanation(
    await explainPermission({
      policy: decision,
      autonomy: runtime.autonomy,
      approvalMode: runtime.config.approval.mode,
      tool: "bash",
      command,
      cwd: runtime.paths.cwd,
      networkAllow: runtime.permissionSnapshot.networkAllow,
      networkDeny: runtime.permissionSnapshot.networkDeny,
      execution:
        runtime.sandbox === null
          ? {
              status: "blocked",
              reason: "shell is disabled for this session",
            }
          : { status: "available", reason: null },
    }),
  );
}

export async function configurePermissions(
  state: TuiState,
  context: ExtensionContext,
  argument: string,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  if (argument.length === 0) {
    await showPermissionsMenu(state, context);
    return;
  }
  const trimmed = argument.trim();
  if (trimmed === "status") {
    if (!(await showPermissionPanel(runtime, context))) {
      context.ui.notify(permissionSummary(runtime), "info");
    }
    return;
  }
  if (trimmed === "rules") {
    if (!(await showScopedRulesTable(runtime, context))) {
      context.ui.notify(await scopedRulesSummary(runtime), "info");
    }
    return;
  }
  if (trimmed === "why" || trimmed.startsWith("why ")) {
    const command = parsePermissionWhyCommand(trimmed);
    if (command === null) {
      context.ui.notify(permissionUsage(), "warning");
      return;
    }
    context.ui.notify(await explainCommandPolicy(runtime, command), "info");
    return;
  }
  const [group, value, ...rest] = trimmed.split(/\s+/u);
  if (group !== undefined && value === undefined && rest.length === 0) {
    const picker = permissionPicker(runtime, group);
    if (picker !== null) {
      const labels = picker.values.map(
        (candidate) =>
          `${candidate === picker.current ? "\u2713" : " "} ${candidate}`,
      );
      const selected = await context.ui.select(`Permission ${group}`, labels);
      if (selected === undefined) {
        return;
      }
      const chosen = picker.values[labels.indexOf(selected)];
      if (chosen !== undefined) {
        await configurePermissions(state, context, `${group} ${chosen}`);
      }
      return;
    }
  }
  if (group === "sandbox" && value === "network") {
    await handleSandboxNetwork(runtime, context, rest);
    return;
  }
  if (group === "reviewer") {
    await handleReviewer(runtime, context, value, rest);
    return;
  }
  if (group === undefined || value === undefined || rest.length > 0) {
    context.ui.notify(permissionUsage(), "warning");
    return;
  }
  if (group === "profile") {
    await configurePermissionProfile(runtime, context, value);
  } else if (group === "approval") {
    await configureApprovalMode(runtime, context, value);
  } else if (group === "autonomy") {
    await configureAutonomyProfile(runtime, context, value);
  } else if (group === "sandbox") {
    await configureSandboxMode(runtime, context, value);
  } else if (group === "filesystem") {
    await configureFilesystemMode(runtime, context, value);
  } else {
    context.ui.notify(permissionUsage(), "warning");
    return;
  }
  if (state.context !== null) {
    setupChrome(state, state.context);
  }
}

const PERMISSION_GROUPS = [
  "approval",
  "autonomy",
  "profile",
  "sandbox",
  "filesystem",
] as const;

function permissionMenuRows(runtime: CodepunkRuntime): {
  readonly labels: string[];
  readonly groups: readonly string[];
} {
  const labels = PERMISSION_GROUPS.map((group) => {
    const picker = permissionPicker(runtime, group);
    return `${group.padEnd(12)} ${picker?.current ?? ""}`.trimEnd();
  });
  return {
    labels: [...labels, "Scoped rules", "Close"],
    groups: [...PERMISSION_GROUPS],
  };
}

async function pickPermissionGroup(
  state: TuiState,
  context: ExtensionContext,
  group: string,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    return;
  }
  if (group === "rules") {
    if (!(await showScopedRulesTable(runtime, context))) {
      context.ui.notify(await scopedRulesSummary(runtime), "info");
    }
    return;
  }
  const picker = permissionPicker(runtime, group);
  if (picker === null) {
    return;
  }
  const labels = picker.values.map(
    (candidate) =>
      `${candidate === picker.current ? "\u2713" : " "} ${candidate}`,
  );
  const selected = await context.ui.select(`Permission ${group}`, labels);
  if (selected === undefined) {
    return;
  }
  const chosen = picker.values[labels.indexOf(selected)];
  if (chosen !== undefined) {
    await configurePermissions(state, context, `${group} ${chosen}`);
  }
}

/**
 * The bare `/permissions` entry. It is a real selector rather than a status
 * dump so a TUI user can change a mode without remembering the subcommand
 * grammar.
 */
export async function showPermissionsMenu(
  state: TuiState,
  context: ExtensionContext,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  for (;;) {
    const { labels, groups } = permissionMenuRows(runtime);
    const selected = await context.ui.select("codepunk permissions", labels);
    if (selected === undefined || selected === "Close") {
      return;
    }
    if (selected === "Scoped rules") {
      await pickPermissionGroup(state, context, "rules");
      continue;
    }
    const index = labels.indexOf(selected);
    const group = groups[index];
    if (group === undefined) {
      return;
    }
    await pickPermissionGroup(state, context, group);
  }
}

/**
 * `/settings` opens the same selector surface; config paths and the status
 * panel stay available as explicit entries instead of being the only answer.
 */
export async function showSettingsMenu(
  state: TuiState,
  context: ExtensionContext,
  argument: string,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  const trimmed = argument.trim();
  if (trimmed === "permissions" || trimmed === "permission") {
    await showPermissionsMenu(state, context);
    return;
  }
  for (;;) {
    const selected = await context.ui.select("codepunk settings", [
      "Permissions",
      "Config paths",
      "Close",
    ]);
    if (selected === undefined || selected === "Close") {
      return;
    }
    if (selected === "Permissions") {
      await showPermissionsMenu(state, context);
      continue;
    }
    context.ui.notify(
      [
        "codepunk settings are file-backed.",
        `config: ${runtime.paths.home}/config.toml`,
        "Use /permissions to change approval, autonomy, sandbox, and filesystem modes.",
        "Use /model for the model and /thinking for the reasoning level.",
      ].join("\n"),
      "info",
    );
  }
}
