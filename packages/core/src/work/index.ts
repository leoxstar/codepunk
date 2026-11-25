import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  PlanStepSchema,
  TodoItemSchema,
  validateSchema,
  type PlanMode,
  type PlanStep,
  type SessionEvent,
  type TodoItem,
} from "codepunk-protocol";
import { recordHash } from "../platform/hash.ts";

export interface WorkState {
  run_id: string;
  steps: PlanStep[];
  explanation: string | null;
  updated_at: string;
  sha256: string;
}

export interface TodoState {
  run_id: string;
  items: TodoItem[];
  updated_at: string;
  sha256: string;
}

export interface WorkStateSnapshot {
  plan: WorkState | null;
  todos: TodoState | null;
}

export interface PlanModeState {
  mode: PlanMode;
  plan_sha256: string | null;
  updated_at: string;
}

export interface PlanModeGate {
  allowed: boolean;
  rule: string | null;
  reason: string | null;
}

const PLAN_MODE_READ_ONLY_TOOLS = new Set([
  "read",
  "search",
  "plan",
  "todo",
  "ask_user",
  "subagent",
  "memory_search",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

export function isPlanModeReadOnlyTool(tool: string): boolean {
  return PLAN_MODE_READ_ONLY_TOOLS.has(tool);
}

export interface WorkUpdate<State> {
  state: State;
  text: string;
}

export function readPlanModeState(
  events: readonly SessionEvent[],
): PlanModeState | null {
  let state: PlanModeState | null = null;
  for (const event of events) {
    if (event.kind === "plan_mode/update") {
      state = {
        mode: event.data.mode,
        plan_sha256: event.data.plan_sha256,
        updated_at: event.data.updated_at,
      };
    }
  }
  return state;
}

/**
 * Approval binds the ordered plan content, not step status. Status changes
 * during execution must not invalidate an approval, while adding, removing,
 * reordering, or rewriting a step must.
 */
export function planContentHash(plan: WorkState | null): string | null {
  if (plan === null || plan.steps.length === 0) {
    return null;
  }
  return recordHash({
    kind: "codepunk/plan-content",
    steps: plan.steps.map((step) => step.step),
  });
}

export function evaluatePlanModeGate(input: {
  state: PlanModeState | null;
  plan: WorkState | null;
  tool: string;
}): PlanModeGate {
  const { state, plan, tool } = input;
  if (state === null || state.mode === "off") {
    return { allowed: true, rule: null, reason: null };
  }
  if (state.mode === "planning") {
    return isPlanModeReadOnlyTool(tool)
      ? { allowed: true, rule: null, reason: null }
      : {
          allowed: false,
          rule: "plan_mode.read_only",
          reason:
            "Plan mode is on; only read-only tools are available. Record the plan, then run /plan-mode approve before mutating anything.",
        };
  }
  if (state.plan_sha256 === null) {
    return {
      allowed: false,
      rule: "plan_mode.approval_missing",
      reason:
        "Plan execution has no approved plan hash. Run /plan-mode approve after recording a plan.",
    };
  }
  const current = planContentHash(plan);
  if (current === null) {
    return {
      allowed: false,
      rule: "plan_mode.approval_missing",
      reason:
        "No plan is recorded for this execution. Record a plan and run /plan-mode approve.",
    };
  }
  if (current !== state.plan_sha256) {
    return {
      allowed: false,
      rule: "plan_mode.approval_mismatch",
      reason:
        "The current plan no longer matches the approved plan. Review it and run /plan-mode approve again.",
    };
  }
  return { allowed: true, rule: null, reason: null };
}

export function readWorkState(
  events: readonly SessionEvent[],
  runId?: string,
): WorkStateSnapshot {
  let plan: WorkState | null = null;
  let todos: TodoState | null = null;
  for (const event of events) {
    if (
      runId !== undefined &&
      (!("run_id" in event.data) || event.data.run_id !== runId)
    ) {
      continue;
    }
    if (event.kind === "plan/update") {
      plan = {
        run_id: event.data.run_id,
        steps: event.data.steps,
        explanation: event.data.explanation,
        updated_at: event.data.updated_at,
        sha256: event.data.sha256,
      };
    } else if (event.kind === "todo/update") {
      todos = {
        run_id: event.data.run_id,
        items: event.data.items,
        updated_at: event.data.updated_at,
        sha256: event.data.sha256,
      };
    }
  }
  return { plan, todos };
}

export function formatPlan(state: WorkState | null): string {
  if (state === null || state.steps.length === 0) {
    return "No active plan. The model records one with the plan tool.";
  }
  const lines = ["Plan:"];
  for (const step of state.steps) {
    const mark =
      step.status === "completed"
        ? "[x]"
        : step.status === "in_progress"
          ? "[>]"
          : "[ ]";
    lines.push(`${mark} ${step.step}`);
  }
  if (state.explanation !== null && state.explanation.length > 0) {
    lines.push(`note: ${state.explanation}`);
  }
  return lines.join("\n");
}

export function formatTodos(state: TodoState | null): string {
  if (state === null || state.items.length === 0) {
    return "No todos. The model records them with the todo tool.";
  }
  const lines = ["Todos:"];
  for (const item of state.items) {
    const mark =
      item.status === "completed"
        ? "[x]"
        : item.status === "in_progress"
          ? "[>]"
          : "[ ]";
    lines.push(`${mark} ${item.content}`);
  }
  return lines.join("\n");
}

function statusError(label: string, value: unknown): string | null {
  if (
    value === undefined ||
    value === "pending" ||
    value === "in_progress" ||
    value === "completed"
  ) {
    return null;
  }
  return `${label} status must be pending, in_progress, or completed`;
}

function inProgressCount(entries: readonly { status: string }[]): number {
  return entries.filter((entry) => entry.status === "in_progress").length;
}

export async function updatePlan(
  input: {
    runId: string;
    now?: () => Date;
    persist: (event: {
      run_id: string;
      steps: PlanStep[];
      explanation: string | null;
      updated_at: string;
      sha256: string;
    }) => Promise<void>;
  },
  params: unknown,
): Promise<WorkUpdate<WorkState> | { error: string }> {
  const record =
    params !== null && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  const raw = record["plan"] ?? record["steps"];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "plan requires at least one step" };
  }
  if (raw.length > 50) {
    return { error: "plan accepts at most 50 steps" };
  }
  const steps: PlanStep[] = [];
  for (const [index, entry] of raw.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: `plan step ${index + 1} must be an object` };
    }
    const value = entry as Record<string, unknown>;
    const candidate = {
      step: value["step"],
      status: value["status"] ?? "pending",
    };
    const issue = statusError(`plan step ${index + 1}`, candidate.status);
    if (issue !== null) {
      return { error: issue };
    }
    const validation = validateSchema(PlanStepSchema, candidate);
    if (!validation.ok) {
      return {
        error: `plan step ${index + 1}: ${validation.issues
          .map((item) => `${item.path} ${item.message}`)
          .join("; ")}`,
      };
    }
    steps.push(candidate as PlanStep);
  }
  if (inProgressCount(steps) > 1) {
    return { error: "only one plan step may be in_progress" };
  }
  const explanation = record["explanation"];
  if (
    explanation !== undefined &&
    explanation !== null &&
    typeof explanation !== "string"
  ) {
    return { error: "plan explanation must be a string" };
  }
  const updatedAt = (input.now ?? (() => new Date()))().toISOString();
  const normalizedExplanation =
    typeof explanation === "string" && explanation.trim().length > 0
      ? explanation.trim()
      : null;
  const sha256 = recordHash({
    run_id: input.runId,
    steps,
    explanation: normalizedExplanation,
    updated_at: updatedAt,
  });
  const state: WorkState = {
    run_id: input.runId,
    steps,
    explanation: normalizedExplanation,
    updated_at: updatedAt,
    sha256,
  };
  await input.persist({
    run_id: state.run_id,
    steps,
    explanation: normalizedExplanation,
    updated_at: updatedAt,
    sha256,
  });
  return { state, text: formatPlan(state) };
}

export async function updateTodos(
  input: {
    runId: string;
    now?: () => Date;
    persist: (event: {
      run_id: string;
      items: TodoItem[];
      updated_at: string;
      sha256: string;
    }) => Promise<void>;
  },
  params: unknown,
): Promise<WorkUpdate<TodoState> | { error: string }> {
  const record =
    params !== null && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  const raw = record["todos"] ?? record["items"];
  if (!Array.isArray(raw)) {
    return { error: "todos must be an array; send [] to clear the list" };
  }
  if (raw.length > 50) {
    return { error: "todos accepts at most 50 items" };
  }
  const items: TodoItem[] = [];
  for (const [index, entry] of raw.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: `todo ${index + 1} must be an object` };
    }
    const value = entry as Record<string, unknown>;
    const candidate = {
      content: value["content"],
      status: value["status"] ?? "pending",
    };
    const issue = statusError(`todo ${index + 1}`, candidate.status);
    if (issue !== null) {
      return { error: issue };
    }
    const validation = validateSchema(TodoItemSchema, candidate);
    if (!validation.ok) {
      return {
        error: `todo ${index + 1}: ${validation.issues
          .map((item) => `${item.path} ${item.message}`)
          .join("; ")}`,
      };
    }
    items.push(candidate as TodoItem);
  }
  if (inProgressCount(items) > 1) {
    return { error: "only one todo may be in_progress" };
  }
  const updatedAt = (input.now ?? (() => new Date()))().toISOString();
  const sha256 = recordHash({
    run_id: input.runId,
    items,
    updated_at: updatedAt,
  });
  const state: TodoState = {
    run_id: input.runId,
    items,
    updated_at: updatedAt,
    sha256,
  };
  await input.persist({
    run_id: state.run_id,
    items,
    updated_at: updatedAt,
    sha256,
  });
  return { state, text: formatTodos(state) };
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
    ...(isError ? { isError: true } : {}),
  };
}

export function createPlanTool(options: {
  runId: string | (() => string);
  now?: () => Date;
  persist: (event: {
    run_id: string;
    steps: PlanStep[];
    explanation: string | null;
    updated_at: string;
    sha256: string;
  }) => Promise<void>;
}): ToolDefinition<any, any, any> {
  return {
    name: "plan",
    label: "plan",
    description:
      "Record or update the task plan. Send the full ordered step list on every call; it replaces the previous plan. Keep at most one step in_progress.",
    promptSnippet:
      "Record an ordered plan before multi-step work; update statuses as you go",
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              step: { type: "string", minLength: 1 },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                default: "pending",
              },
            },
            required: ["step"],
            additionalProperties: false,
          },
        },
        explanation: { type: "string" },
      },
      required: ["plan"],
      additionalProperties: false,
    } as never,
    async execute(_toolCallId: string, params: unknown) {
      const result = await updatePlan(
        {
          ...options,
          runId:
            typeof options.runId === "function"
              ? options.runId()
              : options.runId,
        },
        params,
      );
      if ("error" in result) {
        return textResult(`denied: ${result.error}`, true);
      }
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          sha256: result.state.sha256,
          steps: result.state.steps.length,
        },
        structuredContent: {
          sha256: result.state.sha256,
          steps: result.state.steps,
        },
      };
    },
  };
}

export function createTodoTool(options: {
  runId: string | (() => string);
  now?: () => Date;
  current?: () => TodoState | null;
  persist: (event: {
    run_id: string;
    items: TodoItem[];
    updated_at: string;
    sha256: string;
  }) => Promise<void>;
}): ToolDefinition<any, any, any> {
  return {
    name: "todo",
    label: "todo",
    description:
      "Record or update the working todo list. Send the full list on every call; [] clears it. Omit todos to read the current list.",
    promptSnippet:
      "Keep a full working todo list; send the whole list on each update",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              content: { type: "string", minLength: 1 },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                default: "pending",
              },
            },
            required: ["content"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    } as never,
    async execute(_toolCallId: string, params: unknown) {
      const record =
        params !== null && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};
      if (!("todos" in record) && !("items" in record)) {
        const current = options.current?.() ?? null;
        return {
          content: [{ type: "text", text: formatTodos(current) }],
          details: {
            sha256: current?.sha256 ?? null,
            items: current?.items.length ?? 0,
          },
          structuredContent: {
            sha256: current?.sha256 ?? null,
            todos: current?.items ?? [],
          },
        };
      }
      const result = await updateTodos(
        {
          ...options,
          runId:
            typeof options.runId === "function"
              ? options.runId()
              : options.runId,
        },
        params,
      );
      if ("error" in result) {
        return textResult(`denied: ${result.error}`, true);
      }
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          sha256: result.state.sha256,
          items: result.state.items.length,
        },
        structuredContent: {
          sha256: result.state.sha256,
          todos: result.state.items,
        },
      };
    },
  };
}
