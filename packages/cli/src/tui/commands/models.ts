import { showModelRoles } from "../format/roles.ts";
import { showFavoriteModels, toggleFavorite } from "../format/model.ts";
import { recordReviewFailure, formatStructuredReview } from "../format/plan.ts";
import { notify } from "../format/notify.ts";
import {
  createStructuredReview,
  generateStructuredReviewFindings,
  readWorkspaceDiffSnapshot,
  StructuredReviewValidationError,
} from "codepunk-core";
import type { TuiCommand } from "../define-command.ts";
import { commandContext } from "../command-context.ts";
import type { TuiState } from "../state.ts";
import { defineCommand } from "../define-command.ts";

export function rolesCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "roles",
    description: "Show configured model roles and subagent pools",
    handler: commandContext(state, async (runtime, context, args) => {
      if (args.trim() !== "" && args.trim() !== "status") {
        context.ui.notify("usage: /roles [status]", "warning");
        return;
      }
      await showModelRoles(runtime, context);
    }),
  });
}

export function reviewCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "review",
    description: "Review the current diff with structured findings",
    handler: commandContext(state, async (runtime, context, args) => {
      if (args.trim() !== "") {
        context.ui.notify("usage: /review", "warning");
        return;
      }
      if (runtime.primaryModel === undefined) {
        const reason = "A model must be selected before /review can run.";
        let recordFailure: string | null = null;
        try {
          await recordReviewFailure(runtime, reason);
        } catch (error) {
          recordFailure =
            error instanceof Error ? error.message : String(error);
        }
        context.ui.notify(
          recordFailure === null
            ? reason
            : `${reason}\nThe review error event could not be written: ${recordFailure}`,
          "warning",
        );
        return;
      }
      try {
        const snapshot = await readWorkspaceDiffSnapshot({
          root: runtime.paths.deliveryRoot,
        });
        if (snapshot.changed_paths.length === 0) {
          context.ui.notify("No diff to review.", "info");
          return;
        }
        const findings = await generateStructuredReviewFindings({
          runtime: runtime.host.services.modelRuntime,
          model: runtime.primaryModel,
          snapshot,
        });
        const review = await createStructuredReview(snapshot, {
          session_id: runtime.session.sessionId,
          run_id: runtime.host.currentRunId ?? runtime.runId ?? "review-only",
          findings,
          append: async (record) => {
            await runtime.host.recordEvent("review/result", record);
          },
        });
        await notify(context, formatStructuredReview(review));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        let recordFailure: string | null = null;
        try {
          await recordReviewFailure(runtime, reason);
        } catch (recordError) {
          recordFailure =
            recordError instanceof Error
              ? recordError.message
              : String(recordError);
        }
        context.ui.notify(
          `/review failed: ${reason}${
            recordFailure === null
              ? ""
              : `\nThe review error event could not be written: ${recordFailure}`
          }`,
          error instanceof StructuredReviewValidationError
            ? "warning"
            : "error",
        );
      }
    }),
  });
}

export function modelsCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "models",
    description: "Select a recent or favorite model",
    handler: commandContext(state, async (_runtime, context) => {
      await showFavoriteModels(state, context);
    }),
  });
}

export function favoriteCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "favorite",
    description: "Toggle the current model in favorites",
    handler: commandContext(state, async (_runtime, context) => {
      await toggleFavorite(state, context);
    }),
  });
}
