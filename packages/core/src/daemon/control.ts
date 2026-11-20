import { randomUUID } from "node:crypto";
import type {
  DaemonControlEvent,
  DaemonControlResult,
  DaemonScope,
  DaemonWriterLease,
} from "codepunk-protocol";
import { DAEMON_WRITE_LEASE_TTL_MS } from "codepunk-protocol";
import type { CodepunkRuntime } from "../runtime/index.ts";
import { GoalController } from "../session/goal.ts";

export class ControlScopeError extends Error {
  readonly code = "control.scope_denied";

  constructor(message = "control scope is denied") {
    super(message);
    this.name = "ControlScopeError";
  }
}

export class ControlWriteConflictError extends Error {
  readonly code = "control.write_conflict";

  constructor(message = "writer lease conflict") {
    super(message);
    this.name = "ControlWriteConflictError";
  }
}

export class ControlApprovalError extends Error {
  readonly code = "control.approval_mismatch";

  constructor(message = "approval nonce does not match") {
    super(message);
    this.name = "ControlApprovalError";
  }
}

export class ControlNotFoundError extends Error {
  readonly code = "control.not_found";

  constructor(message = "control session was not found") {
    super(message);
    this.name = "ControlNotFoundError";
  }
}

export class ControlRunError extends Error {
  readonly code = "control.run_failed";
  readonly events: readonly DaemonControlEvent[];

  constructor(message: string, events: readonly DaemonControlEvent[]) {
    super(message);
    this.name = "ControlRunError";
    this.events = events;
  }
}

export interface ControlLease {
  writerLease?: DaemonWriterLease;
}

export interface ControlRun extends ControlLease {
  sessionId: string;
  prompt: string;
  reason: string;
}

export interface ControlAction extends ControlLease {
  sessionId: string;
  message: string;
  reason: string;
}

export interface ControlApproval extends ControlLease {
  sessionId: string;
  approvalId: string;
  nonceSha256: string;
  approved: boolean;
  reason: string;
}

export interface ControlBackend {
  newSession(scopes: readonly DaemonScope[]): Promise<{
    sessionId: string;
    writerLease: DaemonWriterLease;
  }>;
  run(request: ControlRun): Promise<DaemonControlResult>;
  steer(request: ControlAction): Promise<DaemonControlResult>;
  stop(request: ControlAction): Promise<DaemonControlResult>;
  plan(request: ControlAction): Promise<DaemonControlResult>;
  goal(request: ControlAction): Promise<DaemonControlResult>;
  approve(request: ControlApproval): Promise<DaemonControlResult>;
  close?(): Promise<void>;
}

interface OpenRuntime {
  runtime: CodepunkRuntime;
  lease: DaemonWriterLease;
  activeRun: boolean;
  leaseHeartbeat: NodeJS.Timeout | null;
}

export class RuntimeControlBackend implements ControlBackend {
  private readonly sessions = new Map<string, OpenRuntime>();
  private nextEventSeq = 1;
  private readonly options: {
    cwd: string;
    createRuntime: () => Promise<CodepunkRuntime>;
    now?: () => Date;
  };

  constructor(options: {
    cwd: string;
    createRuntime: () => Promise<CodepunkRuntime>;
    now?: () => Date;
  }) {
    this.options = options;
  }

  async newSession(
    _scopes: readonly DaemonScope[],
  ): Promise<{ sessionId: string; writerLease: DaemonWriterLease }> {
    const runtime = await this.options.createRuntime();
    const now = this.now();
    const writerLease = this.lease(runtime, now);
    this.sessions.set(runtime.session.sessionId, {
      runtime,
      lease: writerLease,
      activeRun: false,
      leaseHeartbeat: null,
    });
    return { sessionId: runtime.session.sessionId, writerLease };
  }

  async run(request: ControlRun): Promise<DaemonControlResult> {
    const open = this.open(request);
    this.assertLease(open, request.writerLease);
    if (open.activeRun) {
      throw new ControlWriteConflictError(
        `session ${request.sessionId} already has an active run`,
      );
    }
    open.activeRun = true;
    this.startLeaseHeartbeat(open);
    const events = [
      this.event(
        request.sessionId,
        open.lease.run_id,
        "control/accepted",
        request.reason,
      ),
    ];
    let failure: string | null = null;
    try {
      const before = open.runtime.session.allEvents.length;
      await open.runtime.host.session.prompt(request.prompt);
      failure = this.runFailure(open.runtime, before);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure !== null) {
      events.push(
        this.event(
          request.sessionId,
          open.lease.run_id,
          "control/error",
          failure,
        ),
      );
      open.activeRun = false;
      this.stopLeaseHeartbeat(open);
      throw new ControlRunError(failure, events);
    }
    events.push(
      this.event(request.sessionId, open.lease.run_id, "control/completed"),
    );
    open.activeRun = false;
    this.stopLeaseHeartbeat(open);
    return this.result(request, open.lease, events);
  }

  private runFailure(
    runtime: CodepunkRuntime,
    eventStart: number,
  ): string | null {
    const terminal = runtime.session.allEvents
      .slice(eventStart)
      .filter((event) => event.kind === "run/end")
      .at(-1);
    if (terminal === undefined) {
      return "run resolved without a durable run/end event";
    }
    if (terminal.data.state === "settled") {
      return null;
    }
    return (
      terminal.data.termination ??
      `run ended with terminal state ${terminal.data.state}`
    );
  }

  async steer(request: ControlAction): Promise<DaemonControlResult> {
    const open = this.open(request);
    this.assertLease(open, request.writerLease);
    await open.runtime.host.session.steer(request.message);
    return this.result(request, open.lease, [
      this.event(
        request.sessionId,
        open.lease.run_id,
        "control/accepted",
        request.reason,
      ),
      this.event(
        request.sessionId,
        open.lease.run_id,
        "control/message",
        request.message,
      ),
    ]);
  }

  async stop(request: ControlAction): Promise<DaemonControlResult> {
    const open = this.open(request);
    this.assertLease(open, request.writerLease);
    await open.runtime.host.session.abort();
    return this.result(request, open.lease, [
      this.event(
        request.sessionId,
        open.lease.run_id,
        "control/stopped",
        request.reason,
      ),
    ]);
  }

  async plan(request: ControlAction): Promise<DaemonControlResult> {
    const open = this.open(request);
    this.assertLease(open, request.writerLease);
    await open.runtime.planMode.enter();
    return this.result(request, open.lease, [
      this.event(
        request.sessionId,
        open.lease.run_id,
        "control/accepted",
        request.reason,
      ),
      this.event(
        request.sessionId,
        open.lease.run_id,
        "control/message",
        request.message,
      ),
    ]);
  }

  async goal(request: ControlAction): Promise<DaemonControlResult> {
    const open = this.open(request);
    this.assertLease(open, request.writerLease);
    const controller = new GoalController(
      open.runtime.session,
      this.options.now === undefined ? {} : { now: this.options.now },
    );
    await controller.set(request.message);
    return this.result(request, open.lease, [
      this.event(
        request.sessionId,
        open.lease.run_id,
        "control/accepted",
        request.reason,
      ),
      this.event(
        request.sessionId,
        open.lease.run_id,
        "control/message",
        request.message,
      ),
    ]);
  }

  async approve(request: ControlApproval): Promise<DaemonControlResult> {
    const open = this.open(request);
    this.assertLease(open, request.writerLease);
    const result = open.runtime.approval.answer(
      request.approvalId,
      request.nonceSha256,
      request.approved,
    );
    if (result.failure !== null) {
      throw new ControlApprovalError(result.reason);
    }
    return this.result(request, open.lease, [
      this.event(
        request.sessionId,
        open.lease.run_id,
        "control/accepted",
        request.reason,
      ),
    ]);
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const open of sessions) {
      this.stopLeaseHeartbeat(open);
      await open.runtime.dispose().catch(() => undefined);
    }
  }

  private open(request: { sessionId: string }): OpenRuntime {
    const open = this.sessions.get(request.sessionId);
    if (open === undefined) {
      throw new ControlNotFoundError(
        `control session ${request.sessionId} was not found`,
      );
    }
    return open;
  }

  private assertLease(
    open: OpenRuntime,
    supplied: DaemonWriterLease | undefined,
  ): void {
    const expected = open.lease;
    if (
      supplied === undefined ||
      supplied.session_id !== expected.session_id ||
      supplied.run_id !== expected.run_id ||
      supplied.token !== expected.token ||
      supplied.channel_id !== expected.channel_id ||
      Date.parse(expected.expires_at) < this.now().getTime()
    ) {
      throw new ControlWriteConflictError();
    }
    this.refreshLease(open);
  }

  private lease(runtime: CodepunkRuntime, now: Date): DaemonWriterLease {
    return {
      session_id: runtime.session.sessionId,
      run_id: runtime.runId,
      token: randomUUID(),
      channel_id: "codepunk-acp",
      expires_at: new Date(
        now.getTime() + DAEMON_WRITE_LEASE_TTL_MS,
      ).toISOString(),
    };
  }

  private refreshLease(open: OpenRuntime): void {
    open.lease.expires_at = new Date(
      this.now().getTime() + DAEMON_WRITE_LEASE_TTL_MS,
    ).toISOString();
  }

  private startLeaseHeartbeat(open: OpenRuntime): void {
    this.stopLeaseHeartbeat(open);
    this.refreshLease(open);
    const heartbeat = setInterval(
      () => {
        this.refreshLease(open);
      },
      Math.max(1_000, Math.floor(DAEMON_WRITE_LEASE_TTL_MS / 2)),
    );
    heartbeat.unref();
    open.leaseHeartbeat = heartbeat;
  }

  private stopLeaseHeartbeat(open: OpenRuntime): void {
    if (open.leaseHeartbeat !== null) {
      clearInterval(open.leaseHeartbeat);
      open.leaseHeartbeat = null;
    }
  }

  private result(
    request: { sessionId: string },
    lease: DaemonWriterLease,
    events: DaemonControlEvent[],
  ): DaemonControlResult {
    return {
      session_id: request.sessionId,
      run_id: lease.run_id,
      events,
      writer_lease: lease,
    };
  }

  private event(
    sessionId: string,
    runId: string,
    kind: DaemonControlEvent["kind"],
    reason?: string,
  ): DaemonControlEvent {
    return {
      type: "codepunk/daemon-control-event",
      version: 1,
      session_id: sessionId,
      run_id: runId,
      seq: this.nextEventSeq++,
      kind,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
