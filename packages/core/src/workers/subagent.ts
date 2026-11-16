import type { TaskSpec } from "@codepunk/protocol";
import { ApprovalBroker, type ApprovalChannel } from "../approval/index.ts";
import { isInsidePath, normalizeAbsolute } from "../platform/path.ts";

export type SubagentTool =
  "read" | "write" | "edit" | "shell" | "search" | "memory_search";

export interface SubagentToolMask {
  read: boolean;
  write: boolean;
  edit: boolean;
  shell: boolean;
  search: boolean;
  memory_search: boolean;
}

export type SubagentPermissionMode = "ask" | "read-only" | "scoped";

export type SubagentPermissionCeiling = "read-only" | "standard";

export interface SubagentProfilePolicy {
  permission: SubagentPermissionCeiling;
  networkAllow: readonly string[];
  networkDeny: readonly string[];
}

export interface SubagentParentPolicy {
  approval: "ask" | "deny" | "auto" | "allow";
  autonomy: "read-only" | "ask" | "scoped";
  tools: readonly string[];
  /**
   * Maximum execution ceiling of the parent. It defaults to read-only when
   * autonomy is read-only or approval is deny; otherwise it is standard.
   */
  permission?: SubagentPermissionCeiling;
  /** Operator egress allowlist that bounds every child profile. */
  networkAllow?: readonly string[];
  /** Operator egress deny list inherited by every child. */
  networkDeny?: readonly string[];
}

export interface SubagentRequest {
  parent_session_id: string;
  child_session_id: string;
  task: TaskSpec;
  isolation: "worktree" | "shared";
  tool_mask: SubagentToolMask;
  permission_mode: SubagentPermissionMode;
  /**
   * Ceiling of the parent session. A child may narrow this policy but cannot
   * enable a mutating capability or a tool the parent disabled.
   */
  parent_policy: SubagentParentPolicy;
  /** Profile-declared ceiling and network policy, checked against the parent. */
  profile_policy?: SubagentProfilePolicy;
  depth: number;
  worktree?: string;
  parent_worktree?: string;
  parent_root?: string;
  sibling_root?: string;
  write_set?: readonly string[];
  approval_channel?: ApprovalChannel;
  spawn_approved?: boolean;
  budget?: {
    max_tool_calls?: number;
    max_wall_ms?: number;
    max_disk_bytes?: number;
  };
  run(context: {
    tool_mask: SubagentToolMask;
    worktree: string;
    write_set: readonly string[];
    signal: AbortSignal;
    approval: ApprovalBroker;
    messages: string[];
    budget: {
      max_tool_calls: number;
      max_wall_ms: number;
      max_disk_bytes: number;
    };
    consumeToolCall(): void;
    consumeDiskBytes(bytes: number): void;
    assertWriteTarget(target: string): string;
  }): Promise<{ summary: string; evidence_head: string }>;
}

export interface SubagentResult {
  child_session_id: string;
  parent_session_id: string;
  depth: number;
  isolation: "worktree" | "shared";
  summary: string;
  evidence_head: string;
}

export class SubagentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SubagentError";
    this.code = code;
  }
}

const ACTION_KEYS: Record<string, keyof SubagentToolMask> = {
  read: "read",
  write: "write",
  edit: "edit",
  bash: "shell",
  shell: "shell",
  exec: "shell",
  search: "search",
  memory_search: "memory_search",
};

export function assertSubagentAction(
  mask: SubagentToolMask,
  action: string,
): void {
  const key = ACTION_KEYS[action];
  if (key === undefined || mask[key] !== true) {
    throw new SubagentError(
      "subagent.action_not_masked",
      `subagent tool action ${action} is outside its mask`,
    );
  }
}

export function assertSubagentMask(
  mask: SubagentToolMask,
  permission: SubagentPermissionMode,
): void {
  if (mask.memory_search) {
    throw new SubagentError(
      "subagent.memory_search_denied",
      "workers never receive memory_search",
    );
  }
  if (permission === "read-only" && (mask.write || mask.edit || mask.shell)) {
    throw new SubagentError(
      "subagent.read_only_mask",
      "read-only subagents cannot mutate or execute shell",
    );
  }
  if (permission === "scoped" && !mask.write && !mask.edit && !mask.shell) {
    throw new SubagentError(
      "subagent.scoped_empty",
      "scoped permission requires an explicit mutating capability",
    );
  }
}

export function assertSubagentWithinParentPolicy(
  mask: SubagentToolMask,
  permission: SubagentPermissionMode,
  parent: SubagentParentPolicy,
  profile?: SubagentProfilePolicy,
): void {
  const mutating = mask.write || mask.edit || mask.shell;
  if (
    mutating &&
    (parent.autonomy === "read-only" || parent.approval === "deny")
  ) {
    throw new SubagentError(
      "subagent.parent_read_only",
      `a ${parent.autonomy === "read-only" ? "read-only" : "deny-approval"} parent cannot spawn a mutating subagent`,
    );
  }
  const parentTools = new Set(parent.tools);
  const ceiling: ReadonlyArray<readonly [keyof SubagentToolMask, string]> = [
    ["read", "read"],
    ["search", "search"],
    ["write", "write"],
    ["edit", "edit"],
    ["shell", "shell"],
  ];
  for (const [key, tool] of ceiling) {
    if (mask[key] && !parentTools.has(tool)) {
      throw new SubagentError(
        "subagent.parent_tool_ceiling",
        `subagent tool ${tool} exceeds the parent's enabled tools`,
      );
    }
  }
  if (permission === "read-only" && mutating) {
    throw new SubagentError(
      "subagent.read_only_mask",
      "read-only subagents cannot mutate or execute shell",
    );
  }
  const parentPermission =
    parent.permission ??
    (parent.autonomy === "read-only" || parent.approval === "deny"
      ? "read-only"
      : "standard");
  if (profile?.permission === "standard" && parentPermission === "read-only") {
    throw new SubagentError(
      "subagent.parent_permission_ceiling",
      "a read-only parent cannot accept a standard agent profile",
    );
  }
  if (profile === undefined) {
    return;
  }
  if (
    !mask.shell &&
    (profile.networkAllow.length > 0 || profile.networkDeny.length > 0)
  ) {
    throw new SubagentError(
      "subagent.network_without_shell",
      "a child network policy requires the shell tool",
    );
  }
  const parentAllow = parent.networkAllow ?? [];
  const parentDeny = parent.networkDeny ?? [];
  for (const entry of profile.networkAllow) {
    if (!parentAllow.some((allowed) => domainCovered(entry, allowed))) {
      throw new SubagentError(
        "subagent.parent_network_ceiling",
        `child network entry ${entry} exceeds the parent allowlist`,
      );
    }
    if (parentDeny.some((denied) => domainsOverlap(entry, denied))) {
      throw new SubagentError(
        "subagent.parent_network_deny",
        `child network entry ${entry} is denied by the parent`,
      );
    }
  }
}

function splitDomain(entry: string): { host: string; port: string | null } {
  const match = /^(.*?)(?::(\d+))?$/u.exec(entry.toLowerCase())!;
  return { host: match[1]!, port: match[2] ?? null };
}

/**
 * True when every host matched by `entry` is also matched by `ceiling`.
 * This is intentionally conservative; a profile may narrow a wildcard, but it
 * cannot invent a host or port outside the operator allowlist.
 */
function domainCovered(entry: string, ceiling: string): boolean {
  if (entry === ceiling) {
    return true;
  }
  const candidate = splitDomain(entry);
  const limit = splitDomain(ceiling);
  if (limit.port !== null && candidate.port !== limit.port) {
    return false;
  }
  if (limit.host === "*" || candidate.host === limit.host) {
    return true;
  }
  if (!limit.host.startsWith("*.")) {
    return false;
  }
  const base = limit.host.slice(2);
  if (candidate.host.startsWith("*.")) {
    const candidateBase = candidate.host.slice(2);
    return candidateBase === base || candidateBase.endsWith(`.${base}`);
  }
  return candidate.host.endsWith(`.${base}`);
}

/**
 * True when the two patterns can match the same destination. A parent deny
 * entry wins over a wider child allow wildcard, so a subset check alone is not
 * enough here.
 */
function domainsOverlap(left: string, right: string): boolean {
  const first = splitDomain(left);
  const second = splitDomain(right);
  if (
    first.port !== null &&
    second.port !== null &&
    first.port !== second.port
  ) {
    return false;
  }
  if (first.host === "*" || second.host === "*") {
    return true;
  }
  if (first.host === second.host) {
    return true;
  }
  const firstWildcard = first.host.startsWith("*.");
  const secondWildcard = second.host.startsWith("*.");
  if (firstWildcard && secondWildcard) {
    const firstBase = first.host.slice(2);
    const secondBase = second.host.slice(2);
    return (
      firstBase === secondBase ||
      firstBase.endsWith(`.${secondBase}`) ||
      secondBase.endsWith(`.${firstBase}`)
    );
  }
  if (firstWildcard) {
    return second.host.endsWith(`.${first.host.slice(2)}`);
  }
  if (secondWildcard) {
    return first.host.endsWith(`.${second.host.slice(2)}`);
  }
  return false;
}

function relativeWritePath(value: string): string {
  const normalized = value.split("\\").join("/").replace(/^\.\//u, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new SubagentError(
      "subagent.shared_write_set_escape",
      "subagent write set escapes the parent with a non-relative path",
    );
  }
  return normalized;
}

function writeSetContains(
  relative: string,
  writeSet: readonly string[],
): boolean {
  return writeSet.some((entry) => {
    const normalized = relativeWritePath(entry);
    if (normalized === ".") {
      return true;
    }
    return normalized.endsWith("/")
      ? relative === normalized.slice(0, -1) || relative.startsWith(normalized)
      : relative === normalized;
  });
}

export function assertSubagentWriteTarget(
  worktree: string,
  writeSet: readonly string[],
  target: string,
): string {
  const root = normalizeAbsolute(worktree);
  const absolute = normalizeAbsolute(target);
  if (!isInsidePath(root, absolute)) {
    throw new SubagentError(
      "subagent.write_outside_worktree",
      "subagent file write is outside its run worktree",
    );
  }
  const relative = absolute
    .slice(root.length)
    .replace(/^[/\\]+/u, "")
    .split("\\")
    .join("/");
  if (!writeSetContains(relative, writeSet)) {
    throw new SubagentError(
      "subagent.write_outside_write_set",
      "subagent file write is outside its inherited write set",
    );
  }
  return absolute;
}

export class Subagent {
  private readonly request: SubagentRequest;
  private childStarted = false;
  private readonly controller = new AbortController();
  private readonly messages: string[] = [];

  constructor(request: SubagentRequest) {
    this.request = request;
  }

  /**
   * Aborted when the subagent stops, exhausts a budget, or exceeds its
   * wall-clock allowance. Callers that own child processes must combine this
   * signal with their own so a wall-clock stop actually kills the child.
   */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  validate(): void {
    if (this.request.depth >= 1) {
      throw new SubagentError(
        "subagent.depth_exceeded",
        "subagent depth is limited to one",
      );
    }
    if (
      this.request.parent_session_id.length === 0 ||
      this.request.child_session_id.length === 0 ||
      this.request.parent_session_id === this.request.child_session_id
    ) {
      throw new SubagentError(
        "subagent.session_binding",
        "subagent needs distinct parent and child session ids",
      );
    }
    assertSubagentMask(this.request.tool_mask, this.request.permission_mode);
    const parentPolicy: SubagentParentPolicy | undefined =
      this.request.parent_policy;
    if (parentPolicy === undefined) {
      throw new SubagentError(
        "subagent.parent_policy_required",
        "subagent requires an explicit parent policy",
      );
    }
    assertSubagentWithinParentPolicy(
      this.request.tool_mask,
      this.request.permission_mode,
      parentPolicy,
      this.request.profile_policy,
    );
    const worktree = this.request.worktree;
    if (worktree === undefined || worktree.trim().length === 0) {
      throw new SubagentError(
        "subagent.worktree_required",
        "subagent runs require an explicit worktree path",
      );
    }
    if (worktree === this.request.task.base_commit) {
      throw new SubagentError(
        "subagent.worktree_invalid",
        "the task base commit is not a worktree path",
      );
    }
    if (
      this.request.parent_root !== undefined &&
      isInsidePath(
        normalizeAbsolute(this.request.parent_root),
        normalizeAbsolute(worktree),
      )
    ) {
      throw new SubagentError(
        "subagent.worktree_escape",
        "subagent worktree cannot sit inside the parent checkout",
      );
    }
    if (
      this.request.sibling_root !== undefined &&
      isInsidePath(
        normalizeAbsolute(this.request.sibling_root),
        normalizeAbsolute(worktree),
      )
    ) {
      throw new SubagentError(
        "subagent.sibling_worktree",
        "subagent worktree cannot sit inside a sibling worktree",
      );
    }
    if (this.request.isolation === "shared") {
      if (
        this.request.parent_worktree !== undefined &&
        normalizeAbsolute(this.request.parent_worktree) !==
          normalizeAbsolute(worktree)
      ) {
        throw new SubagentError(
          "subagent.shared_worktree",
          "shared subagents must use the parent worktree",
        );
      }
      if (this.request.write_set === undefined) {
        throw new SubagentError(
          "subagent.shared_write_set",
          "shared subagents must inherit an explicit write set",
        );
      }
      for (const entry of this.request.write_set) {
        relativeWritePath(entry);
      }
    } else if (this.request.budget?.max_disk_bytes !== undefined) {
      if (
        !Number.isSafeInteger(this.request.budget.max_disk_bytes) ||
        this.request.budget.max_disk_bytes < 0
      ) {
        throw new SubagentError(
          "subagent.budget",
          "subagent disk budget must be a non-negative safe integer",
        );
      }
    }
  }

  send(message: string): void {
    if (!this.childStarted) {
      throw new SubagentError(
        "subagent.not_started",
        "subagent has not started",
      );
    }
    if (this.controller.signal.aborted) {
      throw new SubagentError("subagent.stopped", "subagent is stopped");
    }
    this.messages.push(message);
  }

  stop(): void {
    this.controller.abort();
  }

  async run(): Promise<SubagentResult> {
    this.validate();
    if (this.childStarted) {
      throw new SubagentError(
        "subagent.already_started",
        "subagent already started",
      );
    }
    this.childStarted = true;
    const approval = new ApprovalBroker();
    if (this.request.approval_channel !== undefined) {
      approval.registerChannel(this.request.approval_channel);
    }
    const budget = {
      max_tool_calls: Math.min(
        this.request.budget?.max_tool_calls ??
          this.request.task.budget.max_tool_calls,
        this.request.task.budget.max_tool_calls,
      ),
      max_wall_ms: Math.min(
        this.request.budget?.max_wall_ms ??
          this.request.task.budget.max_wall_ms,
        this.request.task.budget.max_wall_ms,
      ),
      max_disk_bytes: Math.min(
        this.request.budget?.max_disk_bytes ??
          this.request.task.budget.max_disk_bytes,
        this.request.task.budget.max_disk_bytes,
      ),
    };
    let toolCalls = 0;
    let diskBytes = 0;
    let budgetFailure: SubagentError | null = null;
    const consumeToolCall = (): void => {
      toolCalls += 1;
      if (toolCalls > budget.max_tool_calls) {
        budgetFailure = new SubagentError(
          "subagent.budget_exceeded",
          "subagent exceeded its tool-call budget",
        );
        this.controller.abort();
        throw budgetFailure;
      }
    };
    const consumeDiskBytes = (bytes: number): void => {
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new SubagentError(
          "subagent.budget",
          "subagent disk usage must be a non-negative safe integer",
        );
      }
      diskBytes += bytes;
      if (!Number.isSafeInteger(diskBytes)) {
        throw new SubagentError(
          "subagent.budget",
          "subagent disk usage is not finite",
        );
      }
      if (diskBytes > budget.max_disk_bytes) {
        budgetFailure = new SubagentError(
          "subagent.budget_exceeded",
          "subagent exceeded its disk budget",
        );
        this.controller.abort();
        throw budgetFailure;
      }
    };
    const runWorktree = normalizeAbsolute(this.request.worktree!);
    const runWriteSet = this.request.write_set ?? this.request.task.write_set;
    const execution = this.request.run({
      tool_mask: this.request.tool_mask,
      worktree: runWorktree,
      write_set: runWriteSet,
      signal: this.controller.signal,
      approval,
      messages: this.messages,
      budget,
      consumeToolCall,
      consumeDiskBytes,
      assertWriteTarget: (target: string) =>
        assertSubagentWriteTarget(runWorktree, runWriteSet, target),
    });
    let result: { summary: string; evidence_head: string };
    try {
      const stopped = new Promise<never>((_, reject) => {
        const abort = () => {
          reject(
            budgetFailure ??
              new SubagentError("subagent.stopped", "subagent is stopped"),
          );
        };
        if (this.controller.signal.aborted) {
          abort();
          return;
        }
        this.controller.signal.addEventListener("abort", abort, {
          once: true,
        });
      });
      const wallClock = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          budgetFailure = new SubagentError(
            "subagent.budget_exceeded",
            "subagent exceeded its wall-clock budget",
          );
          this.controller.abort();
          reject(budgetFailure);
        }, budget.max_wall_ms);
        timer.unref();
      });
      result = await Promise.race([execution, stopped, wallClock]);
    } catch (error) {
      const cleanupTimeout = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        timer.unref();
      });
      await Promise.race([
        execution.then(
          () => undefined,
          () => undefined,
        ),
        cleanupTimeout,
      ]);
      throw budgetFailure ?? error;
    }
    return {
      child_session_id: this.request.child_session_id,
      parent_session_id: this.request.parent_session_id,
      depth: this.request.depth + 1,
      isolation: this.request.isolation,
      summary: result.summary,
      evidence_head: result.evidence_head,
    };
  }

  spawnChild(): never {
    throw new SubagentError(
      "subagent.depth_exceeded",
      "subagent depth is limited to one",
    );
  }
}

export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

export interface SubagentHandle {
  child_session_id: string;
  parent_session_id: string;
  status: SubagentStatus;
  result: SubagentResult | null;
  error: string | null;
}

interface RunningSubagent {
  subagent: Subagent;
  handle: SubagentHandle;
  promise: Promise<SubagentResult>;
}

export class SubagentDispatcher {
  private readonly running = new Map<string, RunningSubagent>();

  async dispatch(request: SubagentRequest): Promise<SubagentHandle> {
    if (this.running.has(request.child_session_id)) {
      throw new SubagentError(
        "subagent.already_started",
        "subagent already started",
      );
    }
    const subagent = new Subagent(request);
    subagent.validate();
    const handle: SubagentHandle = {
      child_session_id: request.child_session_id,
      parent_session_id: request.parent_session_id,
      status: "running",
      result: null,
      error: null,
    };
    const promise = subagent
      .run()
      .then((result) => {
        handle.status = "completed";
        handle.result = result;
        return result;
      })
      .catch((error: unknown) => {
        handle.status =
          error instanceof SubagentError && error.code === "subagent.stopped"
            ? "stopped"
            : "failed";
        handle.error = error instanceof Error ? error.message : String(error);
        throw error;
      });
    promise.catch(() => undefined);
    this.running.set(request.child_session_id, { subagent, handle, promise });
    return { ...handle };
  }

  status(childSessionId: string): SubagentHandle {
    const entry = this.running.get(childSessionId);
    if (entry === undefined) {
      throw new SubagentError(
        "subagent.not_found",
        "subagent is not registered",
      );
    }
    return { ...entry.handle };
  }

  send(childSessionId: string, message: string): void {
    const entry = this.running.get(childSessionId);
    if (entry === undefined) {
      throw new SubagentError(
        "subagent.not_found",
        "subagent is not registered",
      );
    }
    entry.subagent.send(message);
  }

  stop(childSessionId: string): void {
    const entry = this.running.get(childSessionId);
    if (entry === undefined) {
      throw new SubagentError(
        "subagent.not_found",
        "subagent is not registered",
      );
    }
    entry.subagent.stop();
  }

  async wait(childSessionId: string): Promise<SubagentHandle> {
    const entry = this.running.get(childSessionId);
    if (entry === undefined) {
      throw new SubagentError(
        "subagent.not_found",
        "subagent is not registered",
      );
    }
    await entry.promise.catch(() => undefined);
    return { ...entry.handle };
  }
}
