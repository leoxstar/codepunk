import {
  analyzePermissionInsights,
  formatPermissionInsights,
  loadScopedRules,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { resolveProject } from "../run/project.ts";

export async function permissionsRules(options: CliOptions): Promise<number> {
  const { paths, config } = await resolveProject(options);
  if (config.autonomy.scoped_rules === null) {
    if (options.json) {
      process.stdout.write("[]\n");
      return 0;
    }
    process.stdout.write(
      'scoped rules: none; choose "Always allow exact" in an approval, or pass --scoped-rules <path>\n',
    );
    return 0;
  }
  const loaded = await loadScopedRules(config.autonomy.scoped_rules, paths);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(loaded.rules)}\n`);
    return 0;
  }
  process.stdout.write(
    [
      `scoped rules: ${loaded.rules.length}`,
      `file: ${loaded.path}`,
      ...loaded.rules.map(
        (rule) => `  ${rule.id}: ${rule.argv.join(" ")} (cwd ${rule.cwd})`,
      ),
    ].join("\n") + "\n",
  );
  return 0;
}

export async function permissionsInsights(
  options: CliOptions,
): Promise<number> {
  const { paths } = await resolveProject(options);
  const insights = await analyzePermissionInsights(paths);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(insights)}\n`);
    return 0;
  }
  process.stdout.write(`${formatPermissionInsights(insights)}\n`);
  return 0;
}
