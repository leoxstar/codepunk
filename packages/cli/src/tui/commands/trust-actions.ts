import {
  WORKSPACE_TRUST_RESOURCE_KINDS,
  allWorkspaceTrustGrants,
  applyWorkspaceTrustGrantChanges,
  autonomyRulesHash,
  formatWorkspaceTrust,
  inspectSavedWorkspaceResourceTrust,
  loadScopedRules,
  previewWorkspaceTrustResources,
  readOnlyLiveSwitchIssue,
  readOnlyLiveWidenIssue,
  readSavedWorkspaceTrust,
  readSavedWorkspaceTrustGrants,
  saveWorkspaceTrustGrants,
  type CodepunkRuntime,
  type WorkspaceTrustResourceKind,
} from "codepunk-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TuiState } from "../state.ts";
async function openTrustPanelInteractive(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
  summaryLines: readonly string[],
): Promise<void> {
  const initialGrants = await readSavedWorkspaceTrustGrants(
    runtime.paths.home,
    runtime.workspaceTrust.root,
  ).catch(() => allWorkspaceTrustGrants(runtime.workspaceTrust.trusted));
  const [{ createTrustPanel }, { defaultViewportHeight }] = await Promise.all([
    import("../components/trust-panel.ts"),
    import("../components/frame.ts"),
  ]);
  const updated = await context.ui.custom<Record<
    WorkspaceTrustResourceKind,
    boolean
  > | null>((_tui, theme, keybindings, done) =>
    createTrustPanel(
      {
        summaryLines: summaryLines.join("\n").split("\n"),
        initialGrants,
        viewportHeight: defaultViewportHeight(),
      },
      theme,
      keybindings,
      done,
    ),
  );
  if (updated !== null && updated !== undefined) {
    const savedEntry = await saveWorkspaceTrustGrants(
      runtime.paths.home,
      runtime.workspaceTrust.root,
      updated,
      "cli",
    );
    const anyAllowed = WORKSPACE_TRUST_RESOURCE_KINDS.some(
      (kind) => updated[kind],
    );
    context.ui.notify(
      [
        `workspace trust saved as ${anyAllowed ? "trusted" : "untrusted"}`,
        `resources: ${WORKSPACE_TRUST_RESOURCE_KINDS.map((kind) => `${kind}=${updated[kind] ? "allowed" : "skipped"}`).join(", ")}`,
        `resource store: ${savedEntry.resourceStorePath}`,
        "the current session is unchanged; restart codepunk to load or skip project resources",
      ].join("\n"),
      anyAllowed ? "info" : "warning",
    );
  }
}

export async function configureTrust(
  state: TuiState,
  context: ExtensionContext,
  argument: string,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  const tokens = argument.split(/\s+/u).filter(Boolean);
  if (tokens.length > 2) {
    context.ui.notify(
      "usage: /trust [status|grant|revoke] [config,policy,skills,instructions]",
      "warning",
    );
    return;
  }
  const action = tokens[0] ?? "status";
  if (action === "grant" || action === "revoke") {
    const requested = tokens[1];
    let selected: WorkspaceTrustResourceKind[] = [];
    if (requested !== undefined) {
      selected = [
        ...new Set(
          requested
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
        ),
      ] as WorkspaceTrustResourceKind[];
      const unknown = selected.find(
        (kind) =>
          !(WORKSPACE_TRUST_RESOURCE_KINDS as readonly string[]).includes(kind),
      );
      if (unknown !== undefined || selected.length === 0) {
        context.ui.notify(
          `unknown trust resource kind: ${
            unknown ?? requested
          }; use ${WORKSPACE_TRUST_RESOURCE_KINDS.join(",")}`,
          "warning",
        );
        return;
      }
    }
    try {
      const grants =
        selected.length === 0
          ? allWorkspaceTrustGrants(action === "grant")
          : applyWorkspaceTrustGrantChanges(
              await readSavedWorkspaceTrustGrants(
                runtime.paths.home,
                runtime.workspaceTrust.root,
              ),
              selected,
              action === "grant",
            );
      const saved = await saveWorkspaceTrustGrants(
        runtime.paths.home,
        runtime.workspaceTrust.root,
        grants,
        "cli",
      );
      const anyAllowed = WORKSPACE_TRUST_RESOURCE_KINDS.some(
        (kind) => grants[kind],
      );
      context.ui.notify(
        [
          `workspace trust saved as ${anyAllowed ? "trusted" : "untrusted"}`,
          `root: ${runtime.workspaceTrust.root}`,
          `resources: ${WORKSPACE_TRUST_RESOURCE_KINDS.map(
            (kind) => `${kind}=${grants[kind] ? "allowed" : "skipped"}`,
          ).join(", ")}`,
          `store: ${saved.storePath}`,
          `resource store: ${saved.resourceStorePath}`,
          "the current session is unchanged; restart codepunk to load or skip project resources",
        ].join("\n"),
        anyAllowed ? "info" : "warning",
      );
    } catch (error) {
      context.ui.notify(
        `workspace trust was not saved: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
    }
    return;
  }
  if (action !== "status") {
    context.ui.notify(
      "usage: /trust [status|grant|revoke] [config,policy,skills,instructions]",
      "warning",
    );
    return;
  }
  let saved = "none";
  let savedResources = "none for this checkout";
  try {
    const entry = readSavedWorkspaceTrust(
      runtime.paths.home,
      runtime.workspaceTrust.root,
    );
    if (entry !== null) {
      saved = `${entry.decision ? "trusted" : "untrusted"} (${entry.path})`;
    }
    const resourceEntry = await inspectSavedWorkspaceResourceTrust(
      runtime.paths.home,
      runtime.workspaceTrust.root,
    );
    if (resourceEntry !== null) {
      savedResources = WORKSPACE_TRUST_RESOURCE_KINDS.map(
        (kind) =>
          `${kind}=${resourceEntry.entry.grants[kind] ? "allowed" : "skipped"}`,
      ).join(", ");
    }
  } catch (error) {
    saved = `unreadable: ${error instanceof Error ? error.message : String(error)}`;
    savedResources = saved;
  }
  const summaryLines = [
    formatWorkspaceTrust(
      runtime.workspaceTrust,
      await previewWorkspaceTrustResources(
        runtime.workspaceTrust.root,
        runtime.workspaceTrust.cwd,
        {
          includeSkills: !runtime.isolation.skills,
          includeInstructions: !runtime.isolation.context,
        },
      ),
      {
        excluded: [
          runtime.isolation.context ? "instruction files (--bare)" : null,
          runtime.isolation.skills
            ? "project skills (--no-skills or --bare)"
            : null,
        ].filter((entry): entry is string => entry !== null),
      },
    ),
    `saved decision: ${saved}`,
    `saved resources: ${savedResources}`,
    "Use /trust grant|revoke [kinds] to change future sessions.",
  ];
  if (tokens.length === 0 && typeof context.ui.custom === "function") {
    await openTrustPanelInteractive(runtime, context, summaryLines);
    return;
  }
  context.ui.notify(summaryLines.join("\n"), "info");
}

export async function setAutonomyProfile(
  runtime: CodepunkRuntime,
  profile: "read-only" | "ask" | "scoped",
): Promise<void> {
  if (profile === "read-only") {
    const issue = readOnlyLiveSwitchIssue({
      pluginsEnabled: runtime.plugins.enabled,
      mcpServers: runtime.mcpServers,
      sandboxStartedWritable:
        runtime.sandbox?.sandboxed === true &&
        !runtime.permissionSnapshot.readOnly,
    });
    if (issue !== null) {
      throw new Error(issue);
    }
  } else {
    const issue = readOnlyLiveWidenIssue({
      target: profile,
      sandboxStartedReadOnly:
        runtime.sandbox?.sandboxed === true &&
        runtime.permissionSnapshot.readOnly,
    });
    if (issue !== null) {
      throw new Error(issue);
    }
  }
  if (profile !== "scoped") {
    runtime.autonomy.setProfile(profile);
    return;
  }
  const filePath = runtime.config.autonomy.scoped_rules;
  if (filePath !== null && filePath.length > 0) {
    const loaded = await loadScopedRules(filePath, runtime.paths);
    runtime.autonomy.replaceRules(
      loaded.rules,
      autonomyRulesHash(loaded.rules),
    );
  }
  runtime.autonomy.setProfile("scoped");
}
