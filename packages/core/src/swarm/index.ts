import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  NotificationSchema,
  WorkItemSchema,
  validateSchema,
  type Notification,
  type WorkItem,
} from "@codepunk/protocol";
import { appendFileSynced } from "../platform/fs.ts";
import { atomicWriteFile } from "../platform/fs.ts";
import { createUlid } from "../platform/hash.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import {
  Board,
  WorkerPool,
  type WorkerJob,
  type WorkerResult,
} from "../workers/pool.ts";

const execFileAsync = promisify(execFile);
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export interface WorkSource {
  list(): Promise<WorkItem[]>;
}

export class LocalWorkSource implements WorkSource {
  private readonly items: readonly WorkItem[];

  constructor(items: readonly WorkItem[]) {
    this.items = items;
  }

  async list(): Promise<WorkItem[]> {
    return [...this.items];
  }
}

export interface GitHubWorkSourceOptions {
  repo: string;
  limit?: number;
  runGh?: (args: readonly string[]) => Promise<string>;
}

export class GitHubWorkSource implements WorkSource {
  private readonly repo: string;
  private readonly limit: number;
  private readonly runGh: (args: readonly string[]) => Promise<string>;

  constructor(options: GitHubWorkSourceOptions) {
    if (!REPOSITORY.test(options.repo)) {
      throw new Error("GitHub repository must be owner/name");
    }
    this.repo = options.repo;
    this.limit = Math.max(1, Math.min(100, options.limit ?? 20));
    this.runGh =
      options.runGh ??
      (async (args) => {
        const result = await execFileAsync("gh", [...args], {
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env },
        });
        return result.stdout;
      });
  }

  async list(): Promise<WorkItem[]> {
    const output = await this.runGh([
      "issue",
      "list",
      "--repo",
      this.repo,
      "--state",
      "open",
      "--limit",
      String(this.limit),
      "--json",
      "number,title,url,labels,body,createdAt",
    ]);
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("GitHub issue list did not return an array");
    }
    const items: WorkItem[] = [];
    for (const raw of parsed) {
      if (raw === null || typeof raw !== "object") {
        continue;
      }
      const issue = raw as Record<string, unknown>;
      if (
        typeof issue["number"] !== "number" ||
        typeof issue["title"] !== "string" ||
        typeof issue["url"] !== "string" ||
        typeof issue["body"] !== "string" ||
        typeof issue["createdAt"] !== "string"
      ) {
        continue;
      }
      const labels = Array.isArray(issue["labels"])
        ? issue["labels"]
            .map((label) =>
              label !== null && typeof label === "object"
                ? (label as Record<string, unknown>)["name"]
                : null,
            )
            .filter((label): label is string => typeof label === "string")
        : [];
      const item: WorkItem = {
        version: 1,
        id: `github:${this.repo}#${issue["number"]}`,
        source: "github",
        title: issue["title"],
        body: issue["body"],
        url: issue["url"],
        labels,
        created_at: new Date(issue["createdAt"]).toISOString(),
      };
      if (!validateSchema(WorkItemSchema, item).ok) {
        continue;
      }
      items.push(item);
    }
    return items;
  }
}

export interface NotificationAdapter {
  id: string;
  send(notification: Notification): Promise<void>;
}

export class NotificationBridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NotificationBridgeError";
    this.code = code;
  }
}

export interface NotificationInput {
  kind: Notification["kind"];
  title: string;
  body: string;
  task_id?: string | null;
}

export class MessageBridge {
  private readonly queuePath: string;
  private readonly adapter: NotificationAdapter | null;
  private readonly maxQueue: number;
  private readonly now: () => Date;

  constructor(options: {
    paths: ProjectPaths;
    adapter?: NotificationAdapter | null;
    maxQueue?: number;
    now?: () => Date;
  }) {
    this.queuePath = path.join(options.paths.projectDir, "notifications.jsonl");
    this.adapter = options.adapter ?? null;
    this.maxQueue = Math.max(1, options.maxQueue ?? 1_000);
    this.now = options.now ?? (() => new Date());
  }

  private async readQueue(): Promise<Notification[]> {
    let content: string;
    try {
      content = await fs.readFile(this.queuePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const lines = content.split("\n");
    const output: Notification[] = [];
    for (const line of lines) {
      if (line.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new NotificationBridgeError(
          "bridge.corrupt_queue",
          "notification queue is corrupt",
        );
      }
      const validation = validateSchema(NotificationSchema, parsed);
      if (!validation.ok) {
        throw new NotificationBridgeError(
          "bridge.corrupt_queue",
          "notification queue contains an invalid entry",
        );
      }
      output.push(parsed as Notification);
    }
    return output;
  }

  private async writeQueue(
    notifications: readonly Notification[],
  ): Promise<void> {
    const content = notifications
      .map((item) => JSON.stringify(item))
      .join("\n");
    await atomicWriteFile(
      this.queuePath,
      content.length > 0 ? `${content}\n` : "",
    );
  }

  async notify(input: NotificationInput): Promise<"sent" | "queued"> {
    const raw = input as unknown as Record<string, unknown>;
    if (raw["kind"] === "approval" || "approval" in raw) {
      throw new NotificationBridgeError(
        "bridge.approval_forbidden",
        "MessageBridge is notification-only; approvals require a local human surface",
      );
    }
    const notification: Notification = {
      version: 1,
      id: createUlid(this.now()),
      kind: input.kind,
      title: input.title,
      body: input.body,
      task_id: input.task_id ?? null,
      created_at: this.now().toISOString(),
    };
    if (!validateSchema(NotificationSchema, notification).ok) {
      throw new NotificationBridgeError(
        "bridge.invalid_notification",
        "notification is invalid",
      );
    }
    if (this.adapter !== null) {
      try {
        await this.adapter.send(notification);
        return "sent";
      } catch {
        // Fall through to the durable local queue.
      }
    }
    const queue = await this.readQueue();
    if (queue.length >= this.maxQueue) {
      throw new NotificationBridgeError(
        "bridge.queue_full",
        "notification queue is full",
      );
    }
    await appendFileSynced(this.queuePath, `${JSON.stringify(notification)}\n`);
    return "queued";
  }

  async flush(): Promise<{ sent: number; remaining: number }> {
    if (this.adapter === null) {
      return { sent: 0, remaining: (await this.readQueue()).length };
    }
    const queue = await this.readQueue();
    let sent = 0;
    for (const notification of queue) {
      try {
        await this.adapter.send(notification);
        sent += 1;
      } catch {
        break;
      }
    }
    const remaining = queue.slice(sent);
    await this.writeQueue(remaining);
    return { sent, remaining: remaining.length };
  }

  async queueSize(): Promise<number> {
    return (await this.readQueue()).length;
  }
}

export interface BoundedSwarmOptions {
  pool: WorkerPool;
  board: Board;
  bridge?: MessageBridge;
}

export class BoundedSwarm {
  private readonly pool: WorkerPool;
  private readonly board: Board;
  private readonly bridge: MessageBridge | null;

  constructor(options: BoundedSwarmOptions) {
    this.pool = options.pool;
    this.board = options.board;
    this.bridge = options.bridge ?? null;
  }

  async run(jobs: readonly WorkerJob[]): Promise<WorkerResult[]> {
    if (this.pool.size > 4) {
      throw new Error("bounded swarm permits at most four active workers");
    }
    for (const job of jobs) {
      this.board.setTask(job.task.task_id, "queued");
    }
    const results = await this.pool.run(jobs);
    for (const result of results) {
      this.board.setTask(result.task_id, result.status, result.error);
      this.board.setWorker({
        id: result.id,
        task_id: result.task_id,
        status: result.status,
        error: result.error,
      });
      if (this.bridge !== null) {
        await this.bridge.notify({
          kind: "worker",
          title: `worker ${result.id} ${result.status}`,
          body: result.error ?? `task ${result.task_id} ${result.status}`,
          task_id: result.task_id,
        });
      }
    }
    return results;
  }
}
