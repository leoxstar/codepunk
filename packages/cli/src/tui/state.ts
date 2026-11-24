import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  BackgroundTaskManager,
  CodepunkRuntime,
  SideTaskQueue,
  SubagentHostResult,
  SubagentModelPoolManager,
} from "codepunk-core";
import type { MergeRecord, TaskHandoff, Verdict } from "codepunk-protocol";
import type { ResumeHint } from "../exit-hint.ts";
import type { TuiApprovalChannel } from "../tui.ts";

export interface TuiState {
  runtime: CodepunkRuntime | null;
  context: ExtensionContext | null;
  channel: TuiApprovalChannel;
  lastRunId: string | null;
  lastEvidence: number;
  warningsShown: boolean;
  modelSelected: boolean;
  modelOnboardingShown?: boolean;
  ready: boolean;
  childHostArgv: readonly string[];
  shuttingDown: boolean;
  titleTimers?: NodeJS.Timeout[];
  buildWatch?: NodeJS.Timeout | undefined;
  subagents?: Map<string, BackgroundSubagent>;
  backgroundTasks?: BackgroundTaskManager;
  sideQueue?: SideTaskQueue;
  sideQueueSessionId?: string;
  modelPool?: SubagentModelPoolManager;
  activeToolsBeforePreset?: string[];
  /**
   * Slash command names the Pi host will accept in this session. Pi's builtin
   * table is not exported from the package root, and `pi.getCommands()` covers
   * only extensions, prompts, and skills, so the accepted set is loaded from
   * the installed host module at session start.
   */
  hostCommands: Set<string>;
  replaceRuntime?: (target: TuiSessionTarget) => Promise<TuiRuntimeReplacement>;
  /** Armed on quit; prints the resume command after Pi restores the terminal. */
  resumeHint?: ResumeHint;
}

export interface TuiSessionTarget {
  sessionId?: string;
  newSession?: boolean;
}

export interface TuiRuntimeReplacement {
  runtime: CodepunkRuntime;
  context: ExtensionCommandContext;
}

export interface BackgroundSubagent {
  childSessionId: string;
  prompt: string;
  profile: string | null;
  isolation: "shared" | "worktree";
  startedAt: number;
  status: "running" | "completed" | "failed" | "stopped";
  result: SubagentHostResult | null;
  error: string | null;
  worktree: string | null;
  transcriptPath: string | null;
  streamTail: string;
  lastTool: string | null;
  lastStreamUpdate: number;
  delivery: BackgroundSubagentDelivery | null;
  controller: AbortController;
  promise: Promise<void>;
}

export interface BackgroundSubagentDelivery {
  state: "signed" | "signed-incomplete" | "merged" | "discarded";
  verdict: Verdict;
  handoff?: TaskHandoff;
  handoffPath?: string;
  merge?: MergeRecord;
  mergeRecordPath?: string;
}
