import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  McpOAuthAuthorizationRequiredError,
  McpRefreshLockBusyError,
  completeMcpSignIn,
  listenForLoopbackSignIn,
  startMcpSignIn,
  waitForLoopbackSignIn,
  type McpOAuthServerStore,
  type McpOAuthSettings,
  type McpOAuthState,
  type McpAuthProvider,
  createMcpAuthProvider,
} from "@earendil-works/pi-mcp/oauth";
import { atomicWriteFile, ensurePrivateDir } from "../platform/fs.ts";
import { normalizeAbsolute } from "../platform/path.ts";

export type { McpAuthProvider } from "@earendil-works/pi-mcp/oauth";

const AUTH_VERSION = 1;
const LOCK_WAIT_MS = 25_000;
// A waiter must never be able to declare the holder stale before its own
// deadline: otherwise a refresh longer than this value is stolen while the
// original process is still rotating the token, and two writers race on a
// one-time refresh token. Keep stale strictly greater than wait.
const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 100;

/**
 * Exported so the wait/stale ordering is a testable invariant rather than a
 * comment. A refresh lock may only be stolen after every waiter has already
 * given up.
 */
export const MCP_REFRESH_LOCK_POLICY = {
  waitMs: LOCK_WAIT_MS,
  staleMs: LOCK_STALE_MS,
} as const;

export class McpAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "McpAuthError";
    this.code = code;
  }
}

export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  callbackUrl?: string;
  scope?: string;
  clientName?: string;
  clientRegistration?: "auto" | "dcr";
  authServerMetadataUrl?: string;
}

interface AuthDocument {
  version: typeof AUTH_VERSION;
  servers: Record<string, McpOAuthState>;
}

interface AuthStatus {
  signed_in: boolean;
  expires_at: string | null;
  scope: string | null;
}

function emptyDocument(): AuthDocument {
  return { version: AUTH_VERSION, servers: {} };
}

function canonicalServerUrl(serverUrl: string): string {
  return new URL(serverUrl).href;
}

function storeKey(server: string, serverUrl: string): string {
  return `${server}|${canonicalServerUrl(serverUrl)}`;
}

function lockPathFor(directory: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(directory, "mcp-auth-locks", `${digest}.lock`);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withLockFile<T>(
  lockPath: string,
  busyError: () => Error,
  work: () => Promise<T>,
): Promise<T> {
  await ensurePrivateDir(path.dirname(lockPath));
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = randomUUID();
  let acquired = false;
  while (!acquired) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${token}\n`, "utf8");
      } finally {
        await handle.close();
      }
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw busyError();
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await work();
  } finally {
    // Do not remove a lock another process took over after ours went stale.
    const current = await fs.readFile(lockPath, "utf8").catch(() => null);
    if (current === `${token}\n`) {
      await fs.unlink(lockPath).catch(() => {});
    }
  }
}

/**
 * Durable OAuth state for Streamable HTTP MCP servers.
 *
 * The token format and the refresh algorithm belong to
 * `@earendil-works/pi-mcp/oauth`; this class only provides the missing
 * Codepunk-side store. The file is user-scope under Codepunk home so a
 * repository cannot read or redirect it.
 */
export class McpAuthStore {
  readonly path: string;

  constructor(home: string, options: { path?: string } = {}) {
    this.path =
      options.path === undefined
        ? path.join(normalizeAbsolute(home), "mcp-auth.json")
        : normalizeAbsolute(options.path);
  }

  private async read(
    options: { tolerateCorrupt?: boolean } = {},
  ): Promise<AuthDocument> {
    let content: string;
    try {
      content = await fs.readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyDocument();
      }
      throw new McpAuthError(
        "mcp.auth_unreadable",
        `cannot read ${this.path}`,
        { cause: error },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      if (options.tolerateCorrupt === true) {
        return emptyDocument();
      }
      throw new McpAuthError(
        "mcp.auth_corrupt",
        `${this.path} is not valid JSON; remove it and sign in again`,
        { cause: error },
      );
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>)["version"] !== AUTH_VERSION ||
      (parsed as Record<string, unknown>)["servers"] === null ||
      typeof (parsed as Record<string, unknown>)["servers"] !== "object" ||
      Array.isArray((parsed as Record<string, unknown>)["servers"])
    ) {
      if (options.tolerateCorrupt === true) {
        return emptyDocument();
      }
      throw new McpAuthError(
        "mcp.auth_corrupt",
        `${this.path} has an unsupported shape; remove it and sign in again`,
      );
    }
    if (process.platform !== "win32") {
      await fs.chmod(this.path, 0o600).catch(() => {});
    }
    return parsed as AuthDocument;
  }

  private async write(document: AuthDocument): Promise<void> {
    await atomicWriteFile(
      this.path,
      `${JSON.stringify(document, null, 2)}\n`,
      0o600,
    );
  }

  private async update(
    mutate: (document: AuthDocument) => void,
    options: { tolerateCorrupt?: boolean } = {},
  ): Promise<void> {
    await withLockFile(
      `${this.path}.write.lock`,
      () =>
        new McpAuthError(
          "mcp.auth_busy",
          `${this.path} is locked by another process`,
        ),
      async () => {
        const document = await this.read(options);
        mutate(document);
        await this.write(document);
      },
    );
  }

  forServer(server: string, serverUrl: string): McpOAuthServerStore {
    const key = storeKey(server, serverUrl);
    const canonicalUrl = canonicalServerUrl(serverUrl);
    return {
      load: async () => {
        const document = await this.read();
        const state = document.servers[key];
        if (state === undefined) {
          return undefined;
        }
        if (canonicalServerUrl(state.serverUrl) !== canonicalUrl) {
          return undefined;
        }
        return state;
      },
      save: async (state) => {
        if (canonicalServerUrl(state.serverUrl) !== canonicalUrl) {
          throw new McpAuthError(
            "mcp.auth_server_mismatch",
            `refusing to store credentials for ${state.serverUrl} under ${canonicalUrl}`,
          );
        }
        await this.update((document) => {
          document.servers[key] = state;
        });
      },
      withRefreshLock: async (work) => {
        return withLockFile(
          lockPathFor(path.dirname(this.path), key),
          () => new McpRefreshLockBusyError(),
          work,
        );
      },
    };
  }

  async tokens(
    server: string,
    serverUrl: string,
  ): Promise<McpOAuthState["tokens"]> {
    const document = await this.read();
    const state = document.servers[storeKey(server, serverUrl)];
    if (
      state === undefined ||
      canonicalServerUrl(state.serverUrl) !== canonicalServerUrl(serverUrl)
    ) {
      return undefined;
    }
    return state.tokens;
  }

  async status(server: string, serverUrl: string): Promise<AuthStatus> {
    const document = await this.read();
    const state = document.servers[storeKey(server, serverUrl)];
    if (
      state === undefined ||
      canonicalServerUrl(state.serverUrl) !== canonicalServerUrl(serverUrl)
    ) {
      return { signed_in: false, expires_at: null, scope: null };
    }
    const tokens = state.tokens;
    return {
      signed_in:
        tokens !== undefined &&
        typeof tokens.access_token === "string" &&
        tokens.access_token.length > 0,
      expires_at:
        state.tokensExpireAt === undefined
          ? null
          : new Date(state.tokensExpireAt).toISOString(),
      scope: tokens?.scope ?? null,
    };
  }

  async remove(server: string, serverUrl: string): Promise<boolean> {
    const key = storeKey(server, serverUrl);
    let removed = false;
    // `logout` is the documented recovery path for a corrupt store. Treat the
    // unreadable document as empty and rewrite it so the next command works.
    await this.update(
      (document) => {
        removed = Object.hasOwn(document.servers, key);
        delete document.servers[key];
      },
      { tolerateCorrupt: true },
    );
    return removed;
  }
}

function expandSecret(
  value: string,
  server: string,
  environment: NodeJS.ProcessEnv,
): string {
  if (value.trimStart().startsWith("!")) {
    throw new McpAuthError(
      "mcp.oauth_command_unsupported",
      `MCP server ${server} oauth.clientSecret cannot use !command expansion; use \${ENV} instead`,
    );
  }
  const missing = new Set<string>();
  const expanded = value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu,
    (_match, name: string) => {
      const resolved = environment[name];
      if (resolved === undefined) {
        missing.add(name);
        return "";
      }
      return resolved;
    },
  );
  if (missing.size > 0) {
    throw new McpAuthError(
      "mcp.missing_env",
      `MCP server ${server} oauth.clientSecret requires missing environment variables: ${[...missing].sort().join(", ")}`,
    );
  }
  return expanded;
}

/**
 * Turn Codepunk's validated TOML settings into the shape Pi's OAuth client
 * expects. Only `${ENV}` expansion is supported; command expansion would make
 * a config file executable at refresh time.
 */
export function oauthSettings(
  config: McpOAuthConfig | undefined,
  server: string,
  environment: NodeJS.ProcessEnv = process.env,
): McpOAuthSettings {
  const clientSecret =
    config?.clientSecret === undefined
      ? undefined
      : expandSecret(config.clientSecret, server, environment);
  return {
    ...(config?.clientId === undefined ? {} : { clientId: config.clientId }),
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(config?.callbackPort === undefined
      ? {}
      : { callbackPort: config.callbackPort }),
    ...(config?.callbackUrl === undefined
      ? {}
      : { callbackUrl: config.callbackUrl }),
    ...(config?.scope === undefined ? {} : { scope: config.scope }),
    clientName: config?.clientName ?? "Codepunk",
    clientRegistration: config?.clientRegistration ?? "dcr",
    ...(config?.authServerMetadataUrl === undefined
      ? {}
      : { authServerMetadataUrl: new URL(config.authServerMetadataUrl) }),
  };
}

export function createServerAuthProvider(options: {
  server: string;
  serverUrl: string;
  store: McpAuthStore;
  settings: McpOAuthSettings;
  onChallenge?: (server: string) => void;
}): McpAuthProvider {
  return createMcpAuthProvider({
    serverUrl: options.serverUrl,
    store: options.store.forServer(options.server, options.serverUrl),
    clientName: options.settings.clientName ?? "Codepunk",
    settings: () => options.settings,
    onChallenge: () => options.onChallenge?.(options.server),
  });
}

export interface McpLoginOptions {
  server: string;
  serverUrl: string;
  store: McpAuthStore;
  settings: McpOAuthSettings;
  signal?: AbortSignal;
  onAuthorizationUrl: (url: URL) => void;
  promptForRedirectUrl?: (signal: AbortSignal) => Promise<string | undefined>;
}

export interface McpLoginResult {
  already_authorized: boolean;
  redirect_url: string;
}

/**
 * Run Pi's MCP sign-in flow against Codepunk's durable store.
 *
 * The browser step is explicit: a session start never calls this function.
 * A stored refresh token is used first; a full PKCE/DCR flow runs only when
 * that cannot produce an access token.
 */
export async function loginMcpServer(
  options: McpLoginOptions,
): Promise<McpLoginResult> {
  const store = options.store.forServer(options.server, options.serverUrl);
  const { callback, redirectUrl } = await listenForLoopbackSignIn({
    serverUrl: options.serverUrl,
    store,
    settings: options.settings,
  });
  try {
    const signIn = {
      serverUrl: options.serverUrl,
      store,
      clientName: options.settings.clientName ?? "Codepunk",
      settings: options.settings,
      redirectUrl,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const authorization = await startMcpSignIn(signIn);
    if (authorization.kind === "authorized") {
      return { already_authorized: true, redirect_url: redirectUrl };
    }
    options.onAuthorizationUrl(new URL(authorization.authorizationUrl));
    const response = await waitForLoopbackSignIn({
      callback,
      authorization,
      ...(options.promptForRedirectUrl === undefined
        ? {}
        : { promptForRedirectUrl: options.promptForRedirectUrl }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await completeMcpSignIn({ ...signIn, authorization, response });
    return { already_authorized: false, redirect_url: redirectUrl };
  } finally {
    await callback.close();
  }
}

export { McpOAuthAuthorizationRequiredError };
