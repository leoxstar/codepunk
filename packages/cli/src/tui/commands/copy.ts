import { spawnSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodepunkRuntime } from "codepunk-core";
import { commandContext } from "../command-context.ts";
import { defineCommand, type TuiCommand } from "../define-command.ts";
import type { TuiState } from "../state.ts";

const MAX_OSC52_BASE64_CHARS = 100_000;

export type CopySelector =
  { kind: "reply"; index: number } | { kind: "code"; index: number };

export function parseCopySelector(rawArgs: string): CopySelector | null {
  const tokens = rawArgs
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "last")) {
    return { kind: "reply", index: 1 };
  }
  if (tokens[0] === "code") {
    if (tokens.length === 1) {
      return { kind: "code", index: 1 };
    }
    if (tokens.length === 2) {
      const parsed = Number(tokens[1]);
      if (Number.isSafeInteger(parsed) && parsed >= 1) {
        return { kind: "code", index: parsed };
      }
    }
    return null;
  }
  if (tokens.length === 1) {
    const parsed = Number(tokens[0]);
    if (Number.isSafeInteger(parsed) && parsed >= 1) {
      return { kind: "reply", index: parsed };
    }
  }
  return null;
}

function messageTextParts(message: unknown): string {
  if (message === null || typeof message !== "object") {
    return "";
  }
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "assistant") {
    return "";
  }
  if (typeof record.content === "string") {
    return record.content.trim();
  }
  if (!Array.isArray(record.content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of record.content) {
    if (
      part !== null &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join("\n").trim();
}

function extractFencedCodeBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const pattern = /```[^\n]*\n([\s\S]*?)```/gu;
  for (const match of markdown.matchAll(pattern)) {
    const body = (match[1] ?? "").replace(/\n$/u, "");
    if (body.trim().length > 0) {
      blocks.push(body);
    }
  }
  return blocks;
}

export function extractAssistantReplyText(
  messages: readonly unknown[],
  selector: CopySelector = { kind: "reply", index: 1 },
): string | null {
  const replies: string[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = messageTextParts(messages[i]);
    if (text.length > 0) {
      replies.push(text);
    }
  }
  if (selector.kind === "reply") {
    return replies[selector.index - 1] ?? null;
  }
  const codeBlocks: string[] = [];
  for (const reply of replies) {
    const blocks = extractFencedCodeBlocks(reply);
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      codeBlocks.push(blocks[i]!);
    }
  }
  return codeBlocks[selector.index - 1] ?? null;
}

function nativeClipboardCommands(
  platform: NodeJS.Platform,
): ReadonlyArray<{ cmd: string; args: readonly string[] }> {
  if (platform === "darwin") {
    return [{ cmd: "pbcopy", args: [] }];
  }
  if (platform === "win32") {
    return [{ cmd: "clip", args: [] }];
  }
  return [
    { cmd: "wl-copy", args: [] },
    { cmd: "xclip", args: ["-selection", "clipboard"] },
    { cmd: "xsel", args: ["--clipboard", "--input"] },
  ];
}

export interface ClipboardCopyOptions {
  platform?: NodeJS.Platform;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  execClipboard?: (
    cmd: string,
    args: readonly string[],
    text: string,
  ) => boolean;
  writeOsc52?: (sequence: string) => void;
}

export function copyTextToClipboard(
  text: string,
  options: ClipboardCopyOptions = {},
): { ok: boolean; method: "native" | "osc52" | "none" } {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;
  const runNative =
    options.execClipboard ??
    ((cmd: string, args: readonly string[], input: string) => {
      const res = spawnSync(cmd, [...args], {
        input,
        encoding: "utf8",
        timeout: 3_000,
        stdio: ["pipe", "ignore", "ignore"],
      });
      return res.error === undefined && res.status === 0;
    });
  const isRemoteSsh = Boolean(env["SSH_TTY"] || env["SSH_CONNECTION"]);
  if (!isRemoteSsh) {
    for (const candidate of nativeClipboardCommands(platform)) {
      if (runNative(candidate.cmd, candidate.args, text)) {
        return { ok: true, method: "native" };
      }
    }
  }
  if (isTTY) {
    const encoded = Buffer.from(text, "utf8").toString("base64");
    if (encoded.length <= MAX_OSC52_BASE64_CHARS) {
      const write =
        options.writeOsc52 ??
        ((seq: string) => {
          process.stdout.write(seq);
        });
      write(`\u001b]52;c;${encoded}\u0007`);
      return { ok: true, method: "osc52" };
    }
  }
  return { ok: false, method: "none" };
}

export async function runCopyAction(
  runtime: CodepunkRuntime,
  context: Pick<ExtensionContext, "ui">,
  rawArgs: string,
): Promise<void> {
  const selector = parseCopySelector(rawArgs);
  if (selector === null) {
    context.ui.notify("usage: /copy [last|<n>|code [n]]", "warning");
    return;
  }
  const messages = runtime.host.session.messages ?? [];
  const extracted = extractAssistantReplyText(messages, selector);
  if (extracted === null) {
    context.ui.notify(
      selector.kind === "code"
        ? "No matching fenced code block found in assistant replies."
        : "No matching assistant reply found in this session.",
      "warning",
    );
    return;
  }
  const copied = copyTextToClipboard(extracted);
  if (!copied.ok) {
    context.ui.notify(
      "Clipboard unavailable (install pbcopy/wl-copy/xclip or use an OSC 52 terminal).",
      "error",
    );
    return;
  }
  const lines = extracted.split("\n").length;
  const targetLabel =
    selector.kind === "code"
      ? `code block #${selector.index}`
      : selector.index === 1
        ? "last reply"
        : `reply #${selector.index}`;
  context.ui.notify(
    `Copied ${targetLabel} (${extracted.length} chars, ${lines} line${lines === 1 ? "" : "s"}).`,
    "info",
  );
}

export function copyCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "copy",
    description: "Copy the latest assistant reply or code block to clipboard",
    handler: commandContext(state, async (runtime, context, args) => {
      await runCopyAction(runtime, context, args);
    }),
  });
}
