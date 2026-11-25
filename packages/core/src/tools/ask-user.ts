import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface AskUserOption {
  readonly label: string;
  readonly description?: string;
}

export interface AskUserRequest {
  readonly question: string;
  readonly options: readonly AskUserOption[];
  readonly allowFreeform: boolean;
}

export interface AskUserAnswer {
  readonly cancelled: boolean;
  readonly selectedIndex: number | null;
  readonly selectedLabel: string | null;
  readonly freeformText: string | null;
}

export interface AskUserChannel {
  ask(request: AskUserRequest): Promise<AskUserAnswer | null>;
}

export const ASK_USER_TOOL_NAME = "ask_user" as const;

function parseOptions(raw: unknown): AskUserOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: AskUserOption[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim().length > 0) {
      result.push({ label: item.trim() });
      continue;
    }
    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const label =
        typeof record["label"] === "string" ? record["label"].trim() : "";
      if (label.length === 0) {
        continue;
      }
      const description =
        typeof record["description"] === "string" &&
        record["description"].trim().length > 0
          ? record["description"].trim()
          : undefined;
      result.push(
        description === undefined ? { label } : { label, description },
      );
    }
  }
  return result.slice(0, 9);
}

export function createAskUserTool(
  channel: AskUserChannel | null,
): ToolDefinition<any, any, any> {
  return {
    name: ASK_USER_TOOL_NAME,
    label: ASK_USER_TOOL_NAME,
    description:
      "Ask the user a structured multiple-choice question when a key decision or clarification is needed. " +
      "Put the recommended option first.",
    promptSnippet:
      "Use ask_user to present concise options when user input materially changes the approach",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Concise question for the user",
        },
        options: {
          type: "array",
          minItems: 1,
          maxItems: 9,
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              description: { type: "string" },
            },
            required: ["label"],
            additionalProperties: false,
          },
          description: "Ordered options; put the recommended option first",
        },
        allow_freeform: {
          type: "boolean",
          default: true,
          description: "Allow the user to type a custom answer",
        },
      },
      required: ["question", "options"],
      additionalProperties: false,
    } as never,
    async execute(_toolCallId, params: Record<string, unknown>) {
      const question =
        typeof params["question"] === "string" ? params["question"].trim() : "";
      if (question.length === 0) {
        return {
          content: [
            { type: "text", text: "ask_user requires a non-empty question" },
          ],
          details: {},
          structuredContent: { answered: false, reason: "missing_question" },
          isError: true,
        };
      }
      const options = parseOptions(params["options"]);
      if (options.length === 0) {
        return {
          content: [
            { type: "text", text: "ask_user requires at least one option" },
          ],
          details: {},
          structuredContent: { answered: false, reason: "missing_options" },
          isError: true,
        };
      }
      if (channel === null) {
        return {
          content: [
            {
              type: "text",
              text: "No interactive user channel is available; proceed with the best reasonable default and state your assumption.",
            },
          ],
          details: {},
          structuredContent: { answered: false, reason: "channel_unavailable" },
        };
      }
      const allowFreeform = params["allow_freeform"] !== false;
      const answer = await channel.ask({ question, options, allowFreeform });
      if (answer === null || answer.cancelled) {
        return {
          content: [
            { type: "text", text: "User cancelled the question prompt." },
          ],
          details: {},
          structuredContent: { answered: false, cancelled: true },
        };
      }
      const responseText =
        answer.freeformText !== null
          ? answer.freeformText
          : (answer.selectedLabel ?? "");
      return {
        content: [{ type: "text", text: `User selected: ${responseText}` }],
        details: {
          selectedIndex: answer.selectedIndex,
          selectedLabel: answer.selectedLabel,
          freeform: answer.freeformText !== null,
        },
        structuredContent: {
          answered: true,
          cancelled: false,
          selected_index: answer.selectedIndex,
          selected_label: answer.selectedLabel,
          freeform_text: answer.freeformText,
        },
      };
    },
  };
}
