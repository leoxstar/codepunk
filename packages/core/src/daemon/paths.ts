import path from "node:path";
import { normalizeAbsolute } from "../platform/path.ts";
import type { ProjectPaths } from "../platform/paths.ts";

function unixSocketPathLimit(): number {
  if (process.platform === "darwin") {
    return 103;
  }
  if (process.platform === "linux") {
    return 107;
  }
  throw new Error(
    "the Codepunk daemon requires a Unix socket; Windows is not supported",
  );
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(normalizeAbsolute(root), candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function daemonSocketPath(
  paths: Pick<ProjectPaths, "home" | "projectId">,
  override?: string,
): string {
  const home = normalizeAbsolute(paths.home);
  const socketPath = normalizeAbsolute(
    override ?? path.join(home, "run", `${paths.projectId}.sock`),
  );
  if (!isInside(home, socketPath)) {
    throw new Error("daemon socket must stay under CODEPUNK_HOME");
  }
  const limit = unixSocketPathLimit();
  if (Buffer.byteLength(socketPath, "utf8") <= limit) {
    return socketPath;
  }
  if (override !== undefined) {
    throw new Error(
      `daemon socket path is too long for this platform: ${socketPath}`,
    );
  }
  const userId =
    typeof process.getuid === "function" ? String(process.getuid()) : "user";
  const fallback = path.join(
    "/tmp",
    `codepunk-${userId}`,
    `${paths.projectId}.sock`,
  );
  if (Buffer.byteLength(fallback, "utf8") > limit) {
    throw new Error(
      `daemon socket path is too long for this platform: ${fallback}`,
    );
  }
  return fallback;
}
