import { promises as fs } from "node:fs";
import path from "node:path";
import {
  generateUnifiedPatch,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { redactOutputPreview, type CodepunkRuntime } from "codepunk-core";
import type { EvidenceRecord } from "codepunk-protocol";
import { commandContext } from "../command-context.ts";
import { defineCommand, type TuiCommand } from "../define-command.ts";
import type { TuiState } from "../state.ts";

const CORRECTIVE_CUE =
  /(?:^|\b)(?:always|never|do not|don't|must not|prefer|use .+ instead|remember to)\b|(?:不要|必须|切勿|严禁|优先使用|记住|以后请|以后都)/iu;

function extractTextFromMessage(message: unknown): {
  role: string;
  text: string;
} {
  if (message === null || typeof message !== "object") {
    return { role: "", text: "" };
  }
  const rec = message as Record<string, unknown>;
  const role = typeof rec["role"] === "string" ? rec["role"] : "";
  const content = rec["content"];
  if (typeof content === "string") {
    return { role, text: content };
  }
  if (!Array.isArray(content)) {
    return { role, text: "" };
  }
  const parts: string[] = [];
  for (const item of content) {
    if (
      item !== null &&
      typeof item === "object" &&
      (item as Record<string, unknown>)["type"] === "text" &&
      typeof (item as Record<string, unknown>)["text"] === "string"
    ) {
      parts.push((item as Record<string, unknown>)["text"] as string);
    }
  }
  return { role, text: parts.join("\n") };
}

export function extractSessionLearnings(
  messages: readonly unknown[],
  evidenceRecords: readonly Pick<EvidenceRecord, "approval">[],
  codepunkHome?: string,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (raw: string) => {
    const cleaned = redactOutputPreview(raw, codepunkHome)
      .replace(/\s+/gu, " ")
      .trim();
    if (cleaned.length < 8 || cleaned.length > 280) {
      return;
    }
    const key = cleaned.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(cleaned);
  };

  for (const record of [...evidenceRecords].reverse()) {
    const guidance = record.approval?.guidance;
    if (typeof guidance === "string" && guidance.trim().length > 0) {
      addCandidate(guidance);
    }
  }
  for (const msg of [...messages].reverse()) {
    const { role, text } = extractTextFromMessage(msg);
    if (role !== "user") {
      continue;
    }
    for (const line of text.split(/\r?\n/u)) {
      const stripped = line.replace(/^[-*>\s]+/u, "").trim();
      if (
        stripped.length >= 8 &&
        !stripped.startsWith("/") &&
        CORRECTIVE_CUE.test(stripped)
      ) {
        addCandidate(stripped);
      }
    }
  }
  return candidates.slice(0, 8);
}

export function proposeAgentsMdRulePatch(
  existingContent: string,
  ruleText: string,
): { updatedContent: string; diff: string; alreadyPresent: boolean } {
  const bullet = `- ${ruleText.replace(/^[-*]\s+/u, "").trim()}`;
  const normalizedExisting = existingContent.replace(/\r\n/gu, "\n");
  if (
    normalizedExisting
      .split("\n")
      .some((line) => line.trim().toLowerCase() === bullet.toLowerCase())
  ) {
    return {
      updatedContent: existingContent,
      diff: "",
      alreadyPresent: true,
    };
  }
  const heading = "## Learned Rules";
  let updated: string;
  if (normalizedExisting.trim().length === 0) {
    updated = `# AGENTS.md\n\n${heading}\n\n${bullet}\n`;
  } else if (normalizedExisting.includes(heading)) {
    const idx = normalizedExisting.indexOf(heading) + heading.length;
    const before = normalizedExisting.slice(0, idx);
    const after = normalizedExisting.slice(idx).replace(/^\n*/u, "");
    updated = `${before}\n\n${bullet}\n${after.length > 0 ? `${after.replace(/\n*$/u, "\n")}` : ""}`;
  } else {
    updated = `${normalizedExisting.replace(/\n*$/u, "")}\n\n${heading}\n\n${bullet}\n`;
  }
  const diff = generateUnifiedPatch(
    "AGENTS.md",
    normalizedExisting,
    updated,
    2,
  );
  return { updatedContent: updated, diff, alreadyPresent: false };
}

async function writeAgentsRuleAtomically(
  agentsPath: string,
  content: string,
): Promise<void> {
  const tempPath = `${agentsPath}.codepunk-learn-${process.pid}.tmp`;
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, agentsPath);
}

export async function runLearnAction(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
  rawArgs: string,
): Promise<void> {
  const trimmed = rawArgs.trim();
  const forceMemory = trimmed === "memory" || trimmed.startsWith("memory ");
  const explicitRule = forceMemory
    ? trimmed.slice("memory".length).trim()
    : trimmed;
  let chosenRule = redactOutputPreview(explicitRule, runtime.paths.home).trim();

  if (chosenRule.length === 0) {
    const candidates = extractSessionLearnings(
      runtime.host.session.messages ?? [],
      runtime.ledger.all,
      runtime.paths.home,
    );
    if (candidates.length === 0) {
      context.ui.notify(
        "No corrective rules detected in this session. Pass one explicitly: /learn <rule to persist>",
        "info",
      );
      return;
    }
    if (candidates.length === 1 || typeof context.ui.select !== "function") {
      chosenRule = candidates[0]!;
    } else {
      const picked = await context.ui.select(
        "Select a session learning to persist",
        [...candidates, "Cancel"],
      );
      if (picked === undefined || picked === "Cancel") {
        return;
      }
      chosenRule = picked;
    }
  }

  if (forceMemory) {
    const res = await runtime.memory.add({
      scope: "project",
      content: chosenRule,
      source: "user",
      source_refs: [`session:${runtime.session.sessionId}`],
    });
    await runtime.recordMemoryWrite({
      scope: "project",
      action: res.ok ? "add" : "reject",
      memoryId: res.record?.id ?? null,
      contentSha256: res.record?.content_sha256 ?? null,
      sourceRefs: [`session:${runtime.session.sessionId}`],
      reason: res.ok ? null : res.reason,
    });
    context.ui.notify(
      res.ok
        ? `Learned rule saved to project memory (${res.record?.id}).`
        : `Memory rejected: ${res.reason}`,
      res.ok ? "info" : "warning",
    );
    return;
  }

  const agentsPath = path.join(runtime.paths.deliveryRoot, "AGENTS.md");
  let existing = "";
  try {
    const stat = await fs.lstat(agentsPath);
    if (stat.isSymbolicLink()) {
      context.ui.notify(
        "Refused to modify symlinked AGENTS.md; use /learn memory <rule> instead.",
        "error",
      );
      return;
    }
    existing = await fs.readFile(agentsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const proposal = proposeAgentsMdRulePatch(existing, chosenRule);
  if (proposal.alreadyPresent) {
    context.ui.notify("Rule is already present in AGENTS.md.", "info");
    return;
  }
  if (typeof context.ui.select !== "function") {
    context.ui.notify(`Proposed AGENTS.md patch:\n${proposal.diff}`, "info");
    return;
  }
  const action = await context.ui.select(
    `Persist learned rule?\n\n${proposal.diff}`,
    ["Write to AGENTS.md", "Save to project memory", "Cancel"],
  );
  if (action === "Write to AGENTS.md") {
    await writeAgentsRuleAtomically(agentsPath, proposal.updatedContent);
    context.ui.notify("Saved learned rule to AGENTS.md.", "info");
    return;
  }
  if (action === "Save to project memory") {
    const res = await runtime.memory.add({
      scope: "project",
      content: chosenRule,
      source: "user",
      source_refs: [`session:${runtime.session.sessionId}`],
    });
    await runtime.recordMemoryWrite({
      scope: "project",
      action: res.ok ? "add" : "reject",
      memoryId: res.record?.id ?? null,
      contentSha256: res.record?.content_sha256 ?? null,
      sourceRefs: [`session:${runtime.session.sessionId}`],
      reason: res.ok ? null : res.reason,
    });
    context.ui.notify(
      res.ok
        ? `Learned rule saved to project memory (${res.record?.id}).`
        : `Memory rejected: ${res.reason}`,
      res.ok ? "info" : "warning",
    );
  }
}

export function learnCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "learn",
    description:
      "Distill session corrections into AGENTS.md or project memory with diff review",
    handler: commandContext(state, async (runtime, context, args) => {
      await runLearnAction(runtime, context, args);
    }),
  });
}
