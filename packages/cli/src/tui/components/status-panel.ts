import type { CodepunkRuntime } from "codepunk-core";
import { formatStatusSummary } from "../format/status-summary.ts";
import {
  Panel,
  type PanelKeybindings,
  type PanelSection,
  type PanelTheme,
} from "./panel.ts";

const STATUS_GROUPS: readonly {
  readonly label: string;
  readonly keys: readonly string[];
}[] = [
  { label: "Project", keys: ["project", "cwd"] },
  { label: "Session", keys: ["session", "model", "thinking", "context"] },
  { label: "Permissions", keys: ["permissions", "sandbox", "trust"] },
  { label: "Capabilities", keys: ["capabilities"] },
  { label: "Evidence", keys: ["evidence"] },
  { label: "Usage", keys: ["usage", "budget"] },
  { label: "Paths", keys: ["config", "sessions"] },
];

/**
 * Project the text status summary into panel sections. Grouping only changes
 * the rendering; every field emitted by formatStatusSummary is retained.
 */
export function statusPanelSections(runtime: CodepunkRuntime): PanelSection[] {
  const fields = new Map<string, string>();
  const unparsed: string[] = [];
  for (const line of formatStatusSummary(runtime).split("\n").slice(1)) {
    const separator = line.indexOf(": ");
    if (separator === -1) {
      unparsed.push(line);
      continue;
    }
    fields.set(line.slice(0, separator), line.slice(separator + 2));
  }

  const sections: PanelSection[] = [];
  const used = new Set<string>();
  for (const group of STATUS_GROUPS) {
    const lines = group.keys.flatMap((key) => {
      const value = fields.get(key);
      if (value === undefined) {
        return [];
      }
      used.add(key);
      return [`${key}: ${value}`];
    });
    if (lines.length > 0) {
      sections.push({ label: group.label, lines });
    }
  }

  const rest = [...fields.entries()]
    .filter(([key]) => !used.has(key))
    .map(([key, value]) => `${key}: ${value}`);
  if (rest.length > 0) {
    sections.push({ label: "Other", lines: rest });
  }
  if (unparsed.length > 0) {
    sections.push({ label: "Details", lines: unparsed });
  }
  return sections;
}

export function createStatusPanel(
  runtime: CodepunkRuntime,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: () => void,
): Panel {
  return new Panel(
    {
      title: "codepunk status",
      sections: statusPanelSections(runtime),
      footer: "esc close",
    },
    theme,
    keybindings,
    done,
  );
}
