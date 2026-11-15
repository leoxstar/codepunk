import assert from "node:assert/strict";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import {
  chainRecords,
  compactionEvent,
  HASH_A,
  headOf,
  readRecord,
  RUN_ID,
  runEndEvent,
  shellRecord,
  signOffEvent,
  signOffRequest,
  SESSION_ID,
  writeRecord,
} from "./support/fixtures.mjs";

const core = await importCore();
const NOW = new Date("2026-11-12T01:00:00.000Z");

function derive(records, events, extra = {}) {
  return core.deriveVerdict({
    runId: RUN_ID,
    sessionId: SESSION_ID,
    records,
    events,
    now: NOW,
    ...extra,
  });
}

function cleanRun() {
  const records = chainRecords([readRecord()]);
  const head = headOf(records);
  return { records, head };
}

test("a clean run with a matching human sign-off is complete", () => {
  const { records, head } = cleanRun();
  const result = derive(records, [
    runEndEvent({ head }),
    signOffEvent({ head }),
  ]);
  assert.equal(result.verdict.verdict, "complete");
  assert.equal(result.verdict.evidence_head, head);
  assert.equal(result.verdict.sign_off_id, "01J0SIGNOFF000000000000000");
  assert.equal(result.verdict.signed_verdict, "complete");
  assert.deepEqual(result.issues, []);
});

test("a mechanically clean run without sign-off is unverifiable", () => {
  const { records, head } = cleanRun();
  const result = derive(records, [runEndEvent({ head })]);
  assert.equal(result.verdict.verdict, "unverifiable");
  assert.match(result.issues.join(" "), /sign-off is missing/u);
});

test("a denial is incomplete without requiring sign-off", () => {
  const records = chainRecords([
    writeRecord({
      decision: "deny",
      rule: "path.write.deny",
      before_sha256: null,
      after_sha256: null,
      diff_sha256: null,
      output_sha256: null,
    }),
  ]);
  const result = derive(records, [runEndEvent({ head: headOf(records) })]);
  assert.equal(result.verdict.verdict, "incomplete");
  assert.match(result.issues.join(" "), /was denied/u);
});

test("a nonzero shell exit is incomplete", () => {
  const records = chainRecords([
    shellRecord({ exit_code: 2, output_sha256: core.outputSha("failure") }),
  ]);
  const result = derive(records, [runEndEvent({ head: headOf(records) })]);
  assert.equal(result.verdict.verdict, "incomplete");
  assert.match(result.issues.join(" "), /exit code 2/u);
});

test("human cancellation is incomplete with human_cancel", () => {
  const { records, head } = cleanRun();
  const result = derive(records, [
    runEndEvent({
      head,
      state: "cancelled",
      termination: "human_cancel",
    }),
  ]);
  assert.equal(result.verdict.verdict, "incomplete");
  assert.match(result.issues.join(" "), /cancelled by the human/u);
});

test("a sign-off head mismatch is unverifiable", () => {
  const { records, head } = cleanRun();
  const result = derive(records, [
    runEndEvent({ head }),
    signOffEvent({ head: HASH_A }),
  ]);
  assert.equal(result.verdict.verdict, "unverifiable");
  assert.match(result.issues.join(" "), /evidence head/u);
});

test("prepareSignOff refuses complete on a denial", () => {
  const records = chainRecords([
    writeRecord({
      decision: "deny",
      rule: "path.write.deny",
      before_sha256: null,
      after_sha256: null,
      diff_sha256: null,
      output_sha256: null,
    }),
  ]);
  const head = headOf(records);
  const result = core.prepareSignOff({
    runId: RUN_ID,
    records,
    events: [runEndEvent({ head })],
    request: signOffRequest({ head }),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "not_eligible");
  assert.match(result.issues.join(" "), /denied/u);
});

test("a forged complete sign-off cannot upgrade a denial", () => {
  const records = chainRecords([
    writeRecord({
      decision: "deny",
      rule: "path.write.deny",
      before_sha256: null,
      after_sha256: null,
      diff_sha256: null,
      output_sha256: null,
    }),
  ]);
  const head = headOf(records);
  const result = derive(records, [
    runEndEvent({ head }),
    signOffEvent({ head }),
  ]);
  assert.equal(result.verdict.verdict, "incomplete");
  assert.match(result.issues.join(" "), /ineligible run/u);
});

test("a second sign-off without previous id is rejected", () => {
  const { records, head } = cleanRun();
  const events = [
    runEndEvent({ head }),
    signOffEvent({ head, signOffId: "first" }),
    signOffEvent({ head, signOffId: "second", previousSignOffId: null }),
  ];
  const derivation = derive(records, events);
  assert.equal(derivation.verdict.verdict, "unverifiable");
  assert.match(derivation.issues.join(" "), /previous_sign_off_id/u);

  const prepared = core.prepareSignOff({
    runId: RUN_ID,
    records,
    events,
    request: signOffRequest({
      head,
      signedVerdict: "incomplete",
      previousSignOffId: null,
    }),
    now: NOW,
  });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.code, "previous_sign_off_mismatch");
});

test("a valid second sign-off references the first and can downgrade", () => {
  const { records, head } = cleanRun();
  const first = signOffEvent({ head, signOffId: "first" });
  const events = [runEndEvent({ head }), first];
  const prepared = core.prepareSignOff({
    runId: RUN_ID,
    records,
    events,
    request: signOffRequest({
      head,
      signedVerdict: "incomplete",
      previousSignOffId: "first",
    }),
    now: NOW,
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.prepared.data.previous_sign_off_id, "first");
  const derivation = derive(records, [
    ...events,
    signOffEvent({
      head,
      signOffId: "second",
      previousSignOffId: "first",
      signedVerdict: "incomplete",
      seq: 3,
    }),
  ]);
  assert.equal(derivation.verdict.verdict, "incomplete");
  assert.equal(derivation.verdict.sign_off_id, "second");
});

test("tool, plugin, MCP, and non-TTY sign-offs are refused", () => {
  const { records, head } = cleanRun();
  const events = [runEndEvent({ head })];
  for (const [overrides, code] of [
    [{ source: "tool" }, "invalid_source"],
    [{ source: "plugin" }, "invalid_source"],
    [{ source: "mcp" }, "invalid_source"],
    [{ isTty: false }, "invalid_source"],
  ]) {
    const result = core.prepareSignOff({
      runId: RUN_ID,
      records,
      events,
      request: signOffRequest({ head, ...overrides }),
      now: NOW,
    });
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.equal(result.code, code);
  }
});

test("missing run/end, wrong run, and wrong head are refused", () => {
  const { records, head } = cleanRun();
  const missing = derive(records, []);
  assert.equal(missing.verdict.verdict, "unverifiable");
  assert.match(missing.issues.join(" "), /run\/end is missing/u);

  const wrongRun = core.prepareSignOff({
    runId: RUN_ID,
    records,
    events: [runEndEvent({ head })],
    request: signOffRequest({ runId: "another-run", head }),
    now: NOW,
  });
  assert.equal(wrongRun.ok, false);
  assert.equal(wrongRun.code, "run_mismatch");

  const wrongHead = core.prepareSignOff({
    runId: RUN_ID,
    records,
    events: [runEndEvent({ head })],
    request: signOffRequest({ head: HASH_A }),
    now: NOW,
  });
  assert.equal(wrongHead.ok, false);
  assert.equal(wrongHead.code, "evidence_head_mismatch");
});

test("malformed compaction, run-end head, and uncovered shell are unverifiable", () => {
  const { records, head } = cleanRun();
  const cancelledCompaction = derive(records, [
    runEndEvent({ head }),
    compactionEvent({ reason: "manual", cancelled: true, entries: 0 }),
  ]);
  assert.equal(cancelledCompaction.verdict.verdict, "unverifiable");
  assert.match(
    cancelledCompaction.issues.join(" "),
    /manual compaction was cancelled/u,
  );

  const missingCheckpointEvent = compactionEvent({
    reason: "manual",
    cancelled: false,
    entries: 1,
  });
  delete missingCheckpointEvent.data.checkpoint;
  const missingCheckpoint = derive(records, [
    runEndEvent({ head }),
    missingCheckpointEvent,
  ]);
  assert.equal(missingCheckpoint.verdict.verdict, "unverifiable");
  assert.match(
    missingCheckpoint.issues.join(" "),
    /no recoverable checkpoint/u,
  );

  const wrongHead = derive(records, [runEndEvent({ head: HASH_A })]);
  assert.equal(wrongHead.verdict.verdict, "unverifiable");
  assert.match(wrongHead.issues.join(" "), /run\/end evidence head/u);

  const uncovered = chainRecords([
    shellRecord({
      sandbox: { backend: "none", version: null, profile_sha256: null },
      coverage: "uncovered",
    }),
  ]);
  const uncoveredResult = derive(uncovered, [
    runEndEvent({ head: headOf(uncovered) }),
  ]);
  assert.equal(uncoveredResult.verdict.verdict, "unverifiable");
  assert.match(uncoveredResult.issues.join(" "), /uncovered/u);
});

test("prepareSignOff succeeds on a clean run and binds the head", () => {
  const { records, head } = cleanRun();
  const result = core.prepareSignOff({
    runId: RUN_ID,
    records,
    events: [runEndEvent({ head })],
    request: signOffRequest({ head }),
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.prepared.data.evidence_head, head);
  assert.equal(result.prepared.data.previous_sign_off_id, null);
  assert.equal(result.prepared.data.signed_verdict, "complete");
  assert.equal(result.prepared.mechanical.status, "eligible");
});
