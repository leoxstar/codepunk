import { createHash } from "node:crypto";

export const RUN_ID = "01J0RUN0000000000000000000";
export const SESSION_ID = "01J0SESSION000000000000000";
export const HASH_A = `sha256:${"a".repeat(64)}`;
export const HASH_B = `sha256:${"b".repeat(64)}`;
export const FIXED_TIME = "2026-11-12T00:00:00.000Z";

export function sha256Text(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

function normalize(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) {
      output[key] = normalize(value[key]);
    }
  }
  return output;
}

export function recordHash(value) {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

function policyLayers() {
  return [
    {
      layer: "user",
      source: "user",
      sha256: HASH_A,
      rule_sha256: HASH_B,
    },
  ];
}

export function readRecord(overrides = {}) {
  return {
    version: 1,
    id: "ev-read",
    seq: 1,
    prev_sha256: null,
    task_id: null,
    run_id: RUN_ID,
    session_id: SESSION_ID,
    source: "tool",
    tool: "read",
    tool_call_id: "call-read",
    decision: "allow",
    rule: "path.read.allow",
    rule_sha256: HASH_A,
    policy_layers: policyLayers(),
    approval: null,
    command: null,
    command_argv: null,
    cwd: "/workspace",
    workspace_root: "/workspace",
    path_check: { performed: true, target: "/workspace/a.txt" },
    sandbox: { backend: "none", version: null, profile_sha256: null },
    effects: { fs: "read", shell: false, network: false },
    coverage: "app-layer",
    coverage_basis: ["policy"],
    exit_code: null,
    duration_ms: 1,
    before_sha256: null,
    after_sha256: null,
    diff_sha256: null,
    output_ref: null,
    output_sha256: sha256Text("content"),
    output_preview: "content",
    empty_result: false,
    executor: null,
    vcs: { commit: null, tree: null, base_commit: null },
    memory: {
      ids: [],
      action: "none",
      query_sha256: null,
      cap: 0,
      truncated: false,
    },
    created_at: FIXED_TIME,
    ...overrides,
  };
}

export function writeRecord(overrides = {}) {
  return readRecord({
    id: "ev-write",
    tool: "write",
    tool_call_id: "call-write",
    rule: "path.write.allow",
    effects: { fs: "write", shell: false, network: false },
    before_sha256: sha256Text("before"),
    after_sha256: sha256Text("after"),
    diff_sha256: sha256Text("diff"),
    ...overrides,
  });
}

export function shellRecord(overrides = {}) {
  return readRecord({
    id: "ev-shell",
    tool: "user_bash",
    tool_call_id: "call-shell",
    source: "user_bash",
    rule: "shell.read.printf",
    command: "printf ok",
    cwd: "/workspace",
    path_check: { performed: false, target: null },
    sandbox: { backend: "srt", version: "0.0.82", profile_sha256: HASH_A },
    effects: { fs: "unknown", shell: true, network: true },
    coverage: "enforced",
    coverage_basis: ["srt"],
    exit_code: 0,
    output_sha256: sha256Text("ok"),
    output_preview: "ok",
    empty_result: null,
    executor: "srt",
    ...overrides,
  });
}

export function chainRecords(records) {
  let previous = null;
  return records.map((record, index) => {
    const chained = {
      ...record,
      id: record.id === undefined ? `ev-${index + 1}` : record.id,
      seq: index + 1,
      prev_sha256: previous,
    };
    previous = recordHash(chained);
    return chained;
  });
}

export function headOf(records) {
  const last = records.at(-1);
  return last === undefined ? null : recordHash(last);
}

export function runEndEvent({
  runId = RUN_ID,
  head,
  state = "settled",
  termination = null,
  seq = 1,
} = {}) {
  return {
    type: "codepunk/event",
    version: 1,
    seq,
    at: FIXED_TIME,
    kind: "run/end",
    data: {
      run_id: runId,
      state,
      termination,
      evidence_head: head,
      actor: "local-user",
    },
  };
}

export function signOffEvent({
  runId = RUN_ID,
  head,
  signOffId = "01J0SIGNOFF000000000000000",
  previousSignOffId = null,
  signedVerdict = "complete",
  channel = "cli",
  actor = "local-user",
  seq = 2,
} = {}) {
  return {
    type: "codepunk/event",
    version: 1,
    seq,
    at: FIXED_TIME,
    kind: "verdict/sign_off",
    data: {
      sign_off_id: signOffId,
      previous_sign_off_id: previousSignOffId,
      run_id: runId,
      evidence_head: head,
      signed_verdict: signedVerdict,
      channel,
      actor,
      signed_at: FIXED_TIME,
    },
  };
}

export function compactionEvent({
  runId = RUN_ID,
  reason = "manual",
  cancelled = true,
  entries = 0,
  head = null,
  seq = 2,
} = {}) {
  return {
    type: "codepunk/event",
    version: 1,
    seq,
    at: FIXED_TIME,
    kind: "compaction/decision",
    data: {
      run_id: runId,
      reason,
      cancelled,
      entries,
      keep_recent_tokens: 0,
      evidence_head: head,
      ...(cancelled
        ? {}
        : {
            checkpoint: {
              compaction_entry_id: "cmp-1",
              first_kept_entry_id: "entry-1",
              summary_sha256: head ?? "a".repeat(64),
              summary_bytes: 24,
              tokens_before: 12_000,
              messages_before: 6,
              messages_after: 2,
              model: "openai/chat-latest",
              loadout_sha256: null,
              tool_names: ["read", "write"],
            },
          }),
    },
  };
}

export function signOffRequest({
  runId = RUN_ID,
  head,
  signedVerdict = "complete",
  previousSignOffId = null,
  source = "human",
  isTty = true,
  channel = "cli",
  actor = "local-user",
} = {}) {
  return {
    version: 1,
    run_id: runId,
    evidence_head: head,
    signed_verdict: signedVerdict,
    channel,
    actor,
    is_tty: isTty,
    source,
    previous_sign_off_id: previousSignOffId,
  };
}
