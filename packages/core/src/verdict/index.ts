import type {
  EvidenceRecord,
  RunEndEvent,
  SessionEvent,
  SignOffEvent,
  SignOffRequest,
  Verdict,
  VerdictValue,
} from "codepunk-protocol";
import {
  evidenceRecordHash,
  validateEvidenceChain,
  validateEvidenceForClass,
} from "../evidence/index.ts";
import { createUlid } from "../platform/hash.ts";

export type MechanicalStatus = "eligible" | "incomplete" | "unverifiable";

export interface VerdictInput {
  runId: string;
  sessionId: string;
  records: readonly EvidenceRecord[];
  events: readonly SessionEvent[];
  chainIssues?: readonly string[];
  truncatedTail?: boolean;
  vcs?: Verdict["vcs"];
  now?: Date;
}

export interface VerdictDerivation {
  verdict: Verdict;
  issues: string[];
  coverage: Verdict["coverage"];
}

export interface MechanicalDerivation {
  status: MechanicalStatus;
  issues: string[];
  coverage: Verdict["coverage"];
  head: string | null;
  runEnd: RunEndEvent | null;
}

export interface PreparedSignOff {
  data: SignOffEvent["data"];
  mechanical: MechanicalDerivation;
}

export type SignOffPreparation =
  | { ok: true; prepared: PreparedSignOff }
  | { ok: false; code: string; message: string; issues: string[] };

type RunEventKind =
  | "run/start"
  | "user/input"
  | "bash/result"
  | "compaction/decision"
  | "run/end"
  | "verdict/sign_off";

function eventForRun<K extends RunEventKind>(
  events: readonly SessionEvent[],
  runId: string,
  kind: K,
): Extract<SessionEvent, { kind: K }>[] {
  return events.filter(
    (event): event is Extract<SessionEvent, { kind: K }> =>
      event.kind === kind && event.data.run_id === runId,
  ) as Extract<SessionEvent, { kind: K }>[];
}

function coverageOf(records: readonly EvidenceRecord[]): Verdict["coverage"] {
  const executed = records.filter((record) => record.decision === "allow");
  if (executed.some((record) => record.coverage === "uncovered")) {
    return "uncovered";
  }
  if (executed.some((record) => record.coverage === "app-layer")) {
    return "app-layer";
  }
  return executed.length === 0 ? "uncovered" : "enforced";
}

function compactionIssues(
  events: readonly SessionEvent[],
  runId: string,
): string[] {
  const issues: string[] = [];
  for (const event of eventForRun(events, runId, "compaction/decision")) {
    if (
      event.data.entries === 0 &&
      event.data.failure !== undefined &&
      /nothing to compact/iu.test(event.data.failure)
    ) {
      continue;
    }
    if (event.data.reason === "manual" && event.data.cancelled) {
      issues.push("manual compaction was cancelled");
    } else if (event.data.cancelled) {
      issues.push(`automatic compaction (${event.data.reason}) was cancelled`);
    }
    if (!event.data.cancelled) {
      if (event.data.entries !== 1) {
        issues.push(
          `${event.data.reason} compaction produced ${event.data.entries} entries`,
        );
      }
      const checkpoint = event.data.checkpoint;
      if (checkpoint === undefined) {
        issues.push(
          `${event.data.reason} compaction has no recoverable checkpoint`,
        );
      } else if (
        checkpoint.messages_after === 0 &&
        checkpoint.messages_before > 0
      ) {
        issues.push(`${event.data.reason} compaction kept no visible history`);
      }
    }
  }
  return issues;
}

export function deriveMechanical(input: {
  runId: string;
  records: readonly EvidenceRecord[];
  events: readonly SessionEvent[];
  chainIssues?: readonly string[];
  truncatedTail?: boolean;
}): MechanicalDerivation {
  const unverifiable: string[] = [];
  const incomplete: string[] = [];
  const records = [...input.records];
  const chain = validateEvidenceChain(records);
  if ((input.chainIssues?.length ?? 0) > 0) {
    unverifiable.push(...(input.chainIssues ?? []));
  }
  if (!chain.ok) {
    unverifiable.push(...chain.issues);
  }
  if (input.truncatedTail) {
    unverifiable.push("evidence tail is truncated");
  }
  for (const record of records) {
    const classCheck = validateEvidenceForClass(record);
    if (!classCheck.ok) {
      unverifiable.push(
        ...classCheck.issues.map((issue) => `${record.id}: ${issue}`),
      );
    }
    if (record.decision === "ask") {
      unverifiable.push(`record ${record.seq} has an unresolved approval`);
    }
    if (record.decision === "allow" && record.coverage === "uncovered") {
      unverifiable.push(`record ${record.seq} has uncovered execution`);
    }
    if (record.decision === "deny") {
      incomplete.push(`record ${record.seq} was denied`);
    }
    if (record.outcome === "failed") {
      incomplete.push(`record ${record.seq} failed during execution`);
    }
    if (record.outcome === "cancelled") {
      incomplete.push(`record ${record.seq} was cancelled`);
    }
    if (
      record.exit_code !== null &&
      record.exit_code !== 0 &&
      (record.tool === "bash" ||
        record.tool === "exec" ||
        record.tool === "user_bash")
    ) {
      incomplete.push(
        `record ${record.seq} failed with exit code ${record.exit_code}`,
      );
    }
  }
  unverifiable.push(...compactionIssues(input.events, input.runId));

  const runEnds = eventForRun(input.events, input.runId, "run/end");
  const runEnd = runEnds.length === 1 ? runEnds[0]! : null;
  if (runEnds.length === 0) {
    unverifiable.push("run/end is missing");
  } else if (runEnds.length > 1) {
    unverifiable.push("run has ambiguous run/end events");
  } else if (runEnd !== null) {
    if (runEnd.data.state !== "settled") {
      incomplete.push(`run ended in state ${runEnd.data.state}`);
    }
    if (
      runEnd.data.state === "cancelled" &&
      runEnd.data.termination === "human_cancel"
    ) {
      incomplete.push("run was cancelled by the human");
    }
  }

  const head =
    records.length === 0
      ? null
      : evidenceRecordHash(records[records.length - 1]!);
  if (runEnd !== null && runEnd.data.evidence_head !== head) {
    unverifiable.push(
      "run/end evidence head does not match the evidence chain",
    );
  }

  const status: MechanicalStatus =
    unverifiable.length > 0
      ? "unverifiable"
      : incomplete.length > 0
        ? "incomplete"
        : "eligible";
  return {
    status,
    issues: [...unverifiable, ...incomplete],
    coverage: coverageOf(records),
    head,
    runEnd,
  };
}

export function signOffRequestIssue(request: SignOffRequest): string | null {
  if (request.source !== "human") {
    return "sign-off must come from a human surface";
  }
  if (!request.is_tty) {
    return "sign-off requires a TTY";
  }
  if (request.channel !== "tui" && request.channel !== "cli") {
    return "invalid sign-off channel";
  }
  if (request.actor.length === 0) {
    return "sign-off actor is missing";
  }
  return null;
}

function signOffBindingIssue(
  signOffs: readonly SignOffEvent[],
  head: string | null,
): string | null {
  const latest = signOffs.at(-1);
  if (latest === undefined) {
    return null;
  }
  const previous = signOffs.at(-2);
  const expectedPrevious = previous?.data.sign_off_id ?? null;
  if (latest.data.previous_sign_off_id !== expectedPrevious) {
    return "sign-off previous_sign_off_id does not match the previous sign-off";
  }
  if (latest.data.evidence_head !== head) {
    return "sign-off evidence head does not match the evidence chain";
  }
  if (latest.data.actor.length === 0) {
    return "sign-off actor is missing";
  }
  return null;
}

export function prepareSignOff(input: {
  runId: string;
  records: readonly EvidenceRecord[];
  events: readonly SessionEvent[];
  request: SignOffRequest;
  now?: Date;
}): SignOffPreparation {
  const requestIssue = signOffRequestIssue(input.request);
  if (requestIssue !== null) {
    return {
      ok: false,
      code: "invalid_source",
      message: requestIssue,
      issues: [requestIssue],
    };
  }
  if (input.request.run_id !== input.runId) {
    return {
      ok: false,
      code: "run_mismatch",
      message: "sign-off run id does not match the evidence run",
      issues: ["run id mismatch"],
    };
  }
  const mechanical = deriveMechanical(input);
  if (mechanical.status === "unverifiable") {
    return {
      ok: false,
      code: "unverifiable",
      message: "run is unverifiable and cannot be signed",
      issues: mechanical.issues,
    };
  }
  if (
    input.request.signed_verdict === "complete" &&
    mechanical.status !== "eligible"
  ) {
    return {
      ok: false,
      code: "not_eligible",
      message: "complete sign-off was requested for an ineligible run",
      issues: mechanical.issues,
    };
  }
  if (mechanical.head === null) {
    return {
      ok: false,
      code: "evidence_missing",
      message: "run has no evidence head to sign",
      issues: ["evidence head is missing"],
    };
  }
  if (input.request.evidence_head !== mechanical.head) {
    return {
      ok: false,
      code: "evidence_head_mismatch",
      message: "sign-off evidence head does not match the evidence chain",
      issues: ["evidence head mismatch"],
    };
  }
  const signOffs = eventForRun(input.events, input.runId, "verdict/sign_off");
  const latest = signOffs.at(-1);
  const expectedPrevious = latest?.data.sign_off_id ?? null;
  if (input.request.previous_sign_off_id !== expectedPrevious) {
    return {
      ok: false,
      code: "previous_sign_off_mismatch",
      message: "sign-off must reference the previous sign-off id",
      issues: ["previous_sign_off_id mismatch"],
    };
  }
  const bindingIssue = signOffBindingIssue(signOffs, mechanical.head);
  if (bindingIssue !== null) {
    return {
      ok: false,
      code: "sign_off_chain",
      message: bindingIssue,
      issues: [bindingIssue],
    };
  }
  const now = input.now ?? new Date();
  return {
    ok: true,
    prepared: {
      mechanical,
      data: {
        sign_off_id: createUlid(now),
        previous_sign_off_id: expectedPrevious,
        run_id: input.runId,
        evidence_head: mechanical.head,
        signed_verdict: input.request.signed_verdict,
        channel: input.request.channel,
        actor: input.request.actor,
        signed_at: now.toISOString(),
      },
    },
  };
}

export function deriveVerdict(input: VerdictInput): VerdictDerivation {
  const mechanical = deriveMechanical(input);
  const issues = [...mechanical.issues];
  const signOffs = eventForRun(input.events, input.runId, "verdict/sign_off");
  const latestSignOff = signOffs.at(-1);
  const bindingIssue = signOffBindingIssue(signOffs, mechanical.head);
  let verdict: VerdictValue;

  if (bindingIssue !== null) {
    issues.push(bindingIssue);
    verdict = "unverifiable";
  } else if (latestSignOff === undefined) {
    if (mechanical.status === "eligible") {
      issues.push("human sign-off is missing");
      verdict = "unverifiable";
    } else {
      verdict = mechanical.status;
    }
  } else if (latestSignOff.data.signed_verdict === "incomplete") {
    issues.push("human signed the run incomplete");
    verdict = "incomplete";
  } else if (mechanical.status === "eligible") {
    verdict = "complete";
  } else {
    if (mechanical.status === "incomplete") {
      issues.push("complete sign-off was requested for an ineligible run");
    }
    verdict = mechanical.status;
  }

  return {
    coverage: mechanical.coverage,
    issues,
    verdict: {
      version: 1,
      run_id: input.runId,
      session_id: input.sessionId,
      verdict,
      evidence_head: mechanical.head,
      sign_off_id: latestSignOff?.data.sign_off_id ?? null,
      signed_verdict: latestSignOff?.data.signed_verdict ?? null,
      coverage: mechanical.coverage,
      reasons: issues,
      computed_at: (input.now ?? new Date()).toISOString(),
      vcs: input.vcs ?? {
        commit: null,
        tree: null,
        base_commit: null,
      },
    },
  };
}
