import {
  findDeliveryRoot,
  installSkill,
  loadSkills,
  projectPaths,
  removeSkill,
  resolveWorkspaceTrust,
  type SkillBundle,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { workspaceTrustOverride } from "../run/trust-prompt.ts";

function formatSkillInventory(bundle: SkillBundle): string {
  const lines = [`Skills (${bundle.skills.length})`];
  if (bundle.skills.length === 0) {
    lines.push("  none");
  } else {
    for (const skill of bundle.skills) {
      lines.push(
        `  ${skill.scope.padEnd(7)} ${skill.name}  ${skill.bytes} B  ${skill.sha256.slice(0, 19)}`,
      );
      if (skill.description !== null && skill.description.length > 0) {
        lines.push(`          ${skill.description}`);
      }
      lines.push(`          ${skill.path}`);
    }
  }
  for (const warning of bundle.warnings) {
    lines.push(`  warning: ${warning}`);
  }
  lines.push(
    "",
    "add:    codepunk skills add <dir> [--scope user|project]",
    "remove: codepunk skills remove <name> [--scope user|project]",
    "skill changes take effect on the next Codepunk process",
  );
  return lines.join("\n");
}

export async function commandSkills(options: CliOptions): Promise<number> {
  const project = await findDeliveryRoot(process.cwd());
  const paths = projectPaths(project);
  const action = options.positionals[1] ?? "list";
  if (action === "list") {
    const workspaceTrust = await resolveWorkspaceTrust({
      cwd: project.cwd,
      root: project.deliveryRoot,
      home: paths.home,
      ...workspaceTrustOverride(options),
    });
    const bundle = await loadSkills({
      deliveryRoot: paths.deliveryRoot,
      codepunkHome: paths.home,
      projectTrusted: workspaceTrust.grants.skills,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(
            { skills: bundle.skills, warnings: bundle.warnings },
            null,
            2,
          )}\n`
        : `${formatSkillInventory(bundle)}\n`,
    );
    return 0;
  }
  const scope = options.scope ?? "user";
  if (action === "add") {
    const source = options.positionals[2];
    if (source === undefined) {
      throw new Error(
        "usage: codepunk skills add <dir> [--scope user|project] [--force]",
      );
    }
    const result = await installSkill({
      paths,
      source,
      scope,
      force: options.force,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `installed skill ${result.skill.name} (${scope})`,
          `path: ${result.target}`,
          "applies to the next Codepunk process",
        ].join("\n") + "\n",
      );
    }
    return 0;
  }
  if (action === "remove") {
    const name = options.positionals[2];
    if (name === undefined) {
      throw new Error(
        "usage: codepunk skills remove <name> [--scope user|project]",
      );
    }
    const target = await removeSkill({ paths, name, scope });
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ scope, name, target }, null, 2)}\n`
        : `removed skill ${name} (${scope})\npath: ${target}\n`,
    );
    return 0;
  }
  throw new Error(`unknown skills command: ${action}`);
}
