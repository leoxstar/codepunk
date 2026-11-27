import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore, importSource } from "./support/core.mjs";
import { withTempDirectory } from "./support/helpers.mjs";

const core = await importCore();
const { parseCli } = await importSource("packages/cli/src/args/parse.ts");

test("json-schema validator enforces types, required fields, additionalProperties, enums, and fenced JSON", async () => {
  await withTempDirectory("codepunk-json-schema-", async (dir) => {
    const schema = {
      type: "object",
      required: ["summary", "findings"],
      additionalProperties: false,
      properties: {
        summary: { type: "string", minLength: 3 },
        findings: {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            required: ["severity", "line"],
            additionalProperties: false,
            properties: {
              severity: { type: "string", enum: ["low", "high"] },
              line: { type: "integer", minimum: 1 },
            },
          },
        },
      },
    };
    const schemaPath = path.join(dir, "review.schema.json");
    await fs.writeFile(schemaPath, JSON.stringify(schema), "utf8");

    const loadedFile = await core.loadJsonOutputSchema(
      "review.schema.json",
      dir,
    );
    assert.deepEqual(loadedFile, schema);
    const loadedInline = await core.loadJsonOutputSchema(
      JSON.stringify(schema),
      dir,
    );
    assert.deepEqual(loadedInline, schema);

    await assert.rejects(
      () => core.loadJsonOutputSchema("[]", dir),
      /root must be a JSON object/u,
    );

    const fencedReply = [
      "```json",
      JSON.stringify(
        {
          summary: "Clean patch",
          findings: [{ severity: "high", line: 42 }],
        },
        null,
        2,
      ),
      "```",
    ].join("\n");
    const valid = core.validateAssistantTextAgainstSchema(fencedReply, schema);
    assert.equal(valid.ok, true);
    assert.equal(
      valid.canonicalJson,
      '{"summary":"Clean patch","findings":[{"severity":"high","line":42}]}',
    );

    const invalid = core.validateAssistantTextAgainstSchema(
      JSON.stringify({
        summary: "ok",
        extra: true,
        findings: [{ severity: "critical", line: 0 }],
      }),
      schema,
    );
    assert.equal(invalid.ok, false);
    const paths = invalid.issues.map((issue) => issue.path);
    assert.ok(paths.includes("$.summary"));
    assert.ok(paths.includes("$.extra"));
    assert.ok(paths.includes("$.findings[0].severity"));
    assert.ok(paths.includes("$.findings[0].line"));
  });
});

test("attestSession and analyzePermissionInsights summarize verified evidence, sign-offs, repeated once approvals, and denials without leaking home paths", async () => {
  await withTempDirectory("codepunk-attest-", async (root) => {
    const workspace = path.join(root, "repo");
    const home = path.join(root, "cp-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(home, { recursive: true });

    const delivery = {
      cwd: workspace,
      deliveryRoot: workspace,
      projectId: "proj-attest-test",
      isGitRepository: false,
    };
    const paths = core.projectPaths(delivery, home);
    const store = await core.SessionStore.create({
      rootDir: paths.home,
      cwd: workspace,
      projectRoot: paths.deliveryRoot,
      projectId: paths.projectId,
    });
    const writer = await store.acquireWriter();
    const fakeToken = ["Bearer", "demoTokenValue123456"].join(" ");
    await store.writeMeta({
      title: `Verify auth ${fakeToken}`,
    });

    const runDir = path.join(paths.evidenceDir, store.sessionId);
    await fs.mkdir(runDir, { recursive: true });
    const evidencePath = path.join(runDir, "run-attest-1.jsonl");
    const ledger = await core.EvidenceLedger.open(evidencePath);

    const baseLayer = [
      {
        layer: "user",
        source: "user",
        sha256: `sha256:${"1".repeat(64)}`,
        rule_sha256: `sha256:${"2".repeat(64)}`,
      },
    ];
    const srtSandbox = {
      backend: "srt",
      version: "0.0.82",
      profile_sha256: `sha256:${"3".repeat(64)}`,
    };
    const noneSandbox = {
      backend: "none",
      version: null,
      profile_sha256: null,
    };

    // Two identical 'once' bash approvals -> should surface in permission insights.
    for (let idx = 1; idx <= 2; idx += 1) {
      await ledger.append({
        task_id: null,
        run_id: "run-attest-1",
        session_id: store.sessionId,
        source: "tool",
        tool: "bash",
        tool_call_id: `tc-bash-${idx}`,
        decision: "allow",
        outcome: "completed",
        rule: "shell.workspace",
        rule_sha256: `sha256:${"4".repeat(64)}`,
        policy_layers: baseLayer,
        approval: {
          channel: "tui",
          request_id: `req-${idx}`,
          nonce_sha256: `sha256:${"5".repeat(64)}`,
          ttl_ms: 60_000,
          worker_id: "local",
          session_id: store.sessionId,
          tool_call_id: `tc-bash-${idx}`,
          answer: "allow",
          scope: "once",
        },
        approval_mode: "ask",
        command: "pnpm test",
        command_argv: ["pnpm", "test"],
        cwd: workspace,
        workspace_root: workspace,
        path_check: { performed: false, target: null },
        sandbox: srtSandbox,
        effects: { fs: "write", shell: true, network: false },
        coverage: "enforced",
        coverage_basis: ["policy", "srt"],
        exit_code: 0,
        duration_ms: 120,
        before_sha256: null,
        after_sha256: null,
        diff_sha256: null,
        output_ref: null,
        output_sha256: core.outputSha("ok\n"),
        output_preview: "ok\n",
        empty_result: null,
        executor: "srt",
        vcs: { commit: null, tree: null, base_commit: null },
        memory: {
          ids: [],
          action: "none",
          query_sha256: null,
          cap: 0,
          truncated: false,
        },
      });
    }

    // File write record.
    await ledger.append({
      task_id: null,
      run_id: "run-attest-1",
      session_id: store.sessionId,
      source: "tool",
      tool: "write",
      tool_call_id: "tc-write-1",
      decision: "allow",
      outcome: "completed",
      rule: "fs.write.workspace",
      rule_sha256: `sha256:${"6".repeat(64)}`,
      policy_layers: baseLayer,
      approval: null,
      approval_mode: "auto",
      command: null,
      command_argv: null,
      cwd: workspace,
      workspace_root: workspace,
      path_check: {
        performed: true,
        target: path.join(workspace, "src", "auth.ts"),
      },
      sandbox: noneSandbox,
      effects: { fs: "write", shell: false, network: false },
      coverage: "app-layer",
      coverage_basis: ["policy"],
      exit_code: null,
      duration_ms: 5,
      before_sha256: `sha256:${"a".repeat(64)}`,
      after_sha256: `sha256:${"b".repeat(64)}`,
      diff_sha256: `sha256:${"c".repeat(64)}`,
      output_ref: null,
      output_sha256: core.outputSha("wrote"),
      output_preview: "wrote",
      empty_result: null,
      executor: null,
      vcs: { commit: null, tree: null, base_commit: null },
      memory: {
        ids: [],
        action: "none",
        query_sha256: null,
        cap: 0,
        truncated: false,
      },
    });

    // Denied action record.
    await ledger.append({
      task_id: null,
      run_id: "run-attest-1",
      session_id: store.sessionId,
      source: "tool",
      tool: "bash",
      tool_call_id: "tc-deny-1",
      decision: "deny",
      outcome: "denied",
      rule: "taint.untrusted_context",
      rule_sha256: `sha256:${"7".repeat(64)}`,
      policy_layers: baseLayer,
      approval: null,
      approval_mode: "auto",
      command: "curl https://evil.example.org",
      command_argv: ["curl", "https://evil.example.org"],
      cwd: workspace,
      workspace_root: workspace,
      path_check: { performed: false, target: null },
      sandbox: noneSandbox,
      effects: { fs: "write", shell: true, network: false },
      coverage: "uncovered",
      coverage_basis: ["policy"],
      exit_code: null,
      duration_ms: 0,
      before_sha256: null,
      after_sha256: null,
      diff_sha256: null,
      output_ref: null,
      output_sha256: core.outputSha("denied"),
      output_preview: "denied",
      empty_result: null,
      executor: null,
      vcs: { commit: null, tree: null, base_commit: null },
      memory: {
        ids: [],
        action: "none",
        query_sha256: null,
        cap: 0,
        truncated: false,
      },
    });

    await store.append("verdict/sign_off", {
      sign_off_id: "01SIGN00000000000000000001",
      previous_sign_off_id: null,
      run_id: "run-attest-1",
      evidence_head: ledger.head,
      signed_verdict: "complete",
      channel: "cli",
      actor: "ci-bot",
      signed_at: new Date().toISOString(),
    });
    await writer.release();

    const attestation = await core.attestSession({
      paths,
      sessionId: store.sessionId,
    });
    assert.equal(attestation.chain_verified, true);
    assert.equal(attestation.runs.length, 1);
    assert.equal(attestation.runs[0].signed_verdict, "complete");
    assert.equal(attestation.modified_files.length, 1);
    assert.equal(attestation.modified_files[0].path, "src/auth.ts");
    assert.equal(attestation.commands.length, 2);
    assert.equal(attestation.denied_actions.length, 1);

    const markdown = core.formatSessionAttestationMarkdown(attestation);
    assert.match(markdown, /## Codepunk Verification Summary/u);
    assert.match(markdown, /\[REDACTED_TOKEN\]/u);
    assert.doesNotMatch(markdown, /demoTokenValue123456/u);
    assert.doesNotMatch(markdown, new RegExp(workspace, "u"));
    assert.match(markdown, /`src\/auth\.ts`/u);
    assert.match(markdown, /`pnpm test` — exit 0 \(srt enforced\)/u);
    assert.match(markdown, /`taint\.untrusted_context`/u);

    const insights = await core.analyzePermissionInsights(paths);
    assert.equal(insights.runs_scanned, 1);
    assert.equal(insights.human_approvals, 2);
    assert.equal(insights.denials, 1);
    assert.equal(insights.repeated_once_approvals.length, 1);
    assert.equal(insights.repeated_once_approvals[0].command, "pnpm test");
    assert.equal(insights.repeated_once_approvals[0].count, 2);
    assert.equal(
      insights.repeated_once_approvals[0].persistable_exact_argv,
      true,
    );
    assert.equal(insights.top_denials[0].rule, "taint.untrusted_context");
    assert.match(
      core.formatPermissionInsights(insights),
      /eligible for 'Always allow exact'/u,
    );
  });
});

test("parseCli accepts --json-schema, attest, and permissions insights", () => {
  const parsed = parseCli([
    "-p",
    "--json-schema",
    '{"type":"object"}',
    "summarize",
  ]);
  assert.equal(parsed.print, true);
  assert.equal(parsed.jsonSchema, '{"type":"object"}');
  assert.deepEqual(parsed.positionals, ["summarize"]);

  const attestArgs = parseCli(["attest", "01ABC", "--json"]);
  assert.deepEqual(attestArgs.positionals, ["attest", "01ABC"]);
  assert.equal(attestArgs.json, true);

  const insightsArgs = parseCli(["permissions", "insights", "--json"]);
  assert.deepEqual(insightsArgs.positionals, ["permissions", "insights"]);
  assert.equal(insightsArgs.json, true);
});
