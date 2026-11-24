import type { CliOptions } from "../args/options.ts";
import {
  COMPLETION_SHELLS,
  completionScript,
  isCompletionShell,
} from "../completion.ts";

export async function commandCompletion(options: CliOptions): Promise<number> {
  const shell = options.positionals[1];
  if (shell === undefined || !isCompletionShell(shell)) {
    throw new Error(
      `completion requires one shell: ${COMPLETION_SHELLS.join(", ")}`,
    );
  }
  process.stdout.write(completionScript(shell));
  return 0;
}
