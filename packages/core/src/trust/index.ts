import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { SCHEMA_VERSIONS, STATE_FILES } from "codepunk-protocol";
import {
  ProjectTrustStore,
  type ProjectTrustStoreEntry,
} from "@earendil-works/pi-coding-agent";
import {
  isInsidePath,
  normalizeAbsolute,
  resolveRealPath,
} from "../platform/path.ts";
import {
  CLAIM_LOCK_STALE_MS,
  CLAIM_LOCK_TIMEOUT_MS,
  withClaimFileLock,
} from "../platform/file-lock.ts";
import { readJsonFile, writeJsonAtomic } from "../platform/fs.ts";
import { discoverProjectInstructionFiles } from "../platform/context-files.ts";
import { sha256Value } from "../platform/hash.ts";

export type WorkspaceTrustSource =
  "flag" | "saved" | "prompt" | "default" | "no-resources";

export const WORKSPACE_TRUST_RESOURCE_KINDS = [
  "config",
  "policy",
  "skills",
  "instructions",
] as const;

export type WorkspaceTrustResourceKind =
  (typeof WORKSPACE_TRUST_RESOURCE_KINDS)[number];

export type WorkspaceTrustGrants = Record<WorkspaceTrustResourceKind, boolean>;

export type WorkspaceTrustMode = "all" | "custom" | "none";

export interface WorkspaceTrust {
  /**
   * True only when every discovered resource kind is granted. Consumers that
   * load one specific resource class must read `grants` instead; a workspace
   * can load project instructions while denying project config.
   */
  trusted: boolean;
  mode: WorkspaceTrustMode;
  grants: WorkspaceTrustGrants;
  available: WorkspaceTrustResourceKind[];
  source: WorkspaceTrustSource;
  cwd: string;
  root: string;
  resources: string[];
  storePath: string;
  resourceStorePath: string;
  savedPath: string | null;
}

export type WorkspaceTrustResourceType =
  "file" | "directory" | "symlink" | "other" | "missing";

export interface WorkspaceTrustResourcePreview {
  path: string;
  kind: WorkspaceTrustResourceKind;
  type: WorkspaceTrustResourceType;
  bytes: number | null;
  sha256: string | null;
  truncated: boolean;
  /**
   * Why the entry could not be inspected. Absent for readable entries and for
   * entries that stopped at a symlink or a missing path.
   */
  reason?: "unreadable" | "symlink-ancestor";
}

const TRUST_REQUIRING_FILES = [
  "config.toml",
  "hooks.toml",
  "local.toml",
  "mcp.toml",
  "mcp.json",
  "policy.toml",
] as const;

const TRUST_REQUIRING_DIRECTORIES = ["skills", "agents", "commands"] as const;
const PREVIEW_MAX_ENTRIES = 512;
const PREVIEW_MAX_BYTES = 1024 * 1024;
const NOFOLLOW = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
const RESOURCE_TRUST_STORE_VERSION = SCHEMA_VERSIONS.resourceTrust;
const RESOURCE_TRUST_STORE_FILE = STATE_FILES.WORKSPACE_TRUST;

async function directoryHasEntries(directory: string): Promise<boolean> {
  try {
    const handle = await fs.opendir(directory);
    for await (const _entry of handle) {
      return true;
    }
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function projectInstructionFiles(
  root: string,
  cwd: string,
): Promise<string[]> {
  const files = await discoverProjectInstructionFiles({ root, cwd });
  const resources: string[] = [];
  for (const file of files) {
    const candidate = normalizeAbsolute(file);
    if (!isInsidePath(root, candidate)) {
      continue;
    }
    resources.push(path.relative(root, candidate).split(path.sep).join("/"));
  }
  return resources;
}

/**
 * Project resources that can change the agent's instructions or tools without
 * the user asking. A bare `.codepunk` directory is deliberately not enough:
 * `ensureProjectConfigDir()` creates one in every project.
 */
export async function findTrustRequiringProjectResources(
  root: string,
  cwd: string = root,
  options: {
    includeSkills?: boolean;
    includeInstructions?: boolean;
  } = {},
): Promise<string[]> {
  const normalizedRoot = normalizeAbsolute(root);
  const normalizedCwd = normalizeAbsolute(cwd);
  const projectDir = path.join(normalizedRoot, ".codepunk");
  const resources: string[] = [];
  const rootMcpJson = path.join(normalizedRoot, ".mcp.json");
  try {
    const stat = await fs.lstat(rootMcpJson);
    if (stat.isSymbolicLink() || stat.isFile()) {
      resources.push(".mcp.json");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      resources.push(".mcp.json");
    }
  }
  for (const name of TRUST_REQUIRING_FILES) {
    const candidate = path.join(projectDir, name);
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink() || stat.isFile()) {
        resources.push(`.codepunk/${name}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        resources.push(`.codepunk/${name}`);
      }
    }
  }
  if (options.includeSkills !== false) {
    for (const name of TRUST_REQUIRING_DIRECTORIES) {
      const candidate = path.join(projectDir, name);
      try {
        const stat = await fs.lstat(candidate);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          resources.push(`.codepunk/${name}`);
          continue;
        }
        if (await directoryHasEntries(candidate)) {
          resources.push(`.codepunk/${name}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          resources.push(`.codepunk/${name}`);
        }
      }
    }
  }
  if (options.includeInstructions !== false) {
    resources.push(
      ...(await projectInstructionFiles(normalizedRoot, normalizedCwd)),
    );
  }
  return resources;
}

export function workspaceTrustResourceKind(
  resource: string,
): WorkspaceTrustResourceKind {
  if (
    resource === ".mcp.json" ||
    resource.endsWith("/.mcp.json") ||
    resource.endsWith("/config.toml") ||
    resource.endsWith("/hooks.toml") ||
    resource.endsWith("/local.toml") ||
    resource.endsWith("/mcp.toml") ||
    resource.endsWith("/mcp.json")
  ) {
    return "config";
  }
  if (resource.endsWith("/agents") || resource.endsWith("/commands")) {
    return "config";
  }
  if (resource.endsWith("/policy.toml")) {
    return "policy";
  }
  if (resource.endsWith("/skills")) {
    return "skills";
  }
  return "instructions";
}

interface PreviewState {
  entries: number;
  bytes: number;
  truncated: boolean;
}

interface PreviewEntry {
  type: WorkspaceTrustResourceType;
  bytes: number | null;
  sha256: string | null;
  truncated: boolean;
  reason?: "unreadable" | "symlink-ancestor";
}

function unreadableEntry(
  type: WorkspaceTrustResourceType = "other",
): PreviewEntry {
  return {
    type,
    bytes: null,
    sha256: null,
    truncated: false,
    reason: "unreadable",
  };
}

/**
 * Returns the first path component between `root` and `resource` that is a
 * symbolic link, if any. A resource reached through a linked directory would
 * otherwise be read from outside the checkout, because lexical containment
 * checks cannot see the link.
 */
async function symlinkInPath(
  root: string,
  resource: string,
): Promise<string | null> {
  let current = root;
  for (const segment of resource.split("/")) {
    if (segment.length === 0) {
      continue;
    }
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        return current;
      }
    } catch {
      return null;
    }
  }
  return null;
}

async function previewFile(
  absolute: string,
  size: number,
  state: PreviewState,
): Promise<PreviewEntry> {
  const remaining = Math.max(0, PREVIEW_MAX_BYTES - state.bytes);
  const readBytes = Math.min(size, remaining);
  let content = Buffer.alloc(0);
  if (readBytes > 0) {
    let handle;
    try {
      // O_NOFOLLOW closes the lstat-to-open window where the file could be
      // replaced with a symlink pointing outside the workspace.
      handle = await fs.open(absolute, fsConstants.O_RDONLY | NOFOLLOW);
    } catch {
      return unreadableEntry("other");
    }
    try {
      const buffer = Buffer.alloc(readBytes);
      const result = await handle.read(buffer, 0, readBytes, 0);
      content = buffer.subarray(0, result.bytesRead);
    } finally {
      await handle.close();
    }
  }
  state.bytes += content.length;
  const truncated = size > content.length;
  if (truncated) {
    state.truncated = true;
  }
  return {
    type: "file",
    bytes: size,
    sha256: sha256Value({
      type: "file",
      size,
      content: content.toString("base64"),
      truncated,
    }),
    truncated,
  };
}

async function previewEntry(
  absolute: string,
  state: PreviewState,
): Promise<PreviewEntry> {
  let stat;
  try {
    stat = await fs.lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        type: "missing",
        bytes: null,
        sha256: null,
        truncated: false,
      };
    }
    return unreadableEntry();
  }
  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = await fs.readlink(absolute);
    } catch {
      return unreadableEntry("symlink");
    }
    return {
      type: "symlink",
      bytes: null,
      sha256: sha256Value({ type: "symlink", target }),
      truncated: false,
    };
  }
  if (stat.isFile()) {
    return previewFile(absolute, stat.size, state);
  }
  if (!stat.isDirectory()) {
    return {
      type: "other",
      bytes: null,
      sha256: null,
      truncated: false,
    };
  }
  const entries: Array<{ name: string; entry: PreviewEntry }> = [];
  const names: string[] = [];
  try {
    const directory = await fs.opendir(absolute);
    for await (const entry of directory) {
      names.push(entry.name);
      if (names.length > PREVIEW_MAX_ENTRIES) {
        state.truncated = true;
        break;
      }
    }
  } catch {
    return unreadableEntry("directory");
  }
  names.sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    if (state.entries >= PREVIEW_MAX_ENTRIES) {
      state.truncated = true;
      break;
    }
    state.entries += 1;
    entries.push({
      name,
      entry: await previewEntry(path.join(absolute, name), state),
    });
  }
  if (entries.some((item) => item.entry.reason === "unreadable")) {
    // Reporting a numeric total here would read as "this directory is small"
    // even though part of it was never inspected.
    return unreadableEntry("directory");
  }
  return {
    type: "directory",
    bytes: entries.reduce((total, item) => total + (item.entry.bytes ?? 0), 0),
    sha256: sha256Value({
      type: "directory",
      entries,
      truncated: state.truncated,
    }),
    truncated: state.truncated,
  };
}

/**
 * Inspect each resource without following symlinks. The digest is a bounded
 * preview: files above 1 MiB and directories above 512 entries are marked
 * truncated, so an untrusted checkout cannot make trust startup read an
 * unbounded amount of data.
 */
export async function previewWorkspaceTrustResources(
  root: string,
  cwd: string = root,
  options: {
    includeSkills?: boolean;
    includeInstructions?: boolean;
  } = {},
): Promise<WorkspaceTrustResourcePreview[]> {
  const normalizedRoot = normalizeAbsolute(root);
  const resources = await findTrustRequiringProjectResources(
    normalizedRoot,
    cwd,
    options,
  );
  const previews: WorkspaceTrustResourcePreview[] = [];
  for (const resource of resources) {
    const absolute = path.join(normalizedRoot, resource);
    if (!isInsidePath(normalizedRoot, absolute)) {
      throw new Error(`trust resource escapes the workspace root: ${resource}`);
    }
    const linked = await symlinkInPath(normalizedRoot, resource);
    if (linked !== null) {
      let target: string | null = null;
      try {
        target = await fs.readlink(linked);
      } catch {
        target = null;
      }
      previews.push({
        path: resource,
        kind: workspaceTrustResourceKind(resource),
        type: "symlink",
        bytes: null,
        sha256:
          target === null ? null : sha256Value({ type: "symlink", target }),
        truncated: false,
        reason: "symlink-ancestor",
      });
      continue;
    }
    const state: PreviewState = {
      entries: 1,
      bytes: 0,
      truncated: false,
    };
    let entry: PreviewEntry;
    try {
      entry = await previewEntry(absolute, state);
    } catch {
      entry = unreadableEntry();
    }
    previews.push({
      path: resource,
      kind: workspaceTrustResourceKind(resource),
      ...entry,
    });
  }
  return previews;
}

export function formatWorkspaceTrustResourcePreview(
  preview: WorkspaceTrustResourcePreview,
  options: { compactDigest?: boolean } = {},
): string {
  const facts = [
    preview.type,
    preview.bytes === null ? null : `${preview.bytes} B`,
    preview.truncated ? "truncated" : null,
  ].filter((fact): fact is string => fact !== null);
  const lines = [`  [${preview.kind}] ${preview.path} (${facts.join(", ")})`];
  if (preview.sha256 !== null) {
    lines.push(
      `    ${
        options.compactDigest === true
          ? `${preview.sha256.slice(0, 19)}\u2026`
          : preview.sha256
      }`,
    );
  }
  if (preview.reason !== undefined) {
    lines.push(`    ${preview.reason}`);
  }
  return lines.join("\n");
}

export function workspaceTrustStorePath(home: string): string {
  return path.join(normalizeAbsolute(home), "trust.json");
}

export function workspaceResourceTrustStorePath(home: string): string {
  return path.join(normalizeAbsolute(home), RESOURCE_TRUST_STORE_FILE);
}

export function allWorkspaceTrustGrants(value: boolean): WorkspaceTrustGrants {
  return {
    config: value,
    policy: value,
    skills: value,
    instructions: value,
  };
}

export function workspaceTrustGrantsFromKinds(
  kinds: readonly WorkspaceTrustResourceKind[],
): WorkspaceTrustGrants {
  const grants = allWorkspaceTrustGrants(false);
  for (const kind of kinds) {
    grants[kind] = true;
  }
  return grants;
}

/**
 * Apply a partial grant or revoke without touching resource kinds the caller
 * did not name. A partial revoke must never widen trust, so callers should
 * start from the saved decision rather than an all-true default.
 */
export function applyWorkspaceTrustGrantChanges(
  grants: WorkspaceTrustGrants,
  kinds: readonly WorkspaceTrustResourceKind[],
  value: boolean,
): WorkspaceTrustGrants {
  const updated = { ...grants };
  for (const kind of kinds) {
    updated[kind] = value;
  }
  return updated;
}

export function workspaceTrustKindLabel(
  kind: WorkspaceTrustResourceKind,
): string {
  return {
    config: "project-config",
    policy: "project-policy",
    skills: "project-skills",
    instructions: "project-instructions",
  }[kind];
}

export function availableWorkspaceTrustKinds(
  resources: readonly string[],
): WorkspaceTrustResourceKind[] {
  const present = new Set(
    resources.map((resource) => workspaceTrustResourceKind(resource)),
  );
  return WORKSPACE_TRUST_RESOURCE_KINDS.filter((kind) => present.has(kind));
}

export function workspaceTrustMode(
  grants: WorkspaceTrustGrants,
): WorkspaceTrustMode {
  const granted = WORKSPACE_TRUST_RESOURCE_KINDS.filter(
    (kind) => grants[kind],
  ).length;
  if (granted === WORKSPACE_TRUST_RESOURCE_KINDS.length) {
    return "all";
  }
  return granted === 0 ? "none" : "custom";
}

function grantedKinds(
  grants: WorkspaceTrustGrants,
  available: readonly WorkspaceTrustResourceKind[],
): WorkspaceTrustResourceKind[] {
  return available.filter((kind) => grants[kind]);
}

export interface SavedWorkspaceTrust {
  entry: ProjectTrustStoreEntry;
  /**
   * True when the decision belongs to an ancestor directory rather than this
   * exact checkout. Codepunk displays that fact but never applies the ancestor
   * decision to a nested repository.
   */
  inherited: boolean;
}

export function inspectSavedWorkspaceTrust(
  home: string,
  root: string,
): SavedWorkspaceTrust | null {
  const entry = new ProjectTrustStore(normalizeAbsolute(home)).getEntry(root);
  if (entry === null) {
    return null;
  }
  const requested = normalizeAbsolute(resolveRealPath(root));
  const saved = normalizeAbsolute(resolveRealPath(entry.path));
  return {
    entry,
    inherited: requested !== saved,
  };
}

export function readSavedWorkspaceTrust(
  home: string,
  root: string,
): ProjectTrustStoreEntry | null {
  const saved = inspectSavedWorkspaceTrust(home, root);
  // Pi's store returns the closest saved ancestor. A decision for a parent
  // repository must not silently trust a nested repository that can carry its
  // own .codepunk configuration.
  return saved === null || saved.inherited ? null : saved.entry;
}

interface StoredWorkspaceTrustEntry {
  grants: WorkspaceTrustGrants;
  updated_at: string;
  source: "prompt" | "cli";
}

interface StoredWorkspaceTrustFile {
  version: typeof RESOURCE_TRUST_STORE_VERSION;
  workspaces: Record<string, StoredWorkspaceTrustEntry>;
}

/**
 * Serialize Codepunk's trust sidecar and Pi's legacy trust store. Pi still
 * owns the legacy file shape, but this claim lock coordinates all Codepunk
 * writers without changing that format.
 */
async function withWorkspaceTrustLock<T>(
  home: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockDir = path.join(
    normalizeAbsolute(home),
    `${path.basename(workspaceTrustStorePath(home))}.lock.d`,
  );
  return withClaimFileLock(
    {
      lockDir,
      timeoutMs: CLAIM_LOCK_TIMEOUT_MS,
      staleMs: CLAIM_LOCK_STALE_MS,
      busyError: () =>
        new Error("workspace trust store is locked by another process"),
    },
    operation,
  );
}

export interface SavedWorkspaceResourceTrust {
  path: string;
  entry: StoredWorkspaceTrustEntry;
}

function parseStoredGrants(
  value: unknown,
  storePath: string,
  root: string,
): WorkspaceTrustGrants {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `${storePath} has a non-object grants value for ${root}; repair or remove the resource trust store`,
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(WORKSPACE_TRUST_RESOURCE_KINDS as readonly string[]).includes(key)) {
      throw new Error(
        `${storePath} has an unknown resource kind ${key} for ${root}; repair or remove the resource trust store`,
      );
    }
  }
  const grants = allWorkspaceTrustGrants(false);
  for (const kind of WORKSPACE_TRUST_RESOURCE_KINDS) {
    const entry = record[kind];
    if (entry === undefined) {
      continue;
    }
    if (typeof entry !== "boolean") {
      throw new Error(
        `${storePath} has a non-boolean ${kind} decision for ${root}; repair or remove the resource trust store`,
      );
    }
    grants[kind] = entry;
  }
  return grants;
}

function parseResourceTrustStore(
  value: unknown,
  storePath: string,
): Record<string, StoredWorkspaceTrustEntry> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `${storePath} is not a JSON object; repair or remove the resource trust store`,
    );
  }
  const record = value as Record<string, unknown>;
  if (record["version"] !== RESOURCE_TRUST_STORE_VERSION) {
    throw new Error(
      `${storePath} uses an unsupported version ${String(
        record["version"],
      )}; repair or remove the resource trust store`,
    );
  }
  const workspaces = record["workspaces"];
  if (
    typeof workspaces !== "object" ||
    workspaces === null ||
    Array.isArray(workspaces)
  ) {
    throw new Error(
      `${storePath} has no workspaces object; repair or remove the resource trust store`,
    );
  }
  const parsed: Record<string, StoredWorkspaceTrustEntry> = {};
  for (const [rawRoot, rawEntry] of Object.entries(workspaces)) {
    const root = normalizeAbsolute(rawRoot);
    if (
      typeof rawEntry !== "object" ||
      rawEntry === null ||
      Array.isArray(rawEntry)
    ) {
      throw new Error(
        `${storePath} has a non-object entry for ${root}; repair or remove the resource trust store`,
      );
    }
    const entry = rawEntry as Record<string, unknown>;
    if (entry["source"] !== "prompt" && entry["source"] !== "cli") {
      throw new Error(
        `${storePath} has an invalid source for ${root}; repair or remove the resource trust store`,
      );
    }
    if (typeof entry["updated_at"] !== "string") {
      throw new Error(
        `${storePath} has no updated_at for ${root}; repair or remove the resource trust store`,
      );
    }
    parsed[root] = {
      grants: parseStoredGrants(entry["grants"], storePath, root),
      updated_at: entry["updated_at"],
      source: entry["source"],
    };
  }
  return parsed;
}

async function readResourceTrustStore(
  home: string,
): Promise<Record<string, StoredWorkspaceTrustEntry>> {
  const storePath = workspaceResourceTrustStorePath(home);
  try {
    const value = await readJsonFile<unknown>(storePath);
    return value === null ? {} : parseResourceTrustStore(value, storePath);
  } catch (error) {
    throw new Error(
      `workspace resource trust store ${storePath} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }; repair or remove the store before starting Codepunk`,
      { cause: error },
    );
  }
}

export async function inspectSavedWorkspaceResourceTrust(
  home: string,
  root: string,
): Promise<SavedWorkspaceResourceTrust | null> {
  const canonical = normalizeAbsolute(resolveRealPath(root));
  const workspaces = await readResourceTrustStore(home);
  const entry = workspaces[canonical];
  return entry === undefined ? null : { path: canonical, entry };
}

/**
 * The saved per-resource decision, or the legacy whole-workspace boolean when
 * no sidecar exists. An unsaved workspace starts with every kind denied so a
 * partial revoke cannot grant anything by omission.
 */
export async function readSavedWorkspaceTrustGrants(
  home: string,
  root: string,
): Promise<WorkspaceTrustGrants> {
  const savedResources = await inspectSavedWorkspaceResourceTrust(home, root);
  if (savedResources !== null) {
    return { ...savedResources.entry.grants };
  }
  const saved = readSavedWorkspaceTrust(home, root);
  return allWorkspaceTrustGrants(saved?.decision ?? false);
}

export async function saveWorkspaceTrustGrants(
  home: string,
  cwd: string,
  grants: WorkspaceTrustGrants,
  source: "prompt" | "cli" = "cli",
): Promise<{ storePath: string; resourceStorePath: string }> {
  return withWorkspaceTrustLock(home, async () => {
    const root = normalizeAbsolute(resolveRealPath(cwd));
    const resourceStorePath = workspaceResourceTrustStorePath(home);
    const workspaces = await readResourceTrustStore(home);
    workspaces[root] = {
      grants: { ...grants },
      updated_at: new Date().toISOString(),
      source,
    };
    const store: StoredWorkspaceTrustFile = {
      version: RESOURCE_TRUST_STORE_VERSION,
      workspaces,
    };

    // Pi's store can only express a whole-workspace boolean. Keep it
    // conservative for partial decisions so removing Codepunk's sidecar cannot
    // silently widen trust when another Pi entry point reads the same store.
    const allGranted = WORKSPACE_TRUST_RESOURCE_KINDS.every(
      (kind) => grants[kind],
    );
    const storePath = await saveWorkspaceTrustUnlocked(home, root, allGranted);
    try {
      await writeJsonAtomic(resourceStorePath, store);
    } catch (error) {
      // The Pi boolean is already conservative, so a failed sidecar write can
      // only narrow trust. Report the failure instead of claiming a saved
      // per-resource decision.
      throw new Error(
        `workspace resource trust store ${resourceStorePath} could not be written: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    return { storePath, resourceStorePath };
  });
}

export async function saveWorkspaceTrust(
  home: string,
  cwd: string,
  decision: boolean,
): Promise<string> {
  return withWorkspaceTrustLock(home, async () =>
    saveWorkspaceTrustUnlocked(home, cwd, decision),
  );
}

async function saveWorkspaceTrustUnlocked(
  home: string,
  cwd: string,
  decision: boolean,
): Promise<string> {
  const store = new ProjectTrustStore(normalizeAbsolute(home));
  store.set(normalizeAbsolute(resolveRealPath(cwd)), decision);
  const filePath = workspaceTrustStorePath(home);
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(
      `Pi trust store did not write ${filePath}; the installed host may use a different trust path`,
    );
  }
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o600);
  }
  return filePath;
}

export async function resolveWorkspaceTrust(input: {
  cwd: string;
  root?: string;
  home: string;
  override?: boolean | WorkspaceTrustGrants | null;
  source?: WorkspaceTrustSource;
  savedPath?: string | null;
  includeSkills?: boolean;
  includeInstructions?: boolean;
}): Promise<WorkspaceTrust> {
  const cwd = normalizeAbsolute(input.cwd);
  const root = normalizeAbsolute(resolveRealPath(input.root ?? input.cwd));
  const resources = await findTrustRequiringProjectResources(root, cwd, {
    ...(input.includeSkills !== undefined
      ? { includeSkills: input.includeSkills }
      : {}),
    ...(input.includeInstructions !== undefined
      ? { includeInstructions: input.includeInstructions }
      : {}),
  });
  const storePath = workspaceTrustStorePath(input.home);
  const resourceStorePath = workspaceResourceTrustStorePath(input.home);
  const available = availableWorkspaceTrustKinds(resources);
  let saved: ProjectTrustStoreEntry | null;
  try {
    saved = readSavedWorkspaceTrust(input.home, root);
  } catch (error) {
    throw new Error(
      `workspace trust store ${storePath} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }; repair or remove the store before starting Codepunk`,
      { cause: error },
    );
  }
  let savedResources: SavedWorkspaceResourceTrust | null;
  try {
    savedResources = await inspectSavedWorkspaceResourceTrust(input.home, root);
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error(
          `workspace resource trust store ${resourceStorePath} could not be read: ${String(
            error,
          )}; repair or remove the store before starting Codepunk`,
          { cause: error },
        );
  }
  let grants: WorkspaceTrustGrants;
  let source: WorkspaceTrustSource;
  let savedPath: string | null;
  if (input.override === true || input.override === false) {
    grants = allWorkspaceTrustGrants(input.override);
    source = input.source ?? "flag";
    savedPath = input.savedPath ?? null;
  } else if (input.override !== undefined && input.override !== null) {
    grants = { ...input.override };
    source = input.source ?? "flag";
    savedPath = input.savedPath ?? null;
  } else if (savedResources !== null) {
    grants = { ...savedResources.entry.grants };
    source = "saved";
    savedPath = savedResources.path;
  } else if (saved !== null) {
    grants = allWorkspaceTrustGrants(saved.decision);
    source = "saved";
    savedPath = saved.path;
  } else if (resources.length === 0) {
    grants = allWorkspaceTrustGrants(true);
    source = "no-resources";
    savedPath = null;
  } else {
    grants = allWorkspaceTrustGrants(false);
    source = "default";
    savedPath = null;
  }
  const mode = workspaceTrustMode(grants);
  return {
    // A workspace that grants nothing is never trusted, even when it
    // discovers no resources at all: an explicit `--no-trust` or a revoked
    // decision must not read as trusted because the check would be vacuous.
    trusted: mode !== "none" && available.every((kind) => grants[kind]),
    mode,
    grants,
    available,
    source,
    cwd,
    root,
    resources,
    storePath,
    resourceStorePath,
    savedPath,
  };
}

export function skippedProjectResources(trust: WorkspaceTrust): string[] {
  return trust.available
    .filter((kind) => !trust.grants[kind])
    .map(workspaceTrustKindLabel);
}

function formatTrustHeadline(trust: WorkspaceTrust): string {
  if (trust.mode === "all") {
    return `trust: trusted (${trust.source})`;
  }
  if (trust.mode === "none") {
    return `trust: untrusted (${trust.source})`;
  }
  const loaded = grantedKinds(trust.grants, trust.available).join(", ");
  return loaded.length === 0
    ? `trust: custom (${trust.source})`
    : `trust: custom (${trust.source}; allowed ${loaded})`;
}

export function formatWorkspaceTrust(
  trust: WorkspaceTrust,
  previews?: readonly WorkspaceTrustResourcePreview[],
  options: { excluded?: readonly string[] } = {},
): string {
  const skipped = skippedProjectResources(trust);
  return [
    formatTrustHeadline(trust),
    `resource decisions: ${WORKSPACE_TRUST_RESOURCE_KINDS.map(
      (kind) => `${kind}=${trust.grants[kind] ? "allowed" : "skipped"}`,
    ).join(", ")}`,
    `root: ${trust.root}`,
    `store: ${trust.storePath}`,
    `resource store: ${trust.resourceStorePath}`,
    ...(trust.savedPath === null ? [] : [`saved for: ${trust.savedPath}`]),
    ...(trust.source === "prompt" && trust.savedPath === null
      ? ["scope: this session only"]
      : trust.source === "flag"
        ? ["scope: this run only"]
        : []),
    ...(trust.resources.length === 0
      ? ["project resources: none"]
      : previews === undefined || previews.length === 0
        ? [`project resources: ${trust.resources.join(", ")}`]
        : [
            "project resources:",
            ...previews.map((preview) =>
              formatWorkspaceTrustResourcePreview(preview),
            ),
          ]),
    ...(options.excluded === undefined || options.excluded.length === 0
      ? []
      : [
          `excluded from this session's trust check: ${options.excluded.join(", ")}`,
        ]),
    ...(skipped.length === 0
      ? []
      : trust.mode === "none"
        ? [`not loaded (untrusted workspace): ${skipped.join(", ")}`]
        : [`not loaded (untrusted resource kinds): ${skipped.join(", ")}`]),
  ].join("\n");
}
