import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  EvidenceRecordSchema,
  validateSchema,
  type EvidenceRecord,
} from "codepunk-protocol";
import { appendFileSynced, ensurePrivateDir } from "../platform/fs.ts";
import { canonicalJson, recordHash, sha256Text } from "../platform/hash.ts";

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}

export interface EvidenceAppendInput extends Omit<
  EvidenceRecord,
  "version" | "id" | "seq" | "prev_sha256" | "created_at"
> {
  id?: string;
  created_at?: string;
}

export interface EvidenceOpenResult {
  records: EvidenceRecord[];
  truncatedTail: boolean;
  head: string | null;
}

export function evidenceRecordHash(record: EvidenceRecord): string {
  return recordHash(record);
}

function parseLines(content: string): {
  records: EvidenceRecord[];
  truncatedTail: boolean;
} {
  let lines = content.split("\n");
  const records: EvidenceRecord[] = [];
  let truncatedTail = false;
  if (content.length > 0 && !content.endsWith("\n")) {
    truncatedTail = true;
    lines = lines.slice(0, -1);
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      const validation = validateSchema(EvidenceRecordSchema, parsed);
      if (!validation.ok) {
        throw new EvidenceError(
          `invalid evidence record at line ${index + 1}: ${validation.issues
            .map((issue) => `${issue.path} ${issue.message}`)
            .join("; ")}`,
        );
      }
      records.push(parsed as EvidenceRecord);
    } catch (error) {
      if (error instanceof EvidenceError) {
        throw error;
      }
      throw new EvidenceError(
        `cannot parse evidence record at line ${index + 1}`,
      );
    }
  }
  return { records, truncatedTail };
}

export function validateEvidenceChain(records: readonly EvidenceRecord[]): {
  ok: boolean;
  issues: string[];
  head: string | null;
} {
  const issues: string[] = [];
  let previous: EvidenceRecord | null = null;
  for (const record of records) {
    if (previous === null && record.seq !== 1) {
      issues.push("evidence chain does not start at sequence 1");
    }
    if (record.seq !== (previous?.seq ?? 0) + 1) {
      issues.push(`evidence sequence is not contiguous at ${record.seq}`);
    }
    const expectedPrev =
      previous === null ? null : evidenceRecordHash(previous);
    if (record.prev_sha256 !== expectedPrev) {
      issues.push(`evidence prev_sha256 mismatch at ${record.seq}`);
    }
    previous = record;
  }
  return {
    ok: issues.length === 0,
    issues,
    head: previous === null ? null : evidenceRecordHash(previous),
  };
}

export async function readEvidenceFile(
  filePath: string,
): Promise<EvidenceOpenResult> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], truncatedTail: false, head: null };
    }
    throw error;
  }
  const parsed = parseLines(content);
  const chain = validateEvidenceChain(parsed.records);
  if (!chain.ok) {
    throw new EvidenceError(chain.issues.join("; "));
  }
  return {
    records: parsed.records,
    truncatedTail: parsed.truncatedTail,
    head: chain.head,
  };
}

export class EvidenceLedger {
  readonly filePath: string;
  private records: EvidenceRecord[];
  private truncatedTail: boolean;
  private appendTail: Promise<void> = Promise.resolve();

  private constructor(
    filePath: string,
    records: EvidenceRecord[],
    truncatedTail: boolean,
  ) {
    this.filePath = filePath;
    this.records = records;
    this.truncatedTail = truncatedTail;
  }

  static async open(filePath: string): Promise<EvidenceLedger> {
    const loaded = await readEvidenceFile(filePath);
    return new EvidenceLedger(filePath, loaded.records, loaded.truncatedTail);
  }

  get all(): readonly EvidenceRecord[] {
    return this.records;
  }

  get head(): string | null {
    const last = this.records.at(-1);
    return last === undefined ? null : evidenceRecordHash(last);
  }

  get hasTruncatedTail(): boolean {
    return this.truncatedTail;
  }

  async append(input: EvidenceAppendInput): Promise<EvidenceRecord> {
    const appended = this.appendTail.then(() => this.appendNow(input));
    this.appendTail = appended.then(
      () => undefined,
      () => undefined,
    );
    return appended;
  }

  private async appendNow(input: EvidenceAppendInput): Promise<EvidenceRecord> {
    if (this.truncatedTail) {
      throw new EvidenceError(
        "cannot append to an evidence file with a truncated tail",
      );
    }
    const previous = this.records.at(-1);
    const record: EvidenceRecord = {
      ...input,
      version: 1,
      id: input.id ?? randomUUID(),
      seq: (previous?.seq ?? 0) + 1,
      prev_sha256: previous === undefined ? null : evidenceRecordHash(previous),
      created_at: input.created_at ?? new Date().toISOString(),
    };
    const validation = validateSchema(EvidenceRecordSchema, record);
    if (!validation.ok) {
      throw new EvidenceError(
        `evidence record is invalid: ${validation.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ")}`,
      );
    }
    await ensurePrivateDir(path.dirname(this.filePath));
    await appendFileSynced(this.filePath, `${canonicalJson(record)}\n`);
    this.records.push(record);
    return record;
  }
}

export interface EvidenceClassCheck {
  ok: boolean;
  issues: string[];
}

export function validateEvidenceForClass(
  record: EvidenceRecord,
): EvidenceClassCheck {
  const issues: string[] = [];
  const tool = record.tool;
  const invalidArguments = record.rule === "tool.invalid_arguments";
  const reviewer = record.reviewer ?? null;
  const reviewerRules = new Set([
    "reviewer.model.allow",
    "reviewer.model.deny",
    "reviewer.abstained",
  ]);
  if (!invalidArguments && record.policy_layers.length === 0) {
    issues.push("policy_layers is empty");
  }
  if (invalidArguments) {
    if (record.coverage !== "uncovered") {
      issues.push("invalid arguments record is not uncovered");
    }
    if (record.output_sha256 === null) {
      issues.push("invalid arguments output_sha256 is missing");
    }
  }
  if (record.decision === "deny" && record.approval !== null) {
    // A denied call may carry an approval denial; no additional requirement.
  }
  if (record.decision === "ask" && record.approval === null) {
    issues.push("approval ask record is missing approval data");
  }
  if (reviewerRules.has(record.rule)) {
    if (reviewer === null) {
      issues.push("reviewer rule is missing reviewer evidence");
    } else if (record.rule === "reviewer.model.allow") {
      if (reviewer.decision !== "allow") {
        issues.push("reviewer allow rule has a different reviewer decision");
      }
      if (record.decision !== "allow") {
        issues.push("reviewer allow rule does not have an allow decision");
      }
    } else if (record.rule === "reviewer.model.deny") {
      if (reviewer.decision !== "deny") {
        issues.push("reviewer deny rule has a different reviewer decision");
      }
      if (record.decision !== "deny") {
        issues.push("reviewer deny rule does not have a deny decision");
      }
    } else if (reviewer.decision !== "abstain") {
      issues.push("reviewer abstained rule has a different reviewer decision");
    } else if (record.decision !== "deny") {
      issues.push("reviewer abstained rule does not have a deny decision");
    }
  }
  if (reviewer !== null) {
    if (
      reviewer.decision === "allow" &&
      record.rule !== "reviewer.model.allow"
    ) {
      issues.push("reviewer allow evidence is not bound to a reviewer rule");
    }
    if (record.rule === "reviewer.abstained" && record.approval !== null) {
      issues.push("reviewer abstained rule cannot carry a human approval");
    }
  }
  if (tool === "write" || tool === "edit") {
    if (!invalidArguments && !record.path_check.performed) {
      issues.push("write/edit path check was not performed");
    }
    if (!invalidArguments && record.path_check.target === null) {
      issues.push("write/edit path target is missing");
    }
    if (record.decision === "allow") {
      if (record.before_sha256 === null)
        issues.push("before_sha256 is missing");
      if (record.after_sha256 === null) issues.push("after_sha256 is missing");
      if (record.diff_sha256 === null) issues.push("diff_sha256 is missing");
    }
  }
  if (tool === "read" || tool === "search") {
    if (!invalidArguments && !record.path_check.performed) {
      issues.push("read/search path check was not performed");
    }
    if (!invalidArguments && record.path_check.target === null) {
      issues.push("read/search path target is missing");
    }
    if (record.decision === "allow") {
      if (record.output_sha256 === null) {
        issues.push("read/search output hash is missing");
      }
      if (record.empty_result === null) {
        issues.push("read/search empty_result is missing");
      }
    }
  }
  if (tool === "bash" || tool === "exec" || tool === "user_bash") {
    if (tool === "exec" && record.command_argv === null) {
      issues.push("exec argv is missing");
    }
    if (tool !== "exec" && record.command === null) {
      issues.push("shell command is missing");
    }
    if (record.cwd.length === 0) issues.push("shell cwd is missing");
    if (
      record.decision === "allow" &&
      record.outcome !== "failed" &&
      record.outcome !== "cancelled"
    ) {
      if (record.exit_code === null) issues.push("shell exit_code is missing");
      if (record.output_sha256 === null)
        issues.push("shell output_sha256 is missing");
      if (record.executor === null) issues.push("shell executor is missing");
      if (record.sandbox.backend !== "srt" && record.coverage === "enforced") {
        issues.push("sandbox backend is missing for enforced shell coverage");
      }
    }
  }
  if (tool === "memory_search") {
    if (record.memory.query_sha256 === null)
      issues.push("query_sha256 is missing");
    if (record.decision === "allow" && record.memory.action !== "read") {
      issues.push("memory_search action is missing");
    }
  }
  if (
    record.decision === "allow" &&
    record.output_sha256 === null &&
    tool !== "write" &&
    tool !== "edit"
  ) {
    issues.push("output_sha256 is missing");
  }
  if (
    record.coverage === "uncovered" &&
    record.decision === "allow" &&
    (tool === "bash" || tool === "exec" || tool === "user_bash")
  ) {
    issues.push("shell action is uncovered");
  }
  return { ok: issues.length === 0, issues };
}

export function outputSha(value: string | Uint8Array): string {
  return sha256Text(
    typeof value === "string" ? value : Buffer.from(value).toString("utf8"),
  );
}

export function fileContentHash(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
