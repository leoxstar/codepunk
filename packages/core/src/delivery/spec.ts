import type { TaskSpec } from "@codepunk/protocol";
import { sha256Value } from "../platform/hash.ts";
import { PI_INSTRUCTION_FILE_NAMES } from "../platform/path.ts";

export const DEFAULT_PROTECTED_PATHS = [
  ...PI_INSTRUCTION_FILE_NAMES,
  ".codepunk/",
] as const;

export interface TaskSpecInput {
  taskId: string;
  title: string;
  objective: string;
  baseCommit: string;
  writeSet: readonly string[];
  protectedPaths?: readonly string[];
  acceptance: readonly string[];
  budget?: {
    maxWallMs: number;
    maxToolCalls: number;
    maxDiskBytes: number;
  };
  isolation?: "worktree" | "shared";
  now?: () => Date;
}

function immutableArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export function createTaskSpec(input: TaskSpecInput): TaskSpec {
  if (!/^[0-9a-f]{40,64}$/u.test(input.baseCommit)) {
    throw new Error("base commit must be a lowercase Git commit id");
  }
  if (input.writeSet.length === 0) {
    throw new Error("write set must not be empty");
  }
  const budget = input.budget ?? {
    maxWallMs: 30 * 60 * 1_000,
    maxToolCalls: 200,
    maxDiskBytes: 256 * 1024 * 1024,
  };
  const body = {
    version: 1 as const,
    task_id: input.taskId,
    title: input.title,
    objective: input.objective,
    base_commit: input.baseCommit,
    write_set: [...input.writeSet],
    protected_paths: [...(input.protectedPaths ?? DEFAULT_PROTECTED_PATHS)],
    acceptance: [...input.acceptance],
    budget: {
      max_wall_ms: budget.maxWallMs,
      max_tool_calls: budget.maxToolCalls,
      max_disk_bytes: budget.maxDiskBytes,
    },
    isolation: input.isolation ?? ("worktree" as const),
    created_at: (input.now ?? (() => new Date()))().toISOString(),
  };
  const spec: TaskSpec = {
    ...body,
    spec_sha256: sha256Value(body),
  };
  return Object.freeze({
    ...spec,
    write_set: immutableArray(spec.write_set) as string[],
    protected_paths: immutableArray(spec.protected_paths) as string[],
    acceptance: immutableArray(spec.acceptance) as string[],
  });
}

export function assertTaskSpecImmutable(spec: TaskSpec): void {
  const body = {
    version: spec.version,
    task_id: spec.task_id,
    title: spec.title,
    objective: spec.objective,
    base_commit: spec.base_commit,
    write_set: spec.write_set,
    protected_paths: spec.protected_paths,
    acceptance: spec.acceptance,
    budget: spec.budget,
    isolation: spec.isolation,
    created_at: spec.created_at,
  };
  if (sha256Value(body) !== spec.spec_sha256) {
    throw new Error("task spec hash does not match its immutable body");
  }
}
