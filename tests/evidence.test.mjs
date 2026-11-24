import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importCore, importProtocol } from "./support/core.mjs";
import {
  chainRecords,
  HASH_A,
  headOf,
  readRecord,
  RUN_ID,
  runEndEvent,
  shellRecord,
  writeRecord,
} from "./support/fixtures.mjs";

const core = await importCore();
const protocol = await importProtocol();

async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codepunk-evidence-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("protocol versions must be positive and no newer than this build", () => {
  for (const kind of ["evidence", "session-event", "agent-state", "verdict"]) {
    assert.doesNotThrow(() => protocol.assertSupportedVersion(kind, 1));
    for (const version of [0, -1]) {
      assert.throws(
        () => protocol.assertSupportedVersion(kind, version),
        (error) =>
          error instanceof protocol.ProtocolError &&
          /is not a positive schema version/u.test(error.message),
        `${kind} accepted version ${version}`,
      );
    }
    assert.throws(
      () => protocol.assertSupportedVersion(kind, 2),
      /is newer than supported version/u,
    );
  }
});

test("the ledger appends a verifiable hash chain", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, "run.jsonl");
    const ledger = await core.EvidenceLedger.open(filePath);
    const first = await ledger.append(readRecord());
    const second = await ledger.append(writeRecord({ output_sha256: null }));
    assert.equal(first.seq, 1);
    assert.equal(first.prev_sha256, null);
    assert.equal(second.seq, 2);
    assert.equal(second.prev_sha256, core.evidenceRecordHash(first));
    assert.equal(ledger.head, core.evidenceRecordHash(second));

    const reopened = await core.readEvidenceFile(filePath);
    assert.equal(reopened.records.length, 2);
    assert.equal(reopened.truncatedTail, false);
    assert.equal(reopened.head, ledger.head);
    assert.ok((await readFile(filePath, "utf8")).endsWith("\n"));
  });
});

test("concurrent appends keep one contiguous chain", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, "run.jsonl");
    const ledger = await core.EvidenceLedger.open(filePath);
    const appended = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        ledger.append(
          readRecord({
            id: `ev-concurrent-${index}`,
            tool_call_id: `call-concurrent-${index}`,
          }),
        ),
      ),
    );
    assert.deepEqual(
      appended.map((record) => record.seq),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    for (let index = 1; index < appended.length; index += 1) {
      assert.equal(
        appended[index].prev_sha256,
        core.evidenceRecordHash(appended[index - 1]),
      );
    }
    const reopened = await core.readEvidenceFile(filePath);
    assert.equal(reopened.records.length, 8);
    assert.equal(reopened.head, ledger.head);
  });
});

test("editing a middle record breaks the chain", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, "run.jsonl");
    const ledger = await core.EvidenceLedger.open(filePath);
    await ledger.append(readRecord());
    await ledger.append(writeRecord({ output_sha256: null }));
    await ledger.append(shellRecord());

    const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
    const first = JSON.parse(lines[0]);
    first.output_preview = "tampered";
    lines[0] = JSON.stringify(first);
    await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");

    await assert.rejects(
      () => core.readEvidenceFile(filePath),
      /prev_sha256 mismatch/u,
    );
  });
});

test("a truncated final line is ignored and append is refused", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, "run.jsonl");
    const record = chainRecords([readRecord()])[0];
    await writeFile(
      filePath,
      `${JSON.stringify(record)}\n{"truncated":`,
      "utf8",
    );
    const loaded = await core.readEvidenceFile(filePath);
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.truncatedTail, true);
    assert.equal(loaded.head, core.evidenceRecordHash(record));

    const ledger = await core.EvidenceLedger.open(filePath);
    await assert.rejects(
      () => ledger.append(writeRecord({ output_sha256: null })),
      /truncated tail/u,
    );
  });
});

test("a complete malformed line is not treated as truncation", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, "run.jsonl");
    await writeFile(filePath, '{"not":"a record"}\n', "utf8");
    await assert.rejects(
      () => core.readEvidenceFile(filePath),
      /evidence record at line 1 version is missing/u,
    );
  });
});

test("a chain with a missing prefix is rejected", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, "run.jsonl");
    const record = {
      ...chainRecords([readRecord()])[0],
      seq: 3,
      prev_sha256: null,
    };
    await writeFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
    await assert.rejects(
      () => core.readEvidenceFile(filePath),
      /does not start at sequence 1/u,
    );
  });
});

test("class-specific fields are required", () => {
  const validRead = core.validateEvidenceForClass(readRecord());
  assert.equal(validRead.ok, true);

  for (const [record, expected] of [
    [readRecord({ empty_result: null }), /empty_result/u],
    [readRecord({ output_sha256: null }), /output hash/u],
    [writeRecord({ output_sha256: null, diff_sha256: null }), /diff_sha256/u],
    [shellRecord({ executor: null }), /executor/u],
    [shellRecord({ output_sha256: null }), /output_sha256/u],
    [readRecord({ policy_layers: [] }), /policy_layers/u],
    [
      readRecord({
        tool: "memory_search",
        decision: "allow",
        memory: {
          ids: [],
          action: "read",
          query_sha256: null,
          cap: 8,
          truncated: false,
        },
      }),
      /query_sha256/u,
    ],
    [
      readRecord({
        tool: "memory_search",
        decision: "allow",
        memory: {
          ids: [],
          action: "none",
          query_sha256: "sha256:test",
          cap: 8,
          truncated: false,
        },
      }),
      /memory_search action/u,
    ],
  ]) {
    const check = core.validateEvidenceForClass(record);
    assert.equal(check.ok, false, expected.source);
    assert.match(check.issues.join(" "), expected);
  }
});

test("reviewer evidence is bound to its rule and decision", () => {
  const review = (decision) => ({
    kind: "model",
    provider: "fake",
    model: "reviewer",
    decision,
    reason: "review reason",
    action_sha256: HASH_A,
    latency_ms: 1,
  });
  const allow = readRecord({
    rule: "reviewer.model.allow",
    reviewer: review("allow"),
  });
  assert.equal(core.validateEvidenceForClass(allow).ok, true);

  const missing = readRecord({ rule: "reviewer.model.allow" });
  assert.match(
    core.validateEvidenceForClass(missing).issues.join(" "),
    /reviewer evidence/u,
  );

  const mismatched = readRecord({
    rule: "reviewer.model.allow",
    reviewer: review("deny"),
  });
  assert.match(
    core.validateEvidenceForClass(mismatched).issues.join(" "),
    /different reviewer decision/u,
  );

  const abstained = readRecord({
    decision: "deny",
    rule: "reviewer.abstained",
    reviewer: review("abstain"),
  });
  assert.equal(core.validateEvidenceForClass(abstained).ok, true);
  const abstainedAllow = readRecord({
    rule: "reviewer.abstained",
    reviewer: review("abstain"),
  });
  assert.match(
    core.validateEvidenceForClass(abstainedAllow).issues.join(" "),
    /does not have a deny decision/u,
  );

  const forgedAllow = readRecord({
    rule: "path.read.allow",
    reviewer: review("allow"),
  });
  assert.match(
    core.validateEvidenceForClass(forgedAllow).issues.join(" "),
    /not bound/u,
  );
});

test("invalid arguments have their own denial evidence shape", () => {
  const invalid = readRecord({
    decision: "deny",
    rule: "tool.invalid_arguments",
    policy_layers: [],
    path_check: { performed: false, target: null },
    coverage: "uncovered",
    coverage_basis: ["arguments"],
    empty_result: null,
  });
  assert.equal(core.validateEvidenceForClass(invalid).ok, true);

  const missingHash = { ...invalid, output_sha256: null };
  const check = core.validateEvidenceForClass(missingHash);
  assert.equal(check.ok, false);
  assert.match(check.issues.join(" "), /output_sha256/u);
});

test("an empty read records an explicit empty_result", () => {
  const valid = core.validateEvidenceForClass(
    readRecord({
      output_sha256: core.outputSha(""),
      output_preview: "",
      empty_result: true,
    }),
  );
  assert.equal(valid.ok, true);
});

test("a missing class field makes the run unverifiable", () => {
  const records = chainRecords([readRecord({ empty_result: null })]);
  const derivation = core.deriveVerdict({
    runId: RUN_ID,
    sessionId: "session",
    records,
    events: [runEndEvent({ head: headOf(records) })],
  });
  assert.equal(derivation.verdict.verdict, "unverifiable");
  assert.match(derivation.issues.join(" "), /empty_result/u);
});

test("truncated evidence makes the run unverifiable", () => {
  const records = chainRecords([readRecord()]);
  const derivation = core.deriveVerdict({
    runId: RUN_ID,
    sessionId: "session",
    records,
    events: [runEndEvent({ head: headOf(records) })],
    truncatedTail: true,
  });
  assert.equal(derivation.verdict.verdict, "unverifiable");
  assert.match(derivation.issues.join(" "), /truncated/u);
});

test("output and record hashes are canonical", () => {
  assert.equal(core.outputSha("hello"), core.outputSha("hello"));
  assert.notEqual(core.outputSha("hello"), core.outputSha("world"));
  assert.equal(
    core.recordHash({ b: 2, a: 1 }),
    core.recordHash({ a: 1, b: 2 }),
  );
});
