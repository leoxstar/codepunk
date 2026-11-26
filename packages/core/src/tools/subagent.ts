import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_TOOL_NAME = "subagent" as const;

export interface SubagentToolRequest {
  readonly task: string;
  readonly role?: string;
}

export interface SubagentToolOutcome {
  readonly sessionId: string;
  readonly status: "completed" | "failed" | "stopped";
  readonly summary: string;
  readonly evidenceRef: string | null;
  readonly exitCode: number | null;
  readonly error?: string;
}

export type SubagentToolExecutor = (
  request: SubagentToolRequest,
  signal?: AbortSignal,
) => Promise<SubagentToolOutcome>;

const MAX_SUMMARY_CHARS = 8_000;
const MAX_PARALLEL_TASKS = 4;

function truncateSummary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_SUMMARY_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SUMMARY_CHARS)}\n… [truncated]`;
}

function parseBatchTasks(
  params: Record<string, unknown>,
): SubagentToolRequest[] | null {
  const rawTasks = params["tasks"];
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    return null;
  }
  const parsed: SubagentToolRequest[] = [];
  for (const item of rawTasks.slice(0, MAX_PARALLEL_TASKS)) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const task =
      typeof record["task"] === "string" ? record["task"].trim() : "";
    if (task.length === 0) {
      continue;
    }
    const role =
      typeof record["role"] === "string" && record["role"].trim().length > 0
        ? record["role"].trim()
        : undefined;
    parsed.push(role === undefined ? { task } : { task, role });
  }
  return parsed.length > 0 ? parsed : null;
}

export function createSubagentTool(
  executor: SubagentToolExecutor | null,
): ToolDefinition<any, any, any> {
  return {
    name: SUBAGENT_TOOL_NAME,
    label: SUBAGENT_TOOL_NAME,
    description:
      "Delegate one or up to 4 parallel focused read-only codebase exploration tasks to isolated depth-1 child agents. " +
      "Children can read and search files without mutating the workspace and return bounded summaries with evidence.",
    promptSnippet:
      "Use subagent to delegate independent read-only research or parallel codebase exploration tasks in isolation",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Clear, self-contained read-only task prompt for a single child agent",
        },
        role: {
          type: "string",
          description:
            "Optional short label describing the exploration focus (e.g. 'research', 'audit')",
        },
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: MAX_PARALLEL_TASKS,
          description:
            "Optional batch of up to 4 independent read-only tasks to run in parallel",
          items: {
            type: "object",
            properties: {
              task: { type: "string" },
              role: { type: "string" },
            },
            required: ["task"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    } as never,
    async execute(
      _toolCallId,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
    ) {
      const batch = parseBatchTasks(params);
      const singleTask =
        typeof params["task"] === "string" ? params["task"].trim() : "";
      if (batch === null && singleTask.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "subagent requires a non-empty task or tasks array",
            },
          ],
          details: {},
          structuredContent: { ok: false, reason: "missing_task" },
          isError: true,
        };
      }
      if (executor === null) {
        return {
          content: [
            {
              type: "text",
              text: "subagent delegation is unavailable in this execution surface; inspect files directly with read and search.",
            },
          ],
          details: {},
          structuredContent: { ok: false, reason: "executor_unavailable" },
          isError: true,
        };
      }
      if (batch !== null) {
        try {
          const outcomes = await Promise.all(
            batch.map((request) => executor(request, signal)),
          );
          const perTaskCap = Math.max(
            1_500,
            Math.floor(MAX_SUMMARY_CHARS / outcomes.length),
          );
          const sections = outcomes.map((outcome, index) => {
            const label = batch[index]?.role ?? `task-${index + 1}`;
            const raw = outcome.summary.trim();
            const summary =
              raw.length <= perTaskCap
                ? raw
                : `${raw.slice(0, perTaskCap)}\n… [truncated]`;
            return [
              `### [${index + 1}] ${label} — ${outcome.sessionId} (${outcome.status})`,
              ...(outcome.evidenceRef === null
                ? []
                : [`evidence: ${outcome.evidenceRef}`]),
              ...(outcome.error !== undefined
                ? [`error: ${outcome.error}`]
                : []),
              summary.length > 0 ? summary : "(no summary returned)",
            ].join("\n");
          });
          const anyError = outcomes.some(
            (outcome) => outcome.status !== "completed",
          );
          return {
            content: [{ type: "text", text: sections.join("\n\n") }],
            details: {
              count: outcomes.length,
              status: anyError ? "partial" : "completed",
              sessionIds: outcomes.map((outcome) => outcome.sessionId),
            },
            structuredContent: {
              count: outcomes.length,
              results: outcomes.map((outcome) => ({
                session_id: outcome.sessionId,
                status: outcome.status,
                summary: truncateSummary(outcome.summary),
                evidence_ref: outcome.evidenceRef,
                exit_code: outcome.exitCode,
                ...(outcome.error === undefined
                  ? {}
                  : { error: outcome.error }),
              })),
            },
            ...(anyError ? { isError: true } : {}),
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              { type: "text", text: `subagent batch failed: ${message}` },
            ],
            details: {},
            structuredContent: { ok: false, error: message },
            isError: true,
          };
        }
      }
      const role =
        typeof params["role"] === "string" && params["role"].trim().length > 0
          ? params["role"].trim()
          : undefined;
      try {
        const outcome = await executor(
          role === undefined
            ? { task: singleTask }
            : { task: singleTask, role },
          signal,
        );
        const summary = truncateSummary(outcome.summary);
        const isError = outcome.status !== "completed";
        const textLines = [
          `Subagent ${outcome.sessionId} (${outcome.status})`,
          ...(outcome.evidenceRef === null
            ? []
            : [`evidence: ${outcome.evidenceRef}`]),
          ...(outcome.error !== undefined ? [`error: ${outcome.error}`] : []),
          "",
          summary.length > 0 ? summary : "(no summary returned)",
        ];
        return {
          content: [{ type: "text", text: textLines.join("\n") }],
          details: {
            sessionId: outcome.sessionId,
            status: outcome.status,
            evidenceRef: outcome.evidenceRef,
            exitCode: outcome.exitCode,
          },
          structuredContent: {
            session_id: outcome.sessionId,
            status: outcome.status,
            summary,
            evidence_ref: outcome.evidenceRef,
            exit_code: outcome.exitCode,
            ...(outcome.error === undefined ? {} : { error: outcome.error }),
          },
          ...(isError ? { isError: true } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `subagent failed: ${message}` }],
          details: {},
          structuredContent: { ok: false, error: message },
          isError: true,
        };
      }
    },
  };
}
