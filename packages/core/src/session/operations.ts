import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "../platform/fs.ts";
import { withClaimFileLock } from "../platform/file-lock.ts";
import { sha256Value } from "../platform/hash.ts";
import { normalizeAbsolute } from "../platform/path.ts";

const OPERATIONS_DIR = "operations";
const OPERATIONS_FILE = "sessions.jsonl";
const MAX_OPERATIONS_BYTES = 4 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 60_000;

export type SessionOperationAction =
  "rename" | "archive" | "unarchive" | "delete" | "import";

export interface SessionOperationRecord {
  type: "codepunk/session-operation";
  version: 1;
  seq: number;
  prev_sha256: string | null;
  at: string;
  action: SessionOperationAction;
  project_id: string;
  session_id: string;
  title: string | null;
  backup_id: string | null;
  source_sha256: string | null;
}

export class SessionOperationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionOperationError";
    this.code = code;
  }
}

function operationsPath(home: string): string {
  return path.join(normalizeAbsolute(home), OPERATIONS_DIR, OPERATIONS_FILE);
}

function parseRecord(value: unknown, index: number): SessionOperationRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionOperationError(
      "session.operations_corrupt",
      `session operation ${index} is not an object`,
    );
  }
  const record = value as Record<string, unknown>;
  const action = record["action"];
  if (
    record["type"] !== "codepunk/session-operation" ||
    record["version"] !== 1 ||
    !Number.isSafeInteger(record["seq"]) ||
    (record["seq"] as number) !== index + 1 ||
    !(
      record["prev_sha256"] === null ||
      (typeof record["prev_sha256"] === "string" &&
        /^sha256:[0-9a-f]{64}$/u.test(record["prev_sha256"]))
    ) ||
    typeof record["at"] !== "string" ||
    !Number.isFinite(Date.parse(record["at"])) ||
    !(
      action === "rename" ||
      action === "archive" ||
      action === "unarchive" ||
      action === "delete" ||
      action === "import"
    ) ||
    typeof record["project_id"] !== "string" ||
    record["project_id"].length === 0 ||
    typeof record["session_id"] !== "string" ||
    record["session_id"].length === 0 ||
    !(
      record["title"] === null ||
      (typeof record["title"] === "string" && record["title"].length > 0)
    ) ||
    !(
      record["backup_id"] === null ||
      (typeof record["backup_id"] === "string" &&
        record["backup_id"].length > 0)
    ) ||
    !(
      record["source_sha256"] === null ||
      (typeof record["source_sha256"] === "string" &&
        /^sha256:[0-9a-f]{64}$/u.test(record["source_sha256"]))
    )
  ) {
    throw new SessionOperationError(
      "session.operations_corrupt",
      `session operation ${index} is invalid`,
    );
  }
  return record as unknown as SessionOperationRecord;
}

async function readOperationsUnlocked(
  home: string,
): Promise<SessionOperationRecord[]> {
  const filePath = operationsPath(home);
  let raw: string;
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new SessionOperationError(
        "session.operations_corrupt",
        "session operations file must be a regular file",
      );
    }
    if (stat.size > MAX_OPERATIONS_BYTES) {
      throw new SessionOperationError(
        "session.operations_corrupt",
        "session operations file is too large",
      );
    }
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const records: SessionOperationRecord[] = [];
  let previous: string | null = null;
  const lines = raw.split("\n").filter((line) => line.length > 0);
  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new SessionOperationError(
        "session.operations_corrupt",
        `session operation ${index} is not JSON`,
      );
    }
    const record = parseRecord(value, index);
    if (record.prev_sha256 !== previous) {
      throw new SessionOperationError(
        "session.operations_corrupt",
        `session operation ${index} breaks the hash chain`,
      );
    }
    records.push(record);
    previous = sha256Value(record);
  }
  return records;
}

async function withOperationLock<T>(
  home: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withClaimFileLock(
    {
      lockDir: `${operationsPath(home)}.lock.d`,
      timeoutMs: LOCK_TIMEOUT_MS,
      staleMs: LOCK_STALE_MS,
      busyError: () =>
        new SessionOperationError(
          "session.operations_busy",
          "session operation log is locked",
        ),
    },
    operation,
  );
}

export async function readSessionOperations(
  home: string,
): Promise<SessionOperationRecord[]> {
  return readOperationsUnlocked(home);
}

export async function appendSessionOperation(
  home: string,
  input: Omit<
    SessionOperationRecord,
    "type" | "version" | "seq" | "prev_sha256" | "at"
  >,
): Promise<SessionOperationRecord> {
  return withOperationLock(home, async () => {
    const existing = await readOperationsUnlocked(home);
    const previous =
      existing.length === 0 ? null : sha256Value(existing.at(-1));
    const record: SessionOperationRecord = {
      type: "codepunk/session-operation",
      version: 1,
      seq: existing.length + 1,
      prev_sha256: previous,
      at: new Date().toISOString(),
      ...input,
    };
    const body = `${[...existing, record]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    if (Buffer.byteLength(body, "utf8") > MAX_OPERATIONS_BYTES) {
      throw new SessionOperationError(
        "session.operations_too_large",
        "session operation log would exceed its size limit",
      );
    }
    await atomicWriteFile(operationsPath(home), body, 0o600);
    return record;
  });
}

export async function archivedSessionIds(home: string): Promise<Set<string>> {
  const archived = new Set<string>();
  for (const record of await readSessionOperations(home)) {
    if (record.action === "archive") {
      archived.add(record.session_id);
    } else if (
      record.action === "unarchive" ||
      record.action === "delete" ||
      record.action === "import"
    ) {
      archived.delete(record.session_id);
    }
  }
  return archived;
}
