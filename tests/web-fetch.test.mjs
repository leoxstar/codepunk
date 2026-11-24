import assert from "node:assert/strict";
import test from "node:test";
import { importCore } from "./support/core.mjs";

const core = await importCore();

function request(overrides = {}) {
  return {
    tool: "read",
    args: { path: "src/a.ts" },
    cwd: "/workspace",
    workspaceRoot: "/workspace",
    deliveryRoot: "/workspace",
    codepunkHome: "/home",
    ...overrides,
  };
}

test("web_fetch is registered with an external execution policy", () => {
  assert.ok(core.CODEPUNK_TOOL_NAMES.includes("web_fetch"));
  const policy = core.toolExecutionPolicy("web_fetch");
  assert.equal(policy.sideEffect, "external");
  assert.equal(policy.resultBudgetBytes, 256 * 1_024);
});

test("web_fetch policy decision is ask with the network approval class", () => {
  const decision = core.decidePolicy(request({ tool: "web_fetch" }));
  assert.equal(decision.decision, "ask");
  assert.equal(decision.approval_class, "network");
  assert.equal(decision.rule, "web.fetch.ask");
  assert.equal(decision.match.tool, "web_fetch");
});

test("web_fetch coverage is app-layer and survives an absent sandbox", () => {
  assert.equal(core.coverageFor("web_fetch", null), "app-layer");
});

test("web_fetch is enabled in the default config", () => {
  const config = core.defaultConfig();
  assert.ok(config.tools.enabled.includes("web_fetch"));
});

test("web_fetch refuses missing, non-http, private, and denied targets", async () => {
  const tool = core.createWebFetchTool();
  for (const input of [
    { url: "" },
    { url: "not-a-url" },
    { url: "ftp://example.com/file" },
    { url: "file:///etc/passwd" },
    { url: "http://127.0.0.1:8080/x" },
    { url: "http://localhost/x" },
    { url: "https://10.0.0.5/internal" },
    { url: "https://192.168.1.1/internal" },
    { url: "https://[::1]/internal" },
  ]) {
    const result = await tool.execute("call-refuse", input);
    assert.equal(result.isError, true, `expected refusal for ${input.url}`);
    assert.match(
      result.content[0].text,
      /(absolute http\(s\)|private, loopback|network_deny)/u,
    );
  }

  const denied = core.createWebFetchTool({
    deniedDomains: ["example.com:443"],
  });
  const deniedResult = await denied.execute("call-deny", {
    url: "https://example.com/page",
  });
  assert.equal(deniedResult.isError, true);
  assert.match(deniedResult.content[0].text, /network_deny/u);

  const allowed = core.createWebFetchTool({
    deniedDomains: ["example.com:443"],
  });
  assert.equal(typeof allowed.execute, "function");
});
