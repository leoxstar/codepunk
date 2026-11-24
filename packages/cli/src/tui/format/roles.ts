import {
  loadModelRoles,
  MODEL_ROLE_NAMES,
  resolveModelRole,
  ModelRoleError,
  type CodepunkRuntime,
} from "codepunk-core";
import { physicalModel } from "../chrome/model.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
export async function showModelRoles(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
): Promise<void> {
  try {
    const bundle = await loadModelRoles(runtime.paths);
    if (bundle.warnings.length > 0) {
      context.ui.notify(bundle.warnings.join("\n"), "warning");
    }
    const active = physicalModel(runtime);
    const fallback =
      active !== undefined
        ? `${active.provider}/${active.id}`
        : runtime.config.model.provider !== null &&
            runtime.config.model.id !== null
          ? `${runtime.config.model.provider}/${runtime.config.model.id}`
          : null;
    const lines = ["Model roles"];
    for (const role of MODEL_ROLE_NAMES) {
      const configured = bundle.roles[role];
      if (configured !== undefined) {
        lines.push(`  ${role}: ${configured} (user)`);
        continue;
      }
      if (fallback === null) {
        lines.push(`  ${role}: unconfigured (no fallback model)`);
        continue;
      }
      try {
        const resolved = resolveModelRole(
          bundle,
          runtime.config,
          role,
          fallback,
        );
        lines.push(`  ${role}: ${resolved.model} (${resolved.source})`);
      } catch (error) {
        lines.push(
          `  ${role}: invalid (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    const pools = Object.values(bundle.pools).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    lines.push(
      pools.length === 0
        ? "Subagent pools: none"
        : `Subagent pools (${pools.length})`,
    );
    for (const pool of pools) {
      lines.push(`  ${pool.name}: max ${pool.max} · ${pool.models.join(", ")}`);
    }
    context.ui.notify(lines.join("\n"), "info");
  } catch (error) {
    context.ui.notify(
      `/roles failed: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof ModelRoleError ? "warning" : "error",
    );
  }
}
