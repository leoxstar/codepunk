import { promises as fs } from "node:fs";
import path from "node:path";
import {
  archiveSession,
  createSessionBundle,
  deleteSession,
  formatSessionGraph,
  formatSessionList,
  formatSessionSearch,
  formatSessionTree,
  importSession,
  listProjectSessions,
  planRetention,
  readSessionGraph,
  readSessionTree,
  renameSession,
  resolveSession,
  searchAllProjectSessions,
  searchProjectSessions,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { resolveProject } from "../run/project.ts";

export async function commandSessions(options: CliOptions): Promise<number> {
  const { paths, config } = await resolveProject(options);
  if (options.positionals.includes("prune")) {
    return sessionsPrune(options, paths, config);
  }
  const subcommand = options.positionals[1];
  if (options.allProjects && subcommand !== "search") {
    throw new Error("--all-projects only applies to sessions search");
  }
  if (
    subcommand === "rename" ||
    subcommand === "archive" ||
    subcommand === "unarchive" ||
    subcommand === "delete" ||
    subcommand === "export" ||
    subcommand === "import"
  ) {
    return sessionsMutate(options, paths, subcommand);
  }
  if (subcommand === "search") {
    return sessionsSearch(options, paths);
  }
  if (subcommand === "tree") {
    return sessionsTree(options, paths);
  }
  if (subcommand === "graph") {
    return sessionsGraph(options, paths);
  }
  return sessionsList(options, paths);
}

type ProjectPaths = Awaited<ReturnType<typeof resolveProject>>["paths"];
type ProjectConfig = Awaited<ReturnType<typeof resolveProject>>["config"];

async function sessionsPrune(
  options: CliOptions,
  paths: ProjectPaths,
  config: ProjectConfig,
): Promise<number> {
  if (options.apply) {
    throw new Error(
      "sessions prune --apply is refused because it bypasses the backup boundary; use codepunk gc --apply for artifact cleanup",
    );
  }
  const plan = await planRetention(
    paths,
    {
      sessionDays: config.session.retention_days,
      sessionCount: config.session.retention_count,
      evidenceDays: config.evidence.retention_days,
      evidenceCount: config.evidence.retention_count,
      logDays: 14,
      leaseMs: config.session.lease_seconds * 1_000,
    },
    { dryRun: !options.apply },
  );
  process.stdout.write(
    options.json
      ? `${JSON.stringify(plan)}\n`
      : `${plan.dryRun ? "DRY RUN" : "APPLIED"}: ${plan.actions.length} action(s)\n`,
  );
  if (!options.json) {
    for (const action of plan.actions) {
      process.stdout.write(
        `${action.kind} ${action.id} ${action.blocked === null ? "" : `[blocked: ${action.blocked}]`}\n`,
      );
    }
  }
  return 0;
}

function sessionOptions(paths: ProjectPaths, sessionId: string) {
  return {
    rootDir: paths.home,
    cwd: paths.cwd,
    projectRoot: paths.deliveryRoot,
    projectId: paths.projectId,
    sessionId,
  };
}

async function sessionsMutate(
  options: CliOptions,
  paths: ProjectPaths,
  subcommand: string,
): Promise<number> {
  const requested = options.positionals[2];
  if (requested === undefined) {
    throw new Error(`sessions ${subcommand} requires a session id`);
  }
  if (subcommand === "rename") {
    const title = options.positionals.slice(3).join(" ").trim();
    if (title.length === 0) {
      throw new Error("sessions rename requires a title");
    }
    const renamed = await renameSession(
      sessionOptions(paths, requested),
      title,
    );
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ session_id: requested, title: renamed })}\n`
        : `renamed ${requested} -> ${renamed}\n`,
    );
    return 0;
  }
  if (subcommand === "archive" || subcommand === "unarchive") {
    await archiveSession(
      sessionOptions(paths, requested),
      subcommand === "archive",
    );
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ session_id: requested, archived: subcommand === "archive" })}\n`
        : `${subcommand === "archive" ? "archived" : "unarchived"} ${requested}\n`,
    );
    return 0;
  }
  if (subcommand === "delete") {
    if (!options.confirm) {
      throw new Error("sessions delete requires --confirm");
    }
    const deleted = await deleteSession({
      ...sessionOptions(paths, requested),
      confirmed: true,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(deleted)}\n`
        : `deleted ${deleted.session_id} (backup ${deleted.backup_id}, ${deleted.deleted_files} file(s))\n`,
    );
    return 0;
  }
  if (subcommand === "export") {
    const store = await resolveSession(sessionOptions(paths, requested));
    const bundle = await createSessionBundle(store);
    const target =
      options.output ??
      path.join(paths.artifactsDir, `${store.sessionId}.session.json`);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, `${JSON.stringify(bundle)}\n`, {
      mode: 0o600,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ session_id: store.sessionId, output: target, events: bundle.meta.log_seq })}\n`
        : `exported ${store.sessionId} -> ${target} (${bundle.meta.log_seq} event(s))\n`,
    );
    return 0;
  }
  const bundlePath = path.resolve(requested);
  const stat = await fs.lstat(bundlePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("session bundle must be a regular file");
  }
  if (stat.size > 64 * 1024 * 1024) {
    throw new Error("session bundle exceeds 64 MiB");
  }
  let bundle: unknown;
  try {
    bundle = JSON.parse(await fs.readFile(bundlePath, "utf8"));
  } catch {
    throw new Error("session bundle is not valid JSON");
  }
  const imported = await importSession({
    home: paths.home,
    projectId: paths.projectId,
    bundle: bundle as never,
  });
  process.stdout.write(
    options.json
      ? `${JSON.stringify(imported)}\n`
      : `imported ${imported.session_id} -> ${imported.path} (${imported.events} event(s))\n`,
  );
  return 0;
}

async function sessionsSearch(
  options: CliOptions,
  paths: ProjectPaths,
): Promise<number> {
  const query = options.positionals[2];
  if (query === undefined) {
    throw new Error("sessions search requires a query");
  }
  const result = options.allProjects
    ? await searchAllProjectSessions({
        rootDir: paths.home,
        query,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      })
    : await searchProjectSessions({
        rootDir: paths.home,
        projectId: paths.projectId,
        query,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
  process.stdout.write(
    options.json
      ? `${JSON.stringify(result)}\n`
      : `${formatSessionSearch(result)}\n`,
  );
  return 0;
}

async function sessionsTree(
  options: CliOptions,
  paths: ProjectPaths,
): Promise<number> {
  const requested = options.positionals[2];
  const store = await resolveSession({
    rootDir: paths.home,
    cwd: paths.cwd,
    projectRoot: paths.deliveryRoot,
    projectId: paths.projectId,
    ...(requested !== undefined ? { sessionId: requested } : {}),
  });
  const tree = await readSessionTree(store);
  if (tree === null) {
    throw new Error(
      `session ${store.sessionId} has no saved agent state; run a turn before inspecting its tree`,
    );
  }
  process.stdout.write(
    options.json ? `${JSON.stringify(tree)}\n` : `${formatSessionTree(tree)}\n`,
  );
  return 0;
}

async function sessionsGraph(
  options: CliOptions,
  paths: ProjectPaths,
): Promise<number> {
  const graph = await readSessionGraph(paths.home, paths.projectId);
  process.stdout.write(
    options.json
      ? `${JSON.stringify(graph)}\n`
      : `${formatSessionGraph(graph)}\n`,
  );
  return 0;
}

async function sessionsList(
  options: CliOptions,
  paths: ProjectPaths,
): Promise<number> {
  const sessions = await listProjectSessions(paths.home, paths.projectId, {
    includeArchived: options.includeArchived,
  });
  process.stdout.write(
    options.json
      ? `${JSON.stringify(sessions)}\n`
      : `${formatSessionList(sessions)}\n`,
  );
  return 0;
}
