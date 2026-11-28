import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CodepunkRuntime } from "codepunk-core";
import type { TuiState } from "./state.ts";

function liveCommandContext(
  state: TuiState,
  initial: ExtensionCommandContext,
): ExtensionCommandContext {
  return new Proxy(initial, {
    get(target, prop, receiver) {
      const active = (state.context ?? target) as ExtensionCommandContext;
      const source = prop in active ? active : target;
      const value = Reflect.get(source, prop, receiver);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
}

export async function waitForIdleTuiCommands(state: TuiState): Promise<void> {
  if ((state.activeCommandCount ?? 0) === 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    const waiters = state.idleCommandWaiters ?? [];
    waiters.push(resolve);
    state.idleCommandWaiters = waiters;
  });
}

function isLiveContext(context: ExtensionCommandContext): boolean {
  try {
    void context.ui;
    return true;
  } catch {
    return false;
  }
}

export function commandContext(
  state: TuiState,
  handler: (
    runtime: CodepunkRuntime,
    context: ExtensionCommandContext,
    args: string,
  ) => Promise<void>,
): (args: string, context: ExtensionCommandContext) => Promise<void> {
  return async (args, context) => {
    const pendingTransition = state.transitionPromise;
    if (pendingTransition !== null && pendingTransition !== undefined) {
      await pendingTransition.catch(() => undefined);
    }
    const activeContext = (
      isLiveContext(context) ? context : (state.context ?? context)
    ) as ExtensionCommandContext;
    const runtime = state.runtime;
    if (runtime === null) {
      if (isLiveContext(activeContext)) {
        activeContext.ui.notify("codepunk runtime is not ready", "error");
      }
      return;
    }
    if (isLiveContext(activeContext)) {
      state.context = activeContext;
      state.channel.attach(activeContext);
    }
    state.activeCommandCount = (state.activeCommandCount ?? 0) + 1;
    try {
      await handler(
        runtime,
        liveCommandContext(state, activeContext),
        args.trim(),
      );
    } finally {
      state.activeCommandCount = Math.max(
        0,
        (state.activeCommandCount ?? 1) - 1,
      );
      if (state.activeCommandCount === 0 && state.idleCommandWaiters) {
        const waiters = state.idleCommandWaiters.splice(0);
        for (const resolve of waiters) {
          resolve();
        }
      }
    }
  };
}
