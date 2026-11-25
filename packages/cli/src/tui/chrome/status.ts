import { DeferredSandbox, type CodepunkRuntime } from "codepunk-core";

export function currentShellStatus(
  runtime: Pick<CodepunkRuntime, "config" | "sandbox" | "shellPreflightIssue">,
):
  "srt" | "srt-preparing" | "explicit-unsandboxed" | "srt-failed" | "disabled" {
  if (runtime.shellPreflightIssue !== null) {
    return "srt-failed";
  }
  if (runtime.sandbox?.sandboxed === true) {
    return runtime.sandbox instanceof DeferredSandbox ? "srt-preparing" : "srt";
  }
  if (runtime.sandbox !== null) {
    return "explicit-unsandboxed";
  }
  return runtime.config.sandbox.mode === "uncovered"
    ? "disabled"
    : "srt-failed";
}

export function sandboxStatusLines(
  runtime: Pick<CodepunkRuntime, "config" | "sandbox" | "shellPreflightIssue">,
): string[] | undefined {
  if (runtime.sandbox instanceof DeferredSandbox) {
    return ["srt sandbox preparing; shell tools will wait until it is ready"];
  }
  if (runtime.shellPreflightIssue !== null) {
    return [
      `srt shell unavailable: ${runtime.shellPreflightIssue}`,
      "shell tools are disabled",
    ];
  }
  if (runtime.sandbox === null && runtime.config.sandbox.mode === "required") {
    return [
      "srt sandbox initialization failed; shell tools are disabled",
      "run codepunk doctor for details",
    ];
  }
  return undefined;
}
