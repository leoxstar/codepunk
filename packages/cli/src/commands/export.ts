import { promises as fs } from "node:fs";
import path from "node:path";
import { exportSession, resolveSession } from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { resolveProject } from "../run/project.ts";

export async function commandExport(options: CliOptions): Promise<number> {
  const { paths } = await resolveProject(options);
  const requested = options.positionals[1];
  const store = await resolveSession({
    rootDir: paths.home,
    cwd: paths.cwd,
    projectRoot: paths.deliveryRoot,
    projectId: paths.projectId,
    ...(requested !== undefined ? { sessionId: requested } : {}),
  });
  const exported = await exportSession(store);
  if (options.output !== undefined) {
    const target = path.resolve(options.output);
    const manifestTarget = `${target}.manifest.json`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, exported.transcript, { mode: 0o600 });
    await fs.writeFile(
      manifestTarget,
      `${JSON.stringify(exported.manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    process.stdout.write(`${target}\n${manifestTarget}\n`);
  } else {
    process.stdout.write(exported.transcript);
  }
  return 0;
}
