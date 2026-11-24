import path from "node:path";
import type {
  ConfigReloadResult,
  PluginReloadResult,
  SkillReloadResult,
} from "codepunk-core";

export function formatSkillReload(result: SkillReloadResult): string {
  if (result.error !== null) {
    return `Skill reload failed: ${result.error}`;
  }
  if (result.skipped === "disabled") {
    return "Skills are disabled for this session.";
  }
  if (result.skills.length === 0) {
    return "Skills reloaded: none discovered.";
  }
  return `Skills reloaded: ${result.skills
    .map((skill) => `${skill.name} (${skill.scope})`)
    .join(", ")}`;
}

export function formatPluginReload(result: PluginReloadResult): string {
  if (result.error !== null) {
    return `Plugin reload failed: ${result.error}\nThe previous plugin surface was kept.`;
  }
  if (result.skipped === "disabled") {
    return "Plugins are disabled for this session.";
  }
  if (result.skipped === "read-only") {
    return "Plugins are not loaded while autonomy is read-only.";
  }
  if (result.skipped === "headless") {
    return "Plugins are not loaded in headless sessions.";
  }
  if (result.plugins.paths.length === 0) {
    return "Plugins reloaded: none installed.";
  }
  return `Plugins reloaded: ${result.plugins.paths
    .map((file) => path.basename(file))
    .join(", ")}`;
}
export function formatConfigReload(outcome: ConfigReloadResult): string {
  if (!outcome.changed) {
    return [
      "Codepunk config: unchanged.",
      ...outcome.warnings.map((warning) => `warning: ${warning}`),
    ].join("\n");
  }
  return [
    "Codepunk config reloaded.",
    ...(outcome.applied.length === 0
      ? []
      : [`applied now: ${outcome.applied.join(", ")}`]),
    ...(outcome.pluginsChanged
      ? ["plugin surface follows plugins.enabled; see the plugin result below"]
      : []),
    ...(outcome.nextSession.length === 0
      ? []
      : [`next session: ${outcome.nextSession.join(", ")}`]),
    ...(outcome.blocked.length === 0
      ? []
      : [`blocked: ${outcome.blocked.join("; ")}`]),
    ...outcome.warnings.map((warning) => `warning: ${warning}`),
  ].join("\n");
}
