import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  SubagentModelPoolManager,
  loadModelRoles,
  resolveModelRole,
  type CodepunkRuntime,
  type SubagentModelLease,
} from "codepunk-core";
import type { TuiState } from "../state.ts";
import type { SubagentInvocation } from "./subagent-common.ts";

export interface SubagentModelSelection {
  roleSelection: ReturnType<typeof resolveModelRole> | undefined;
  modelLease: SubagentModelLease | undefined;
}

export async function configureSubagentModel(
  state: TuiState,
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  invocation: SubagentInvocation,
  configuredModel: string | undefined,
): Promise<SubagentModelSelection | null> {
  let roleSelection: ReturnType<typeof resolveModelRole> | undefined;
  let modelLease: SubagentModelLease | undefined;
  if (invocation.role !== undefined || invocation.poolName !== undefined) {
    let roleBundle: Awaited<ReturnType<typeof loadModelRoles>>;
    try {
      roleBundle = await loadModelRoles(runtime.paths);
    } catch (error) {
      context.ui.notify(
        `model roles could not be loaded: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
      return null;
    }
    if (roleBundle.warnings.length > 0) {
      context.ui.notify(roleBundle.warnings.join("\n"), "warning");
    }
    if (invocation.role !== undefined) {
      if (configuredModel === undefined) {
        context.ui.notify(
          `role ${invocation.role} has no fallback model; select a model or configure roles.toml`,
          "error",
        );
        return null;
      }
      try {
        roleSelection = resolveModelRole(
          roleBundle,
          runtime.config,
          invocation.role,
          configuredModel,
        );
      } catch (error) {
        context.ui.notify(
          `role ${invocation.role} is not usable: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
        return null;
      }
    }
    if (invocation.poolName !== undefined) {
      const definition = roleBundle.pools[invocation.poolName];
      if (definition === undefined) {
        context.ui.notify(
          `subagent model pool ${invocation.poolName} is not configured`,
          "error",
        );
        return null;
      }
      const requested =
        invocation.model === undefined
          ? definition.models.slice(0, definition.max)
          : [
              invocation.model,
              ...definition.models.filter(
                (entry) => entry !== invocation.model,
              ),
            ].slice(0, definition.max);
      try {
        state.modelPool ??= new SubagentModelPoolManager();
        modelLease = state.modelPool.acquire(
          roleBundle,
          runtime.config,
          invocation.poolName,
          requested,
        );
      } catch (error) {
        context.ui.notify(
          `subagent model pool ${invocation.poolName} is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
        return null;
      }
    }
  }
  return { roleSelection, modelLease };
}
