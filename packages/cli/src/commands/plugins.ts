import path from "node:path";
import {
  installUserPlugin,
  listUserPluginFiles,
  removeUserPlugin,
  writeUserPluginsEnabled,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { resolveProject } from "../run/project.ts";

export async function commandPlugins(options: CliOptions): Promise<number> {
  const { paths, config } = await resolveProject(options);
  const extensionDir = path.join(paths.home, "extensions");
  const action = options.positionals[1] ?? "list";
  if (action === "list") {
    const files = await listUserPluginFiles(extensionDir);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            enabled: config.plugins.enabled,
            directory: extensionDir,
            files,
            applies: "next-process",
          },
          null,
          2,
        )}\n`,
      );
    } else {
      const lines = [
        `Plugins (${config.plugins.enabled ? "enabled" : "disabled"}, ${files.length} file${
          files.length === 1 ? "" : "s"
        })`,
        `directory: ${extensionDir}`,
        ...(files.length === 0 ? ["  none"] : files.map((file) => `  ${file}`)),
        "",
        "add:     codepunk plugins add <file|dir> [--force]",
        "remove:  codepunk plugins remove <file|id>",
        "enable:  codepunk plugins enable",
        "disable: codepunk plugins disable",
        "plugin state takes effect on the next Codepunk process",
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    return 0;
  }
  if (action === "enable" || action === "disable") {
    const enabled = action === "enable";
    const configPath = await writeUserPluginsEnabled(paths, enabled);
    process.stdout.write(
      options.json
        ? `${JSON.stringify(
            { enabled, config: configPath, applies: "next-process" },
            null,
            2,
          )}\n`
        : [
            `plugins ${enabled ? "enabled" : "disabled"}`,
            `config: ${configPath}`,
            "applies to the next Codepunk process; the current process is unchanged",
          ].join("\n") + "\n",
    );
    return 0;
  }
  if (action === "add") {
    const source = options.positionals[2];
    if (source === undefined) {
      throw new Error("usage: codepunk plugins add <file|dir> [--force]");
    }
    const target = await installUserPlugin({
      extensionDir,
      source,
      force: options.force,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ target, applies: "next-process" }, null, 2)}\n`
        : [
            `installed plugin ${path.basename(target)}`,
            `path: ${target}`,
            "load with `codepunk plugins enable`, or `--allow-plugins` for one TUI run",
            "plugin effects are uncovered and plugin tools are rejected",
          ].join("\n") + "\n",
    );
    return 0;
  }
  if (action === "remove") {
    const name = options.positionals[2];
    if (name === undefined) {
      throw new Error("usage: codepunk plugins remove <file|id>");
    }
    const target = await removeUserPlugin({
      extensionDir,
      name: path.basename(name),
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ target }, null, 2)}\n`
        : `removed plugin ${path.basename(target)}\npath: ${target}\n`,
    );
    return 0;
  }
  throw new Error(`unknown plugins command: ${action}`);
}
