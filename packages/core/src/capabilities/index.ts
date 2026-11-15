import path from "node:path";
import { redactOutputPreview } from "../artifacts/index.ts";
import { readMcpConfig } from "../mcp/index.ts";
import { McpAuthStore } from "../mcp/auth.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import { listUserPluginFiles } from "../plugin/index.ts";
import { loadSkills, type SkillSource } from "../skills/index.ts";

export interface CapabilityMcpServer {
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  env_keys: string[];
  header_keys: string[];
  auth: {
    mode: "none" | "header" | "oauth";
    signed_in: boolean;
    expires_at: string | null;
    scope: string | null;
  };
}

export interface CapabilitySnapshot {
  cwd: string;
  delivery_root: string;
  project_id: string;
  codepunk_home: string;
  mcp: {
    servers: CapabilityMcpServer[];
    error: string | null;
  };
  skills: {
    items: SkillSource[];
    warnings: string[];
  };
  plugins: {
    enabled: boolean;
    directory: string;
    files: string[];
    warnings: string[];
  };
}

export interface CapabilityCollectOptions {
  pluginEnabled?: boolean;
  skills?: readonly SkillSource[];
  pluginFiles?: readonly string[];
  projectTrusted?: boolean;
}

function displayPath(value: string, home: string): string {
  const normalizedHome = home.replace(/[/\\]+$/u, "");
  if (normalizedHome.length === 0) {
    return value;
  }
  if (value === normalizedHome) {
    return "~";
  }
  return value.startsWith(`${normalizedHome}/`) ||
    value.startsWith(`${normalizedHome}\\`)
    ? `~${value.slice(normalizedHome.length)}`
    : value;
}

function describeSkill(skill: SkillSource, home: string): SkillSource {
  return {
    ...skill,
    path: displayPath(skill.path, home),
    description:
      skill.description === null
        ? null
        : redactOutputPreview(skill.description, home),
  };
}

async function describeMcpServer(
  config: Awaited<ReturnType<typeof readMcpConfig>>[number],
  home: string,
  authStore: McpAuthStore,
): Promise<CapabilityMcpServer> {
  if (config.transport === "http") {
    const hasAuthorization = Object.keys(config.headers).some(
      (header) => header.toLowerCase() === "authorization",
    );
    const auth = hasAuthorization
      ? { signed_in: false, expires_at: null, scope: null }
      : await authStore.status(config.name, config.url);
    return {
      name: config.name,
      transport: "http",
      command: null,
      args: [],
      cwd: null,
      url: redactOutputPreview(config.url, home),
      env_keys: [],
      header_keys: Object.keys(config.headers).sort(),
      auth: {
        mode: hasAuthorization ? "header" : "oauth",
        ...auth,
      },
    };
  }
  return {
    name: config.name,
    transport: "stdio",
    command: redactOutputPreview(config.command, home),
    args: config.args.map((argument) => redactOutputPreview(argument, home)),
    cwd: displayPath(config.cwd, home),
    url: null,
    env_keys: Object.keys(config.env).sort(),
    header_keys: [],
    auth: {
      mode: "none",
      signed_in: false,
      expires_at: null,
      scope: null,
    },
  };
}

export async function collectCapabilities(
  paths: ProjectPaths,
  options: CapabilityCollectOptions = {},
): Promise<CapabilitySnapshot> {
  let mcpError: string | null = null;
  let mcpServers: CapabilityMcpServer[] = [];
  try {
    const configs = await readMcpConfig(paths);
    const authStore = new McpAuthStore(paths.home);
    mcpServers = await Promise.all(
      configs.map((config) => describeMcpServer(config, paths.home, authStore)),
    );
  } catch (error) {
    mcpError = redactOutputPreview(
      error instanceof Error ? error.message : String(error),
      paths.home,
    );
  }

  let skills = options.skills;
  let skillWarnings: string[] = [];
  if (skills === undefined) {
    const loaded = await loadSkills({
      deliveryRoot: paths.deliveryRoot,
      codepunkHome: paths.home,
      ...(options.projectTrusted === undefined
        ? {}
        : { projectTrusted: options.projectTrusted }),
    });
    skills = loaded.skills;
    skillWarnings = loaded.warnings;
  }

  let pluginFiles = options.pluginFiles;
  if (pluginFiles === undefined) {
    const directory = path.join(paths.home, "extensions");
    pluginFiles = await listUserPluginFiles(directory);
  }
  const pluginDirectory = displayPath(
    path.join(paths.home, "extensions"),
    paths.home,
  );

  return {
    cwd: displayPath(paths.cwd, paths.home),
    delivery_root: displayPath(paths.deliveryRoot, paths.home),
    project_id: paths.projectId,
    codepunk_home: displayPath(paths.home, paths.home),
    mcp: {
      servers: mcpServers,
      error: mcpError,
    },
    skills: {
      items: skills.map((skill) => describeSkill(skill, paths.home)),
      warnings: skillWarnings,
    },
    plugins: {
      enabled: options.pluginEnabled === true,
      directory: pluginDirectory,
      files: pluginFiles.map((file) => displayPath(file, paths.home)),
      warnings: [],
    },
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  if (bytes < 1_024 * 1_024) {
    return `${(bytes / 1_024).toFixed(1)} KB`;
  }
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function shortHash(hash: string): string {
  const value = hash.startsWith("sha256:") ? hash.slice(7) : hash;
  return `sha256:${value.slice(0, 12)}`;
}

export function formatCapabilities(snapshot: CapabilitySnapshot): string {
  const lines = [
    "codepunk capabilities",
    `project: ${snapshot.delivery_root}`,
    `cwd: ${snapshot.cwd}`,
    `home: ${snapshot.codepunk_home}`,
  ];
  lines.push(...formatMcpServers(snapshot.mcp));
  lines.push("", `Skills (${snapshot.skills.items.length})`);

  if (snapshot.skills.items.length === 0) {
    lines.push("  none");
  } else {
    for (const skill of snapshot.skills.items) {
      lines.push(
        `  ${skill.scope.padEnd(7)} ${skill.name}  ${formatBytes(skill.bytes)}  ${shortHash(skill.sha256)}`,
      );
      if (skill.description !== null && skill.description.length > 0) {
        lines.push(`          ${skill.description}`);
      }
      lines.push(`          ${skill.path}`);
    }
  }
  for (const warning of snapshot.skills.warnings) {
    lines.push(`  warning: ${warning}`);
  }

  const pluginCount = snapshot.plugins.files.length;
  lines.push(
    "",
    `Plugins (${snapshot.plugins.enabled ? "enabled" : "opt-in"}, ${pluginCount} file${
      pluginCount === 1 ? "" : "s"
    })`,
  );
  lines.push(`  directory: ${snapshot.plugins.directory}`);
  if (pluginCount === 0) {
    lines.push("  none");
  } else {
    for (const file of snapshot.plugins.files) {
      lines.push(`  ${file}`);
    }
    if (!snapshot.plugins.enabled) {
      lines.push(
        "  start the TUI with --allow-plugins to load them; plugin effects are uncovered",
      );
    }
  }
  for (const warning of snapshot.plugins.warnings) {
    lines.push(`  warning: ${warning}`);
  }
  return lines.join("\n");
}

export function formatMcpServers(mcp: CapabilitySnapshot["mcp"]): string[] {
  const lines = ["", "MCP servers (user scope)"];
  if (mcp.error !== null) {
    lines.push(`  error: ${mcp.error}`);
  } else if (mcp.servers.length === 0) {
    lines.push("  none");
  } else {
    for (const server of mcp.servers) {
      lines.push(`  ${server.name}`);
      lines.push(`    transport: ${server.transport}`);
      if (server.url !== null) {
        lines.push(`    url: ${server.url}`);
      }
      if (server.command !== null) {
        lines.push(`    command: ${server.command}`);
        if (server.args.length > 0) {
          lines.push(`    args: ${server.args.join(" ")}`);
        }
        lines.push(`    cwd: ${server.cwd}`);
      }
      lines.push(
        `    env: ${
          server.env_keys.length === 0 ? "none" : server.env_keys.join(", ")
        }`,
      );
      if (server.header_keys.length > 0) {
        lines.push(`    headers: ${server.header_keys.join(", ")}`);
      }
      lines.push(
        `    auth: ${server.auth.mode}${
          server.auth.mode === "oauth"
            ? server.auth.signed_in
              ? " · signed in"
              : " · sign in with codepunk mcp login " + server.name
            : ""
        }`,
      );
      if (server.auth.expires_at !== null) {
        lines.push(`    token expires: ${server.auth.expires_at}`);
      }
      if (server.auth.scope !== null) {
        lines.push(`    scope: ${server.auth.scope}`);
      }
    }
    lines.push(
      "  tool calls are approval-gated and reported as uncovered because the server process is not sandboxed",
    );
  }
  return lines;
}
