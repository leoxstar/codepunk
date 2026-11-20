import type { StatuslineSegment } from "codepunk-core";

export interface StatuslineValues {
  model: string;
  session: string;
  policy: string;
  sandbox: string;
  filesystem: string;
  budget: string;
}

const LINE_GROUP: Record<StatuslineSegment, number> = {
  model: 0,
  session: 1,
  sandbox: 1,
  filesystem: 1,
  policy: 2,
  budget: 2,
};

/**
 * Render configured segments in order while keeping the established visual
 * grouping: model, session context, then policy and budget.
 */
export function renderStatusline(
  segments: readonly StatuslineSegment[],
  values: StatuslineValues,
): string {
  const lines: string[][] = [];
  let group: number | null = null;
  for (const segment of segments) {
    const next = LINE_GROUP[segment];
    if (next !== group) {
      lines.push([]);
      group = next;
    }
    lines.at(-1)!.push(values[segment]);
  }
  return lines.map((parts) => parts.join(" · ")).join("\n");
}
