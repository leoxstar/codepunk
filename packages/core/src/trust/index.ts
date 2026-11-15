import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import {
  ProjectTrustStore,
  type ProjectTrustStoreEntry,
} from "@earendil-works/pi-coding-agent";
import {
  isInsidePath,
  normalizeAbsolute,
  resolveRealPath,
} from "../platform/path.ts";
import { discoverProjectInstructionFiles } from "../platform/context-files.ts";
import { sha256Value } from "../platform/hash.ts";

export type WorkspaceTrustSource =
  "flag" | "saved" | "prompt" | "default" | "no-resources";

export interface WorkspaceTrust {
  trusted: boolean;
  source: WorkspaceTrustSource;
  cwd: string;
  root: string;
  resources: string[];
  storePath: string;
  savedPath: string | null;
}

export type WorkspaceTrustResourceKind =
  "config" | "policy" | "skills" | "instructions";

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
  "local.toml",
  "policy.toml",
] as const;

const TRUST_REQUIRING_DIRECTORIES = ["skills"] as const;
const PREVIEW_MAX_ENTRIES = 512;
const PREVIEW_MAX_BYTES = 1024 * 1024;
const NOFOLLOW = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;

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

function resourceKind(resource: string): WorkspaceTrustResourceKind {
  if (resource.endsWith("/config.toml") || resource.endsWith("/local.toml")) {
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
        kind: resourceKind(resource),
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
      kind: resourceKind(resource),
      ...entry,
    });
  }
  return previews;
}

export function formatWorkspaceTrustResourcePreview(
  preview: WorkspaceTrustResourcePreview,
): string {
  const facts = [
    preview.type,
    preview.bytes === null ? null : `${preview.bytes} B`,
    preview.sha256,
    preview.truncated ? "truncated" : null,
    preview.reason ?? null,
  ].filter((fact): fact is string => fact !== null);
  return `  [${preview.kind}] ${preview.path} (${facts.join(", ")})`;
}

export function workspaceTrustStorePath(home: string): string {
  return path.join(normalizeAbsolute(home), "trust.json");
}

export function readSavedWorkspaceTrust(
  home: string,
  root: string,
): ProjectTrustStoreEntry | null {
  const entry = new ProjectTrustStore(normalizeAbsolute(home)).getEntry(root);
  if (entry === null) {
    return null;
  }
  // Pi's store returns the closest saved ancestor. A decision for a parent
  // repository must not silently trust a nested repository that can carry its
  // own .codepunk configuration.
  const requested = normalizeAbsolute(resolveRealPath(root));
  const saved = normalizeAbsolute(resolveRealPath(entry.path));
  return requested === saved ? entry : null;
}

export async function saveWorkspaceTrust(
  home: string,
  cwd: string,
  decision: boolean,
): Promise<string> {
  const store = new ProjectTrustStore(normalizeAbsolute(home));
  store.set(cwd, decision);
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
  override?: boolean | null;
  source?: WorkspaceTrustSource;
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
  if (input.override === true || input.override === false) {
    return {
      trusted: input.override,
      source: input.source ?? "flag",
      cwd,
      root,
      resources,
      storePath,
      savedPath: saved?.path ?? null,
    };
  }
  if (saved !== null) {
    return {
      trusted: saved.decision,
      source: "saved",
      cwd,
      root,
      resources,
      storePath,
      savedPath: saved.path,
    };
  }
  if (resources.length === 0) {
    return {
      trusted: true,
      source: "no-resources",
      cwd,
      root,
      resources,
      storePath,
      savedPath: null,
    };
  }
  return {
    trusted: false,
    source: "default",
    cwd,
    root,
    resources,
    storePath,
    savedPath: null,
  };
}

export function skippedProjectResources(trust: WorkspaceTrust): string[] {
  if (trust.trusted) {
    return [];
  }
  const skipped: string[] = [];
  for (const resource of trust.resources) {
    if (resource.endsWith("/config.toml") || resource.endsWith("/local.toml")) {
      skipped.push("project-config");
    } else if (resource.endsWith("/policy.toml")) {
      skipped.push("project-policy");
    } else if (resource.endsWith("/skills")) {
      skipped.push("project-skills");
    } else if (!resource.startsWith(".codepunk/")) {
      skipped.push("project-instructions");
    }
  }
  return [...new Set(skipped)];
}

export function formatWorkspaceTrust(
  trust: WorkspaceTrust,
  previews?: readonly WorkspaceTrustResourcePreview[],
  options: { excluded?: readonly string[] } = {},
): string {
  const skipped = skippedProjectResources(trust);
  return [
    `trust: ${trust.trusted ? "trusted" : "untrusted"} (${trust.source})`,
    `root: ${trust.root}`,
    `store: ${trust.storePath}`,
    ...(trust.savedPath === null ? [] : [`saved for: ${trust.savedPath}`]),
    ...(trust.resources.length === 0
      ? ["project resources: none"]
      : previews === undefined || previews.length === 0
        ? [`project resources: ${trust.resources.join(", ")}`]
        : [
            "project resources:",
            ...previews.map(formatWorkspaceTrustResourcePreview),
          ]),
    ...(options.excluded === undefined || options.excluded.length === 0
      ? []
      : [
          `excluded from this session's trust check: ${options.excluded.join(", ")}`,
        ]),
    ...(trust.trusted || skipped.length === 0
      ? []
      : [`not loaded (untrusted workspace): ${skipped.join(", ")}`]),
  ].join("\n");
}
