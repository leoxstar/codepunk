import path from "node:path";
import {
  persistScopedRule,
  writeUserPermissionSelection,
  type CodepunkRuntime,
} from "codepunk-core";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { selectedModel } from "./chrome/model.ts";
import { setupChrome } from "./chrome/setup.ts";
import type { TuiState } from "./state.ts";
export function setTuiRuntime(state: TuiState, runtime: CodepunkRuntime): void {
  state.runtime = runtime;
  state.sandboxNoticeShown = false;
  state.modelOnboardingShown = false;
  if (typeof state.channel.setWorkspaceTrusted === "function") {
    state.channel.setWorkspaceTrusted(runtime.workspaceTrust?.trusted ?? false);
  }
  if (typeof state.channel.setPersistHandler === "function") {
    state.channel.setPersistHandler(async (request) => {
      if (
        request.argv === undefined ||
        request.argv.length === 0 ||
        request.cwd === undefined
      ) {
        return false;
      }
      try {
        const persisted = await persistScopedRule({
          paths: runtime.paths,
          argv: request.argv,
          cwd: request.cwd,
          filePath:
            runtime.config.autonomy.scoped_rules ??
            path.join(runtime.paths.home, "scoped-rules.toml"),
        });
        await writeUserPermissionSelection(runtime.paths, {
          autonomy: "scoped",
          scopedRules: persisted.path,
        });
        runtime.config.autonomy.scoped_rules = persisted.path;
        state.context?.ui.notify(
          [
            `saved exact rule ${persisted.rule.id} for the next session`,
            `argv: ${persisted.rule.argv.join(" ")}`,
            `cwd: ${persisted.rule.cwd}`,
            `file: ${persisted.path}`,
          ].join("\n"),
          "info",
        );
        return true;
      } catch (error) {
        state.context?.ui.notify(
          `exact rule was not saved: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
        return false;
      }
    });
  }
  state.modelSelected = selectedModel(runtime) !== undefined;
  if (state.context !== null) {
    setupChrome(state, state.context);
  }
}

export function applyReplacedRuntime(
  state: TuiState,
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
): void {
  state.context = context;
  state.channel.attach(context);
  state.questionChannel?.attach(context);
  context.ui.setWidget("subagents", undefined);
  state.ready = true;
  state.lastRunId = runtime.host.currentRunId;
  state.lastEvidence = runtime.ledger.all.length;
  setTuiRuntime(state, runtime);
}
