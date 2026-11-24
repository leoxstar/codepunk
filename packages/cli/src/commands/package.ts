import {
  installPackage,
  uninstallPackage,
  upgradePackage,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { readCliVersion, UNPUBLISHED_VERSION } from "../build-info.ts";

export async function commandPackage(
  options: CliOptions,
  verb: "install" | "upgrade" | "uninstall",
): Promise<number> {
  const targetVersion = options.packageVersion ?? (await readCliVersion());
  if (verb === "install" && targetVersion === UNPUBLISHED_VERSION) {
    throw new Error(
      "0.0.0 is the unpublished placeholder version and codepunk-cli is not published at it; install from the repository checkout or pass --package-version <published-version>",
    );
  }
  const base = {
    prefix: options.prefix ?? null,
    cwd: process.cwd(),
    dryRun: options.dryRun,
  };
  const result =
    verb === "install"
      ? await installPackage({
          ...base,
          version: targetVersion,
        })
      : verb === "upgrade"
        ? await upgradePackage(base)
        : await uninstallPackage(base);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  const command = `${result.command.command} ${result.command.args.join(" ")}`;
  if (result.dryRun) {
    process.stdout.write(`${command}\n`);
    return 0;
  }
  if (verb === "install") {
    process.stdout.write(
      `installed ${result.packageName}@${result.version ?? "latest"}${result.prefix === null ? " globally" : ` at ${result.prefix}`}\n`,
    );
  } else if (verb === "upgrade") {
    process.stdout.write(
      `upgraded ${result.packageName} from ${result.previousVersion ?? "(not installed)"} to ${result.version ?? "latest"}\n`,
    );
  } else {
    process.stdout.write(`uninstalled ${result.packageName}\n`);
  }
  return 0;
}
