import { notify } from "./notify.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  readMcpConfig,
  mcpUsesAuthorizationHeader,
  removeMcpServer,
  writeMcpServer,
  type CodepunkRuntime,
  type McpReloadResult,
  type McpServerConfig,
  type McpServerInput,
} from "codepunk-core";

export function formatMcpReload(result: McpReloadResult): string {
  if (result.error !== null) {
    return [
      "MCP reload did not complete.",
      `MCP reload failed: ${result.error}`,
      "The previous MCP server processes were kept; restart codepunk if the error mentions the Pi reload.",
    ].join("\n");
  }
  const lines = ["Reloaded Pi resources and MCP configuration."];
  if (result.skipped === "disabled") {
    lines.push("MCP is disabled for this session.");
  } else if (result.skipped === "read-only") {
    lines.push(
      "MCP is not started while autonomy is read-only. Leave read-only, then run /reload.",
    );
  } else if (result.skipped === "no-model") {
    lines.push(
      "MCP is not started because no model is selected. Select one with /model, then run /reload.",
    );
  } else if (result.servers.length === 0) {
    lines.push("No user-scope MCP servers are configured.");
  } else {
    lines.push(
      `MCP servers: ${result.servers
        .map((server) => `${server} (${result.toolCounts[server] ?? 0} tools)`)
        .join(", ")}`,
    );
    if (result.resourceServers.length > 0) {
      lines.push(`Resource servers: ${result.resourceServers.join(", ")}`);
    }
  }
  for (const failure of result.failures) {
    lines.push(
      `MCP server ${failure.server} skipped: ${failure.code}: ${failure.message}`,
    );
  }
  for (const warning of result.warnings) {
    lines.push(warning);
  }
  return lines.join("\n");
}

/**
 * Parse the command line used by `/mcp add` without invoking a shell. The
 * editor form accepts quoted arguments so a command such as
 * `npx -y "@scope/server" --root "path with spaces"` maps to exact argv.
 */
export interface McpEditResult {
  message: string;
  level: "info" | "error";
}

export async function addMcpServerInteractive(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  requestedName: string | undefined,
): Promise<McpEditResult | null> {
  let name = requestedName?.trim();
  if (name === undefined || name.length === 0) {
    name = (
      await context.ui.input(
        "MCP server name",
        "lowercase name, for example github",
      )
    )?.trim();
  }
  if (name === undefined || name.length === 0) {
    return null;
  }
  const configs = await readMcpConfig(runtime.paths);
  const existing = configs.find((config) => config.name === name);
  if (existing !== undefined) {
    const replace = await context.ui.select(
      `MCP server ${name} already exists`,
      ["Replace the existing server", "Cancel"],
    );
    if (replace !== "Replace the existing server") {
      return null;
    }
  }
  const transport = await context.ui.select("MCP transport", [
    "stdio - run a local command",
    "Streamable HTTP - connect to a URL",
  ]);
  if (transport === undefined) {
    return null;
  }
  let input: McpServerInput;
  if (transport.startsWith("Streamable HTTP")) {
    const url = (
      await context.ui.input("MCP server URL", "https://example.invalid/mcp")
    )?.trim();
    if (url === undefined || url.length === 0) {
      return null;
    }
    const headers: Record<string, string> = {};
    const headerLine = (
      await context.ui.input(
        "Optional HTTP header",
        "Authorization: Bearer ${MCP_TOKEN}",
      )
    )?.trim();
    if (headerLine !== undefined && headerLine.length > 0) {
      const header = parseMcpHeader(headerLine);
      if (header === null) {
        context.ui.notify(
          "HTTP header must use the form Name: value",
          "warning",
        );
        return null;
      }
      headers[header.name] = header.value;
    }
    input = { name, url, headers };
  } else {
    const commandLine = (
      await context.ui.input(
        "Command and arguments",
        'npx -y "@modelcontextprotocol/server-filesystem" .',
      )
    )?.trim();
    if (commandLine === undefined || commandLine.length === 0) {
      return null;
    }
    const argv = splitMcpArguments(commandLine);
    if (argv.length === 0) {
      context.ui.notify("command is required", "warning");
      return null;
    }
    const cwd = (
      await context.ui.input(
        "Working directory inside the project (optional)",
        ".",
      )
    )?.trim();
    input = {
      name,
      command: argv[0]!,
      args: argv.slice(1),
      ...(cwd === undefined || cwd.length === 0 ? {} : { cwd }),
    };
  }
  const configPath = await writeMcpServer(runtime.paths, input, {
    force: existing !== undefined,
  });
  const reload = await runtime.reloadMcp();
  return {
    message: [
      `MCP server ${name} saved to ${configPath}`,
      "Environment variables and extra headers remain available through `codepunk mcp add`.",
      formatMcpReload(reload),
    ].join("\n"),
    level: reload.error === null ? "info" : "error",
  };
}

export async function removeMcpServerInteractive(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  requestedName: string | undefined,
): Promise<McpEditResult | null> {
  const configs = await readMcpConfig(runtime.paths);
  if (configs.length === 0) {
    await notify(context, "No user MCP servers configured.");
    return null;
  }
  let name = requestedName?.trim();
  if (name === undefined || name.length === 0) {
    name = await context.ui.select(
      "MCP server to remove",
      configs.map((config) => config.name),
    );
  }
  if (name === undefined || name.length === 0) {
    return null;
  }
  if (!configs.some((config) => config.name === name)) {
    context.ui.notify(`MCP server ${name} is not configured`, "warning");
    return null;
  }
  const confirmed = await context.ui.select(`Remove MCP server ${name}?`, [
    `Remove ${name}`,
    "Cancel",
  ]);
  if (confirmed !== `Remove ${name}`) {
    return null;
  }
  const configPath = await removeMcpServer(runtime.paths, name);
  const reload = await runtime.reloadMcp();
  return {
    message: [
      `MCP server ${name} removed from ${configPath}`,
      formatMcpReload(reload),
    ].join("\n"),
    level: reload.error === null ? "info" : "error",
  };
}

export function splitMcpArguments(input: string): string[] {
  const args: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (const character of input) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") {
        quote = null;
      } else {
        token += character;
        started = true;
      }
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null;
      } else if (character === "\\") {
        escaped = true;
      } else {
        token += character;
        started = true;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        args.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }
  if (quote !== null) {
    throw new Error("command line has an unterminated quote");
  }
  if (escaped) {
    token += "\\";
  }
  if (started) {
    args.push(token);
  }
  return args;
}

export function parseMcpHeader(
  input: string,
): { name: string; value: string } | null {
  if (/[\r\n]/u.test(input)) {
    return null;
  }
  const separator = input.indexOf(":");
  if (separator <= 0) {
    return null;
  }
  const name = input.slice(0, separator).trim();
  const value = input.slice(separator + 1).trim();
  if (name.length === 0) {
    return null;
  }
  return { name, value };
}

export function resolveMcpLoginTarget(
  configs: readonly McpServerConfig[],
  requested: string | undefined,
): Extract<McpServerConfig, { transport: "http" }> {
  const oauthCandidates = configs.filter(
    (config) =>
      config.transport === "http" && !mcpUsesAuthorizationHeader(config),
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
        : `mcp login requires a server name; candidates: ${oauthCandidates
            .map((config) => config.name)
            .join(", ")}`,
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
  return target;
}
