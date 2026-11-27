import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { simpleShellArgv, type CodepunkRuntime } from "codepunk-core";
import { commandContext } from "../command-context.ts";
import { defineCommand, type TuiCommand } from "../define-command.ts";
import type { TuiState } from "../state.ts";
import { extractAssistantReplyText } from "./copy.ts";

export type ExternalEditorResolution =
  | { kind: "external"; argv: string[]; raw: string }
  | { kind: "builtin" }
  | { kind: "unsafe"; raw: string };

export function resolveExternalEditor(
  env: NodeJS.ProcessEnv = process.env,
): ExternalEditorResolution {
  const raw = env["VISUAL"]?.trim() || env["EDITOR"]?.trim() || "";
  if (raw.length === 0) {
    return { kind: "builtin" };
  }
  const parsed = simpleShellArgv(raw);
  if (parsed === null || parsed.length === 0) {
    return { kind: "unsafe", raw };
  }
  return { kind: "external", argv: parsed, raw };
}

export function buildEditorBuffer(
  draft: string,
  replyQuote: string | null,
): string {
  const header = [
    "# codepunk: Lines starting with '# codepunk:' are removed when you save and quit.",
  ];
  if (replyQuote !== null && replyQuote.trim().length > 0) {
    header.push("# codepunk: --- Previous assistant reply ---");
    for (const line of replyQuote.split("\n").slice(0, 80)) {
      header.push(`# codepunk: ${line}`);
    }
    header.push("# codepunk: --------------------------------");
  }
  return `${draft}${draft.endsWith("\n") || draft.length === 0 ? "" : "\n"}\n${header.join("\n")}\n`;
}

export function stripEditorComments(content: string): string {
  return content
    .split(/\r?\n/u)
    .filter((line) => !line.startsWith("# codepunk:"))
    .join("\n")
    .trim();
}

export async function openExternalPromptEditor(
  runtime: CodepunkRuntime | null,
  context: ExtensionContext,
  rawArgs = "",
): Promise<void> {
  const trimmed = rawArgs.trim();
  if (trimmed !== "" && trimmed !== "--reply") {
    context.ui.notify("usage: /editor [--reply]", "warning");
    return;
  }
  const includeReply = trimmed === "--reply";
  const currentDraft = context.ui.getEditorText?.() ?? "";
  const replyQuote =
    includeReply && runtime !== null
      ? extractAssistantReplyText(runtime.host.session.messages ?? [])
      : null;
  const resolution = resolveExternalEditor();
  if (resolution.kind === "unsafe") {
    context.ui.notify(
      `Refused unsafe $VISUAL/$EDITOR (${resolution.raw}); set a plain executable (for example 'nvim' or 'code --wait').`,
      "error",
    );
    return;
  }
  if (resolution.kind === "builtin") {
    if (typeof context.ui.editor !== "function") {
      context.ui.notify(
        "Set $VISUAL or $EDITOR (for example export EDITOR=nvim) to use /editor.",
        "warning",
      );
      return;
    }
    const prefill =
      replyQuote !== null && currentDraft.length === 0
        ? buildEditorBuffer(currentDraft, replyQuote)
        : currentDraft;
    const edited = await context.ui.editor("Compose prompt", prefill);
    if (edited !== undefined) {
      context.ui.setEditorText(stripEditorComments(edited));
      context.ui.notify("Updated prompt in editor.", "info");
    }
    return;
  }

  const tempPath = path.join(os.tmpdir(), `codepunk-prompt-${randomUUID()}.md`);
  const initialBuffer = buildEditorBuffer(currentDraft, replyQuote);
  await fs.writeFile(tempPath, initialBuffer, {
    encoding: "utf8",
    mode: 0o600,
  });
  const [binary, ...editorArgs] = resolution.argv;
  try {
    let exitStatus: number | null = null;
    let spawnErr: Error | undefined;
    const launch = () => {
      const res = spawnSync(binary!, [...editorArgs, tempPath], {
        stdio: "inherit",
      });
      exitStatus = res.status;
      spawnErr = res.error;
    };
    if (typeof context.ui.custom === "function") {
      await context.ui.custom<void>((tui, _theme, _keybindings, done) => {
        tui.stop();
        try {
          launch();
        } finally {
          tui.start();
          tui.requestRender(true);
          done();
        }
        return {
          render: () => [],
          invalidate: () => {},
        };
      });
    } else {
      launch();
    }
    if (spawnErr !== undefined || (exitStatus !== null && exitStatus !== 0)) {
      context.ui.notify(
        `External editor exited${spawnErr ? `: ${spawnErr.message}` : ` with code ${exitStatus}`}.`,
        "warning",
      );
      return;
    }
    const updatedRaw = await fs.readFile(tempPath, "utf8");
    const cleaned = stripEditorComments(updatedRaw);
    context.ui.setEditorText(cleaned);
    context.ui.notify(
      cleaned.length === 0
        ? "Cleared editor draft."
        : `Loaded ${cleaned.length} char(s) from ${binary} into prompt.`,
      "info",
    );
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

export function editorCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "editor",
    description: "Compose or edit the current prompt in $VISUAL/$EDITOR",
    handler: commandContext(state, async (runtime, context, args) => {
      await openExternalPromptEditor(runtime, context, args);
    }),
  });
}
