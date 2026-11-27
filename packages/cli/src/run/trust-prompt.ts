import {
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
  type TrustChoice = "always" | "session" | "never" | "never-session";
  const discoveredSummary = previews
    .slice(0, 6)
    .map((preview) => preview.path)
    .join(", ");
  const promptContext = {
    contextLines: [
      `cwd: ${project.cwd}`,
      `checkout root: ${resolved.root}`,
      `saved decision: ${savedDecision}`,
      ...(discoveredSummary.length === 0
        ? []
        : [
            `resources: ${discoveredSummary}${
              previews.length > 6 ? ` (+${previews.length - 6} more)` : ""
            }`,
          ]),
      ...(excluded.length === 0
        ? []
        : [`excluded for this run: ${excluded.join(", ")}`]),
    ],
    ...(build.stale === true || build.rebuiltAfterStart
      ? { footerNote: formatBuildLabel(build) }
      : {}),
  };
  // Loaded on demand: only the interactive prompt needs the terminal picker,
  // and its module graph pulls in the TUI stack.
  const { selectTerminalChoice, TerminalSelectCancelledError } =
    await import("../terminal-select.ts");
  let decision: TrustChoice;
  try {
    decision = await selectTerminalChoice<TrustChoice>(
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
