import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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

export async function openRewindPicker(
  state: TuiState,
  context: ExtensionCommandContext,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  const preview = await runtime.checkpoints.preview("undo", 50);
  const items: RewindCheckpointItem[] = preview.entries.map((entry, index) => ({
    id: entry.id,
    tool: entry.tool,
    displayTarget: entry.display_target,
    createdAt: entry.created_at,
    stepsBack: index + 1,
  }));
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
      await restoreCheckpoint(
        state,
        context,
        "undo",
        String(selection.stepsBack),
      );
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
    handler: commandContext(state, async (_runtime, context, args) => {
      const trimmed = args.trim();
      if (trimmed.length > 0 && /^\d+$/u.test(trimmed)) {
        await restoreCheckpoint(state, context, "undo", trimmed);
        return;
      }
      await openRewindPicker(state, context);
    }),
  });
}
