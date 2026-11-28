import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import { makeProject, withTempDirectory } from "./support/helpers.mjs";
import { TEST_MODEL } from "./support/pi-model.mjs";

const core = await importCore();

const SAFE_COMMAND = process.platform === "win32" ? "robocopy" : "mkdir";

function makeSyntheticMcpTools(count) {
  const tools = [];
  for (let i = 1; i <= count; i += 1) {
    const domain = i % 2 === 0 ? "billing" : "tickets";
    const action = i === 7 ? "lookup_invoice_pdf" : `action_${i}`;
    tools.push({
      name: `mcp__${domain}__${action}`,
      label: `mcp:${domain}/${action}`,
      description:
        i === 7
          ? "Fetch invoice PDF and billing statement details for an account."
          : `Perform ${domain} workflow step ${i}.`,
      parameters: {
        type: "object",
        properties: {
          accountId: {
            type: "string",
            description: i === 7 ? "Customer billing account identifier" : "id",
          },
        },
        required: ["accountId"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        return {
          content: [{ type: "text", text: `ok:${params.accountId}` }],
          details: {},
        };
      },
    });
  }
  return tools;
}

test("small MCP tool sets stay direct without injecting tool_search", async () => {
  await withTempDirectory("codepunk-mcp-small-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    const ledger = await core.EvidenceLedger.open(
      path.join(root, "evidence.jsonl"),
    );
    const host = await core.createPiHost({
      cwd: projectRoot,
      workspaceRoot: projectRoot,
      deliveryRoot: projectRoot,
      codepunkHome: paths.home,
      sessionId: "small-mcp-session",
      runId: "small-mcp-run",
      writeSet: [projectRoot],
      approval: new core.ApprovalBroker(),
      ledger,
      model: TEST_MODEL,
      extraTools: makeSyntheticMcpTools(3),
    });
    try {
      const active = host.session.getActiveToolNames();
      assert.equal(active.includes("tool_search"), false);
      assert.equal(active.includes("mcp__tickets__action_1"), true);
      assert.equal(active.includes("mcp__billing__action_2"), true);
      host.validateToolRegistry();
    } finally {
      await host.dispose();
      await ledger.close?.();
    }
  });
});

test("large MCP tool sets (>8) defer schemas and activate matches via wrapped tool_search", async () => {
  await withTempDirectory("codepunk-mcp-lazy-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    const ledger = await core.EvidenceLedger.open(
      path.join(root, "evidence.jsonl"),
    );
    const mcpTools = makeSyntheticMcpTools(10);
    const host = await core.createPiHost({
      cwd: projectRoot,
      workspaceRoot: projectRoot,
      deliveryRoot: projectRoot,
      codepunkHome: paths.home,
      sessionId: "lazy-mcp-session",
      runId: "lazy-mcp-run",
      writeSet: [projectRoot],
      approval: new core.ApprovalBroker(),
      ledger,
      model: TEST_MODEL,
      extraTools: mcpTools,
    });
    try {
      const initialActive = host.session.getActiveToolNames();
      assert.equal(
        initialActive.includes("tool_search"),
        true,
        "tool_search must be active when MCP tools are deferred",
      );
      for (const tool of mcpTools) {
        assert.equal(
          initialActive.includes(tool.name),
          false,
          `${tool.name} must not bloat initial active tools`,
        );
      }
      const snapshot = host.validateToolRegistry();
      assert.equal(snapshot.registered.includes("tool_search"), true);
      assert.equal(
        snapshot.registered.includes("mcp__tickets__lookup_invoice_pdf"),
        true,
      );

      const searchDef = host.session.getToolDefinition("tool_search");
      assert.ok(searchDef, "wrapped tool_search definition is present");
      const result = await searchDef.execute(
        "call-search-1",
        { query: "invoice billing pdf", limit: 3 },
        undefined,
        undefined,
        {},
      );
      assert.equal(result.isError, undefined);
      assert.ok(
        result.details.loaded.includes("mcp__tickets__lookup_invoice_pdf"),
      );

      const afterActive = host.session.getActiveToolNames();
      assert.equal(
        afterActive.includes("mcp__tickets__lookup_invoice_pdf"),
        true,
        "matched deferred MCP tool becomes active for next turn",
      );
      assert.equal(
        ledger.all.some(
          (rec) =>
            rec.tool === "tool_search" &&
            rec.decision === "allow" &&
            rec.rule === "tool.search.allow",
        ),
        true,
        "tool_search execution is recorded in EvidenceLedger",
      );
    } finally {
      await host.dispose();
      await ledger.close?.();
    }
  });
});

test("controlled wildcard scoped rules authorize fixed-subcommand slots and reject dangerous flags or tampering", async () => {
  await withTempDirectory("codepunk-wildcard-scoped-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    const rulesPath = path.join(paths.home, "scoped-rules.toml");

    // Negative: bare executable + single wildcard without fixed subcommand/flag is rejected
    await assert.rejects(
      () =>
        core.persistScopedRule({
          paths,
          argv: [SAFE_COMMAND, "*"],
          cwd: projectRoot,
          filePath: rulesPath,
        }),
      /glob or pattern/u,
    );

    // Positive: single-slot wildcard with fixed flag + trailing rest wildcard
    const slotRule = await core.persistScopedRule({
      paths,
      argv: [SAFE_COMMAND, "-p", "*"],
      cwd: projectRoot,
      filePath: rulesPath,
    });
    assert.equal(slotRule.created, true);

    const restRule = await core.persistScopedRule({
      paths,
      argv: [SAFE_COMMAND, "sub", "**"],
      cwd: projectRoot,
      filePath: rulesPath,
    });
    assert.equal(restRule.created, true);

    const loaded = await core.loadScopedRules(rulesPath, paths);
    assert.equal(loaded.rules.length, 2);

    const controller = new core.AutonomyController({
      profile: "scoped",
      source: "cli",
      rules: loaded.rules,
      rulesSha256: loaded.rulesSha256,
    });

    // Matches single-slot wildcard for multiple safe targets
    const matchA = await controller.authorize({
      tool: "bash",
      command: `${SAFE_COMMAND} -p packages/core/dist`,
      cwd: projectRoot,
    });
    assert.equal(matchA?.id, slotRule.rule.id);

    const matchB = await controller.authorize({
      tool: "bash",
      command: `${SAFE_COMMAND} -p packages/cli/dist`,
      cwd: projectRoot,
    });
    assert.equal(matchB?.id, slotRule.rule.id);

    // Matches trailing ** for 0 or multiple safe trailing args
    const matchRest0 = await controller.authorize({
      tool: "bash",
      command: `${SAFE_COMMAND} sub`,
      cwd: projectRoot,
    });
    assert.equal(matchRest0?.id, restRule.rule.id);

    const matchRest2 = await controller.authorize({
      tool: "bash",
      command: `${SAFE_COMMAND} sub alpha beta`,
      cwd: projectRoot,
    });
    assert.equal(matchRest2?.id, restRule.rule.id);

    // Negative controls: dangerous flags (-rf, --force, --hard) or shell chaining NEVER match wildcard slots!
    for (const badCmd of [
      `${SAFE_COMMAND} -p -rf`,
      `${SAFE_COMMAND} -p --force`,
      `${SAFE_COMMAND} sub --hard`,
      `${SAFE_COMMAND} -p alpha && echo injected`,
      `${SAFE_COMMAND} other alpha`,
    ]) {
      const denied = await controller.authorize({
        tool: "bash",
        command: badCmd,
        cwd: projectRoot,
      });
      assert.equal(denied, null, `must reject ${badCmd}`);
    }
  });
});

test("permission insights suggest controlled wildcard rules across distinct once-approved commands", async () => {
  await withTempDirectory("codepunk-wildcard-insights-", async (root) => {
    const { projectRoot, paths } = await makeProject(root);
    const sessionDir = path.join(paths.evidenceDir, "sess-1");
    await fs.mkdir(sessionDir, { recursive: true });
    const ledger = await core.EvidenceLedger.open(
      path.join(sessionDir, "run-1.jsonl"),
    );
    const baseRecord = (id, cmd, argv) => ({
      task_id: null,
      run_id: "run-1",
      session_id: "sess-1",
      source: "tool",
      tool: "bash",
      tool_call_id: id,
      decision: "allow",
      outcome: "completed",
      rule: "policy.default",
      rule_sha256: core.sha256Text("rule"),
      policy_layers: [],
      approval: {
        channel: "tui",
        request_id: `req-${id}`,
        nonce_sha256: core.sha256Text(`nonce-${id}`),
        ttl_ms: 60_000,
        worker_id: "main",
        session_id: "sess-1",
        tool_call_id: id,
        answer: "allow",
        scope: "once",
      },
      approval_mode: "ask",
      command: cmd,
      command_argv: argv,
      cwd: projectRoot,
      workspace_root: projectRoot,
      path_check: { performed: false, target: null },
      sandbox: { backend: "none", version: null, profile_sha256: null },
      effects: { fs: "unknown", shell: true, network: true },
      coverage: "uncovered",
      coverage_basis: ["shell"],
      exit_code: 0,
      duration_ms: 5,
      before_sha256: null,
      after_sha256: null,
      diff_sha256: null,
      output_ref: null,
      output_sha256: core.sha256Text("ok"),
      output_preview: "ok",
      empty_result: false,
      executor: "direct",
      vcs: { commit: null, tree: null, base_commit: null },
      memory: {
        ids: [],
        action: "none",
        query_sha256: null,
        cap: 0,
        truncated: false,
      },
    });
    await ledger.append(
      baseRecord("c1", "pnpm --filter core test", [
        "pnpm",
        "--filter",
        "core",
        "test",
      ]),
    );
    await ledger.append(
      baseRecord("c2", "pnpm --filter cli test", [
        "pnpm",
        "--filter",
        "cli",
        "test",
      ]),
    );
    await ledger.close?.();

    const insights = await core.analyzePermissionInsights(paths);
    assert.ok(insights.suggested_wildcard_rules?.length >= 1);
    assert.deepEqual(insights.suggested_wildcard_rules[0].argv, [
      "pnpm",
      "--filter",
      "*",
      "test",
    ]);
    assert.match(
      core.formatPermissionInsights(insights),
      /pnpm --filter \* test/u,
    );
  });
});
