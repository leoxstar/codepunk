import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodepunkRuntime } from "codepunk-core";
import type { TuiState } from "../state.ts";

export function setRuntimeStatus(
  state: TuiState,
  context: ExtensionContext,
  key: string,
  value: string | undefined,
): void {
  context.ui.setStatus(
    key,
    state.runtime?.config.tui.status === true ? value : undefined,
  );
}
export function currentShellStatus(
  runtime: Pick<CodepunkRuntime, "sandbox">,
): "srt" | "explicit-unsandboxed" | "disabled" {
  if (runtime.sandbox?.sandboxed === true) {
    return "srt";
  }
  return runtime.sandbox === null ? "disabled" : "explicit-unsandboxed";
}
