import type { CodepunkRuntime } from "codepunk-core";
import { permissionSummary } from "../format/status.ts";
import { defaultViewportHeight } from "./frame.ts";
import {
  Panel,
  type PanelKeybindings,
  type PanelSection,
  type PanelTheme,
} from "./panel.ts";

interface FieldGroup {
  readonly label: string;
  readonly keys: readonly string[];
  readonly tone?: PanelSection["tone"];
}

const FIELD_GROUPS: readonly FieldGroup[] = [
  { label: "Profile", keys: ["profile"] },
  {
    label: "Trust",
    keys: ["workspace trust", "trust root", "approvals beyond this call"],
  },
  {
    label: "Approvals",
    keys: ["approvals", "approval reviewer"],
  },
  { label: "Autonomy", keys: ["autonomy"] },
  { label: "Behavior", keys: ["behavior", "safe reads"] },
  { label: "Shell", keys: ["current shell", "next session sandbox"] },
  {
    label: "Network",
    keys: ["next session network", "next session network deny"],
  },
  {
    label: "Filesystem",
    keys: ["next session filesystem", "extra file roots"],
  },
  { label: "Config", keys: ["config"] },
  { label: "Profiles", keys: ["Profiles"] },
];

interface PermissionFields {
  readonly fields: ReadonlyMap<string, string>;
  readonly usage: readonly string[];
  readonly notes: readonly string[];
}

function permissionFields(runtime: CodepunkRuntime): PermissionFields {
  const fields = new Map<string, string>();
  const usage: string[] = [];
  const notes: string[] = [];
  let inUsage = false;
  for (const line of permissionSummary(runtime).split("\n").slice(1)) {
    if (line === "usage:") {
      inUsage = true;
      usage.push(line);
      continue;
    }
    if (inUsage) {
      if (line.startsWith("  ")) {
        usage.push(line);
        continue;
      }
      if (line.length === 0) {
        continue;
      }
      inUsage = false;
    }
    if (line.length === 0) {
      continue;
    }
    const separator = line.indexOf(": ");
    if (separator === -1) {
      notes.push(line);
      continue;
    }
    fields.set(line.slice(0, separator), line.slice(separator + 2));
  }
  while (usage.length > 0 && usage.at(-1) === "") {
    usage.pop();
  }
  return { fields, usage, notes };
}

/**
 * Project permissionSummary into panel sections. The grouping preserves every
 * field and the usage block; it never re-derives policy.
 */
export function permissionPanelSections(
  runtime: CodepunkRuntime,
): PanelSection[] {
  const { fields, usage, notes } = permissionFields(runtime);
  const sections: PanelSection[] = [];
  const used = new Set<string>();
  for (const group of FIELD_GROUPS) {
    const lines = group.keys.flatMap((key) => {
      const value = fields.get(key);
      if (value === undefined) {
        return [];
      }
      used.add(key);
      return [`${key}: ${value}`];
    });
    if (lines.length > 0) {
      const tone =
        group.label === "Trust" && fields.has("approvals beyond this call")
          ? "warning"
          : group.tone;
      sections.push({
        label: group.label,
        lines,
        ...(tone === undefined ? {} : { tone }),
      });
    }
  }
  const rest = [...fields.entries()]
    .filter(([key]) => !used.has(key))
    .map(([key, value]) => `${key}: ${value}`);
  if (rest.length > 0) {
    sections.push({ label: "Other", lines: rest });
  }
  if (notes.length > 0) {
    sections.push({ label: "Notes", lines: notes });
  }
  if (usage.length > 0) {
    sections.push({
      label: "Usage",
      lines: [
        "groups: profile · approval · autonomy · sandbox · filesystem · rules · why · trust",
        "full syntax: /help",
      ],
      tone: "muted",
    });
  }
  return sections;
}

export function createPermissionPanel(
  runtime: CodepunkRuntime,
  theme: PanelTheme,
  keybindings: PanelKeybindings,
  done: () => void,
): Panel {
  return new Panel(
    {
      title: "codepunk permissions",
      sections: permissionPanelSections(runtime),
      footer: "esc close",
      viewportHeight: defaultViewportHeight(),
    },
    theme,
    keybindings,
    done,
  );
}
