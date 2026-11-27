import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactOutputPreview } from "../artifacts/index.ts";
import { readEvidenceFile } from "../evidence/index.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import { simpleShellArgv } from "../policy/index.ts";

export interface RepeatedApprovalCandidate {
  command: string;
  cwd: string;
  count: number;
  persistable_exact_argv: boolean;
}

export interface PolicyDenialHotspot {
  rule: string;
  tool: string;
  count: number;
  sample: string;
}

export interface PermissionInsights {
  version: 1;
  runs_scanned: number;
  records_scanned: number;
  human_approvals: number;
  session_reuses: number;
  reviewer_resolutions: number;
  denials: number;
  repeated_once_approvals: RepeatedApprovalCandidate[];
  top_denials: PolicyDenialHotspot[];
}

function cleanSample(
  value: string,
  deliveryRoot: string,
  codepunkHome: string,
): string {
  const userHome = os.homedir();
  let text = redactOutputPreview(value, codepunkHome);
  if (userHome.length > 1) {
    text = redactOutputPreview(text, userHome);
  }
  if (deliveryRoot.length > 1) {
    text = text.replaceAll(`${deliveryRoot}/`, "");
    text = text.replaceAll(deliveryRoot, ".");
  }
  return text.slice(0, 120);
}

export async function analyzePermissionInsights(
  paths: ProjectPaths,
): Promise<PermissionInsights> {
  let sessionDirs: string[] = [];
  try {
    sessionDirs = await fs.readdir(paths.evidenceDir);
  } catch {
    sessionDirs = [];
  }

  let runsScanned = 0;
  let recordsScanned = 0;
  let humanApprovals = 0;
  let sessionReuses = 0;
  let reviewerResolutions = 0;
  let denials = 0;

  const onceMap = new Map<
    string,
    { command: string; cwd: string; count: number; persistable: boolean }
  >();
  const denyMap = new Map<
    string,
    { rule: string; tool: string; count: number; sample: string }
  >();

  for (const sessionId of sessionDirs) {
    const dir = path.join(paths.evidenceDir, sessionId);
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl") || file === "index.jsonl") {
        continue;
      }
      let loaded;
      try {
        loaded = await readEvidenceFile(path.join(dir, file));
      } catch {
        continue;
      }
      runsScanned += 1;
      for (const record of loaded.records) {
        recordsScanned += 1;
        if (record.reviewer !== undefined && record.reviewer !== null) {
          reviewerResolutions += 1;
        }
        if (record.approval !== null) {
          if (record.approval.reused_from_request_id !== undefined) {
            sessionReuses += 1;
          } else if (record.approval.answer === "allow") {
            humanApprovals += 1;
            if (
              record.approval.scope === "once" &&
              (record.tool === "bash" || record.tool === "exec")
            ) {
              const rawCmd =
                record.command ??
                (record.command_argv ? record.command_argv.join(" ") : "");
              if (rawCmd.trim().length > 0) {
                const cleanedCmd = cleanSample(
                  rawCmd.trim(),
                  paths.deliveryRoot,
                  paths.home,
                );
                const cleanedCwd = cleanSample(
                  record.cwd,
                  paths.deliveryRoot,
                  paths.home,
                );
                const key = `${cleanedCwd}\0${cleanedCmd}`;
                const persistable =
                  record.command_argv !== null ||
                  simpleShellArgv(rawCmd) !== null;
                const prev = onceMap.get(key);
                if (prev === undefined) {
                  onceMap.set(key, {
                    command: cleanedCmd,
                    cwd: cleanedCwd,
                    count: 1,
                    persistable,
                  });
                } else {
                  prev.count += 1;
                }
              }
            }
          }
        }
        if (record.decision === "deny") {
          denials += 1;
          const rawSample =
            record.command ??
            (record.command_argv ? record.command_argv.join(" ") : null) ??
            record.path_check.target ??
            record.tool;
          const key = `${record.rule}\0${record.tool}`;
          const prev = denyMap.get(key);
          if (prev === undefined) {
            denyMap.set(key, {
              rule: record.rule,
              tool: record.tool,
              count: 1,
              sample: cleanSample(rawSample, paths.deliveryRoot, paths.home),
            });
          } else {
            prev.count += 1;
          }
        }
      }
    }
  }

  const repeatedOnce = [...onceMap.values()]
    .filter((item) => item.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((item) => ({
      command: item.command,
      cwd: item.cwd,
      count: item.count,
      persistable_exact_argv: item.persistable,
    }));

  const topDenials = [...denyMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    version: 1,
    runs_scanned: runsScanned,
    records_scanned: recordsScanned,
    human_approvals: humanApprovals,
    session_reuses: sessionReuses,
    reviewer_resolutions: reviewerResolutions,
    denials,
    repeated_once_approvals: repeatedOnce,
    top_denials: topDenials,
  };
}

export function formatPermissionInsights(insights: PermissionInsights): string {
  const lines: string[] = [
    `Permission insights (${insights.runs_scanned} run(s), ${insights.records_scanned} evidence record(s))`,
    `  human approvals: ${insights.human_approvals} · session reuses: ${insights.session_reuses} · reviewer: ${insights.reviewer_resolutions} · denials: ${insights.denials}`,
    "",
    "Repeated 'Allow once' shell commands (candidates for 'Allow for session' or 'Always allow exact'):",
  ];
  if (insights.repeated_once_approvals.length === 0) {
    lines.push("  none (no shell command was approved once 2+ times)");
  } else {
    for (const candidate of insights.repeated_once_approvals) {
      const hint = candidate.persistable_exact_argv
        ? "eligible for 'Always allow exact' (p)"
        : "pipeline; eligible for 'Allow for session' (s)";
      lines.push(
        `  ${candidate.count}x  ${candidate.command}  [cwd: ${candidate.cwd}] — ${hint}`,
      );
    }
  }

  lines.push("", "Top policy / approval denials:");
  if (insights.top_denials.length === 0) {
    lines.push("  none");
  } else {
    for (const item of insights.top_denials) {
      lines.push(
        `  ${item.count}x  ${item.rule} (${item.tool}) — e.g. ${item.sample}`,
      );
    }
  }
  return lines.join("\n");
}
