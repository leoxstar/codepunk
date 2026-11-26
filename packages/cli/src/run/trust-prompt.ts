import {
  WORKSPACE_TRUST_RESOURCE_KINDS,
  allWorkspaceTrustGrants,
  findDeliveryRoot,
  formatWorkspaceTrustResourcePreview,
  inspectSavedWorkspaceTrust,
  previewWorkspaceTrustResources,
  projectPaths,
  resolveWorkspaceTrust,
  saveWorkspaceTrustGrants,
  workspaceTrustGrantsFromKinds,
  workspaceTrustMode,
  type WorkspaceTrust,
  type WorkspaceTrustGrants,
  type WorkspaceTrustResourceKind,
  type WorkspaceTrustSource,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { formatBuildLabel, inspectCliBuild } from "../build-info.ts";

function trustWithGrants(
  trust: WorkspaceTrust,
  grants: WorkspaceTrustGrants,
  source: WorkspaceTrustSource,
  savedPath: string | null = trust.savedPath,
): WorkspaceTrust {
  return {
    ...trust,
    grants,
    mode: workspaceTrustMode(grants),
    trusted: trust.available.every((kind) => grants[kind]),
    source,
    savedPath,
  };
}

export function workspaceTrustOverride(options: CliOptions): {
  override?: boolean | WorkspaceTrustGrants;
  source?: WorkspaceTrustSource;
} {
  if (options.trust !== undefined) {
    return {
      override: options.trust === "trusted",
      source: "flag",
    };
  }
  if (options.trustResources !== undefined) {
    return {
      override: workspaceTrustGrantsFromKinds(options.trustResources),
      source: "flag",
    };
  }
  return {};
}

async function resolveRunWorkspaceTrust(
  options: CliOptions,
  project: Awaited<ReturnType<typeof findDeliveryRoot>>,
  interactive: boolean,
): Promise<WorkspaceTrust> {
  const paths = projectPaths(project);
  const resourceOptions = {
    includeSkills: !options.noSkills,
    includeInstructions: !options.bare,
  };
  if (options.trust !== undefined) {
    return resolveWorkspaceTrust({
      cwd: project.cwd,
      root: project.deliveryRoot,
      home: paths.home,
      override: options.trust === "trusted",
      source: "flag",
      ...resourceOptions,
    });
  }
  if (options.trustResources !== undefined) {
    return resolveWorkspaceTrust({
      cwd: project.cwd,
      root: project.deliveryRoot,
      home: paths.home,
      override: workspaceTrustGrantsFromKinds(options.trustResources),
      source: "flag",
      ...resourceOptions,
    });
  }
  const resolved = await resolveWorkspaceTrust({
    cwd: project.cwd,
    root: project.deliveryRoot,
    home: paths.home,
    ...resourceOptions,
  });
  if (resolved.source !== "default" || resolved.resources.length === 0) {
    return resolved;
  }
  if (!interactive) {
    // A one-shot process cannot prompt. Refusing here is the same posture as
    // Gemini CLI's headless trust failure: proceeding on defaults would run
    // without the project's own config while still reading its files. The
    // two flags are an explicit one-run choice, so they keep working.
    throw new Error(
      `workspace trust is unresolved for ${resolved.root} (project resources: ${resolved.resources.join(", ")}); print mode cannot prompt. Run codepunk trust grant ${resolved.root} for future sessions, or pass --trust / --no-trust for this run`,
    );
  }
  const previews = await previewWorkspaceTrustResources(
    project.deliveryRoot,
    project.cwd,
    resourceOptions,
  );
  const savedDecision = describeSavedTrust(paths, resolved);
  const excluded = [
    options.bare ? "project instructions and skills (--bare)" : null,
    options.noSkills ? "project skills (--no-skills)" : null,
  ].filter((entry): entry is string => entry !== null);
  process.stderr.write(
    [
      "",
      "Workspace trust",
      `  cwd: ${project.cwd}`,
      `  checkout root: ${resolved.root}`,
      "",
      "This workspace contains project resources that can change Codepunk's instructions or tools:",
      ...previews.map((preview) =>
        formatWorkspaceTrustResourcePreview(preview, {
          compactDigest: true,
        }),
      ),
      ...(excluded.length === 0
        ? []
        : [`excluded for this run: ${excluded.join(", ")}`]),
      "",
      "Trust only controls project config, policy, skills, and instruction files.",
      "It does not change approval, sandbox, or filesystem permissions.",
      "",
    ].join("\n"),
  );
  const build = await inspectCliBuild();
  if (build.stale === true) {
    process.stderr.write(
      `codepunk: warning: the running dist is older than the package sources; run pnpm build (entry: ${build.entryPath})\n`,
    );
  }
  return promptForWorkspaceTrust({
    options,
    project,
    paths,
    resolved,
    previews,
    excluded,
    savedDecision,
    build,
  });
}

function describeSavedTrust(
  paths: ReturnType<typeof projectPaths>,
  resolved: WorkspaceTrust,
): string {
  try {
    const saved = inspectSavedWorkspaceTrust(paths.home, resolved.root);
    if (saved === null) {
      return "none for this checkout or an ancestor";
    }
    const label = saved.entry.decision ? "trusted" : "untrusted";
    return saved.inherited
      ? `${label} for parent ${saved.entry.path}; this checkout needs its own decision`
      : `${label} for this checkout (${saved.entry.path})`;
  } catch (error) {
    return `unreadable: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

interface TrustPromptContext {
  options: CliOptions;
  project: Awaited<ReturnType<typeof findDeliveryRoot>>;
  paths: ReturnType<typeof projectPaths>;
  resolved: WorkspaceTrust;
  previews: Awaited<ReturnType<typeof previewWorkspaceTrustResources>>;
  excluded: string[];
  savedDecision: string;
  build: Awaited<ReturnType<typeof inspectCliBuild>>;
}

async function promptForWorkspaceTrust(
  context: TrustPromptContext,
): Promise<WorkspaceTrust> {
  const { project, paths, resolved, previews, excluded, savedDecision, build } =
    context;
  const kindCopy: Record<
    WorkspaceTrustResourceKind,
    { label: string; detail: string }
  > = {
    config: {
      label: "Project configuration",
      detail: "config.toml, local.toml, and project agent profiles",
    },
    policy: {
      label: "Project policy",
      detail: "policy.toml rules and write set",
    },
    skills: {
      label: "Project skills",
      detail: ".codepunk/skills",
    },
    instructions: {
      label: "Project instructions",
      detail: "AGENTS.md and CLAUDE.md files",
    },
  };
  const discoveredKinds = WORKSPACE_TRUST_RESOURCE_KINDS.filter((kind) =>
    previews.some((preview) => preview.kind === kind),
  );
  const customChoices = discoveredKinds.map((kind) => ({
    label: kindCopy[kind].label,
    value: kind,
    checked: true,
    description: `${kindCopy[kind].detail} — ${previews
      .filter((preview) => preview.kind === kind)
      .map((preview) => preview.path)
      .join(", ")}`,
  }));
  type TrustChoice =
    "always" | "session" | "custom" | "never" | "never-session";
  const promptContext = {
    contextLines: [
      `cwd: ${project.cwd}`,
      `checkout root: ${resolved.root}`,
      `saved decision: ${savedDecision}`,
      ...(excluded.length === 0
        ? []
        : [`excluded for this run: ${excluded.join(", ")}`]),
    ],
    ...(build.stale === true || build.rebuiltAfterStart
      ? { footerNote: formatBuildLabel(build) }
      : {}),
  };
  let decision: Exclude<TrustChoice, "custom"> | null = null;
  // Loaded on demand: only the interactive prompt needs the terminal picker,
  // and its module graph pulls in the TUI stack.
  const { selectTerminalChoice, TerminalSelectCancelledError } =
    await import("../terminal-select.ts");
  while (decision === null) {
    let choice: TrustChoice;
    try {
      choice = await selectTerminalChoice<TrustChoice>(
        "Project trust",
        [
          {
            label: "Trust this workspace and remember",
            value: "always",
            description: "Load all resources · remember",
          },
          {
            label: "Trust for this session only",
            value: "session",
            description: "Load all now · ask again next start",
          },
          ...(customChoices.length > 1
            ? [
                {
                  label: "Customize resources…",
                  value: "custom" as const,
                  description: "Pick which groups load",
                },
              ]
            : []),
          {
            label: "Do not trust and remember this decision",
            value: "never",
            description: "Skip all resources · remember",
          },
          {
            label: "Do not trust for this session only",
            value: "never-session",
            description: "Skip all now · ask again next start",
          },
        ],
        promptContext,
      );
    } catch (error) {
      if (error instanceof TerminalSelectCancelledError) {
        throw new Error(
          "workspace trust was not decided; choose an option or pass --trust / --no-trust",
        );
      }
      throw error;
    }
    if (choice !== "custom") {
      decision = choice;
      break;
    }
    const custom = await selectCustomTrust(
      paths,
      project,
      resolved,
      customChoices,
    );
    if (custom !== null) {
      return custom;
    }
  }
  if (decision === "session") {
    return trustWithGrants(resolved, allWorkspaceTrustGrants(true), "prompt");
  }
  if (decision === "never-session") {
    return trustWithGrants(resolved, allWorkspaceTrustGrants(false), "prompt");
  }
  const grants = allWorkspaceTrustGrants(decision === "always");
  const saved = await saveWorkspaceTrustGrants(
    paths.home,
    resolved.root,
    grants,
    "prompt",
  );
  return {
    ...trustWithGrants(resolved, grants, "prompt", resolved.root),
    storePath: saved.storePath,
    resourceStorePath: saved.resourceStorePath,
  };
}

async function selectCustomTrust(
  paths: ReturnType<typeof projectPaths>,
  project: Awaited<ReturnType<typeof findDeliveryRoot>>,
  resolved: WorkspaceTrust,
  customChoices: readonly {
    label: string;
    value: WorkspaceTrustResourceKind;
    checked: boolean;
    description: string;
  }[],
): Promise<WorkspaceTrust | null> {
  const {
    selectTerminalCheckboxes,
    selectTerminalChoice,
    TerminalSelectCancelledError,
  } = await import("../terminal-select.ts");
  const selectedKinds =
    await selectTerminalCheckboxes<WorkspaceTrustResourceKind>(
      "Load project resources",
      customChoices,
      {
        contextLines: [
          `cwd: ${project.cwd}`,
          `checkout root: ${resolved.root}`,
          "Space toggles one resource group; empty selection loads none.",
        ],
      },
    );
  if (selectedKinds === null) {
    return null;
  }
  let scope: "session" | "remember" | "back";
  try {
    scope = await selectTerminalChoice<"session" | "remember" | "back">(
      "Apply custom trust",
      [
        {
          label: "Apply to this session",
          value: "session",
          description: "Use now · ask again next start",
        },
        {
          label: "Apply and remember",
          value: "remember",
          description: "Use now and for future sessions",
        },
        {
          label: "Back",
          value: "back",
          description: "Return to the trust menu",
        },
      ],
      {
        contextLines: [
          `selected: ${
            selectedKinds.length === 0 ? "none" : selectedKinds.join(", ")
          }`,
        ],
      },
    );
  } catch (error) {
    if (error instanceof TerminalSelectCancelledError) {
      return null;
    }
    throw error;
  }
  if (scope === "back") {
    return null;
  }
  const grants = workspaceTrustGrantsFromKinds(selectedKinds);
  if (scope === "session") {
    return trustWithGrants(resolved, grants, "prompt");
  }
  const saved = await saveWorkspaceTrustGrants(
    paths.home,
    resolved.root,
    grants,
    "prompt",
  );
  return {
    ...trustWithGrants(resolved, grants, "prompt", resolved.root),
    storePath: saved.storePath,
    resourceStorePath: saved.resourceStorePath,
  };
}

export function trustRuntimeOptions(trust: WorkspaceTrust): {
  projectTrust: WorkspaceTrustGrants;
  projectTrustSource: WorkspaceTrustSource;
  projectTrustSavedPath: string | null;
} {
  return {
    projectTrust: trust.grants,
    projectTrustSource: trust.source,
    projectTrustSavedPath: trust.savedPath,
  };
}

export { resolveRunWorkspaceTrust };
