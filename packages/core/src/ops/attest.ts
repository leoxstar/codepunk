import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EvidenceRecord } from "codepunk-protocol";
import { redactOutputPreview } from "../artifacts/index.ts";
import { readEvidenceFile, validateEvidenceChain } from "../evidence/index.ts";
import { relativeDisplayPath } from "../platform/path.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import type { SessionStore } from "../session/index.ts";
import { resolveSession } from "../session/ops.ts";

export interface AttestedRun {
  run_id: string;
  records: number;
  head_sha256: string | null;
  chain_valid: boolean;
  signed_verdict: string | null;
  signed_by: string | null;
}

export interface AttestedCommand {
  run_id: string;
  command: string;
  exit_code: number | null;
  coverage: EvidenceRecord["coverage"];
  sandbox_backend: EvidenceRecord["sandbox"]["backend"];
}

export interface AttestedFileChange {
  path: string;
  tools: string[];
  edits: number;
  before_sha256: string | null;
  after_sha256: string | null;
  diff_sha256: string | null;
}

export interface AttestedDenial {
  run_id: string;
  tool: string;
  rule: string;
  target: string;
}

export interface SessionAttestation {
  version: 1;
  session_id: string;
  title: string | null;
  created_at: string;
  chain_verified: boolean;
  runs: AttestedRun[];
  commands: AttestedCommand[];
  modified_files: AttestedFileChange[];
  denied_actions: AttestedDenial[];
}

function sanitizeDisplayText(
  value: string,
  deliveryRoot: string,
  codepunkHome: string,
): string {
  const userHome = os.homedir();
  let cleaned = redactOutputPreview(value, codepunkHome);
  if (userHome.length > 1) {
    cleaned = redactOutputPreview(cleaned, userHome);
  }
  if (deliveryRoot.length > 1) {
    cleaned = cleaned.replaceAll(`${deliveryRoot}/`, "");
    cleaned = cleaned.replaceAll(deliveryRoot, ".");
  }
  return cleaned;
}

async function readRunSignOffs(
  paths: ProjectPaths,
  store: SessionStore,
): Promise<Map<string, { verdict: string; actor: string | null }>> {
  const map = new Map<string, { verdict: string; actor: string | null }>();
  for (const event of store.allEvents) {
    if (event.kind !== "verdict/sign_off") {
      continue;
    }
    const data = event.data as {
      run_id?: unknown;
      signed_verdict?: unknown;
      actor?: unknown;
    };
    if (
      typeof data.run_id === "string" &&
      typeof data.signed_verdict === "string"
    ) {
      map.set(data.run_id, {
        verdict: data.signed_verdict,
        actor: typeof data.actor === "string" ? data.actor : null,
      });
    }
  }
  try {
    const verdictFiles = await fs.readdir(paths.verdictsDir);
    for (const file of verdictFiles) {
      if (!file.endsWith(".json")) {
        continue;
      }
      try {
        const raw = JSON.parse(
          await fs.readFile(path.join(paths.verdictsDir, file), "utf8"),
        ) as Record<string, unknown>;
        const runId = typeof raw["run_id"] === "string" ? raw["run_id"] : null;
        const signed =
          typeof raw["signed_verdict"] === "string"
            ? raw["signed_verdict"]
            : typeof raw["verdict"] === "string" && raw["sign_off_id"] !== null
              ? raw["verdict"]
              : null;
        if (runId !== null && signed !== null && !map.has(runId)) {
          map.set(runId, {
            verdict: signed,
            actor: typeof raw["actor"] === "string" ? raw["actor"] : null,
          });
        }
      } catch {
        // Ignore unreadable verdict files from unrelated runs.
      }
    }
  } catch {
    // Missing verdicts directory is normal before /sign.
  }
  return map;
}

export async function attestSession(options: {
  paths: ProjectPaths;
  session?: SessionStore;
  sessionId?: string;
}): Promise<SessionAttestation> {
  const { paths } = options;
  const store =
    options.session ??
    (await resolveSession({
      rootDir: paths.home,
      cwd: paths.cwd,
      projectRoot: paths.deliveryRoot,
      projectId: paths.projectId,
      ...(options.sessionId !== undefined
        ? { sessionId: options.sessionId }
        : {}),
    }));

  const signOffs = await readRunSignOffs(paths, store);
  const sessionEvidenceDir = path.join(paths.evidenceDir, store.sessionId);
  let files: string[] = [];
  try {
    files = (await fs.readdir(sessionEvidenceDir))
      .filter((file) => file.endsWith(".jsonl") && file !== "index.jsonl")
      .sort();
  } catch {
    files = [];
  }

  const runs: AttestedRun[] = [];
  const commands: AttestedCommand[] = [];
  const fileMap = new Map<string, AttestedFileChange>();
  const deniedActions: AttestedDenial[] = [];
  let allChainsValid = true;

  const loadedRuns: Array<{
    runId: string;
    createdAt: number;
    records: EvidenceRecord[];
    head: string | null;
  }> = [];

  for (const file of files) {
    const loaded = await readEvidenceFile(path.join(sessionEvidenceDir, file));
    const runId = loaded.records[0]?.run_id ?? file.slice(0, -6);
    const createdAt =
      loaded.records[0] !== undefined
        ? Date.parse(loaded.records[0].created_at)
        : 0;
    loadedRuns.push({
      runId,
      createdAt,
      records: loaded.records,
      head: loaded.head,
    });
  }
  loadedRuns.sort((a, b) => a.createdAt - b.createdAt);

  for (const entry of loadedRuns) {
    const chain = validateEvidenceChain(entry.records);
    if (!chain.ok) {
      allChainsValid = false;
    }
    const signOff = signOffs.get(entry.runId) ?? null;
    runs.push({
      run_id: entry.runId,
      records: entry.records.length,
      head_sha256: entry.head,
      chain_valid: chain.ok,
      signed_verdict: signOff?.verdict ?? null,
      signed_by: signOff?.actor ?? null,
    });

    for (const record of entry.records) {
      if (record.decision === "deny") {
        const rawTarget =
          record.command ??
          (record.command_argv ? record.command_argv.join(" ") : null) ??
          record.path_check.target ??
          record.tool;
        deniedActions.push({
          run_id: entry.runId,
          tool: record.tool,
          rule: record.rule,
          target: sanitizeDisplayText(
            rawTarget,
            paths.deliveryRoot,
            paths.home,
          ),
        });
        continue;
      }

      if (
        record.tool === "bash" ||
        record.tool === "exec" ||
        record.tool === "user_bash"
      ) {
        const rawCommand =
          record.command ??
          (record.command_argv ? record.command_argv.join(" ") : record.tool);
        commands.push({
          run_id: entry.runId,
          command: sanitizeDisplayText(
            rawCommand,
            paths.deliveryRoot,
            paths.home,
          ),
          exit_code: record.exit_code,
          coverage: record.coverage,
          sandbox_backend: record.sandbox.backend,
        });
      }

      if (
        (record.tool === "write" || record.tool === "edit") &&
        record.outcome === "completed" &&
        record.path_check.target !== null
      ) {
        const relPath = sanitizeDisplayText(
          relativeDisplayPath(paths.deliveryRoot, record.path_check.target),
          paths.deliveryRoot,
          paths.home,
        );
        const existing = fileMap.get(relPath);
        if (existing === undefined) {
          fileMap.set(relPath, {
            path: relPath,
            tools: [record.tool],
            edits: 1,
            before_sha256: record.before_sha256,
            after_sha256: record.after_sha256,
            diff_sha256: record.diff_sha256,
          });
        } else {
          if (!existing.tools.includes(record.tool)) {
            existing.tools.push(record.tool);
          }
          existing.edits += 1;
          existing.after_sha256 = record.after_sha256;
          existing.diff_sha256 = record.diff_sha256;
        }
      }
    }
  }

  const rawTitle = store.metadata.title;
  return {
    version: 1,
    session_id: store.sessionId,
    title:
      rawTitle === null
        ? null
        : sanitizeDisplayText(rawTitle, paths.deliveryRoot, paths.home),
    created_at: store.header.created_at,
    chain_verified: allChainsValid,
    runs,
    commands,
    modified_files: [...fileMap.values()],
    denied_actions: deniedActions,
  };
}

function shortHash(hash: string | null): string {
  if (hash === null) {
    return "none";
  }
  return hash.startsWith("sha256:") ? `sha256:${hash.slice(7, 19)}` : hash;
}

export function formatSessionAttestationMarkdown(
  attestation: SessionAttestation,
): string {
  const signedCount = attestation.runs.filter(
    (run) => run.signed_verdict !== null,
  ).length;
  const lines: string[] = [
    "## Codepunk Verification Summary",
    "",
    `- **Session**: \`${attestation.session_id}\`${attestation.title ? ` — ${attestation.title}` : ""}`,
    `- **Evidence Chain**: ${attestation.chain_verified ? "verified" : "FAILED"} (${attestation.runs.length} run${attestation.runs.length === 1 ? "" : "s"}, ${signedCount} signed)`,
  ];
  for (const run of attestation.runs) {
    const signLabel =
      run.signed_verdict === null
        ? "unsigned"
        : `signed:${run.signed_verdict}${run.signed_by ? ` by ${run.signed_by}` : ""}`;
    lines.push(
      `  - \`${run.run_id}\`: ${run.records} record(s) · head \`${shortHash(run.head_sha256)}\` · ${signLabel}`,
    );
  }

  lines.push("", "### Modified Files");
  if (attestation.modified_files.length === 0) {
    lines.push("- None (no workspace file writes recorded).");
  } else {
    for (const file of attestation.modified_files) {
      lines.push(
        `- \`${file.path}\` (${file.tools.join("+")}, ${file.edits} edit${file.edits === 1 ? "" : "s"}, after \`${shortHash(file.after_sha256)}\`)`,
      );
    }
  }

  lines.push("", "### Shell Commands Executed");
  if (attestation.commands.length === 0) {
    lines.push("- None.");
  } else {
    for (const cmd of attestation.commands.slice(-25)) {
      const status =
        cmd.exit_code === null ? "running/unknown" : `exit ${cmd.exit_code}`;
      const sandbox =
        cmd.sandbox_backend === "srt" ? "srt enforced" : cmd.coverage;
      lines.push(
        `- \`${cmd.command.replace(/`/gu, "'")}\` — ${status} (${sandbox})`,
      );
    }
    if (attestation.commands.length > 25) {
      lines.push(
        `- _(${attestation.commands.length - 25} earlier command(s) omitted; use \`--json\` for full list)_`,
      );
    }
  }

  if (attestation.denied_actions.length > 0) {
    lines.push("", "### Policy & Approval Blocks");
    for (const block of attestation.denied_actions.slice(-15)) {
      lines.push(
        `- \`${block.rule}\` on \`${block.tool}\`: \`${block.target.replace(/`/gu, "'")}\``,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
