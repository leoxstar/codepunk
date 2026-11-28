import { createInterface } from "node:readline";
import { CODEPUNK_VERSION } from "../build-meta.ts";
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
  type AcpPromptBlock,
  type AcpResponse,
  type AcpSessionNewResult,
  type AcpStandardInitializeResult,
  type AcpStandardPromptResult,
  type AcpStandardSessionResult,
  type DaemonControlEvent,
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
  type ControlRunResult,
} from "./control.ts";

export interface AcpServerOptions {
  backend: ControlBackend;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  agentVersion?: string;
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

type AcpWireMode = "scoped" | "standard";

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

type AcpWireRequest =
  | {
      id: string | number;
      method: "initialize";
      params?: {
        protocolVersion?: 1;
        scopes?: DaemonScope[];
        clientCapabilities?: Record<string, unknown>;
        clientInfo?: { name: string; title?: string; version?: string };
      };
    }
  | {
      id: string | number;
      method: "session/new";
      params?: {
        scopes?: DaemonScope[];
        cwd?: string;
        mcpServers?: unknown[];
      };
    }
  | {
      id: string | number;
      method: "session/load";
      params: {
        sessionId: string;
        cwd?: string;
        mcpServers?: unknown[];
      };
    }
  | {
      id: string | number;
      method: "session/prompt";
      params: {
        sessionId: string;
        prompt: string | AcpPromptBlock[];
        reason?: string;
      };
    }
  | {
      id?: string | number;
      method: "session/cancel";
      params: {
        sessionId: string;
        reason?: string;
      };
    };

const STANDARD_ACP_DEFAULT_SCOPES: readonly DaemonScope[] = [
  "daemon:read",
  "sessions:read",
  "runs:write",
];

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

export function normalizeAcpPrompt(
  prompt: string | readonly AcpPromptBlock[],
): string | null {
  if (typeof prompt === "string") {
    return prompt.length > 0 && prompt.length <= 32_000 ? prompt : null;
  }
  const parts: string[] = [];
  for (const block of prompt) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "resource_link") {
      const label = block.name ? `${block.name} (${block.uri})` : block.uri;
      parts.push(
        block.description
          ? `[Resource link: ${label} - ${block.description}]`
          : `[Resource link: ${label}]`,
      );
    } else if (block.type === "resource") {
      const body =
        typeof block.resource.text === "string" &&
        block.resource.text.length > 0
          ? `\n${block.resource.text}`
          : "";
      parts.push(`[Resource: ${block.resource.uri}]${body}`);
    }
  }
  const joined = parts.join("\n\n").trim();
  return joined.length > 0 && joined.length <= 32_000 ? joined : null;
}

export class AcpServer {
  private readonly backend: ControlBackend;
  private readonly output: NodeJS.WritableStream;
  private readonly input: NodeJS.ReadableStream;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly agentVersion: string;
  private readonly sessions = new Map<string, AcpSessionState>();
  private readonly activeRuns = new Map<string, AcpRunState>();
  private readonly tasks = new Set<Promise<void>>();
  private setupTail: Promise<void> = Promise.resolve();
  private scopes: readonly DaemonScope[] = [];
  private mode: AcpWireMode = "scoped";
  private initialized = false;

  constructor(options: AcpServerOptions) {
    this.backend = options.backend;
    this.input = options.input;
    this.output = options.output;
    this.maxRequestBytes = options.maxRequestBytes ?? ACP_REQUEST_MAX_BYTES;
    this.maxResponseBytes = options.maxResponseBytes ?? ACP_RESPONSE_MAX_BYTES;
    this.agentVersion = options.agentVersion ?? CODEPUNK_VERSION;
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
    const request = validation.value as unknown as AcpWireRequest;
    if (request.method === "initialize") {
      this.handleInitialize(request);
      return;
    }
    const setup = this.setupTail;
    if (request.method === "session/new") {
      const handler = this.handleNewSession(request);
      this.setupTail = handler;
      await handler;
      return;
    }
    if (request.method === "session/load") {
      const handler = this.handleLoadSession(request, setup);
      this.setupTail = handler;
      await handler;
      return;
    }
    await this.handleControlRequest(request, setup);
  }

  private handleInitialize(
    request: Extract<AcpWireRequest, { method: "initialize" }>,
  ): void {
    const explicitScopes = request.params?.scopes;
    if (Array.isArray(explicitScopes)) {
      this.mode = "scoped";
      this.scopes = explicitScopes;
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
    this.mode = "standard";
    this.scopes = [...STANDARD_ACP_DEFAULT_SCOPES];
    this.initialized = true;
    const result: AcpStandardInitializeResult = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          embeddedContext: true,
        },
      },
      agentInfo: {
        name: "codepunk",
        title: "Codepunk",
        version: this.agentVersion,
      },
    };
    this.writeResponse({
      jsonrpc: "2.0",
      id: request.id,
      result,
    });
  }

  private async handleNewSession(
    request: Extract<AcpWireRequest, { method: "session/new" }>,
  ): Promise<void> {
    try {
      if (!this.initialized) {
        throw new ControlScopeError("initialize must be called first");
      }
      const requestedScopes = request.params?.scopes;
      const effectiveScopes =
        requestedScopes !== undefined ? requestedScopes : [...this.scopes];
      if (
        !this.scopes.includes("runs:write") ||
        effectiveScopes.some((scope) => !this.scopes.includes(scope))
      ) {
        throw new ControlScopeError();
      }
      const cwd = request.params?.cwd;
      const session = await this.backend.newSession(
        effectiveScopes,
        cwd === undefined ? undefined : { cwd },
      );
      this.sessions.set(session.sessionId, {
        sessionId: session.sessionId,
        scopes: effectiveScopes,
        writerLease: session.writerLease,
      });
      if (this.mode === "standard" && requestedScopes === undefined) {
        const result: AcpStandardSessionResult = {
          sessionId: session.sessionId,
        };
        this.writeResponse({
          jsonrpc: "2.0",
          id: request.id,
          result,
        });
        return;
      }
      this.writeResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          sessionId: session.sessionId,
          scopes: [...effectiveScopes],
          writerLease: session.writerLease,
        } as AcpSessionNewResult,
      });
    } catch (error) {
      this.writeError(request.id, this.errorCode(error));
    }
  }

  private async handleLoadSession(
    request: Extract<AcpWireRequest, { method: "session/load" }>,
    setup: Promise<void>,
  ): Promise<void> {
    try {
      await setup;
      if (!this.initialized) {
        throw new ControlScopeError("initialize must be called first");
      }
      if (
        !this.scopes.includes("sessions:read") ||
        !this.scopes.includes("runs:write")
      ) {
        throw new ControlScopeError();
      }
      const existing = this.sessions.get(request.params.sessionId);
      if (existing === undefined) {
        if (typeof this.backend.loadSession !== "function") {
          throw new ControlNotFoundError();
        }
        const loaded = await this.backend.loadSession(
          request.params.sessionId,
          this.scopes,
          request.params.cwd === undefined
            ? undefined
            : { cwd: request.params.cwd },
        );
        this.sessions.set(loaded.sessionId, {
          sessionId: loaded.sessionId,
          scopes: [...this.scopes],
          writerLease: loaded.writerLease,
        });
      }
      const result: AcpStandardSessionResult = {
        sessionId: request.params.sessionId,
      };
      this.writeResponse({
        jsonrpc: "2.0",
        id: request.id,
        result,
      });
    } catch (error) {
      this.writeError(request.id, this.errorCode(error));
    }
  }

  private async handleControlRequest(
    request: Extract<
      AcpWireRequest,
      { method: "session/prompt" | "session/cancel" }
    >,
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
      if (request.id !== undefined) {
        this.writeError(request.id, this.errorCode(error));
      }
    }
  }

  private async runPrompt(
    request: Extract<AcpWireRequest, { method: "session/prompt" }>,
    session: AcpSessionState,
  ): Promise<void> {
    const normalizedPrompt = normalizeAcpPrompt(request.params.prompt);
    if (normalizedPrompt === null) {
      this.writeError(request.id, -32602);
      return;
    }
    const reason = request.params.reason ?? "acp prompt";
    let releaseCancel = (): void => {};
    const run: AcpRunState = {
      cancelRequested: false,
      cancelResponse: new Promise<void>((resolve) => {
        releaseCancel = resolve;
      }),
      releaseCancel: () => releaseCancel(),
    };
    this.activeRuns.set(request.params.sessionId, run);
    let result: ControlRunResult;
    try {
      result = await this.backend.run({
        sessionId: request.params.sessionId,
        prompt: normalizedPrompt,
        reason,
        writerLease: session.writerLease,
      });
    } catch (error) {
      if (error instanceof ControlRunError) {
        this.emitEvents(request.params.sessionId, error.events);
      }
      if (run.cancelRequested) {
        await run.cancelResponse;
        this.writeCancelledPrompt(request.id, request.params.sessionId);
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
    this.emitEvents(
      request.params.sessionId,
      result.events,
      result.assistantText,
    );
    if (run.cancelRequested) {
      await run.cancelResponse;
      this.writeCancelledPrompt(request.id, request.params.sessionId);
    } else if (hasControlEvent(result.events, "control/error")) {
      this.writeError(request.id, 49006);
    } else if (hasControlEvent(result.events, "control/stopped")) {
      this.writeCancelledPrompt(request.id, request.params.sessionId);
    } else if (this.mode === "standard") {
      const promptResult: AcpStandardPromptResult = {
        stopReason: "end_turn",
        sessionId: request.params.sessionId,
        runId: result.run_id,
      };
      this.writeResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: promptResult,
      });
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

  private writeCancelledPrompt(id: string | number, sessionId: string): void {
    if (this.mode === "standard") {
      const cancelledResult: AcpStandardPromptResult = {
        stopReason: "cancelled",
        sessionId,
      };
      this.writeResponse({
        jsonrpc: "2.0",
        id,
        result: cancelledResult,
      });
      return;
    }
    this.writeError(id, 49007);
  }

  private finishRun(sessionId: string, run: AcpRunState): void {
    if (this.activeRuns.get(sessionId) === run) {
      this.activeRuns.delete(sessionId);
    }
  }

  private async cancelRun(
    request: Extract<AcpWireRequest, { method: "session/cancel" }>,
    session: AcpSessionState,
  ): Promise<void> {
    const reason = request.params.reason ?? "acp cancel";
    const run = this.activeRuns.get(request.params.sessionId);
    if (run !== undefined) {
      run.cancelRequested = true;
      try {
        const result = await this.backend.stop({
          sessionId: request.params.sessionId,
          message: "",
          reason,
          writerLease: session.writerLease,
        });
        session.writerLease = result.writer_lease;
        this.emitEvents(request.params.sessionId, result.events);
        this.writeCancelAck(request.id, request.params.sessionId, result);
      } finally {
        run.releaseCancel();
      }
      return;
    }
    const result = await this.backend.stop({
      sessionId: request.params.sessionId,
      message: "",
      reason,
      writerLease: session.writerLease,
    });
    session.writerLease = result.writer_lease;
    this.emitEvents(request.params.sessionId, result.events);
    this.writeCancelAck(request.id, request.params.sessionId, result);
  }

  private writeCancelAck(
    id: string | number | undefined,
    sessionId: string,
    result: { run_id: string; writer_lease: DaemonWriterLease },
  ): void {
    if (id === undefined) {
      return;
    }
    if (this.mode === "standard") {
      this.writeResponse({
        jsonrpc: "2.0",
        id,
        result: { sessionId },
      });
      return;
    }
    this.writeResponse({
      jsonrpc: "2.0",
      id,
      result: {
        sessionId,
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
    assistantText?: string,
  ): void {
    if (this.mode === "standard") {
      if (assistantText !== undefined && assistantText.length > 0) {
        const chunkNotification = {
          jsonrpc: "2.0" as const,
          method: "session/update" as const,
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk" as const,
              content: {
                type: "text" as const,
                text: assistantText,
              },
            },
          },
        };
        if (validateSchema(AcpNotificationSchema, chunkNotification).ok) {
          this.writeRaw(chunkNotification);
        }
      }
      for (const event of events) {
        const notification = {
          jsonrpc: "2.0" as const,
          method: "session/update" as const,
          params: {
            sessionId,
            update: {
              sessionUpdate: "status" as const,
              kind: event.kind,
              ...(event.reason === undefined ? {} : { reason: event.reason }),
            },
          },
        };
        const validation = validateSchema(AcpNotificationSchema, notification);
        if (!validation.ok) {
          this.writeError(null, -32603);
          continue;
        }
        this.writeRaw(notification);
      }
      return;
    }
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
