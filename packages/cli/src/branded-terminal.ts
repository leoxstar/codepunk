import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";

export const CODEPUNK_APP_NAME = "codepunk";

/**
 * Pi owns the interactive runtime and writes its own title and program-status
 * identity. Rewrite only those two fields at the terminal boundary; everything
 * else delegates unchanged.
 */
export function brandTerminalTitle(title: string): string {
  if (title === "\u03c0" || title === "pi") {
    return CODEPUNK_APP_NAME;
  }
  if (title.startsWith("\u03c0 - ")) {
    return `${CODEPUNK_APP_NAME} - ${title.slice(4)}`;
  }
  if (title.startsWith("pi - ")) {
    return `${CODEPUNK_APP_NAME} - ${title.slice(5)}`;
  }
  return title;
}

export function brandProgramStatus(status: ProgramStatus): ProgramStatus {
  return { ...status, app: CODEPUNK_APP_NAME };
}

export class CodepunkTerminal implements Terminal {
  private readonly inner: Terminal;

  constructor(inner: Terminal) {
    this.inner = inner;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inner.start(onInput, onResize);
  }

  stop(): void {
    this.inner.stop();
  }

  restoreOnExit(before: string, after: string): void {
    this.inner.restoreOnExit?.(before, after);
  }

  drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    return this.inner.drainInput(maxMs, idleMs);
  }

  write(data: string): void {
    this.inner.write(data);
  }

  get columns(): number {
    return this.inner.columns;
  }

  get rows(): number {
    return this.inner.rows;
  }

  get kittyProtocolActive(): boolean {
    return this.inner.kittyProtocolActive;
  }

  moveBy(lines: number): void {
    this.inner.moveBy(lines);
  }

  hideCursor(): void {
    this.inner.hideCursor();
  }

  showCursor(): void {
    this.inner.showCursor();
  }

  clearLine(): void {
    this.inner.clearLine();
  }

  clearFromCursor(): void {
    this.inner.clearFromCursor();
  }

  clearScreen(): void {
    this.inner.clearScreen();
  }

  setTitle(title: string): void {
    this.inner.setTitle(brandTerminalTitle(title));
  }

  setProgress(active: boolean): void {
    this.inner.setProgress(active);
  }

  setProgramStatus(status: ProgramStatus): void {
    this.inner.setProgramStatus(brandProgramStatus(status));
  }
}
