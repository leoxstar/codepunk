import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  replaceControlCharacters,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";

export type SubagentTranscriptStatus =
  "running" | "completed" | "failed" | "stopped";

export interface SubagentTranscriptSource {
  childSessionId: string;
  profile: string | null;
  transcriptPath: string;
  status: () => SubagentTranscriptStatus;
  error: () => string | null;
}

export type SubagentTranscriptBlockKind =
  "user" | "assistant" | "tool" | "error" | "raw";

export interface SubagentTranscriptBlock {
  kind: SubagentTranscriptBlockKind;
  title: string;
  text: string;
  thinking: string;
  running: boolean;
  toolName?: string;
  toolArguments?: unknown;
  output?: string;
  details?: unknown;
  isError?: boolean;
  durationMs?: number;
}

interface LooseRecord {
  [key: string]: unknown;
  args?: unknown;
  assistantMessageEvent?: unknown;
  code?: unknown;
  content?: unknown;
  delta?: unknown;
  details?: unknown;
  durationMs?: unknown;
  error?: unknown;
  errorMessage?: unknown;
  isError?: unknown;
  message?: unknown;
  mimeType?: unknown;
  partialResult?: unknown;
  reason?: unknown;
  result?: unknown;
  role?: unknown;
  text?: unknown;
  thinking?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  type?: unknown;
}

function recordValue(value: unknown): LooseRecord | null {
  return value !== null && typeof value === "object"
    ? (value as LooseRecord)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .flatMap((part) => {
      const content = recordValue(part);
      if (content === null) {
        return [];
      }
      if (content.type === "text" && typeof content.text === "string") {
        return [content.text];
      }
      if (content.type === "image") {
        return [
          `[image ${typeof content.mimeType === "string" ? content.mimeType : "unknown"}]`,
        ];
      }
      return [];
    })
    .join("\n");
}

function contentThinking(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .flatMap((part) => {
      const content = recordValue(part);
      return content?.type === "thinking" &&
        typeof content.thinking === "string"
        ? [content.thinking]
        : [];
    })
    .join("\n");
}

function prettyJson(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function resultOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const result = recordValue(value);
  if (result === null) {
    return value === undefined ? "" : prettyJson(value);
  }
  if ("content" in result) {
    return contentText(result.content);
  }
  return prettyJson(result);
}

function resultDetails(value: unknown): unknown {
  const result = recordValue(value);
  return result !== null && "details" in result ? result.details : undefined;
}

function assistantBlock(
  text = "",
  thinking = "",
  running = true,
): SubagentTranscriptBlock {
  return {
    kind: "assistant",
    title: "ASSISTANT",
    text,
    thinking,
    running,
  };
}

/**
 * Incrementally builds the visible child transcript from the Pi JSONL stream.
 * The parser keeps one incomplete line between calls, so a transcript can be
 * read while the child is still writing it.
 */
export class SubagentTranscriptDocument {
  private readonly blocksValue: SubagentTranscriptBlock[] = [];
  private readonly tools = new Map<string, SubagentTranscriptBlock>();
  private pending = "";
  private liveAssistant: SubagentTranscriptBlock | null = null;
  private revisionValue = 0;
  private parsedEventsValue = 0;
  private unparsedLinesValue = 0;

  get blocks(): readonly SubagentTranscriptBlock[] {
    return this.blocksValue;
  }

  get revision(): number {
    return this.revisionValue;
  }

  get parsedEvents(): number {
    return this.parsedEventsValue;
  }

  get unparsedLines(): number {
    return this.unparsedLinesValue;
  }

  clear(): void {
    this.blocksValue.length = 0;
    this.tools.clear();
    this.pending = "";
    this.liveAssistant = null;
    this.parsedEventsValue = 0;
    this.unparsedLinesValue = 0;
    this.revisionValue += 1;
  }

  append(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    this.pending += chunk;
    let newline = this.pending.indexOf("\n");
    while (newline !== -1) {
      const line = this.pending.slice(0, newline).replace(/\r$/u, "");
      this.pending = this.pending.slice(newline + 1);
      if (line.trim().length > 0) {
        this.consumeLine(line);
      }
      newline = this.pending.indexOf("\n");
    }
  }

  private consumeLine(line: string): void {
    let event: LooseRecord;
    try {
      const parsed = JSON.parse(line.replace(/^\uFEFF/u, "")) as unknown;
      const record = recordValue(parsed);
      if (record === null) {
        throw new Error("event is not an object");
      }
      event = record;
    } catch {
      this.unparsedLinesValue += 1;
      this.blocksValue.push({
        kind: "raw",
        title: "UNPARSED LINE",
        text: line,
        thinking: "",
        running: false,
      });
      this.revisionValue += 1;
      return;
    }
    this.parsedEventsValue += 1;
    this.applyEvent(event);
    this.revisionValue += 1;
  }

  private applyEvent(event: LooseRecord): void {
    const type = stringValue(event.type);
    if (type === "message_start") {
      const message = recordValue(event.message);
      if (message?.role === "assistant") {
        this.liveAssistant = assistantBlock();
        this.blocksValue.push(this.liveAssistant);
      }
      return;
    }
    if (type === "message_update") {
      const update = recordValue(event.assistantMessageEvent);
      if (update === null) {
        return;
      }
      const block =
        this.liveAssistant ??
        (() => {
          const created = assistantBlock();
          this.liveAssistant = created;
          this.blocksValue.push(created);
          return created;
        })();
      if (update.type === "text_delta" && typeof update.delta === "string") {
        block.text += update.delta;
      } else if (
        update.type === "text_end" &&
        typeof update.content === "string"
      ) {
        block.text = update.content;
      } else if (
        update.type === "thinking_delta" &&
        typeof update.delta === "string"
      ) {
        block.thinking += update.delta;
      } else if (
        update.type === "thinking_end" &&
        typeof update.content === "string"
      ) {
        block.thinking = update.content;
      } else if (update.type === "error") {
        block.running = false;
        block.kind = "error";
        block.title = "ASSISTANT ERROR";
        block.text =
          stringValue(update.error) ??
          stringValue(update.reason) ??
          "assistant stream failed";
      }
      return;
    }
    if (type === "message_end") {
      this.applyMessageEnd(recordValue(event.message));
      return;
    }
    if (type === "tool_execution_start") {
      const block = this.toolBlock(event);
      block.toolArguments = event.args;
      block.running = true;
      block.isError = false;
      return;
    }
    if (type === "tool_execution_update") {
      const block = this.toolBlock(event);
      block.toolArguments = event.args;
      block.output = resultOutput(event.partialResult);
      block.details = resultDetails(event.partialResult);
      block.running = true;
      block.isError = false;
      return;
    }
    if (type === "tool_execution_end") {
      const block = this.toolBlock(event);
      block.output = resultOutput(event.result);
      block.details = resultDetails(event.result);
      block.running = false;
      block.isError = event.isError === true;
      if (
        typeof event.durationMs === "number" &&
        Number.isFinite(event.durationMs)
      ) {
        block.durationMs = event.durationMs;
      }
      return;
    }
    if (type === "error" || type === "extension_error") {
      this.blocksValue.push({
        kind: "error",
        title: type === "extension_error" ? "EXTENSION ERROR" : "ERROR",
        text:
          stringValue(event.error) ??
          stringValue(event.errorMessage) ??
          prettyJson(event),
        thinking: "",
        running: false,
      });
    }
  }

  private applyMessageEnd(message: LooseRecord | null): void {
    if (message === null) {
      return;
    }
    const role = stringValue(message.role);
    if (role === "assistant") {
      const text = contentText(message.content);
      const thinking = contentThinking(message.content);
      if (this.liveAssistant === null) {
        this.blocksValue.push(assistantBlock(text, thinking, false));
      } else if (text.length === 0 && thinking.length === 0) {
        const index = this.blocksValue.indexOf(this.liveAssistant);
        if (index !== -1) {
          this.blocksValue.splice(index, 1);
        }
      } else {
        this.liveAssistant.text = text;
        this.liveAssistant.thinking = thinking;
        this.liveAssistant.running = false;
      }
      this.liveAssistant = null;
      return;
    }
    if (role === "user") {
      const text = contentText(message.content);
      if (text.length > 0) {
        this.blocksValue.push({
          kind: "user",
          title: "USER",
          text,
          thinking: "",
          running: false,
        });
      }
      return;
    }
    if (role === "toolResult") {
      const block = this.toolBlock({
        toolCallId: message.toolCallId,
        toolName: message.toolName,
      });
      block.output = contentText(message.content);
      block.details = message.details;
      block.running = false;
      block.isError = message.isError === true;
      return;
    }
    const text = contentText(message.content);
    if (text.length > 0) {
      this.blocksValue.push({
        kind: "raw",
        title: (role ?? "message").toUpperCase(),
        text,
        thinking: contentThinking(message.content),
        running: false,
      });
    }
  }

  private toolBlock(event: LooseRecord): SubagentTranscriptBlock {
    const toolCallId = stringValue(event.toolCallId) ?? "unknown-tool-call";
    const existing = this.tools.get(toolCallId);
    if (existing !== undefined) {
      return existing;
    }
    const block: SubagentTranscriptBlock = {
      kind: "tool",
      title: "TOOL",
      text: "",
      thinking: "",
      running: true,
      toolName: stringValue(event.toolName) ?? "tool",
      output: "",
    };
    this.tools.set(toolCallId, block);
    this.blocksValue.push(block);
    return block;
  }
}

function cleanTerminalText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => replaceControlCharacters(stripTerminalSequences(line)))
    .join("\n");
}

function blockOutput(block: SubagentTranscriptBlock): string {
  const sections: string[] = [];
  if (block.toolArguments !== undefined) {
    sections.push(`arguments:\n${prettyJson(block.toolArguments)}`);
  }
  if (block.output !== undefined) {
    sections.push(
      `output:\n${
        block.output.length > 0
          ? block.output
          : block.running
            ? "(waiting for output...)"
            : "(no text output)"
      }`,
    );
  }
  if (block.details !== undefined) {
    sections.push(`details:\n${prettyJson(block.details)}`);
  }
  return sections.join("\n\n");
}

function blockText(block: SubagentTranscriptBlock): string {
  if (block.kind === "tool") {
    return blockOutput(block);
  }
  if (block.thinking.length === 0) {
    return block.text;
  }
  return `thinking:\n${block.thinking}\n\n${block.text}`;
}

function blockLabel(block: SubagentTranscriptBlock): string {
  if (block.kind === "tool") {
    const status = block.running
      ? "running"
      : block.isError === true
        ? "error"
        : "ok";
    const duration =
      block.durationMs === undefined
        ? ""
        : ` ${Math.max(0, Math.round(block.durationMs))}ms`;
    return `TOOL ${block.toolName ?? "tool"} [${status}${duration}]`;
  }
  return block.title;
}

function blockColor(
  block: SubagentTranscriptBlock,
): "userMessageText" | "success" | "error" | "toolTitle" | "warning" {
  if (block.kind === "user") {
    return "userMessageText";
  }
  if (block.kind === "tool") {
    return block.isError === true ? "error" : "toolTitle";
  }
  if (block.kind === "error") {
    return "error";
  }
  if (block.kind === "raw") {
    return "warning";
  }
  return "success";
}

function padLine(value: string, width: number): string {
  const clipped = truncateToWidth(value, width);
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

class SubagentTranscriptBrowser implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: () => void;
  private readonly source: SubagentTranscriptSource;
  private readonly document = new SubagentTranscriptDocument();
  private readonly timer: NodeJS.Timeout;
  private decoder = new StringDecoder("utf8");
  private offset = 0;
  private fileBytes = 0;
  private fileError: string | null = null;
  private pollBusy = false;
  private closed = false;
  private follow = true;
  private scrollTop = 0;
  private cachedWidth = -1;
  private cachedRevision = -1;
  private cachedLines: string[] = [];
  private lastStatus = "";
  private lastError: string | null = null;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: () => void,
    source: SubagentTranscriptSource,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.source = source;
    this.timer = setInterval(() => {
      void this.refreshFile();
    }, 200);
    this.timer.unref();
    void this.refreshFile();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.finish();
      return;
    }
    const maxScroll = Math.max(
      0,
      this.cachedLines.length - this.viewportRows(),
    );
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.scrollTo(this.scrollTop - 1, false);
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.scrollTo(this.scrollTop + 1, false);
    } else if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.scrollTo(this.scrollTop - this.viewportRows(), false);
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.scrollTo(this.scrollTop + this.viewportRows(), false);
    } else if (
      matchesKey(data, "home") ||
      this.keybindings.matches(data, "tui.altScreen.top")
    ) {
      this.scrollTo(0, false);
    } else if (
      matchesKey(data, "end") ||
      this.keybindings.matches(data, "tui.altScreen.bottom")
    ) {
      this.scrollTo(maxScroll, true);
    } else if (data === "f") {
      this.follow = !this.follow;
      if (this.follow) {
        this.scrollTop = maxScroll;
      }
      this.invalidate();
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const rows = Math.max(6, this.tui.terminal.rows);
    const bodyRows = Math.max(1, rows - 3);
    const contentWidth = Math.max(1, width - 1);
    if (
      this.cachedWidth !== contentWidth ||
      this.cachedRevision !== this.document.revision
    ) {
      this.cachedWidth = contentWidth;
      this.cachedRevision = this.document.revision;
      this.cachedLines = this.renderDocument(contentWidth);
    }
    const maxScroll = Math.max(0, this.cachedLines.length - bodyRows);
    if (this.follow) {
      this.scrollTop = maxScroll;
    } else {
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll));
    }

    const status = this.source.status();
    const statusText = status === "running" ? "live" : status;
    const headerText = [
      "CODEPUNK SUBAGENT TRANSCRIPT",
      this.source.childSessionId,
      this.source.profile ?? "built-in",
      statusText,
      this.follow ? "follow" : "paused",
    ].join("  ·  ");
    const header = this.theme.style(padLine(` ${headerText}`, width), {
      fg: "text",
      bg: "selectedBg",
    });
    const separator = this.theme.fg("borderMuted", "─".repeat(width));
    const viewport = this.cachedLines.slice(
      this.scrollTop,
      this.scrollTop + bodyRows,
    );
    while (viewport.length < bodyRows) {
      viewport.push("");
    }
    const body = viewport.map((line, index) =>
      this.withScrollbar(line, index, bodyRows, contentWidth, width),
    );
    const eventCount = `${this.document.parsedEvents} event${
      this.document.parsedEvents === 1 ? "" : "s"
    }`;
    const error = this.source.error();
    const footerStatus =
      this.fileError === null
        ? error === null
          ? this.lastError === null
            ? `${eventCount} · ${this.fileBytes} bytes`
            : `${eventCount} · ${this.lastError}`
          : error
        : this.fileError;
    const scrollPosition =
      maxScroll === 0
        ? "all visible"
        : `${Math.round((this.scrollTop / maxScroll) * 100)}%`;
    const footerText =
      `${footerStatus} · ${scrollPosition} · ` +
      "↑↓ line · PgUp/PgDn page · Home/End ends · f follow · Esc close";
    const footer = this.theme.fg(
      this.fileError === null && error === null ? "dim" : "error",
      padLine(` ${footerText}`, width),
    );
    return [
      truncateToWidth(header, width, "", true),
      truncateToWidth(separator, width, "", true),
      ...body,
      truncateToWidth(footer, width, "", true),
    ];
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedRevision = -1;
    this.cachedLines = [];
  }

  dispose(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  private viewportRows(): number {
    return Math.max(1, Math.max(6, this.tui.terminal.rows) - 3);
  }

  private scrollTo(next: number, follow: boolean): void {
    const maxScroll = Math.max(
      0,
      this.cachedLines.length - this.viewportRows(),
    );
    this.scrollTop = Math.max(0, Math.min(maxScroll, next));
    this.follow = follow || this.scrollTop === maxScroll;
    this.tui.requestRender();
  }

  private finish(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.timer);
    this.done();
  }

  private async refreshFile(): Promise<void> {
    if (this.closed || this.pollBusy) {
      return;
    }
    this.pollBusy = true;
    try {
      const status = this.source.status();
      const error = this.source.error();
      const statusChanged =
        status !== this.lastStatus || error !== this.lastError;
      this.lastStatus = status;
      this.lastError = error;
      const previousFileError = this.fileError;
      let handle: FileHandle;
      try {
        handle = await fs.open(this.source.transcriptPath, "r");
      } catch (openError) {
        const code = recordValue(openError)?.code;
        this.fileError =
          code === "ENOENT" && status === "running"
            ? null
            : `transcript unavailable: ${
                openError instanceof Error
                  ? openError.message
                  : String(openError)
              }`;
        if (statusChanged || this.fileError !== previousFileError) {
          this.tui.requestRender();
        }
        return;
      }
      try {
        const stat = await handle.stat();
        this.fileBytes = stat.size;
        if (stat.size < this.offset) {
          this.document.clear();
          this.decoder = new StringDecoder("utf8");
          this.offset = 0;
          this.follow = true;
        }
        if (stat.size > this.offset) {
          const length = Math.min(stat.size - this.offset, 1024 * 1024);
          const buffer = Buffer.allocUnsafe(length);
          const result = await handle.read(buffer, 0, length, this.offset);
          if (result.bytesRead > 0) {
            this.offset += result.bytesRead;
            this.document.append(
              this.decoder.write(buffer.subarray(0, result.bytesRead)),
            );
          }
        }
        this.fileError = null;
      } catch (readError) {
        this.fileError = `transcript read failed: ${
          readError instanceof Error ? readError.message : String(readError)
        }`;
      } finally {
        await handle.close().catch(() => undefined);
      }
      if (statusChanged) {
        this.invalidate();
      }
      if (
        statusChanged ||
        this.fileError !== previousFileError ||
        this.document.revision !== this.cachedRevision
      ) {
        this.tui.requestRender();
      }
    } finally {
      this.pollBusy = false;
    }
  }

  private renderDocument(width: number): string[] {
    if (this.document.blocks.length === 0) {
      return [
        this.theme.fg(
          "dim",
          "  Waiting for the child transcript. Output appears here as the subagent writes it.",
        ),
      ];
    }
    const lines: string[] = [];
    for (const block of this.document.blocks) {
      if (lines.length > 0) {
        lines.push("");
      }
      const label = this.theme.bold(
        this.theme.fg(blockColor(block), `  ${blockLabel(block)}`),
      );
      lines.push(truncateToWidth(label, width));
      const body = cleanTerminalText(blockText(block));
      if (body.length === 0) {
        continue;
      }
      const bodyColor =
        block.kind === "assistant" && block.running
          ? "text"
          : block.kind === "tool"
            ? "toolOutput"
            : block.kind === "error"
              ? "error"
              : block.kind === "raw"
                ? "warning"
                : "text";
      for (const logicalLine of body.split("\n")) {
        if (logicalLine.length === 0) {
          lines.push("");
          continue;
        }
        for (const wrapped of wrapTextWithAnsi(
          logicalLine,
          Math.max(1, width - 2),
        )) {
          lines.push(this.theme.fg(bodyColor, `  ${wrapped}`));
        }
      }
    }
    return lines;
  }

  private withScrollbar(
    line: string,
    index: number,
    bodyRows: number,
    contentWidth: number,
    width: number,
  ): string {
    const padded = truncateToWidth(line, contentWidth, "", true);
    if (this.cachedLines.length <= bodyRows || width <= 1) {
      return `${padded} `;
    }
    const thumbSize = Math.max(
      1,
      Math.min(
        bodyRows,
        Math.round((bodyRows * bodyRows) / this.cachedLines.length),
      ),
    );
    const maxStart = bodyRows - thumbSize;
    const thumbStart =
      maxStart === 0
        ? 0
        : Math.round(
            (this.scrollTop / Math.max(1, this.cachedLines.length - bodyRows)) *
              maxStart,
          );
    const thumb = index >= thumbStart && index < thumbStart + thumbSize;
    return `${padded}${this.theme.fg(
      thumb ? "scrollbarThumb" : "scrollbarTrack",
      thumb ? "█" : "│",
    )}`;
  }
}

export async function openSubagentTranscript(
  context: ExtensionCommandContext,
  source: SubagentTranscriptSource,
): Promise<void> {
  await context.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      new SubagentTranscriptBrowser(tui, theme, keybindings, done, source),
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
        margin: 0,
      },
      blocked: {
        kind: "question",
        message: `Viewing subagent ${source.childSessionId} transcript`,
      },
    },
  );
}
