import { promises as fs } from "node:fs";
import path from "node:path";
import {
  NotificationSchema,
  validateSchema,
  type Notification,
} from "codepunk-protocol";
import { appendFileSynced, atomicWriteFile } from "../platform/fs.ts";
import { createUlid } from "../platform/hash.ts";
import type { ProjectPaths } from "../platform/paths.ts";

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
    paths: Pick<ProjectPaths, "projectDir">;
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
