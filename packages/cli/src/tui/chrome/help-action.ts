import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TuiState } from "../state.ts";
import { codepunkHelp } from "./help.ts";

const ARG_COMMANDS = new Set([
  "/subagent",
  "/logs",
  "/stop",
  "/btw",
  "/image",
  "/image-gen",
  "/remember",
  "/goal",
  "/preset",
  "/plan",
  "/commit",
  "/fork",
  "/clone",
]);

export async function dispatchSlashOrPrefill(
  state: TuiState,
  context: ExtensionContext,
  command: string,
): Promise<void> {
  if (ARG_COMMANDS.has(command)) {
    context.ui.setEditorText(`${command} `);
    context.ui.notify(
      `Prepared ${command} in the editor — complete arguments and press Enter.`,
      "info",
    );
    return;
  }
  const runtime = state.runtime;
  if (runtime === null) {
    context.ui.setEditorText(command);
    return;
  }
  switch (command) {
    case "/settings": {
      const { showInteractiveSettingsMenu } =
        await import("../commands/settings.ts");
      await showInteractiveSettingsMenu(state, context, "");
      return;
    }
    case "/permissions": {
      const { configurePermissions } =
        await import("../commands/permission-actions.ts");
      await configurePermissions(state, context, "");
      return;
    }
    case "/trust": {
      const { configureTrust } = await import("../commands/trust-actions.ts");
      await configureTrust(state, context, "");
      return;
    }
    case "/resume": {
      const { resumeSession } = await import("../commands/session.ts");
      await resumeSession(state, context, "");
      return;
    }
    case "/new": {
      const { startNewSession } = await import("../commands/session.ts");
      await startNewSession(state, context);
      return;
    }
    case "/tasks": {
      const { showTaskCenter } = await import("../commands/tasks.ts");
      await showTaskCenter(state, runtime, context as never);
      return;
    }
    case "/rewind": {
      const { openRewindPicker } = await import("../commands/rewind.ts");
      await openRewindPicker(state, context as never);
      return;
    }
    case "/copy": {
      const { runCopyAction } = await import("../commands/copy.ts");
      await runCopyAction(runtime, context, "");
      return;
    }
    case "/model":
    case "/compact":
    case "/tree":
    case "/login":
    case "/logout":
    case "/quit": {
      context.ui.setEditorText(command);
      context.ui.notify(
        `Prepared ${command} in the editor — press Enter to run.`,
        "info",
      );
      return;
    }
    default: {
      try {
        await runtime.host.session.prompt(command);
      } catch {
        context.ui.setEditorText(command);
      }
    }
  }
}

export async function openInteractiveHelp(
  state: TuiState,
  context: ExtensionContext,
  initialQuery = "",
): Promise<void> {
  if (typeof context.ui.custom !== "function") {
    const text = codepunkHelp();
    if (initialQuery.length === 0) {
      context.ui.notify(text, "info");
      return;
    }
    const lower = initialQuery.toLowerCase();
    const matched = text
      .split("\n")
      .filter((line) => line.toLowerCase().includes(lower));
    context.ui.notify(
      matched.length === 0
        ? `No commands matching "${initialQuery}". Press F1 to browse all commands.`
        : [`Commands matching "${initialQuery}":`, ...matched].join("\n"),
      "info",
    );
    return;
  }
  const [{ createHelpBrowser }, { defaultViewportHeight }] = await Promise.all([
    import("../components/help-browser.ts"),
    import("../components/frame.ts"),
  ]);
  const selected = await context.ui.custom<string | null>(
    (_tui, theme, keybindings, done) =>
      createHelpBrowser(
        {
          title: "Codepunk help",
          text: codepunkHelp(),
          viewportHeight: defaultViewportHeight(),
          ...(initialQuery.length > 0 ? { initialQuery } : {}),
          onSelectCommand: (command) => done(command),
        },
        theme,
        keybindings,
        () => done(null),
      ),
  );
  if (selected !== null && selected !== undefined && selected !== "/help") {
    await dispatchSlashOrPrefill(state, context, selected);
  }
}
