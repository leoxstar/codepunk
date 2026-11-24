import { DaemonClient, DaemonServer } from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { resolveDaemonProject } from "../run/project.ts";

export async function commandDaemon(options: CliOptions): Promise<number> {
  if (process.platform === "win32") {
    throw new Error(
      "codepunk daemon is not supported on Windows: the daemon requires a Unix socket and Windows named pipes are not implemented",
    );
  }
  const paths = await resolveDaemonProject();
  const server = await DaemonServer.start({
    paths,
    ...(options.socket !== undefined ? { socketPath: options.socket } : {}),
    ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
  });
  try {
    const client = new DaemonClient({ socketPath: server.socketPath });
    const hello = await client.hello();
    const stop = () => {
      void server.close().catch(() => {});
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          socket: server.socketPath,
          project_id: server.projectId,
          ...hello,
        })}\n`,
      );
    } else {
      process.stdout.write(
        `codepunk daemon ${server.socketPath}\nprotocol v1: ${hello.methods.join(", ")}; Ctrl-C to stop\n`,
      );
    }
    try {
      await server.wait();
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return 0;
  } finally {
    await server.close();
  }
}
