import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  normalizeNetworkAllow,
  normalizeNetworkDeny,
} from "../config/index.ts";
import { sha256Text } from "../platform/hash.ts";
import {
  assertProjectConfigSafe,
  type ProjectPaths,
} from "../platform/paths.ts";
import { isShellLauncher } from "../platform/shell.ts";
import type { SubagentToolMask } from "../workers/subagent.ts";

const MAX_AGENT_BYTES = 64 * 1024;
const MAX_AGENT_FILES = 64;
const MAX_SHELL_RULES = 32;
const MAX_SHELL_ARGV = 32;
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MODEL_REFERENCE = /^[A-Za-z0-9._@-]+\/[^\s\u0000-\u001f\u007f]+$/u;
const MODEL_REFERENCE_MAX = 300;
const FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "tools",
  "permission",
  "shell-allow",
  "network-allow",
  "network-deny",
  "model",
  "fallback",
  "thinking",
]);
const TOOL_ALIASES: Record<string, keyof SubagentToolMask> = {
  read: "read",
  search: "search",
  grep: "search",
  find: "search",
  ls: "search",
  write: "write",
  edit: "edit",
  shell: "shell",
  bash: "shell",
};

export class AgentProfileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentProfileError";
    this.code = code;
  }
}

export interface AgentProfile {
  name: string;
  description: string;
  tools: SubagentToolMask;
  /**
   * The maximum execution ceiling the profile may use. A read-only profile
   * cannot contain mutating tools; a standard profile can still be narrowed by
   * the parent session.
   */
  permission: AgentProfilePermission;
  /**
   * Exact argv rules for the shell tool. The child host turns these into
   * scoped autonomy rules with a worktree-bound cwd and executable digest.
   */
  shellAllow: string[][];
  /** Domains the profile may reach, provided the parent operator allows them. */
  networkAllow: string[];
  /** Domains the profile never reaches; added to the parent deny list. */
  networkDeny: string[];
  model: string | null;
  fallback: string[];
  thinking: string | null;
  systemPrompt: string;
  source: "user" | "project";
  path: string;
  sha256: string;
}

export type AgentProfilePermission = "read-only" | "standard";

export interface AgentProfileBundle {
  profiles: AgentProfile[];
  warnings: string[];
}

function emptyMask(): SubagentToolMask {
  return {
    read: false,
    write: false,
    edit: false,
    shell: false,
    search: false,
    memory_search: false,
  };
}

function stringList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseTools(value: unknown, shellAllowed: boolean): SubagentToolMask {
  const names = stringList(value);
  const mask = emptyMask();
  if (names.length === 0) {
    mask.read = true;
    mask.search = true;
    return mask;
  }
  for (const name of names) {
    const key = TOOL_ALIASES[name.toLowerCase()];
    if (key === undefined) {
      throw new AgentProfileError(
        "agent.unknown_tool",
        `agent profile tool ${name} is not supported`,
      );
    }
    if (key === "shell" && !shellAllowed) {
      throw new AgentProfileError(
        "agent.shell_allowlist_required",
        "agent profile shell requires an exact shell-allow argv list",
      );
    }
    mask[key] = true;
  }
  if (!mask.read && !mask.search && !mask.write && !mask.edit && !mask.shell) {
    throw new AgentProfileError(
      "agent.empty_tools",
      "agent profile tools must include at least one supported tool",
    );
  }
  return mask;
}

function parsePermission(
  value: unknown,
  mask: SubagentToolMask,
): AgentProfilePermission {
  const mutating = mask.write || mask.edit || mask.shell;
  if (value === undefined || value === null) {
    return mutating ? "standard" : "read-only";
  }
  if (value !== "read-only" && value !== "standard") {
    throw new AgentProfileError(
      "agent.permission",
      "agent profile permission must be read-only or standard",
    );
  }
  if (value === "read-only" && mutating) {
    throw new AgentProfileError(
      "agent.permission_mutation",
      "a read-only agent profile cannot enable write, edit, or shell",
    );
  }
  return value;
}

function shellArgv(value: unknown, index: number): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AgentProfileError(
      "agent.shell_allow",
      `agent profile shell-allow entry ${index + 1} must be a non-empty argv array`,
    );
  }
  if (value.length > MAX_SHELL_ARGV) {
    throw new AgentProfileError(
      "agent.shell_allow",
      `agent profile shell-allow entry ${index + 1} has more than ${MAX_SHELL_ARGV} arguments`,
    );
  }
  const argv: string[] = [];
  for (const token of value) {
    if (typeof token !== "string" || token.length === 0) {
      throw new AgentProfileError(
        "agent.shell_allow",
        `agent profile shell-allow entry ${index + 1} must contain non-empty strings`,
      );
    }
    if (/[*?[\]{}]/u.test(token)) {
      throw new AgentProfileError(
        "agent.shell_allow",
        `agent profile shell-allow entry ${index + 1} contains a glob or pattern token`,
      );
    }
    if (/[\0\n\r]/u.test(token)) {
      throw new AgentProfileError(
        "agent.shell_allow",
        `agent profile shell-allow entry ${index + 1} contains a control character`,
      );
    }
    if (/[;&|<>`]/u.test(token) || token.includes("$(")) {
      throw new AgentProfileError(
        "agent.shell_allow",
        `agent profile shell-allow entry ${index + 1} contains a shell fragment`,
      );
    }
    argv.push(token);
  }
  if (isShellLauncher(argv)) {
    throw new AgentProfileError(
      "agent.shell_allow",
      `agent profile shell-allow entry ${index + 1} cannot launch a shell or interpreter`,
    );
  }
  return argv;
}

function parseShellAllow(value: unknown): string[][] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AgentProfileError(
      "agent.shell_allow",
      "agent profile shell-allow must be an array of argv arrays",
    );
  }
  if (value.length > MAX_SHELL_RULES) {
    throw new AgentProfileError(
      "agent.shell_allow",
      `agent profile shell-allow has more than ${MAX_SHELL_RULES} rules`,
    );
  }
  const rules = value.map((entry, index) => shellArgv(entry, index));
  const seen = new Set<string>();
  for (const argv of rules) {
    const key = JSON.stringify(argv);
    if (seen.has(key)) {
      throw new AgentProfileError(
        "agent.shell_allow",
        "agent profile shell-allow contains a duplicate argv rule",
      );
    }
    seen.add(key);
  }
  return rules;
}

function parseNetwork(
  allowValue: unknown,
  denyValue: unknown,
  shell: boolean,
): { allow: string[]; deny: string[] } {
  const rawAllow = stringList(allowValue);
  const rawDeny = stringList(denyValue);
  if (!shell && (rawAllow.length > 0 || rawDeny.length > 0)) {
    throw new AgentProfileError(
      "agent.network_without_shell",
      "agent profile network lists require the shell tool",
    );
  }
  let allow: string[];
  let deny: string[];
  try {
    allow = normalizeNetworkAllow(rawAllow);
    deny = normalizeNetworkDeny(rawDeny);
  } catch (error) {
    throw new AgentProfileError(
      "agent.network",
      error instanceof Error ? error.message : String(error),
    );
  }
  const overlap = allow.filter((entry) => deny.includes(entry));
  if (overlap.length > 0) {
    throw new AgentProfileError(
      "agent.network",
      `agent profile network allow and deny overlap: ${overlap.join(", ")}`,
    );
  }
  return { allow, deny };
}

function parseModel(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length > MODEL_REFERENCE_MAX ||
    !MODEL_REFERENCE.test(value.trim())
  ) {
    throw new AgentProfileError(
      "agent.model",
      `${label} must use provider/model`,
    );
  }
  return value.trim();
}

function parseThinking(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
  ) {
    throw new AgentProfileError(
      "agent.thinking",
      "agent profile thinking must be a supported level",
    );
  }
  return value;
}

async function readProfile(
  filePath: string,
  source: "user" | "project",
): Promise<AgentProfile> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new AgentProfileError(
      "agent.file",
      `agent profile must be a regular file: ${filePath}`,
    );
  }
  if (stat.size > MAX_AGENT_BYTES) {
    throw new AgentProfileError(
      "agent.too_large",
      `agent profile exceeds ${MAX_AGENT_BYTES} bytes: ${filePath}`,
    );
  }
  const content = await fs.readFile(filePath, "utf8");
  if (content.includes("\0")) {
    throw new AgentProfileError(
      "agent.nul",
      `agent profile contains a NUL byte: ${filePath}`,
    );
  }
  const parsed = parseFrontmatter<Record<string, unknown>>(content);
  for (const key of Object.keys(parsed.frontmatter)) {
    if (!FRONTMATTER_KEYS.has(key)) {
      throw new AgentProfileError(
        "agent.unknown_key",
        `agent profile has unknown frontmatter key ${key}: ${filePath}`,
      );
    }
  }
  const rawName = parsed.frontmatter["name"];
  if (typeof rawName !== "string" || !AGENT_NAME.test(rawName)) {
    throw new AgentProfileError(
      "agent.name",
      `agent profile needs a lowercase name: ${filePath}`,
    );
  }
  const rawDescription = parsed.frontmatter["description"];
  if (
    typeof rawDescription !== "string" ||
    rawDescription.trim().length === 0
  ) {
    throw new AgentProfileError(
      "agent.description",
      `agent profile needs a description: ${filePath}`,
    );
  }
  const systemPrompt = parsed.body.trim();
  if (systemPrompt.length === 0) {
    throw new AgentProfileError(
      "agent.prompt",
      `agent profile needs a system prompt body: ${filePath}`,
    );
  }
  const model = parseModel(parsed.frontmatter["model"], "agent model");
  const fallback = stringList(parsed.frontmatter["fallback"]);
  if (fallback.length > 0 && model === null) {
    throw new AgentProfileError(
      "agent.fallback",
      "agent profile fallback requires a primary model",
    );
  }
  for (const entry of fallback) {
    if (entry.length > MODEL_REFERENCE_MAX || !MODEL_REFERENCE.test(entry)) {
      throw new AgentProfileError(
        "agent.fallback",
        "agent profile fallback entries must use provider/model",
      );
    }
  }
  if (new Set(fallback).size !== fallback.length) {
    throw new AgentProfileError(
      "agent.fallback",
      "agent profile fallback contains a duplicate model",
    );
  }
  if (model !== null && fallback.includes(model)) {
    throw new AgentProfileError(
      "agent.fallback",
      "agent profile fallback must not repeat the primary model",
    );
  }
  const shellAllow = parseShellAllow(parsed.frontmatter["shell-allow"]);
  const tools = parseTools(parsed.frontmatter["tools"], shellAllow.length > 0);
  if (tools.shell && shellAllow.length === 0) {
    throw new AgentProfileError(
      "agent.shell_allowlist_required",
      "agent profile shell requires an exact shell-allow argv list",
    );
  }
  if (!tools.shell && shellAllow.length > 0) {
    throw new AgentProfileError(
      "agent.shell_allowlist_without_shell",
      "agent profile shell-allow requires the shell tool",
    );
  }
  const permission = parsePermission(parsed.frontmatter["permission"], tools);
  const network = parseNetwork(
    parsed.frontmatter["network-allow"],
    parsed.frontmatter["network-deny"],
    tools.shell,
  );
  return {
    name: rawName,
    description: rawDescription.trim(),
    tools,
    permission,
    shellAllow,
    networkAllow: network.allow,
    networkDeny: network.deny,
    model,
    fallback,
    thinking: parseThinking(parsed.frontmatter["thinking"]),
    systemPrompt,
    source,
    path: filePath,
    sha256: sha256Text(content),
  };
}

async function loadScope(
  root: string,
  source: "user" | "project",
  warnings: string[],
): Promise<Map<string, AgentProfile>> {
  const profiles = new Map<string, AgentProfile>();
  let stat;
  try {
    stat = await fs.lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return profiles;
    }
    warnings.push(`agent profile root could not be read: ${root}`);
    return profiles;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    warnings.push(`agent profile root is not a real directory: ${root}`);
    return profiles;
  }
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    warnings.push(`agent profile root could not be read: ${root}`);
    return profiles;
  }
  const files = entries
    .filter((entry) => entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (files.length > MAX_AGENT_FILES) {
    warnings.push(
      `agent profile scope ${source} has more than ${MAX_AGENT_FILES} files; extras were ignored`,
    );
  }
  for (const entry of files.slice(0, MAX_AGENT_FILES)) {
    const filePath = path.join(root, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      warnings.push(`agent profile is not a regular file: ${filePath}`);
      continue;
    }
    try {
      const profile = await readProfile(filePath, source);
      if (profiles.has(profile.name)) {
        throw new AgentProfileError(
          "agent.duplicate",
          `duplicate ${source} agent profile ${profile.name}`,
        );
      }
      profiles.set(profile.name, profile);
    } catch (error) {
      warnings.push(
        `agent profile ignored (${path.basename(filePath)}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return profiles;
}

/**
 * Load user-scope agent profiles and, only for a trusted workspace, project
 * profiles from `.codepunk/agents`. Project profiles override a user profile
 * with the same name. Profiles are declarations for a guarded child process;
 * they never grant policy or sandbox authority by themselves.
 */
export async function loadAgentProfiles(
  paths: ProjectPaths,
  options: { projectTrusted?: boolean } = {},
): Promise<AgentProfileBundle> {
  const warnings: string[] = [];
  const merged = await loadScope(
    path.join(paths.home, "agents"),
    "user",
    warnings,
  );
  if (options.projectTrusted === true) {
    const safety = await assertProjectConfigSafe(paths);
    if (safety === null) {
      const project = await loadScope(
        path.join(paths.projectConfigDir, "agents"),
        "project",
        warnings,
      );
      for (const [name, profile] of project) {
        merged.set(name, profile);
      }
    } else {
      warnings.push(`project agent profiles were skipped: ${safety}`);
    }
  }
  return {
    profiles: [...merged.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    warnings,
  };
}

export function formatAgentProfiles(profiles: readonly AgentProfile[]): string {
  if (profiles.length === 0) {
    return "No agent profiles. Add $CODEPUNK_HOME/agents/<name>.md or a trusted project's .codepunk/agents/<name>.md.";
  }
  return profiles
    .map((profile) => {
      const tools = Object.entries(profile.tools)
        .filter(([name, enabled]) => name !== "memory_search" && enabled)
        .map(([name]) => name)
        .join(",");
      const pool = [profile.model, ...profile.fallback]
        .filter((entry): entry is string => entry !== null)
        .join(",");
      const network =
        profile.networkAllow.length === 0 && profile.networkDeny.length === 0
          ? ""
          : ` net=${profile.networkAllow.join(",") || "deny-by-default"}${
              profile.networkDeny.length === 0
                ? ""
                : ` net-deny=${profile.networkDeny.join(",")}`
            }`;
      return `${profile.name} (${profile.source}) [${profile.permission}: ${tools}]${network}${
        pool.length === 0 ? "" : ` model=${pool}`
      }\n  ${profile.description}`;
    })
    .join("\n");
}
