import { type createSessionRecap } from "codepunk-core";
export function recapRange(
  argument: string,
  lastSeq: number,
): { from: number; to: number } {
  if (argument.length === 0 || argument === "all") {
    return { from: 1, to: lastSeq };
  }
  const range = /^(\d+)\.\.(\d+)$/u.exec(argument);
  if (range !== null) {
    return { from: Number(range[1]), to: Number(range[2]) };
  }
  if (/^\d+$/u.test(argument)) {
    return { from: Number(argument), to: Number(argument) };
  }
  throw new Error("usage: /recap [all|<from>..<to>|<seq>]");
}

export function formatRecap(
  recap: ReturnType<typeof createSessionRecap>,
): string {
  return [
    `Session recap ${recap.from_seq}..${recap.to_seq}`,
    `events: ${recap.event_count}`,
    ...Object.entries(recap.kinds)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, count]) => `  ${kind}: ${count}`),
    `body_sha256: ${recap.body_sha256}`,
    "This is a derived view, not evidence.",
  ].join("\n");
}
