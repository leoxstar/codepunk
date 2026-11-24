import path from "node:path";
import {
  appendRetentionOperation,
  applyGc,
  applyMigration,
  checkMigration,
  createBackup,
  listBackups,
  resolveCodepunkHome,
  restoreBackup,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { resolveProject } from "../run/project.ts";

function formatByteCount(bytes: number): string {
  return `${bytes} byte${bytes === 1 ? "" : "s"}`;
}

export async function commandGc(options: CliOptions): Promise<number> {
  const { paths, config } = await resolveProject(options);
  if (options.apply && (options.dryRun || options.check)) {
    throw new Error("gc accepts --dry-run or --apply, not both");
  }
  const result = await applyGc(paths.home, {
    dryRun: !options.apply,
    olderThanMs: config.evidence.retention_days * 86_400_000,
    now: new Date(),
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.skipped.length === 0 ? 0 : 1;
  }
  const lines = [
    `${result.dry_run ? "GC DRY RUN" : "GC APPLIED"}: ${result.candidates.length} candidate(s)`,
  ];
  for (const candidate of result.candidates) {
    lines.push(
      `  ${candidate.path}  ${formatByteCount(candidate.bytes)}  ${candidate.reason}`,
    );
  }
  if (!result.dry_run) {
    lines.push(
      `backup: ${result.backup_id ?? "(none; nothing to delete)"}`,
      `deleted: ${result.deleted.length}`,
    );
  }
  for (const skipped of result.skipped) {
    lines.push(`skipped: ${skipped.path}  ${skipped.reason}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return result.skipped.length === 0 ? 0 : 1;
}

export async function commandMigrate(options: CliOptions): Promise<number> {
  const home = resolveCodepunkHome(process.env);
  if (options.apply && options.check) {
    throw new Error("migrate accepts --check or --apply, not both");
  }
  if (options.apply) {
    const result = await applyMigration(home);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(
        [
          `migrate: ${result.status.current} -> ${result.status.target}`,
          `backup: ${result.backup_id ?? "(none; already current)"}`,
        ].join("\n") + "\n",
      );
    }
    return 0;
  }
  const status = await checkMigration(home);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
  } else {
    process.stdout.write(
      [
        `current: ${status.current}`,
        `target: ${status.target}`,
        `migration required: ${status.required ? "yes" : "no"}`,
      ].join("\n") + "\n",
    );
  }
  return status.required ? 1 : 0;
}

export async function commandBackup(options: CliOptions): Promise<number> {
  const { paths } = await resolveProject(options);
  const action = options.positionals[1] ?? "list";
  if (action === "create") {
    const manifest = await createBackup(paths.home, {
      roots: ["projects"],
      include: ["config.toml", "state-version.json"],
      waitForWritersMs: 5_000,
    });
    await appendRetentionOperation(paths.home, {
      at: manifest.created_at,
      action: "backup.create",
      mode: "apply",
      paths: manifest.files.map((file) => ({
        path: file.path,
        before_sha256: null,
        after_sha256: file.sha256,
        bytes: file.bytes,
      })),
      backup_id: manifest.id,
      exit_code: 0,
      failure: null,
    });
    const totalBytes = manifest.files.reduce(
      (sum, file) => sum + file.bytes,
      0,
    );
    if (options.json) {
      process.stdout.write(`${JSON.stringify(manifest)}\n`);
    } else {
      process.stdout.write(
        [
          `created backup ${manifest.id}`,
          `files: ${manifest.files.length}`,
          `bytes: ${totalBytes}`,
          `path: ${path.join(paths.home, "backups", manifest.id)}`,
        ].join("\n") + "\n",
      );
    }
    return 0;
  }
  if (action === "list") {
    const backups = await listBackups(paths.home);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(backups)}\n`);
    } else if (backups.length === 0) {
      process.stdout.write("No backups.\n");
    } else {
      process.stdout.write(
        backups
          .map(
            (backup) =>
              `${backup.id}  ${backup.created_at}  ${backup.files.length} file(s)`,
          )
          .join("\n") + "\n",
      );
    }
    return 0;
  }
  if (action === "restore") {
    const id = options.positionals[2];
    if (id === undefined) {
      throw new Error("backup restore requires a backup id");
    }
    const manifest = await restoreBackup(paths.home, id);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(manifest)}\n`);
    } else {
      process.stdout.write(
        `restored backup ${manifest.id} (${manifest.files.length} file(s))\n`,
      );
    }
    return 0;
  }
  throw new Error(`unknown backup command: ${action}`);
}
