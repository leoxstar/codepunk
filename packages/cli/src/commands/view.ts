import { DaemonClient, daemonSocketPath } from "codepunk-core";
import type {
  DaemonSessionListResult,
  DaemonSessionReadResult,
} from "codepunk-protocol";
import type { CliOptions } from "../args/options.ts";
import { resolveDaemonProject } from "../run/project.ts";

function formatDaemonList(result: DaemonSessionListResult): string {
  if (result.sessions.length === 0) {
    return "No sessions.";
  }
  return result.sessions
    .map((session) => {
      const title =
        session.title === null || session.title.length === 0
          ? "(untitled)"
          : session.title;
      const pin = session.pinned ? " pinned" : "";
      return `${session.id}  ${session.updated_at}  seq=${session.last_seq}${pin}  ${title}\n  ${session.cwd}`;
    })
    .join("\n");
}

function formatDaemonSession(result: DaemonSessionReadResult): string {
  const lines = [
    `Session: ${result.header.id}`,
    `Project: ${result.header.project_id}`,
    `Created: ${result.header.created_at}`,
    `Updated: ${result.metadata.updated_at}`,
    `CWD: ${result.header.cwd}`,
    `Events: ${result.events.length} (through seq ${result.next_seq})`,
    "",
  ];
  for (const event of result.events) {
    const data = JSON.stringify(event.data);
    const preview = data.length > 500 ? `${data.slice(0, 497)}...` : data;
    lines.push(`#${event.seq} ${event.at} ${event.kind} ${preview}`);
  }
  return lines.join("\n");
}

export async function commandView(options: CliOptions): Promise<number> {
  if (process.platform === "win32") {
    throw new Error(
      "codepunk view is not supported on Windows: the daemon requires a Unix socket and Windows named pipes are not implemented",
    );
  }
  const paths = await resolveDaemonProject();
  const client = new DaemonClient({
    socketPath: daemonSocketPath(paths, options.socket),
  });
  const requested = options.positionals[1];
  if (requested === undefined) {
    const result = await client.listSessions();
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result)}\n`
        : `${formatDaemonList(result)}\n`,
    );
    return 0;
  }
  const result = await client.readAllSession(requested);
  process.stdout.write(
    options.json
      ? `${JSON.stringify(result)}\n`
      : `${formatDaemonSession(result)}\n`,
  );
  return 0;
}
