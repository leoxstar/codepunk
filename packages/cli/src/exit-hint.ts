import { writeSync } from "node:fs";

/**
 * The part of a session store the exit hint needs. Kept structural so the
 * module stays free of runtime imports and can be unit-tested from source.
 */
export interface ResumeHintSession {
  readonly sessionId: string;
  readonly allEvents: readonly { readonly kind: string }[];
}

/**
 * Event kinds that make a session worth resuming. A session that only holds
 * startup bookkeeping (trust, context, MCP start) has no conversation, so a
 * resume hint for it would point at an empty session.
 */
const CONVERSATION_EVENT_KINDS: ReadonlySet<string> = new Set([
  "user/input",
  "session/forked",
]);

const SAFE_ARGUMENT = /^[A-Za-z0-9._:@%+=,/-]+$/u;

export function sessionHasConversation(session: ResumeHintSession): boolean {
  return session.allEvents.some((event) =>
    CONVERSATION_EVENT_KINDS.has(event.kind),
  );
}

function quoteArgument(value: string): string {
  return SAFE_ARGUMENT.test(value) ? value : JSON.stringify(value);
}

export function resumeCommand(sessionId: string): string {
  return `codepunk resume ${quoteArgument(sessionId)}`;
}

export function formatResumeHint(sessionId: string, color: boolean): string {
  const label = "To resume this session:";
  const shown = color ? `\u001b[2m${label}\u001b[0m` : label;
  return `${shown} ${resumeCommand(sessionId)}\n`;
}

function stdoutSupportsColor(): boolean {
  return (
    process.stdout.isTTY === true &&
    process.env["NO_COLOR"] === undefined &&
    process.env["TERM"] !== "dumb"
  );
}

export interface ResumeHintOutput {
  isTTY: boolean;
  color: boolean;
  write: (text: string) => void;
}

function processOutput(): ResumeHintOutput {
  return {
    isTTY: process.stdout.isTTY === true,
    color: stdoutSupportsColor(),
    // Exit listeners cannot wait for an asynchronous stream flush, and a TTY
    // stream is asynchronous on Windows. A direct fd write lands before exit.
    write: (text) => {
      writeSync(1, text);
    },
  };
}

/**
 * Prints one resume command after the interactive host has quit.
 *
 * Pi prints its own hint only for a persisted Pi session file. Codepunk keeps
 * Pi's session manager in memory and owns the durable store, so Pi never sees
 * a resumable session; this replaces that hint with the product command.
 *
 * Pi's quit path calls `process.exit` after `session_shutdown`, so the hint is
 * armed from the shutdown handler and written from an `exit` listener, after
 * Pi has restored the terminal.
 */
export class ResumeHint {
  private sessionId: string | null = null;
  private printed = false;
  private readonly output: () => ResumeHintOutput;

  constructor(output: () => ResumeHintOutput = processOutput) {
    this.output = output;
  }

  arm(session: ResumeHintSession): void {
    this.sessionId = sessionHasConversation(session) ? session.sessionId : null;
  }

  disarm(): void {
    this.sessionId = null;
  }

  get armedSessionId(): string | null {
    return this.sessionId;
  }

  /** Writes the hint at most once; returns whether anything was written. */
  print(): boolean {
    if (this.printed || this.sessionId === null) {
      return false;
    }
    this.printed = true;
    const output = this.output();
    if (!output.isTTY) {
      return false;
    }
    try {
      output.write(formatResumeHint(this.sessionId, output.color));
      return true;
    } catch {
      // The terminal can already be gone (SIGHUP, closed pty). The hint is a
      // convenience and must never turn a clean exit into a crash.
      return false;
    }
  }

  /** Registers the exit listener; returns a function that removes it. */
  installOnExit(): () => void {
    const listener = () => {
      this.print();
    };
    process.once("exit", listener);
    return () => {
      process.off("exit", listener);
    };
  }
}
