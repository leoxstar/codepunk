import { createInterface } from "node:readline";
import {
  ACP_ERROR_MESSAGES,
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  ACP_REQUEST_MAX_BYTES,
  ACP_RESPONSE_MAX_BYTES,
  AcpNotificationSchema,
  AcpRequestSchema,
  AcpResponseSchema,
  DAEMON_METHOD_SCOPES,
  DAEMON_SCOPES,
  DAEMON_WRITE_LEASE_TTL_MS,
  validateSchema,
  type AcpInitializeResult,
  type AcpResponse,
  type AcpSessionNewResult,
  type DaemonControlEvent,
  type DaemonControlResult,
  type DaemonScope,
  type DaemonWriterLease,
} from "codepunk-protocol";
import {
  ControlApprovalError,
  ControlNotFoundError,
  ControlRunError,
  ControlScopeError,
  ControlWriteConflictError,
  type ControlBackend,
} from "./control.ts";

export interface AcpServerOptions {
  backend: ControlBackend;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

interface AcpSessionState {
  sessionId: string;
  scopes: readonly DaemonScope[];
  writerLease: DaemonWriterLease;
}

interface AcpRunState {
  cancelRequested: boolean;
  cancelResponse: Promise<void>;
  releaseCancel: () => void;
}

type AcpErrorCode =
  | -32700
  | -32600
  | -32601
  | -32602
  | -32603
  | 49001
  | 49002
  | 49003
  | 49004
  | 49005
  | 49006
  | 49007;

type AcpRequest =
  | {
      id: string | number;
      method: "initialize";
      params: { protocolVersion: 1; scopes: DaemonScope[] };
    }
  | {
      id: string | number;
      method: "session/new";
      params: { scopes: DaemonScope[] };
    }
  | {
      id: string | number;
      method: "session/prompt";
      params: { sessionId: string; prompt: string; reason: string };
    }
  | {
      id: string | number;
      method: "session/cancel";
      params: { sessionId: string; reason: string };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestId(value: unknown): string | number | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = value["id"];
  return typeof id === "string" || Number.isInteger(id)
    ? (id as string | number)
    : null;
}

function hasControlEvent(
  events: readonly DaemonControlEvent[],
  kind: DaemonControlEvent["kind"],
): boolean {
  return events.some((event) => event.kind === kind);
}

export class AcpServer {
  private readonly backend: ControlBackend;
  private readonly output: NodeJS.WritableStream;
  private readonly input: NodeJS.ReadableStream;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly sessions = new Map<string, AcpSessionState>();
  private readonly activeRuns = new Map<string, AcpRunState>();
  private readonly tasks = new Set<Promise<void>>();
  private setupTail: Promise<void> = Promise.resolve();
  private scopes: readonly DaemonScope[] = [];
  private initialized = false;

  constructor(options: AcpServerOptions) {
    this.backend = options.backend;
    this.input = options.input;
    this.output = options.output;
    this.maxRequestBytes = options.maxRequestBytes ?? ACP_REQUEST_MAX_BYTES;
    this.maxResponseBytes = options.maxResponseBytes ?? ACP_RESPONSE_MAX_BYTES;
  }

  async run(): Promise<void> {
    const reader = createInterface({ input: this.input });
    reader.on("line", (line) => {
      const task = this.handleLine(line);
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task));
    });
    await new Promise<void>((resolve) => reader.once("close", resolve));
    try {
      while (this.tasks.size > 0) {
        await Promise.allSettled([...this.tasks]);
      }
    } finally {
      await this.backend.close?.();
    }
  }

  private async handleLine(line: string): Promise<void> {
    if (line.trim().length === 0) {
      return;
    }
    if (Buffer.byteLength(line, "utf8") > this.maxRequestBytes) {
      this.writeError(null, -32603);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      this.writeError(null, -32700);
      return;
    }
    if (
      isRecord(value) &&
      value["jsonrpc"] === "2.0" &&
      typeof value["method"] === "string" &&
      !(ACP_METHODS as readonly string[]).includes(value["method"])
    ) {
      this.writeError(requestId(value), -32601);
      return;
    }
    const validation = validateSchema(AcpRequestSchema, value);
    if (!validation.ok) {
      this.writeError(requestId(value), -32600);
      return;
    }
    const request = validation.value as unknown as AcpRequest;
    if (request.method === "initialize") {
      this.scopes = request.params.scopes;
      this.initialized = true;
      this.writeResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: ACP_PROTOCOL_VERSION,
          methods: [...ACP_METHODS],
          scopes: [...DAEMON_SCOPES],
          methodScopes: { ...DAEMON_METHOD_SCOPES },
          writerLeaseTtlMs: DAEMON_WRITE_LEASE_TTL_MS,
          compatibility:
            "ACP v1 wraps additive daemon v1 control; JSON-RPC errors are ACP-only",
        } as AcpInitializeResult,
      });
      return;
    }
    const setup = this.setupTail;
    if (request.method === "session/new") {
      const handler = this.handleNewSession(request);
      this.setupTail = handler;
      await handler;
      return;
    }
    await this.handleControlRequest(request, setup);
  }

  private async handleNewSession(
    request: Extract<AcpRequest, { method: "session/new" }>,
  ): Promise<void> {
    try {
      if (!this.initialized) {
        throw new ControlScopeError("initialize must be called first");
      }
      if (
        !this.scopes.includes("runs:write") ||
        request.params.scopes.some((scope) => !this.scopes.includes(scope))
      ) {
        throw new ControlScopeError();
      }
      const session = await this.backend.newSession(request.params.scopes);
      this.sessions.set(session.sessionId, {
        sessionId: session.sessionId,
        scopes: request.params.scopes,
        writerLease: session.writerLease,
      });
      this.writeResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          sessionId: session.sessionId,
          scopes: request.params.scopes,
          writerLease: session.writerLease,
        } as AcpSessionNewResult,
      });
    } catch (error) {
      this.writeError(request.id, this.errorCode(error));
    }
  }

  private async handleControlRequest(
    request: Exclude<AcpRequest, { method: "initialize" | "session/new" }>,
    setup: Promise<void>,
  ): Promise<void> {
    try {
      await setup;
      const session = this.sessions.get(request.params.sessionId);
      if (!this.initialized) {
        throw new ControlScopeError("initialize must be called first");
      }
      if (session === undefined) {
        throw new ControlNotFoundError();
      }
      if (
        !this.scopes.includes("runs:write") ||
        !session.scopes.includes("runs:write")
      ) {
        throw new ControlScopeError();
      }
      if (request.method === "session/prompt") {
        if (this.activeRuns.has(request.params.sessionId)) {
          throw new ControlWriteConflictError(
            `session ${request.params.sessionId} already has an active run`,
          );
        }
        await this.runPrompt(request, session);
        return;
      }
      await this.cancelRun(request, session);
    } catch (error) {
      this.writeError(request.id, this.errorCode(error));
    }
  }

  private async runPrompt(
    request: Extract<AcpRequest, { method: "session/prompt" }>,
    session: AcpSessionState,
  ): Promise<void> {
    let releaseCancel = (): void => {};
    const run: AcpRunState = {
      cancelRequested: false,
      cancelResponse: new Promise<void>((resolve) => {
        releaseCancel = resolve;
      }),
      releaseCancel: () => releaseCancel(),
    };
    this.activeRuns.set(request.params.sessionId, run);
    let result: DaemonControlResult;
    try {
      result = await this.backend.run({
        sessionId: request.params.sessionId,
        prompt: request.params.prompt,
        reason: request.params.reason,
        writerLease: session.writerLease,
      });
    } catch (error) {
      if (error instanceof ControlRunError) {
        this.emitEvents(request.params.sessionId, error.events);
      }
      if (run.cancelRequested) {
        await run.cancelResponse;
        this.writeError(request.id, 49007);
      } else if (error instanceof ControlRunError) {
        this.writeError(request.id, 49006);
      } else {
        this.activeRuns.delete(request.params.sessionId);
        run.releaseCancel();
        throw error;
      }
      this.finishRun(request.params.sessionId, run);
      run.releaseCancel();
      return;
    }
    session.writerLease = result.writer_lease;
    this.emitEvents(request.params.sessionId, result.events);
    if (run.cancelRequested) {
      await run.cancelResponse;
      this.writeError(request.id, 49007);
    } else if (hasControlEvent(result.events, "control/error")) {
      this.writeError(request.id, 49006);
    } else if (hasControlEvent(result.events, "control/stopped")) {
      this.writeError(request.id, 49007);
    } else {
      this.writeResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          sessionId: request.params.sessionId,
          runId: result.run_id,
          events: [],
          writerLease: result.writer_lease,
        },
      });
    }
    this.finishRun(request.params.sessionId, run);
    run.releaseCancel();
  }

  private finishRun(sessionId: string, run: AcpRunState): void {
    if (this.activeRuns.get(sessionId) === run) {
      this.activeRuns.delete(sessionId);
    }
  }

  private async cancelRun(
    request: Extract<AcpRequest, { method: "session/cancel" }>,
    session: AcpSessionState,
  ): Promise<void> {
    const run = this.activeRuns.get(request.params.sessionId);
    if (run !== undefined) {
      run.cancelRequested = true;
      try {
        const result = await this.backend.stop({
          sessionId: request.params.sessionId,
          message: "",
          reason: request.params.reason,
          writerLease: session.writerLease,
        });
        session.writerLease = result.writer_lease;
        this.emitEvents(request.params.sessionId, result.events);
        this.writeResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            sessionId: request.params.sessionId,
            runId: result.run_id,
            events: [],
            writerLease: result.writer_lease,
          },
        });
      } finally {
        run.releaseCancel();
      }
      return;
    }
    const result = await this.backend.stop({
      sessionId: request.params.sessionId,
      message: "",
      reason: request.params.reason,
      writerLease: session.writerLease,
    });
    session.writerLease = result.writer_lease;
    this.emitEvents(request.params.sessionId, result.events);
    this.writeResponse({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        sessionId: request.params.sessionId,
        runId: result.run_id,
        events: [],
        writerLease: result.writer_lease,
      },
    });
  }

  private errorCode(error: unknown): AcpErrorCode {
    if (error instanceof ControlScopeError) {
      return 49001;
    }
    if (error instanceof ControlWriteConflictError) {
      return 49002;
    }
    if (error instanceof ControlApprovalError) {
      return 49003;
    }
    if (error instanceof ControlNotFoundError) {
      return 49005;
    }
    return 49006;
  }

  private emitEvents(
    sessionId: string,
    events: readonly DaemonControlEvent[],
  ): void {
    for (const event of events) {
      const notification = {
        jsonrpc: "2.0",
        method: "session/event",
        params: { sessionId, event },
      };
      const validation = validateSchema(AcpNotificationSchema, notification);
      if (!validation.ok) {
        this.writeError(null, -32603);
        continue;
      }
      this.writeRaw(notification);
    }
  }

  private writeResponse(response: AcpResponse): void {
    const validation = validateSchema(AcpResponseSchema, response);
    if (!validation.ok) {
      this.writeError(response.id, -32603);
      return;
    }
    this.writeRaw(response);
  }

  private writeError(id: string | number | null, code: AcpErrorCode): void {
    this.writeResponse({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message:
          ACP_ERROR_MESSAGES[String(code) as keyof typeof ACP_ERROR_MESSAGES],
      },
    });
  }

  private writeRaw(value: unknown): void {
    const encoded = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > this.maxResponseBytes) {
      const fallback = {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: 49004,
          message: ACP_ERROR_MESSAGES[49004],
        },
      };
      this.output.write(`${JSON.stringify(fallback)}\n`);
      return;
    }
    this.output.write(encoded);
  }
}
