import assert from "node:assert/strict";
import test from "node:test";
import { importCore } from "./support/core.mjs";

const core = await importCore();

const HASH = `sha256:${"0".repeat(64)}`;

function askPolicy() {
  return {
    version: 1,
    decision: "ask",
    approval_class: "shell",
    rule: "policy.default",
    rule_sha256: HASH,
    reason: "shell command is not in a known safe class",
    layers: [],
    match: { tool: "bash", command: "touch probe.txt" },
    requires_approval: true,
  };
}

function scopedAutonomy(rule = null) {
  return {
    profile: "scoped",
    async authorize() {
      return rule;
    },
  };
}

test("scoped autonomy is an allowlist and never falls through to blanket approval", async () => {
  const policy = askPolicy();
  const unmatched = await core.resolvePermissionGate({
    policy,
    autonomy: scopedAutonomy(),
    approvalMode: "allow",
    tool: "bash",
    command: "touch probe.txt",
    cwd: "/workspace",
  });
  assert.equal(unmatched.decision, "ask");
  assert.equal(unmatched.consult_approval, true);
  assert.equal(unmatched.rule, "scoped.unmatched");

  const denied = await core.resolvePermissionGate({
    policy,
    autonomy: scopedAutonomy(),
    approvalMode: "deny",
    tool: "bash",
    command: "touch probe.txt",
    cwd: "/workspace",
  });
  assert.equal(denied.decision, "deny");
  assert.equal(denied.rule, "approval.denied");
});

test("a matching scoped rule allows the exact action", async () => {
  const rule = {
    id: "probe",
    argv: ["touch", "probe.txt"],
    cwd: "/workspace",
    executable_sha256: HASH,
    rule_sha256: HASH,
  };
  const gate = await core.resolvePermissionGate({
    policy: askPolicy(),
    autonomy: scopedAutonomy(rule),
    approvalMode: "allow",
    tool: "bash",
    command: "touch probe.txt",
    cwd: "/workspace",
  });
  assert.equal(gate.decision, "allow");
  assert.equal(gate.scoped_rule?.id, "probe");
  assert.equal(gate.consult_approval, false);
});

test("blanket approval applies only outside scoped autonomy", async () => {
  const gate = await core.resolvePermissionGate({
    policy: askPolicy(),
    autonomy: {
      profile: "ask",
      async authorize() {
        return null;
      },
    },
    approvalMode: "allow",
    tool: "bash",
    command: "touch probe.txt",
    cwd: "/workspace",
  });
  assert.equal(gate.decision, "allow");
  assert.equal(gate.consult_approval, false);
});

test("blanket approval keeps MCP at the human gate", async () => {
  const shell = core.effectiveApprovalDecision("ask", "allow", "shell");
  assert.equal(shell.decision, "allow");
  assert.equal(shell.requiresApproval, false);

  const mcp = core.effectiveApprovalDecision("ask", "allow", "mcp");
  assert.equal(mcp.decision, "ask");
  assert.equal(mcp.requiresApproval, true);

  const gate = await core.resolvePermissionGate({
    policy: {
      ...askPolicy(),
      approval_class: "mcp",
      match: { tool: "mcp__probe__run" },
    },
    autonomy: {
      profile: "ask",
      async authorize() {
        return null;
      },
    },
    approvalMode: "allow",
    tool: "mcp__probe__run",
    cwd: "/workspace",
  });
  assert.equal(gate.decision, "ask");
  assert.equal(gate.consult_approval, true);
});

test("switching to read-only refuses already-loaded plugins and MCP servers", () => {
  assert.equal(
    core.readOnlyLiveSwitchIssue({
      pluginsEnabled: false,
      mcpServers: [],
      sandboxStartedWritable: false,
    }),
    null,
  );
  assert.match(
    core.readOnlyLiveSwitchIssue({ pluginsEnabled: true, mcpServers: [] }),
    /user plugins/u,
  );
  const issue = core.readOnlyLiveSwitchIssue({
    pluginsEnabled: true,
    mcpServers: ["echo", "search"],
  });
  assert.match(issue, /user plugins/u);
  assert.match(issue, /MCP servers \(echo, search\)/u);
  assert.match(issue, /Restart with --permission-mode read-only --no-mcp/u);
  assert.match(issue, /Disable user plugins before restart/u);
  const sandbox = core.readOnlyLiveSwitchIssue({
    pluginsEnabled: false,
    mcpServers: [],
    sandboxStartedWritable: true,
  });
  assert.match(sandbox, /srt workspace write grants/u);
  assert.match(sandbox, /Restart with --permission-mode read-only/u);
  assert.equal(
    core.readOnlyLiveWidenIssue({
      target: "ask",
      sandboxStartedReadOnly: false,
    }),
    null,
  );
  const widen = core.readOnlyLiveWidenIssue({
    target: "scoped",
    sandboxStartedReadOnly: true,
  });
  assert.match(widen, /cannot switch from read-only to scoped/u);
  assert.match(widen, /allowWrite list stays empty/u);
  assert.match(widen, /Restart with --autonomy scoped/u);
});

test("permission behavior summary explains the effective mode", () => {
  const config = core.defaultConfig();
  assert.match(core.permissionBehaviorSummary(config), /ask prompts/u);
  config.autonomy.profile = "read-only";
  assert.match(
    core.permissionBehaviorSummary(config),
    /read-only denies file mutations and ask-level actions/u,
  );
  config.approval.mode = "auto";
  config.autonomy.profile = "ask";
  assert.match(
    core.permissionBehaviorSummary(config),
    /auto approves routine and ordinary shell classes/u,
  );
  config.approval.mode = "allow";
  assert.match(
    core.permissionBehaviorSummary(config),
    /allow approves every non-MCP ask/u,
  );
  assert.match(
    core.permissionBehaviorSummary(config),
    /network egress is deny-by-default/u,
  );
  config.filesystem.mode = "full";
  assert.match(
    core.permissionBehaviorSummary(config),
    /filesystem is full and needs the dangerous start flag/u,
  );
});
