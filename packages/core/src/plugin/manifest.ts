import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseToml, type TomlTable, type TomlValue } from "../config/toml.ts";
import {
  isInsidePath,
  normalizeAbsolute,
  resolveRealPath,
} from "../platform/path.ts";
import { PluginError } from "./index.ts";

const MANIFEST_FILE = "plugin.toml";
const MAX_ENTRY_BYTES = 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const TOOL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const DOMAIN_RE =
  /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[0-9]{1,5})?$/u;
const TOP_LEVEL = new Set([
  "id",
  "version",
  "entry",
  "tools",
  "commands",
  "files",
  "network",
  "capabilities",
]);
const FILE_KEYS = new Set(["read", "write"]);
const NETWORK_KEYS = new Set(["allow"]);
const CAPABILITIES = new Set([
  "tools",
  "commands",
  "filesystem.read",
  "filesystem.write",
  "network",
]);

export interface PluginManifest {
  id: string;
  version: string;
  dir: string;
  entry: string;
  manifestPath: string;
  manifestSha256: string;
  tools: string[];
  commands: string[];
  readRoots: string[];
  writeRoots: string[];
  networkAllow: string[];
  capabilities: string[];
}

export interface PluginManifestLoadResult {
  manifests: PluginManifest[];
  errors: { dir: string; code: string; message: string }[];
}

function invalid(message: string, code = "plugin.manifest_invalid"): never {
  throw new PluginError(message, code);
}

function table(value: TomlValue | undefined, name: string): TomlTable {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${name} must be a table`);
  }
  return value;
}

function stringValue(source: TomlTable, key: string, name: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function stringArray(source: TomlTable, key: string, name: string): string[] {
  const value = source[key];
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    invalid(`${name} must be an array of non-empty strings`);
  }
  const values = value as string[];
  return [...new Set(values.map((item) => item.trim()))].sort();
}

function assertKeys(
  source: TomlTable,
  allowed: ReadonlySet<string>,
  name: string,
): void {
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      invalid(
        `${name} contains unknown field ${key}`,
        "plugin.manifest_unknown_field",
      );
    }
  }
}

function resolveRoot(
  pluginDir: string,
  candidate: string,
  label: string,
): string {
  if (path.isAbsolute(candidate) || candidate.split(/[\\/]/u).includes("..")) {
    invalid(`${label} must be a relative path inside the plugin directory`);
  }
  const resolved = resolveRealPath(path.join(pluginDir, candidate));
  if (!isInsidePath(pluginDir, resolved)) {
    invalid(
      `${label} escapes the plugin directory`,
      "plugin.manifest_path_escape",
    );
  }
  return resolved;
}

export async function loadPluginManifest(
  pluginDirInput: string,
): Promise<PluginManifest> {
  const pluginDir = normalizeAbsolute(pluginDirInput);
  let dirStat;
  try {
    dirStat = await fs.lstat(pluginDir);
  } catch (error) {
    throw new PluginError(
      `plugin directory cannot be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "plugin.manifest_missing",
    );
  }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    invalid("plugin path must be a real directory", "plugin.manifest_missing");
  }
  const realDir = normalizeAbsolute(await fs.realpath(pluginDir));
  const manifestPath = path.join(realDir, MANIFEST_FILE);
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PluginError(
        `plugin.toml is required in ${realDir}`,
        "plugin.manifest_missing",
      );
    }
    throw new PluginError(
      `plugin.toml cannot be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "plugin.manifest_invalid",
    );
  }
  let parsed: TomlTable;
  try {
    parsed = parseToml(bytes.toString("utf8"));
  } catch (error) {
    throw new PluginError(
      `plugin.toml is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "plugin.manifest_invalid",
    );
  }
  assertKeys(parsed, TOP_LEVEL, "plugin.toml");
  const id = stringValue(parsed, "id", "id");
  if (!ID_RE.test(id)) {
    invalid("id must be lowercase letters, digits, or hyphens");
  }
  const version = stringValue(parsed, "version", "version");
  if (!VERSION_RE.test(version)) {
    invalid("version must be a semantic version");
  }
  const entryValue = stringValue(parsed, "entry", "entry");
  const entry = resolveRoot(realDir, entryValue, "entry");
  let entryStat;
  try {
    entryStat = await fs.lstat(entry);
  } catch {
    invalid(`entry does not exist: ${entryValue}`, "plugin.manifest_entry");
  }
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
    invalid("entry must be a regular file", "plugin.manifest_entry");
  }
  if (entryStat.size > MAX_ENTRY_BYTES) {
    invalid(`entry exceeds ${MAX_ENTRY_BYTES} bytes`, "plugin.manifest_entry");
  }
  const tools = stringArray(parsed, "tools", "tools");
  for (const tool of tools) {
    if (!TOOL_RE.test(tool)) {
      invalid(`tool name ${tool} is invalid`);
    }
  }
  const commands = stringArray(parsed, "commands", "commands");
  for (const command of commands) {
    if (!TOOL_RE.test(command)) {
      invalid(`command name ${command} is invalid`);
    }
  }
  const files = table(parsed["files"], "files");
  assertKeys(files, FILE_KEYS, "files");
  const readRoots = stringArray(files, "read", "files.read").map((candidate) =>
    resolveRoot(realDir, candidate, "files.read"),
  );
  const writeRoots = stringArray(files, "write", "files.write").map(
    (candidate) => resolveRoot(realDir, candidate, "files.write"),
  );
  const network = table(parsed["network"], "network");
  assertKeys(network, NETWORK_KEYS, "network");
  const networkAllow = stringArray(network, "allow", "network.allow").map(
    (domain) => {
      const normalized = domain.toLowerCase();
      if (!DOMAIN_RE.test(normalized)) {
        invalid(`network domain ${domain} is invalid`);
      }
      return normalized;
    },
  );
  const capabilities = stringArray(parsed, "capabilities", "capabilities");
  for (const capability of capabilities) {
    if (!CAPABILITIES.has(capability)) {
      invalid(
        `capability ${capability} is not supported`,
        "plugin.capability_unknown",
      );
    }
  }
  if (tools.length > 0 && !capabilities.includes("tools")) {
    invalid("declared tools require the tools capability");
  }
  if (commands.length > 0 && !capabilities.includes("commands")) {
    invalid("declared commands require the commands capability");
  }
  if (readRoots.length > 0 && !capabilities.includes("filesystem.read")) {
    invalid("files.read requires the filesystem.read capability");
  }
  if (writeRoots.length > 0 && !capabilities.includes("filesystem.write")) {
    invalid("files.write requires the filesystem.write capability");
  }
  if (networkAllow.length > 0 && !capabilities.includes("network")) {
    invalid("network.allow requires the network capability");
  }
  return {
    id,
    version,
    dir: realDir,
    entry,
    manifestPath,
    manifestSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    tools,
    commands,
    readRoots,
    writeRoots,
    networkAllow,
    capabilities,
  };
}

/**
 * Scans the user extension root. Only directories with a `plugin.toml` are
 * candidates; a bare script is reported instead of being loaded, because the
 * pre-isolation extension format has no manifest to enforce.
 */
export async function loadPluginManifests(
  extensionDirInput: string,
): Promise<PluginManifestLoadResult> {
  const extensionDir = normalizeAbsolute(extensionDirInput);
  let entries;
  try {
    entries = await fs.readdir(extensionDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { manifests: [], errors: [] };
    }
    throw new PluginError(
      `plugin directory cannot be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "plugin.root",
    );
  }
  const manifests: PluginManifest[] = [];
  const errors: { dir: string; code: string; message: string }[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const candidate = path.join(extensionDir, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      errors.push({
        dir: normalizeAbsolute(candidate),
        code: "plugin.manifest_missing",
        message:
          "legacy extension has no plugin.toml; migrate it into its own plugin directory",
      });
      continue;
    }
    try {
      manifests.push(await loadPluginManifest(candidate));
    } catch (error) {
      errors.push({
        dir: normalizeAbsolute(candidate),
        code:
          error instanceof PluginError ? error.code : "plugin.manifest_invalid",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const seen = new Map<string, string>();
  const unique: PluginManifest[] = [];
  for (const manifest of manifests) {
    const previous = seen.get(manifest.id);
    if (previous !== undefined) {
      errors.push({
        dir: manifest.dir,
        code: "plugin.manifest_duplicate_id",
        message: `plugin id ${manifest.id} is already used by ${previous}`,
      });
      continue;
    }
    seen.set(manifest.id, manifest.dir);
    unique.push(manifest);
  }
  return { manifests: unique, errors };
}
