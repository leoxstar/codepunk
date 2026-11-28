import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { escapeRegExp, withTempDirectory } from "./support/helpers.mjs";
import { importCore, importSource } from "./support/core.mjs";
import {
  IMAGE_PNG_BASE64,
  core,
  stopPty,
  waitForQuiet,
} from "./support/tui-pty.mjs";

test("the TUI treats an active session model as selected", async () => {
  const { setTuiRuntime } = await importSource("packages/cli/src/tui.ts");
  const makeState = () => ({
    runtime: null,
    context: null,
    channel: {},
    lastRunId: null,
    lastEvidence: 0,
    warningsShown: false,
    modelSelected: false,
  });
  const matched = makeState();
  setTuiRuntime(matched, {
    config: { model: { provider: "local", id: "chat" } },
    host: { session: { model: { provider: "local", id: "chat" } } },
  });
  assert.equal(matched.modelSelected, true);

  const noModel = makeState();
  setTuiRuntime(noModel, {
    config: { model: { provider: null, id: null } },
    host: { session: { model: undefined } },
  });
  assert.equal(noModel.modelSelected, false);

  const unknown = makeState();
  setTuiRuntime(unknown, {
    config: { model: { provider: null, id: null } },
    host: { session: { model: { provider: "unknown", id: "unknown" } } },
  });
  assert.equal(unknown.modelSelected, false);

  const unconfigured = makeState();
  setTuiRuntime(unconfigured, {
    config: { model: { provider: null, id: null } },
    host: { session: { model: { provider: "local", id: "chat" } } },
  });
  assert.equal(unconfigured.modelSelected, true);
});

test("sandbox shell status reflects deferred readiness and preflight failure", async () => {
  const { currentShellStatus, sandboxStatusLines } = await importSource(
    "packages/cli/src/tui.ts",
  );
  const { DeferredSandbox } = await importCore();
  const deferred = new DeferredSandbox(Promise.resolve(null));
  assert.equal(
    currentShellStatus({
      config: { sandbox: { mode: "required" } },
      sandbox: deferred,
      shellPreflightIssue: null,
    }),
    "srt-preparing",
  );
  assert.equal(
    currentShellStatus({
      config: { sandbox: { mode: "required" } },
      sandbox: deferred,
      shellPreflightIssue: "probe failed",
    }),
    "srt-failed",
  );
  assert.equal(
    currentShellStatus({
      config: { sandbox: { mode: "uncovered" } },
      sandbox: null,
      shellPreflightIssue: null,
    }),
    "disabled",
  );
  assert.equal(
    currentShellStatus({
      config: { sandbox: { mode: "required" } },
      sandbox: null,
      shellPreflightIssue: null,
    }),
    "srt-failed",
  );
  assert.equal(
    currentShellStatus({
      config: { sandbox: { mode: "required" } },
      sandbox: { sandboxed: true, descriptor: {} },
      shellPreflightIssue: null,
    }),
    "srt",
  );
  assert.deepEqual(
    sandboxStatusLines({
      config: { sandbox: { mode: "required" } },
      sandbox: deferred,
      shellPreflightIssue: null,
    }),
    ["srt sandbox preparing; shell tools will wait until it is ready"],
  );
  assert.deepEqual(
    sandboxStatusLines({
      config: { sandbox: { mode: "required" } },
      sandbox: null,
      shellPreflightIssue: "probe failed",
    }),
    ["srt shell unavailable: probe failed", "shell tools are disabled"],
  );
  assert.deepEqual(
    sandboxStatusLines({
      config: { sandbox: { mode: "required" } },
      sandbox: null,
      shellPreflightIssue: null,
    }),
    [
      "srt sandbox initialization failed; shell tools are disabled",
      "run codepunk doctor for details",
    ],
  );
  assert.equal(
    sandboxStatusLines({
      config: { sandbox: { mode: "required" } },
      sandbox: { sandboxed: true, descriptor: {} },
      shellPreflightIssue: null,
    }),
    undefined,
  );
});

test("image input records failure instead of completion when dispatch fails", async () => {
  const { createTuiExtension } = await importSource("packages/cli/src/tui.ts");
  await withTempDirectory("codepunk-tui-image-failure-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(project, "pixel.png"),
      Buffer.from(IMAGE_PNG_BASE64, "base64"),
    );
    const records = [];
    const runtime = {
      paths: {
        cwd: project,
        deliveryRoot: project,
        home,
        projectDir: path.join(home, "projects", "project"),
        projectConfigDir: path.join(project, ".codepunk"),
      },
      session: { sessionId: "session-image-failure" },
      ledger: {
        activeRunId: "run-image-failure",
        async append(record) {
          records.push(record);
          return record;
        },
      },
      config: {
        approval: { mode: "allow" },
        model: { enabled: [] },
        filesystem: { mode: "workspace" },
        tui: { keymap: { model_cycle: "off", background: "off" } },
      },
      autonomy: { profile: "standard" },
      policy: { writeSet: [], userRules: [], projectRules: [], layers: [] },
      approval: {
        async request() {
          return {
            approved: true,
            reason: "test approval",
            evidence: null,
          };
        },
      },
      host: {
        session: {
          async sendUserMessage() {
            sends += 1;
            throw new Error("test dispatch rejected");
          },
        },
      },
    };
    const commands = new Map();
    const notifications = [];
    let sends = 0;
    const pi = {
      on() {
        return () => {};
      },
      registerCommand(name, command) {
        commands.set(name, command);
      },
      registerShortcut() {},
      registerToolRenderer() {},
      getCommands() {
        return [];
      },
    };
    const state = {
      runtime,
      context: null,
      channel: { attach() {} },
      lastRunId: null,
      lastEvidence: 0,
      warningsShown: false,
      modelSelected: true,
    };
    const extension = createTuiExtension(state, {
      attach() {},
    });
    extension.factory(pi);
    const image = commands.get("image");
    assert.ok(image, "image command is not registered");
    await image.handler("pixel.png rejected prompt", {
      model: {
        provider: "local",
        id: "local-test",
        input: ["text", "image"],
      },
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    });
    assert.equal(sends, 1);
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, "image_input");
    assert.equal(records[0].outcome, "failed");
    assert.equal(records[0].rule, "product.image.input_failed");
    assert.equal(records[0].decision, "allow");
    assert.equal(records[0].exit_code, 1);
    assert.match(records[0].output_preview, /test dispatch rejected/u);
    assert.match(
      notifications.at(-1).message,
      /\/image failed: test dispatch rejected/u,
    );
  });
});

test("image input reports evidence failure after a successful dispatch", async () => {
  const { createTuiExtension } = await importSource("packages/cli/src/tui.ts");
  await withTempDirectory("codepunk-tui-image-evidence-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(project, "pixel.png"),
      Buffer.from(IMAGE_PNG_BASE64, "base64"),
    );
    let sends = 0;
    let appends = 0;
    const runtime = {
      paths: {
        cwd: project,
        deliveryRoot: project,
        home,
        projectDir: path.join(home, "projects", "project"),
        projectConfigDir: path.join(project, ".codepunk"),
      },
      session: { sessionId: "session-image-evidence" },
      ledger: {
        activeRunId: "run-image-evidence",
        async append() {
          appends += 1;
          throw new Error("test evidence rejected");
        },
      },
      config: {
        approval: { mode: "allow" },
        model: { enabled: [] },
        filesystem: { mode: "workspace" },
        tui: { keymap: { model_cycle: "off", background: "off" } },
      },
      autonomy: { profile: "standard" },
      policy: { writeSet: [], userRules: [], projectRules: [], layers: [] },
      approval: {
        async request() {
          return {
            approved: true,
            reason: "test approval",
            evidence: null,
          };
        },
      },
      host: {
        session: {
          async sendUserMessage() {
            sends += 1;
          },
        },
      },
    };
    const commands = new Map();
    const notifications = [];
    const pi = {
      on() {
        return () => {};
      },
      registerCommand(name, command) {
        commands.set(name, command);
      },
      registerShortcut() {},
      registerToolRenderer() {},
      getCommands() {
        return [];
      },
    };
    const state = {
      runtime,
      context: null,
      channel: { attach() {} },
      lastRunId: null,
      lastEvidence: 0,
      warningsShown: false,
      modelSelected: true,
    };
    const extension = createTuiExtension(state, {
      attach() {},
    });
    extension.factory(pi);
    const image = commands.get("image");
    assert.ok(image, "image command is not registered");
    await image.handler("pixel.png evidence prompt", {
      model: {
        provider: "local",
        id: "local-test",
        input: ["text", "image"],
      },
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    });
    assert.equal(sends, 1);
    assert.equal(appends, 1);
    assert.equal(notifications.at(-1).level, "warning");
    assert.match(
      notifications.at(-1).message,
      /image sent, but evidence could not be written: test evidence rejected/u,
    );
    assert.doesNotMatch(notifications.at(-1).message, /\/image failed/u);
  });
});

test("no-model onboarding treats the Pi unknown sentinel as absent", async () => {
  const { modelOnboardingMessage } = await importSource(
    "packages/cli/src/tui.ts",
  );
  const runtime = {
    config: { model: { provider: null, id: null } },
    host: { session: { model: { provider: "unknown", id: "unknown" } } },
  };
  const message = modelOnboardingMessage(runtime);
  assert.match(message, /No model configured\./u);
  assert.match(message, /\/model/u);
  assert.match(message, /codepunk models import/u);

  const primaryUnknown = modelOnboardingMessage({
    ...runtime,
    primaryModel: { provider: "unknown", id: "unknown" },
  });
  assert.match(primaryUnknown, /No model configured\./u);
  assert.doesNotMatch(primaryUnknown, /unknown\/unknown/u);
});

test("a failed persistent write allows only the current call", async () => {
  const { TuiApprovalChannel } = await importSource("packages/cli/src/tui.ts");
  const notifications = [];
  const selections = ["Always allow exact", "Save exact rule and allow"];
  const channel = new TuiApprovalChannel(true);
  channel.setWorkspaceTrusted(true);
  channel.attach({
    ui: {
      async select(_title, options) {
        const next = selections.shift();
        assert.ok(options.includes(next), `${next} is not in ${options}`);
        return next;
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  });
  channel.setPersistHandler(async () => false);
  const answer = await channel.ask({
    request_id: "request-1",
    nonce_sha256: `sha256:${"a".repeat(64)}`,
    ttl_ms: 30_000,
    worker_id: "local",
    session_id: "session-1",
    tool_call_id: "call-1",
    channel_id: "tui-main",
    command: "touch probe.txt",
    argv: ["touch", "probe.txt"],
    cwd: "/workspace",
    created_at: "2026-11-14T00:00:00.000Z",
    expires_at: "2026-11-14T00:00:30.000Z",
  });
  assert.equal(answer.answer, "allow");
  assert.equal(answer.scope, "once");
  assert.deepEqual(notifications, [
    {
      message: "the exact rule was not stored; allowing this call only",
      level: "warning",
    },
  ]);
});

test("untrusted TUI approval selector", async () => {
  const { TuiApprovalChannel } = await importSource("packages/cli/src/tui.ts");
  let title = "";
  let options = [];
  const channel = new TuiApprovalChannel(true);
  channel.attach({
    ui: {
      async select(nextTitle, nextOptions) {
        title = nextTitle;
        options = nextOptions;
        return "Allow once";
      },
      notify() {},
    },
  });
  const request = {
    request_id: "request-untrusted",
    nonce_sha256: `sha256:${"b".repeat(64)}`,
    ttl_ms: 30_000,
    worker_id: "local",
    session_id: "session-1",
    tool_call_id: "call-1",
    channel_id: "tui-main",
    tool: "bash",
    command: "touch probe.txt",
    argv: ["touch", "probe.txt"],
    cwd: "/workspace",
    created_at: "2026-11-14T00:00:00.000Z",
    expires_at: "2026-11-14T00:00:30.000Z",
  };

  channel.setWorkspaceTrusted(false);
  const deniedScope = await channel.ask(request);
  assert.equal(deniedScope.answer, "allow");
  assert.equal(deniedScope.scope, "once");
  assert.equal(title.includes("workspace is untrusted"), true);
  assert.deepEqual(options, [
    "Allow once",
    "Allow for session",
    "Deny",
    "Deny with guidance",
  ]);

  channel.setWorkspaceTrusted(true);
  await channel.ask(request);
  assert.ok(options.includes("Allow for session"));
  assert.ok(options.includes("Always allow exact"));
});

test("TuiApprovalChannel uses the inline approval card when available", async () => {
  const { TuiApprovalChannel } = await importSource("packages/cli/src/tui.ts");
  let customCalls = 0;
  let selectCalls = 0;
  const channel = new TuiApprovalChannel(true);
  channel.setWorkspaceTrusted(true);
  channel.attach({
    ui: {
      custom(factory) {
        customCalls += 1;
        return new Promise((resolve) => {
          const card = factory(
            {},
            { bold: (text) => text, fg: (_color, text) => text },
            {
              matches: (data, keybinding) =>
                keybinding === "tui.select.cancel" && data === "\u001b",
            },
            resolve,
          );
          card.handleInput("s");
        });
      },
      async select() {
        selectCalls += 1;
        return "Deny";
      },
      notify() {},
    },
  });
  const answer = await channel.ask({
    request_id: "request-inline",
    nonce_sha256: `sha256:${"c".repeat(64)}`,
    ttl_ms: 30_000,
    worker_id: "local",
    session_id: "session-1",
    tool_call_id: "call-1",
    channel_id: "tui-main",
    tool: "bash",
    command: "touch probe.txt",
    argv: ["touch", "probe.txt"],
    cwd: "/workspace",
    created_at: "2026-11-14T00:00:00.000Z",
    expires_at: "2026-11-14T00:00:30.000Z",
  });
  assert.equal(customCalls, 1);
  assert.equal(selectCalls, 0);
  assert.equal(answer.answer, "allow");
  assert.equal(answer.scope, "session");
});

test("TuiApprovalChannel keeps denial guidance on the inline path", async () => {
  const { TuiApprovalChannel } = await importSource("packages/cli/src/tui.ts");
  let prompts = 0;
  const channel = new TuiApprovalChannel(true);
  channel.setWorkspaceTrusted(true);
  channel.attach({
    ui: {
      custom(factory) {
        return new Promise((resolve) => {
          const card = factory(
            {},
            { bold: (text) => text, fg: (_color, text) => text },
            {
              matches: (data, keybinding) =>
                keybinding === "tui.select.cancel" && data === "\u001b",
            },
            resolve,
          );
          card.handleInput("g");
        });
      },
      async input(title) {
        prompts += 1;
        assert.match(title, /Denial guidance/u);
        return "  keep the original file  ";
      },
      async select() {
        throw new Error("inline approval must not fall back to select");
      },
      notify() {},
    },
  });
  const answer = await channel.ask({
    request_id: "request-guidance",
    nonce_sha256: `sha256:${"d".repeat(64)}`,
    ttl_ms: 30_000,
    worker_id: "local",
    session_id: "session-1",
    tool_call_id: "call-1",
    channel_id: "tui-main",
    tool: "bash",
    command: "touch probe.txt",
    argv: ["touch", "probe.txt"],
    cwd: "/workspace",
    created_at: "2026-11-14T00:00:00.000Z",
    expires_at: "2026-11-14T00:00:30.000Z",
  });
  assert.equal(prompts, 1);
  assert.equal(answer.answer, "deny");
  assert.equal(answer.scope, "once");
  assert.equal(answer.guidance, "keep the original file");
});

test("TuiApprovalChannel falls back to select when the inline card fails", async () => {
  const { TuiApprovalChannel } = await importSource("packages/cli/src/tui.ts");
  const channel = new TuiApprovalChannel(true);
  channel.setWorkspaceTrusted(true);
  channel.attach({
    ui: {
      async custom() {
        throw new Error("custom components are unavailable");
      },
      async select(_title, options) {
        assert.ok(options.includes("Allow once"));
        return "Allow once";
      },
      notify() {},
    },
  });
  const answer = await channel.ask({
    request_id: "request-fallback",
    nonce_sha256: `sha256:${"e".repeat(64)}`,
    ttl_ms: 30_000,
    worker_id: "local",
    session_id: "session-1",
    tool_call_id: "call-1",
    channel_id: "tui-main",
    tool: "bash",
    command: "touch probe.txt",
    argv: ["touch", "probe.txt"],
    cwd: "/workspace",
    created_at: "2026-11-14T00:00:00.000Z",
    expires_at: "2026-11-14T00:00:30.000Z",
  });
  assert.equal(answer.answer, "allow");
  assert.equal(answer.scope, "once");
});

test("the Codepunk help lists the real command surface", async () => {
  const { codepunkHelp } = await importSource("packages/cli/src/tui.ts");
  const help = codepunkHelp();
  assert.doesNotMatch(help, /\bPi\b|pi update|pi\.dev/u);
  assert.match(help, /\/model \[query\]/u);
  assert.match(help, /\/models\s+pick from recent or favorite models/u);
  assert.match(help, /\/favorite\s+toggle the current model in favorites/u);
  assert.match(help, /F2 cycles through recent models/u);
  assert.match(help, /\/permissions why -- <cmd>/u);
  assert.match(help, /\/plan \[request\|status\|on\|approve\|off\]/u);
  assert.doesNotMatch(help, /\/plan-mode/u);
  assert.doesNotMatch(help, /\/side\b/u);
  assert.doesNotMatch(help, /\/setting\b/u);
  assert.match(help, /\/goal \[text\|status\|pause\|resume\|clear\]/u);
  assert.match(help, /\/review\s+review the current diff/u);
  assert.match(help, /\/hooks \[status\]/u);
  assert.match(help, /\/ps\s+list background tasks/u);
  assert.match(help, /\/logs <id>\s+show bounded background task logs/u);
  assert.match(help, /\/stop <id>\s+stop a background task/u);
  assert.doesNotMatch(help, /\/cp-plan/u);
  assert.match(help, /\/todos\s+show the current todo list/u);
  assert.match(help, /\/init \[--update\]/u);
  assert.match(help, /\/settings\s+open interactive settings/u);
  assert.match(help, /\/diff\s+show staged and unstaged/u);
  assert.match(help, /\/commit \[message\]\s+review and create/u);
  assert.match(help, /\/mcp \[list\|add \[name\]\|remove/u);
  assert.match(help, /\/status\s+show model, session, permissions/u);
  assert.match(help, /\/help\s+show this command list/u);
  assert.doesNotMatch(help, /\/share/u);
});

test("user-visible TUI text blocks internal engine branding", async () => {
  const { assertUserVisibleTuiText, BrandedInteractiveMode } =
    await importSource("packages/cli/src/branded-interactive.ts");
  const base = Object.create(BrandedInteractiveMode.prototype);

  assertUserVisibleTuiText("Codepunk session ready");
  assertUserVisibleTuiText("Search all models");
  assert.throws(
    () => assertUserVisibleTuiText("Run pi update for Pi 1.6"),
    /internal engine brand/u,
  );
  assert.throws(
    () => assertUserVisibleTuiText("https://pi.dev/changelog"),
    /internal engine brand/u,
  );

  const brandedChildren = [];
  const brandedRenders = [];
  base.chatContainer = {
    addChild: (component) => brandedChildren.push(component),
  };
  base.ui = { requestRender: () => brandedRenders.push(null) };
  BrandedInteractiveMode.prototype.showNewVersionNotification.call(base, {
    version: "1.6.0",
  });
  BrandedInteractiveMode.prototype.showPackageUpdateNotification.call(base, [
    "example@2.0.0",
    "@earendil-works/pi-mcp@1.6.0",
    "Pi-engine@1.6.0",
  ]);
  assert.deepEqual(brandedChildren, []);
  assert.deepEqual(brandedRenders, []);

  const upstreamChildren = [];
  const upstreamRenders = [];
  const upstream = Object.create(
    Object.getPrototypeOf(BrandedInteractiveMode.prototype),
  );
  upstream.chatContainer = {
    addChild: (component) => upstreamChildren.push(component),
  };
  upstream.ui = { requestRender: () => upstreamRenders.push(null) };
  upstream.showNewVersionNotification({ version: "1.6.0" });
  upstream.showPackageUpdateNotification(["example@2.0.0"]);
  assert.ok(upstreamChildren.length > 0);
  assert.ok(upstreamRenders.length > 0);
});

test("MCP login target selection rejects unsafe or ambiguous servers", async () => {
  const { resolveMcpLoginTarget } = await importSource(
    "packages/cli/src/tui.ts",
  );
  const stdio = {
    name: "local",
    transport: "stdio",
    command: "node",
    args: [],
    cwd: "/tmp",
    env: {},
  };
  const oauth = {
    name: "remote",
    transport: "http",
    url: "https://example.invalid/mcp",
    headers: {},
  };
  const header = {
    name: "legacy",
    transport: "http",
    url: "https://example.invalid/legacy",
    headers: { Authorization: "Bearer token" },
  };
  const secondOauth = {
    name: "remote-two",
    transport: "http",
    url: "https://example.invalid/two",
    headers: {},
  };
  assert.equal(resolveMcpLoginTarget([stdio, oauth], undefined), oauth);
  assert.throws(
    () => resolveMcpLoginTarget([stdio], undefined),
    /none is configured/u,
  );
  assert.throws(
    () => resolveMcpLoginTarget([stdio, oauth, secondOauth, header], undefined),
    /requires a server name; candidates: remote, remote-two/u,
  );
  assert.throws(
    () => resolveMcpLoginTarget([stdio, oauth], "missing"),
    /is not configured/u,
  );
  assert.throws(
    () => resolveMcpLoginTarget([stdio, oauth], "local"),
    /uses stdio/u,
  );
  assert.throws(
    () => resolveMcpLoginTarget([stdio, oauth, header], "legacy"),
    /Authorization header/u,
  );
});

test("MCP command lines and headers parse without invoking a shell", async () => {
  const { splitMcpArguments, parseMcpHeader } = await importSource(
    "packages/cli/src/tui.ts",
  );
  assert.deepEqual(
    splitMcpArguments(
      'npx -y "@scope/server" --root "path with spaces" --flag=\'a b\'',
    ),
    ["npx", "-y", "@scope/server", "--root", "path with spaces", "--flag=a b"],
  );
  assert.deepEqual(splitMcpArguments('""'), [""]);
  assert.throws(
    () => splitMcpArguments('"unterminated'),
    /unterminated quote/u,
  );
  assert.deepEqual(parseMcpHeader("Authorization: Bearer ${MCP_TOKEN}"), {
    name: "Authorization",
    value: "Bearer ${MCP_TOKEN}",
  });
  assert.equal(parseMcpHeader("missing separator"), null);
  assert.equal(parseMcpHeader("Name:\r\nInjected"), null);
});

test("/init prompts the model with repository-evidence instructions", async () => {
  const { buildInitPrompt } = await importSource("packages/cli/src/tui.ts");
  const created = buildInitPrompt("/repo", null);
  assert.match(
    created,
    new RegExp(
      `^Create the repository guidance file at ${escapeRegExp(
        path.join("/repo", "AGENTS.md"),
      )}\\.`,
      "u",
    ),
  );
  assert.match(created, /Work from repository evidence only\./u);
  assert.match(created, /Do not modify\s+any file other than the target\./u);
  assert.match(created, /Keep it under 120 lines\./u);
  assert.doesNotMatch(created, /^## /mu);

  const updated = buildInitPrompt("/repo", "/repo/CLAUDE.md");
  assert.match(
    updated,
    /^Update the repository guidance file at \/repo\/CLAUDE\.md\./u,
  );
  assert.match(updated, /Preserve accurate existing content/u);
});

test("permissions why accepts exactly one leading separator", async () => {
  const { parsePermissionWhyCommand } = await importSource(
    "packages/cli/src/tui.ts",
  );
  assert.equal(parsePermissionWhyCommand("why date +%A"), "date +%A");
  assert.equal(parsePermissionWhyCommand("why -- date +%A"), "date +%A");
  assert.equal(
    parsePermissionWhyCommand("why -- touch probe.txt"),
    "touch probe.txt",
  );
  assert.equal(parsePermissionWhyCommand("why -- --flag"), "--flag");
  assert.equal(parsePermissionWhyCommand("why"), null);
  assert.equal(parsePermissionWhyCommand("why --"), null);
  assert.equal(parsePermissionWhyCommand("rules"), null);
});

test("autocomplete hides intercepted Pi builtins", async () => {
  const { filterInterceptedAutocomplete } = await importSource(
    "packages/cli/src/tui.ts",
  );
  const items = [
    { value: "model", label: "model" },
    { value: "plan", label: "plan" },
    { value: "settings", label: "settings" },
    { value: "share", label: "share" },
    { value: "resume", label: "resume" },
    { value: "new", label: "new" },
    { value: "fork", label: "fork" },
    { value: "clone", label: "clone" },
    { value: "tree", label: "tree" },
    { value: "permissions", label: "permissions" },
  ];
  assert.deepEqual(
    filterInterceptedAutocomplete(items).map((item) => item.value),
    ["model", "plan", "resume", "new", "fork", "clone", "tree", "permissions"],
  );
});

test("resume preflight rejects a session held by a live writer", async () => {
  const core = await importSource("packages/core/src/index.ts");
  const { sessionResumeIssue } = await importSource("packages/cli/src/tui.ts");
  await withTempDirectory("codepunk-resume-preflight-", async (dir) => {
    const projectId = "resume-preflight";
    const store = await core.SessionStore.create({
      rootDir: dir,
      cwd: dir,
      projectRoot: dir,
      projectId,
      sessionId: core.createUlid(),
    });
    const runtime = {
      paths: { home: dir, cwd: dir, deliveryRoot: dir, projectId },
    };
    assert.equal(await sessionResumeIssue(runtime, store.sessionId), null);
    const writer = await store.acquireWriter();
    try {
      const issue = await sessionResumeIssue(runtime, store.sessionId);
      assert.match(issue ?? "", /not resumable now/);
    } finally {
      await writer.release();
    }
  });
});

test("resume preflight accepts benign tails and rejects semantic tails", async () => {
  const { sessionResumeIssue } = await importSource("packages/cli/src/tui.ts");
  await withTempDirectory("codepunk-resume-tail-", async (root) => {
    const projectRoot = path.join(root, "project");
    await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
    const home = path.join(root, "home");
    const projectId = "resume-tail";
    const store = await core.SessionStore.create({
      rootDir: home,
      cwd: projectRoot,
      projectRoot,
      projectId,
      sessionId: core.createUlid(),
    });
    const writer = await store.acquireWriter();
    await store.saveAgentState(
      { type: "session", id: store.sessionId, cwd: projectRoot },
      [],
      { entries: [], leafId: null },
    );
    await store.append("context/loaded", {
      sources: [],
      warnings: [],
      total_bytes: 0,
      truncated: false,
    });
    await writer.release();
    const runtime = {
      paths: { home, cwd: projectRoot, deliveryRoot: projectRoot, projectId },
    };
    assert.equal(await sessionResumeIssue(runtime, store.sessionId), null);

    const semanticWriter = await store.acquireWriter();
    await store.append("approval/answer", {
      request_id: "request-1",
      answer: "deny",
      channel: "test",
      channel_id: "channel-1",
      nonce_sha256: `sha256:${"0".repeat(64)}`,
      worker_id: "worker-1",
      session_id: store.sessionId,
      tool_call_id: "tool-call-1",
      answered_at: "2026-11-24T00:00:00.000Z",
    });
    await semanticWriter.release();
    const issue = await sessionResumeIssue(runtime, store.sessionId);
    assert.match(
      issue ?? "",
      /2 uncommitted event\(s\) after the last agent-state snapshot/u,
    );
  });
});

test("the Pi builtin command table is loaded from the installed host", async () => {
  const { loadPiBuiltinSlashCommands } = await importSource(
    "packages/cli/src/tui.ts",
  );
  const commands = await loadPiBuiltinSlashCommands();
  assert.ok(commands.length > 0);
  assert.ok(commands.every((command) => command.name.length > 0));
  assert.ok(commands.some((command) => command.name === "model"));
  assert.ok(commands.some((command) => command.name === "quit"));
});

test("fallback selection still resolves to the configured physical model", async () => {
  const { modelOnboardingMessage, setTuiRuntime } = await importSource(
    "packages/cli/src/tui.ts",
  );
  const runtime = {
    config: {
      model: { provider: "openai", id: "primary" },
      tui: { header: true, footer: true, status: true },
    },
    primaryModel: { provider: "openai", id: "primary" },
    host: {
      session: {
        model: { provider: "codepunk", id: "auto" },
      },
    },
  };
  assert.equal(modelOnboardingMessage(runtime), undefined);

  const state = {
    runtime: null,
    context: null,
    channel: {},
    lastRunId: null,
    lastEvidence: 0,
    warningsShown: false,
    modelSelected: false,
  };
  setTuiRuntime(state, runtime);
  assert.equal(state.modelSelected, true);
});

test("waitForQuiet rejects a continuously repainting session", async () => {
  let output = "paint";
  const session = {
    output: () => {
      output += "!";
      return output;
    },
    child: { exitCode: null, signalCode: null },
  };

  await assert.rejects(waitForQuiet(session, 100, 250), (error) => {
    assert.match(error.message, /waitForQuiet timed out after \d+ms/u);
    assert.match(error.message, /quietMs=100/u);
    assert.match(error.message, /timeoutMs=250/u);
    assert.match(error.message, /exitCode=null/u);
    assert.match(error.message, /signal=null/u);
    assert.match(error.message, /lastOutput="paint!+"/u);
    return true;
  });
});

test("stopPty returns when a terminated pty never emits close", async () => {
  const { EventEmitter } = await import("node:events");
  await withTempDirectory("codepunk-stop-pty-close-", async (root) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = { destroy() {} };
    child.stdout = { destroy() {} };
    child.stderr = { destroy() {} };
    child.kill = () => {
      setTimeout(() => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
      }, 10);
      return true;
    };
    const session = {
      child,
      exited: new Promise(() => {}),
      terminated: new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      ),
      pidFile: path.join(root, "missing.pid"),
      output: () => "",
    };

    const startedAt = Date.now();
    await stopPty(session);
    assert.ok(Date.now() - startedAt < 1_000);
  });
});

test("stopPty reports a bounded cleanup timeout", async () => {
  const { EventEmitter } = await import("node:events");
  await withTempDirectory("codepunk-stop-pty-timeout-", async (root) => {
    const child = new EventEmitter();
    child.pid = 4243;
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = { destroy() {} };
    child.stdout = { destroy() {} };
    child.stderr = { destroy() {} };
    child.kill = () => true;
    const session = {
      child,
      exited: new Promise(() => {}),
      terminated: new Promise(() => {}),
      pidFile: path.join(root, "missing.pid"),
      output: () => "",
    };

    await assert.rejects(
      stopPty(session, { gracefulMs: 20, killMs: 30, closeMs: 10 }),
      (error) => {
        assert.match(error.message, /stopPty timed out after \d+ms/u);
        assert.match(error.message, /wrapperPid=4243/u);
        assert.match(error.message, /ptyPid=unknown/u);
        assert.match(error.message, /exitCode=null/u);
        assert.match(error.message, /lastOutput=""/u);
        return true;
      },
    );
  });
});
