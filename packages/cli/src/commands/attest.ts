import { promises as fs } from "node:fs";
import path from "node:path";
import { attestSession, formatSessionAttestationMarkdown } from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { resolveProject } from "../run/project.ts";

export async function commandAttest(options: CliOptions): Promise<number> {
  const { paths } = await resolveProject(options);
  const requested = options.positionals[1];
  const attestation = await attestSession({
    paths,
    ...(requested !== undefined ? { sessionId: requested } : {}),
  });
  const rendered = options.json
    ? `${JSON.stringify(attestation, null, 2)}\n`
    : formatSessionAttestationMarkdown(attestation);

  if (options.output !== undefined) {
    const target = path.resolve(options.output);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, rendered, { mode: 0o600 });
    process.stdout.write(`${target}\n`);
    return 0;
  }
  process.stdout.write(rendered);
  return 0;
}
