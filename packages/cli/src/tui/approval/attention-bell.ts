export const DEFAULT_ATTENTION_BELL_DELAY_MS = 3_000;

export interface AttentionBellOptions {
  delayMs?: number;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  write?: (chunk: string) => void;
}

/**
 * Emit a single terminal bell (`\x07`) if an interactive approval or user
 * question remains unanswered past `delayMs`. Disabled automatically in CI,
 * under `node --test`, or when `CODEPUNK_NO_BELL=1` is set.
 */
export function startAttentionBellTimer(
  options: AttentionBellOptions = {},
): () => void {
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;
  const env = options.env ?? process.env;
  if (
    !isTTY ||
    Boolean(env["CI"]) ||
    env["CODEPUNK_NO_BELL"] === "1" ||
    (options.env === undefined && env["NODE_TEST_CONTEXT"] !== undefined)
  ) {
    return () => {};
  }
  const delayMs = Math.max(
    50,
    options.delayMs ?? DEFAULT_ATTENTION_BELL_DELAY_MS,
  );
  const write =
    options.write ??
    ((chunk: string) => {
      process.stdout.write(chunk);
    });
  let stopped = false;
  const timer = setTimeout(() => {
    if (!stopped) {
      write("\u0007");
    }
  }, delayMs);
  timer.unref?.();
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimeout(timer);
  };
}
