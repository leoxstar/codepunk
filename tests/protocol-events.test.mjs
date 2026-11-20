import assert from "node:assert/strict";
import test from "node:test";
import { importProtocol } from "./support/core.mjs";

const protocol = await importProtocol();
const digest = `sha256:${"a".repeat(64)}`;
const timestamp = "2026-11-20T00:00:00.000Z";

function event(kind, data) {
  return {
    type: "codepunk/event",
    version: protocol.SESSION_EVENT_SCHEMA_VERSION,
    seq: 1,
    at: timestamp,
    kind,
    data,
  };
}

const goal = {
  goal_id: "goal-1",
  objective: "Ship the frozen protocol",
  status: "active",
  revision: 1,
  created_at: timestamp,
  updated_at: timestamp,
};

const review = {
  version: 1,
  review_id: "review-1",
  session_id: "session-1",
  run_id: "run-1",
  diff_sha256: digest,
  changed_paths: ["packages/core/src/index.ts"],
  findings: [
    {
      severity: "high",
      file: "packages/core/src/index.ts",
      line: 7,
      reason: "The failure path must not continue.",
    },
  ],
  created_at: timestamp,
};

const hook = {
  version: 1,
  hook_name: "policy-check",
  event: "before_tool",
  scope: "user",
  outcome: "passed",
  exit_code: 0,
  duration_ms: 12,
  stdout_sha256: digest,
  stderr_sha256: null,
  reason: null,
  recorded_at: timestamp,
};

const p0Events = [
  event("goal/update", {
    action: "set",
    previous_sha256: null,
    goal,
    event_sha256: digest,
  }),
  event("goal/error", {
    version: 1,
    code: "goal.corrupt",
    reason: "goal event hash is invalid",
    created_at: timestamp,
  }),
  event("review/result", review),
  event("review/error", {
    version: 1,
    session_id: "session-1",
    run_id: "run-1",
    reason: "diff could not be read",
    created_at: timestamp,
  }),
  event("hook/result", hook),
];

test("the capability event additions remain additive session-event version 1", () => {
  assert.equal(protocol.SESSION_EVENT_SCHEMA_VERSION, 1);
  for (const value of p0Events) {
    const validation = protocol.validateSchema(
      protocol.SessionEventSchema,
      value,
    );
    assert.equal(validation.ok, true, validation.ok ? "" : validation.issues);
  }

  const oldEvent = event("run/start", {
    run_id: "run-1",
    session_id: "session-1",
  });
  assert.equal(
    protocol.validateSchema(protocol.SessionEventSchema, oldEvent).ok,
    true,
  );
});

test("unknown kinds, future versions, and widened payloads fail validation", () => {
  const unknown = {
    ...event("future/event", { value: true }),
  };
  assert.equal(
    protocol.validateSchema(protocol.SessionEventSchema, unknown).ok,
    false,
  );

  const future = {
    ...p0Events[0],
    version: 2,
  };
  assert.equal(
    protocol.validateSchema(protocol.SessionEventSchema, future).ok,
    false,
  );

  const widened = structuredClone(p0Events[4]);
  widened.data.raw_output = "must not be persisted";
  assert.equal(
    protocol.validateSchema(protocol.SessionEventSchema, widened).ok,
    false,
  );

  const overlongReason = structuredClone(p0Events[4]);
  overlongReason.data.reason = "x".repeat(2_001);
  assert.equal(
    protocol.validateSchema(protocol.SessionEventSchema, overlongReason).ok,
    false,
  );

  const overlongName = structuredClone(p0Events[4]);
  overlongName.data.hook_name = "h".repeat(65);
  assert.equal(
    protocol.validateSchema(protocol.SessionEventSchema, overlongName).ok,
    false,
  );
});
