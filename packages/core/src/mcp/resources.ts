import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  McpAuthRequiredError,
  type McpClient,
  McpConnectionClosedError,
  McpError as PiMcpError,
  McpTimeoutError,
  limitMcpContent,
  toLlmContent,
  type ContentBlock,
  type ListResourceTemplatesResult,
  type ListResourcesResult,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
} from "@earendil-works/pi-mcp";
import { McpAuthError, McpOAuthAuthorizationRequiredError } from "./auth.ts";
import { MCP_REQUEST_TIMEOUT_MS, McpError } from "./config-store.ts";
import {
  LIST_MCP_RESOURCES_TOOL,
  LIST_MCP_RESOURCE_TEMPLATES_TOOL,
  READ_MCP_RESOURCE_TOOL,
} from "./names.ts";

export interface McpResourceConnection {
  server: string;
  client: McpClient;
}

export function operationError(
  server: string,
  method: string,
  error: unknown,
  authHint?: string,
): McpError {
  if (error instanceof McpError) {
    return error;
  }
  if (
    error instanceof McpAuthRequiredError ||
    error instanceof McpOAuthAuthorizationRequiredError
  ) {
    return new McpError(
      "mcp.auth_required",
      authHint ??
        `MCP server ${server} requires sign-in; run codepunk mcp login ${server}`,
    );
  }
  if (error instanceof McpAuthError) {
    return new McpError(error.code, error.message);
  }
  if (error instanceof McpTimeoutError) {
    return new McpError(
      "mcp.timeout",
      `MCP server ${server} did not answer ${method}`,
    );
  }
  if (error instanceof McpConnectionClosedError) {
    return new McpError(
      "mcp.server_exited",
      `MCP server ${server} closed while handling ${method}`,
    );
  }
  if (error instanceof PiMcpError) {
    return new McpError("mcp.rpc_error", `${error.code}: ${error.message}`);
  }
  return new McpError(
    "mcp.operation_failed",
    error instanceof Error ? error.message : String(error),
  );
}

function isMcpAppResource(item: Resource | ResourceTemplate): boolean {
  const uri = "uri" in item ? item.uri : item.uriTemplate;
  return (
    uri.startsWith("ui://") ||
    /;\s*profile\s*=\s*"?mcp-app"?/iu.test(item.mimeType ?? "")
  );
}

function listedResource(
  server: string,
  item: Resource | ResourceTemplate,
): Record<string, unknown> {
  const copy = { ...item } as Record<string, unknown>;
  delete copy["_meta"];
  delete copy["icons"];
  return { server, ...copy };
}

function resourceStringArgument(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value.trim() || undefined;
}

function resourceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resourceJsonResult(
  tool: string,
  server: string | undefined,
  payload: Record<string, unknown>,
): Promise<any> {
  const limited = await limitMcpContent([
    { type: "text", text: JSON.stringify(payload) },
  ]);
  return {
    content: limited.content,
    details: { server: server ?? "", tool, mcp: true },
    structuredContent: payload as any,
  };
}

export function createResourceTools(
  connections: readonly McpResourceConnection[],
): ToolDefinition<any, any, any>[] {
  if (connections.length === 0) {
    return [];
  }

  const findServer = (name: string): McpResourceConnection => {
    const server = connections.find((candidate) => candidate.server === name);
    if (server !== undefined) {
      return server;
    }
    const available = connections
      .map((candidate) => candidate.server)
      .join(", ");
    throw new Error(
      `MCP server "${name}" has no resources${
        available.length === 0 ? "" : `. Servers with resources: ${available}`
      }`,
    );
  };

  const requestOptions = (
    connection: McpResourceConnection,
    signal: AbortSignal | undefined,
  ): { signal?: AbortSignal; timeoutMs?: number } => ({
    ...(signal === undefined ? {} : { signal }),
    timeoutMs:
      connection.client.options.requestTimeoutMs ?? MCP_REQUEST_TIMEOUT_MS,
  });

  const list = async (
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    key: "resources" | "resourceTemplates",
    page: (
      connection: McpResourceConnection,
      cursor: string | undefined,
      options: { signal?: AbortSignal; timeoutMs?: number },
    ) => Promise<{
      items: (Resource | ResourceTemplate)[];
      nextCursor?: string;
    }>,
    all: (
      connection: McpResourceConnection,
      options: { signal?: AbortSignal; timeoutMs?: number },
    ) => Promise<(Resource | ResourceTemplate)[]>,
  ): Promise<Record<string, unknown>> => {
    const serverName = resourceStringArgument(params, "server");
    const cursor = resourceStringArgument(params, "cursor");
    const visible = (item: Resource | ResourceTemplate): boolean =>
      !isMcpAppResource(item);
    if (serverName !== undefined) {
      const connection = findServer(serverName);
      const result = await page(
        connection,
        cursor,
        requestOptions(connection, signal),
      );
      return {
        server: connection.server,
        [key]: result.items
          .filter(visible)
          .map((item) => listedResource(connection.server, item)),
        ...(result.nextCursor === undefined
          ? {}
          : { nextCursor: result.nextCursor }),
      };
    }
    if (cursor !== undefined) {
      throw new Error("cursor can only be used when a server is specified");
    }
    const sorted = [...connections].sort((left, right) =>
      left.server.localeCompare(right.server),
    );
    const results = await Promise.allSettled(
      sorted.map((connection) =>
        all(connection, requestOptions(connection, signal)),
      ),
    );
    const items: Record<string, unknown>[] = [];
    const errors: { server: string; error: string }[] = [];
    results.forEach((result, index) => {
      const connection = sorted[index]!;
      if (result.status === "fulfilled") {
        items.push(
          ...result.value
            .filter(visible)
            .map((item) => listedResource(connection.server, item)),
        );
      } else {
        errors.push({
          server: connection.server,
          error: resourceErrorMessage(result.reason),
        });
      }
    });
    return {
      [key]: items,
      ...(errors.length === 0 ? {} : { errors }),
    };
  };

  const listResources: ToolDefinition<any, any, any> = {
    name: LIST_MCP_RESOURCES_TOOL,
    label: LIST_MCP_RESOURCES_TOOL,
    description:
      "Lists resources provided by MCP servers. Resources allow servers to share data that provides context to language models, such as files, database schemas, or application-specific information. Prefer resources over web search when possible.",
    parameters: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description:
            "MCP server name. Omit to list every server with resources.",
        },
        cursor: {
          type: "string",
          description:
            "Opaque cursor from a previous call with the same server; omit for the first page.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async execute(_toolCallId, params, signal) {
      const input = params as Record<string, unknown>;
      const payload = await list(
        input,
        signal,
        "resources",
        async (connection, cursor, options) => {
          const result: ListResourcesResult =
            await connection.client.listResourcesPage(cursor, options);
          return {
            items: result.resources,
            ...(result.nextCursor === undefined
              ? {}
              : { nextCursor: result.nextCursor }),
          };
        },
        (connection, options) => connection.client.listResources(options),
      );
      return resourceJsonResult(
        LIST_MCP_RESOURCES_TOOL,
        resourceStringArgument(input, "server"),
        payload,
      );
    },
  };

  const listTemplates: ToolDefinition<any, any, any> = {
    name: LIST_MCP_RESOURCE_TEMPLATES_TOOL,
    label: LIST_MCP_RESOURCE_TEMPLATES_TOOL,
    description:
      "Lists resource templates provided by MCP servers. Parameterized resource templates allow servers to share data that takes parameters and provides context to language models, such as files, database schemas, or application-specific information. Prefer resource templates over web search when possible.",
    parameters: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description:
            "MCP server name. Omit to list every server with resources.",
        },
        cursor: {
          type: "string",
          description:
            "Opaque cursor from a previous call with the same server; omit for the first page.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async execute(_toolCallId, params, signal) {
      const input = params as Record<string, unknown>;
      const payload = await list(
        input,
        signal,
        "resourceTemplates",
        async (connection, cursor, options) => {
          const result: ListResourceTemplatesResult =
            await connection.client.listResourceTemplatesPage(cursor, options);
          return {
            items: result.resourceTemplates,
            ...(result.nextCursor === undefined
              ? {}
              : { nextCursor: result.nextCursor }),
          };
        },
        (connection, options) =>
          connection.client.listResourceTemplates(options),
      );
      return resourceJsonResult(
        LIST_MCP_RESOURCE_TEMPLATES_TOOL,
        resourceStringArgument(input, "server"),
        payload,
      );
    },
  };

  const readResource: ToolDefinition<any, any, any> = {
    name: READ_MCP_RESOURCE_TOOL,
    label: READ_MCP_RESOURCE_TOOL,
    description:
      "Read a specific resource from an MCP server given the server name and resource URI.",
    parameters: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description:
            "MCP server name exactly as configured. Must match the 'server' field returned by list_mcp_resources.",
        },
        uri: {
          type: "string",
          description:
            "Resource URI to read. Must be one of the URIs returned by list_mcp_resources.",
        },
      },
      required: ["server", "uri"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async execute(_toolCallId, params, signal) {
      const input = params as Record<string, unknown>;
      const serverName = resourceStringArgument(input, "server");
      const uri = resourceStringArgument(input, "uri");
      if (serverName === undefined) {
        throw new Error("server must be provided");
      }
      if (uri === undefined) {
        throw new Error("uri must be provided");
      }
      const connection = findServer(serverName);
      let result: ReadResourceResult;
      try {
        result = await connection.client.readResource(
          uri,
          requestOptions(connection, signal),
        );
      } catch (error) {
        throw operationError(serverName, "resources/read", error);
      }
      const contents = result.contents.map(({ _meta: _ignored, ...rest }) => {
        void _ignored;
        return rest;
      });
      const blocks: ContentBlock[] = [];
      for (const content of contents) {
        if (contents.length > 1) {
          blocks.push({ type: "text", text: `${content.uri}:` });
        }
        blocks.push({ type: "resource", resource: content });
      }
      const converted = toLlmContent({ content: blocks });
      const modelContent =
        converted.length === 0
          ? [{ type: "text" as const, text: `Resource ${uri} is empty.` }]
          : converted;
      const limited = await limitMcpContent(modelContent);
      return {
        content: limited.content,
        details: {
          server: serverName,
          tool: READ_MCP_RESOURCE_TOOL,
          mcp: true,
          ...(limited.fullOutputPath === undefined
            ? {}
            : { fullOutputPath: limited.fullOutputPath }),
        },
        structuredContent: { server: serverName, uri, contents },
      };
    },
  };

  return [listResources, listTemplates, readResource];
}
