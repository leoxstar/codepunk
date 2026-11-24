import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CodepunkRuntime } from "codepunk-core";
import type { TuiState } from "./state.ts";

export function commandContext(
  state: TuiState,
  handler: (
    runtime: CodepunkRuntime,
    context: ExtensionCommandContext,
    args: string,
  ) => Promise<void>,
): (args: string, context: ExtensionCommandContext) => Promise<void> {
  return async (args, context) => {
    state.context = context;
    state.channel.attach(context);
    const runtime = state.runtime;
    if (runtime === null) {
      context.ui.notify("codepunk runtime is not ready", "error");
      return;
    }
    await handler(runtime, context, args.trim());
  };
}
