import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  McpClient,
  McpAuthRequiredError,
  McpConnectionClosedError,
  McpError as PiMcpError,
  McpTimeoutError,
  StdioTransport,
  StreamableHttpTransport,
  createMcpToolName,
  limitMcpContent,
  normalizeMcpInputSchema,
  toLlmContent,
  validateMcpServerConfig,
  type CallToolResult,
} from "@earendil-works/pi-mcp";
import { parseToml, TomlError, type TomlTable } from "../config/toml.ts";
import { atomicWriteFile } from "../platform/fs.ts";
import { sha256Text } from "../platform/hash.ts";
import { isInsidePath, normalizeAbsolute } from "../platform/path.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import {
  McpAuthError,
  McpAuthStore,
  McpOAuthAuthorizationRequiredError,
  createServerAuthProvider,
  oauthSettings,
  type McpAuthProvider,
  type McpOAuthConfig,
} from "./auth.ts";

export class McpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

export interface McpStdioServerConfig {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface McpHttpServerConfig {
  name: string;
  transport: "http";
  url: string;
  headers: Record<string, string>;
  oauth?: McpOAuthConfig;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

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
  failures: McpServerFailure[];
  close(): Promise<void>;
}

export function emptyMcpBundle(): McpBundle {
  return {
    servers: [],
    toolCounts: {},
    tools: [],
    failures: [],
    async close() {},
  };
}

export interface McpServerFailure {
  server: string;
  code: string;
  message: string;
}

export interface McpServerInput {
  name: string;
  command?: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

const SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
export const MCP_REQUEST_TIMEOUT_MS = 15_000;

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new McpError(
      "mcp.invalid_config",
      `${field} must be an array of strings`,
    );
  }
  return [...value];
}

function envTable(value: unknown, field: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new McpError("mcp.invalid_config", `${field} must be a table`);
  }
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new McpError(
        "mcp.invalid_config",
        `${field}.${key} must be a string`,
      );
    }
    output[key] = entry;
  }
  return output;
}

function stringRecord(
  value: unknown,
  field: string,
  options: {
    name: RegExp;
    rejectCrLf: boolean;
  },
): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new McpError("mcp.invalid_config", `${field} must be a table`);
  }
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new McpError(
        "mcp.invalid_config",
        `${field}.${key} must be a string`,
      );
    }
    if (entry.includes("\u0000")) {
      throw new McpError(
        "mcp.invalid_config",
        `${field}.${key} cannot contain NUL bytes`,
      );
    }
    if (options.rejectCrLf && /[\r\n]/u.test(entry)) {
      throw new McpError(
        "mcp.invalid_config",
        `${field}.${key} cannot contain CR or LF`,
      );
    }
    output[key] = entry;
  }
  for (const key of Object.keys(output)) {
    if (!options.name.test(key)) {
      throw new McpError(
        "mcp.invalid_config",
        `${field}.${key} is not a valid name`,
      );
    }
  }
  return output;
}

function parseServers(root: TomlTable, paths: ProjectPaths): McpServerConfig[] {
  const servers = root["servers"];
  if (servers === undefined) {
    return [];
  }
  if (
    servers === null ||
    typeof servers !== "object" ||
    Array.isArray(servers)
  ) {
    throw new McpError("mcp.invalid_config", "servers must be a table");
  }
  const output: McpServerConfig[] = [];
  for (const [name, value] of Object.entries(servers)) {
    if (!SERVER_NAME.test(name)) {
      throw new McpError(
        "mcp.invalid_config",
        `server name ${name} must match ${SERVER_NAME.source}`,
      );
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new McpError(
        "mcp.invalid_config",
        `servers.${name} must be a table`,
      );
    }
    const table = value as TomlTable;
    const validated = validateMcpServerConfig(name, table);
    if (validated.kind === "invalid") {
      throw new McpError(
        "mcp.invalid_config",
        `servers.${name}: ${validated.error}`,
      );
    }
    if (validated.kind === "http") {
      if (table["cwd"] !== undefined) {
        throw new McpError(
          "mcp.invalid_config",
          `servers.${name}.cwd is only valid for stdio servers`,
        );
      }
      const url = validated.config.url;
      const headers = stringRecord(
        table["headers"],
        `servers.${name}.headers`,
        { name: HEADER_NAME, rejectCrLf: true },
      );
      const oauth = parseOAuthConfig(validated.config.oauth, name);
      if (
        oauth !== undefined &&
        Object.keys(headers).some(
          (header) => header.toLowerCase() === "authorization",
        )
      ) {
        throw new McpError(
          "mcp.invalid_config",
          `servers.${name} cannot combine an Authorization header with oauth; remove one`,
        );
      }
      output.push({
        name,
        transport: "http",
        url,
        headers,
        ...(oauth === undefined ? {} : { oauth }),
      });
      continue;
    }
    const command = validated.config.command;
    if (command.trim().length === 0) {
      throw new McpError(
        "mcp.invalid_config",
        `servers.${name}.command cannot be empty`,
      );
    }
    const args = stringArray(table["args"], `servers.${name}.args`);
    const env = envTable(table["env"], `servers.${name}.env`);
    const requestedCwd =
      typeof table["cwd"] === "string"
        ? normalizeAbsolute(
            path.isAbsolute(table["cwd"])
              ? table["cwd"]
              : path.resolve(paths.deliveryRoot, table["cwd"]),
          )
        : paths.deliveryRoot;
    if (!isInsidePath(paths.deliveryRoot, requestedCwd)) {
      throw new McpError(
        "mcp.invalid_config",
        `servers.${name}.cwd must stay inside the delivery root`,
      );
    }
    output.push({
      name,
      transport: "stdio",
      command,
      args,
      cwd: requestedCwd,
      env,
    });
  }
  return output.sort((left, right) => left.name.localeCompare(right.name));
}

const OAUTH_FIELDS = new Set([
  "clientId",
  "clientSecret",
  "callbackPort",
  "callbackUrl",
  "scope",
  "clientName",
  "clientRegistration",
  "authServerMetadataUrl",
]);

function oauthString(
  value: unknown,
  field: string,
  allowEmpty = true,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new McpError(
      "mcp.invalid_config",
      `${field} must be a ${allowEmpty ? "" : "non-empty "}string`,
    );
  }
  if (value.includes("\u0000") || /[\r\n]/u.test(value)) {
    throw new McpError(
      "mcp.invalid_config",
      `${field} cannot contain NUL, CR, or LF`,
    );
  }
  return value;
}

/**
 * Parse the OAuth block after Pi's shared config validator has checked its
 * field types and loopback URL rules. Codepunk deliberately does not accept
 * `cimd`: it has no public Client ID Metadata Document, so a `cimd` setting
 * could never complete. `auto` already falls back to dynamic registration
 * when no document exists.
 */
function parseOAuthConfig(
  value: unknown,
  server: string,
): McpOAuthConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new McpError(
      "mcp.invalid_config",
      `servers.${server}.oauth must be a table`,
    );
  }
  const table = value as Record<string, unknown>;
  for (const key of Object.keys(table)) {
    if (!OAUTH_FIELDS.has(key)) {
      throw new McpError(
        "mcp.invalid_config",
        `servers.${server}.oauth.${key} is not supported`,
      );
    }
  }
  const clientId = oauthString(
    table["clientId"],
    `servers.${server}.oauth.clientId`,
    false,
  );
  const clientSecret = oauthString(
    table["clientSecret"],
    `servers.${server}.oauth.clientSecret`,
  );
  const callbackUrl = oauthString(
    table["callbackUrl"],
    `servers.${server}.oauth.callbackUrl`,
    false,
  );
  const scope = oauthString(table["scope"], `servers.${server}.oauth.scope`);
  const clientName = oauthString(
    table["clientName"],
    `servers.${server}.oauth.clientName`,
    false,
  );
  const authServerMetadataUrl = oauthString(
    table["authServerMetadataUrl"],
    `servers.${server}.oauth.authServerMetadataUrl`,
    false,
  );
  const callbackPort = table["callbackPort"];
  if (
    callbackPort !== undefined &&
    (typeof callbackPort !== "number" ||
      !Number.isInteger(callbackPort) ||
      callbackPort < 1 ||
      callbackPort > 65_535)
  ) {
    throw new McpError(
      "mcp.invalid_config",
      `servers.${server}.oauth.callbackPort must be an integer from 1 to 65535`,
    );
  }
  const registration = table["clientRegistration"];
  if (
    registration !== undefined &&
    registration !== "auto" &&
    registration !== "dcr" &&
    registration !== "cimd"
  ) {
    throw new McpError(
      "mcp.invalid_config",
      `servers.${server}.oauth.clientRegistration must be auto or dcr`,
    );
  }
  if (registration === "cimd") {
    throw new McpError(
      "mcp.oauth_unsupported",
      `servers.${server}.oauth.clientRegistration "cimd" is not available because Codepunk publishes no Client ID Metadata Document; use auto or dcr`,
    );
  }
  return {
    ...(clientId === undefined ? {} : { clientId }),
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(callbackPort === undefined ? {} : { callbackPort }),
    ...(callbackUrl === undefined ? {} : { callbackUrl }),
    ...(scope === undefined ? {} : { scope }),
    ...(clientName === undefined ? {} : { clientName }),
    ...(registration === undefined
      ? {}
      : { clientRegistration: registration as "auto" | "dcr" }),
    ...(authServerMetadataUrl === undefined ? {} : { authServerMetadataUrl }),
  };
}

async function assertMcpConfigScope(paths: ProjectPaths): Promise<void> {
  const piConfig = path.join(paths.home, "mcp.json");
  if (await exists(piConfig)) {
    throw new McpError(
      "mcp.pi_config_forbidden",
      "~/.codepunk/mcp.json is not supported; use ~/.codepunk/mcp.toml",
    );
  }
}

const PROJECT_MCP_CONFIG_FILES = ["mcp.toml", "mcp.json"] as const;

/**
 * Project-scope MCP files are intentionally inert. MCP servers execute
 * outside the shell sandbox, so Codepunk only loads user-scope configuration;
 * a trusted workspace must not turn a repository file into a startup failure
 * after the user has already granted trust.
 */
export async function findProjectMcpConfigs(
  paths: ProjectPaths,
): Promise<string[]> {
  const found: string[] = [];
  for (const name of PROJECT_MCP_CONFIG_FILES) {
    const candidate = path.join(paths.projectConfigDir, name);
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isFile() || stat.isSymbolicLink()) {
        found.push(candidate);
      }
    } catch {
      // Missing files are the normal case.
    }
  }
  return found;
}

interface McpConfigDocument {
  path: string;
  exists: boolean;
  content: string;
  servers: McpServerConfig[];
}

async function readMcpConfigDocument(
  paths: ProjectPaths,
): Promise<McpConfigDocument> {
  await assertMcpConfigScope(paths);
  const configPath = path.join(paths.home, "mcp.toml");
  let content: string;
  try {
    content = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path: configPath,
        exists: false,
        content: "",
        servers: [],
      };
    }
    throw new McpError(
      "mcp.config_unreadable",
      "cannot read ~/.codepunk/mcp.toml",
    );
  }
  let parsed: TomlTable;
  try {
    parsed = parseToml(content);
  } catch (error) {
    throw new McpError(
      "mcp.invalid_config",
      error instanceof TomlError ? error.message : String(error),
    );
  }
  return {
    path: configPath,
    exists: true,
    content,
    servers: parseServers(parsed, paths),
  };
}

export async function readMcpConfig(
  paths: ProjectPaths,
): Promise<McpServerConfig[]> {
  return (await readMcpConfigDocument(paths)).servers;
}

interface NormalizedMcpStdioServerInput {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  cwd: string;
  cwdRaw: string | null;
  env: Record<string, string>;
}

interface NormalizedMcpHttpServerInput {
  name: string;
  transport: "http";
  url: string;
  headers: Record<string, string>;
}

type NormalizedMcpServerInput =
  NormalizedMcpStdioServerInput | NormalizedMcpHttpServerInput;

function normalizeMcpServerInput(
  paths: ProjectPaths,
  input: McpServerInput,
): NormalizedMcpServerInput {
  if (!SERVER_NAME.test(input.name)) {
    throw new McpError(
      "mcp.invalid_name",
      `server name must match ${SERVER_NAME.source}`,
    );
  }
  const hasCommand = input.command !== undefined;
  const hasUrl = input.url !== undefined;
  if (hasCommand === hasUrl) {
    throw new McpError(
      "mcp.invalid_transport",
      "configure exactly one of command (stdio) or url (Streamable HTTP)",
    );
  }
  if (input.url !== undefined) {
    if (
      input.command !== undefined ||
      input.cwd !== undefined ||
      input.env !== undefined
    ) {
      throw new McpError(
        "mcp.invalid_transport",
        "HTTP MCP servers do not accept command, cwd, or env; use headers",
      );
    }
    const validated = validateMcpServerConfig(input.name, {
      type: "http",
      url: input.url,
      headers: input.headers ?? {},
    });
    if (validated.kind === "invalid") {
      throw new McpError("mcp.invalid_url", validated.error);
    }
    const headers = stringRecord(input.headers, "headers", {
      name: HEADER_NAME,
      rejectCrLf: true,
    });
    return {
      name: input.name,
      transport: "http",
      url: input.url,
      headers,
    };
  }
  const command = input.command!;
  if (command.trim().length === 0 || command.includes("\u0000")) {
    throw new McpError("mcp.invalid_command", "command is required");
  }
  const args = [...(input.args ?? [])];
  if (args.some((argument) => argument.includes("\u0000"))) {
    throw new McpError("mcp.invalid_args", "args cannot contain NUL bytes");
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!ENV_NAME.test(key)) {
      throw new McpError(
        "mcp.invalid_env",
        `environment variable ${key} is not a valid name`,
      );
    }
    if (value.includes("\u0000")) {
      throw new McpError(
        "mcp.invalid_env",
        `environment variable ${key} cannot contain NUL bytes`,
      );
    }
    env[key] = value;
  }
  const cwdRaw = input.cwd?.trim() ?? null;
  const requestedCwd =
    cwdRaw === null
      ? paths.deliveryRoot
      : path.resolve(paths.deliveryRoot, cwdRaw);
  if (!isInsidePath(paths.deliveryRoot, requestedCwd)) {
    throw new McpError(
      "mcp.invalid_cwd",
      "cwd must stay inside the delivery root",
    );
  }
  return {
    name: input.name,
    transport: "stdio",
    command,
    args,
    cwd: normalizeAbsolute(requestedCwd),
    cwdRaw,
    env,
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function serializeMcpServer(input: NormalizedMcpServerInput): string {
  if (input.transport === "http") {
    const lines = [`[servers.${input.name}]`, `url = ${tomlString(input.url)}`];
    const headerEntries = Object.entries(input.headers).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    if (headerEntries.length > 0) {
      lines.push("", `[servers.${input.name}.headers]`);
      for (const [key, value] of headerEntries) {
        lines.push(`${key} = ${tomlString(value)}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }
  const lines = [
    `[servers.${input.name}]`,
    `command = ${tomlString(input.command)}`,
  ];
  if (input.args.length > 0) {
    lines.push(
      `args = [${input.args.map((argument) => tomlString(argument)).join(", ")}]`,
    );
  }
  if (input.cwdRaw !== null) {
    lines.push(`cwd = ${tomlString(input.cwdRaw)}`);
  }
  const envEntries = Object.entries(input.env).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (envEntries.length > 0) {
    lines.push("", `[servers.${input.name}.env]`);
    for (const [key, value] of envEntries) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function serverNameFromHeader(line: string): string | null {
  const match =
    /^\s*\[servers\.(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))(?:\.[^\]]*)?\]/u.exec(
      line,
    );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function removeMcpServerBlocks(content: string, name: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of content.split(/\r?\n/u)) {
    const header = line.trimStart().startsWith("[");
    if (header) {
      skipping = serverNameFromHeader(line) === name;
      if (skipping) {
        continue;
      }
    } else if (skipping) {
      continue;
    }
    kept.push(line);
  }
  const output = kept
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trimEnd();
  return output.length === 0 ? "" : `${output}\n`;
}

function validateWrittenConfig(
  paths: ProjectPaths,
  content: string,
): McpServerConfig[] {
  if (content.trim().length === 0) {
    return [];
  }
  let parsed: TomlTable;
  try {
    parsed = parseToml(content);
  } catch (error) {
    throw new McpError(
      "mcp.invalid_config",
      error instanceof TomlError ? error.message : String(error),
    );
  }
  return parseServers(parsed, paths);
}

export async function writeMcpServer(
  paths: ProjectPaths,
  input: McpServerInput,
  options: { force?: boolean } = {},
): Promise<string> {
  const normalized = normalizeMcpServerInput(paths, input);
  const document = await readMcpConfigDocument(paths);
  const existing = document.servers.find(
    (server) => server.name === normalized.name,
  );
  if (existing !== undefined && options.force !== true) {
    throw new McpError(
      "mcp.already_exists",
      `MCP server ${normalized.name} already exists; pass --force to replace it`,
    );
  }
  const prefix = removeMcpServerBlocks(document.content, normalized.name);
  const block = serializeMcpServer(normalized);
  const content = `${prefix}${prefix.length === 0 ? "" : "\n"}${block}`;
  validateWrittenConfig(paths, content);
  await atomicWriteFile(document.path, content, 0o600);
  return document.path;
}

export async function removeMcpServer(
  paths: ProjectPaths,
  name: string,
): Promise<string> {
  if (!SERVER_NAME.test(name)) {
    throw new McpError(
      "mcp.invalid_name",
      `server name must match ${SERVER_NAME.source}`,
    );
  }
  const document = await readMcpConfigDocument(paths);
  if (!document.servers.some((server) => server.name === name)) {
    throw new McpError("mcp.not_found", `MCP server ${name} is not configured`);
  }
  const content = removeMcpServerBlocks(document.content, name);
  validateWrittenConfig(paths, content);
  await atomicWriteFile(document.path, content, 0o600);
  return document.path;
}

interface McpConnection {
  client: McpClient;
  transport: StdioTransport | StreamableHttpTransport;
  authProvider?: McpAuthProvider;
}

async function closeConnection(connection: McpConnection): Promise<void> {
  await connection.client.close().catch(() => {});
  // A refresh can rotate the refresh token after the transport has closed.
  // Pi owns the refresh promise; wait for it before dropping the provider so
  // the rotated token is persisted instead of leaving the old grant on disk.
  await connection.authProvider?.settled().catch(() => {});
}

function operationError(
  server: string,
  method: string,
  error: unknown,
): McpError {
  // connect() already maps transport failures. Do not turn a specific
  // mcp.auth_required or mcp.timeout code into a generic startup failure when
  // the tolerant loader sees the converted error.
  if (error instanceof McpError) {
    return error;
  }
  if (
    error instanceof McpAuthRequiredError ||
    error instanceof McpOAuthAuthorizationRequiredError
  ) {
    return new McpError(
      "mcp.auth_required",
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
    const transport = new StreamableHttpTransport({
      url: config.url,
      headers,
      openGetStream: false,
      ...(authProvider === undefined ? {} : { authProvider }),
    });
    const client = new McpClient({
      name: "codepunk",
      version: "0.0.0",
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
      throw operationError(config.name, "initialize", error);
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
    name: "codepunk",
    version: "0.0.0",
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
      // Pi owns the model-facing MCP output limit. Applying it here keeps a
      // single large tool result from consuming the whole context before the
      // product wrapper gets a chance to persist it as an artifact.
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
  onServerStart?: (start: McpServerStart) => Promise<void> | void;
  requestTimeoutMs?: number;
  only?: readonly string[];
  /**
   * Strict mode preserves the library behavior: one failed server rejects the
   * whole bundle. Product startup uses tolerant mode so one broken MCP server
   * cannot prevent an otherwise usable coding session.
   */
  strict?: boolean;
}): Promise<McpBundle> {
  const requestTimeoutMs = Math.max(
    1,
    options.requestTimeoutMs ?? MCP_REQUEST_TIMEOUT_MS,
  );
  const configs = await readMcpConfig(options.paths);
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
    failures,
    async close() {
      await Promise.all(connections.map(closeConnection));
    },
  };
}
