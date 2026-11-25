import type { ScopedRule } from "codepunk-core";
import type { TableOptions } from "./table.ts";

export interface ScopedRulesView {
  readonly filePath: string | null;
  readonly rules: readonly ScopedRule[];
}

function shortHash(value: string): string {
  return value.replace(/^sha256:/u, "").slice(0, 12);
}

export function scopedRulesTableOptions(view: ScopedRulesView): TableOptions {
  const visible = view.rules.slice(0, 30);
  const hidden = view.rules.length - visible.length;
  return {
    columns: [
      { label: "ID", minWidth: 6, maxWidth: 24 },
      { label: "ARGV", minWidth: 12, maxWidth: 48 },
      { label: "CWD", minWidth: 8, maxWidth: 36 },
      { label: "HASH", minWidth: 8, maxWidth: 12, align: "right" },
    ],
    rows: visible.map((rule) => [
      rule.id,
      rule.argv.join(" "),
      rule.cwd,
      shortHash(rule.rule_sha256),
    ]),
    emptyText:
      'No scoped rules. Choose "Always allow exact" on an approval to create one.',
    ...(hidden === 0 ? {} : { overflowText: `… ${hidden} more` }),
  };
}

export function scopedRulesTitle(
  view: ScopedRulesView,
  profile: string,
): string {
  return view.rules.length === 0
    ? "Scoped rules: none"
    : `Scoped rules: ${view.rules.length} (profile ${profile})`;
}
