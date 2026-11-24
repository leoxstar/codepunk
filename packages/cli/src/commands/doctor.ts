import { formatDoctor, runDoctor } from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { appendBuildDoctorCheck, inspectCliBuild } from "../build-info.ts";
import { resolveProject } from "../run/project.ts";

export async function commandDoctor(options: CliOptions): Promise<number> {
  const { paths, config, workspaceTrust } = await resolveProject(options);
  const build = await inspectCliBuild();
  const report = appendBuildDoctorCheck(
    await runDoctor({
      paths,
      config,
      projectTrusted: workspaceTrust.grants.skills,
      pluginEnabled: options.allowPlugins,
      packageVersion: build.version,
    }),
    build,
  );
  process.stdout.write(
    options.json ? `${JSON.stringify(report)}\n` : `${formatDoctor(report)}\n`,
  );
  return report.ok ? 0 : 1;
}
