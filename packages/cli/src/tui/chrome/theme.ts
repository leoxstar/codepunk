import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeUserTuiPreferences, type CodepunkRuntime } from "codepunk-core";

export interface ThemeChoice {
  readonly id: string;
  readonly label: string;
  readonly hostTheme: string;
}

const BUILTIN_THEME_CHOICES: readonly ThemeChoice[] = [
  { id: "codepunk", label: "codepunk (adaptive default)", hostTheme: "system" },
  { id: "dark", label: "dark", hostTheme: "dark" },
  { id: "light", label: "light", hostTheme: "light" },
  { id: "system", label: "system (follow terminal)", hostTheme: "system" },
];

export function availableThemeChoices(
  context?: Pick<ExtensionContext, "ui">,
): ThemeChoice[] {
  const choices: ThemeChoice[] = [...BUILTIN_THEME_CHOICES];
  const seen = new Set(choices.map((entry) => entry.id));
  const discovered = context?.ui.getAllThemes?.() ?? [];
  for (const item of discovered) {
    if (!seen.has(item.name)) {
      seen.add(item.name);
      choices.push({
        id: item.name,
        label: item.path ? `${item.name} (custom)` : item.name,
        hostTheme: item.name,
      });
    }
  }
  return choices;
}

export function resolveHostThemeName(themeId: string): string {
  const builtin = BUILTIN_THEME_CHOICES.find((entry) => entry.id === themeId);
  return builtin?.hostTheme ?? themeId;
}

export async function applyTuiTheme(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
  themeId: string,
  persist = true,
): Promise<{ readonly ok: boolean; readonly error?: string }> {
  const hostName = resolveHostThemeName(themeId);
  if (typeof context.ui.setTheme === "function") {
    const result = context.ui.setTheme(hostName);
    if (!result.success) {
      return { ok: false, error: result.error ?? `theme ${themeId} not found` };
    }
  }
  runtime.config.tui.theme = themeId;
  if (persist) {
    await writeUserTuiPreferences(runtime.paths, { theme: themeId }).catch(
      () => undefined,
    );
  }
  return { ok: true };
}
