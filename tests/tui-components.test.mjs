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
