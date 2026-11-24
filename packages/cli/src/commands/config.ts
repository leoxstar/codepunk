import {
  configFilePaths,
  configSummary,
  findDeliveryRoot,
  formatWorkspaceTrust,
  loadConfig,
  loadPolicyFiles,
  projectPaths,
  resolveWorkspaceTrust,
  type WorkspaceTrust,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { workspaceTrustOverride } from "../run/trust-prompt.ts";

function configLayerSuffix(loaded: boolean): string {
  return loaded ? "" : " (not loaded)";
}

export async function commandConfig(options: CliOptions): Promise<number> {
  const subject = options.positionals[1] ?? "show";
  if (subject !== "show" && subject !== "path") {
    throw new Error(
      `unknown config command ${subject}; use config [show] or config path`,
    );
  }
  const project = await findDeliveryRoot(process.cwd());
  const paths = projectPaths(project);
  const files = configFilePaths(paths);
  const configPaths = {
    home: paths.home,
    user: files.user,
    project: files.project,
    local: files.local,
    project_dir: paths.projectConfigDir,
  };
  if (subject === "path") {
    const payload = {
      cwd: project.cwd,
      root: project.deliveryRoot,
      project_id: paths.projectId,
      ...configPaths,
    };
    process.stdout.write(
      options.json
        ? `${JSON.stringify(payload, null, 2)}\n`
        : `${[
            `cwd: ${payload.cwd}`,
            `checkout root: ${payload.root}`,
            `project id: ${payload.project_id}`,
            `home: ${payload.home}`,
            `user config: ${payload.user}`,
            `project config: ${payload.project}`,
            `local config: ${payload.local}`,
            `project config dir: ${payload.project_dir}`,
          ].join("\n")}\n`,
    );
    return 0;
  }

  let trust: WorkspaceTrust | null = null;
  let trustError: string | null = null;
  try {
    trust = await resolveWorkspaceTrust({
      cwd: project.cwd,
      root: project.deliveryRoot,
      home: paths.home,
      includeSkills: !options.noSkills,
      includeInstructions: !options.bare,
      ...workspaceTrustOverride(options),
    });
  } catch (error) {
    trustError = error instanceof Error ? error.message : String(error);
  }
  const loaded = await loadConfig(
    paths,
    process.env,
    {},
    { projectTrusted: trust?.grants.config === true },
  );
  let writeSet: string[] | null = null;
  const warnings = [...loaded.warnings];
  if (trust?.grants.policy === true) {
    const policy = await loadPolicyFiles(paths, { projectTrusted: true });
    writeSet = policy.writeSet;
    warnings.push(...policy.warnings);
  }
  if (trustError !== null) {
    warnings.unshift(trustError);
  }
  const summary = configSummary(
    loaded.config,
    writeSet ?? ["(policy not loaded)"],
  );
  const trustPayload =
    trust === null
      ? { error: trustError }
      : {
          mode: trust.mode,
          source: trust.source,
          trusted: trust.trusted,
          grants: trust.grants,
          available: trust.available,
          resources: trust.resources,
          cwd: trust.cwd,
          root: trust.root,
          store: trust.storePath,
          resource_store: trust.resourceStorePath,
          saved_path: trust.savedPath,
        };
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          cwd: project.cwd,
          root: project.deliveryRoot,
          project_id: paths.projectId,
          paths: configPaths,
          trust: trustPayload,
          config: loaded.config,
          write_set: writeSet,
          summary,
          warnings,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const lines = [
    "codepunk configuration",
    `cwd: ${project.cwd}`,
    `checkout root: ${project.deliveryRoot}`,
    `project id: ${paths.projectId}`,
    `home: ${configPaths.home}`,
    `user config: ${configPaths.user}`,
    `project config: ${configPaths.project}${configLayerSuffix(
      trust?.grants.config === true,
    )}`,
    `local config: ${configPaths.local}${configLayerSuffix(
      trust?.grants.config === true,
    )}`,
    "",
    "Trust",
  ];
  if (trust !== null) {
    lines.push(...formatWorkspaceTrust(trust).split("\n"));
    if (trust.source === "default" && trust.resources.length > 0) {
      lines.push(`next: codepunk trust grant ${trust.root}`);
    }
  } else {
    lines.push(`trust: unreadable (${trustError ?? "unknown error"})`);
    lines.push("project layers were skipped");
  }
  lines.push("", "Effective configuration", ...summary);
  if (warnings.length > 0) {
    lines.push("", "Warnings", ...warnings.map((warning) => `- ${warning}`));
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
