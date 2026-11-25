import type { StatuslineSegment } from "codepunk-core";

export interface StatuslineValues {
  model: string;
  session: string;
  policy: string;
  sandbox: string;
  filesystem: string;
  budget: string;
}

/**
 * Render configured segments as one compact line. The footer owns truncation
 * so a narrow terminal clips the line instead of wrapping it into the chat.
 */
export function renderStatusline(
  segments: readonly StatuslineSegment[],
  values: StatuslineValues,
): string {
  return segments
    .map((segment) => values[segment])
    .filter((value) => value.length > 0)
    .join(" · ");
}
