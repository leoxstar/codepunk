import {
  DaemonClient,
  DaemonClientError,
  daemonSocketPath,
  pinSession,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { resolveProject } from "../run/project.ts";

export async function commandPin(options: CliOptions): Promise<number> {
  const { paths } = await resolveProject(options);
  const sessionId = options.positionals[1];
  if (sessionId === undefined) {
    throw new Error("pin requires a session id");
  }
  const pinned = !options.unpin;
  // Prefer the daemon so a running server stays the only writer for this
  // project; fall back to the direct store write when no daemon is listening,
  // which is the normal case for a one-shot CLI call.
  // Windows cannot host the Unix-socket daemon at all, so it always takes the
  // direct store path. Asking for the socket path there would throw before
  // the fallback could run.
  let client: DaemonClient | null = null;
  if (process.platform === "darwin" || process.platform === "linux") {
    client = new DaemonClient({
      socketPath: daemonSocketPath(paths, options.socket),
    });
  }
  let handled = false;
  if (client !== null) {
    try {
      await client.pinSession(sessionId, pinned);
      handled = true;
    } catch (error) {
      if (
        !(error instanceof DaemonClientError) ||
        error.code !== "daemon.unavailable"
      ) {
        throw error;
      }
    }
  }
  if (!handled) {
    await pinSession(
      {
        rootDir: paths.home,
        cwd: paths.cwd,
        projectRoot: paths.deliveryRoot,
        projectId: paths.projectId,
        sessionId,
      },
      pinned,
    );
  }
  process.stdout.write(
    `${options.unpin ? "unpinned" : "pinned"} ${sessionId}\n`,
  );
  return 0;
}
