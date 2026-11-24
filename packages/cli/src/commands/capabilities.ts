import {
  collectCapabilities,
  findDeliveryRoot,
  formatCapabilities,
  loadConfig,
  projectPaths,
  resolveWorkspaceTrust,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { workspaceTrustOverride } from "../run/trust-prompt.ts";

export async function commandCapabilities(
  options: CliOptions,
): Promise<number> {
  const project = await findDeliveryRoot(process.cwd());
  const paths = projectPaths(project);
  const workspaceTrust = await resolveWorkspaceTrust({
    cwd: project.cwd,
    root: project.deliveryRoot,
    home: paths.home,
    ...workspaceTrustOverride(options),
  });
  const { config } = await loadConfig(
    paths,
    process.env,
    {},
    {
      projectTrusted: workspaceTrust.grants.config,
    },
  );
  const snapshot = await collectCapabilities(paths, {
    pluginEnabled: options.allowPlugins || config.plugins.enabled,
    projectTrusted: workspaceTrust.grants.skills,
  });
  process.stdout.write(
    options.json
      ? `${JSON.stringify(snapshot, null, 2)}\n`
      : `${formatCapabilities(snapshot)}\n`,
  );
  return snapshot.mcp.error === null ? 0 : 1;
}
