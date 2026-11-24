import { signStandalone } from "codepunk-core";
import type { CliOptions } from "../args/options.ts";

export async function commandSign(options: CliOptions): Promise<number> {
  const runId = options.positionals[1];
  if (runId === undefined || options.verdict === undefined) {
    throw new Error("sign requires <run-id> --verdict complete|incomplete");
  }
  if (process.stdin.isTTY !== true) {
    throw new Error("sign requires a top-level TTY");
  }
  const result = await signStandalone({
    cwd: process.cwd(),
    runId,
    verdict: options.verdict,
    ...(options.actor !== undefined ? { actor: options.actor } : {}),
    tty: true,
  });
  process.stdout.write(
    `${result.verdict.verdict} ${result.artifactPath}\n${result.issues.join("\n")}\n`,
  );
  return 0;
}
