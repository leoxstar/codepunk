import type { BackgroundSubagent, TuiState } from "../state.ts";
import type { TableOptions } from "./table.ts";

function nextStep(record: BackgroundSubagent): string {
  switch (record.status) {
    case "running":
      return `/agents wait ${record.childSessionId}`;
    case "completed":
      return record.worktree === null
        ? `/agents result ${record.childSessionId}`
        : `/agents review ${record.childSessionId}`;
    case "failed":
      return `/agents transcript ${record.childSessionId}`;
    case "stopped":
      return `/agents discard ${record.childSessionId}`;
  }
}

export function agentsTableOptions(state: TuiState): TableOptions {
  const records = [...(state.subagents?.values() ?? [])];
  const visible = records.slice(0, 30);
  const hidden = records.length - visible.length;
  return {
    columns: [
      { label: "Agent", minWidth: 8, maxWidth: 24 },
      { label: "Session", minWidth: 8, maxWidth: 20 },
      { label: "Status", minWidth: 9, maxWidth: 22 },
      { label: "Next", minWidth: 12, maxWidth: 48 },
    ],
    rows: visible.map((record) => [
      `${record.profile ?? "built-in"}${
        record.isolation === "worktree" ? " · worktree" : ""
      }`,
      record.childSessionId,
      `${record.status}${
        record.delivery === null ? "" : ` · ${record.delivery.state}`
      }`,
      nextStep(record),
    ]),
    emptyText:
      "No subagents. Start one with /subagent [--profile <name>] <task>.",
    ...(hidden === 0 ? {} : { overflowText: `… ${hidden} more` }),
  };
}
