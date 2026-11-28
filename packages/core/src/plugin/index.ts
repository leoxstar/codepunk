import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteFile, ensurePrivateDir } from "../platform/fs.ts";
import { isInsidePath, normalizeAbsolute } from "../platform/path.ts";
import { PluginError } from "./error.ts";
import { loadPluginManifest, PLUGIN_ID_RE } from "./manifest.ts";

export { PluginError };

export interface PluginLoadOptions {
  allowed: boolean;
  extensionDir: string;
}

export interface PluginSummary {
  enabled: boolean;
  dir: string;
  paths: string[];
  errors: string[];
  warnings: string[];
}

export interface PluginLoadResult {
  paths: string[];
  summary: PluginSummary;
}

export interface PluginInstallOptions {
  extensionDir: string;
  source: string;
  force?: boolean;
}

export const MAX_PLUGIN_BYTES = 1024 * 1024;
const MAX_PLUGIN_FILES = 64;
const PLUGIN_FILE = /^[A-Za-z0-9._-]+\.(?:mjs|cjs|js|ts)$/u;

async function listExtensionFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new PluginError(
      `cannot read plugin directory: ${(error as Error).message}`,
    );
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && /\.(?:mjs|cjs|js|ts)$/u.test(entry.name)) {
      files.push(normalizeAbsolute(path.join(dir, entry.name)));
      continue;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const manifestPath = path.join(dir, entry.name, "plugin.toml");
      try {
        const stat = await fs.lstat(manifestPath);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          files.push(normalizeAbsolute(manifestPath));
        }
      } catch {
        // Unmanifested directory is surfaced as an isolation error on load.
      }
    }
  }
  return files.sort();
}

export async function listUserPluginFiles(
  extensionDir: string,
): Promise<string[]> {
  return listExtensionFiles(normalizeAbsolute(extensionDir));
}

async function ensureExtensionDir(extensionDirInput: string): Promise<string> {
  const extensionDir = normalizeAbsolute(extensionDirInput);
  let rootStat;
  try {
    rootStat = await fs.lstat(extensionDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new PluginError(
        `plugin extension directory cannot be inspected: ${(error as Error).message}`,
        "plugin.root",
      );
    }
    await ensurePrivateDir(extensionDir);
    rootStat = await fs.lstat(extensionDir);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new PluginError(
      "plugin extension directory must be a real directory",
      "plugin.root",
    );
  }
  return extensionDir;
}

interface CollectedPluginDirectory {
  dirs: string[];
  files: Array<{ rel: string; content: Buffer }>;
}

async function collectPluginDirectoryEntries(
  rootDir: string,
): Promise<CollectedPluginDirectory> {
  const dirs: string[] = [];
  const files: Array<{ rel: string; content: Buffer }> = [];
  let totalBytes = 0;

  async function walk(currentDir: string, relPrefix: string): Promise<void> {
    const entries = (
      await fs.readdir(currentDir, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath =
        relPrefix.length === 0 ? entry.name : path.join(relPrefix, entry.name);
      const entryStat = await fs.lstat(fullPath);
      if (entryStat.isSymbolicLink()) {
        throw new PluginError(
          `plugin directory must not contain symbolic links (${relPath})`,
          "plugin.source_symlink",
        );
      }
      const realEntry = normalizeAbsolute(await fs.realpath(fullPath));
      if (!isInsidePath(rootDir, realEntry)) {
        throw new PluginError(
          `plugin directory entry escapes root (${relPath})`,
          "plugin.source_escape",
        );
      }
      if (entryStat.isDirectory()) {
        dirs.push(relPath);
        await walk(fullPath, relPath);
        continue;
      }
      if (!entryStat.isFile()) {
        throw new PluginError(
          `plugin directory entry must be a regular file or directory (${relPath})`,
          "plugin.source_type",
        );
      }
      if (files.length >= MAX_PLUGIN_FILES) {
        throw new PluginError(
          `plugin directory exceeds ${MAX_PLUGIN_FILES} files`,
          "plugin.too_many_files",
        );
      }
      totalBytes += entryStat.size;
      if (totalBytes > MAX_PLUGIN_BYTES) {
        throw new PluginError(
          `plugin source exceeds ${MAX_PLUGIN_BYTES} bytes`,
          "plugin.too_large",
        );
      }
      const content = await fs.readFile(fullPath);
      if (content.includes(0)) {
        throw new PluginError(
          `plugin source contains NUL bytes (${relPath})`,
          "plugin.binary_content",
        );
      }
      files.push({ rel: relPath, content });
    }
  }

  await walk(rootDir, "");
  return { dirs, files };
}

async function installPluginDirectory(
  source: string,
  extensionDir: string,
  force: boolean,
): Promise<string> {
  const manifest = await loadPluginManifest(source);
  const collected = await collectPluginDirectoryEntries(manifest.dir);
  const target = normalizeAbsolute(path.join(extensionDir, manifest.id));
  if (path.dirname(target) !== extensionDir) {
    throw new PluginError(
      "plugin target escapes extension directory",
      "plugin.target_escape",
    );
  }
  let existing = false;
  try {
    const current = await fs.lstat(target);
    existing = true;
    if (!force) {
      throw new PluginError(
        `plugin ${manifest.id} already exists; pass --force to replace it`,
        "plugin.already_exists",
      );
    }
    if (!current.isDirectory() || current.isSymbolicLink()) {
      throw new PluginError(
        "plugin target is not a directory",
        "plugin.target_type",
      );
    }
  } catch (error) {
    if (error instanceof PluginError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const suffix = randomBytes(4).toString("hex");
  const stageDir = path.join(extensionDir, `.install-${manifest.id}-${suffix}`);
  const backupDir = path.join(extensionDir, `.replace-${manifest.id}-${suffix}`);
  let movedBackup = false;
  try {
    await ensurePrivateDir(stageDir);
    for (const relDir of collected.dirs) {
      await ensurePrivateDir(path.join(stageDir, relDir));
    }
    for (const file of collected.files) {
      await fs.writeFile(path.join(stageDir, file.rel), file.content, {
        mode: 0o600,
      });
    }
    if (existing) {
      await fs.rename(target, backupDir);
      movedBackup = true;
    }
    await fs.rename(stageDir, target);
    if (movedBackup) {
      await fs.rm(backupDir, { recursive: true, force: true });
    }
    return target;
  } catch (error) {
    if (movedBackup) {
      await fs.rename(backupDir, target).catch(() => undefined);
    }
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function installUserPlugin(
  options: PluginInstallOptions,
): Promise<string> {
  const source = normalizeAbsolute(options.source);
  let stat;
  try {
    stat = await fs.lstat(source);
  } catch (error) {
    throw new PluginError(
      `plugin source cannot be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "plugin.source_missing",
    );
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    const extensionDir = await ensureExtensionDir(options.extensionDir);
    return installPluginDirectory(source, extensionDir, options.force === true);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !PLUGIN_FILE.test(path.basename(source))
  ) {
    throw new PluginError(
      "plugin source must be a regular .mjs, .cjs, .js, or .ts file or a plugin directory containing plugin.toml",
      "plugin.source_type",
    );
  }
  if (stat.size > MAX_PLUGIN_BYTES) {
    throw new PluginError(
      `plugin source exceeds ${MAX_PLUGIN_BYTES} bytes`,
      "plugin.too_large",
    );
  }
  const content = await fs.readFile(source);
  if (content.includes(0)) {
    throw new PluginError(
      "plugin source contains NUL bytes",
      "plugin.binary_content",
    );
  }
  const extensionDir = await ensureExtensionDir(options.extensionDir);
  const target = path.join(extensionDir, path.basename(source));
  let existing = false;
  try {
    await fs.lstat(target);
    existing = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (existing && options.force !== true) {
    throw new PluginError(
      `plugin ${path.basename(source)} already exists; pass --force to replace it`,
      "plugin.already_exists",
    );
  }
  if (existing) {
    const current = await fs.lstat(target);
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new PluginError(
        "plugin target is not a regular file",
        "plugin.target_type",
      );
    }
  }
  await atomicWriteFile(target, content.toString("utf8"), 0o600);
  return target;
}

export async function removeUserPlugin(options: {
  extensionDir: string;
  name: string;
}): Promise<string> {
  const isFile = PLUGIN_FILE.test(options.name);
  const isDirectoryId = !isFile && PLUGIN_ID_RE.test(options.name);
  if (!isFile && !isDirectoryId) {
    throw new PluginError("plugin name is invalid", "plugin.invalid_name");
  }
  const extensionDir = normalizeAbsolute(options.extensionDir);
  let dirStat;
  try {
    dirStat = await fs.lstat(extensionDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PluginError(
        `plugin ${options.name} is not installed`,
        "plugin.not_found",
      );
    }
    throw error;
  }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new PluginError(
      "plugin target must not use a symlinked path",
      "plugin.target_escape",
    );
  }
  const target = path.join(extensionDir, options.name);
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PluginError(
        `plugin ${options.name} is not installed`,
        "plugin.not_found",
      );
    }
    throw error;
  }
  if (isFile && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new PluginError(
      "plugin target is not a regular file",
      "plugin.target_type",
    );
  }
  if (isDirectoryId && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new PluginError(
      "plugin target is not a directory",
      "plugin.target_type",
    );
  }
  const realDir = normalizeAbsolute(await fs.realpath(extensionDir));
  const real = normalizeAbsolute(await fs.realpath(target));
  if (real !== normalizeAbsolute(path.join(realDir, options.name))) {
    throw new PluginError(
      "plugin target must not use a symlinked path",
      "plugin.target_escape",
    );
  }
  if (isDirectoryId) {
    await fs.rm(target, { recursive: true, force: false });
  } else {
    await fs.unlink(target);
  }
  return target;
}

/**
 * Loads user-level Pi plugins from `~/.codepunk/extensions`.
 *
 * v1 rules: plugins are opt-in, user-level only, and may not register tools.
 * A tool-registering plugin aborts startup instead of running unwrapped.
 */
export async function loadUserPlugins(
  options: PluginLoadOptions,
): Promise<PluginLoadResult> {
  const dir = normalizeAbsolute(options.extensionDir);
  const summary: PluginSummary = {
    enabled: options.allowed,
    dir,
    paths: [],
    errors: [],
    warnings: [],
  };
  if (!options.allowed) {
    return { paths: [], summary };
  }
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { paths: [], summary };
    }
    throw new PluginError(
      `cannot read plugin directory: ${(error as Error).message}`,
    );
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && /\.(?:mjs|cjs|js|ts)$/u.test(entry.name)) {
      files.push(normalizeAbsolute(path.join(dir, entry.name)));
    }
  }
  files.sort();
  summary.paths = files;
  if (files.length === 0) {
    return { paths: [], summary };
  }
  return { paths: files, summary };
}
