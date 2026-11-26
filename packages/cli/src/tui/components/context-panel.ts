import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { CodepunkRuntime } from "codepunk-core";
import { formatContextBar } from "../chrome/statusline.ts";
import {
  BORDERED_MIN_WIDTH,
  defaultViewportHeight,
  frameLines,
  isCloseInput,
  sliceViewport,
  viewportScrollbar,
  type PanelColor,
  type PanelKeybindings,
  type PanelTheme,
} from "./frame.ts";

export interface ContextCategory {
  readonly label: string;
  readonly tokens: number;
  readonly color: PanelColor;
  readonly detail: string;
}

export interface ContextBreakdown {
  readonly usedTokens: number;
  readonly contextWindow: number | null;
  readonly percent: number | null;
  readonly compactionMode: "auto" | "manual";
  readonly compactionThreshold: number;
  readonly categories: readonly ContextCategory[];
}

function estimateTokens(bytesOrChars: number): number {
  return bytesOrChars <= 0 ? 0 : Math.max(1, Math.round(bytesOrChars / 4));
}

function messageTextBytes(message: unknown): number {
  if (message === null || typeof message !== "object") {
    return 0;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return Buffer.byteLength(content, "utf8");
  }
  if (Array.isArray(content)) {
    let bytes = 0;
    for (const part of content) {
      if (part !== null && typeof part === "object") {
        const text = (part as { text?: unknown }).text;
        const thinking = (part as { thinking?: unknown }).thinking;
        if (typeof text === "string") {
          bytes += Buffer.byteLength(text, "utf8");
        }
        if (typeof thinking === "string") {
          bytes += Buffer.byteLength(thinking, "utf8");
        }
      }
    }
    return bytes;
  }
  return 0;
}

export function buildContextBreakdown(
  runtime: CodepunkRuntime,
): ContextBreakdown {
  const usage = runtime.host.session.getContextUsage?.();
  const contextWindow =
    usage !== undefined &&
    typeof usage.contextWindow === "number" &&
    usage.contextWindow > 0
      ? usage.contextWindow
      : null;

  let conversationBytes = 0;
  let toolOutputBytes = 0;
  let userTurns = 0;
  let toolMessages = 0;
  for (const message of runtime.host.session.messages) {
    const bytes = messageTextBytes(message);
    if (message.role === "toolResult") {
      toolOutputBytes += bytes;
      toolMessages += 1;
    } else {
      conversationBytes += bytes;
      if (message.role === "user") {
        userTurns += 1;
      }
    }
  }

  const skillBytes = runtime.skills.reduce(
    (sum, skill) => sum + skill.bytes,
    0,
  );
  const memoryRecords = [
    ...runtime.memory.storeFor("user").records,
    ...runtime.memory.storeFor("project").records,
  ].filter((record) => record.status !== "archived");
  const memoryBytes = memoryRecords.reduce(
    (sum, record) => sum + Buffer.byteLength(record.content, "utf8"),
    0,
  );
  const appendBytes = Buffer.byteLength(runtime.config.context.append, "utf8");

  const conversationTokens = estimateTokens(conversationBytes);
  const toolTokens = estimateTokens(toolOutputBytes);
  const skillTokens = estimateTokens(skillBytes);
  const memoryTokens = estimateTokens(memoryBytes);
  const systemBaseTokens = Math.max(250, estimateTokens(appendBytes) + 600);

  const estimatedTotal =
    systemBaseTokens +
    skillTokens +
    memoryTokens +
    conversationTokens +
    toolTokens;
  const reportedUsed =
    usage !== undefined && usage.tokens !== null && usage.tokens > 0
      ? usage.tokens
      : estimatedTotal;
  const percent =
    usage !== undefined &&
    usage.percent !== null &&
    Number.isFinite(usage.percent)
      ? Math.max(0, Math.min(100, Math.round(usage.percent)))
      : contextWindow !== null
        ? Math.max(
            0,
            Math.min(100, Math.round((reportedUsed / contextWindow) * 100)),
          )
        : null;

  return {
    usedTokens: reportedUsed,
    contextWindow,
    percent,
    compactionMode: runtime.config.context.compaction,
    compactionThreshold: runtime.config.context.compaction_threshold,
    categories: [
      {
        label: "System & rules",
        tokens: systemBaseTokens,
        color: "accent",
        detail:
          runtime.config.context.append_files.length > 0
            ? `${runtime.config.context.append_files.length} append file(s)`
            : "core instructions",
      },
      {
        label: "Skills",
        tokens: skillTokens,
        color: "success",
        detail: `${runtime.skills.length} loaded`,
      },
      {
        label: "Memory",
        tokens: memoryTokens,
        color: "accent",
        detail: `${memoryRecords.length} active note(s)`,
      },
      {
        label: "Conversation",
        tokens: conversationTokens,
        color: "text",
        detail: `${userTurns} user turn(s)`,
      },
      {
        label: "Tool outputs",
        tokens: toolTokens,
        color: "warning",
        detail: `${toolMessages} tool result(s)`,
      },
    ],
  };
}

export class ContextPanel implements Component {
  private readonly breakdown: ContextBreakdown;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly done: (action: "compact" | null) => void;
  private readonly viewportHeight: number;
  private cachedWidth = -1;
  private cachedLines: readonly string[] = [];

  constructor(
    breakdown: ContextBreakdown,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    done: (action: "compact" | null) => void,
    viewportHeight = defaultViewportHeight(),
  ) {
    this.breakdown = breakdown;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.viewportHeight = viewportHeight;
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    if (this.cachedWidth === safeWidth) {
      return this.cachedLines;
    }
    const inner = Math.max(
      1,
      safeWidth - (safeWidth < BORDERED_MIN_WIDTH ? 2 : 4),
    );
    const b = this.breakdown;
    const pct = b.percent ?? 0;
    const barColor: PanelColor =
      pct >= 85 ? "error" : pct >= 65 ? "warning" : "success";
    const windowText =
      b.contextWindow === null
        ? `${b.usedTokens.toLocaleString()} est. tokens (window unknown)`
        : `${b.usedTokens.toLocaleString()} / ${b.contextWindow.toLocaleString()} tokens (${pct}%)`;
    const body: string[] = [
      `${this.theme.bold(this.theme.fg("text", "Usage:"))} ${this.theme.fg(barColor, formatContextBar(pct, 16))} ${this.theme.fg("text", windowText)}`,
      this.theme.fg(
        "muted",
        `compaction: ${b.compactionMode} (threshold ${Math.round(b.compactionThreshold * 100)}%)`,
      ),
      "",
      this.theme.bold(this.theme.fg("accent", "Estimated breakdown")),
    ];
    const totalCat = Math.max(
      1,
      b.categories.reduce((sum, item) => sum + item.tokens, 0),
    );
    for (const item of b.categories) {
      const share = Math.round((item.tokens / totalCat) * 100);
      const bar = this.theme.fg(item.color, formatContextBar(share, 10));
      const label = item.label.padEnd(15);
      const tok = `${item.tokens.toLocaleString()} tok`.padStart(10);
      const line = `  ${this.theme.fg("text", label)} ${bar} ${this.theme.fg("text", tok)}  ${this.theme.fg("muted", `${String(share).padStart(2)}% · ${item.detail}`)}`;
      body.push(truncateToWidth(line, inner, "…"));
    }
    const viewport = sliceViewport(body, 0, this.viewportHeight);
    const scrollbar = viewportScrollbar(viewport);
    const rendered = frameLines(
      {
        title: "codepunk context",
        body: viewport.visible,
        footer: "c compact context · esc close",
        tone: pct >= 85 ? "error" : pct >= 65 ? "warning" : "accent",
        ...(scrollbar === undefined ? {} : { scrollbar }),
      },
      safeWidth,
      this.theme,
    );
    this.cachedWidth = safeWidth;
    this.cachedLines = rendered;
    return rendered;
  }

  handleInput(data: string): void {
    if (isCloseInput(data, this.keybindings)) {
      this.done(null);
      return;
    }
    if (data === "c") {
      this.done("compact");
    }
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = [];
  }
}

export function createContextPanel(
  runtime: CodepunkRuntime,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: (action: "compact" | null) => void,
): ContextPanel {
  return new ContextPanel(
    buildContextBreakdown(runtime),
    theme,
    keybindings,
    done,
  );
}
