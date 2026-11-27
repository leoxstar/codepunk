import {
  analyzePermissionInsights,
  formatPermissionInsights,
  loadScopedRules,
  persistScopedRule,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { resolveProject } from "../run/project.ts";

export async function permissionsRules(options: CliOptions): Promise<number> {
  const { paths, config } = await resolveProject(options);
  if (options.positionals[2] === "add") {
    const argv = options.positionals.slice(3);
    if (argv.length === 0) {
      throw new Error(
        "permissions rules add requires argv tokens (e.g. codepunk permissions rules add -- pnpm --filter '*' test)",
      );
    }
    const persisted = await persistScopedRule({
      paths,
      argv,
      cwd: paths.cwd,
      filePath: options.scopedRules ?? config.autonomy.scoped_rules,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(persisted)}\n`);
      return 0;
    }
    process.stdout.write(
      `${persisted.created ? "added" : "kept"} scoped rule ${persisted.rule.id}: ${persisted.rule.argv.join(" ")} (file: ${persisted.path})\n`,
    );
    return 0;
  }
  const targetFile = options.scopedRules ?? config.autonomy.scoped_rules;
  if (targetFile === null) {
    if (options.json) {
      process.stdout.write("[]\n");
      return 0;
    }
    process.stdout.write(
      'scoped rules: none; choose "Always allow exact" in an approval, run "codepunk permissions rules add -- <argv...>", or pass --scoped-rules <path>\n',
    );
    return 0;
  }
  const loaded = await loadScopedRules(targetFile, paths);
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
