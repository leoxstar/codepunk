import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { importSource, REPO_ROOT } from "./support/core.mjs";

const requireFromCli = createRequire(
  pathToFileURL(path.join(REPO_ROOT, "packages", "cli", "package.json")),
);
const { stripTerminalSequences, visibleWidth } = await import(
  requireFromCli.resolve("@earendil-works/pi-tui")
);

const { TextBlock } = await importSource(
  "packages/cli/src/tui/components/text.ts",
);
const { Panel } = await importSource(
  "packages/cli/src/tui/components/panel.ts",
);
const { Table } = await importSource(
  "packages/cli/src/tui/components/table.ts",
);
const { TableScreen } = await importSource(
  "packages/cli/src/tui/components/table-screen.ts",
);
const { DiffView, diffViewLines } = await importSource(
  "packages/cli/src/tui/components/diff-view.ts",
);
const { ApprovalCard } = await importSource(
  "packages/cli/src/tui/components/approval-card.ts",
);

const WIDTHS = [1, 2, 8, 12, 20, 40, 80, 120];
const THEME = {
  bold: (text) => text,
  fg: (_color, text) => text,
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

test("TextBlock wraps CJK, emoji, ANSI, and empty lines within every width", () => {
  const block = new TextBlock({
    lines: [
      "plain ".repeat(40),
      "中文路径/非常/长/的/目录/🙂🙂🙂".repeat(8),
      "\u001b[31mred\u001b[0m ".repeat(16),
      "",
    ],
  });
  for (const width of WIDTHS) {
    const lines = block.render(width);
    assert.ok(lines.length > 0);
    assertWidthSafe(lines, width);
    block.invalidate();
  }
});

test("Panel renders sections, empty state, and footer with a bounded border", () => {
  const panel = new Panel(
    {
      title: "codepunk status",
      sections: [
        {
          label: "Project",
          lines: ["project: /tmp/very/long/path/中文/🙂/project"],
        },
        { label: "Session", lines: [] },
        { label: "Usage", lines: ["usage: 12 tokens · $0.000000"] },
      ],
      footer: "esc close",
    },
    THEME,
    KEYBINDINGS,
    () => {},
  );

  for (const width of WIDTHS) {
    assertWidthSafe(panel.render(width), width);
    panel.invalidate();
  }

  const text = stripTerminalSequences(panel.render(48).join("\n"));
  assert.match(text, /codepunk status/u);
  assert.match(text, /Project/u);
  assert.match(text, /Session/u);
  assert.match(text, /\(none\)/u);
  assert.match(text, /esc close/u);
  assert.match(text, /│/u);
  assert.doesNotMatch(text, /\bpi\b|π/iu);
});

test("Panel falls back to an indented layout below 12 columns", () => {
  const panel = new Panel(
    {
      title: "codepunk status",
      sections: [
        { label: "Project", lines: ["project: /tmp/中文/🙂"] },
        { label: "Session", lines: [] },
      ],
      footer: "esc close",
    },
    THEME,
    KEYBINDINGS,
    () => {},
  );
  const lines = panel.render(8).map(stripTerminalSequences);
  assertWidthSafe(lines, 8);
  assert.ok(lines.some((line) => line.startsWith("codep")));
  assert.ok(!lines.some((line) => line.includes("│") || line.includes("┌")));
});

test("Panel closes on escape or q and ignores other input", () => {
  let closed = 0;
  const panel = new Panel(
    {
      title: "codepunk status",
      sections: [{ label: "Project", lines: ["project: /tmp"] }],
    },
    THEME,
    KEYBINDINGS,
    () => {
      closed += 1;
    },
  );
  panel.handleInput("x");
  assert.equal(closed, 0);
  panel.handleInput("\u001b");
  assert.equal(closed, 1);
  panel.handleInput("q");
  assert.equal(closed, 2);
});

test("Panel output is stable across invalidate and width changes", () => {
  const panel = new Panel(
    {
      title: "codepunk status",
      sections: [
        { label: "Project", lines: ["project: /tmp/repo"] },
        { label: "Usage", lines: ["usage: 1 token · $0"] },
      ],
      footer: "esc close",
    },
    THEME,
    KEYBINDINGS,
    () => {},
  );
  const first = panel.render(40);
  panel.invalidate();
  assert.deepEqual(panel.render(40), first);
  assertWidthSafe(panel.render(8), 8);
  assert.deepEqual(panel.render(40), first);
});

test("Table renders CJK, emoji, ANSI, and long cells within every width", () => {
  const table = new Table({
    columns: [
      { label: "Agent", minWidth: 6, maxWidth: 24 },
      { label: "Session", minWidth: 8, maxWidth: 20 },
      { label: "Status", minWidth: 9, maxWidth: 22 },
      { label: "Next", minWidth: 12, maxWidth: 48 },
    ],
    rows: [
      [
        "reviewer · worktree",
        "01a20b77-4998-70f8-a3d8-05fb196066a8",
        "completed · merged",
        `/agents review ${"x".repeat(120)}`,
      ],
      [
        "中文🙂/非常长的代理名",
        "\u001b[31mred-session\u001b[0m",
        "running",
        "路径/🙂/下一 步 ".repeat(10),
      ],
    ],
  });
  for (const width of WIDTHS) {
    assertWidthSafe(table.render(width), width);
    table.invalidate();
  }
  assert.match(table.render(60).join("\n"), /AGENT/u);
  assert.match(table.render(60).join("\n"), /SESSION/u);
});

test("Table renders a width-safe empty state", () => {
  const table = new Table({
    columns: [{ label: "ID" }, { label: "ARGV" }],
    rows: [],
    emptyText:
      'No scoped rules. Choose "Always allow this exact command" on an approval to create one.',
  });
  for (const width of WIDTHS) {
    const lines = table.render(width);
    assertWidthSafe(lines, width);
    assert.ok(lines.length > 0);
    table.invalidate();
  }
  assert.match(table.render(40).join("\n"), /No scoped rules/u);
});

test("Table falls back to a label list when the terminal is too narrow", () => {
  const table = new Table({
    columns: [
      { label: "ID" },
      { label: "ARGV" },
      { label: "CWD" },
      { label: "HASH" },
    ],
    rows: [["rule-1", "touch probe.txt", "/workspace", "abc123def456"]],
  });
  const lines = table.render(10).map(stripTerminalSequences);
  assertWidthSafe(lines, 10);
  assert.ok(lines.some((line) => line.startsWith("id:")));
  assert.ok(lines.some((line) => line.startsWith("argv:")));
  assert.ok(!lines.some((line) => line.includes("┼")));
});

test("Table shrinks maxWidth columns and aligns a right column", () => {
  const table = new Table({
    columns: [
      { label: "ID", minWidth: 6, maxWidth: 10 },
      { label: "ARGV", minWidth: 10, maxWidth: 16 },
      { label: "HASH", minWidth: 8, maxWidth: 12, align: "right" },
    ],
    rows: [
      [
        "rule-with-a-very-long-id",
        "touch a-very-long-argument.txt",
        "abc123def456",
      ],
    ],
  });
  const lines = table.render(40).map(stripTerminalSequences);
  assertWidthSafe(lines, 40);
  assert.ok(lines.some((line) => /abc123def456$/u.test(line)));
  assert.ok(lines.some((line) => line.includes("…")));
});

test("TableScreen renders a title, footer, and closes on escape or q", () => {
  let closed = 0;
  const screen = new TableScreen(
    {
      title: "Background subagents",
      table: {
        columns: [{ label: "Agent" }, { label: "Status" }],
        rows: [["reviewer", "running"]],
      },
      footer: "esc close",
    },
    THEME,
    KEYBINDINGS,
    () => {
      closed += 1;
    },
  );
  for (const width of WIDTHS) {
    assertWidthSafe(screen.render(width), width);
    screen.invalidate();
  }
  const text = stripTerminalSequences(screen.render(60).join("\n"));
  assert.match(text, /Background subagents/u);
  assert.match(text, /esc close/u);
  assert.doesNotMatch(text, /\bpi\b|π/iu);
  screen.handleInput("x");
  assert.equal(closed, 0);
  screen.handleInput("\u001b");
  assert.equal(closed, 1);
  screen.handleInput("q");
  assert.equal(closed, 2);
});

function diffSource(overrides = {}) {
  return {
    root: "/workspace/中文/🙂/project",
    status: "M tracked.txt\n?? new.txt",
    stat: "1 file changed, 1 insertion(+), 1 deletion(-)",
    staged: "",
    unstaged: [
      "diff --git a/tracked.txt b/tracked.txt",
      "--- a/tracked.txt",
      "+++ b/tracked.txt",
      "@@ -1 +1 @@",
      "-one",
      "+two",
    ].join("\n"),
    untracked: ["new.txt"],
    truncated: false,
    ...overrides,
  };
}

test("DiffView renders a 500-line diff within every width and truncates", () => {
  const patch = [
    "diff --git a/big.txt b/big.txt",
    "--- a/big.txt",
    "+++ b/big.txt",
    "@@ -1,500 +1,500 @@",
    ...Array.from({ length: 500 }, (_, index) => ` line ${index + 1}`),
  ].join("\n");
  const view = new DiffView(
    {
      title: "Working tree diff · /workspace/中文/🙂/project",
      source: diffSource({
        staged: patch,
        unstaged: "",
        status: "M big.txt",
      }),
      maxLines: 100,
    },
    THEME,
    KEYBINDINGS,
    () => {},
  );
  for (const width of WIDTHS) {
    assertWidthSafe(view.render(width), width);
    view.invalidate();
  }
  const text = stripTerminalSequences(view.render(80).join("\n"));
  assert.match(text, /Working tree diff/u);
  assert.match(text, /M big\.txt/u);
  assert.match(text, /@@ -1,500 \+1,500 @@/u);
  assert.match(text, /… diff truncated \(404 lines\)/u);
  assert.match(text, /esc close/u);
});

test("DiffView shows clean and untracked-only states", () => {
  const clean = diffViewLines({
    title: "Working tree diff",
    source: diffSource({ status: "", stat: "", unstaged: "", untracked: [] }),
  });
  assert.deepEqual(clean, ["No changes."]);

  const untracked = diffViewLines({
    title: "Working tree diff",
    source: diffSource({
      status: "?? new.txt",
      stat: "",
      staged: "",
      unstaged: "",
      untracked: ["new.txt"],
    }),
  }).join("\n");
  assert.match(untracked, /untracked files \(1; no patch until staged\)/u);
  assert.match(untracked, /new\.txt/u);
  assert.doesNotMatch(untracked, /@@/u);
});

test("DiffView closes on escape or q and ignores other input", () => {
  let closed = 0;
  const view = new DiffView(
    {
      title: "Working tree diff",
      source: diffSource(),
    },
    THEME,
    KEYBINDINGS,
    () => {
      closed += 1;
    },
  );
  view.handleInput("x");
  assert.equal(closed, 0);
  view.handleInput("\u001b");
  assert.equal(closed, 1);
  view.handleInput("q");
  assert.equal(closed, 2);
});

const APPROVAL_CHOICES = [
  { key: "a", label: "Allow once", decision: "allow", scope: "once" },
  {
    key: "s",
    label: "Allow this exact command for the session",
    decision: "allow",
    scope: "session",
    requiresTrust: true,
  },
  {
    key: "p",
    label: "Always allow this exact command",
    decision: "allow",
    scope: "persistent",
    requiresTrust: true,
  },
  { key: "d", label: "Deny", decision: "deny", scope: "once" },
  {
    key: "g",
    label: "Deny with guidance for the model",
    decision: "deny",
    scope: "once",
    guidance: true,
  },
];

function approvalRequest(overrides = {}) {
  return {
    request_id: "request-1",
    nonce_sha256: `sha256:${"a".repeat(64)}`,
    ttl_ms: 30_000,
    worker_id: "local",
    session_id: "session-1",
    tool_call_id: "call-1",
    channel_id: "tui-main",
    tool: "bash",
    command: "touch probe.txt",
    argv: ["touch", "probe.txt"],
    cwd: "/workspace",
    reason: "write outside the safe read-only classes",
    created_at: "2026-11-14T00:00:00.000Z",
    expires_at: "2026-11-14T00:00:30.000Z",
    ...overrides,
  };
}

function createCard({ trusted = true, request = approvalRequest(), onDone }) {
  return new ApprovalCard(
    {
      request,
      choices: APPROVAL_CHOICES,
      workspaceTrusted: trusted,
    },
    THEME,
    KEYBINDINGS,
    (choice) => onDone(choice),
  );
}

test("ApprovalCard renders the full request and defaults to Deny", () => {
  let result = "unset";
  const card = createCard({ onDone: (choice) => (result = choice) });
  for (const width of WIDTHS) {
    assertWidthSafe(card.render(width), width);
    card.invalidate();
  }
  const text = stripTerminalSequences(card.render(80).join("\n"));
  assert.match(text, /codepunk approval/u);
  assert.match(text, /action: bash/u);
  assert.match(text, /command: touch probe\.txt/u);
  assert.match(text, /exact argv: touch probe\.txt/u);
  assert.match(text, /cwd: \/workspace/u);
  assert.match(text, /why: write outside/u);
  assert.match(text, /> d  Deny/u);
  assert.match(text, /a  Allow once/u);
  assert.match(text, /s  Allow this exact command for the session/u);
  assert.match(text, /p  Always allow this exact command/u);
  assert.match(text, /g  Deny with guidance/u);
  assert.match(text, /esc cancel/u);
  assert.doesNotMatch(text, /\bpi\b|π/iu);
  card.handleInput("\r");
  assert.equal(result.key, "d");
  assert.equal(result.decision, "deny");
});

test("ApprovalCard single keys and persistent confirmation", () => {
  for (const [key, scope] of [
    ["a", "once"],
    ["d", "once"],
    ["s", "session"],
    ["g", "once"],
  ]) {
    let result = "unset";
    const card = createCard({ onDone: (choice) => (result = choice) });
    card.handleInput(key);
    assert.equal(result.key, key);
    assert.equal(result.scope, scope);
  }

  let result = "unset";
  const card = createCard({ onDone: (choice) => (result = choice) });
  card.handleInput("p");
  assert.equal(result, "unset");
  const preview = stripTerminalSequences(card.render(80).join("\n"));
  assert.match(preview, /Persistent rule preview/u);
  assert.match(preview, /exact argv: \["touch","probe\.txt"\]/u);
  assert.match(preview, /enter\/p confirm · esc back/u);
  card.handleInput("\u001b");
  assert.equal(result, "unset");
  assert.match(
    stripTerminalSequences(card.render(80).join("\n")),
    /> d  Deny/u,
  );
  card.handleInput("p");
  card.handleInput("\r");
  assert.equal(result.key, "p");
  assert.equal(result.scope, "persistent");
});

test("ApprovalCard hides session and persistent choices when untrusted", () => {
  let result = "unset";
  const card = createCard({
    trusted: false,
    onDone: (choice) => (result = choice),
  });
  const text = stripTerminalSequences(card.render(80).join("\n"));
  assert.doesNotMatch(text, /Allow this exact command for the session/u);
  assert.doesNotMatch(text, /Always allow this exact command/u);
  assert.match(text, /workspace is untrusted/u);
  card.handleInput("s");
  assert.equal(result, "unset");
  card.handleInput("p");
  assert.equal(result, "unset");
  card.handleInput("a");
  assert.equal(result.key, "a");
});

test("ApprovalCard arrows move the selection and escape cancels", () => {
  let result = "unset";
  const card = createCard({ onDone: (choice) => (result = choice) });
  card.handleInput("\u001b[B");
  assert.match(
    stripTerminalSequences(card.render(80).join("\n")),
    /> g  Deny with guidance/u,
  );
  card.handleInput("k");
  assert.match(
    stripTerminalSequences(card.render(80).join("\n")),
    /> d  Deny/u,
  );
  card.handleInput("\u001b[A");
  assert.match(
    stripTerminalSequences(card.render(80).join("\n")),
    /> p  Always allow this exact command/u,
  );
  card.handleInput("\u001b");
  assert.equal(result, null);
});

test("ApprovalCard keeps CJK, emoji, ANSI, and long argv within width", () => {
  const card = createCard({
    request: approvalRequest({
      command: `touch ${"中文/🙂/非常长的路径 ".repeat(12)}`,
      argv: ["touch", `中文/🙂/非常长的路径-${"x".repeat(160)}`],
    }),
    onDone: () => {},
  });
  for (const width of WIDTHS) {
    assertWidthSafe(card.render(width), width);
    card.invalidate();
  }
});
