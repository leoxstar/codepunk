import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { importCore, importProtocol } from "./support/core.mjs";

const core = await importCore();
const protocol = await importProtocol();

/**
 * A redirect is a fresh domain decision, never an inheritance of the first
 * hop's answer. The first half drives the guard directly; the second half
 * runs an in-process HTTP server so a real client follows the redirect and
 * the guard judges each hop in order.
 */

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

function collectingGuard(options) {
  const events = [];
  const guard = new core.NetworkGuard({
    runId: "run-redirect",
    ...options,
    onEvent: (kind, data) => {
      const validation = protocol.validateSchema(
        protocol.SessionEventSchema,
        eventFrame(kind, data),
      );
      assert.ok(validation.ok, `${kind}: ${JSON.stringify(validation)}`);
      events.push({ kind, data });
    },
  });
  return { guard, events };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("network redirect to a denied domain is refused, not inherited", async () => {
  const { guard, events } = collectingGuard({
    allow: ["allowed.example"],
    deny: ["denied.example"],
  });
  const decision = await guard.filterRequest(
    new Request("http://allowed.example/start"),
    { target: { host: "allowed.example", port: 80 }, scheme: "http" },
  );
  assert.equal(decision.action, "allow");
  decision.onResponse(302, {
    location: "http://denied.example/next",
    "content-length": "0",
  });
  await settle();
  const redirect = events.find((entry) => entry.kind === "network/redirect");
  assert.ok(redirect, "a redirect event was emitted");
  assert.deepEqual(redirect.data, {
    run_id: "run-redirect",
    from: "allowed.example",
    to: "denied.example",
    status: 302,
    decision: "deny",
  });
  const rejection = events.find((entry) => entry.kind === "network/rejected");
  assert.equal(rejection.data.domain, "denied.example");
  assert.equal(rejection.data.reason, "domain_denied");
  // The hop never reached the proxy, so nothing was counted for the target.
  assert.deepEqual(guard.usageFor("denied.example"), {
    requests: 0,
    bytes: 0,
  });
});

test("network redirect to a domain outside the allowlist is refused", async () => {
  const { guard, events } = collectingGuard({
    allow: ["allowed.example"],
  });
  const decision = await guard.filterRequest(
    new Request("http://allowed.example/start"),
    { target: { host: "allowed.example", port: 80 }, scheme: "http" },
  );
  decision.onResponse(301, {
    location: "https://other.example/next",
  });
  await settle();
  const redirect = events.find((entry) => entry.kind === "network/redirect");
  assert.equal(redirect.data.to, "other.example");
  assert.equal(redirect.data.status, 301);
  assert.equal(redirect.data.decision, "deny");
  assert.equal(
    events.find((entry) => entry.kind === "network/rejected").data.reason,
    "domain_not_allowed",
  );
});

test("network redirect to an allowed domain is recorded and allowed", async () => {
  const { guard, events } = collectingGuard({
    allow: ["allowed.example", "cdn.example"],
  });
  const decision = await guard.filterRequest(
    new Request("http://allowed.example/start"),
    { target: { host: "allowed.example", port: 80 }, scheme: "http" },
  );
  decision.onResponse(302, { location: "http://cdn.example/next" });
  await settle();
  const redirect = events.find((entry) => entry.kind === "network/redirect");
  assert.equal(redirect.data.decision, "allow");
  assert.equal(redirect.data.to, "cdn.example");
  assert.equal(
    events.some((entry) => entry.kind === "network/rejected"),
    false,
  );
});

test("network redirect to a budget-exhausted domain is refused", async () => {
  const { guard, events } = collectingGuard({
    allow: ["allowed.example", "other.example"],
    maxRequests: 1,
  });
  // Exhaust the redirect target's own budget before the redirect arrives.
  const first = await guard.filterRequest(
    new Request("http://other.example/"),
    { target: { host: "other.example", port: 80 }, scheme: "http" },
  );
  assert.equal(first.action, "allow");
  const hop = await guard.filterRequest(
    new Request("http://allowed.example/start"),
    { target: { host: "allowed.example", port: 80 }, scheme: "http" },
  );
  assert.equal(hop.action, "allow");
  hop.onResponse(302, { location: "http://other.example/next" });
  await settle();
  // The redirect event records the domain decision; the budget refusal is
  // the target's own next request, which the guard refuses before forwarding.
  const next = await guard.filterRequest(
    new Request("http://other.example/next"),
    { target: { host: "other.example", port: 80 }, scheme: "http" },
  );
  assert.equal(next.action, "deny");
  const rejection = events
    .filter((entry) => entry.kind === "network/rejected")
    .at(-1);
  assert.equal(rejection.data.domain, "other.example");
  assert.equal(rejection.data.reason, "max_requests");
});

test("network redirect keeps the same domain for a relative target", async () => {
  const { guard, events } = collectingGuard({
    allow: ["allowed.example"],
  });
  const decision = await guard.filterRequest(
    new Request("http://allowed.example/start"),
    { target: { host: "allowed.example", port: 80 }, scheme: "http" },
  );
  decision.onResponse(307, { location: "/moved" });
  await settle();
  const redirect = events.find((entry) => entry.kind === "network/redirect");
  assert.equal(redirect.data.from, "allowed.example");
  assert.equal(redirect.data.to, "allowed.example");
  assert.equal(redirect.data.status, 307);
  assert.equal(redirect.data.decision, "allow");
});

test("network redirect ignores a target the proxy cannot carry", async () => {
  const { guard, events } = collectingGuard({
    allow: ["allowed.example"],
  });
  const decision = await guard.filterRequest(
    new Request("http://allowed.example/start"),
    { target: { host: "allowed.example", port: 80 }, scheme: "http" },
  );
  decision.onResponse(302, { location: "file:///etc/passwd" });
  decision.onResponse(302, { location: "http://[invalid" });
  await settle();
  assert.equal(
    events.some((entry) => entry.kind === "network/redirect"),
    false,
  );
});

test("network redirect follows a real in-process server hop by hop", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/first") {
      res.writeHead(302, { location: "/second" });
      res.end();
      return;
    }
    if (req.url === "/second") {
      res.writeHead(302, { location: "/third" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-length": "2" });
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address.port;
  const { guard, events } = collectingGuard({
    allow: ["127.0.0.1"],
    maxRequests: 10,
  });
  try {
    // A small fetch shim that runs every hop through the guard, the way the
    // proxy does, so no public network is involved.
    let target = `http://127.0.0.1:${port}/first`;
    for (let hop = 0; hop < 5; hop += 1) {
      const url = new URL(target);
      const decision = await guard.filterRequest(new Request(target), {
        target: { host: url.hostname, port: Number(url.port) },
        scheme: "http",
      });
      assert.equal(decision.action, "allow");
      const response = await new Promise((resolve, reject) => {
        const req = http.get(target, (res) => {
          res.resume();
          res.on("end", () => resolve(res));
        });
        req.on("error", reject);
      });
      decision.onResponse(response.statusCode, response.headers);
      await settle();
      if (response.statusCode < 300 || response.statusCode > 399) {
        break;
      }
      target = new URL(response.headers.location, target).href;
    }
    assert.deepEqual(requests, ["/first", "/second", "/third"]);
    const redirects = events.filter(
      (entry) => entry.kind === "network/redirect",
    );
    assert.equal(redirects.length, 2);
    assert.deepEqual(
      redirects.map((entry) => entry.data.status),
      [302, 302],
    );
    assert.equal(guard.usageFor("127.0.0.1").requests, 3);
    assert.equal(guard.usageFor("127.0.0.1").bytes, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("network redirect refuses the second hop when the first was allowed", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(302, { location: "http://denied.example/blocked" });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const { guard, events } = collectingGuard({
    allow: ["127.0.0.1"],
  });
  try {
    const decision = await guard.filterRequest(
      new Request(`http://127.0.0.1:${port}/first`),
      { target: { host: "127.0.0.1", port }, scheme: "http" },
    );
    assert.equal(decision.action, "allow");
    const response = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/first`, (res) => {
        res.resume();
        res.on("end", () => resolve(res));
      });
      req.on("error", reject);
    });
    decision.onResponse(response.statusCode, response.headers);
    await settle();
    const redirect = events.find((entry) => entry.kind === "network/redirect");
    assert.equal(redirect.data.decision, "deny");
    assert.equal(redirect.data.to, "denied.example");
    const next = await guard.filterRequest(
      new Request("http://denied.example/blocked"),
      { target: { host: "denied.example", port: 80 }, scheme: "http" },
    );
    assert.equal(next.action, "deny");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
