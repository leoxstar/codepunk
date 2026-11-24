import {
  MODEL_ROLE_NAMES,
  readWorkspaceCommitPreview,
  readWorkspaceDiff,
  type AgentProfile,
  type ModelRoleName,
  type SubagentStreamEvent,
} from "codepunk-core";
import type { BackgroundSubagent, TuiState } from "../state.ts";
import { setRuntimeStatus } from "../chrome/status.ts";
export interface SubagentInvocation {
  task: string;
  profileName?: string;
  role?: ModelRoleName;
  poolName?: string;
  model?: string;
  worktree: boolean;
  shared: boolean;
}

export function parseSubagentInvocation(args: string): SubagentInvocation {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  let profileName: string | undefined;
  let role: ModelRoleName | undefined;
  let poolName: string | undefined;
  let model: string | undefined;
  let worktree = false;
  let shared = false;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("--")) {
      break;
    }
    if (token === "--worktree") {
      worktree = true;
      index += 1;
      continue;
    }
    if (token === "--shared") {
      shared = true;
      index += 1;
      continue;
    }
    if (
      token !== "--profile" &&
      token !== "--role" &&
      token !== "--pool" &&
      token !== "--model"
    ) {
      throw new Error(
        "usage: /subagent [--profile <name>] [--role plan|smol|slow] [--pool <name>] [--model <provider/model>] [--worktree|--shared] <task>",
      );
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`/subagent ${token} requires a value`);
    }
    if (token === "--profile") {
      profileName = value;
    } else if (token === "--role") {
      if (!(MODEL_ROLE_NAMES as readonly string[]).includes(value)) {
        throw new Error(`--role must be ${MODEL_ROLE_NAMES.join(", ")}`);
      }
      role = value as ModelRoleName;
    } else if (token === "--pool") {
      poolName = value;
    } else {
      model = value;
    }
    index += 2;
  }
  const task = tokens.slice(index).join(" ").trim();
  if (task.length === 0) {
    throw new Error(
      "usage: /subagent [--profile <name>] [--role plan|smol|slow] [--pool <name>] [--model <provider/model>] [--worktree|--shared] <task>",
    );
  }
  if (role !== undefined && model !== undefined) {
    throw new Error("--role and --model are mutually exclusive");
  }
  if (worktree && shared) {
    throw new Error("--worktree and --shared are mutually exclusive");
  }
  return {
    task,
    ...(profileName !== undefined ? { profileName } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(poolName !== undefined ? { poolName } : {}),
    ...(model !== undefined ? { model } : {}),
    worktree,
    shared,
  };
}

export function profilePool(profile: AgentProfile): string[] {
  return profile.model === null
    ? []
    : [
        profile.model,
        ...profile.fallback.filter((entry) => entry !== profile.model),
      ];
}

export function profileTools(profile: AgentProfile | undefined): string[] {
  if (profile === undefined) {
    return ["read", "search"];
  }
  return Object.entries(profile.tools)
    .filter(([name, enabled]) => name !== "memory_search" && enabled)
    .map(([name]) => name);
}

export function formatSubagents(state: TuiState): string {
  const records = [...(state.subagents?.values() ?? [])];
  if (records.length === 0) {
    return "No subagents. Start one with /subagent [--profile <name>] <task>.";
  }
  return records
    .map((record) => {
      const elapsed = Math.max(
        0,
        Math.floor((Date.now() - record.startedAt) / 1_000),
      );
      const prompt = record.prompt.replace(/\s+/gu, " ").slice(0, 100);
      const delivery =
        record.delivery === null ? "" : `  ${record.delivery.state}`;
      const worktree = record.worktree === null ? "" : "  worktree";
      return `${record.childSessionId}  ${record.status}  ${elapsed}s  ${
        record.profile ?? "built-in"
      }  ${record.isolation}${delivery}${worktree}  ${prompt}`;
    })
    .join("\n");
}

export function boundedSubagentText(value: string, limit = 12_000): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n[truncated]`;
}

export function isCodepunkReviewPath(filePath: string): boolean {
  const normalized = filePath.split("\\").join("/");
  return normalized === ".codepunk/.gitignore";
}

export async function subagentReviewText(
  record: BackgroundSubagent,
): Promise<string> {
  const worktree = record.worktree ?? record.result?.worktree ?? null;
  if (worktree === null) {
    return `subagent ${record.childSessionId} has no worktree to review`;
  }
  const [diff, preview] = await Promise.all([
    readWorkspaceDiff({ root: worktree, maxBytes: 48 * 1024 }),
    readWorkspaceCommitPreview({ root: worktree }),
  ]);
  const files = [
    ...preview.staged,
    ...preview.unstaged,
    ...preview.untracked,
  ].filter((entry) => !isCodepunkReviewPath(entry));
  const frozenPaths = record.delivery?.handoff?.changed_paths ?? [];
  const untracked = diff.untracked
    .split("\n")
    .filter((entry) => entry.length > 0 && !isCodepunkReviewPath(entry));
  const fileLines =
    files.length > 0
      ? [...new Set(files)].map((entry) => `  ${entry}`).join("\n")
      : frozenPaths.length > 0
        ? frozenPaths.map((entry) => `  ${entry} (frozen)`).join("\n")
        : "  (no files)";
  const patch = [diff.staged, diff.unstaged]
    .filter((entry) => entry.length > 0)
    .join("\n");
  return boundedSubagentText(
    [
      `subagent ${record.childSessionId} · ${record.status}${
        record.delivery === null ? "" : ` · ${record.delivery.state}`
      }`,
      `profile: ${record.profile ?? "built-in"} · isolation: ${record.isolation}`,
      `worktree: ${worktree}`,
      `files: ${files.length > 0 ? files.length : frozenPaths.length}`,
      fileLines,
      ...(preview.staged_stat.length === 0 ? [] : [preview.staged_stat]),
      ...(preview.unstaged_stat.length === 0 ? [] : [preview.unstaged_stat]),
      ...(untracked.length === 0
        ? []
        : [`untracked:\n${untracked.join("\n")}`]),
      ...(patch.length === 0 ? [] : ["patch:", patch]),
      ...(diff.truncated ? ["[patch truncated]"] : []),
      `summary: ${record.result?.summary ?? record.error ?? record.status}`,
    ].join("\n\n"),
  );
}

export interface ChildTranscriptEvent {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
  toolName?: unknown;
  isError?: unknown;
  result?: {
    content?: unknown;
  };
}

export const SUBAGENT_STREAM_LIMIT = 1_200;
export const SUBAGENT_WIDGET_LINES = 6;
export const SUBAGENT_WIDGET_INTERVAL_MS = 120;

export function appendSubagentStream(previous: string, text: string): string {
  const combined = `${previous}${text}`.replace(/\r/gu, "");
  return combined.length <= SUBAGENT_STREAM_LIMIT
    ? combined
    : combined.slice(-SUBAGENT_STREAM_LIMIT);
}

export function subagentWidgetLines(record: BackgroundSubagent): string[] {
  const preview = record.streamTail
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-2)
    .map((line) => (line.length > 160 ? line.slice(-160) : line));
  if (preview.length === 0) {
    return [];
  }
  return [
    `${record.childSessionId.slice(0, 10)} ${record.profile ?? "built-in"}${
      record.lastTool === null ? "" : ` · ${record.lastTool}`
    }`,
    ...preview.map((line) => `  ${line}`),
  ];
}

export function applySubagentWidget(state: TuiState): void {
  if (state.context === null) {
    return;
  }
  const lines = [...(state.subagents?.values() ?? [])]
    .filter((record) => record.status === "running")
    .flatMap(subagentWidgetLines)
    .slice(-SUBAGENT_WIDGET_LINES);
  state.context.ui.setWidget(
    "subagents",
    lines.length === 0 ? undefined : lines,
    { placement: "aboveEditor" },
  );
}

export function observeSubagentEvent(
  state: TuiState,
  record: BackgroundSubagent,
  event: SubagentStreamEvent,
): void {
  if (record.status !== "running") {
    return;
  }
  if (event.type === "assistant_delta") {
    record.streamTail = appendSubagentStream(record.streamTail, event.text);
  } else if (event.type === "tool_start") {
    record.lastTool = event.tool;
  } else {
    record.streamTail = appendSubagentStream(
      record.streamTail,
      `\n[${event.tool}${event.is_error ? " error" : ""}] ${
        event.output.trim().slice(0, 800) || "(no text output)"
      }\n`,
    );
  }
  const now = Date.now();
  if (now - record.lastStreamUpdate < SUBAGENT_WIDGET_INTERVAL_MS) {
    return;
  }
  record.lastStreamUpdate = now;
  applySubagentWidget(state);
}

export function updateSubagentStatus(state: TuiState): void {
  if (state.context === null) {
    return;
  }
  const records = [...(state.subagents?.values() ?? [])];
  const running = records.filter(
    (record) => record.status === "running",
  ).length;
  setRuntimeStatus(
    state,
    state.context,
    "agents",
    records.length === 0
      ? "none"
      : `${running} running / ${records.length} total`,
  );
  applySubagentWidget(state);
}
