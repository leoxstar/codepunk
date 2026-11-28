import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
  createMcpToolName,
  limitMcpContent,
  normalizeMcpInputSchema,
  toLlmContent,
  type CallToolResult,
} from "@earendil-works/pi-mcp";
import { APP_NAME } from "codepunk-protocol";
import { CODEPUNK_VERSION } from "../build-meta.ts";
import { sha256Text } from "../platform/hash.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import {
  McpAuthStore,
  createServerAuthProvider,
  oauthSettings,
  type McpAuthProvider,
} from "./auth.ts";
import {
  MCP_REQUEST_TIMEOUT_MS,
  McpError,
  findProjectMcpConfigs,
  mcpUsesAuthorizationHeader,
  readMcpConfig,
  removeMcpServer,
  writeMcpServer,
  type McpHttpServerConfig,
  type McpServerConfig,
  type McpServerInput,
  type McpStdioServerConfig,
} from "./config-store.ts";
import {
  createResourceTools,
  operationError,
  type McpResourceConnection,
} from "./resources.ts";

export {
  MCP_REQUEST_TIMEOUT_MS,
  McpError,
  findProjectMcpConfigs,
  mcpUsesAuthorizationHeader,
  readMcpConfig,
  removeMcpServer,
  writeMcpServer,
  type McpHttpServerConfig,
  type McpServerConfig,
  type McpServerInput,
  type McpStdioServerConfig,
};

export interface McpServerStart {
  server: string;
  command_sha256: string;
  pid: number;
  transport: "stdio" | "http";
  coverage: "uncovered";
}

export interface McpBundle {
  servers: string[];
  toolCounts: Record<string, number>;
  tools: ToolDefinition<any, any, any>[];
  resourceServers: string[];
  resourceTools: ToolDefinition<any, any, any>[];
  failures: McpServerFailure[];
  close(): Promise<void>;
}

export function emptyMcpBundle(): McpBundle {
  return {
    servers: [],
    toolCounts: {},
    tools: [],
    resourceServers: [],
    resourceTools: [],
    failures: [],
    async close() {},
  };
}

export interface McpServerFailure {
  server: string;
  code: string;
  message: string;
}

interface McpConnection {
  client: McpClient;
  transport: StdioTransport | StreamableHttpTransport;
  authProvider?: McpAuthProvider;
}

async function closeConnection(connection: McpConnection): Promise<void> {
  await connection.client.close().catch(() => {});
  await connection.authProvider?.settled().catch(() => {});
}

function expandReferences(
  input: Record<string, string>,
  server: string,
  kind: string,
): Record<string, string> {
  const missing = new Set<string>();
  const output = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      value.replace(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu,
        (_match, name: string) => {
          const resolved = process.env[name];
          if (resolved === undefined) {
            missing.add(name);
            return "";
          }
          return resolved;
        },
      ),
    ]),
  );
  if (missing.size > 0) {
    throw new McpError(
      "mcp.missing_env",
      `MCP server ${server} requires missing environment variables for ${kind}: ${[...missing].sort().join(", ")}`,
    );
  }
  return output;
}

async function connect(
  config: McpServerConfig,
  requestTimeoutMs: number,
  home: string,
): Promise<McpConnection> {
  if (config.transport === "http") {
    const headers = expandReferences(config.headers, config.name, "header");
    const hasAuthorization = Object.keys(headers).some(
      (header) => header.toLowerCase() === "authorization",
    );
    if (hasAuthorization && config.oauth !== undefined) {
      throw new McpError(
        "mcp.invalid_config",
        `MCP server ${config.name} cannot combine an Authorization header with oauth; remove one`,
      );
    }
    const authProvider = hasAuthorization
      ? undefined
      : createServerAuthProvider({
          server: config.name,
          serverUrl: config.url,
          store: new McpAuthStore(home),
          settings: oauthSettings(config.oauth, config.name, process.env),
        });
    const authHint = hasAuthorization
      ? `MCP server ${config.name} rejected its configured Authorization header; update it in mcp.toml or remove it to use OAuth`
      : undefined;
    const transport = new StreamableHttpTransport({
      url: config.url,
      headers,
      openGetStream: false,
      ...(authProvider === undefined ? {} : { authProvider }),
    });
    const client = new McpClient({
      name: APP_NAME,
      version: CODEPUNK_VERSION,
      requestTimeoutMs,
    });
    try {
      await client.connect(transport);
      return {
        client,
        transport,
        ...(authProvider === undefined ? {} : { authProvider }),
      };
    } catch (error) {
      await client.close().catch(() => {});
      await authProvider?.settled().catch(() => {});
      throw operationError(config.name, "initialize", error, authHint);
    }
  }
  const env = expandReferences(config.env, config.name, "environment variable");
  const transport = new StdioTransport({
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    env,
  });
  const client = new McpClient({
    name: APP_NAME,
    version: CODEPUNK_VERSION,
    requestTimeoutMs,
  });
  try {
    await client.connect(transport);
    return { client, transport };
  } catch (error) {
    await client.close().catch(() => {});
    throw operationError(config.name, "initialize", error);
  }
}

function createTool(
  client: McpClient,
  server: string,
  name: string,
  tool: {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  },
): ToolDefinition<any, any, any> {
  return {
    name,
    label: name,
    description:
      tool.description === undefined
        ? `MCP tool ${tool.name} from ${server}`
        : `[MCP ${server}] ${tool.description}`,
    parameters: normalizeMcpInputSchema(
      tool.inputSchema !== null &&
        typeof tool.inputSchema === "object" &&
        !Array.isArray(tool.inputSchema)
        ? tool.inputSchema
        : {},
    ) as never,
    async execute(_toolCallId: string, params: unknown): Promise<any> {
      let result: CallToolResult;
      try {
        result = await client.callTool(
          tool.name,
          params !== null &&
            typeof params === "object" &&
            !Array.isArray(params)
            ? (params as Record<string, unknown>)
            : {},
        );
      } catch (error) {
        throw operationError(server, "tools/call", error);
      }
      const content = toLlmContent(result);
      if (content.length === 0) {
        content.push({
          type: "text",
          text: JSON.stringify(result),
        });
      }
      const limited = await limitMcpContent(content);
      const text = content
        .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
        .join("\n");
      return {
        content: limited.content,
        details: { server, tool: tool.name, mcp: true },
        structuredContent: {
          output: text,
          exit_code: result.isError === true ? 1 : 0,
          empty_result: text.length === 0,
        },
        ...(result.isError === true ? { isError: true } : {}),
      };
    },
  };
}

export async function loadMcpTools(options: {
  paths: ProjectPaths;
  projectTrusted?: boolean;
  onServerStart?: (start: McpServerStart) => Promise<void> | void;
  requestTimeoutMs?: number;
  only?: readonly string[];
  strict?: boolean;
}): Promise<McpBundle> {
  const requestTimeoutMs = Math.max(
    1,
    options.requestTimeoutMs ?? MCP_REQUEST_TIMEOUT_MS,
  );
  const configs = await readMcpConfig(options.paths, {
    projectTrusted: options.projectTrusted === true,
  });
  const requested = options.only === undefined ? null : new Set(options.only);
  const missing = [...(requested ?? [])].filter(
    (name) => !configs.some((config) => config.name === name),
  );
  if (missing.length > 0) {
    throw new McpError(
      "mcp.not_found",
      `MCP server not configured: ${missing.sort().join(", ")}`,
    );
  }
  const selected =
    requested === null
      ? configs
      : configs.filter((config) => requested.has(config.name));
  const connections: McpConnection[] = [];
  const resourceConnections: McpResourceConnection[] = [];
  const tools: ToolDefinition<any, any, any>[] = [];
  const failures: McpServerFailure[] = [];
  const takenToolNames = new Set<string>();
  const servers: string[] = [];
  const toolCounts: Record<string, number> = {};
  try {
    for (const config of selected) {
      let connection: McpConnection;
      try {
        connection = await connect(
          config,
          requestTimeoutMs,
          options.paths.home,
        );
      } catch (error) {
        if (options.strict !== false) {
          throw error;
        }
        const failure = operationError(config.name, "initialize", error);
        failures.push({
          server: config.name,
          code: failure.code,
          message: failure.message,
        });
        continue;
      }
      let descriptions;
      try {
        descriptions = await connection.client.listTools();
      } catch (error) {
        await closeConnection(connection);
        if (options.strict !== false) {
          throw operationError(config.name, "tools/list", error);
        }
        const failure = operationError(config.name, "tools/list", error);
        failures.push({
          server: config.name,
          code: failure.code,
          message: failure.message,
        });
        continue;
      }
      connections.push(connection);
      servers.push(config.name);
      if (connection.client.serverCapabilities?.resources !== undefined) {
        resourceConnections.push({
          server: config.name,
          client: connection.client,
        });
      }
      for (const description of descriptions) {
        if (
          description === null ||
          typeof description !== "object" ||
          typeof description.name !== "string" ||
          description.name.length === 0
        ) {
          continue;
        }
        const name = createMcpToolName(
          config.name,
          description.name,
          (candidate) => takenToolNames.has(candidate),
        );
        takenToolNames.add(name);
        tools.push(
          createTool(connection.client, config.name, name, description),
        );
      }
      toolCounts[config.name] = descriptions.length;
      await options.onServerStart?.({
        server: config.name,
        command_sha256: sha256Text(
          config.transport === "http"
            ? JSON.stringify(["http", config.url])
            : JSON.stringify(["stdio", config.command, ...config.args]),
        ),
        pid:
          connection.transport instanceof StdioTransport
            ? (connection.transport.pid ?? 0)
            : 0,
        transport: config.transport,
        coverage: "uncovered",
      });
    }
  } catch (error) {
    await Promise.all(connections.map(closeConnection));
    throw error;
  }
  return {
    servers,
    toolCounts,
    tools,
    resourceServers: resourceConnections.map((connection) => connection.server),
    resourceTools: createResourceTools(resourceConnections),
    failures,
    async close() {
      await Promise.all(connections.map(closeConnection));
    },
  };
}
