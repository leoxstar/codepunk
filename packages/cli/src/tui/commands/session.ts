import {
  LOCK_LEASE_MS,
  SessionStore,
  forkLiveSession,
  isBenignTailEventKind,
  listProjectSessions,
  readLock,
  searchProjectSessions,
  staleLockReason,
  type CodepunkRuntime,
} from "codepunk-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchSessionChoice } from "../../session-resume.ts";
import {
  type TreeNodeView,
  formatSessionTree,
  sessionChoiceLabel,
  sessionSearchChoiceLabels,
} from "../format/session-tree.ts";
import type { TuiState } from "../state.ts";

export async function sessionResumeIssue(
  runtime: Pick<CodepunkRuntime, "paths">,
  sessionId: string,
): Promise<string | null> {
  try {
    const store = await SessionStore.open({
      rootDir: runtime.paths.home,
      cwd: runtime.paths.cwd,
      projectRoot: runtime.paths.deliveryRoot,
      projectId: runtime.paths.projectId,
      sessionId,
    });
    const lock = await readLock(store.paths.lockPath);
    if (lock !== null) {
      const reason = staleLockReason(lock, new Date(), LOCK_LEASE_MS);
      if (reason !== null) {
        return `session ${sessionId} is not resumable now: ${reason}`;
      }
    }
    const state = await store.readAgentState();
    if (state === null) {
      return store.allEvents.length === 0
        ? null
        : `session ${sessionId} has events but no agent-state.json`;
    }
    if (!store.hasContiguousEventSeqs()) {
      return `session ${sessionId} event log seqs are not contiguous`;
    }
    if (
      store.metadata.log_seq > store.lastSeq ||
      store.metadata.state_covers_seq > store.lastSeq
    ) {
      return `session ${sessionId} metadata is ahead of its event log`;
    }
    const resumed = await store.resume();
    if (
      resumed.uncommittedEvents.some(
        (event) => !isBenignTailEventKind(event.kind),
      )
    ) {
      return `session ${sessionId} has ${resumed.uncommittedEvents.length} uncommitted event(s) after the last agent-state snapshot`;
    }
    if (
      resumed.uncommittedEvents.length > 0 &&
      (resumed.state.entries === undefined ||
        resumed.state.leaf_id === undefined)
    ) {
      return `session ${sessionId} has benign uncommitted events but the agent-state entry tree is incomplete`;
    }
    return null;
  } catch (error) {
    return `session ${sessionId} cannot be resumed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function withSessionTransition<T>(
  state: TuiState,
  run: () => Promise<T>,
): Promise<T> {
  const previous = state.transitionPromise;
  if (previous !== null && previous !== undefined) {
    await previous.catch(() => undefined);
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  state.transitionPromise = promise;
  try {
    return await run();
  } finally {
    if (state.transitionPromise === promise) {
      state.transitionPromise = null;
    }
    resolve();
  }
}

async function pickSessionFromList(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
  entries: Awaited<ReturnType<typeof listProjectSessions>>,
): Promise<string | undefined> {
  if (typeof context.ui.custom === "function") {
    try {
      const [{ createSessionPicker }, { defaultViewportHeight }] =
        await Promise.all([
          import("../components/session-picker.ts"),
          import("../components/frame.ts"),
        ]);
      const items = entries.map((entry) => ({
        id: entry.id,
        title: entry.title ?? "",
        updatedAt: entry.updated_at,
        pinned: entry.pinned === true,
        current: entry.id === runtime.session.sessionId,
        label: sessionChoiceLabel(entry, runtime.session.sessionId),
      }));
      const picked = await context.ui.custom<string | null>(
        (_tui, theme, keybindings, done) =>
          createSessionPicker(
            {
              title: "Resume session",
              items,
              viewportHeight: defaultViewportHeight(),
            },
            theme,
            keybindings,
            done,
          ),
      );
      return picked ?? undefined;
    } catch {
      // Fall back to the standard select prompt when custom overlays are unavailable.
    }
  }
  const visible = entries.slice(0, 20);
  const labels = visible.map((entry) =>
    sessionChoiceLabel(entry, runtime.session.sessionId),
  );
  const title =
    entries.length > visible.length
      ? `Resume session (showing 20 of ${entries.length}; type /resume <text> to search)`
      : "Resume session";
  const selected = await context.ui.select(title, labels);
  if (selected === undefined) {
    return undefined;
  }
  return entries[labels.indexOf(selected)]?.id;
}

export async function resumeSession(
  state: TuiState,
  context: ExtensionContext,
  argument: string,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null || state.replaceRuntime === undefined) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  const entries = await listProjectSessions(
    runtime.paths.home,
    runtime.paths.projectId,
  );
  if (entries.length === 0) {
    context.ui.notify("No sessions in this project.", "warning");
    return;
  }
  let targetId: string | undefined;
  const query = argument.trim();
  if (query === "latest" || query === "--latest") {
    targetId = entries[0]!.id;
  } else if (query.length > 0) {
    const matched = matchSessionChoice(entries, query);
    if (matched !== null) {
      targetId = matched.id;
    } else {
      const result = await searchProjectSessions({
        rootDir: runtime.paths.home,
        projectId: runtime.paths.projectId,
        query,
        limit: 60,
      });
      if (result.warnings.length > 0) {
        context.ui.notify(result.warnings.join("\n"), "warning");
      }
      const choices = sessionSearchChoiceLabels(
        result.matches,
        entries,
        runtime.session.sessionId,
      );
      if (choices.ids.length === 0) {
        context.ui.notify(
          `No session id, title, or event excerpt matches ${query}.`,
          "warning",
        );
        return;
      }
      if (choices.ids.length === 1) {
        targetId = choices.ids[0];
      } else {
        const selected = await context.ui.select(
          "Resume matching session",
          choices.labels,
        );
        if (selected === undefined) {
          return;
        }
        targetId = choices.ids[choices.labels.indexOf(selected)];
      }
    }
  } else if (entries.length === 1) {
    targetId = entries[0]!.id;
  } else {
    targetId = await pickSessionFromList(runtime, context, entries);
  }
  if (targetId === undefined) {
    return;
  }
  if (targetId === runtime.session.sessionId) {
    context.ui.notify(`Already in session ${targetId}.`, "info");
    return;
  }
  if (runtime.host.session.isStreaming || runtime.host.session.isCompacting) {
    context.ui.notify(
      "Wait for the current run to settle before switching sessions.",
      "warning",
    );
    return;
  }
  await withSessionTransition(state, async () => {
    const issue = await sessionResumeIssue(runtime, targetId);
    if (issue !== null) {
      (state.context ?? context).ui.notify(issue, "error");
      return;
    }
    try {
      const replacement = await state.replaceRuntime!({ sessionId: targetId });
      (state.context ?? replacement.context).ui.notify(
        `resumed session ${targetId}`,
        "info",
      );
    } catch (error) {
      (state.context ?? context).ui.notify(
        `resume failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  });
}

export async function forkCurrentSession(
  state: TuiState,
  context: ExtensionContext,
  argument: string,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null || state.replaceRuntime === undefined) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  const session = runtime.host.session;
  if (session.isStreaming || session.isCompacting) {
    context.ui.notify(
      "Wait for the current run to settle before forking.",
      "warning",
    );
    return;
  }
  const entryId = argument.trim();
  if (entryId.length > 0) {
    const entry = runtime.host.sessionManager.getEntry(entryId);
    if (entry === undefined) {
      context.ui.notify(`No session entry ${entryId}.`, "warning");
      return;
    }
  }
  await withSessionTransition(state, async () => {
    await session.waitForIdle();
    let parentState = await runtime.host.saveAgentState();
    let stableSaves = 0;
    for (
      let attempt = 0;
      attempt < 50 && parentState !== null && stableSaves < 2;
      attempt += 1
    ) {
      if (
        runtime.session.metadata.state_covers_seq === runtime.session.lastSeq
      ) {
        stableSaves += 1;
        if (stableSaves >= 2) {
          break;
        }
      } else {
        stableSaves = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (stableSaves < 2) {
        await session.waitForIdle();
        parentState = await runtime.host.saveAgentState();
      }
    }
    if (parentState === null) {
      (state.context ?? context).ui.notify(
        "the current session has no agent state to fork",
        "error",
      );
      return;
    }
    if (stableSaves < 2) {
      (state.context ?? context).ui.notify(
        "the current session did not settle before forking",
        "error",
      );
      return;
    }
    const branch =
      entryId.length === 0
        ? parentState.branch
        : runtime.host.sessionManager.getBranch(entryId);
    try {
      const forked = await forkLiveSession({
        parent: runtime.session,
        parentState,
        rootDir: runtime.paths.home,
        cwd: runtime.paths.cwd,
        projectRoot: runtime.paths.deliveryRoot,
        projectId: runtime.paths.projectId,
        branch,
        ...(entryId.length === 0 ? {} : { forkEntryId: entryId }),
      });
      const replacement = await state.replaceRuntime!({
        sessionId: forked.sessionId,
      });
      (state.context ?? replacement.context).ui.notify(
        [
          `forked ${forked.parentSessionId} -> ${forked.sessionId}`,
          `entries: ${forked.forkEntries}; parent last seq: ${forked.parentLastSeq}`,
        ].join("\n"),
        "info",
      );
    } catch (error) {
      (state.context ?? context).ui.notify(
        `fork failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  });
}

export async function navigateSessionTree(
  state: TuiState,
  context: ExtensionContext,
  argument: string,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  const entryId = argument.trim();
  if (entryId.length === 0) {
    context.ui.notify(
      "usage: /tree (session branch selector) | /tree list | /tree <entry-id>",
      "warning",
    );
    return;
  }
  if (entryId === "list") {
    context.ui.notify(
      formatSessionTree(
        runtime.host.sessionManager.getTree() as TreeNodeView[],
        runtime.host.sessionManager.getLeafId(),
      ),
      "info",
    );
    return;
  }
  const session = runtime.host.session;
  if (session.isStreaming || session.isCompacting) {
    context.ui.notify(
      "Wait for the current run to settle before moving in the tree.",
      "warning",
    );
    return;
  }
  const target = runtime.host.sessionManager.getEntry(entryId);
  if (target === undefined) {
    context.ui.notify(`No session entry ${entryId}.`, "warning");
    return;
  }
  const from = runtime.host.sessionManager.getLeafId();
  if (from === target.id) {
    context.ui.notify(`${entryId} is already the current leaf.`, "info");
    return;
  }
  try {
    const result = await session.navigateTree(target.id, {
      summarize: false,
    });
    if (result.cancelled) {
      context.ui.notify("tree navigation was cancelled", "warning");
      return;
    }
    context.ui.notify(
      `moved to ${target.id}; the next prompt continues from this branch`,
      "info",
    );
  } catch (error) {
    context.ui.notify(
      `tree navigation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
}

export async function startNewSession(
  state: TuiState,
  context: ExtensionContext,
): Promise<void> {
  const runtime = state.runtime;
  if (runtime === null || state.replaceRuntime === undefined) {
    context.ui.notify("codepunk runtime is not ready", "error");
    return;
  }
  if (runtime.host.session.isStreaming || runtime.host.session.isCompacting) {
    context.ui.notify(
      "Wait for the current run to settle before starting a new session.",
      "warning",
    );
    return;
  }
  const selected = await context.ui.select("Start a new codepunk session?", [
    "Start new session",
    "Cancel",
  ]);
  if (selected !== "Start new session") {
    return;
  }
  await withSessionTransition(state, async () => {
    try {
      const replacement = await state.replaceRuntime!({ newSession: true });
      (state.context ?? replacement.context).ui.notify(
        `started session ${replacement.runtime.session.sessionId}`,
        "info",
      );
    } catch (error) {
      (state.context ?? context).ui.notify(
        `new session failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  });
}
