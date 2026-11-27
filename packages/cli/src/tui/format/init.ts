import type { CodepunkRuntime } from "codepunk-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelOnboardingMessage, physicalModel } from "../chrome/model.ts";
import path from "node:path";
import { promises as fs } from "node:fs";
import { PI_INSTRUCTION_FILE_NAMES } from "codepunk-core";

export async function findRootInstructionFile(
  root: string,
): Promise<string | null> {
  for (const name of PI_INSTRUCTION_FILE_NAMES) {
    const candidate = path.join(root, name);
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isFile() || stat.isSymbolicLink()) {
        return candidate;
      }
    } catch {
      // A missing candidate is the normal case; keep looking.
    }
  }
  return null;
}

export function buildInitPrompt(
  root: string,
  existingFile: string | null,
): string {
  const target = existingFile ?? path.join(root, "AGENTS.md");
  return [
    `${
      existingFile === null ? "Create" : "Update"
    } the repository guidance file at ${target}.`,
    "",
    "Work from repository evidence only. Inspect the README and any",
    "package/build/test configuration (for example package.json,",
    "pnpm-workspace.yaml, Makefile, pyproject.toml, Cargo.toml, go.mod), the",
    "top-level layout, and existing docs. Verify commands before writing them;",
    "omit anything you cannot verify.",
    "",
    "The file is for future coding agents. Include only information that is",
    "expensive to rediscover:",
    "- what the project is and its main runtime boundaries;",
    "- exact install, build, test, lint, and single-test commands that exist;",
    "- module or directory ownership and dependency direction when clear;",
    "- repository-specific conventions, generated files, and traps;",
    "- required environment or setup steps that are documented or evidenced.",
    "",
    "Do not include generic advice, marketing copy, secrets, absolute local",
    "paths, usernames, hostnames, or a file-by-file inventory. Do not modify",
    "any file other than the target. Keep it under 120 lines.",
    "",
    existingFile === null
      ? "If a nested AGENTS.md or CLAUDE.md contradicts the root file you write, report the conflict in your final reply instead of silently overriding it."
      : "Preserve accurate existing content and remove stale or generic text. If the target is a symlink, stop and report it instead of writing through it.",
    "",
    "When finished, reply with the target path, the sections you wrote, and",
    "any command you could not verify.",
  ].join("\n");
}

export function buildPlanRoundPrompt(request: string): string {
  return [
    "Plan the request below before changing anything. Use read-only tools to",
    "inspect the repository, then record the full ordered plan with the plan tool,",
    "keeping at most one step in_progress.",
    "",
    "Do not implement the request. Stop after the plan is recorded and reply",
    "with a short summary; the user approves it with /plan approve.",
    "",
    "Request:",
    request,
  ].join("\n");
}

export async function initializeProjectInstructions(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
  argument: string,
): Promise<void> {
  const option = argument.trim();
  if (option !== "" && option !== "--update") {
    context.ui.notify("usage: /init [--update]", "warning");
    return;
  }
  if (!runtime.workspaceTrust.grants.instructions) {
    context.ui.notify(
      [
        "Project instructions are not trusted, so a new AGENTS.md would not load.",
        "Run /trust grant instructions, then restart codepunk and run /init again.",
        "/trust grant only changes future sessions.",
      ].join("\n"),
      "warning",
    );
    return;
  }
  if (runtime.config.autonomy.profile === "read-only") {
    context.ui.notify(
      "The current autonomy is read-only. Switch with /permissions profile standard before /init.",
      "warning",
    );
    return;
  }
  if (runtime.host.session.isStreaming || runtime.host.session.isCompacting) {
    context.ui.notify(
      "Wait for the current response or compaction to finish before /init.",
      "warning",
    );
    return;
  }
  const existingFile = await findRootInstructionFile(
    runtime.paths.deliveryRoot,
  );
  if (existingFile !== null) {
    let symlink = false;
    try {
      symlink = (await fs.lstat(existingFile)).isSymbolicLink();
    } catch {
      symlink = false;
    }
    if (symlink) {
      context.ui.notify(
        `${existingFile} is a symlink. /init does not write through instruction symlinks; replace it with a regular file first.`,
        "warning",
      );
      return;
    }
    if (option !== "--update") {
      context.ui.notify(
        [
          `${existingFile} already exists.`,
          "Use /init --update to let the agent revise that file in place.",
        ].join("\n"),
        "info",
      );
      return;
    }
  }
  if (physicalModel(runtime) === undefined) {
    context.ui.notify(
      modelOnboardingMessage(runtime) ??
        "No model selected. Use /model to choose one.",
      "warning",
    );
    return;
  }
  context.ui.notify(
    [
      `Starting project instruction initialization for ${
        existingFile ?? path.join(runtime.paths.deliveryRoot, "AGENTS.md")
      }.`,
      "The new file applies when the next session starts.",
    ].join("\n"),
    "info",
  );
  try {
    await runtime.host.session.prompt(
      buildInitPrompt(runtime.paths.deliveryRoot, existingFile),
    );
  } catch (error) {
    context.ui.notify(
      `/init could not start: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
}
