import type { TaskSpec } from "codepunk-protocol";

export const TASK_STATES = [
  "queued",
  "claimed",
  "running",
  "submitted",
  "review_passed",
  "merged",
  "closed",
  "blocked",
  "failed",
  "abandoned",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ["claimed", "blocked", "failed", "abandoned"],
  claimed: ["running", "blocked", "failed", "abandoned"],
  running: ["submitted", "blocked", "failed", "abandoned"],
  submitted: ["review_passed", "running", "blocked", "failed", "abandoned"],
  review_passed: ["merged", "running", "blocked", "failed", "abandoned"],
  merged: ["closed"],
  closed: [],
  blocked: ["queued", "failed", "abandoned"],
  failed: ["queued", "abandoned"],
  abandoned: [],
};

export interface DeliveryTask {
  spec: TaskSpec;
  state: TaskState;
  note: string | null;
  updated_at: string;
}

export class TaskGraph {
  private readonly tasks = new Map<string, DeliveryTask>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  add(spec: TaskSpec): DeliveryTask {
    if (this.tasks.has(spec.task_id)) {
      throw new Error(`task ${spec.task_id} already exists`);
    }
    const task: DeliveryTask = {
      spec,
      state: "queued",
      note: null,
      updated_at: this.now().toISOString(),
    };
    this.tasks.set(spec.task_id, task);
    return task;
  }

  get(taskId: string): DeliveryTask {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      throw new Error(`unknown task ${taskId}`);
    }
    return task;
  }

  list(): DeliveryTask[] {
    return [...this.tasks.values()];
  }

  transition(
    taskId: string,
    next: TaskState,
    note: string | null = null,
  ): DeliveryTask {
    const current = this.get(taskId);
    if (!TRANSITIONS[current.state].includes(next)) {
      throw new Error(`invalid task transition ${current.state} -> ${next}`);
    }
    const updated: DeliveryTask = {
      ...current,
      state: next,
      note,
      updated_at: this.now().toISOString(),
    };
    this.tasks.set(taskId, updated);
    return updated;
  }
}
