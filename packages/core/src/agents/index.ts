import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { sha256Text } from "../platform/hash.ts";
import {
  assertProjectConfigSafe,
  type ProjectPaths,
} from "../platform/paths.ts";
import type { SubagentToolMask } from "../workers/subagent.ts";

const MAX_AGENT_BYTES = 64 * 1024;
const MAX_AGENT_FILES = 64;
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MODEL_REFERENCE = /^[^/\s]+\/[^/\s]+$/u;
const FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "tools",
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
  model: string | null;
  fallback: string[];
  thinking: string | null;
  systemPrompt: string;
  source: "user" | "project";
  path: string;
  sha256: string;
}

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

function parseTools(value: unknown): SubagentToolMask {
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
    if (key === "shell") {
      throw new AgentProfileError(
        "agent.shell_unsupported",
        "agent profile shell is not supported yet; use read, search, write, or edit",
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

function parseModel(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !MODEL_REFERENCE.test(value.trim())) {
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
    if (!MODEL_REFERENCE.test(entry)) {
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
  return {
    name: rawName,
    description: rawDescription.trim(),
    tools: parseTools(parsed.frontmatter["tools"]),
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
      return `${profile.name} (${profile.source}) [${tools}]${
        pool.length === 0 ? "" : ` model=${pool}`
      }\n  ${profile.description}`;
    })
    .join("\n");
}
