import type { TaskSpec } from "codepunk-protocol";
import { pathCoveredBySet } from "../delivery/merge.ts";

export interface WorkerBudget {
  maxWallMs: number;
  maxToolCalls: number;
  maxDiskBytes: number;
}

export interface WorkerUsage {
  wall_ms: number;
  tool_calls: number;
  disk_bytes: number;
}

export interface WorkerConfinement {
  readonly worktree: string;
  assertWriteTarget(target: string, writeSet: readonly string[]): string;
}

export interface WorkerJob {
  id: string;
  task: TaskSpec;
  sandbox?: WorkerConfinement;
  run(context: {
    signal: AbortSignal;
    budget: WorkerBudget;
    consumeToolCall(): void;
    consumeDiskBytes(bytes: number): void;
  }): Promise<unknown>;
}

export type WorkerStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";

export interface WorkerResult {
  id: string;
  task_id: string;
  status: WorkerStatus;
  started_at: string;
  ended_at: string;
  usage: WorkerUsage;
  value: unknown;
  error: string | null;
}

export interface WorkerEvent {
  type: "worker/start" | "worker/end";
  worker_id: string;
  task_id: string;
  status: WorkerStatus;
  at: string;
  usage: WorkerUsage;
  error: string | null;
}

function assertDisjoint(jobs: readonly WorkerJob[]): void {
  for (let left = 0; left < jobs.length; left += 1) {
    for (let right = left + 1; right < jobs.length; right += 1) {
      const a = jobs[left]!;
      const b = jobs[right]!;
      if (
        a.task.write_set.some((entry) =>
          b.task.write_set.some(
            (candidate) =>
              pathCoveredBySet(entry, [candidate]) ||
              pathCoveredBySet(candidate, [entry]),
          ),
        )
      ) {
        throw new Error(
          `workers ${a.id} and ${b.id} have overlapping write sets`,
        );
      }
    }
  }
}

function assertConfinement(
  jobs: readonly WorkerJob[],
  maxConcurrency: number,
): void {
  if (maxConcurrency <= 1) {
    return;
  }
  const unconfined = jobs.filter((job) => job.sandbox === undefined);
  if (unconfined.length > 0) {
    throw new Error(
      `parallel workers require WorkerSandbox confinement: ${unconfined
        .map((job) => job.id)
        .join(", ")}`,
    );
  }
}

export class WorkerPool {
  private readonly maxConcurrency: number;
  private readonly budget: WorkerBudget;
  private readonly now: () => Date;
  private readonly onEvent: (event: WorkerEvent) => void | Promise<void>;
  private readonly results: WorkerResult[] = [];
  private readonly active = new Set<Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private stopped = false;

  constructor(
    options: {
      maxConcurrency?: number;
      budget?: WorkerBudget;
      onEvent?: (event: WorkerEvent) => void | Promise<void>;
      now?: () => Date;
    } = {},
  ) {
    this.maxConcurrency = Math.max(1, Math.min(4, options.maxConcurrency ?? 1));
    this.budget = options.budget ?? {
      maxWallMs: 30 * 60 * 1_000,
      maxToolCalls: 200,
      maxDiskBytes: 256 * 1024 * 1024,
    };
    this.now = options.now ?? (() => new Date());
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  get size(): number {
    return this.active.size;
  }

  get completed(): readonly WorkerResult[] {
    return [...this.results];
  }

  private async runJob(job: WorkerJob): Promise<void> {
    if (this.stopped) {
      return;
    }
    const startedAt = this.now();
    const jobBudget: WorkerBudget = {
      maxWallMs: Math.min(job.task.budget.max_wall_ms, this.budget.maxWallMs),
      maxToolCalls: Math.min(
        job.task.budget.max_tool_calls,
        this.budget.maxToolCalls,
      ),
      maxDiskBytes: Math.min(
        job.task.budget.max_disk_bytes,
        this.budget.maxDiskBytes,
      ),
    };
    const usage: WorkerUsage = { wall_ms: 0, tool_calls: 0, disk_bytes: 0 };
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const timer = setTimeout(
      () => controller.abort("budget_exceeded"),
      jobBudget.maxWallMs,
    );
    timer.unref();
    let status: WorkerStatus = "completed";
    let value: unknown = null;
    let error: string | null = null;
    await this.onEvent({
      type: "worker/start",
      worker_id: job.id,
      task_id: job.task.task_id,
      status: "running",
      at: startedAt.toISOString(),
      usage,
      error: null,
    });
    try {
      value = await job.run({
        signal: controller.signal,
        budget: jobBudget,
        consumeToolCall: () => {
          if (!Number.isSafeInteger(usage.tool_calls + 1)) {
            throw new Error("worker tool-call usage is not finite");
          }
          usage.tool_calls += 1;
          if (usage.tool_calls > jobBudget.maxToolCalls) {
            controller.abort("tool_call_budget_exceeded");
            throw new Error("worker tool-call budget exceeded");
          }
        },
        consumeDiskBytes: (bytes: number) => {
          if (!Number.isSafeInteger(bytes) || bytes < 0) {
            throw new Error(
              "worker disk usage must be a non-negative safe integer",
            );
          }
          if (!Number.isSafeInteger(usage.disk_bytes + bytes)) {
            throw new Error("worker disk usage is not finite");
          }
          usage.disk_bytes += bytes;
          if (usage.disk_bytes > jobBudget.maxDiskBytes) {
            controller.abort("disk_budget_exceeded");
            throw new Error("worker disk budget exceeded");
          }
        },
      });
      if (controller.signal.aborted) {
        status = "cancelled";
      }
    } catch (caught) {
      status =
        controller.signal.aborted || this.stopped ? "cancelled" : "failed";
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(job.id);
      const endedAt = this.now();
      usage.wall_ms = Math.max(0, endedAt.getTime() - startedAt.getTime());
      const result: WorkerResult = {
        id: job.id,
        task_id: job.task.task_id,
        status,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        usage,
        value,
        error,
      };
      this.results.push(result);
      await this.onEvent({
        type: "worker/end",
        worker_id: job.id,
        task_id: job.task.task_id,
        status,
        at: endedAt.toISOString(),
        usage,
        error,
      });
    }
  }

  async run(
    jobs: readonly WorkerJob[],
    signal?: AbortSignal,
  ): Promise<WorkerResult[]> {
    if (this.stopped) {
      throw new Error("worker pool is stopped");
    }
    assertDisjoint(jobs);
    assertConfinement(jobs, this.maxConcurrency);
    const queue = [...jobs];
    const onAbort = () => {
      this.stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (queue.length > 0 || this.active.size > 0) {
        while (
          !this.stopped &&
          this.active.size < this.maxConcurrency &&
          queue.length > 0
        ) {
          const job = queue.shift()!;
          const task: Promise<void> = this.runJob(job).finally(() => {
            this.active.delete(task);
          });
          this.active.add(task);
        }
        if (this.active.size === 0) {
          break;
        }
        await Promise.race(this.active);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    return [...this.results];
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.controllers.values()) {
      controller.abort("worker_pool_stopped");
    }
  }
}

export interface SwarmDecisionInput {
  taskCount: number;
  overlappingWriteSets: boolean;
  budget: number;
  uncertainty: "low" | "medium" | "high";
  reviewDepth: "normal" | "high";
}

export interface SwarmDecision {
  mode: "single" | "team" | "reject";
  workers: number;
  reason: string;
}

export function decideSwarm(input: SwarmDecisionInput): SwarmDecision {
  if (input.taskCount <= 0) {
    return { mode: "reject", workers: 0, reason: "no tasks" };
  }
  if (input.overlappingWriteSets) {
    return {
      mode: "reject",
      workers: 0,
      reason: "write sets overlap",
    };
  }
  if (input.taskCount === 1 || input.budget < input.taskCount) {
    return { mode: "single", workers: 1, reason: "single worker budget" };
  }
  if (input.uncertainty === "high" || input.reviewDepth === "high") {
    return {
      mode: "team",
      workers: Math.min(4, input.taskCount),
      reason: "independent review and disjoint write sets",
    };
  }
  return {
    mode: "team",
    workers: Math.min(4, input.taskCount),
    reason: "disjoint work with sufficient budget",
  };
}

export interface BoardWorker {
  id: string;
  task_id: string;
  status: WorkerStatus;
  error: string | null;
}

export class Board {
  private readonly workers = new Map<string, BoardWorker>();
  private readonly tasks = new Map<
    string,
    { state: string; note: string | null }
  >();

  setTask(taskId: string, state: string, note: string | null = null): void {
    this.tasks.set(taskId, { state, note });
  }

  setWorker(worker: BoardWorker): void {
    this.workers.set(worker.id, worker);
  }

  removeWorker(workerId: string): void {
    this.workers.delete(workerId);
  }

  snapshot(): {
    tasks: Array<{ task_id: string; state: string; note: string | null }>;
    workers: BoardWorker[];
  } {
    return {
      tasks: [...this.tasks.entries()].map(([task_id, value]) => ({
        task_id,
        ...value,
      })),
      workers: [...this.workers.values()],
    };
  }
}
