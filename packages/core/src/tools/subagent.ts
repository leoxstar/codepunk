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

function truncateSummary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_SUMMARY_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SUMMARY_CHARS)}\n… [truncated]`;
}

export function createSubagentTool(
  executor: SubagentToolExecutor | null,
): ToolDefinition<any, any, any> {
  return {
    name: SUBAGENT_TOOL_NAME,
    label: SUBAGENT_TOOL_NAME,
    description:
      "Delegate a focused read-only codebase exploration or analysis task to an isolated depth-1 child agent. " +
      "The child can read and search files without mutating the workspace and returns a bounded summary with evidence.",
    promptSnippet:
      "Use subagent to delegate independent read-only research or codebase exploration tasks in isolation",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Clear, self-contained read-only task prompt for the child agent",
        },
        role: {
          type: "string",
          description:
            "Optional short label describing the exploration focus (e.g. 'research', 'audit')",
        },
      },
      required: ["task"],
      additionalProperties: false,
    } as never,
    async execute(
      _toolCallId,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
    ) {
      const task =
        typeof params["task"] === "string" ? params["task"].trim() : "";
      if (task.length === 0) {
        return {
          content: [
            { type: "text", text: "subagent requires a non-empty task" },
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
      const role =
        typeof params["role"] === "string" && params["role"].trim().length > 0
          ? params["role"].trim()
          : undefined;
      try {
        const outcome = await executor(
          role === undefined ? { task } : { task, role },
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
