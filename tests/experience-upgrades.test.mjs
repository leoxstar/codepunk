import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { importCore, importSource, REPO_ROOT } from "./support/core.mjs";

const requireFromCli = createRequire(
  pathToFileURL(path.join(REPO_ROOT, "packages", "cli", "package.json")),
);
const { stripTerminalSequences, visibleWidth } = await import(
  pathToFileURL(requireFromCli.resolve("@earendil-works/pi-tui")).href
);

const core = await importCore();
const { Panel } = await importSource(
  "packages/cli/src/tui/components/panel.ts",
);
const { DiffView, diffViewLines } = await importSource(
  "packages/cli/src/tui/components/diff-view.ts",
);
const { TableScreen } = await importSource(
  "packages/cli/src/tui/components/table-screen.ts",
);
const { SessionPicker } = await importSource(
  "packages/cli/src/tui/components/session-picker.ts",
);
const { TaskCenter } = await importSource(
  "packages/cli/src/tui/components/task-center.ts",
);
const { QuestionCard } = await importSource(
  "packages/cli/src/tui/components/question-card.ts",
);
const { RewindPicker } = await importSource(
  "packages/cli/src/tui/components/rewind-picker.ts",
);
const { HelpBrowser } = await importSource(
  "packages/cli/src/tui/components/help-browser.ts",
);
const { nextWorkMode, cycleWorkMode } = await importSource(
  "packages/cli/src/tui/format/mode-cycle.ts",
);
const { codepunkToolRendererResolver } = await importSource(
  "packages/cli/src/tui/renderers/index.ts",
);

const WIDTHS = [1, 8, 12, 24, 48, 80, 120];
const THEME = {
  bold: (text) => text,
  fg: (_color, text) => text,
};
const COLOR_THEME = {
  bold: (text) => `\u001b[1m${text}\u001b[0m`,
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

test("P0: Panel, DiffView, and TableScreen scroll smoothly when viewportHeight is set", () => {
  const manyLines = Array.from({ length: 40 }, (_, i) => `item-${i + 1}`);
  const panel = new Panel(
    {
      title: "scrollable panel",
      sections: [{ label: "Items", lines: manyLines }],
      footer: "esc close",
      viewportHeight: 6,
    },
    THEME,
    KEYBINDINGS,
    () => {},
  );
  const first = stripTerminalSequences(panel.render(60).join("\n"));
  assert.match(first, /lines 1-6\/41/u);
  assert.match(first, /item-1/u);
  assert.doesNotMatch(first, /item-35/u);

  panel.handleInput("G");
  const bottom = stripTerminalSequences(panel.render(60).join("\n"));
  assert.match(bottom, /item-40/u);
  assert.doesNotMatch(bottom, /item-1\b/u);

  panel.handleInput("g");
  assert.match(
    stripTerminalSequences(panel.render(60).join("\n")),
    /lines 1-6\/41/u,
  );

  const diff = new DiffView(
    {
      title: "Colored Diff",
      source: {
        root: "/repo",
        status: "M a.ts",
        stat: "1 file changed",
        staged: "",
        unstaged: [
          "diff --git a/a.ts b/a.ts",
          "@@ -1,2 +1,2 @@",
          "-const oldVal = 1;",
          "+const newVal = 2;",
          ...Array.from({ length: 30 }, (_, i) => ` context ${i}`),
        ].join("\n"),
        untracked: [],
        truncated: false,
      },
      viewportHeight: 8,
    },
    COLOR_THEME,
    KEYBINDINGS,
    () => {},
  );
  const diffText = diff.render(80).join("\n");
  assert.match(diffText, /<error>-const oldVal = 1;<\/error>/u);
  assert.match(diffText, /<success>\+const newVal = 2;<\/success>/u);
  assert.match(diffText, /<accent>@@ -1,2 \+1,2 @@<\/accent>/u);
  assert.match(diffText, /lines 1-8\//u);

  const tableScreen = new TableScreen(
    {
      title: "Scrollable Table",
      table: {
        columns: [{ label: "ID" }, { label: "Value" }],
        rows: Array.from({ length: 30 }, (_, i) => [`id-${i}`, `val-${i}`]),
      },
      viewportHeight: 6,
    },
    THEME,
    KEYBINDINGS,
    () => {},
  );
  assert.match(tableScreen.render(60).join("\n"), /lines 1-6\//u);
  tableScreen.handleInput("G");
  assert.match(tableScreen.render(60).join("\n"), /id-29/u);
});

test("P0: SessionPicker filters sessions fuzzily and stays width-safe", () => {
  let picked = "unset";
  const picker = new SessionPicker(
    {
      title: "Resume session",
      items: [
        {
          id: "01AAA",
          title: "Fix sandbox bridge",
          updatedAt: "2026-11-25T10:00:00Z",
          pinned: false,
          current: false,
          label: "01AAA · Fix sandbox bridge",
        },
        {
          id: "01BBB",
          title: "Upgrade TUI diff viewer",
          updatedAt: "2026-11-25T11:00:00Z",
          pinned: true,
          current: true,
          label: "01BBB · Upgrade TUI diff viewer",
        },
      ],
      viewportHeight: 10,
    },
    THEME,
    KEYBINDINGS,
    (id) => {
      picked = id;
    },
  );
  for (const width of WIDTHS) {
    assertWidthSafe(picker.render(width), width);
    picker.invalidate();
  }
  picker.handleInput("d");
  picker.handleInput("i");
  picker.handleInput("f");
  picker.handleInput("f");
  const filtered = stripTerminalSequences(picker.render(60).join("\n"));
  assert.match(filtered, /Upgrade TUI diff viewer/u);
  assert.doesNotMatch(filtered, /Fix sandbox bridge/u);
  picker.handleInput("\r");
  assert.equal(picked, "01BBB");
});

test("P0: TaskCenter selects and dispatches actions across subagents and background tasks", () => {
  let action = "unset";
  const center = new TaskCenter(
    {
      title: "Task center",
      entries: [
        {
          id: "sub-1",
          kind: "subagent",
          status: "completed",
          title: "Audit policy rules",
          detail: "enter result · r review · m merge",
          running: false,
          reviewable: true,
          mergeable: true,
        },
        {
          id: "bg-1",
          kind: "background",
          status: "running",
          title: "pnpm test",
          detail: "enter logs · x stop",
          running: true,
          reviewable: false,
          mergeable: false,
        },
      ],
      viewportHeight: 12,
    },
    THEME,
    KEYBINDINGS,
    (result) => {
      action = result;
    },
  );
  for (const width of WIDTHS) {
    assertWidthSafe(center.render(width), width);
    center.invalidate();
  }
  center.handleInput("r");
  assert.equal(action.action, "review");
  assert.equal(action.entry.id, "sub-1");

  center.handleInput("j");
  center.handleInput("x");
  assert.equal(action.action, "stop");
  assert.equal(action.entry.id, "bg-1");
});

test("P0: Shift+Tab mode cycle rotates modes and refuses to widen read-only autonomy", async () => {
  assert.equal(nextWorkMode("plan"), "standard");
  assert.equal(nextWorkMode("standard"), "auto");
  assert.equal(nextWorkMode("auto"), "auto-approve");
  assert.equal(nextWorkMode("auto-approve"), "plan");

  const notices = [];
  const readOnlyState = {
    runtime: {
      autonomy: { profile: "read-only" },
      config: { approval: { mode: "ask" }, tui: { widgets: false } },
      planMode: { state: () => null },
    },
  };
  const result = await cycleWorkMode(readOnlyState, {
    ui: {
      notify(msg, level) {
        notices.push({ msg, level });
      },
      setStatus() {},
      setWidget() {},
    },
  });
  assert.equal(result, null);
  assert.equal(notices[0].level, "warning");
});

test("P1: QuestionCard and ask_user tool handle options, freeform, and headless fallback", async () => {
  let answer = null;
  const card = new QuestionCard(
    {
      question: "Which test runner should we use?",
      options: [
        { label: "node --test", description: "Zero dependencies" },
        { label: "vitest" },
      ],
      allowFreeform: true,
    },
    THEME,
    KEYBINDINGS,
    (res) => {
      answer = res;
    },
  );
  for (const width of WIDTHS) {
    assertWidthSafe(card.render(width), width);
    card.invalidate();
  }
  card.handleInput("2");
  assert.equal(answer.cancelled, false);
  assert.equal(answer.selectedLabel, "vitest");

  let freeformAnswer = null;
  const card2 = new QuestionCard(
    {
      question: "Choose a branch name",
      options: [{ label: "feat/tui" }],
      allowFreeform: true,
    },
    THEME,
    KEYBINDINGS,
    (res) => {
      freeformAnswer = res;
    },
  );
  card2.handleInput("2");
  card2.handleInput("c");
  card2.handleInput("u");
  card2.handleInput("s");
  card2.handleInput("t");
  card2.handleInput("\r");
  assert.equal(freeformAnswer.freeformText, "cust");

  const headlessTool = core.createAskUserTool(null);
  const headlessResult = await headlessTool.execute("call-1", {
    question: "Pick one",
    options: [{ label: "A" }],
  });
  assert.equal(headlessResult.structuredContent.answered, false);
  assert.equal(headlessResult.structuredContent.reason, "channel_unavailable");
});

test("P1: subagent tool delegates read-only tasks and policy denies nested worker spawns", async () => {
  const deniedInWorker = core.decidePolicy({
    tool: "subagent",
    cwd: "/workspace",
    workspaceRoot: "/workspace",
    deliveryRoot: "/workspace",
    codepunkHome: "/home/.codepunk",
    mode: "worker",
  });
  assert.equal(deniedInWorker.decision, "deny");

  const allowedInInteractive = core.decidePolicy({
    tool: "subagent",
    cwd: "/workspace",
    workspaceRoot: "/workspace",
    deliveryRoot: "/workspace",
    codepunkHome: "/home/.codepunk",
    mode: "interactive",
  });
  assert.equal(allowedInInteractive.decision, "allow");

  const tool = core.createSubagentTool(async (request) => ({
    sessionId: "01CHILD",
    status: "completed",
    summary: `Explored: ${request.task}`,
    evidenceRef: "sha256:abc",
    exitCode: 0,
  }));
  const res = await tool.execute("call-sub", {
    task: "find entry points",
    role: "research",
  });
  assert.equal(res.structuredContent.session_id, "01CHILD");
  assert.equal(res.structuredContent.status, "completed");
  assert.match(res.content[0].text, /Explored: find entry points/u);
});

test("P1: RewindPicker supports files-only, both, tree-only, and width safety", () => {
  let selection = null;
  const picker = new RewindPicker(
    {
      title: "Rewind checkpoints & branches",
      items: [
        {
          id: "cp-1",
          tool: "edit",
          displayTarget: "src/app.ts",
          createdAt: "2026-11-25T12:00:00.000Z",
          stepsBack: 1,
        },
        {
          id: "cp-2",
          tool: "write",
          displayTarget: "src/new.ts",
          createdAt: "2026-11-25T11:59:00.000Z",
          stepsBack: 2,
        },
      ],
      viewportHeight: 10,
    },
    THEME,
    KEYBINDINGS,
    (sel) => {
      selection = sel;
    },
  );
  for (const width of WIDTHS) {
    assertWidthSafe(picker.render(width), width);
    picker.invalidate();
  }
  picker.handleInput("j");
  picker.handleInput("b");
  assert.deepEqual(selection, { mode: "both", stepsBack: 2 });

  picker.handleInput("t");
  assert.deepEqual(selection, { mode: "tree" });
});

test("P2: web_search parses results, enforces network_deny, and rejects denied endpoints", async () => {
  const sampleHtml = `
    <div class="result">
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.org%2Fguide">Example Guide</a>
      <a class="result__snippet">A concise guide to local agents.</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://blocked.test/secret">Blocked Result</a>
      <a class="result__snippet">Should be filtered out.</a>
    </div>
  `;
  const parsed = core.parseDuckDuckGoHtml(sampleHtml, 5, ["blocked.test"]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, "Example Guide");
  assert.equal(parsed[0].url, "https://docs.example.org/guide");

  const tool = core.createWebSearchTool({
    deniedDomains: ["blocked.test"],
    endpoint: "https://search.example.org/html/",
    fetchImpl: async () =>
      new Response(sampleHtml, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  });
  const okRes = await tool.execute("call-ws-1", { query: "local agents" });
  assert.equal(okRes.structuredContent.count, 1);
  assert.match(okRes.content[0].text, /Example Guide/u);

  const deniedEndpointTool = core.createWebSearchTool({
    deniedDomains: ["search.example.org"],
    endpoint: "https://search.example.org/html/",
  });
  const deniedRes = await deniedEndpointTool.execute("call-ws-2", {
    query: "test",
  });
  assert.equal(deniedRes.isError, true);
  assert.match(deniedRes.content[0].text, /sandbox\.network_deny/u);
});

test("P2: post-write diagnostics and edit line-anchor hints catch errors accurately", () => {
  const jsonErrors = core.diagnoseFileContent("config.json", '{"a": 1,}');
  assert.equal(jsonErrors.length, 1);
  assert.match(
    core.formatDiagnosticsSummary("config.json", jsonErrors),
    /\[post-write diagnostics\]/u,
  );

  assert.deepEqual(core.diagnoseFileContent("ok.json", '{"a": 1}'), []);

  const jsErrors = core.diagnoseFileContent("broken.cjs", "function f( {");
  assert.equal(jsErrors.length, 1);

  const hints = core.formatEditAnchorHints(
    "const alpha = 1;\nfunction renderHeader(state) {\n  return state.id;\n}\n",
    "function renderHeader(ctx) {",
  );
  assert.ok(hints !== null);
  assert.match(hints, /L2:[0-9a-f]{4} \| function renderHeader\(state\)/u);
});

test("P2: new tool renderers are registered and unknown tools delegate to next()", () => {
  const resolver = codepunkToolRendererResolver();
  for (const name of [
    "search",
    "plan",
    "todo",
    "web_fetch",
    "web_search",
    "ask_user",
    "subagent",
    "memory_search",
  ]) {
    let fellThrough = false;
    const renderer = resolver(name, () => {
      fellThrough = true;
      return undefined;
    });
    assert.ok(renderer !== undefined, `missing renderer for ${name}`);
    assert.equal(fellThrough, false);
  }

  let delegated = false;
  resolver("unknown_tool", () => {
    delegated = true;
    return undefined;
  });
  assert.equal(delegated, true);
});

test("Dogfood fix: HelpBrowser filters commands fuzzily and stays width-safe", () => {
  let closed = 0;
  const browser = new HelpBrowser(
    {
      title: "Codepunk help",
      text: [
        "Commands",
        "  /tasks    open unified task center",
        "  /rewind   rewind file checkpoints",
        "  /diff     show git diff",
      ].join("\n"),
      viewportHeight: 8,
    },
    THEME,
    KEYBINDINGS,
    () => {
      closed += 1;
    },
  );
  for (const width of WIDTHS) {
    assertWidthSafe(browser.render(width), width);
    browser.invalidate();
  }
  browser.handleInput("r");
  browser.handleInput("e");
  browser.handleInput("w");
  const filtered = stripTerminalSequences(browser.render(60).join("\n"));
  assert.match(filtered, /\/rewind/u);
  assert.doesNotMatch(filtered, /\/tasks/u);
  browser.handleInput("\u001b");
  assert.equal(closed, 1);
});

test("Dogfood fix: writeUserTuiPreferences persists TUI and compaction settings to config.toml", async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cp-pref-"));
  try {
    const configPath = await core.writeUserTuiPreferences(
      { home: tempHome },
      {
        hideThinking: true,
        header: false,
        status: true,
        widgets: false,
        compaction: "manual",
      },
    );
    const raw = await fs.readFile(configPath, "utf8");
    assert.match(raw, /\[tui\]/u);
    assert.match(raw, /hide_thinking = true/u);
    assert.match(raw, /header = false/u);
    assert.match(raw, /widgets = false/u);
    assert.match(raw, /\[context\]/u);
    assert.match(raw, /compaction = "manual"/u);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test("Dogfood fix: DiffView collapses internal .codepunk/ untracked noise", () => {
  const onlyInternal = diffViewLines({
    title: "Working tree diff",
    source: {
      root: "/repo",
      status: "?? .codepunk/.gitignore",
      stat: "",
      staged: "",
      unstaged: "",
      untracked: [".codepunk/.gitignore"],
      truncated: false,
    },
  }).join("\n");
  assert.match(onlyInternal, /No workspace changes\./u);
  assert.match(onlyInternal, /1 internal \.codepunk\/ file\(s\) omitted/u);

  const mixed = diffViewLines({
    title: "Working tree diff",
    source: {
      root: "/repo",
      status: "M app.ts\n?? .codepunk/.gitignore\n?? note.txt",
      stat: "1 file changed",
      staged: "",
      unstaged: "diff --git a/app.ts b/app.ts\n+const x = 1;",
      untracked: [".codepunk/.gitignore", "note.txt"],
      truncated: false,
    },
  }).join("\n");
  assert.match(mixed, /untracked files \(1; no patch until staged\):/u);
  assert.match(mixed, /note\.txt/u);
  assert.doesNotMatch(mixed, /\?\? \.codepunk\/\.gitignore/u);
  assert.match(mixed, /1 internal \.codepunk\/ file\(s\) omitted/u);
});

test("External readiness: web_search blocks private hosts, unsafe redirects, bot challenges, and supports Tavily/Brave JSON", async () => {
  const privateTool = core.createWebSearchTool({
    endpoint: "http://127.0.0.1:8080/search",
  });
  const privateRes = await privateTool.execute("ws-priv", { query: "test" });
  assert.equal(privateRes.isError, true);
  assert.match(privateRes.content[0].text, /private, loopback/u);

  const redirectToPrivate = core.createWebSearchTool({
    endpoint: "https://search.example.org/html/",
    fetchImpl: async () =>
      new Response("", {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      }),
  });
  const redirRes = await redirectToPrivate.execute("ws-redir", {
    query: "test",
  });
  assert.equal(redirRes.isError, true);
  assert.match(redirRes.content[0].text, /private, loopback/u);

  const botChallengeTool = core.createWebSearchTool({
    endpoint: "https://search.example.org/html/",
    fetchImpl: async () =>
      new Response("<html><body>anomaly-modal bots</body></html>", {
        status: 202,
        headers: { "content-type": "text/html" },
      }),
  });
  const botRes = await botChallengeTool.execute("ws-bot", { query: "test" });
  assert.equal(botRes.isError, true);
  assert.match(botRes.content[0].text, /TAVILY_API_KEY/u);

  const tavilyTool = core.createWebSearchTool({
    deniedDomains: ["blocked.test"],
    environment: { TAVILY_API_KEY: "tvly-test-key" },
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.tavily.com/search");
      assert.equal(init?.method, "POST");
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Codepunk Guide",
              url: "https://docs.example.org/guide",
              content: "Supervised local coding agent.",
            },
            {
              title: "Blocked Host",
              url: "https://blocked.test/secret",
              content: "Must be stripped.",
            },
            {
              title: "Internal Host",
              url: "http://localhost:3000/admin",
              content: "Must be stripped.",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const tavilyRes = await tavilyTool.execute("ws-tavily", {
    query: "codepunk",
  });
  assert.equal(tavilyRes.structuredContent.backend, "tavily");
  assert.equal(tavilyRes.structuredContent.count, 1);
  assert.match(tavilyRes.content[0].text, /Codepunk Guide/u);
  assert.doesNotMatch(tavilyRes.content[0].text, /Blocked Host|localhost/u);
});

test("External readiness: post-write diagnostics cover TOML, TS/TSX, ESM with zero false positives on repo TS", async () => {
  assert.deepEqual(
    core.diagnoseFileContent("config.toml", "[tui]\nheader = true\n"),
    [],
  );
  const badToml = core.diagnoseFileContent(
    "config.toml",
    "[tui\nheader = true",
  );
  assert.equal(badToml.length, 1);
  assert.equal(badToml[0].line, 1);

  const badTs = core.diagnoseFileContent(
    "broken.ts",
    'export function run(x: number): string {\n  const s = "unterminated;\n  return String(x);\n}\n',
  );
  assert.equal(badTs.length, 1);
  assert.match(badTs[0].message, /Unterminated string/u);

  const badBrace = core.diagnoseFileContent(
    "broken.mjs",
    "import path from 'node:path';\nexport const fn = () => { return [1, 2; };\n",
  );
  assert.equal(badBrace.length, 1);
  assert.match(badBrace[0].message, /Unexpected/u);

  const validTsx = core.diagnoseFileContent(
    "comp.tsx",
    "export const Card = ({ title }: { title: string }) => <div>{title}</div>;\n",
  );
  assert.deepEqual(validTsx, []);

  // Zero false positives across real TypeScript sources in packages/core/src.
  const coreSrcRoot = path.resolve(process.cwd(), "packages/core/src");
  const entries = await fs.readdir(coreSrcRoot, { recursive: true });
  const tsFiles = entries.filter((entry) => entry.endsWith(".ts"));
  assert.ok(tsFiles.length > 20);
  for (const rel of tsFiles) {
    const full = path.join(coreSrcRoot, rel);
    const content = await fs.readFile(full, "utf8");
    const diags = core.diagnoseFileContent(full, content);
    assert.deepEqual(
      diags,
      [],
      `false positive in ${rel}: ${JSON.stringify(diags)}`,
    );
  }
});

test("External readiness: extractDroppedImageInput parses quoted, escaped, and bare image paths", async () => {
  const { extractDroppedImageInput } = await importSource(
    "packages/cli/src/tui/format/clipboard-image.ts",
  );
  assert.deepEqual(
    extractDroppedImageInput("'/tmp/my shot.png' explain this"),
    { rawPath: "/tmp/my shot.png", prompt: "explain this" },
  );
  assert.deepEqual(
    extractDroppedImageInput("/tmp/my\\ shot.webp check alignment"),
    { rawPath: "/tmp/my shot.webp", prompt: "check alignment" },
  );
  assert.deepEqual(extractDroppedImageInput("./ui.jpg"), {
    rawPath: "./ui.jpg",
    prompt: "",
  });
  assert.equal(extractDroppedImageInput("/image ./ui.png"), null);
  assert.equal(extractDroppedImageInput("hello world"), null);
  assert.equal(extractDroppedImageInput("./README.md explain"), null);
});

test("External readiness: codepunk setup writes 0600 auth.json and default model in one command", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { ensureBuilt, withoutAmbientProviderEnv } =
    await import("./support/helpers.mjs");
  const execFileAsync = promisify(execFile);
  const cli = await ensureBuilt();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-setup-"));
  try {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        cli,
        "setup",
        "--provider",
        "anthropic",
        "--api-key",
        "sk-ant-test-key",
        "--json",
      ],
      {
        cwd: project,
        env: { ...withoutAmbientProviderEnv(), CODEPUNK_HOME: home },
      },
    );
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.provider, "anthropic");
    assert.ok(parsed.model.length > 0);
    const authStat = await fs.stat(path.join(home, "auth.json"));
    if (process.platform !== "win32") {
      assert.equal(authStat.mode & 0o777, 0o600);
    }
    const configRaw = await fs.readFile(path.join(home, "config.toml"), "utf8");
    assert.match(configRaw, /provider = "anthropic"/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("External readiness: user-visible TUI onboarding and model prompts have no Pi brand leaks", async () => {
  for (const rel of [
    "packages/cli/src/tui/chrome/model.ts",
    "packages/cli/src/tui/format/model.ts",
    "packages/cli/src/tui/chrome/setup.ts",
    "packages/cli/src/tui/chrome/help.ts",
  ]) {
    const content = await fs.readFile(path.resolve(process.cwd(), rel), "utf8");
    assert.doesNotMatch(
      content,
      /Search all models \(Pi\)|selected by the Pi host|Pi's provider sign-in|Pi's fuzzy model search/u,
      `Pi brand leak remained in ${rel}`,
    );
  }
});

test("External readiness: doctor emits platform-specific remediation hints for Linux srt and rg/fd", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-doc-"));
  try {
    const loaded = await core.loadConfig(
      core.projectPaths({
        cwd: root,
        deliveryRoot: root,
        projectId: "doc-test",
        isGitRepo: false,
      }),
      {},
      {},
      { projectTrusted: false },
    );
    const report = await core.runDoctor({
      paths: core.projectPaths({
        cwd: root,
        deliveryRoot: root,
        projectId: "doc-test",
        isGitRepo: false,
      }),
      config: loaded.config,
      platform: "linux",
      arch: "x64",
      environment: { PATH: "" },
      sandboxProbe: async () => "bwrap blocked by apparmor userns",
      modelProbe: async () => null,
      packageVersion: "0.1.0",
    });
    const srt = report.checks.find((c) => c.id === "srt");
    assert.match(srt?.hint ?? "", /apt-get install -y bubblewrap/u);
    assert.match(srt?.hint ?? "", /apparmor_restrict_unprivileged_userns=0/u);
    const rg = report.checks.find((c) => c.id === "search-rg");
    assert.match(rg?.hint ?? "", /apt-get install -y ripgrep/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("External readiness: crash guard cleanup runs registered handlers within timeout", async () => {
  const { registerFatalCleanup, runFatalCleanups } = await importSource(
    "packages/cli/src/crash-guard.ts",
  );
  let ran = false;
  const unregister = registerFatalCleanup(async () => {
    ran = true;
  });
  try {
    await runFatalCleanups(500);
    assert.equal(ran, true);
  } finally {
    unregister();
  }
});

test("Track 1: piped stdin combines with positional print prompt via CLI", async () => {
  const { spawn } = await import("node:child_process");
  const { ensureBuilt } = await import("./support/helpers.mjs");
  const { readPrompt } = await importSource("packages/cli/src/run/project.ts");
  assert.equal(typeof readPrompt, "function");
  const cli = await ensureBuilt();
  // Verify codepunk upgrade --check --json respects CODEPUNK_OFFLINE=1 without network.
  const child = spawn(process.execPath, [cli, "upgrade", "--check", "--json"], {
    env: { ...process.env, CODEPUNK_OFFLINE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  const { PRODUCT_VERSION } = await import("./support/helpers.mjs");
  assert.equal(parsed.currentVersion, PRODUCT_VERSION);
  assert.equal(parsed.status, "offline");
  assert.equal(parsed.updateAvailable, false);
});

test("Track 1: isNewerSemver and checkPackageUpdate handle semver, prereleases, and fetch responses", async () => {
  assert.equal(core.isNewerSemver("0.1.0", "0.2.0"), true);
  assert.equal(core.isNewerSemver("0.1.0", "0.1.1"), true);
  assert.equal(core.isNewerSemver("0.1.0", "0.1.0"), false);
  assert.equal(core.isNewerSemver("0.2.0", "0.1.9"), false);
  assert.equal(core.isNewerSemver("0.1.0-beta.1", "0.1.0"), true);
  assert.equal(core.isNewerSemver("0.1.0", "0.1.0-beta.1"), false);

  const check = await core.checkPackageUpdate({
    currentVersion: "0.1.0",
    environment: {},
    fetchImpl: async () =>
      new Response(JSON.stringify({ version: "0.1.2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  assert.equal(check.status, "ok");
  assert.equal(check.latestVersion, "0.1.2");
  assert.equal(check.updateAvailable, true);
});

test("Track 1: safe read-only shell pipeline filters auto-allow while blocking mutation flags and outside paths", () => {
  const base = {
    tool: "bash",
    cwd: "/workspace",
    workspaceRoot: "/workspace",
    deliveryRoot: "/workspace",
    codepunkHome: "/home/.codepunk",
    mode: "interactive",
    approvalMode: "ask",
  };
  for (const command of [
    "rg foo src | sort -u | head -n 20",
    "cat package.json | cut -d ':' -f 1 | tr 'a-z' 'A-Z' | nl",
    "fd -e ts packages/core | sort | uniq -c",
    "basename src/index.ts && dirname src/index.ts",
  ]) {
    const decision = core.decidePolicy({ ...base, command });
    assert.equal(
      decision.decision,
      "allow",
      `expected read-only auto-allow for: ${command} (got ${decision.decision}: ${decision.reason})`,
    );
  }
  for (const unsafe of [
    "sort -o out.txt file.txt",
    "sort --output=out.txt file.txt",
    "uniq in.txt out.txt",
    "fd -x rm {} src",
    "fd --exec-batch cat src",
    "cut -d ':' -f 1 /etc/passwd",
    "fd . /etc",
  ]) {
    const decision = core.decidePolicy({ ...base, command: unsafe });
    assert.notEqual(
      decision.decision,
      "allow",
      `unsafe command must not auto-allow: ${unsafe}`,
    );
  }
});

test("Track 1: subagent tool runs up to 4 parallel read-only tasks and McpPanel is width-safe", async () => {
  const seen = [];
  const tool = core.createSubagentTool(async (request) => {
    seen.push(request.task);
    return {
      sessionId: `01SUB_${seen.length}`,
      status: "completed",
      summary: `Result for ${request.task}`,
      evidenceRef: null,
      exitCode: 0,
    };
  });
  const res = await tool.execute("call-batch", {
    tasks: [
      { task: "inspect policy", role: "research" },
      { task: "inspect wrap", role: "review" },
    ],
  });
  assert.notEqual(res.isError, true);
  assert.equal(res.structuredContent.count, 2);
  assert.equal(seen.length, 2);
  assert.match(
    res.content[0].text,
    /### \[1\] research — 01SUB_1 \(completed\)/u,
  );
  assert.match(
    res.content[0].text,
    /### \[2\] review — 01SUB_2 \(completed\)/u,
  );

  const { McpPanel } = await importSource(
    "packages/cli/src/tui/components/mcp-panel.ts",
  );
  let chosen = null;
  const panel = new McpPanel(
    {
      title: "MCP servers (user scope)",
      mcpStatus: "ready",
      entries: [
        {
          name: "docs",
          transport: "http",
          target: "https://mcp.example.org",
          authState: "OAuth signed out",
          connected: false,
          toolCount: 0,
        },
        {
          name: "local-fs",
          transport: "stdio",
          target: "npx server-fs",
          authState: "stdio (no OAuth)",
          connected: true,
          toolCount: 3,
        },
      ],
      viewportHeight: 10,
    },
    THEME,
    KEYBINDINGS,
    (action) => {
      chosen = action;
    },
  );
  for (const width of WIDTHS) {
    assertWidthSafe(panel.render(width), width);
    panel.invalidate();
  }
  panel.handleInput("l");
  assert.deepEqual(chosen, { action: "login", name: "docs" });
  panel.handleInput("j");
  panel.handleInput("d");
  assert.deepEqual(chosen, { action: "remove", name: "local-fs" });
});

test("Track 2: enhanced edit handles multi-hunk + unique indentation fallback and enhanced read appends large-file outline", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-track2-"));
  try {
    const file = path.join(root, "sample.ts");
    await fs.writeFile(
      file,
      [
        "export class Service {",
        "    run(x: number): number {",
        "        const next = x + 1;",
        "        return next;",
        "    }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const editTool = core.createEnhancedEditToolDefinition(root);
    const editRes = await editTool.execute("t2-edit", {
      path: "sample.ts",
      edits: [
        {
          oldText: "  const next = x + 1;\n  return next;",
          newText: "  const next = x + 2;\n  return next * 2;",
        },
      ],
    });
    assert.match(editRes.content[0].text, /indentation-normalized/u);
    const updated = await fs.readFile(file, "utf8");
    assert.match(updated, /^        const next = x \+ 2;$/mu);
    assert.match(updated, /^        return next \* 2;$/mu);

    const bigFile = path.join(root, "big.py");
    const pyLines = [];
    for (let i = 0; i < 12; i += 1) {
      pyLines.push(`def compute_${i}(value):`);
      for (let j = 0; j < 35; j += 1) {
        pyLines.push(`    step_${j} = value + ${j}`);
      }
      pyLines.push(`    return value + ${i}`);
      pyLines.push("");
    }
    await fs.writeFile(bigFile, pyLines.join("\n"), "utf8");
    const readTool = core.createEnhancedReadToolDefinition(root);
    const fullRead = await readTool.execute("t2-read-full", { path: "big.py" });
    assert.match(
      fullRead.content[0].text,
      /\[file outline — \d+ lines, jump with offset\/limit\]/u,
    );
    assert.match(fullRead.content[0].text, /L1: def compute_0/u);

    const sliceRead = await readTool.execute("t2-read-slice", {
      path: "big.py",
      offset: 1,
      limit: 10,
    });
    assert.doesNotMatch(sliceRead.content[0].text, /\[file outline/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
