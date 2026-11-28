import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { WriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { SCHEMA_VERSIONS, type EvidenceRecord } from "codepunk-protocol";
import { checkStoreVersion } from "../compat/index.ts";
import { EvidenceLedger } from "../evidence/index.ts";
import { atomicWriteFile, ensurePrivateDir } from "../platform/fs.ts";
import { createUlid, sha256Text } from "../platform/hash.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import { redactOutputPreview } from "../artifacts/index.ts";
import {
  ClaimStaleError,
  ClaimStore,
  type ClaimRecord,
} from "../workers/claims.ts";

export const BACKGROUND_TASK_VERSION = SCHEMA_VERSIONS.backgroundTask;
export const BACKGROUND_DEFAULT_MAX_TASKS = 8;
export const BACKGROUND_DEFAULT_MAX_CONCURRENT = 2;
export const BACKGROUND_DEFAULT_MAX_STEERING = 16;
export const BACKGROUND_DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;
export const BACKGROUND_DEFAULT_STOP_TIMEOUT_MS = 2_000;

export type BackgroundTaskStatus =
  | "queued"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped"
  | "rejected";

export interface BackgroundTaskSpec {
  id?: string;
  title: string;
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface BackgroundTaskSnapshot {
  version: 1;
  id: string;
  session_id: string;
  title: string;
  command: string;
  argv: string[];
  cwd: string;
  status: BackgroundTaskStatus;
  pid: number | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  signal: string | null;
  stdout_ref: string;
  stderr_ref: string;
  evidence_ref: string;
  steering: string[];
  steering_history: string[];
  claim: ClaimRecord | null;
  error: string | null;
}

export interface BackgroundTaskLogs {
  id: string;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  evidence_ref: string;
}

export interface BackgroundTaskManagerOptions {
  paths: ProjectPaths;
  sessionId: string;
  now?: () => Date;
  maxTasks?: number;
  maxConcurrent?: number;
  maxSteeringQueue?: number;
  maxLogBytes?: number;
  stopTimeoutMs?: number;
  claimStore?: ClaimStore;
  claimLeaseMs?: number;
}

export class BackgroundTaskError extends Error {
  readonly code: string;
  readonly taskId: string | null;
  readonly evidenceRef: string | null;

  constructor(
    code: string,
    message: string,
    taskId: string | null = null,
    evidenceRef: string | null = null,
  ) {
    super(message);
    this.name = "BackgroundTaskError";
    this.code = code;
    this.taskId = taskId;
    this.evidenceRef = evidenceRef;
  }
}

export class BackgroundQueueFullError extends BackgroundTaskError {
  constructor(
    message: string,
    taskId: string | null,
    evidenceRef: string | null,
  ) {
    super("background.queue_full", message, taskId, evidenceRef);
    this.name = "BackgroundQueueFullError";
  }
}

export class BackgroundTaskNotFoundError extends BackgroundTaskError {
  constructor(taskId: string) {
    super(
      "background.not_found",
      `background task ${taskId} was not found`,
      taskId,
    );
    this.name = "BackgroundTaskNotFoundError";
  }
}

interface ManagedTask {
  snapshot: BackgroundTaskSnapshot;
  ledger: EvidenceLedger;
  recordPath: string;
  evidencePath: string;
  stdoutPath: string;
  stderrPath: string;
  child: ChildProcessWithoutNullStreams | null;
  stdoutSink: BoundedLog | null;
  stderrSink: BoundedLog | null;
  claim: ClaimRecord | null;
  env: NodeJS.ProcessEnv;
  leaseTimer: NodeJS.Timeout | null;
  done: Promise<void>;
  resolveDone: () => void;
  finalized: boolean;
  stopRequested: boolean;
  stopFailed: boolean;
  logOverflow: boolean;
}

function snapshotStatus(value: unknown): value is BackgroundTaskStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "stopping" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped" ||
    value === "rejected"
  );
}

function parsePersistedSnapshot(
  value: unknown,
  id: string,
): BackgroundTaskSnapshot | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const snapshot = value as Partial<BackgroundTaskSnapshot>;
  // Spec 0016 C3: accept older snapshot versions, but refuse (skip) the
  // object when the version is missing, not a positive integer, or newer
  // than this build. Skipping never rewrites the persisted file.
  try {
    checkStoreVersion(
      "background task store",
      snapshot.version,
      BACKGROUND_TASK_VERSION,
    );
  } catch {
    return null;
  }
  if (
    snapshot.id !== id ||
    typeof snapshot.session_id !== "string" ||
    typeof snapshot.title !== "string" ||
    typeof snapshot.command !== "string" ||
    !Array.isArray(snapshot.argv) ||
    snapshot.argv.some((entry) => typeof entry !== "string") ||
    typeof snapshot.cwd !== "string" ||
    !snapshotStatus(snapshot.status) ||
    !(snapshot.pid === null || Number.isSafeInteger(snapshot.pid)) ||
    typeof snapshot.created_at !== "string" ||
    !(
      snapshot.started_at === null || typeof snapshot.started_at === "string"
    ) ||
    !(snapshot.ended_at === null || typeof snapshot.ended_at === "string") ||
    !(
      snapshot.exit_code === null || Number.isSafeInteger(snapshot.exit_code)
    ) ||
    !(snapshot.signal === null || typeof snapshot.signal === "string") ||
    typeof snapshot.stdout_ref !== "string" ||
    typeof snapshot.stderr_ref !== "string" ||
    typeof snapshot.evidence_ref !== "string" ||
    !Array.isArray(snapshot.steering) ||
    snapshot.steering.some((entry) => typeof entry !== "string") ||
    !Array.isArray(snapshot.steering_history) ||
    snapshot.steering_history.some((entry) => typeof entry !== "string") ||
    !(
      snapshot.claim === null ||
      (typeof snapshot.claim === "object" &&
        typeof snapshot.claim.claim_id === "string")
    ) ||
    !(snapshot.error === null || typeof snapshot.error === "string")
  ) {
    return null;
  }
  return snapshot as BackgroundTaskSnapshot;
}

class BoundedLog {
  private readonly stream: WriteStream;
  private readonly maxBytes: number;
  private readonly onOverflow: () => void;
  private readonly onError: (error: Error) => void;
  private bytes = 0;
  private overflow = false;
  private failed = false;

  private constructor(
    stream: WriteStream,
    maxBytes: number,
    onOverflow: () => void,
    onError: (error: Error) => void,
  ) {
    this.stream = stream;
    this.maxBytes = maxBytes;
    this.onOverflow = onOverflow;
    this.onError = onError;
    this.stream.on("error", (error) => this.fail(error));
  }

  static async create(
    filePath: string,
    maxBytes: number,
    onOverflow: () => void,
    onError: (error: Error) => void,
  ): Promise<BoundedLog> {
    const handle = await fs.open(filePath, "w", 0o600);
    try {
      return new BoundedLog(
        handle.createWriteStream(),
        maxBytes,
        onOverflow,
        onError,
      );
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private fail(error: Error): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.onError(error);
  }

  write(chunk: Buffer): void {
    if (this.failed || this.overflow) {
      return;
    }
    const remaining = this.maxBytes - this.bytes;
    if (remaining <= 0) {
      this.overflow = true;
      this.onOverflow();
      return;
    }
    const bytes = chunk.subarray(0, remaining);
    this.stream.write(bytes);
    this.bytes += bytes.byteLength;
    if (chunk.byteLength > remaining) {
      this.overflow = true;
      this.onOverflow();
    }
  }

  async close(): Promise<void> {
    if (!this.stream.destroyed) {
      this.stream.end();
    }
    await finished(this.stream).catch(() => undefined);
  }
}

function cloneSnapshot(
  snapshot: BackgroundTaskSnapshot,
): BackgroundTaskSnapshot {
  return {
    ...snapshot,
    argv: [...snapshot.argv],
    steering: [...snapshot.steering],
    steering_history: [...snapshot.steering_history],
    claim: snapshot.claim === null ? null : { ...snapshot.claim },
  };
}

function isTerminal(status: BackgroundTaskStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "stopped" ||
    status === "rejected"
  );
}

function isActive(status: BackgroundTaskStatus): boolean {
  return status === "queued" || status === "running" || status === "stopping";
}

function taskIdIsSafe(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(id);
}

function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

export class BackgroundTaskManager {
  private readonly paths: ProjectPaths;
  private sessionId: string;
  private readonly now: () => Date;
  private readonly maxTasks: number;
  private readonly maxConcurrent: number;
  private readonly maxSteeringQueue: number;
  private readonly maxLogBytes: number;
  private readonly stopTimeoutMs: number;
  private readonly claimStore: ClaimStore;
  private readonly tasks = new Map<string, ManagedTask>();
  private readonly stopOperations = new Map<
    string,
    Promise<BackgroundTaskSnapshot>
  >();
  private hydration: Promise<void> | null = null;
  private pumping = false;

  constructor(options: BackgroundTaskManagerOptions) {
    this.paths = options.paths;
    this.sessionId = options.sessionId;
    this.now = options.now ?? (() => new Date());
    this.maxTasks = Math.max(
      1,
      options.maxTasks ?? BACKGROUND_DEFAULT_MAX_TASKS,
    );
    this.maxConcurrent = Math.max(
      1,
      Math.min(
        this.maxTasks,
        options.maxConcurrent ?? BACKGROUND_DEFAULT_MAX_CONCURRENT,
      ),
    );
    this.maxSteeringQueue = Math.max(
      1,
      options.maxSteeringQueue ?? BACKGROUND_DEFAULT_MAX_STEERING,
    );
    this.maxLogBytes = Math.max(
      1,
      options.maxLogBytes ?? BACKGROUND_DEFAULT_MAX_LOG_BYTES,
    );
    this.stopTimeoutMs = Math.max(
      100,
      options.stopTimeoutMs ?? BACKGROUND_DEFAULT_STOP_TIMEOUT_MS,
    );
    this.claimStore =
      options.claimStore ??
      new ClaimStore({
        paths: this.paths,
        ...(options.claimLeaseMs === undefined
          ? {}
          : { leaseMs: options.claimLeaseMs }),
        now: this.now,
      });
  }

  ps(): BackgroundTaskSnapshot[] {
    return [...this.tasks.values()]
      .map((task) => cloneSnapshot(task.snapshot))
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Loads durable task records so a fresh TUI process can observe tasks that
   * were started by an earlier process. A task that was active when the old
   * process went away is shown as failed instead of pretending the new
   * manager still owns its child process.
   */
  async hydrate(): Promise<void> {
    if (this.hydration !== null) {
      return this.hydration;
    }
    const pending = this.hydrateOnce().finally(() => {
      if (this.hydration === pending) {
        this.hydration = null;
      }
    });
    this.hydration = pending;
    return pending;
  }

  private async hydrateOnce(): Promise<void> {
    const root = path.join(this.paths.projectDir, "background");
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !taskIdIsSafe(entry.name) ||
        this.tasks.has(entry.name)
      ) {
        continue;
      }
      const taskDir = path.join(root, entry.name);
      const recordPath = path.join(taskDir, "task.json");
      let snapshot: BackgroundTaskSnapshot | null = null;
      try {
        snapshot = parsePersistedSnapshot(
          JSON.parse(await fs.readFile(recordPath, "utf8")) as unknown,
          entry.name,
        );
      } catch {
        continue;
      }
      if (snapshot === null) {
        continue;
      }
      let ledger: EvidenceLedger;
      try {
        ledger = await EvidenceLedger.open(
          path.join(taskDir, "evidence.jsonl"),
        );
      } catch {
        continue;
      }
      if (isActive(snapshot.status)) {
        snapshot.status = "failed";
        snapshot.ended_at = this.now().toISOString();
        snapshot.error ??=
          "background manager restarted before the task reported a terminal state; inspect the process before restarting it";
      }
      const task: ManagedTask = {
        snapshot,
        ledger,
        recordPath,
        evidencePath: path.join(taskDir, "evidence.jsonl"),
        stdoutPath: path.join(
          this.paths.artifactsDir,
          "background",
          entry.name,
          "stdout.log",
        ),
        stderrPath: path.join(
          this.paths.artifactsDir,
          "background",
          entry.name,
          "stderr.log",
        ),
        child: null,
        stdoutSink: null,
        stderrSink: null,
        claim: snapshot.claim,
        env: { ...process.env },
        leaseTimer: null,
        done: Promise.resolve(),
        resolveDone: () => undefined,
        finalized: true,
        stopRequested: false,
        stopFailed: false,
        logOverflow: false,
      };
      this.tasks.set(entry.name, task);
    }
  }

  status(id: string): BackgroundTaskSnapshot {
    return cloneSnapshot(this.task(id).snapshot);
  }

  async start(spec: BackgroundTaskSpec): Promise<BackgroundTaskSnapshot> {
    if (process.platform === "win32") {
      throw new BackgroundTaskError(
        "background.unsupported_platform",
        "background tasks require POSIX process groups",
      );
    }
    if (spec.command.trim().length === 0) {
      throw new BackgroundTaskError(
        "background.invalid_command",
        "background command is required",
      );
    }
    const id = spec.id ?? createUlid(this.now());
    if (!taskIdIsSafe(id)) {
      throw new BackgroundTaskError(
        "background.invalid_id",
        "background task id must be path-safe",
      );
    }
    const active = [...this.tasks.values()].filter((task) =>
      isActive(task.snapshot.status),
    );
    if (active.length >= this.maxTasks) {
      const rejected = await this.rejectStart(
        spec,
        "background task queue is full",
      );
      throw new BackgroundQueueFullError(
        "background task queue is full",
        rejected.snapshot.id,
        rejected.snapshot.evidence_ref,
      );
    }
    if (this.tasks.has(id)) {
      throw new BackgroundTaskError(
        "background.already_exists",
        `background task ${id} already exists`,
        id,
      );
    }
    const taskDir = path.join(this.paths.projectDir, "background", id);
    const artifactDir = path.join(this.paths.artifactsDir, "background", id);
    await ensurePrivateDir(taskDir);
    await ensurePrivateDir(artifactDir);
    const evidencePath = path.join(taskDir, "evidence.jsonl");
    const ledger = await EvidenceLedger.open(evidencePath);
    const snapshot: BackgroundTaskSnapshot = {
      version: BACKGROUND_TASK_VERSION,
      id,
      session_id: this.sessionId,
      title: spec.title.trim().length === 0 ? id : spec.title,
      command: spec.command,
      argv: [...(spec.args ?? [])],
      cwd: path.resolve(spec.cwd ?? this.paths.cwd),
      status: "queued",
      pid: null,
      created_at: this.now().toISOString(),
      started_at: null,
      ended_at: null,
      exit_code: null,
      signal: null,
      stdout_ref: path.posix.join("background", id, "stdout.log"),
      stderr_ref: path.posix.join("background", id, "stderr.log"),
      evidence_ref: path.posix.join("background", id, "evidence.jsonl"),
      steering: [],
      steering_history: [],
      claim: null,
      error: null,
    };
    const done = Promise.withResolvers<void>();
    const task: ManagedTask = {
      snapshot,
      ledger,
      recordPath: path.join(taskDir, "task.json"),
      evidencePath,
      stdoutPath: path.join(artifactDir, "stdout.log"),
      stderrPath: path.join(artifactDir, "stderr.log"),
      child: null,
      stdoutSink: null,
      stderrSink: null,
      claim: null,
      env: { ...process.env, ...spec.env },
      leaseTimer: null,
      done: done.promise,
      resolveDone: done.resolve,
      finalized: false,
      stopRequested: false,
      stopFailed: false,
      logOverflow: false,
    };
    try {
      const claim = await this.claimStore.acquire(
        `background:${id}`,
        `background:${this.sessionId}`,
      );
      task.claim = claim;
      snapshot.claim = claim;
      this.startLeaseHeartbeat(task);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      snapshot.status = "rejected";
      snapshot.ended_at = this.now().toISOString();
      snapshot.error = message;
      await this.appendEvidence(task, {
        rule: "background.lease_conflict",
        decision: "deny",
        outcome: "denied",
        message,
      });
      await this.persist(task);
      this.tasks.set(id, task);
      done.resolve();
      throw new BackgroundTaskError(
        "background.lease_conflict",
        message,
        id,
        snapshot.evidence_ref,
      );
    }
    try {
      await this.appendEvidence(task, {
        rule: "background.start",
        decision: "allow",
        message: commandLine(snapshot.command, snapshot.argv),
      });
      await this.persist(task);
    } catch (error) {
      this.stopLeaseHeartbeat(task);
      await this.releaseClaim(task);
      throw error;
    }
    this.tasks.set(id, task);
    await this.pump();
    return cloneSnapshot(task.snapshot);
  }

  async steer(id: string, message: string): Promise<BackgroundTaskSnapshot> {
    const task = this.task(id);
    if (isTerminal(task.snapshot.status)) {
      throw new BackgroundTaskError(
        "background.already_finished",
        `background task ${id} is already ${task.snapshot.status}`,
        id,
        task.snapshot.evidence_ref,
      );
    }
    if (message.trim().length === 0) {
      throw new BackgroundTaskError(
        "background.invalid_steering",
        "steering message is required",
        id,
        task.snapshot.evidence_ref,
      );
    }
    if (task.snapshot.steering.length >= this.maxSteeringQueue) {
      const messageText = "background steering queue is full";
      await this.appendEvidence(task, {
        rule: "background.queue_full",
        decision: "deny",
        outcome: "denied",
        message: messageText,
      });
      throw new BackgroundQueueFullError(
        messageText,
        id,
        task.snapshot.evidence_ref,
      );
    }
    task.snapshot.steering.push(message);
    if (task.snapshot.status === "running") {
      if (task.child === null || task.child.stdin.destroyed) {
        task.snapshot.steering.pop();
        await this.failSteering(task, "background process stdin is closed");
      }
      await this.deliverSteering(task, message);
      task.snapshot.steering.pop();
      task.snapshot.steering_history.push(message);
    }
    await this.appendEvidence(task, {
      rule: "background.steer",
      decision: "allow",
      message: `steering bytes=${Buffer.byteLength(message)}`,
    });
    void this.persist(task);
    return cloneSnapshot(task.snapshot);
  }

  async logs(id: string, maxBytes = 64 * 1024): Promise<BackgroundTaskLogs> {
    const task = this.task(id);
    const limit = Math.max(1, maxBytes);
    const [stdout, stderr] = await Promise.all([
      readBounded(task.stdoutPath, limit),
      readBounded(task.stderrPath, limit),
    ]);
    return {
      id,
      stdout: stdout.value,
      stderr: stderr.value,
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
      evidence_ref: task.snapshot.evidence_ref,
    };
  }

  async wait(id: string): Promise<BackgroundTaskSnapshot> {
    const task = this.task(id);
    await task.done;
    return cloneSnapshot(task.snapshot);
  }

  async stop(id: string): Promise<BackgroundTaskSnapshot> {
    const existing = this.stopOperations.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const pending = this.stopOnce(id).finally(() => {
      if (this.stopOperations.get(id) === pending) {
        this.stopOperations.delete(id);
      }
    });
    this.stopOperations.set(id, pending);
    return pending;
  }

  private async stopOnce(id: string): Promise<BackgroundTaskSnapshot> {
    const task = this.task(id);
    if (isTerminal(task.snapshot.status)) {
      return cloneSnapshot(task.snapshot);
    }
    try {
      if (task.claim === null) {
        throw new ClaimStaleError();
      }
      await this.claimStore.assertLive(task.claim);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.appendEvidence(task, {
        rule: "background.stale_lease",
        decision: "deny",
        outcome: "denied",
        message,
      });
      throw new BackgroundTaskError(
        "background.stale_lease",
        `background task ${id} no longer owns a live lease`,
        id,
        task.snapshot.evidence_ref,
      );
    }
    if (task.snapshot.status === "queued") {
      task.stopRequested = true;
      task.snapshot.status = "stopped";
      task.snapshot.ended_at = this.now().toISOString();
      await this.appendEvidence(task, {
        rule: "background.stop",
        decision: "allow",
        outcome: "cancelled",
        message: "queued task stopped before spawn",
      });
      this.stopLeaseHeartbeat(task);
      await this.releaseClaim(task);
      await this.persist(task);
      task.resolveDone();
      await this.pump();
      return cloneSnapshot(task.snapshot);
    }
    task.stopRequested = true;
    task.snapshot.status = "stopping";
    await this.persist(task);
    await this.appendEvidence(task, {
      rule: "background.stop",
      decision: "allow",
      outcome: "cancelled",
      message: "stop requested",
    });
    const pid = task.snapshot.pid;
    if (pid === null) {
      throw new BackgroundTaskError(
        "background.stop_failed",
        `background task ${id} has no pid`,
        id,
        task.snapshot.evidence_ref,
      );
    }
    this.signalGroup(pid, "SIGTERM");
    if (!(await this.waitForDone(task, this.stopTimeoutMs))) {
      this.signalGroup(pid, "SIGKILL");
      if (!(await this.waitForDone(task, this.stopTimeoutMs))) {
        await this.failStop(task, "process group did not exit after SIGKILL");
      }
    }
    if (this.groupExists(pid)) {
      this.signalGroup(pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (this.groupExists(pid)) {
        await this.failStop(task, "process group is still alive after SIGKILL");
      }
    }
    return cloneSnapshot(task.snapshot);
  }

  private task(id: string): ManagedTask {
    const task = this.tasks.get(id);
    if (task === undefined) {
      throw new BackgroundTaskNotFoundError(id);
    }
    return task;
  }

  private async rejectStart(
    spec: BackgroundTaskSpec,
    message: string,
  ): Promise<{ snapshot: BackgroundTaskSnapshot }> {
    const id = spec.id ?? createUlid(this.now());
    if (!taskIdIsSafe(id)) {
      throw new BackgroundTaskError(
        "background.invalid_id",
        "background task id must be path-safe",
      );
    }
    const taskDir = path.join(this.paths.projectDir, "background", id);
    const artifactDir = path.join(this.paths.artifactsDir, "background", id);
    await ensurePrivateDir(taskDir);
    await ensurePrivateDir(artifactDir);
    const evidencePath = path.join(taskDir, "evidence.jsonl");
    const ledger = await EvidenceLedger.open(evidencePath);
    const snapshot: BackgroundTaskSnapshot = {
      version: BACKGROUND_TASK_VERSION,
      id,
      session_id: this.sessionId,
      title: spec.title,
      command: spec.command,
      argv: [...(spec.args ?? [])],
      cwd: path.resolve(spec.cwd ?? this.paths.cwd),
      status: "rejected",
      pid: null,
      created_at: this.now().toISOString(),
      started_at: null,
      ended_at: this.now().toISOString(),
      exit_code: null,
      signal: null,
      stdout_ref: path.posix.join("background", id, "stdout.log"),
      stderr_ref: path.posix.join("background", id, "stderr.log"),
      evidence_ref: path.posix.join("background", id, "evidence.jsonl"),
      steering: [],
      steering_history: [],
      claim: null,
      error: message,
    };
    const task: ManagedTask = {
      snapshot,
      ledger,
      recordPath: path.join(taskDir, "task.json"),
      evidencePath,
      stdoutPath: path.join(artifactDir, "stdout.log"),
      stderrPath: path.join(artifactDir, "stderr.log"),
      child: null,
      stdoutSink: null,
      stderrSink: null,
      claim: null,
      env: { ...process.env, ...spec.env },
      leaseTimer: null,
      done: Promise.resolve(),
      resolveDone: () => undefined,
      finalized: true,
      stopRequested: false,
      stopFailed: false,
      logOverflow: false,
    };
    await this.appendEvidence(task, {
      rule: "background.queue_full",
      decision: "deny",
      outcome: "denied",
      message,
    });
    await this.persist(task);
    return { snapshot };
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (true) {
        const running = [...this.tasks.values()].filter(
          (task) =>
            task.snapshot.status === "running" ||
            task.snapshot.status === "stopping",
        ).length;
        if (running >= this.maxConcurrent) {
          return;
        }
        const next = [...this.tasks.values()].find(
          (task) => task.snapshot.status === "queued",
        );
        if (next === undefined) {
          return;
        }
        await this.spawnTask(next);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async spawnTask(task: ManagedTask): Promise<void> {
    try {
      if (task.claim === null) {
        throw new ClaimStaleError();
      }
      await this.claimStore.assertLive(task.claim);
    } catch (error) {
      await this.failSpawn(
        task,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    try {
      task.stdoutSink = await BoundedLog.create(
        task.stdoutPath,
        this.maxLogBytes,
        () => this.onLogOverflow(task),
        (error) => this.onLogFailure(task, error),
      );
      task.stderrSink = await BoundedLog.create(
        task.stderrPath,
        this.maxLogBytes,
        () => this.onLogOverflow(task),
        (error) => this.onLogFailure(task, error),
      );
    } catch (error) {
      await Promise.all([
        task.stdoutSink?.close() ?? Promise.resolve(),
        task.stderrSink?.close() ?? Promise.resolve(),
      ]);
      await this.failSpawn(
        task,
        `background log artifact is not writable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    task.snapshot.status = "running";
    task.snapshot.started_at = this.now().toISOString();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(task.snapshot.command, task.snapshot.argv, {
        cwd: task.snapshot.cwd,
        env: task.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      await this.finalize(task, null, null, error);
      return;
    }
    task.child = child;
    task.snapshot.pid = child.pid ?? null;
    this.startLeaseHeartbeat(task);
    child.stdout.on("data", (chunk: Buffer) => {
      task.stdoutSink?.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      task.stderrSink?.write(chunk);
    });
    child.stdin.on("error", (error) => {
      task.snapshot.error = `background stdin failed: ${error.message}`;
    });
    child.once("error", (error) => {
      void this.finalize(task, null, null, error);
    });
    child.once("close", (code, signal) => {
      void this.finalize(task, code, signal, null);
    });
    while (task.snapshot.steering.length > 0) {
      const message = task.snapshot.steering[0]!;
      try {
        await this.deliverSteering(task, message);
      } catch {
        return;
      }
      task.snapshot.steering.shift();
      task.snapshot.steering_history.push(message);
    }
    await this.persist(task);
  }

  private async deliverSteering(
    task: ManagedTask,
    message: string,
  ): Promise<void> {
    const child = task.child;
    if (child === null || child.stdin.destroyed) {
      await this.failSteering(task, "background process stdin is closed");
    }
    const error = await new Promise<Error | null>((resolve) => {
      try {
        child!.stdin.write(`${message}\n`, (writeError) => {
          resolve(writeError ?? null);
        });
      } catch (writeError) {
        resolve(
          writeError instanceof Error
            ? writeError
            : new Error(String(writeError)),
        );
      }
    });
    if (error !== null) {
      await this.failSteering(task, error.message);
    }
  }

  private async failSteering(
    task: ManagedTask,
    message: string,
  ): Promise<never> {
    const failure = `steering delivery failed: ${message}`;
    task.snapshot.error = failure;
    await this.appendEvidence(task, {
      rule: "background.steer_failed",
      decision: "deny",
      outcome: "failed",
      message: failure,
    });
    const pid = task.snapshot.pid;
    if (pid !== null) {
      this.signalGroup(pid, "SIGKILL");
    }
    await this.persist(task);
    throw new BackgroundTaskError(
      "background.steer_failed",
      failure,
      task.snapshot.id,
      task.snapshot.evidence_ref,
    );
  }

  private async failSpawn(task: ManagedTask, message: string): Promise<void> {
    this.stopLeaseHeartbeat(task);
    task.snapshot.status = "failed";
    task.snapshot.error = `background spawn refused: ${message}`;
    task.snapshot.ended_at = this.now().toISOString();
    await this.appendEvidence(task, {
      rule: "background.spawn_refused",
      decision: "deny",
      outcome: "failed",
      message: task.snapshot.error,
    });
    await this.releaseClaim(task);
    await this.persist(task);
    task.resolveDone();
  }

  private onLogOverflow(task: ManagedTask): void {
    if (task.logOverflow) {
      return;
    }
    task.logOverflow = true;
    task.snapshot.error = `background log exceeded ${this.maxLogBytes} bytes`;
    const pid = task.snapshot.pid;
    if (pid !== null) {
      this.signalGroup(pid, "SIGKILL");
    }
  }

  private onLogFailure(task: ManagedTask, error: Error): void {
    if (task.logOverflow) {
      return;
    }
    task.logOverflow = true;
    task.snapshot.error = `background log write failed: ${error.message}`;
    const pid = task.snapshot.pid;
    if (pid !== null) {
      this.signalGroup(pid, "SIGKILL");
    }
  }

  private startLeaseHeartbeat(task: ManagedTask): void {
    const claim = task.claim;
    if (claim === null) {
      return;
    }
    const interval = Math.max(
      10,
      Math.floor(
        (Date.parse(claim.expires_at) - Date.parse(claim.renewed_at)) / 3,
      ),
    );
    task.leaseTimer = setInterval(() => {
      void this.claimStore
        .renew(claim)
        .then((renewed) => {
          task.claim = renewed;
          task.snapshot.claim = renewed;
        })
        .catch((error: unknown) => {
          task.snapshot.error =
            error instanceof ClaimStaleError
              ? "background lease was lost"
              : `background lease renewal failed: ${
                  error instanceof Error ? error.message : String(error)
                }`;
          const pid = task.snapshot.pid;
          if (pid !== null) {
            this.signalGroup(pid, "SIGKILL");
          }
        });
    }, interval);
    task.leaseTimer.unref();
  }

  private stopLeaseHeartbeat(task: ManagedTask): void {
    if (task.leaseTimer !== null) {
      clearInterval(task.leaseTimer);
      task.leaseTimer = null;
    }
  }

  private async finalize(
    task: ManagedTask,
    code: number | null,
    signal: NodeJS.Signals | null,
    failure: unknown,
  ): Promise<void> {
    if (task.finalized) {
      return;
    }
    task.finalized = true;
    this.stopLeaseHeartbeat(task);
    await Promise.all([
      task.stdoutSink?.close() ?? Promise.resolve(),
      task.stderrSink?.close() ?? Promise.resolve(),
    ]);
    task.snapshot.exit_code = code;
    task.snapshot.signal = signal;
    task.snapshot.ended_at = this.now().toISOString();
    const failureMessage =
      failure === undefined || failure === null
        ? null
        : failure instanceof Error
          ? failure.message
          : String(failure);
    if (failureMessage !== null) {
      task.snapshot.error = failureMessage;
    }
    task.snapshot.status = task.stopRequested
      ? task.stopFailed
        ? "failed"
        : "stopped"
      : task.logOverflow || code !== 0 || failureMessage !== null
        ? "failed"
        : "completed";
    if (task.snapshot.status === "failed" && task.snapshot.error === null) {
      task.snapshot.error =
        code === null
          ? `background process ended with signal ${signal ?? "unknown"}`
          : `background process exited with code ${code}`;
    }
    const [stdout, stderr] = await Promise.all([
      readBounded(task.stdoutPath, this.maxLogBytes),
      readBounded(task.stderrPath, this.maxLogBytes),
    ]);
    await this.appendEvidence(task, {
      rule: "background.end",
      decision: "allow",
      outcome:
        task.snapshot.status === "completed"
          ? "completed"
          : task.snapshot.status === "stopped"
            ? "cancelled"
            : "failed",
      message: task.snapshot.error ?? "",
      exitCode: code,
      outputSha256: sha256Text(`${stdout.value}\n${stderr.value}`),
    });
    await this.releaseClaim(task);
    await this.persist(task);
    task.resolveDone();
    await this.pump();
  }

  private async failStop(task: ManagedTask, message: string): Promise<never> {
    task.stopFailed = true;
    task.snapshot.status = "failed";
    task.snapshot.error = message;
    task.snapshot.ended_at = this.now().toISOString();
    await this.appendEvidence(task, {
      rule: "background.stop_failed",
      decision: "deny",
      outcome: "failed",
      message,
    });
    await this.persist(task);
    throw new BackgroundTaskError(
      "background.stop_failed",
      message,
      task.snapshot.id,
      task.snapshot.evidence_ref,
    );
  }

  private async waitForDone(
    task: ManagedTask,
    timeoutMs: number,
  ): Promise<boolean> {
    return Promise.race([
      task.done.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
  }

  private signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }

  private groupExists(pid: number): boolean {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private async releaseClaim(task: ManagedTask): Promise<void> {
    if (task.claim === null) {
      return;
    }
    try {
      await this.claimStore.release(task.claim);
    } catch (error) {
      task.snapshot.error =
        task.snapshot.error ??
        `background lease release failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
    }
    task.claim = null;
  }

  private async persist(task: ManagedTask): Promise<void> {
    await atomicWriteFile(
      task.recordPath,
      `${JSON.stringify(task.snapshot, null, 2)}\n`,
    );
  }

  private async appendEvidence(
    task: ManagedTask,
    input: {
      rule: string;
      decision: "allow" | "deny";
      outcome?: "completed" | "failed" | "cancelled" | "denied";
      message: string;
      exitCode?: number | null;
      outputSha256?: string | null;
    },
  ): Promise<EvidenceRecord> {
    const output = redactOutputPreview(input.message);
    return task.ledger.append({
      task_id: task.snapshot.id,
      run_id: `background:${task.snapshot.id}`,
      session_id: task.snapshot.session_id,
      source: "user_bash",
      tool: "background",
      tool_call_id: `background:${task.snapshot.id}`,
      decision: input.decision,
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      rule: input.rule,
      rule_sha256: sha256Text(input.rule),
      policy_layers: [],
      approval: null,
      command: commandLine(task.snapshot.command, task.snapshot.argv),
      command_argv: [task.snapshot.command, ...task.snapshot.argv],
      cwd: task.snapshot.cwd,
      workspace_root: this.paths.deliveryRoot,
      path_check: { performed: false, target: null },
      sandbox: {
        backend: "none",
        version: null,
        profile_sha256: null,
      },
      effects: { fs: "unknown", shell: true, network: false },
      coverage: "uncovered",
      coverage_basis: ["background task lifecycle"],
      exit_code: input.exitCode ?? task.snapshot.exit_code,
      duration_ms:
        task.snapshot.started_at === null
          ? 0
          : Math.max(
              0,
              this.now().getTime() - Date.parse(task.snapshot.started_at),
            ),
      before_sha256: null,
      after_sha256: null,
      diff_sha256: null,
      output_ref:
        task.snapshot.status === "queued" ? null : task.snapshot.stdout_ref,
      output_sha256: input.outputSha256 ?? null,
      output_preview: output,
      empty_result: null,
      executor: null,
      vcs: { commit: null, tree: null, base_commit: null },
      memory: {
        ids: [],
        action: "none",
        query_sha256: null,
        cap: 0,
        truncated: false,
      },
      created_at: this.now().toISOString(),
    });
  }
}

async function readBounded(
  filePath: string,
  maxBytes: number,
): Promise<{ value: string; truncated: boolean }> {
  try {
    const stat = await fs.stat(filePath);
    const handle = await fs.open(filePath, "r");
    try {
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      return {
        value: buffer.toString("utf8"),
        truncated: stat.size > maxBytes,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { value: "", truncated: false };
    }
    throw error;
  }
}
