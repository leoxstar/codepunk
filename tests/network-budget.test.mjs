import assert from "node:assert/strict";
import test from "node:test";
import { importCore, importProtocol } from "./support/core.mjs";

const core = await importCore();
const protocol = await importProtocol();

/**
 * These tests drive the guard directly, without a proxy or a public network.
 * Every emitted event is also checked against the session schema so a shape
 * drift fails here instead of at append time.
 */

function requestFor(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  return new Request(url, {
    method: options.method ?? "GET",
    headers,
  });
}

function eventFrame(kind, data) {
  return {
    type: "codepunk/event",
    version: 1,
    seq: 1,
    at: "2026-11-18T00:00:00.000Z",
    kind,
    data,
  };
}

function assertSchema(kind, data) {
  const validation = protocol.validateSchema(
    protocol.SessionEventSchema,
    eventFrame(kind, data),
  );
  assert.ok(
    validation.ok,
    `${kind} failed schema: ${JSON.stringify(validation)}`,
  );
}

function collectingGuard(options) {
  const events = [];
  const guard = new core.NetworkGuard({
    runId: "run-1",
    ...options,
    onEvent: (kind, data) => {
      assertSchema(kind, data);
      events.push({ kind, data });
    },
  });
  return { guard, events };
}

test("network allowlist allows a domain and counts requests and bytes", async () => {
  const { guard, events } = collectingGuard({
    allow: ["allowed.example"],
  });
  const decision = await guard.filterRequest(
    requestFor("http://allowed.example/resource"),
    { target: { host: "allowed.example", port: 80 }, scheme: "http" },
  );
  assert.equal(decision.action, "allow");
  decision.onResponse(200, { "content-length": "128" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(guard.usageFor("allowed.example"), {
    requests: 1,
    bytes: 128,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "network/request");
  assert.deepEqual(events[0].data, {
    run_id: "run-1",
    domain: "allowed.example",
    requests: 1,
    bytes: 0,
    limit: { max_requests: null, max_bytes: null },
    decision: "allow",
  });
});

test("network allowlist denies a domain that is not on the list", async () => {
  const { guard, events } = collectingGuard({
    allow: ["allowed.example"],
  });
  const decision = await guard.filterRequest(
    requestFor("http://denied.example/"),
    { target: { host: "denied.example", port: 80 }, scheme: "http" },
  );
  assert.equal(decision.action, "deny");
  assert.equal(decision.status, 403);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((entry) => entry.kind),
    ["network/request", "network/rejected"],
  );
  assert.equal(events[0].data.decision, "deny");
  assert.equal(events[0].data.requests, 0);
  assert.equal(events[1].data.domain, "denied.example");
  assert.equal(events[1].data.reason, "domain_not_allowed");
  // A refused request was never forwarded, so it is not counted.
  assert.deepEqual(guard.usageFor("denied.example"), {
    requests: 0,
    bytes: 0,
  });
});

test("network deny list wins over a wildcard allow", async () => {
  const { guard, events } = collectingGuard({
    allow: ["*.example.com"],
    deny: ["evil.example.com"],
  });
  const allowed = await guard.filterRequest(
    requestFor("http://api.example.com/"),
    { target: { host: "api.example.com", port: 80 }, scheme: "http" },
  );
  assert.equal(allowed.action, "allow");
  const denied = await guard.filterRequest(
    requestFor("http://evil.example.com/"),
    { target: { host: "evil.example.com", port: 80 }, scheme: "http" },
  );
  assert.equal(denied.action, "deny");
  const rejection = events.find((entry) => entry.kind === "network/rejected");
  assert.equal(rejection.data.reason, "domain_denied");
  assert.equal(rejection.data.domain, "evil.example.com");
});

test("network budget rejects the request that would exceed the request limit", async () => {
  const { guard, events } = collectingGuard({
    allow: ["allowed.example"],
    maxRequests: 2,
  });
  for (let index = 0; index < 2; index += 1) {
    const decision = await guard.filterRequest(
      requestFor("http://allowed.example/"),
      { target: { host: "allowed.example", port: 80 }, scheme: "http" },
    );
    assert.equal(decision.action, "allow", `request ${index + 1}`);
  }
  const third = await guard.filterRequest(
    requestFor("http://allowed.example/"),
    { target: { host: "allowed.example", port: 80 }, scheme: "http" },
  );
  assert.equal(third.action, "deny");
  assert.deepEqual(guard.usageFor("allowed.example"), {
    requests: 2,
    bytes: 0,
  });
  const rejection = events.find((entry) => entry.kind === "network/rejected");
  assert.equal(rejection.data.reason, "max_requests");
  assert.deepEqual(rejection.data.limit, {
    max_requests: 2,
    max_bytes: null,
  });
});

test("network budget is per domain, not shared across domains", async () => {
  const { guard } = collectingGuard({
    allow: ["a.example", "b.example"],
    maxRequests: 1,
  });
  for (const host of ["a.example", "b.example"]) {
    const decision = await guard.filterRequest(requestFor(`http://${host}/`), {
      target: { host, port: 80 },
      scheme: "http",
    });
    assert.equal(decision.action, "allow", host);
  }
});

test("network budget counts request body bytes toward the byte limit", async () => {
  const { guard, events } = collectingGuard({
    allow: ["allowed.example"],
    maxBytes: 100,
  });
  const first = await guard.filterRequest(
    requestFor("http://allowed.example/upload", {
      method: "POST",
      headers: { "content-length": "60" },
    }),
    { target: { host: "allowed.example", port: 80 }, scheme: "http" },
  );
  assert.equal(first.action, "allow");
  assert.deepEqual(guard.usageFor("allowed.example"), {
    requests: 1,
    bytes: 60,
  });
  const second = await guard.filterRequest(
    requestFor("http://allowed.example/upload", {
      method: "POST",
      headers: { "content-length": "60" },
    }),
    { target: { host: "allowed.example", port: 80 }, scheme: "http" },
  );
  assert.equal(second.action, "deny");
  const rejection = events.find((entry) => entry.kind === "network/rejected");
  assert.equal(rejection.data.reason, "max_bytes");
  assert.equal(rejection.data.limit.max_bytes, 100);
});

test("network budget counts response content-length toward the byte limit", async () => {
  const { guard } = collectingGuard({
    allow: ["allowed.example"],
    maxBytes: 150,
  });
  const first = await guard.filterRequest(
    requestFor("http://allowed.example/"),
    { target: { host: "allowed.example", port: 80 }, scheme: "http" },
  );
  first.onResponse(200, { "content-length": "120" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(guard.usageFor("allowed.example"), {
    requests: 1,
    bytes: 120,
  });
  const second = await guard.filterRequest(
    requestFor("http://allowed.example/"),
    { target: { host: "allowed.example", port: 80 }, scheme: "http" },
  );
  assert.equal(second.action, "allow");
  // The third request is refused: the response bytes of the second hop have
  // not been observed yet, but the next response would exceed the budget.
  second.onResponse(200, { "content-length": "120" });
  await new Promise((resolve) => setImmediate(resolve));
  const third = await guard.filterRequest(
    requestFor("http://allowed.example/"),
    { target: { host: "allowed.example", port: 80 }, scheme: "http" },
  );
  assert.equal(third.action, "deny");
});

test("network budget of zero refuses the first request", async () => {
  const { guard, events } = collectingGuard({
    allow: ["allowed.example"],
    maxRequests: 0,
  });
  const decision = await guard.filterRequest(
    requestFor("http://allowed.example/"),
    { target: { host: "allowed.example", port: 80 }, scheme: "http" },
  );
  assert.equal(decision.action, "deny");
  assert.equal(
    events.find((entry) => entry.kind === "network/rejected").data.reason,
    "max_requests",
  );
});

test("network budget is unset by default and unlimited with null", async () => {
  const { guard } = collectingGuard({
    allow: ["allowed.example"],
    maxRequests: null,
    maxBytes: null,
  });
  for (let index = 0; index < 5; index += 1) {
    const decision = await guard.filterRequest(
      requestFor("http://allowed.example/"),
      { target: { host: "allowed.example", port: 80 }, scheme: "http" },
    );
    assert.equal(decision.action, "allow");
  }
  assert.equal(guard.usageFor("allowed.example").requests, 5);
});

test("network guard matches the runtime's host canonicalization and ports", async () => {
  assert.equal(
    core.canonicalNetworkHost("Allowed.Example."),
    "allowed.example",
  );
  assert.equal(core.canonicalNetworkHost("127.1"), "127.0.0.1");
  assert.equal(core.canonicalNetworkHost("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(core.canonicalNetworkHost("::1"), "::1");
  assert.equal(core.canonicalNetworkHost("bad host"), null);

  const { guard } = collectingGuard({
    allow: ["allowed.example:8080"],
  });
  const onPort = await guard.filterRequest(
    requestFor("http://allowed.example:8080/"),
    { target: { host: "allowed.example", port: 8080 }, scheme: "http" },
  );
  assert.equal(onPort.action, "allow");
  const offPort = await guard.filterRequest(
    requestFor("http://allowed.example/"),
    { target: { host: "allowed.example", port: 80 }, scheme: "http" },
  );
  assert.equal(offPort.action, "deny");
  // A wildcard admits strict subdomains, never the base or an IP literal.
  const { guard: wildcard } = collectingGuard({ allow: ["*.example.com"] });
  const base = await wildcard.filterRequest(requestFor("http://example.com/"), {
    target: { host: "example.com", port: 80 },
    scheme: "http",
  });
  assert.equal(base.action, "deny");
});
