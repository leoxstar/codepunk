import net, { type Server, type Socket } from "node:net";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DAEMON_DEFAULT_PAGE_SIZE,
  DAEMON_MAX_CONNECTIONS,
  DAEMON_MAX_PAGE_SIZE,
  DAEMON_METHODS,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_REQUEST_MAX_BYTES,
  DAEMON_REQUEST_TIMEOUT_MS,
  DAEMON_RESPONSE_MAX_BYTES,
  DaemonRequestSchema,
  DaemonResponseSchema,
  validateSchema,
  type DaemonErrorCode,
  type DaemonHelloResult,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonSessionListResult,
  type DaemonSessionPinResult,
  type DaemonSessionReadResult,
} from "codepunk-protocol";
import type { ProjectPaths } from "../platform/paths.ts";
import { posixMetadataIsReliable } from "../platform/fs.ts";
import { readSessionSnapshot, SessionNotFoundError } from "../session/index.ts";
import { listProjectSessions, pinSession } from "../session/ops.ts";
import { daemonSocketPath } from "./paths.ts";

const SUPPORTED_METHODS = new Set<string>(DAEMON_METHODS);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export interface DaemonServerOptions {
  paths: ProjectPaths;
  socketPath?: string;
  requestTimeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  now?: () => Date;
}

type DecodedRequest =
  | { ok: true; request: DaemonRequest }
  | { ok: false; requestId: string; code: DaemonErrorCode; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestIdFrom(value: unknown): string {
  if (isRecord(value)) {
    const requestId = value["request_id"];
    if (typeof requestId === "string" && REQUEST_ID_PATTERN.test(requestId)) {
      return requestId;
    }
  }
  return "invalid";
}

function decodeRequest(line: string): DecodedRequest {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return {
      ok: false,
      requestId: "invalid",
      code: "protocol.invalid_request",
      message: "request is not valid JSON",
    };
  }
  const requestId = requestIdFrom(value);
  if (!isRecord(value)) {
    return {
      ok: false,
      requestId,
      code: "protocol.invalid_request",
      message: "request must be a JSON object",
    };
  }
  if (value["type"] !== "codepunk/daemon-request") {
    return {
      ok: false,
      requestId,
      code: "protocol.invalid_request",
      message: "request type is not codepunk/daemon-request",
    };
  }
  const version = value["version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return {
      ok: false,
      requestId,
      code: "protocol.invalid_request",
      message: "daemon protocol version is missing or invalid",
    };
  }
  if (version !== DAEMON_PROTOCOL_VERSION) {
    return {
      ok: false,
      requestId,
      code: "protocol.version_mismatch",
      message: `daemon protocol version ${version} is not supported; expected ${DAEMON_PROTOCOL_VERSION}`,
    };
  }
  const method = value["method"];
  if (typeof method !== "string") {
    return {
      ok: false,
      requestId,
      code: "protocol.invalid_request",
      message: "daemon request method is missing or invalid",
    };
  }
  if (!SUPPORTED_METHODS.has(method)) {
    return {
      ok: false,
      requestId,
      code: "daemon.read_only",
      message: `daemon method ${method} is not available; it is not one of the advertised methods`,
    };
  }
  const validation = validateSchema(DaemonRequestSchema, value);
  if (!validation.ok) {
    return {
      ok: false,
      requestId,
      code: "protocol.invalid_request",
      message: validation.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; "),
    };
  }
  return { ok: true, request: value as DaemonRequest };
}

function errorResponse(
  requestId: string,
  code: DaemonErrorCode,
  message: string,
): DaemonResponse {
  return {
    type: "codepunk/daemon-response",
    version: DAEMON_PROTOCOL_VERSION,
    request_id: requestId,
    ok: false,
    error: { code, message },
  };
}

async function probeSocket(socketPath: string): Promise<"live" | "stale"> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    const finish = (result: "live" | "stale" | Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };
    const timer = setTimeout(() => {
      finish(
        new Error(
          "daemon socket exists but did not accept a probe; refusing to replace it",
        ),
      );
    }, 500);
    timer.unref();
    socket.once("connect", () => finish("live"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        finish("stale");
        return;
      }
      finish(error);
    });
  });
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error("daemon socket path must not be a symbolic link");
  }
  if (!stat.isSocket()) {
    throw new Error("daemon socket path exists and is not a socket");
  }
  if (
    (await posixMetadataIsReliable(socketPath)) &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new Error("daemon socket is owned by another user");
  }
  const state = await probeSocket(socketPath);
  if (state === "live") {
    throw new Error("daemon is already running for this project");
  }
  await fs.unlink(socketPath);
}

async function prepareSocketDirectory(socketPath: string): Promise<void> {
  const directory = path.dirname(socketPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("daemon socket parent must be a real directory");
  }
  if (
    (await posixMetadataIsReliable(directory)) &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new Error("daemon socket directory is owned by another user");
  }
  await fs.chmod(directory, 0o700);
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

export class DaemonServer {
  readonly socketPath: string;
  readonly projectId: string;
  readonly readOnly = true as const;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly requestTimeoutMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly paths: ProjectPaths;
  private readonly startedAt: string;
  private readonly closePromise: Promise<void>;
  private closeResolve: (() => void) | null = null;
  private closing = false;
  private socketIdentity: { dev: number; ino: number } | null = null;

  private constructor(options: DaemonServerOptions, socketPath: string) {
    this.socketPath = socketPath;
    this.projectId = options.paths.projectId;
    this.paths = options.paths;
    this.server = net.createServer((socket) => this.handleConnection(socket));
    this.server.maxConnections = DAEMON_MAX_CONNECTIONS;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DAEMON_REQUEST_TIMEOUT_MS;
    this.maxRequestBytes = options.maxRequestBytes ?? DAEMON_REQUEST_MAX_BYTES;
    this.maxResponseBytes =
      options.maxResponseBytes ?? DAEMON_RESPONSE_MAX_BYTES;
    this.startedAt = (options.now?.() ?? new Date()).toISOString();
    this.closePromise = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
  }

  static async start(options: DaemonServerOptions): Promise<DaemonServer> {
    const socketPath = daemonSocketPath(options.paths, options.socketPath);
    await prepareSocketDirectory(socketPath);
    await prepareSocketPath(socketPath);
    const daemon = new DaemonServer(options, socketPath);
    try {
      await listen(daemon.server, socketPath);
      const initialStat = await fs.lstat(socketPath);
      daemon.socketIdentity = {
        dev: initialStat.dev,
        ino: initialStat.ino,
      };
      await fs.chmod(socketPath, 0o600);
      const stat = await fs.lstat(socketPath);
      if (!stat.isSocket()) {
        throw new Error("daemon path did not resolve to a Unix socket");
      }
      if (
        (await posixMetadataIsReliable(socketPath)) &&
        typeof process.getuid === "function" &&
        stat.uid !== process.getuid()
      ) {
        throw new Error("daemon socket owner changed during startup");
      }
      daemon.server.on("error", () => {
        void daemon.close().catch(() => {});
      });
      return daemon;
    } catch (error) {
      await daemon.close();
      throw error;
    }
  }

  wait(): Promise<void> {
    return this.closePromise;
  }

  async close(): Promise<void> {
    if (this.closing) {
      return this.closePromise;
    }
    this.closing = true;
    let failure: unknown = null;
    try {
      for (const socket of this.sockets) {
        socket.destroy();
      }
      this.sockets.clear();
      if (this.server.listening) {
        await new Promise<void>((resolve) => {
          this.server.close(() => resolve());
        });
      }
      const identity = this.socketIdentity;
      this.socketIdentity = null;
      if (identity !== null) {
        try {
          const stat = await fs.lstat(this.socketPath);
          if (
            stat.isSocket() &&
            stat.dev === identity.dev &&
            stat.ino === identity.ino
          ) {
            await fs.unlink(this.socketPath);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      this.closeResolve?.();
      this.closeResolve = null;
    }
    if (failure !== null) {
      throw failure;
    }
  }

  private helloResult(): DaemonHelloResult {
    return {
      protocol_version: DAEMON_PROTOCOL_VERSION,
      read_only: false,
      methods: [...DAEMON_METHODS],
      pid: process.pid,
      started_at: this.startedAt,
    };
  }

  private async handleRequest(request: DaemonRequest): Promise<DaemonResponse> {
    if (request.method === "daemon/hello") {
      return {
        type: "codepunk/daemon-response",
        version: DAEMON_PROTOCOL_VERSION,
        request_id: request.request_id,
        ok: true,
        result: this.helloResult(),
      };
    }
    if (request.method === "session/list") {
      const sessions = await listProjectSessions(
        this.paths.home,
        this.paths.projectId,
      );
      const result: DaemonSessionListResult = {
        sessions: sessions.map((session) => ({
          id: session.id,
          created_at: session.created_at,
          updated_at: session.updated_at,
          title: session.title,
          pinned: session.pinned,
          last_seq: session.last_seq,
          cwd: session.cwd,
        })),
      };
      return {
        type: "codepunk/daemon-response",
        version: DAEMON_PROTOCOL_VERSION,
        request_id: request.request_id,
        ok: true,
        result,
      };
    }
    if (request.method === "session/pin") {
      await pinSession(
        {
          rootDir: this.paths.home,
          cwd: this.paths.cwd,
          projectRoot: this.paths.deliveryRoot,
          projectId: this.paths.projectId,
          sessionId: request.params.session_id,
        },
        request.params.pinned,
      );
      const result: DaemonSessionPinResult = {
        session_id: request.params.session_id,
        pinned: request.params.pinned,
      };
      return {
        type: "codepunk/daemon-response",
        version: DAEMON_PROTOCOL_VERSION,
        request_id: request.request_id,
        ok: true,
        result,
      };
    }
    const afterSeq = request.params.after_seq ?? 0;
    const limit = Math.min(
      request.params.limit ?? DAEMON_DEFAULT_PAGE_SIZE,
      DAEMON_MAX_PAGE_SIZE,
    );
    const snapshot = await readSessionSnapshot({
      rootDir: this.paths.home,
      projectId: this.paths.projectId,
      sessionId: request.params.session_id,
    });
    const start = snapshot.events.findIndex((event) => event.seq > afterSeq);
    const offset = start === -1 ? snapshot.events.length : start;
    const events = snapshot.events.slice(offset, offset + limit);
    const nextSeq = events.at(-1)?.seq ?? afterSeq;
    const result: DaemonSessionReadResult = {
      header: snapshot.header,
      metadata: snapshot.metadata,
      events,
      after_seq: afterSeq,
      next_seq: nextSeq,
      has_more: offset + events.length < snapshot.events.length,
      read_only: true,
    };
    return {
      type: "codepunk/daemon-response",
      version: DAEMON_PROTOCOL_VERSION,
      request_id: request.request_id,
      ok: true,
      result,
    };
  }

  private send(socket: Socket, response: DaemonResponse): void {
    const validation = validateSchema(DaemonResponseSchema, response);
    const safeResponse = validation.ok
      ? response
      : errorResponse(
          response.request_id,
          "daemon.internal",
          "daemon produced a response outside protocol v1",
        );
    let encoded = `${JSON.stringify(safeResponse)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > this.maxResponseBytes) {
      encoded = `${JSON.stringify(
        errorResponse(
          safeResponse.request_id,
          "daemon.response_too_large",
          "response exceeded the daemon wire limit; request a smaller page",
        ),
      )}\n`;
    }
    if (!socket.destroyed) {
      socket.end(encoded);
    }
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(this.requestTimeoutMs);
    let buffer = "";
    let bytes = 0;
    let handled = false;
    socket.on("error", () => {});
    socket.on("close", () => {
      this.sockets.delete(socket);
    });
    socket.on("timeout", () => {
      if (handled) {
        return;
      }
      handled = true;
      this.send(
        socket,
        errorResponse(
          "timeout",
          "daemon.timeout",
          "daemon request was not complete before the timeout",
        ),
      );
    });
    socket.on("data", (chunk: string) => {
      if (handled) {
        return;
      }
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (bytes + chunkBytes > this.maxRequestBytes) {
        handled = true;
        this.send(
          socket,
          errorResponse(
            "invalid",
            "daemon.request_too_large",
            `daemon request exceeded ${this.maxRequestBytes} bytes`,
          ),
        );
        return;
      }
      bytes += chunkBytes;
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      handled = true;
      socket.setTimeout(0);
      const line = buffer.slice(0, newline);
      buffer = "";
      const decoded = decodeRequest(line);
      if (!decoded.ok) {
        this.send(
          socket,
          errorResponse(decoded.requestId, decoded.code, decoded.message),
        );
        return;
      }
      void this.handleRequest(decoded.request)
        .catch((error: unknown) => {
          if (error instanceof SessionNotFoundError) {
            return errorResponse(
              decoded.request.request_id,
              "daemon.not_found",
              error.message,
            );
          }
          return errorResponse(
            decoded.request.request_id,
            "daemon.internal",
            error instanceof Error ? error.message : String(error),
          );
        })
        .then((response) => {
          this.send(socket, response);
        })
        .catch(() => {
          socket.destroy();
        });
    });
  }
}
