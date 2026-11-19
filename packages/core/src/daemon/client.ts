import { randomUUID } from "node:crypto";
import net from "node:net";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_REQUEST_TIMEOUT_MS,
  DAEMON_RESPONSE_MAX_BYTES,
  DaemonHelloResponseSchema,
  DaemonRequestSchema,
  DaemonResponseSchema,
  DaemonSessionListResponseSchema,
  DaemonSessionPinResponseSchema,
  DaemonSessionReadResponseSchema,
  validateSchema,
  type DaemonErrorCode,
  type DaemonHelloResult,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonSessionListResult,
  type DaemonSessionPinResult,
  type DaemonSessionReadResult,
} from "codepunk-protocol";

export interface DaemonClientOptions {
  socketPath: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class DaemonClientError extends Error {
  readonly code:
    DaemonErrorCode | "daemon.unavailable" | "daemon.invalid_response";

  constructor(
    code: DaemonClientError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DaemonClientError";
    this.code = code;
  }
}

export class DaemonClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: DaemonClientOptions) {
    this.socketPath = options.socketPath;
    this.timeoutMs = options.timeoutMs ?? DAEMON_REQUEST_TIMEOUT_MS;
    this.maxResponseBytes =
      options.maxResponseBytes ?? DAEMON_RESPONSE_MAX_BYTES;
  }

  async hello(): Promise<DaemonHelloResult> {
    const response = await this.send({
      type: "codepunk/daemon-request",
      version: DAEMON_PROTOCOL_VERSION,
      request_id: randomUUID(),
      method: "daemon/hello",
      params: {},
    });
    if (!response.ok) {
      throw new DaemonClientError(response.error.code, response.error.message);
    }
    const validation = validateSchema(DaemonHelloResponseSchema, response);
    if (!validation.ok) {
      throw new DaemonClientError(
        "daemon.invalid_response",
        "daemon hello response did not match protocol v1",
      );
    }
    return response.result as DaemonHelloResult;
  }

  async listSessions(): Promise<DaemonSessionListResult> {
    const response = await this.send({
      type: "codepunk/daemon-request",
      version: DAEMON_PROTOCOL_VERSION,
      request_id: randomUUID(),
      method: "session/list",
      params: {},
    });
    if (!response.ok) {
      throw new DaemonClientError(response.error.code, response.error.message);
    }
    const validation = validateSchema(
      DaemonSessionListResponseSchema,
      response,
    );
    if (!validation.ok) {
      throw new DaemonClientError(
        "daemon.invalid_response",
        "daemon session list response did not match protocol v1",
      );
    }
    return response.result as DaemonSessionListResult;
  }

  async readSession(
    sessionId: string,
    options: { afterSeq?: number; limit?: number } = {},
  ): Promise<DaemonSessionReadResult> {
    const response = await this.send({
      type: "codepunk/daemon-request",
      version: DAEMON_PROTOCOL_VERSION,
      request_id: randomUUID(),
      method: "session/read",
      params: {
        session_id: sessionId,
        ...(options.afterSeq !== undefined
          ? { after_seq: options.afterSeq }
          : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      },
    });
    if (!response.ok) {
      throw new DaemonClientError(response.error.code, response.error.message);
    }
    const validation = validateSchema(
      DaemonSessionReadResponseSchema,
      response,
    );
    if (!validation.ok) {
      throw new DaemonClientError(
        "daemon.invalid_response",
        "daemon session read response did not match protocol v1",
      );
    }
    return response.result as DaemonSessionReadResult;
  }

  async pinSession(
    sessionId: string,
    pinned: boolean,
  ): Promise<DaemonSessionPinResult> {
    const response = await this.send({
      type: "codepunk/daemon-request",
      version: DAEMON_PROTOCOL_VERSION,
      request_id: randomUUID(),
      method: "session/pin",
      params: { session_id: sessionId, pinned },
    });
    if (!response.ok) {
      throw new DaemonClientError(response.error.code, response.error.message);
    }
    const validation = validateSchema(DaemonSessionPinResponseSchema, response);
    if (!validation.ok) {
      throw new DaemonClientError(
        "daemon.invalid_response",
        "daemon session pin response did not match protocol v1",
      );
    }
    return response.result as DaemonSessionPinResult;
  }

  async readAllSession(sessionId: string): Promise<DaemonSessionReadResult> {
    let afterSeq = 0;
    let first: DaemonSessionReadResult | null = null;
    const events: DaemonSessionReadResult["events"] = [];
    for (let page = 0; page < 10_000; page += 1) {
      const result = await this.readSession(sessionId, {
        afterSeq,
        limit: 100,
      });
      first ??= result;
      events.push(...result.events);
      if (!result.has_more) {
        return {
          ...result,
          after_seq: 0,
          events,
          next_seq: result.next_seq,
        };
      }
      if (result.next_seq <= afterSeq) {
        throw new DaemonClientError(
          "daemon.invalid_response",
          "daemon session pagination did not advance",
        );
      }
      afterSeq = result.next_seq;
    }
    throw new DaemonClientError(
      "daemon.invalid_response",
      "daemon session pagination exceeded the client limit",
    );
  }

  private async send(request: DaemonRequest): Promise<DaemonResponse> {
    const requestValidation = validateSchema(DaemonRequestSchema, request);
    if (!requestValidation.ok) {
      throw new DaemonClientError(
        "protocol.invalid_request",
        "daemon client produced an invalid protocol v1 request",
      );
    }
    const payload = `${JSON.stringify(request)}\n`;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      let buffer = "";
      let bytes = 0;
      let settled = false;
      const finish = (result: DaemonResponse | Error) => {
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
          new DaemonClientError(
            "daemon.timeout",
            `daemon request timed out after ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);
      timer.unref();
      socket.setEncoding("utf8");
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
          finish(
            new DaemonClientError(
              "daemon.unavailable",
              "codepunk daemon is not running for this project",
              { cause: error },
            ),
          );
          return;
        }
        finish(
          new DaemonClientError(
            "daemon.unavailable",
            `daemon connection failed: ${error.message}`,
            { cause: error },
          ),
        );
      });
      socket.once("close", () => {
        if (!settled) {
          finish(
            new DaemonClientError(
              "daemon.invalid_response",
              "daemon closed without a response",
            ),
          );
        }
      });
      socket.on("data", (chunk: string) => {
        const chunkBytes = Buffer.byteLength(chunk, "utf8");
        if (bytes + chunkBytes > this.maxResponseBytes) {
          finish(
            new DaemonClientError(
              "daemon.invalid_response",
              "daemon response exceeded the client limit",
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
        const line = buffer.slice(0, newline);
        buffer = "";
        let response: unknown;
        try {
          response = JSON.parse(line) as unknown;
        } catch (error) {
          finish(
            new DaemonClientError(
              "daemon.invalid_response",
              "daemon response is not valid JSON",
              { cause: error },
            ),
          );
          return;
        }
        const validation = validateSchema(DaemonResponseSchema, response);
        if (!validation.ok) {
          finish(
            new DaemonClientError(
              "daemon.invalid_response",
              "daemon response did not match protocol v1",
            ),
          );
          return;
        }
        const typed = response as DaemonResponse;
        if (typed.request_id !== request.request_id) {
          finish(
            new DaemonClientError(
              "daemon.invalid_response",
              "daemon response request_id does not match the request",
            ),
          );
          return;
        }
        finish(typed);
      });
      socket.once("connect", () => {
        socket.write(payload);
      });
    });
  }
}
