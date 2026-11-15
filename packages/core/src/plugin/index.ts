import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteFile, ensurePrivateDir } from "../platform/fs.ts";
import { normalizeAbsolute } from "../platform/path.ts";

export class PluginError extends Error {
  readonly code: string;

  constructor(message: string, code = "plugin.error") {
    super(message);
    this.name = "PluginError";
    this.code = code;
  }
}

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
    }
  }
  return files.sort();
}

export async function listUserPluginFiles(
  extensionDir: string,
): Promise<string[]> {
  return listExtensionFiles(normalizeAbsolute(extensionDir));
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
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !PLUGIN_FILE.test(path.basename(source))
  ) {
    throw new PluginError(
      "plugin source must be a regular .mjs, .cjs, .js, or .ts file",
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
  const extensionDir = normalizeAbsolute(options.extensionDir);
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
  if (!PLUGIN_FILE.test(options.name)) {
    throw new PluginError("plugin name is invalid", "plugin.invalid_name");
  }
  const extensionDir = normalizeAbsolute(options.extensionDir);
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
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new PluginError(
      "plugin target is not a regular file",
      "plugin.target_type",
    );
  }
  const real = normalizeAbsolute(await fs.realpath(target));
  if (real !== normalizeAbsolute(target)) {
    throw new PluginError(
      "plugin target must not use a symlinked path",
      "plugin.target_escape",
    );
  }
  await fs.unlink(target);
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
  const files = await listExtensionFiles(dir);
  summary.paths = files;
  if (files.length === 0) {
    return { paths: [], summary };
  }
  return { paths: files, summary };
}
