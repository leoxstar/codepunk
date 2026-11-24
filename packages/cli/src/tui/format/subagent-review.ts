import { promises as fs } from "node:fs";
import {
  discardWorktree,
  findDeliveryRoot,
  projectPaths,
  signRun,
  type CodepunkRuntime,
} from "codepunk-core";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BackgroundSubagent } from "../state.ts";
import { openSubagentTranscript } from "../../subagent-transcript.ts";
import {
  boundedSubagentText,
  type ChildTranscriptEvent,
  subagentReviewText,
} from "./subagent-common.ts";

export function transcriptContentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => {
      if (
        part !== null &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .join("");
}

export function transcriptToolCalls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((part) => {
    if (
      part === null ||
      typeof part !== "object" ||
      !("type" in part) ||
      part.type !== "toolCall" ||
      !("name" in part) ||
      typeof part.name !== "string"
    ) {
      return [];
    }
    const id = "id" in part && typeof part.id === "string" ? ` ${part.id}` : "";
    const args =
      "arguments" in part ? JSON.stringify(part.arguments) : "(no arguments)";
    return [`tool call ${part.name}${id}: ${args}`];
  });
}

export async function subagentTranscriptText(
  record: BackgroundSubagent,
): Promise<string> {
  const transcriptPath =
    record.transcriptPath ?? record.result?.transcript_path ?? null;
  if (transcriptPath === null) {
    return `subagent ${record.childSessionId} has no transcript`;
  }
  const limit = 4 * 1024 * 1024;
  const handle = await fs.open(transcriptPath, "r");
  let raw: string;
  let truncatedFile: boolean;
  try {
    const stat = await handle.stat();
    const size = Math.min(stat.size, limit);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        size - offset,
        offset,
      );
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    raw = buffer.subarray(0, offset).toString("utf8");
    truncatedFile = stat.size > offset;
  } finally {
    await handle.close();
  }
  const lines = raw.split(/\r?\n/u).filter((line) => line.length > 0);
  const sections: string[] = [];
  let parsed = 0;
  let unparsed = 0;
  for (const line of lines) {
    let event: ChildTranscriptEvent;
    try {
      event = JSON.parse(line) as ChildTranscriptEvent;
    } catch {
      unparsed += 1;
      sections.push(`raw: ${line}`);
      continue;
    }
    parsed += 1;
    if (event.type === "message_end") {
      const role = event.message?.role;
      const text = transcriptContentText(event.message?.content).trim();
      if (role === "assistant" || role === "user") {
        if (text.length > 0) {
          sections.push(`${String(role)}:\n${text}`);
        }
        if (role === "assistant") {
          sections.push(...transcriptToolCalls(event.message?.content));
        }
      }
      continue;
    }
    if (event.type === "tool_execution_end") {
      const tool = typeof event.toolName === "string" ? event.toolName : "tool";
      const output = transcriptContentText(event.result?.content).trim();
      sections.push(
        `tool ${tool}${event.isError === true ? " (error)" : ""}:\n${
          output.length > 0 ? output : "(no text output)"
        }`,
      );
    }
  }
  return boundedSubagentText(
    [
      `subagent ${record.childSessionId} transcript`,
      `file: ${transcriptPath}`,
      `events: ${parsed} parsed / ${unparsed} raw lines`,
      ...(truncatedFile
        ? [
            `preview: first ${limit} bytes; open the file for the full transcript`,
          ]
        : []),
      "",
      ...(sections.length === 0
        ? ["(the transcript contains no assistant or tool events)"]
        : sections),
    ].join("\n"),
    24_000,
  );
}

export async function showSubagentTranscript(
  context: ExtensionCommandContext,
  record: BackgroundSubagent,
): Promise<void> {
  const transcriptPath =
    record.transcriptPath ?? record.result?.transcript_path ?? null;
  if (transcriptPath !== null && context.mode === "tui") {
    await openSubagentTranscript(context, {
      childSessionId: record.childSessionId,
      profile: record.profile,
      transcriptPath,
      status: () => record.status,
      error: () => record.error,
    });
    return;
  }
  try {
    context.ui.notify(await subagentTranscriptText(record), "info");
  } catch (error) {
    context.ui.notify(
      `subagent transcript failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
}

export async function childProjectPaths(
  runtime: CodepunkRuntime,
  record: BackgroundSubagent,
): Promise<{
  paths: ReturnType<typeof projectPaths>;
  cwd: string;
  projectRoot: string;
}> {
  const worktree = record.worktree ?? record.result?.worktree ?? null;
  const context = await findDeliveryRoot(worktree ?? runtime.paths.cwd);
  return {
    paths: projectPaths(context, runtime.paths.home),
    cwd: worktree ?? runtime.paths.cwd,
    projectRoot: context.deliveryRoot,
  };
}

export async function reviewSubagent(
  context: ExtensionCommandContext,
  record: BackgroundSubagent,
): Promise<void> {
  try {
    context.ui.notify(await subagentReviewText(record), "info");
  } catch (error) {
    context.ui.notify(
      `subagent review failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
}

export async function signSubagent(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  record: BackgroundSubagent,
): Promise<void> {
  const result = record.result;
  if (
    record.status !== "completed" ||
    result === null ||
    record.worktree === null
  ) {
    context.ui.notify(
      `subagent ${record.childSessionId} has no completed worktree to sign`,
      "warning",
    );
    return;
  }
  if (
    result.child_run_id === null ||
    result.child_evidence_path === null ||
    result.evidence_head === null
  ) {
    context.ui.notify(
      `subagent ${record.childSessionId} has no child evidence to sign`,
      "warning",
    );
    return;
  }
  await reviewSubagent(context, record);
  const selected = await context.ui.select(
    `Sign subagent ${record.childSessionId}`,
    ["Sign as complete", "Sign as incomplete", "Cancel"],
  );
  if (selected === undefined || selected === "Cancel") {
    return;
  }
  const signed = selected === "Sign as complete" ? "complete" : "incomplete";
  try {
    const child = await childProjectPaths(runtime, record);
    const signedResult = await signRun({
      paths: child.paths,
      cwd: child.cwd,
      projectRoot: child.projectRoot,
      runId: result.child_run_id,
      request: {
        version: 1,
        evidence_head: result.evidence_head,
        signed_verdict: signed,
        channel: "tui",
        actor: "local-user",
        is_tty: true,
        source: "human",
        previous_sign_off_id: record.delivery?.verdict.sign_off_id ?? null,
      },
    });
    record.delivery = {
      state: signed === "complete" ? "signed" : "signed-incomplete",
      verdict: signedResult.verdict,
    };
    context.ui.notify(
      [
        `subagent ${record.childSessionId} signed ${signed}`,
        `verdict: ${signedResult.verdict.verdict}`,
        ...(signedResult.verdict.verdict === "complete"
          ? [
              `next: /agents merge ${record.childSessionId}`,
              `discard: /agents discard ${record.childSessionId}`,
            ]
          : [`the child run remains incomplete; merge is blocked`]),
      ].join("\n"),
      signedResult.verdict.verdict === "complete" ? "info" : "warning",
    );
  } catch (error) {
    context.ui.notify(
      `subagent sign failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
}

export async function discardSubagent(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  record: BackgroundSubagent,
): Promise<void> {
  const worktree = record.worktree ?? record.result?.worktree ?? null;
  if (worktree === null) {
    context.ui.notify(
      `subagent ${record.childSessionId} has no worktree to discard`,
      "warning",
    );
    return;
  }
  const confirmed = await context.ui.select(
    `Discard subagent ${record.childSessionId} worktree?`,
    ["Discard unmerged worktree", "Cancel"],
  );
  if (confirmed !== "Discard unmerged worktree") {
    return;
  }
  try {
    await discardWorktree({
      repoRoot: runtime.paths.deliveryRoot,
      worktree,
    });
    record.worktree = null;
    if (record.result !== null) {
      record.result.worktree = null;
    }
    if (record.delivery !== null) {
      record.delivery = {
        ...record.delivery,
        state: "discarded",
      };
    }
    context.ui.notify(
      `subagent ${record.childSessionId} worktree discarded`,
      "info",
    );
  } catch (error) {
    context.ui.notify(
      `subagent discard failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
}

/**
 * Abort running child hosts and wait briefly for them to settle. Pi's quit
 * path exits the process right after `session_shutdown`, so this runs from
 * that handler while the parent session can still record child results, and
 * again from the TUI runner's `finally`, where it normally finds nothing.
 */
