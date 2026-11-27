import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CodepunkRuntime } from "codepunk-core";
import { commandContext } from "../command-context.ts";
import { defineCommand, type TuiCommand } from "../define-command.ts";
import { restoreCheckpoint } from "../format/commit.ts";
import { navigateSessionTree } from "./session.ts";
import { defaultViewportHeight } from "../components/frame.ts";
import type {
  RewindCheckpointItem,
  RewindSelection,
} from "../components/rewind-picker.ts";
import type { TuiState } from "../state.ts";

async function rewindShadowSteps(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  stepsBack: number,
): Promise<void> {
  try {
    const res = await runtime.shadowGit.rewindSteps(stepsBack);
    const totalTouched =
      res.restoredFiles.length + res.removedAddedFiles.length;
    context.ui.notify(
      `Rewound worktree ${stepsBack} step(s) via Shadow Git (${totalTouched} file(s) restored/cleaned; before ${res.snapshot.tool}: ${res.snapshot.label}).`,
      "info",
    );
  } catch (error) {
    context.ui.notify(
      `Shadow rewind failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

export async function openRewindPicker(
  state: TuiState,
  context: ExtensionCommandContext,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  const shadowSnapshots = await runtime.shadowGit.list(40).catch(() => []);
  const items: RewindCheckpointItem[] =
    shadowSnapshots.length > 0
      ? shadowSnapshots.map((snap, index) => ({
          id: snap.id,
          tool: snap.tool === "manual" ? "shadow" : snap.tool,
          displayTarget: `${snap.label} (${snap.changed_files.length} file${snap.changed_files.length === 1 ? "" : "s"})`,
          createdAt: snap.created_at,
          stepsBack: index + 1,
          source: "shadow" as const,
        }))
      : (await runtime.checkpoints.preview("undo", 50)).entries.map(
          (entry, index) => ({
            id: entry.id,
            tool: entry.tool,
            displayTarget: entry.display_target,
            createdAt: entry.created_at,
            stepsBack: index + 1,
            source: "checkpoint" as const,
          }),
        );
  try {
    const { createRewindPicker } =
      await import("../components/rewind-picker.ts");
    const selection = await context.ui.custom<RewindSelection | null>(
      (_tui, theme, keybindings, done) =>
        createRewindPicker(
          {
            title: "Rewind checkpoints & branches",
            items,
            viewportHeight: defaultViewportHeight(),
          },
          theme,
          keybindings,
          done,
        ),
    );
    if (selection === null || selection === undefined) {
      return;
    }
    if (selection.mode === "files" || selection.mode === "both") {
      if (selection.source === "shadow") {
        await rewindShadowSteps(runtime, context, selection.stepsBack);
      } else {
        await restoreCheckpoint(
          state,
          context,
          "undo",
          String(selection.stepsBack),
        );
      }
    }
    if (selection.mode === "tree" || selection.mode === "both") {
      await navigateSessionTree(state, context, "list");
    }
  } catch {
    await restoreCheckpoint(state, context, "undo", "");
  }
}

export function rewindCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "rewind",
    description:
      "Interactively rewind recent file checkpoints and/or conversation branches",
    handler: commandContext(state, async (runtime, context, args) => {
      const tokens = args.trim().split(/\s+/u).filter(Boolean);
      if (tokens[0] === "shadow") {
        const count =
          tokens[1] === undefined ? 1 : Number.parseInt(tokens[1], 10);
        if (!Number.isSafeInteger(count) || count < 1) {
          context.ui.notify(
            "usage: /rewind [shadow [count]|<count>]",
            "warning",
          );
          return;
        }
        await rewindShadowSteps(runtime, context, count);
        return;
      }
      if (tokens.length === 1 && /^\d+$/u.test(tokens[0]!)) {
        await restoreCheckpoint(state, context, "undo", tokens[0]!);
        return;
      }
      await openRewindPicker(state, context);
    }),
  });
}
