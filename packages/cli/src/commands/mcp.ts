import { createInterface } from "node:readline/promises";
import {
  McpAuthStore,
  collectCapabilities,
  formatMcpServers,
  loadMcpTools,
  loginMcpServer,
  mcpUsesAuthorizationHeader,
  oauthSettings,
  readMcpConfig,
  removeMcpServer,
  resolveWorkspaceTrust,
  writeMcpServer,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { resolveDaemonProject } from "../run/project.ts";
import { workspaceTrustOverride } from "../run/trust-prompt.ts";

function parseMcpEnvironment(
  values: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of values) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new Error("--env must use KEY=VALUE");
    }
    const key = entry.slice(0, separator);
    if (Object.hasOwn(env, key)) {
      throw new Error(`duplicate --env key: ${key}`);
    }
    env[key] = entry.slice(separator + 1);
  }
  return env;
}

function parseMcpHeaders(values: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of values) {
    const separator = entry.indexOf(":");
    if (separator <= 0) {
      throw new Error("--header must use Name: value");
    }
    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (name.length === 0) {
      throw new Error("--header requires a header name");
    }
    const key = name.toLowerCase();
    if (Object.hasOwn(headers, key)) {
      throw new Error(`duplicate --header name: ${name}`);
    }
    headers[name] = value;
  }
  return headers;
}

async function promptForMcpRedirectUrl(
  signal: AbortSignal,
): Promise<string | undefined> {
  if (process.stdin.isTTY !== true) {
    return undefined;
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await readline.question(
      "If the browser cannot reach this machine, paste the full redirect URL (Enter cancels): ",
      { signal },
    );
    const trimmed = answer.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  } catch {
    return undefined;
  } finally {
    readline.close();
  }
}

export async function commandMcp(options: CliOptions): Promise<number> {
  const paths = await resolveDaemonProject();
  const workspaceTrust = await resolveWorkspaceTrust({
    cwd: paths.cwd,
    root: paths.deliveryRoot,
    home: paths.home,
    ...workspaceTrustOverride(options),
  });
  const projectTrusted = workspaceTrust.grants.skills;
  const action = options.positionals[1] ?? "list";
  if (action === "list") {
    return mcpList(options, paths, projectTrusted);
  }
  if (action === "login") {
    return mcpLogin(options, paths);
  }
  if (action === "logout") {
    return mcpLogout(options, paths);
  }
  if (action === "status") {
    return mcpStatus(options, paths);
  }
  if (action === "add") {
    return mcpAdd(options, paths);
  }
  if (action === "remove") {
    return mcpRemove(options, paths);
  }
  if (action === "test") {
    return mcpTest(options, paths);
  }
  throw new Error(`unknown mcp command: ${action}`);
}

type ProjectPaths = Awaited<ReturnType<typeof resolveDaemonProject>>;

async function mcpList(
  options: CliOptions,
  paths: ProjectPaths,
  projectTrusted: boolean,
): Promise<number> {
  const snapshot = await collectCapabilities(paths, {
    skills: [],
    pluginFiles: [],
    projectTrusted,
  });
  process.stdout.write(
    options.json
      ? `${JSON.stringify(snapshot.mcp, null, 2)}\n`
      : `${formatMcpServers(snapshot.mcp).join("\n").trimStart()}\n`,
  );
  return snapshot.mcp.error === null ? 0 : 1;
}

async function mcpLogin(
  options: CliOptions,
  paths: ProjectPaths,
): Promise<number> {
  const requested = options.positionals[2];
  const configs = await readMcpConfig(paths);
  const oauthCandidates = configs.filter(
    (config) => !mcpUsesAuthorizationHeader(config),
  );
  const target =
    requested === undefined
      ? oauthCandidates.length === 1
        ? oauthCandidates[0]
        : undefined
      : configs.find((config) => config.name === requested);
  if (requested === undefined && target === undefined) {
    throw new Error(
      oauthCandidates.length === 0
        ? "mcp login requires an HTTP server without an Authorization header; none is configured"
        : `mcp login requires a server name; candidates: ${oauthCandidates.map((config) => config.name).join(", ")}`,
    );
  }
  if (target === undefined) {
    throw new Error(`MCP server ${requested} is not configured`);
  }
  if (target.transport !== "http") {
    throw new Error(
      `MCP server ${target.name} uses stdio and does not use OAuth`,
    );
  }
  if (mcpUsesAuthorizationHeader(target)) {
    throw new Error(
      `MCP server ${target.name} uses an Authorization header; remove it to use OAuth`,
    );
  }
  const store = new McpAuthStore(paths.home);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  try {
    const result = await loginMcpServer({
      server: target.name,
      serverUrl: target.url,
      store,
      settings: oauthSettings(target.oauth, target.name),
      signal: controller.signal,
      onAuthorizationUrl: (url) => {
        const output = options.json ? process.stderr : process.stdout;
        output.write(
          [
            `MCP server ${target.name} requires authorization.`,
            "Open this URL in a browser:",
            url.href,
            "",
          ].join("\n"),
        );
      },
      ...(process.stdin.isTTY === true
        ? { promptForRedirectUrl: promptForMcpRedirectUrl }
        : {}),
    });
    const status = await store.status(target.name, target.url);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            server: target.name,
            url: target.url,
            signed_in: status.signed_in,
            already_authorized: result.already_authorized,
            expires_at: status.expires_at,
            scope: status.scope,
            credentials: store.path,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(
        [
          result.already_authorized
            ? `MCP server ${target.name} already had usable credentials`
            : `signed in to MCP server ${target.name}`,
          `signed in: ${status.signed_in ? "yes" : "no"}`,
          `expires: ${status.expires_at ?? "not reported"}`,
          `scope: ${status.scope ?? "not reported"}`,
          `credentials: ${store.path}`,
        ].join("\n") + "\n",
      );
    }
    return 0;
  } catch (error) {
    if (controller.signal.aborted) {
      process.stderr.write("MCP sign-in cancelled\n");
      return 130;
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", abort);
  }
}

async function mcpLogout(
  options: CliOptions,
  paths: ProjectPaths,
): Promise<number> {
  const name = options.positionals[2];
  if (name === undefined) {
    throw new Error("usage: codepunk mcp logout <name>");
  }
  const configs = await readMcpConfig(paths);
  const target = configs.find((config) => config.name === name);
  if (target === undefined) {
    throw new Error(`MCP server ${name} is not configured`);
  }
  if (target.transport !== "http") {
    throw new Error(
      `MCP server ${name} uses stdio and has no OAuth credentials`,
    );
  }
  const removed = await new McpAuthStore(paths.home).remove(
    target.name,
    target.url,
  );
  process.stdout.write(
    options.json
      ? `${JSON.stringify({ server: name, removed })}\n`
      : `${removed ? "removed" : "no stored"} OAuth credentials for MCP server ${name}\n`,
  );
  return 0;
}

async function mcpStatus(
  options: CliOptions,
  paths: ProjectPaths,
): Promise<number> {
  const name = options.positionals[2];
  const configs = await readMcpConfig(paths);
  const selected =
    name === undefined
      ? configs
      : configs.filter((config) => config.name === name);
  if (name !== undefined && selected.length === 0) {
    throw new Error(`MCP server ${name} is not configured`);
  }
  const store = new McpAuthStore(paths.home);
  const rows = await Promise.all(
    selected.map(async (config) => {
      if (config.transport !== "http") {
        return {
          server: config.name,
          transport: "stdio",
          auth: "none",
          signed_in: false,
          expires_at: null,
          scope: null,
        };
      }
      const status = mcpUsesAuthorizationHeader(config)
        ? { signed_in: false, expires_at: null, scope: null }
        : await store.status(config.name, config.url);
      return {
        server: config.name,
        transport: "http",
        auth: mcpUsesAuthorizationHeader(config) ? "header" : "oauth",
        ...status,
      };
    }),
  );
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ servers: rows, credentials: store.path }, null, 2)}\n`,
    );
  } else if (rows.length === 0) {
    process.stdout.write("No MCP servers configured.\n");
  } else {
    const lines = ["MCP authentication status:"];
    for (const row of rows) {
      lines.push(
        `  ${row.server}: ${row.auth}${
          row.auth === "oauth"
            ? row.signed_in
              ? " · signed in"
              : " · not signed in"
            : ""
        }`,
      );
      if (row.expires_at !== null) {
        lines.push(`    expires: ${row.expires_at}`);
      }
      if (row.scope !== null) {
        lines.push(`    scope: ${row.scope}`);
      }
    }
    lines.push(`credentials: ${store.path}`);
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  return 0;
}

async function mcpAdd(
  options: CliOptions,
  paths: ProjectPaths,
): Promise<number> {
  const name = options.positionals[2];
  const command = options.positionals[3];
  if (name === undefined) {
    throw new Error(
      "usage: codepunk mcp add <name> [options] -- <command> [args...], or codepunk mcp add <name> --url <url>",
    );
  }
  if (options.url !== undefined) {
    if (
      command !== undefined ||
      options.env.length > 0 ||
      options.cwd !== undefined
    ) {
      throw new Error(
        "--url cannot be combined with a command, --env, or --cwd",
      );
    }
    const configPath = await writeMcpServer(
      paths,
      {
        name,
        url: options.url,
        headers: parseMcpHeaders(options.headers),
      },
      { force: options.force },
    );
    process.stdout.write(
      `added HTTP MCP server ${name}\nconfig: ${configPath}\ncheck: codepunk mcp test ${name}\n`,
    );
    return 0;
  }
  if (command === undefined) {
    throw new Error(
      "usage: codepunk mcp add <name> [options] -- <command> [args...], or codepunk mcp add <name> --url <url>",
    );
  }
  if (options.headers.length > 0) {
    throw new Error("--header is only valid with --url");
  }
  const configPath = await writeMcpServer(
    paths,
    {
      name,
      command,
      args: options.positionals.slice(4),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: parseMcpEnvironment(options.env),
    },
    { force: options.force },
  );
  process.stdout.write(
    `added MCP server ${name}\nconfig: ${configPath}\ncheck: codepunk mcp test ${name}\n`,
  );
  return 0;
}

async function mcpRemove(
  options: CliOptions,
  paths: ProjectPaths,
): Promise<number> {
  const name = options.positionals[2];
  if (name === undefined) {
    throw new Error("usage: codepunk mcp remove <name>");
  }
  const configPath = await removeMcpServer(paths, name);
  process.stdout.write(`removed MCP server ${name}\nconfig: ${configPath}\n`);
  return 0;
}

async function mcpTest(
  options: CliOptions,
  paths: ProjectPaths,
): Promise<number> {
  const name = options.positionals[2];
  const bundle = await loadMcpTools({
    paths,
    strict: false,
    ...(name === undefined ? {} : { only: [name] }),
  });
  try {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            servers: bundle.servers,
            tool_counts: bundle.toolCounts,
            tools: bundle.tools.map((tool) => tool.name),
            resource_servers: bundle.resourceServers,
            resource_tools: bundle.resourceTools.map((tool) => tool.name),
            failures: bundle.failures,
          },
          null,
          2,
        )}\n`,
      );
    } else if (bundle.servers.length === 0 && bundle.failures.length === 0) {
      process.stdout.write("No MCP servers configured.\n");
    } else {
      const lines = ["MCP connection check:"];
      for (const server of bundle.servers) {
        const count = bundle.toolCounts[server] ?? 0;
        const resources = bundle.resourceServers.includes(server)
          ? ", resources available"
          : "";
        lines.push(
          `  ${server}: ok, ${count} tool${count === 1 ? "" : "s"}${resources}`,
        );
      }
      for (const failure of bundle.failures) {
        lines.push(`  ${failure.server}: failed, ${failure.message}`);
      }
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    if (bundle.failures.length > 0) {
      process.stderr.write(
        `${bundle.failures.map((failure) => failure.message).join("\n")}\n`,
      );
      process.exitCode = 1;
    }
  } finally {
    await bundle.close();
  }
  return bundle.failures.length > 0 ? 1 : 0;
}
