import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SessionEvent } from "codepunk-protocol";
import type { CodepunkConfig, ThinkingLevel } from "../config/index.ts";
import {
  parseToml,
  TomlError,
  type TomlTable,
  type TomlValue,
} from "../config/toml.ts";
import {
  canonicalJson,
  createUlid,
  sha256Text,
  sha256Value,
} from "../platform/hash.ts";
import { ensurePrivateDir } from "../platform/fs.ts";
import { withClaimFileLock } from "../platform/file-lock.ts";
import type { ProjectPaths } from "../platform/paths.ts";

const MAX_PRESET_BYTES = 64 * 1024;
const MAX_SIDE_PROMPT = 32_000;
const MAX_SIDE_QUEUE_BYTES = 1024 * 1024;
const PRESET_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const MODEL_REFERENCE = /^[^/\s]+\/[^/\s]+$/u;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SIDE_QUEUE_LOCK_TIMEOUT_MS = 5_000;
const SIDE_QUEUE_LOCK_STALE_MS = 60_000;
const SIDE_QUEUE_COMPACT_TARGET_BYTES = Math.floor(MAX_SIDE_QUEUE_BYTES * 0.75);
const MUTATING_TOOLS = new Set(["write", "edit", "shell", "exec"]);
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "shell",
  "search",
  "memory_search",
  "exec",
  "plan",
  "todo",
]);

export class ProductPresetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProductPresetError";
    this.code = code;
  }
}

export interface ProductPreset {
  name: string;
  description: string;
  model: string | null;
  thinking: ThinkingLevel | null;
  permission: "read-only" | "standard" | null;
  tools: string[];
}

export interface PresetBundle {
  presets: ProductPreset[];
  warnings: string[];
}

export interface SelectedPreset {
  name: string;
  model: string | null;
  thinking: ThinkingLevel;
  tools: string[];
  permission: "read-only" | "standard";
}

function table(value: TomlValue | undefined, where: string): TomlTable {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductPresetError("preset.schema", `${where} must be a table`);
  }
  return value;
}

function optionalString(
  value: TomlValue | undefined,
  where: string,
): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProductPresetError(
      "preset.schema",
      `${where} must be a non-empty string`,
    );
  }
  return value.trim();
}

function stringArray(value: TomlValue | undefined, where: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new ProductPresetError(
      "preset.schema",
      `${where} must be an array of strings`,
    );
  }
  return value.map((entry) => (entry as string).trim());
}

function parsePreset(value: TomlValue, index: number): ProductPreset {
  const where = `preset[${index + 1}]`;
  const preset = table(value, where);
  const allowed = new Set([
    "name",
    "description",
    "model",
    "thinking",
    "permission",
    "tools",
  ]);
  for (const key of Object.keys(preset)) {
    if (!allowed.has(key)) {
      throw new ProductPresetError(
        "preset.unknown_key",
        `${where}.${key} is not a supported preset key`,
      );
    }
  }
  const name = optionalString(preset["name"], `${where}.name`);
  if (name === null || !PRESET_NAME.test(name)) {
    throw new ProductPresetError(
      "preset.name",
      `${where}.name must be a lowercase preset name`,
    );
  }
  const model = optionalString(preset["model"], `${where}.model`);
  if (model !== null && !MODEL_REFERENCE.test(model)) {
    throw new ProductPresetError(
      "preset.model",
      `${where}.model must be provider/model`,
    );
  }
  const thinking = optionalString(preset["thinking"], `${where}.thinking`);
  if (
    thinking !== null &&
    !(THINKING_LEVELS as readonly string[]).includes(thinking)
  ) {
    throw new ProductPresetError(
      "preset.thinking",
      `${where}.thinking is not a supported level`,
    );
  }
  const permission = optionalString(
    preset["permission"],
    `${where}.permission`,
  );
  if (
    permission !== null &&
    permission !== "read-only" &&
    permission !== "standard"
  ) {
    throw new ProductPresetError(
      "preset.permission",
      `${where}.permission must be read-only or standard`,
    );
  }
  const tools = stringArray(preset["tools"], `${where}.tools`);
  if (new Set(tools).size !== tools.length) {
    throw new ProductPresetError(
      "preset.duplicate_tool",
      `${where}.tools contains a duplicate`,
    );
  }
  for (const tool of tools) {
    if (!TOOL_NAMES.has(tool)) {
      throw new ProductPresetError(
        "preset.unknown_tool",
        `${where}.tools has unknown tool ${tool}`,
      );
    }
  }
  if (
    permission === "read-only" &&
    tools.some((tool) => MUTATING_TOOLS.has(tool))
  ) {
    throw new ProductPresetError(
      "preset.permission_mutation",
      `${where} is read-only but enables a mutating tool`,
    );
  }
  return {
    name,
    description:
      optionalString(preset["description"], `${where}.description`) ?? "",
    model,
    thinking: thinking as ThinkingLevel | null,
    permission: permission as "read-only" | "standard" | null,
    tools,
  };
}

export async function loadProductPresets(
  paths: ProjectPaths,
): Promise<PresetBundle> {
  const warnings: string[] = [];
  const projectPath = path.join(paths.projectConfigDir, "presets.toml");
  try {
    await fs.access(projectPath);
    warnings.push(
      `project presets at ${projectPath} are inert; product presets load only from the user home`,
    );
  } catch {
    // No project presets is the normal case.
  }
  const filePath = path.join(paths.home, "presets.toml");
  let raw: string;
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ProductPresetError(
        "preset.file",
        "presets.toml must be a regular file",
      );
    }
    if (stat.size > MAX_PRESET_BYTES) {
      throw new ProductPresetError(
        "preset.too_large",
        `presets.toml exceeds ${MAX_PRESET_BYTES} bytes`,
      );
    }
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { presets: [], warnings };
    }
    throw error;
  }
  let parsed: TomlTable;
  try {
    parsed = parseToml(raw);
  } catch (error) {
    throw new ProductPresetError(
      "preset.toml",
      error instanceof TomlError ? error.message : String(error),
    );
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "version" && key !== "preset") {
      throw new ProductPresetError(
        "preset.unknown_key",
        `presets.toml has unsupported key ${key}`,
      );
    }
  }
  if (parsed["version"] !== 1) {
    throw new ProductPresetError(
      "preset.version",
      "presets.toml version must be 1",
    );
  }
  const rows = parsed["preset"];
  if (!Array.isArray(rows)) {
    throw new ProductPresetError(
      "preset.schema",
      "presets.toml must contain [[preset]] tables",
    );
  }
  const presets = rows.map((row, index) => parsePreset(row, index));
  if (new Set(presets.map((preset) => preset.name)).size !== presets.length) {
    throw new ProductPresetError(
      "preset.duplicate",
      "presets.toml contains duplicate preset names",
    );
  }
  return { presets, warnings };
}

export function selectProductPreset(
  bundle: PresetBundle,
  config: CodepunkConfig,
  name: string,
): SelectedPreset {
  const preset = bundle.presets.find((candidate) => candidate.name === name);
  if (preset === undefined) {
    throw new ProductPresetError(
      "preset.not_found",
      `preset ${name} is not configured in the user home`,
    );
  }
  const enabled = new Set(config.tools.enabled);
  for (const tool of preset.tools) {
    if (!enabled.has(tool)) {
      throw new ProductPresetError(
        "preset.widen_tools",
        `preset ${name} requests tool ${tool}, outside config.tools.enabled`,
      );
    }
  }
  const permission =
    preset.permission ??
    (config.autonomy.profile === "read-only" ? "read-only" : "standard");
  if (config.autonomy.profile === "read-only" && permission !== "read-only") {
    throw new ProductPresetError(
      "preset.widen_permission",
      `preset ${name} cannot widen read-only autonomy`,
    );
  }
  if (
    permission === "read-only" &&
    preset.tools.some((tool) => MUTATING_TOOLS.has(tool))
  ) {
    throw new ProductPresetError(
      "preset.permission_mutation",
      `preset ${name} resolves to read-only but enables a mutating tool`,
    );
  }
  if (
    preset.model !== null &&
    config.model.enabled.length > 0 &&
    !config.model.enabled.includes(preset.model)
  ) {
    throw new ProductPresetError(
      "preset.widen_model",
      `preset ${name} selects ${preset.model}, outside model.enabled`,
    );
  }
  return {
    name,
    model: preset.model,
    thinking: preset.thinking ?? config.model.thinking,
    tools: preset.tools,
    permission,
  };
}

export type SideTaskKind = "btw" | "side";
export type SideTaskStatus =
  "queued" | "running" | "interrupted" | "completed" | "failed" | "cancelled";

export interface SideTaskRecord {
  type: "codepunk/side-task";
  version: 1;
  seq: number;
  id: string;
  session_id: string;
  kind: SideTaskKind;
  prompt: string;
  prompt_sha256: string;
  budget: number;
  status: SideTaskStatus;
  created_at: string;
  updated_at: string;
}

const SIDE_TASK_TRANSITIONS: Record<SideTaskStatus, readonly SideTaskStatus[]> =
  {
    queued: ["running", "cancelled"],
    running: ["interrupted", "completed", "failed", "cancelled"],
    interrupted: ["queued", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
  };

function parseSideTaskRecord(
  value: unknown,
  index: number,
  expectedSeq: number | null = index + 1,
): SideTaskRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductPresetError(
      "side.queue_corrupt",
      `side task record ${index} is not an object`,
    );
  }
  const record = value as Record<string, unknown>;
  const status = record["status"];
  if (
    record["type"] !== "codepunk/side-task" ||
    record["version"] !== 1 ||
    !Number.isSafeInteger(record["seq"]) ||
    (record["seq"] as number) < 1 ||
    (expectedSeq !== null && record["seq"] !== expectedSeq) ||
    typeof record["id"] !== "string" ||
    record["id"].length === 0 ||
    typeof record["session_id"] !== "string" ||
    !SESSION_ID.test(record["session_id"]) ||
    (record["kind"] !== "btw" && record["kind"] !== "side") ||
    typeof record["prompt"] !== "string" ||
    record["prompt"].length === 0 ||
    record["prompt"].length > MAX_SIDE_PROMPT ||
    typeof record["prompt_sha256"] !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(record["prompt_sha256"]) ||
    sha256Text(record["prompt"]) !== record["prompt_sha256"] ||
    !Number.isSafeInteger(record["budget"]) ||
    (record["budget"] as number) < 1 ||
    !(
      status === "queued" ||
      status === "running" ||
      status === "interrupted" ||
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) ||
    typeof record["created_at"] !== "string" ||
    typeof record["updated_at"] !== "string"
  ) {
    throw new ProductPresetError(
      "side.queue_corrupt",
      `side task record ${index} is invalid`,
    );
  }
  return record as unknown as SideTaskRecord;
}

interface SideTaskSnapshotHeader {
  type: "codepunk/side-task-queue";
  version: 1;
  last_seq: number;
  record_count: number;
}

function parseSnapshotHeader(value: unknown): SideTaskSnapshotHeader {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductPresetError(
      "side.queue_corrupt",
      "side task snapshot header is not an object",
    );
  }
  const header = value as Record<string, unknown>;
  if (
    header["type"] !== "codepunk/side-task-queue" ||
    header["version"] !== 1 ||
    !Number.isSafeInteger(header["last_seq"]) ||
    (header["last_seq"] as number) < 0 ||
    !Number.isSafeInteger(header["record_count"]) ||
    (header["record_count"] as number) < 0
  ) {
    throw new ProductPresetError(
      "side.queue_corrupt",
      "side task snapshot header is invalid",
    );
  }
  return header as unknown as SideTaskSnapshotHeader;
}

function isTerminalStatus(status: SideTaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export class SideTaskQueue {
  private readonly filePath: string;
  private readonly lockDir: string;
  private readonly sessionId: string;
  private readonly maxPending: number;
  private readonly maxBudget: number;
  private readonly lockTimeoutMs: number;
  private readonly lockStaleMs: number;
  private readonly now: () => Date;
  private pending: SideTaskRecord[] = [];
  private latest: Map<string, SideTaskRecord> = new Map();
  private seq = 0;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(options: {
    paths: ProjectPaths;
    sessionId: string;
    maxPending?: number;
    maxBudget?: number;
    lockTimeoutMs?: number;
    lockStaleMs?: number;
    now?: () => Date;
  }) {
    if (!SESSION_ID.test(options.sessionId)) {
      throw new ProductPresetError(
        "side.session_id",
        "side task session id must use letters, digits, underscore, or hyphen",
      );
    }
    this.filePath = path.join(
      options.paths.projectDir,
      "product",
      "side-tasks",
      `${options.sessionId}.jsonl`,
    );
    this.lockDir = `${this.filePath}.lock.d`;
    this.sessionId = options.sessionId;
    this.maxPending = Math.max(1, options.maxPending ?? 4);
    this.maxBudget = Math.max(1, options.maxBudget ?? 4);
    this.lockTimeoutMs = Math.max(
      1,
      options.lockTimeoutMs ?? SIDE_QUEUE_LOCK_TIMEOUT_MS,
    );
    this.lockStaleMs = Math.max(
      1,
      options.lockStaleMs ?? SIDE_QUEUE_LOCK_STALE_MS,
    );
    this.now = options.now ?? (() => new Date());
  }

  get queued(): readonly SideTaskRecord[] {
    return this.pending.map((task) => ({ ...task }));
  }

  get running(): readonly SideTaskRecord[] {
    return [...this.latest.values()]
      .filter(
        (task) => task.status === "running" || task.status === "interrupted",
      )
      .map((task) => ({ ...task }));
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    return withClaimFileLock(
      {
        lockDir: this.lockDir,
        timeoutMs: this.lockTimeoutMs,
        staleMs: this.lockStaleMs,
        busyError: () =>
          new ProductPresetError(
            "side.queue_busy",
            "side task queue is locked by another process",
          ),
      },
      operation,
    );
  }

  private async withQueue<T>(operation: () => Promise<T>): Promise<T> {
    return this.runExclusive(() =>
      this.withFileLock(async () => {
        await this.loadUnlocked();
        return operation();
      }),
    );
  }

  async hydrate(): Promise<void> {
    await this.withQueue(async () => undefined);
  }

  private async loadUnlocked(): Promise<void> {
    let raw: string;
    try {
      const stat = await fs.lstat(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new ProductPresetError(
          "side.queue_corrupt",
          "side task queue must be a regular file",
        );
      }
      if (stat.size > MAX_SIDE_QUEUE_BYTES) {
        throw new ProductPresetError(
          "side.queue_too_large",
          `side task queue exceeds ${MAX_SIDE_QUEUE_BYTES} bytes`,
        );
      }
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.seq = 0;
        this.pending = [];
        this.latest = new Map();
        return;
      }
      throw error;
    }
    const lines = raw.split("\n").filter((line) => line.length > 0);
    const latest = new Map<string, SideTaskRecord>();
    const pending: SideTaskRecord[] = [];
    let snapshot: SideTaskSnapshotHeader | null = null;
    let snapshotRecords = 0;
    let offset = 0;
    let seqCursor = 0;
    let snapshotSeq = 0;
    if (lines.length > 0) {
      try {
        const first = JSON.parse(lines[0]!) as { type?: unknown };
        if (first.type === "codepunk/side-task-queue") {
          snapshot = parseSnapshotHeader(first);
          snapshotRecords = snapshot.record_count;
          offset = 1;
          seqCursor = snapshot.last_seq;
        }
      } catch (error) {
        if (error instanceof ProductPresetError) {
          throw error;
        }
      }
    }
    for (const [index, line] of lines.entries()) {
      if (index < offset) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new ProductPresetError(
          "side.queue_corrupt",
          `side task record ${index} is not JSON`,
        );
      }
      const record = parseSideTaskRecord(parsed, index, null);
      if (record.session_id !== this.sessionId) {
        throw new ProductPresetError(
          "side.queue_corrupt",
          `side task record ${index} belongs to another session`,
        );
      }
      if (record.budget > this.maxBudget) {
        throw new ProductPresetError(
          "side.queue_corrupt",
          `side task record ${index} exceeds the configured budget`,
        );
      }
      if (snapshot !== null) {
        const isSnapshotRecord = index < offset + snapshotRecords;
        if (isSnapshotRecord) {
          if (record.seq <= snapshotSeq || record.seq > snapshot.last_seq) {
            throw new ProductPresetError(
              "side.queue_corrupt",
              `side task record ${index} is outside the snapshot sequence`,
            );
          }
          if (latest.has(record.id)) {
            throw new ProductPresetError(
              "side.queue_corrupt",
              `side task record ${index} repeats an id in the snapshot`,
            );
          }
          latest.set(record.id, record);
          if (record.status === "queued") {
            pending.push(record);
          }
          snapshotSeq = record.seq;
          continue;
        }
        if (record.seq !== seqCursor + 1) {
          throw new ProductPresetError(
            "side.queue_corrupt",
            `side task record ${index} is not contiguous after the snapshot`,
          );
        }
        const previous = latest.get(record.id);
        if (previous === undefined) {
          if (record.status !== "queued") {
            throw new ProductPresetError(
              "side.queue_corrupt",
              `side task record ${index} starts after the snapshot`,
            );
          }
          latest.set(record.id, record);
          pending.push(record);
          seqCursor = record.seq;
          continue;
        }
        if (
          !SIDE_TASK_TRANSITIONS[previous.status].includes(record.status) ||
          record.kind !== previous.kind ||
          record.prompt !== previous.prompt ||
          record.prompt_sha256 !== previous.prompt_sha256 ||
          record.budget !== previous.budget ||
          record.created_at !== previous.created_at
        ) {
          throw new ProductPresetError(
            "side.queue_corrupt",
            `side task record ${index} breaks the task state transition`,
          );
        }
        const pendingIndex = pending.findIndex((task) => task.id === record.id);
        if (pendingIndex !== -1) {
          pending.splice(pendingIndex, 1);
        }
        latest.set(record.id, record);
        if (record.status === "queued") {
          pending.push(record);
        }
        seqCursor = record.seq;
        continue;
      }
      if (record.seq !== index + 1) {
        throw new ProductPresetError(
          "side.queue_corrupt",
          `side task record ${index} has a non-contiguous sequence`,
        );
      }
      const previous = latest.get(record.id);
      if (previous === undefined) {
        if (record.status !== "queued") {
          throw new ProductPresetError(
            "side.queue_corrupt",
            `side task record ${index} does not start queued`,
          );
        }
      } else {
        if (
          record.session_id !== previous.session_id ||
          record.kind !== previous.kind ||
          record.prompt !== previous.prompt ||
          record.prompt_sha256 !== previous.prompt_sha256 ||
          record.budget !== previous.budget ||
          record.created_at !== previous.created_at ||
          !SIDE_TASK_TRANSITIONS[previous.status].includes(record.status)
        ) {
          throw new ProductPresetError(
            "side.queue_corrupt",
            `side task record ${index} breaks the task state transition`,
          );
        }
        const pendingIndex = pending.findIndex((task) => task.id === record.id);
        if (pendingIndex !== -1) {
          pending.splice(pendingIndex, 1);
        }
      }
      latest.set(record.id, record);
      if (record.status === "queued") {
        pending.push(record);
      }
      seqCursor = record.seq;
    }
    if (snapshot !== null) {
      const records = lines.length - offset;
      if (records < snapshot.record_count) {
        throw new ProductPresetError(
          "side.queue_corrupt",
          "side task snapshot record count does not match",
        );
      }
      this.seq = seqCursor;
    } else {
      this.seq = seqCursor;
    }
    this.pending = pending;
    this.latest = latest;
  }

  private async append(record: SideTaskRecord): Promise<void> {
    await ensurePrivateDir(path.dirname(this.filePath));
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = Buffer.byteLength(line);
    const currentSize = await fs
      .stat(this.filePath)
      .then((stat) => stat.size)
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return 0;
        }
        throw error;
      });
    if (currentSize + lineBytes <= MAX_SIDE_QUEUE_BYTES) {
      await fs.appendFile(this.filePath, line, { mode: 0o600 });
      return;
    }
    const retained = await this.compact(record);
    if (!retained.some((item) => item.id === record.id)) {
      throw new ProductPresetError(
        "side.queue_too_large",
        "side task record does not fit in the compacted queue",
      );
    }
    const retainedIds = new Set(retained.map((item) => item.id));
    for (const id of [...this.latest.keys()]) {
      if (!retainedIds.has(id)) {
        this.latest.delete(id);
      }
    }
    this.latest.set(record.id, record);
  }

  private async compact(record: SideTaskRecord): Promise<SideTaskRecord[]> {
    const byId = new Map(this.latest);
    byId.set(record.id, record);
    const active = [...byId.values()]
      .filter((item) => !isTerminalStatus(item.status))
      .sort((left, right) => left.seq - right.seq);
    const terminal = [...byId.values()]
      .filter((item) => isTerminalStatus(item.status))
      .sort((left, right) => left.seq - right.seq);
    for (;;) {
      const retained = [...active, ...terminal].sort(
        (left, right) => left.seq - right.seq,
      );
      const payload = this.snapshotPayload(retained);
      if (Buffer.byteLength(payload) <= SIDE_QUEUE_COMPACT_TARGET_BYTES) {
        await this.writeSnapshot(payload);
        return retained;
      }
      if (terminal.length === 0) {
        break;
      }
      terminal.shift();
    }
    throw new ProductPresetError(
      "side.queue_too_large",
      `side task queue cannot be compacted below ${MAX_SIDE_QUEUE_BYTES} bytes`,
    );
  }

  private snapshotPayload(records: SideTaskRecord[]): string {
    const lastSeq = records.reduce((max, item) => Math.max(max, item.seq), 0);
    const header: SideTaskSnapshotHeader = {
      type: "codepunk/side-task-queue",
      version: 1,
      last_seq: lastSeq,
      record_count: records.length,
    };
    return `${[header, ...records].map((item) => JSON.stringify(item)).join("\n")}\n`;
  }

  private async writeSnapshot(payload: string): Promise<void> {
    const temporary = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await fs.rename(temporary, this.filePath);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async enqueue(
    kind: SideTaskKind,
    prompt: string,
    budget = 1,
  ): Promise<SideTaskRecord> {
    return this.withQueue(async () => {
      if (this.pending.length >= this.maxPending) {
        throw new ProductPresetError(
          "side.queue_full",
          `side task queue is limited to ${this.maxPending} pending tasks`,
        );
      }
      const trimmed = prompt.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_SIDE_PROMPT) {
        throw new ProductPresetError(
          "side.prompt",
          `side task prompt must be 1-${MAX_SIDE_PROMPT} characters`,
        );
      }
      if (
        !Number.isSafeInteger(budget) ||
        budget < 1 ||
        budget > this.maxBudget
      ) {
        throw new ProductPresetError(
          "side.budget",
          `side task budget must be 1-${this.maxBudget}`,
        );
      }
      const now = this.now();
      const seq = this.seq + 1;
      const record: SideTaskRecord = {
        type: "codepunk/side-task",
        version: 1,
        seq,
        id: createUlid(now),
        session_id: this.sessionId,
        kind,
        prompt: trimmed,
        prompt_sha256: sha256Text(trimmed),
        budget,
        status: "queued",
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      };
      await this.append(record);
      this.seq = seq;
      this.pending.push(record);
      this.latest.set(record.id, record);
      return record;
    });
  }

  async take(id: string): Promise<SideTaskRecord | null> {
    return this.withQueue(async () => {
      const index = this.pending.findIndex((task) => task.id === id);
      if (index === -1) {
        return null;
      }
      const current = this.pending[index]!;
      const seq = this.seq + 1;
      const record: SideTaskRecord = {
        ...current,
        seq,
        status: "running",
        updated_at: this.now().toISOString(),
      };
      await this.append(record);
      this.seq = seq;
      this.pending.splice(index, 1);
      this.latest.set(record.id, record);
      return record;
    });
  }

  async finish(
    id: string,
    status: "completed" | "failed" | "cancelled",
  ): Promise<SideTaskRecord | null> {
    return this.withQueue(async () => {
      if (this.pending.some((task) => task.id === id)) {
        throw new ProductPresetError(
          "side.transition",
          `side task ${id} is still queued`,
        );
      }
      const latest = this.latest.get(id) ?? null;
      if (latest === null) {
        return null;
      }
      if (!SIDE_TASK_TRANSITIONS[latest.status].includes(status)) {
        throw new ProductPresetError(
          "side.transition",
          `side task ${id} cannot move from ${latest.status} to ${status}`,
        );
      }
      const seq = this.seq + 1;
      const record: SideTaskRecord = {
        ...latest,
        seq,
        status,
        updated_at: this.now().toISOString(),
      };
      await this.append(record);
      this.seq = seq;
      this.latest.set(record.id, record);
      return record;
    });
  }

  async recover(id: string): Promise<SideTaskRecord | null> {
    return this.withQueue(async () => {
      const latest = this.latest.get(id);
      if (latest === undefined) {
        return null;
      }
      if (latest.status !== "running" && latest.status !== "interrupted") {
        throw new ProductPresetError(
          "side.transition",
          `side task ${id} is ${latest.status}, not recoverable`,
        );
      }
      if (this.pending.length >= this.maxPending) {
        throw new ProductPresetError(
          "side.queue_full",
          `side task queue is limited to ${this.maxPending} pending tasks`,
        );
      }
      let record = latest;
      if (record.status === "running") {
        const seq = this.seq + 1;
        record = {
          ...record,
          seq,
          status: "interrupted",
          updated_at: this.now().toISOString(),
        };
        await this.append(record);
        this.seq = seq;
      }
      const queuedSeq = this.seq + 1;
      record = {
        ...record,
        seq: queuedSeq,
        status: "queued",
        updated_at: this.now().toISOString(),
      };
      await this.append(record);
      this.seq = queuedSeq;
      this.latest.set(record.id, record);
      this.pending.push(record);
      return record;
    });
  }

  async recoverAll(): Promise<SideTaskRecord[]> {
    return this.withQueue(async () => {
      const ids = [...this.latest.values()]
        .filter(
          (task) => task.status === "running" || task.status === "interrupted",
        )
        .map((task) => task.id);
      if (this.pending.length + ids.length > this.maxPending) {
        throw new ProductPresetError(
          "side.queue_full",
          `recovering ${ids.length} task(s) would exceed the ${this.maxPending}-task queue limit`,
        );
      }
      const recovered: SideTaskRecord[] = [];
      for (const id of ids) {
        let record = this.latest.get(id)!;
        if (record.status === "running") {
          const seq = this.seq + 1;
          record = {
            ...record,
            seq,
            status: "interrupted",
            updated_at: this.now().toISOString(),
          };
          await this.append(record);
          this.seq = seq;
        }
        const queuedSeq = this.seq + 1;
        record = {
          ...record,
          seq: queuedSeq,
          status: "queued",
          updated_at: this.now().toISOString(),
        };
        await this.append(record);
        this.seq = queuedSeq;
        this.latest.set(record.id, record);
        this.pending.push(record);
        recovered.push(record);
      }
      return recovered;
    });
  }
}

export interface SessionRecap {
  version: 1;
  from_seq: number;
  to_seq: number;
  event_count: number;
  kinds: Record<string, number>;
  body_sha256: string;
}

export function createSessionRecap(
  events: readonly SessionEvent[],
  fromSeq: number,
  toSeq: number,
): SessionRecap {
  if (
    !Number.isSafeInteger(fromSeq) ||
    !Number.isSafeInteger(toSeq) ||
    fromSeq < 1 ||
    toSeq < fromSeq
  ) {
    throw new ProductPresetError(
      "recap.range",
      "recap range must be a positive inclusive seq range",
    );
  }
  const selected = events.filter(
    (event) => event.seq >= fromSeq && event.seq <= toSeq,
  );
  if (
    selected.length !== toSeq - fromSeq + 1 ||
    selected.some((event, index) => event.seq !== fromSeq + index)
  ) {
    throw new ProductPresetError(
      "recap.broken_range",
      "recap range is not contiguous in the session log",
    );
  }
  const kinds: Record<string, number> = {};
  for (const event of selected) {
    kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
  }
  return {
    version: 1,
    from_seq: fromSeq,
    to_seq: toSeq,
    event_count: selected.length,
    kinds,
    body_sha256: sha256Value(canonicalJson(selected)),
  };
}
