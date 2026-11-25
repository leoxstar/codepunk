import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  assertPrivateFile,
  ensureBuilt,
  escapeRegExp,
  PRODUCT_VERSION,
  REPO_ROOT,
  trustWorkspace,
  withTempDirectory,
  withoutAmbientProviderEnv,
} from "./support/helpers.mjs";
import { importCore, importSource } from "./support/core.mjs";

const execFileAsync = promisify(execFile);
const core = await importCore();
const SRT_PTY_SKIP =
  process.platform === "win32"
    ? "the deferred sandbox PTY test runs on POSIX hosts"
    : await (async () => {
        const issue = await core.probeSrtSandbox({
          cwd: os.tmpdir(),
          workspaceRoot: os.tmpdir(),
          deliveryRoot: os.tmpdir(),
          codepunkHome: path.join(os.tmpdir(), "codepunk-pty-srt-home"),
          writeSet: ["."],
        });
        return issue === null ? false : `srt is unavailable: ${issue}`;
      })();
const PTY_RUNNER =
  process.platform === "win32"
    ? [
        process.execPath,
        path.join(REPO_ROOT, "tests", "support", "pty-run.mjs"),
      ]
    : ["python3", path.join(REPO_ROOT, "tests", "support", "pty-run.py")];

// These tests assert what the TUI shows before a model is configured, so the
// provider credentials of the machine running the suite must not reach the
// child process.
const BASE_ENV = withoutAmbientProviderEnv();
const IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAANCAIAAAAv2XlzAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAADQAAAACsJSLBAAACGUlEQVQoFQ2Py27TQABF5z1+JnaSIipEQUKCVgIJBKwoO8TH8BF8Enu2SEj8ABUFWqrEzcNJ6vd4xh7PkP25R/fAz58+IhoAYBwvqIRKFkvCOOeslQ1EJPScOs8gMC6j27yZTEZkEsWdxdgOo/GYOb0UDSH8sD8/f+/5/mQ6+/b1S5UXlMLe2OdnT0kYeJT72yyfp3fTOJ5Fo8EAL/DH0bTrZK/10TQOGRpM7/t+qzVCYPBc7nO2WKVlWXBijVGuS+typ2Sjyjs9DFEcEsriaCS0Qr2szaBdBk9mwX0fAdO3QnBGhJTQmng6BQgCiKXQRVYzYknfq7atrv/Ot0nyJnq50v335doPwpvLHy+ePcZcKyW1tLubxbqoW9clZjBV3c5vkiMKoexV01ZCFkU5o32Mh18XF/kuyzKBalnV6nK+J0labev8Oi3C4yjZ7FLVxJy8On1UJBZyVG3K31fLg/xk7EoD8krhbd3N00YBlpZiVVTWKkLwu9dnmDt/btchxU2jbld7zul4HNZ1ixEhFhHf5aofEMMIWs8hFMNoFP68+EekeBK5MUe+S91x7FFzEDGHQmQHgCiBNqv745mf7vPFbZpv9g4bsO3LRlxtqnUuPrw9xZ5LXAqsGZrOAnB4KdrOwk7uVkvG2cjjm1xkldBaH7Dddo8xQZ7DEACV1NbYrlPZoQwDqAdRCdOppmpED2YBuheghw/i/+orRkAlNmTDAAAAAElFTkSuQmCC";

async function startTextModelServer() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(raw));
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const send = (value) => {
        response.write(`data: ${JSON.stringify(value)}\n\n`);
      };
      send({
        id: "text-response",
        object: "chat.completion.chunk",
        created: 1,
        model: "local-test",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "CHILD_OK" },
            finish_reason: null,
          },
        ],
      });
      send({
        id: "text-response",
        object: "chat.completion.chunk",
        created: 1,
        model: "local-test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
        },
      });
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address);
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
}

async function startHeldModelServer() {
  const requests = [];
  let firstResponse = null;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(raw));
      if (requests.length === 1) {
        firstResponse = response;
        return;
      }
      sendTextResponse(
        response,
        requests.length === 2 ? "STEER_DONE" : "AFTER_DONE",
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address);
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    releaseFirst() {
      assert.ok(firstResponse);
      sendTextResponse(firstResponse, "FIRST_DONE");
      firstResponse = null;
    },
  };
}

function sendTextResponse(response, text) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  const send = (value) => {
    response.write(`data: ${JSON.stringify(value)}\n\n`);
  };
  send({
    id: "text-response",
    object: "chat.completion.chunk",
    created: 1,
    model: "local-test",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: text },
        finish_reason: null,
      },
    ],
  });
  send({
    id: "text-response",
    object: "chat.completion.chunk",
    created: 1,
    model: "local-test",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    },
  });
  response.write("data: [DONE]\n\n");
  response.end();
}

async function startReviewModelServer(responses, options = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      if (
        options.imageBase64 !== undefined &&
        Array.isArray(body.modalities) &&
        body.modalities.includes("image")
      ) {
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-cache",
        });
        response.end(
          JSON.stringify({
            id: "image-response",
            object: "chat.completion",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  images: [
                    {
                      type: "image_url",
                      image_url: {
                        url: `data:image/png;base64,${options.imageBase64}`,
                      },
                    },
                  ],
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 4,
              completion_tokens: 4,
              total_tokens: 8,
            },
          }),
        );
        return;
      }
      const text =
        responses[Math.min(requests.length - 1, responses.length - 1)] ??
        responses.at(-1) ??
        "not json";
      sendTextResponse(response, text);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address);
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
}

async function startPlanRoundModelServer() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const send = (value) => {
        response.write(`data: ${JSON.stringify(value)}\n\n`);
      };
      const hasToolResult = body.messages.some(
        (message) => message.role === "tool",
      );
      if (!hasToolResult) {
        send({
          id: "plan-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: "call-plan",
                    type: "function",
                    function: {
                      name: "plan",
                      arguments: JSON.stringify({
                        plan: [
                          {
                            step: "inspect the repository",
                            status: "in_progress",
                          },
                          {
                            step: "implement the health check",
                            status: "pending",
                          },
                        ],
                      }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({
          id: "plan-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        });
      } else {
        send({
          id: "plan-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "PLAN_RECORDED" },
              finish_reason: null,
            },
          ],
        });
        send({
          id: "plan-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        });
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address);
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
}

async function startToolProjectionModelServer() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const send = (value) => {
        response.write(`data: ${JSON.stringify(value)}\n\n`);
      };
      const toolResults = body.messages.filter(
        (message) => message.role === "tool",
      ).length;
      const calls = [
        {
          id: "call-search",
          name: "search",
          arguments: JSON.stringify({ mode: "ls", query: "note", path: "." }),
        },
        {
          id: "call-todo",
          name: "todo",
          arguments: JSON.stringify({
            todos: [
              { content: "inspect the repository", status: "in_progress" },
              { content: "implement the health check", status: "pending" },
            ],
          }),
        },
        {
          id: "call-plan",
          name: "plan",
          arguments: JSON.stringify({
            plan: [
              { step: "inspect the repository", status: "in_progress" },
              { step: "implement the health check", status: "pending" },
            ],
          }),
        },
      ];
      const call = calls[toolResults];
      if (call !== undefined) {
        send({
          id: "projection-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: call.id,
                    type: "function",
                    function: {
                      name: call.name,
                      arguments: call.arguments,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({
          id: "projection-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        });
      } else {
        send({
          id: "projection-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "TOOLS_PROJECTED" },
              finish_reason: null,
            },
          ],
        });
        send({
          id: "projection-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        });
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address);
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
}

async function startWriteModelServer({ path: targetPath, content }) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const send = (value) => {
        response.write(`data: ${JSON.stringify(value)}\n\n`);
      };
      const hasToolResult = body.messages.some(
        (message) => message.role === "tool",
      );
      if (!hasToolResult) {
        send({
          id: "write-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: "call-write",
                    type: "function",
                    function: {
                      name: "write",
                      arguments: JSON.stringify({
                        path: targetPath,
                        content,
                      }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({
          id: "write-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        });
      } else {
        send({
          id: "write-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "WRITE_DONE" },
              finish_reason: null,
            },
          ],
        });
        send({
          id: "write-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "local-test",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 2,
            total_tokens: 6,
          },
        });
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address);
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
}

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
  assert.deepEqual(options, ["Allow once", "Deny", "Deny with guidance"]);

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
  assert.match(
    help,
    /\/plan \[request\]\s+show the current plan, or plan a request read-only/u,
  );
  assert.match(help, /\/plan-mode \[status\|on\|approve\|off\]/u);
  assert.match(help, /show, enter, approve, or exit plan mode/u);
  assert.match(help, /\/goal \[text\|status\|pause\|resume\|clear\]/u);
  assert.match(help, /\/review\s+review the current diff/u);
  assert.match(help, /\/hooks \[status\]/u);
  assert.match(help, /\/ps\s+list background tasks/u);
  assert.match(help, /\/logs <id>\s+show bounded background task logs/u);
  assert.match(help, /\/stop <id>\s+stop a background task/u);
  assert.doesNotMatch(help, /\/cp-plan/u);
  assert.match(help, /\/todos\s+show the current todo list/u);
  assert.match(help, /\/init \[--update\]/u);
  assert.match(help, /\/config, \/settings\s+show file-backed/u);
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

function startPty(command, args, { cwd, env }) {
  const pidFile = path.join(
    env.CODEPUNK_HOME,
    `pty-child-${process.pid}-${Date.now()}.pid`,
  );
  const child = spawn(
    PTY_RUNNER[0],
    [...PTY_RUNNER.slice(1), command, ...args],
    {
      cwd,
      env: { ...env, PTY_RUN_PID_FILE: pidFile },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  const exited = new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  // `close` waits for stdio EOF, which a descendant can hold open after the
  // process itself is gone. `terminated` reports the process exit separately.
  const terminated = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exited,
    terminated,
    pidFile,
    output: () => output,
  };
}

async function waitForPtyExit(exited, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function killPtyGroup(session) {
  let pid;
  try {
    pid = Number.parseInt(await fs.readFile(session.pidFile, "utf8"), 10);
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      execFile(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 5_000 },
        () => resolve(),
      );
    });
    return pid;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
  return pid;
}

async function stopPty(
  session,
  { gracefulMs = 2_000, killMs = 5_000, closeMs = 250 } = {},
) {
  const startedAt = Date.now();
  let ptyPid = null;
  try {
    ptyPid = await killPtyGroup(session);
    if (session.child.exitCode === null && session.child.signalCode === null) {
      session.child.kill("SIGTERM");
      const graceful = await waitForPtyExit(session.terminated, gracefulMs);
      if (graceful === null) {
        session.child.kill("SIGKILL");
        const forced = await waitForPtyExit(session.terminated, killMs);
        if (forced === null) {
          throw new Error(
            [
              `stopPty timed out after ${Date.now() - startedAt}ms`,
              `wrapperPid=${session.child.pid ?? "unknown"}`,
              `ptyPid=${ptyPid ?? "unknown"}`,
              `exitCode=${session.child.exitCode}`,
              `signal=${session.child.signalCode}`,
              `lastOutput=${JSON.stringify(session.output().slice(-4000))}`,
            ].join(" "),
          );
        }
      }
    }
    // A process that has terminated may never close its stdio pipes while a
    // descendant holds them. Do not let cleanup wait for that indefinitely.
    await waitForPtyExit(session.exited, closeMs);
  } finally {
    session.child.stdin?.destroy();
    session.child.stdout?.destroy();
    session.child.stderr?.destroy();
    session.child.unref?.();
    await fs.rm(session.pidFile, { force: true });
  }
}

async function waitForOutput(session, marker, label) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (stripAnsi(session.output()).includes(marker)) {
      return;
    }
    if (session.child.exitCode !== null) {
      throw new Error(
        `${label}: TUI exited before rendering ${marker}\n${stripAnsi(
          session.output(),
        ).slice(-4000)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `${label}: timed out waiting for ${marker}\n${session.output().slice(-4000)}`,
  );
}

async function waitForOutputAfter(session, mark, marker, label) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (stripAnsi(session.output().slice(mark)).includes(marker)) {
      return;
    }
    if (session.child.exitCode !== null) {
      throw new Error(
        `${label}: TUI exited before rendering ${marker}\n${stripAnsi(
          session.output(),
        ).slice(-4000)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `${label}: timed out waiting for ${marker}\n${session.output().slice(-4000)}`,
  );
}

function stripAnsi(value) {
  return value.replace(
    // CSI, OSC, and simple two-byte escape sequences emitted by the TUI.
    /\u001b(?:\][^\u0007]*?(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/gu,
    "",
  );
}

async function waitForAnyOutputAfter(session, mark, markers, label) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const output = session.output().slice(mark);
    const matched = markers.find((marker) => output.includes(marker));
    if (matched !== undefined) {
      return matched;
    }
    if (session.child.exitCode !== null) {
      throw new Error(`${label}: TUI exited before rendering a marker`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label}: timed out waiting for ${markers.join(" or ")}`);
}

async function submitUserBashWhenIdle(session, command, label) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const mark = session.output().length;
    session.child.stdin.write(`${command}\r`);
    const matched = await waitForAnyOutputAfter(
      session,
      mark,
      ["Approval required", "is already running"],
      label,
    );
    if (matched === "Approval required") {
      return;
    }
    session.child.stdin.write("\u0015");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: the shell stayed busy`);
}

async function runCommand(session, command, marker) {
  session.child.stdin.write(`${command}\r`);
  await waitForOutput(session, marker, command);
}

async function waitForQuiet(session, quietMs = 100, timeoutMs = 10_000) {
  const startedAt = Date.now();
  let lastLength = session.output().length;
  let quietSince = Date.now();
  while (Date.now() - quietSince < quietMs) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        [
          `waitForQuiet timed out after ${Date.now() - startedAt}ms`,
          `quietMs=${quietMs}`,
          `timeoutMs=${timeoutMs}`,
          `exitCode=${session.child.exitCode}`,
          `signal=${session.child.signalCode}`,
          `lastOutput=${JSON.stringify(session.output().slice(-4000))}`,
        ].join(" "),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    const length = session.output().length;
    if (length !== lastLength) {
      lastLength = length;
      quietSince = Date.now();
    }
  }
}

async function runCommandAfter(session, command, marker) {
  // A command sent while the previous full-screen repaint is still streaming
  // can have the top of its panel written before `mark`, which makes the
  // assertion fail even though the content was rendered.
  await waitForQuiet(session);
  const mark = session.output().length;
  session.child.stdin.write(`${command}\r`);
  await waitForOutputAfter(session, mark, marker, command);
  // Let the terminal finish repainting the notification before the next
  // synthetic key sequence reaches the editor. A fixed delay can race with a
  // large redraw and drop the next command; a quiet period follows the paint.
  await waitForQuiet(session, 250);
}

async function closeOverlay(session) {
  session.child.stdin.write("\u001b");
  await waitForQuiet(session, 250);
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value !== null && value !== undefined && value !== false) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function readEvidence(home) {
  const entries = await fs.readdir(home, { recursive: true }).catch((error) => {
    if (["ENOENT", "EPERM", "EBUSY"].includes(error?.code)) {
      return [];
    }
    throw error;
  });
  const records = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl") || !entry.includes("evidence")) {
      continue;
    }
    const lines = (await fs.readFile(path.join(home, entry), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    for (const line of lines) {
      records.push(JSON.parse(line));
    }
  }
  return records;
}

async function waitForBashResult(home, command, minimumMatches = 1) {
  return waitFor(async () => {
    let matches = 0;
    let latest = null;
    const entries = await fs.readdir(home, { recursive: true });
    for (const entry of entries) {
      if (!entry.endsWith("session.jsonl")) {
        continue;
      }
      const lines = (await fs.readFile(path.join(home, entry), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0);
      for (const line of lines) {
        const record = JSON.parse(line);
        if (
          record.type === "codepunk/event" &&
          record.kind === "bash/result" &&
          record.data?.command === command
        ) {
          matches += 1;
          latest = record;
        }
      }
    }
    return matches >= minimumMatches ? latest : null;
  }, `bash result for ${command} (at least ${minimumMatches})`);
}

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

test("a real pty renders codepunk chrome and exit hints", async () => {
  await withTempDirectory("codepunk-tui-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await waitForQuiet(session, 250);
      const output = stripAnsi(session.output());
      assert.match(output, /codepunk · auto\/auto · session [0-9A-Z]{10}/u);
      assert.match(
        output,
        /permissions custom · trust trusted · shell disabled · evidence 0/u,
      );
      assert.match(output, /session [0-9A-Z]{10}/u);
      assert.doesNotMatch(output, /project [0-9a-f]{16}/u);
      assert.doesNotMatch(output, /next sandbox uncovered · fs workspace/u);
      assert.doesNotMatch(output, /v1\.5\.2/u);
      session.child.stdin.write("/quit\r");
      const exited = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(exited, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test(
  "a real pty remains interactive while the srt sandbox prepares",
  { skip: SRT_PTY_SKIP },
  async () => {
    await withTempDirectory("codepunk-tui-srt-preparing-", async (root) => {
      const project = path.join(root, "project");
      const home = path.join(root, "home");
      await fs.mkdir(project);
      await fs.mkdir(home);
      await fs.writeFile(
        path.join(home, "config.toml"),
        '[sandbox]\nmode = "required"\n',
      );
      await execFileAsync("git", ["init", "-q"], { cwd: project });
      const cli = await ensureBuilt();
      const sandboxMarker = path.join(home, "sandbox-ready");
      const session = startPty(
        process.execPath,
        [
          "--import",
          path.join(REPO_ROOT, "tests", "support", "slow-sandbox.mjs"),
          cli,
        ],
        {
          cwd: project,
          env: {
            ...BASE_ENV,
            CODEPUNK_HOME: home,
            CODEPUNK_TEST_SANDBOX_MARKER: sandboxMarker,
            TERM: "xterm-256color",
            NO_COLOR: "1",
          },
        },
      );
      try {
        await waitForOutput(
          session,
          "srt sandbox preparing; shell tools will wait until it is ready",
          "sandbox preparing",
        );
        assert.notEqual(
          await fs.readFile(sandboxMarker, "utf8").catch(() => null),
          "ready",
          "the sandbox finished before the preparing status was rendered",
        );

        const mark = session.output().length;
        session.child.stdin.write("/help\r");
        await waitForOutputAfter(
          session,
          mark,
          "show this command list",
          "interactive /help",
        );
        await waitForOutput(session, "shell srt ·", "sandbox ready status");

        const markerStarted = Date.now();
        while (
          Date.now() - markerStarted < 20_000 &&
          (await fs.readFile(sandboxMarker, "utf8").catch(() => null)) !==
            "ready"
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(
          await fs.readFile(sandboxMarker, "utf8").catch(() => null),
          "ready",
          "the sandbox never reported readiness",
        );

        session.child.stdin.write("/quit\r");
        const exited = await Promise.race([
          session.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(exited, { code: 0, signal: null });
      } finally {
        await stopPty(session);
      }
    });
  },
);

test("a real pty shows the working tree diff", async () => {
  await withTempDirectory("codepunk-tui-diff-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: project,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], {
      cwd: project,
    });
    await fs.writeFile(path.join(project, "tracked.txt"), "one\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: project });
    await execFileAsync("git", ["commit", "-q", "-m", "initial"], {
      cwd: project,
    });
    await fs.writeFile(path.join(project, "tracked.txt"), "two\n");
    await fs.writeFile(path.join(project, "new.txt"), "new\n");
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const diffMark = session.output().length;
      await runCommandAfter(session, "/diff", "Working tree diff");
      const output = session.output().slice(diffMark);
      assert.match(output, /M tracked\.txt/u);
      assert.match(output, /\?\? new\.txt/u);
      assert.match(output, /\+two/u);
      assert.match(output, /-one/u);
      assert.match(output, /untracked files \(2; no patch until staged\)/u);
      assert.match(output, /esc close/u);
      assert.match(output, /│/u);
      await closeOverlay(session);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
      // Commands alone are not a conversation, so no resume hint is printed.
      assert.doesNotMatch(
        stripAnsi(session.output()),
        /To resume this session/u,
      );
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty covers the plan mode command surface", async () => {
  await withTempDirectory("codepunk-tui-plan-mode-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await runCommandAfter(session, "/plan-mode status", "Plan mode: off");
      await runCommandAfter(session, "/plan-mode on", "Plan mode: planning");
      await runCommandAfter(
        session,
        "/plan-mode approve",
        "/plan-mode failed: No plan to approve",
      );
      await runCommandAfter(session, "/plan-mode off", "Plan mode: off");
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty plans a requested task in plan mode", async () => {
  await withTempDirectory("codepunk-tui-plan-request-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const model = await startPlanRoundModelServer();
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      await runCommandAfter(
        session,
        "/plan add a health check",
        "Plan mode: planning",
      );
      await waitForOutput(session, "PLAN_RECORDED", "plan request");
      const planOutput = stripAnsi(session.output());
      assert.match(
        planOutput,
        /plan · 2 steps · in progress: inspect the repository/u,
      );
      assert.match(planOutput, /plan · 2 steps · sha [0-9a-f]{12}…/u);
      await runCommandAfter(session, "/plan", "[>] inspect the repository");
      await runCommandAfter(
        session,
        "/plan-mode status",
        "Plan mode: planning",
      );

      const sent = JSON.stringify(model.requests[0]);
      assert.match(sent, /add a health check/u);
      assert.match(sent, /plan tool/u);

      const eventFiles = (await fs.readdir(home, { recursive: true })).filter(
        (entry) => entry.endsWith("session.jsonl"),
      );
      assert.equal(eventFiles.length, 1);
      const events = (await fs.readFile(path.join(home, eventFiles[0]), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      const planEvents = events.filter((entry) => entry.kind === "plan/update");
      assert.equal(planEvents.length, 1);
      assert.deepEqual(
        planEvents[0].data.steps.map((step) => step.step),
        ["inspect the repository", "implement the health check"],
      );
      assert.equal(
        events.filter((entry) => entry.kind === "plan_mode/update").at(-1).data
          .mode,
        "planning",
      );

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
      // A session with a conversation ends with Codepunk's resume command,
      // written after Pi has restored the terminal.
      assert.ok(
        events.some((entry) => entry.kind === "user/input"),
        "the plan request records a conversation",
      );
      const sessionId = path.basename(path.dirname(eventFiles[0]));
      assert.match(
        stripAnsi(session.output()),
        new RegExp(`To resume this session: codepunk resume ${sessionId}`, "u"),
      );
    } finally {
      await stopPty(session);
      model.server.close();
    }
  });
});

test("a real pty covers Goal, hooks, and structured review events", async () => {
  await withTempDirectory("codepunk-tui-p0-capabilities-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: project,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], {
      cwd: project,
    });
    await fs.writeFile(path.join(project, "tracked.txt"), "one\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: project });
    await execFileAsync("git", ["commit", "-q", "-m", "initial"], {
      cwd: project,
    });
    await fs.writeFile(path.join(project, "tracked.txt"), "two\n");

    const model = await startReviewModelServer([
      JSON.stringify({
        findings: [
          {
            severity: "high",
            file: "tracked.txt",
            line: 1,
            reason: "the changed value loses the original state",
          },
        ],
      }),
      "REVIEW_FAILED_NOT_JSON",
    ]);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(home, "hooks.toml"),
      [
        "version = 1",
        "[[hooks]]",
        'name = "startup"',
        'event = "session_start"',
        `argv = ${JSON.stringify([process.execPath, "-e", "process.exit(0)"])}`,
        "timeout_ms = 5000",
        "max_output_bytes = 1024",
        "fail_closed = true",
        "",
      ].join("\n"),
    );

    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      await runCommandAfter(
        session,
        "/goal Ship the capability wave",
        "Goal: active",
      );
      assert.match(session.output(), /Ship the capability wave/u);
      await runCommandAfter(session, "/goal pause", "Goal: paused");
      await runCommandAfter(session, "/goal resume", "Goal: active");
      await runCommandAfter(session, "/hooks status", "Lifecycle hooks");
      assert.match(session.output(), /user hook startup passed/u);

      await runCommandAfter(session, "/review", "Structured review");
      assert.match(session.output(), /HIGH tracked\.txt:1/u);
      assert.match(session.output(), /loses the original state/u);
      await runCommandAfter(
        session,
        "/review",
        "/review failed: review model did not return a JSON object",
      );
      await runCommandAfter(session, "/goal clear", "No goal is active");

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });

      const eventFiles = (await fs.readdir(home, { recursive: true })).filter(
        (entry) => entry.endsWith("session.jsonl"),
      );
      assert.equal(eventFiles.length, 1);
      const events = (await fs.readFile(path.join(home, eventFiles[0]), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type === "codepunk/event");
      assert.equal(
        events.some(
          (entry) =>
            entry.kind === "goal/update" && entry.data.action === "set",
        ),
        true,
      );
      assert.equal(
        events.some(
          (entry) =>
            entry.kind === "goal/update" && entry.data.action === "clear",
        ),
        true,
      );
      assert.equal(
        events.some(
          (entry) =>
            entry.kind === "hook/result" &&
            entry.data.hook_name === "startup" &&
            entry.data.outcome === "passed",
        ),
        true,
      );
      assert.equal(
        events.some((entry) => entry.kind === "review/result"),
        true,
      );
      assert.equal(
        events.some((entry) => entry.kind === "review/error"),
        true,
      );
    } finally {
      await stopPty(session);
      model.server.close();
    }
  });
});

test(
  "a real pty lists, reads, and stops durable background tasks",
  {
    skip:
      process.platform === "win32"
        ? "background tasks require POSIX process groups"
        : false,
  },
  async () => {
    await withTempDirectory("codepunk-tui-background-", async (root) => {
      const project = path.join(root, "project");
      const home = path.join(root, "home");
      await fs.mkdir(project);
      await fs.mkdir(home);
      await execFileAsync("git", ["init", "-q"], { cwd: project });
      await fs.writeFile(
        path.join(home, "config.toml"),
        '[sandbox]\nmode = "uncovered"\n',
      );
      const projectId = core.projectIdFor(project);
      const paths = core.projectPaths(
        { cwd: project, deliveryRoot: project, projectId },
        home,
      );
      await core.ensureProjectRegistration(
        {
          cwd: project,
          deliveryRoot: project,
          projectId,
          isGitRepository: true,
        },
        paths,
      );
      const seed = new core.BackgroundTaskManager({
        paths,
        sessionId: "seed-session",
      });
      const started = await seed.start({
        id: "tui-background",
        title: "TUI background task",
        command: process.execPath,
        args: ["-e", 'process.stdout.write("BGREADY\\n"); process.exit(0);'],
        cwd: project,
      });
      await seed.wait(started.id);

      const cli = await ensureBuilt();
      const session = startPty(process.execPath, [cli], {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      });
      try {
        await waitForOutput(session, "codepunk · auto/auto", "startup");
        await runCommandAfter(session, "/ps", "tui-background");
        await runCommandAfter(session, "/logs tui-background", "stdout:");
        assert.match(session.output(), /BGREADY/u);
        await runCommandAfter(
          session,
          "/stop tui-background",
          "Background task tui-background: completed",
        );
        session.child.stdin.write("/quit\r");
        const result = await Promise.race([
          session.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(result, { code: 0, signal: null });
      } finally {
        await stopPty(session);
      }
    });
  },
);

test("a real pty lists presets and roles and applies a preset", async () => {
  await withTempDirectory("codepunk-tui-p1-commands-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const model = await startReviewModelServer(["not json"]);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
                input: ["text", "image"],
              },
            ],
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(home, "presets.toml"),
      [
        "version = 1",
        "[[preset]]",
        'name = "reader"',
        'description = "Read-only review"',
        'model = "local/local-test"',
        'thinking = "low"',
        'permission = "read-only"',
        'tools = ["read", "search"]',
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(home, "roles.toml"),
      [
        "version = 1",
        "[roles]",
        'plan = "local/local-test"',
        "",
        "[[pool]]",
        'name = "subagent"',
        'models = ["local/local-test"]',
        "max = 1",
        "",
      ].join("\n"),
    );

    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      await runCommandAfter(session, "/roles status", "Model roles");
      assert.match(session.output(), /plan: local\/local-test \(user\)/u);
      assert.match(session.output(), /subagent: max 1/u);
      await runCommandAfter(session, "/preset list", "reader");
      assert.match(session.output(), /Read-only review/u);
      await runCommandAfter(session, "/preset use reader", "preset reader");
      assert.match(session.output(), /permission read-only/u);
      assert.match(session.output(), /tools read,search/u);
      await runCommandAfter(session, "/recap all", "Session recap");
      assert.match(session.output(), /autonomy\/profile: 1/u);
      assert.match(session.output(), /trust\/decision: 1/u);
      if (process.platform !== "win32") {
        await runCommandAfter(
          session,
          "/btw summarize the current state",
          "btw task queued",
        );
        await runCommandAfter(session, "/ps", "Side tasks");
        assert.match(session.output(), /btw\s+budget=1/u);
        await waitFor(async () => {
          const files = (
            await fs.readdir(path.join(home, "projects"), { recursive: true })
          ).filter((entry) => entry.endsWith(".jsonl"));
          const sideFile = files.find((entry) =>
            entry.includes("product/side-tasks"),
          );
          if (sideFile === undefined) {
            return false;
          }
          const lines = (
            await fs.readFile(path.join(home, "projects", sideFile), "utf8")
          )
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          return lines.some(
            (entry) =>
              entry.type === "codepunk/side-task" &&
              (entry.status === "completed" || entry.status === "failed"),
          );
        }, "side task settlement");
      }
      const imagePath = path.join(project, "pixel.png");
      await fs.writeFile(imagePath, Buffer.from(IMAGE_PNG_BASE64, "base64"));
      await runCommandAfter(
        session,
        "/image pixel.png what is in this image",
        "image confirmed",
      );
      assert.match(session.output(), /type: image\/png/u);
      await waitFor(
        () =>
          model.requests.some((request) =>
            JSON.stringify(request).includes(
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAANCAI",
            ),
          ),
        "image request",
      );
      const imageRecord = await waitFor(
        async () =>
          (await readEvidence(home)).find(
            (record) =>
              record.tool === "image_input" &&
              record.path_check.target === "pixel.png",
          ) ?? null,
        "image input evidence",
      );
      assert.equal(imageRecord.decision, "allow");
      assert.equal(
        imageRecord.output_sha256,
        `sha256:${createHash("sha256")
          .update(Buffer.from(IMAGE_PNG_BASE64, "base64"))
          .digest("hex")}`,
      );
      assert.match(
        imageRecord.output_preview,
        /bytes: 687\nsha256: sha256:[0-9a-f]{64}\nredactions: path/u,
      );
      await waitForQuiet(session, 500);
      const requestsBeforeMissingImage = model.requests.length;
      await runCommandAfter(
        session,
        "/image missing.png",
        "image input was not found",
      );
      const failedImageRecord = await waitFor(
        async () =>
          (await readEvidence(home)).find(
            (record) =>
              record.tool === "image_input" &&
              record.outcome === "failed" &&
              record.rule === "product.image.input_failed" &&
              record.path_check.target === "missing.png",
          ) ?? null,
        "failed image input evidence",
      );
      assert.equal(failedImageRecord.decision, "allow");
      assert.equal(failedImageRecord.exit_code, 1);
      assert.equal(failedImageRecord.effects.fs, "none");
      assert.equal(failedImageRecord.effects.network, false);
      assert.equal(model.requests.length, requestsBeforeMissingImage);
      await runCommandAfter(
        session,
        "/image-gen a red fox in snow",
        "no image generation adapter is configured",
      );
      const rejectedImageGeneration = await waitFor(
        async () =>
          (await readEvidence(home)).find(
            (record) =>
              record.tool === "image_generate" &&
              record.decision === "deny" &&
              record.rule === "product.image.generate_denied",
          ) ?? null,
        "rejected image generation evidence",
      );
      assert.equal(rejectedImageGeneration.outcome, "denied");
      assert.equal(rejectedImageGeneration.approval, null);
      assert.match(
        rejectedImageGeneration.output_preview,
        /no image generation adapter is configured/u,
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
      model.server.close();
    }
  });
});

test("a real pty generates an image through a configured image model", async () => {
  await withTempDirectory("codepunk-tui-image-gen-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const model = await startReviewModelServer(["not json"], {
      imageBase64: IMAGE_PNG_BASE64,
    });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
                input: ["text"],
              },
            ],
          },
          openrouter: {
            name: "OpenRouter",
            baseUrl: model.baseUrl,
            apiKey: "test",
          },
        },
      }),
    );

    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      const mark = session.output().length;
      const command =
        "/image-gen --model openrouter/black-forest-labs/flux.2-pro a red fox in snow";
      session.child.stdin.write(`${command}\r`);
      await waitForOutputAfter(
        session,
        mark,
        "Approval required",
        "image generation approval prompt",
      );
      assert.match(
        stripAnsi(session.output().slice(mark)),
        /command: image-generate openrouter\/black-forest-labs\/flux\.2-pro/u,
      );
      session.child.stdin.write("a");
      await waitForOutputAfter(
        session,
        mark,
        "image generated:",
        "image generation result",
      );

      const record = await waitFor(
        async () =>
          (await readEvidence(home)).find(
            (entry) =>
              entry.tool === "image_generate" &&
              entry.command ===
                "image-generate openrouter/black-forest-labs/flux.2-pro",
          ) ?? null,
        "image generation evidence",
      );
      assert.equal(record.decision, "allow");
      assert.equal(record.outcome, "completed");
      assert.notEqual(record.approval, null);
      assert.equal(record.approval.answer, "allow");
      assert.match(record.output_sha256, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(record.after_sha256, record.output_sha256);
      assert.equal(record.effects.network, true);
      assert.equal(record.effects.fs, "write");
      assert.match(
        record.output_ref,
        /^artifacts\/images\/[0-9a-f]{24}\.png$/u,
      );

      const artifactEntry = (await fs.readdir(home, { recursive: true })).find(
        (entry) => entry.split(path.sep).join("/").endsWith(record.output_ref),
      );
      assert.ok(artifactEntry, "generated artifact is missing");
      const bytes = await fs.readFile(path.join(home, artifactEntry));
      assert.equal(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        record.output_sha256,
      );
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.ok(
        model.requests.some(
          (request) =>
            Array.isArray(request.modalities) &&
            request.modalities.includes("image") &&
            JSON.stringify(request).includes("a red fox in snow"),
        ),
        "image generation request is missing",
      );

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });

      const imageRequestsBeforeScope = model.requests.filter(
        (request) =>
          Array.isArray(request.modalities) &&
          request.modalities.includes("image"),
      ).length;
      await fs.writeFile(
        path.join(home, "config.toml"),
        [
          "[sandbox]",
          'mode = "uncovered"',
          "",
          "[model]",
          'enabled = ["local/local-test"]',
          "",
        ].join("\n"),
      );
      const scoped = startPty(
        process.execPath,
        [cli, "--model", "local/local-test"],
        {
          cwd: project,
          env: {
            ...BASE_ENV,
            CODEPUNK_HOME: home,
            PI_OFFLINE: "1",
            TERM: "xterm-256color",
            NO_COLOR: "1",
          },
        },
      );
      try {
        await waitForOutput(
          scoped,
          "codepunk · local/local-test",
          "scoped startup",
        );
        await runCommandAfter(
          scoped,
          "/image-gen --model openrouter/black-forest-labs/flux.2-pro a blocked fox",
          "model.enabled",
        );
        const denied = await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (entry) =>
                entry.tool === "image_generate" &&
                entry.decision === "deny" &&
                entry.rule === "product.image.generate_denied" &&
                entry.command ===
                  "image-generate openrouter/black-forest-labs/flux.2-pro",
            ) ?? null,
          "image generation scope denial",
        );
        assert.equal(denied.outcome, "denied");
        assert.match(denied.output_preview, /model\.enabled/u);
        assert.equal(
          model.requests.filter(
            (request) =>
              Array.isArray(request.modalities) &&
              request.modalities.includes("image"),
          ).length,
          imageRequestsBeforeScope,
        );
        scoped.child.stdin.write("/quit\r");
        const scopedResult = await Promise.race([
          scoped.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(scopedResult, { code: 0, signal: null });
      } finally {
        await stopPty(scoped);
      }

      await fs.writeFile(
        path.join(home, "config.toml"),
        [
          "[sandbox]",
          'mode = "uncovered"',
          "",
          "[model]",
          'enabled = ["local/local-test", "openrouter/**"]',
          "",
        ].join("\n"),
      );
      const wildcard = startPty(
        process.execPath,
        [cli, "--model", "local/local-test"],
        {
          cwd: project,
          env: {
            ...BASE_ENV,
            CODEPUNK_HOME: home,
            PI_OFFLINE: "1",
            TERM: "xterm-256color",
            NO_COLOR: "1",
          },
        },
      );
      try {
        await waitForOutput(
          wildcard,
          "codepunk · local/local-test",
          "wildcard scoped startup",
        );
        const evidenceBefore = (await readEvidence(home)).filter(
          (entry) =>
            entry.tool === "image_generate" &&
            entry.outcome === "completed" &&
            entry.command ===
              "image-generate openrouter/black-forest-labs/flux.2-pro",
        ).length;
        const mark = wildcard.output().length;
        wildcard.child.stdin.write(
          "/image-gen --model openrouter/black-forest-labs/flux.2-pro a wildcard fox\r",
        );
        await waitForOutputAfter(
          wildcard,
          mark,
          "Approval required",
          "wildcard-scoped image generation approval prompt",
        );
        wildcard.child.stdin.write("a");
        await waitForOutputAfter(
          wildcard,
          mark,
          "image generated:",
          "wildcard-scoped image generation result",
        );
        await waitFor(
          async () =>
            (await readEvidence(home)).filter(
              (entry) =>
                entry.tool === "image_generate" &&
                entry.outcome === "completed" &&
                entry.command ===
                  "image-generate openrouter/black-forest-labs/flux.2-pro",
            ).length > evidenceBefore,
          "wildcard-scoped image generation evidence",
        );
        wildcard.child.stdin.write("/quit\r");
        const wildcardResult = await Promise.race([
          wildcard.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(wildcardResult, { code: 0, signal: null });
      } finally {
        await stopPty(wildcard);
      }
    } finally {
      await stopPty(session);
      model.server.close();
    }
  });
});

test("a real pty records a failed image input when dispatch is rejected", async () => {
  await withTempDirectory(
    "codepunk-tui-image-dispatch-failure-",
    async (root) => {
      const project = path.join(root, "project");
      const home = path.join(root, "home");
      await fs.mkdir(project);
      await fs.mkdir(home);
      await execFileAsync("git", ["init", "-q"], { cwd: project });
      let requestSeen;
      const firstRequest = new Promise((resolve) => {
        requestSeen = resolve;
      });
      const server = http.createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          requestSeen();
        });
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address);
      await fs.writeFile(
        path.join(home, "config.toml"),
        '[sandbox]\nmode = "uncovered"\n',
      );
      await fs.writeFile(
        path.join(home, "models.json"),
        JSON.stringify({
          providers: {
            local: {
              name: "Local",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              api: "openai-completions",
              apiKey: "test",
              models: [
                {
                  id: "local-test",
                  name: "Local Test",
                  api: "openai-completions",
                  contextWindow: 128000,
                  maxTokens: 1024,
                  input: ["text", "image"],
                },
              ],
            },
          },
        }),
      );

      const cli = await ensureBuilt();
      const session = startPty(
        process.execPath,
        [cli, "--model", "local/local-test"],
        {
          cwd: project,
          env: {
            ...BASE_ENV,
            CODEPUNK_HOME: home,
            PI_OFFLINE: "1",
            TERM: "xterm-256color",
            NO_COLOR: "1",
          },
        },
      );
      try {
        await waitForOutput(session, "codepunk · local/local-test", "startup");
        await fs.writeFile(
          path.join(project, "pixel.png"),
          Buffer.from(IMAGE_PNG_BASE64, "base64"),
        );
        session.child.stdin.write("hold the current request\r");
        await firstRequest;
        const mark = session.output().length;
        session.child.stdin.write("/image pixel.png rejected prompt\r");
        await waitForOutputAfter(
          session,
          mark,
          "image confirmed",
          "image confirmation",
        );
        await waitForOutputAfter(
          session,
          mark,
          "/image failed",
          "image dispatch failure",
        );
        const record = await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (entry) =>
                entry.tool === "image_input" &&
                entry.path_check.target === "pixel.png",
            ) ?? null,
          "failed image input evidence",
        );
        assert.equal(record.decision, "allow");
        assert.equal(record.outcome, "failed");
        assert.equal(record.rule, "product.image.input_failed");
        assert.equal(record.exit_code, 1);
        assert.equal(record.effects.network, false);
        assert.match(record.output_preview, /already processing/u);
      } finally {
        await stopPty(session);
        server.closeAllConnections();
        server.close();
      }
    },
  );
});

test("a real pty undoes and redoes Codepunk file changes", async (t) => {
  if (process.platform === "win32") {
    t.skip(
      "hosted Windows ConPTY /undo timing is not reliable; real Windows 11 acceptance is required",
    );
    return;
  }
  await withTempDirectory("codepunk-tui-undo-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(path.join(project, "note.txt"), "before\n");
    const model = await startWriteModelServer({
      path: "note.txt",
      content: "after\n",
    });
    await fs.writeFile(
      path.join(home, "config.toml"),
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[approval]",
        'mode = "allow"',
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      session.child.stdin.write("write note.txt\r");
      await waitForOutput(session, "WRITE_DONE", "model write");
      assert.equal(
        await fs.readFile(path.join(project, "note.txt"), "utf8"),
        "after\n",
      );

      await runCommandAfter(session, "/undo", "Undo file changes?");
      session.child.stdin.write("\r");
      await waitForOutput(session, "undo: 1 file checkpoint(s) restored");
      assert.equal(
        await fs.readFile(path.join(project, "note.txt"), "utf8"),
        "before\n",
      );

      await runCommandAfter(session, "/redo", "Redo file changes?");
      session.child.stdin.write("\r");
      await waitForOutput(session, "redo: 1 file checkpoint(s) restored");
      assert.equal(
        await fs.readFile(path.join(project, "note.txt"), "utf8"),
        "after\n",
      );

      const eventFiles = (await fs.readdir(home, { recursive: true })).filter(
        (entry) => entry.endsWith("session.jsonl"),
      );
      assert.equal(eventFiles.length, 1);
      const events = (await fs.readFile(path.join(home, eventFiles[0]), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      const restores = events.filter(
        (entry) => entry.kind === "checkpoint/restore",
      );
      assert.deepEqual(
        restores.map((entry) => entry.data.action),
        ["undo", "redo"],
      );

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
      model.server.close();
    }
  });
});

test("a real pty signs a settled run with an explicit verdict", async () => {
  await withTempDirectory("codepunk-tui-sign-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(path.join(project, "note.txt"), "before\n");
    const model = await startWriteModelServer({
      path: "note.txt",
      content: "after\n",
    });
    await fs.writeFile(
      path.join(home, "config.toml"),
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[approval]",
        'mode = "allow"',
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      await runCommandAfter(
        session,
        "/sign maybe",
        "usage: /sign [complete|incomplete]",
      );
      session.child.stdin.write("write note.txt\r");
      await waitForOutput(session, "WRITE_DONE", "model write");

      await runCommandAfter(session, "/sign", "Sign as incomplete");
      session.child.stdin.write("\u001b[B\r");
      await waitForOutput(session, "verdict incomplete ·", "incomplete sign");

      const eventFiles = (await fs.readdir(home, { recursive: true })).filter(
        (entry) => entry.endsWith("session.jsonl"),
      );
      assert.equal(eventFiles.length, 1);
      const events = (await fs.readFile(path.join(home, eventFiles[0]), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      const signOff = events.find((entry) => entry.kind === "verdict/sign_off");
      assert.ok(signOff);
      assert.equal(signOff.data.signed_verdict, "incomplete");
      assert.equal(signOff.data.channel, "tui");

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
      model.server.close();
    }
  });
});

test("a real pty creates a human-confirmed commit and records it", async () => {
  await withTempDirectory("codepunk-tui-commit-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: project,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], {
      cwd: project,
    });
    await fs.writeFile(path.join(project, "tracked.txt"), "one\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: project });
    await execFileAsync("git", ["commit", "-q", "-m", "initial"], {
      cwd: project,
    });
    await fs.writeFile(path.join(project, "tracked.txt"), "two\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await runCommandAfter(
        session,
        "/commit update tracked file",
        "Commit scope",
      );
      const scopeMark = session.output().length;
      session.child.stdin.write("\r");
      await waitForOutputAfter(
        session,
        scopeMark,
        "Create this commit?",
        "commit confirmation",
      );
      const confirmMark = session.output().length;
      session.child.stdin.write("\r");
      await waitForOutputAfter(
        session,
        confirmMark,
        "commit created:",
        "commit result",
      );
      const log = await execFileAsync("git", ["log", "-1", "--pretty=%s"], {
        cwd: project,
      });
      assert.equal(log.stdout.trim(), "update tracked file");

      const evidence = await readEvidence(home);
      const commitRecord = evidence.find((record) => record.tool === "commit");
      assert.ok(commitRecord);
      assert.equal(commitRecord.decision, "allow");
      assert.equal(commitRecord.outcome, "completed");
      assert.equal(commitRecord.executor, "codepunk-commit");
      assert.match(commitRecord.vcs.commit, /^[0-9a-f]{40,64}$/u);

      const eventFiles = (await fs.readdir(home, { recursive: true })).filter(
        (entry) => entry.endsWith("session.jsonl"),
      );
      assert.equal(eventFiles.length, 1);
      const events = (await fs.readFile(path.join(home, eventFiles[0]), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      const commitEvent = events.find(
        (entry) => entry.kind === "commit/created",
      );
      assert.ok(commitEvent);
      assert.equal(commitEvent.data.files.length, 1);
      assert.equal(commitEvent.data.files[0], "tracked.txt");

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty manages MCP auth without leaving the TUI", async () => {
  await withTempDirectory("codepunk-tui-mcp-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await runCommandAfter(
        session,
        "/mcp status",
        "no user MCP servers configured",
      );
      await fs.writeFile(
        path.join(home, "mcp.toml"),
        [
          "[servers.alpha]",
          'url = "https://alpha.example.invalid/mcp"',
          "",
          "[servers.beta]",
          'url = "https://beta.example.invalid/mcp"',
          "",
        ].join("\n"),
      );
      const logoutMark = session.output().length;
      session.child.stdin.write("/mcp logout\r");
      await waitForOutputAfter(
        session,
        logoutMark,
        "MCP server to sign out",
        "/mcp logout selector",
      );
      assert.match(
        stripAnsi(session.output().slice(logoutMark)),
        /\u2192 alpha/u,
      );
      assert.match(stripAnsi(session.output().slice(logoutMark)), /beta/u);
      session.child.stdin.write("\u001b[B\r");
      await waitForOutputAfter(
        session,
        logoutMark,
        "beta: no stored credentials",
        "/mcp logout completion",
      );
      await fs.rm(path.join(home, "mcp.toml"));
      await runCommandAfter(
        session,
        "/mcp login",
        "MCP sign-in failed: mcp login requires an HTTP server",
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty adds and removes an MCP server without editing TOML", async () => {
  await withTempDirectory("codepunk-tui-mcp-edit-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await runCommandAfter(session, "/mcp add echo", "MCP transport");
      session.child.stdin.write("\r");
      await waitForOutput(session, "Command and arguments", "stdio command");
      session.child.stdin.write('node -e "process.exit(0)"\r');
      await waitForOutput(
        session,
        "Working directory inside the project",
        "stdio cwd",
      );
      session.child.stdin.write("\r");
      await waitForOutput(session, "MCP server echo saved", "MCP server saved");
      const config = await fs.readFile(path.join(home, "mcp.toml"), "utf8");
      assert.match(config, /\[servers\.echo\]/u);
      assert.match(config, /command = "node"/u);
      assert.match(config, /args = \["-e", "process\.exit\(0\)"\]/u);

      await runCommandAfter(
        session,
        "/mcp remove echo",
        "Remove MCP server echo?",
      );
      session.child.stdin.write("\r");
      await waitForOutput(session, "MCP server echo removed", "MCP removal");
      const after = await fs.readFile(path.join(home, "mcp.toml"), "utf8");
      assert.doesNotMatch(after, /servers\.echo/u);

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty guides first-run model setup without a Pi-only warning", async () => {
  await withTempDirectory("codepunk-tui-no-model-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const modelMark = session.output().length;
      session.child.stdin.write("/model\r");
      await waitForOutputAfter(
        session,
        modelMark,
        "No authenticated models.",
        "/model without credentials",
      );
      assert.doesNotMatch(
        session.output().slice(modelMark),
        /Pi-only command intercepted/u,
      );

      const promptMark = session.output().length;
      session.child.stdin.write("hello\r");
      await waitForOutputAfter(
        session,
        promptMark,
        "No model configured",
        "first-run prompt gate",
      );
      await waitForOutputAfter(
        session,
        promptMark,
        "escape/ctrl+c cancel",
        "first-run setup selector hint",
      );
      assert.match(
        session.output().slice(promptMark),
        /Sign in to a provider/u,
      );
      const setupOutput = stripAnsi(session.output().slice(promptMark));
      assert.match(setupOutput, /\u2192 Sign in to a provider/u);
      assert.match(
        setupOutput,
        /\u2191\u2193 navigate  enter select  escape\/ctrl\+c cancel/u,
      );
      assert.doesNotMatch(setupOutput, /(?:^|\n)\s*1\. Sign in to a provider/u);
      assert.doesNotMatch(setupOutput, /\[1\/2/u);
      const setupMark = session.output().length;
      session.child.stdin.write("\u001b[B\u001b[B\r");
      await waitForOutputAfter(
        session,
        setupMark,
        "codepunk models import",
        "first-run setup commands",
      );

      await waitForQuiet(session, 250);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(
        result,
        { code: 0, signal: null },
        stripAnsi(session.output()).slice(-4_000),
      );
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty reports status without a configured model", async () => {
  await withTempDirectory("codepunk-tui-status-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const mark = session.output().length;
      session.child.stdin.write("/status\r");
      await waitForOutputAfter(
        session,
        mark,
        "codepunk status",
        "/status command",
      );
      await waitForOutputAfter(
        session,
        mark,
        "sessions: ",
        "/status completion",
      );
      const output = stripAnsi(session.output().slice(mark));
      assert.match(output, /project: /u);
      assert.match(output, /model: not selected/u);
      assert.match(output, /permissions: /u);
      assert.match(output, /trust: (trusted|untrusted)(?: \([^)]+\))? · /u);
      assert.match(output, /capabilities: /u);
      assert.match(output, /evidence: /u);
      assert.match(output, /Project/u);
      assert.match(output, /Session/u);
      assert.match(output, /Permissions/u);
      assert.match(output, /esc close/u);
      assert.match(output, /│/u);
      session.child.stdin.write("\u001b");
      await waitForQuiet(session, 250);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty reloads config in place and preserves state on invalid input", async () => {
  await withTempDirectory("codepunk-tui-config-reload-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const configPath = path.join(home, "config.toml");
    await fs.writeFile(
      configPath,
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[approval]",
        'mode = "ask"',
        "",
        "[autonomy]",
        'profile = "ask"',
        "",
      ].join("\n"),
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--allow-unsandboxed-shell"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await fs.writeFile(
        configPath,
        [
          "[sandbox]",
          'mode = "required"',
          "",
          "[approval]",
          'mode = "deny"',
          "",
          "[autonomy]",
          'profile = "read-only"',
          "",
          "[model]",
          'provider = "next"',
          'id = "next-model"',
          "",
        ].join("\n"),
      );

      const reloadMark = session.output().length;
      await runCommandAfter(session, "/reload", "Codepunk config reloaded.");
      const reloaded = session.output().slice(reloadMark);
      assert.match(
        reloaded,
        /applied now: approval\.mode=deny, autonomy=read-only/u,
      );
      assert.match(reloaded, /next session: model, sandbox/u);
      assert.match(
        reloaded,
        /Plugins are not loaded while autonomy is read-only\./u,
      );
      assert.match(
        reloaded,
        /MCP is not started while autonomy is read-only\./u,
      );

      const permissionsMark = session.output().length;
      await runCommandAfter(session, "/permissions", "approvals: deny");
      const permissions = session.output().slice(permissionsMark);
      assert.match(permissions, /codepunk permissions/u);
      assert.match(permissions, /Profile/u);
      assert.match(permissions, /Approvals/u);
      assert.match(permissions, /esc close/u);
      assert.match(permissions, /autonomy: read-only/u);
      assert.match(permissions, /current shell: explicit-unsandboxed/u);
      assert.match(permissions, /next session sandbox: required/u);
      await closeOverlay(session);

      await fs.writeFile(configPath, '[approval]\nmode = "not-a-mode"\n');
      const invalidMark = session.output().length;
      await runCommandAfter(session, "/reload", "Reload failed:");
      assert.match(
        session.output().slice(invalidMark),
        /approval\.mode|not-a-mode/u,
      );

      const preservedMark = session.output().length;
      await runCommandAfter(session, "/permissions", "approvals: deny");
      assert.match(
        session.output().slice(preservedMark),
        /autonomy: read-only/u,
      );
      await closeOverlay(session);

      const sessionsBeforeQuit = (
        await fs.readdir(home, { recursive: true })
      ).filter((entry) => entry.endsWith("session.jsonl"));
      assert.equal(sessionsBeforeQuit.length, 1);

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("/init refuses to overwrite an existing root instruction file", async () => {
  await withTempDirectory("codepunk-tui-init-existing-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(path.join(project, "AGENTS.md"), "EXISTING_RULE\n");
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await trustWorkspace(home, project);
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const mark = session.output().length;
      session.child.stdin.write("/init\r");
      await waitForOutputAfter(
        session,
        mark,
        "Use /init --update to let the agent revise that file in place.",
        "/init existing file guard",
      );
      assert.match(session.output().slice(mark), /\/init --update/u);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty projects search, todo, and plan tool output", async () => {
  await withTempDirectory("codepunk-tui-tool-projection-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await fs.writeFile(path.join(project, "note.txt"), "projection target\n");
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const model = await startToolProjectionModelServer();
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      session.child.stdin.write("project the tools\r");
      await waitForOutput(session, "TOOLS_PROJECTED", "tool projections");
      const output = stripAnsi(session.output());
      assert.match(output, /search · ls \. "note"/u);
      assert.match(output, /search · 1 entry · note\.txt/u);
      assert.match(
        output,
        /todo · 2 items · in progress: inspect the repository/u,
      );
      assert.match(output, /todo · 2 items · 1 in progress · 0 completed/u);
      assert.match(
        output,
        /plan · 2 steps · in progress: inspect the repository/u,
      );
      assert.match(output, /plan · 2 steps · sha [0-9a-f]{12}…/u);
      assert.doesNotMatch(output, /implement the health check/u);

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
      model.server.close();
    }
  });
});

test("/init sends the repository-evidence prompt to the selected model", async () => {
  await withTempDirectory("codepunk-tui-init-model-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const model = await startTextModelServer();
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      await runCommandAfter(session, "/init", "CHILD_OK");
      assert.match(
        session.output(),
        /The new file applies when the next session starts\./u,
      );
      assert.ok(model.requests.length > 0);
      const request = JSON.stringify(model.requests);
      assert.match(request, /Create the repository guidance file/u);
      assert.match(request, /AGENTS\.md/u);
      assert.match(request, /Keep it under 120 lines/u);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
      model.server.close();
    }
  });
});

test("a real pty asks before a project instruction file is trusted", async () => {
  await withTempDirectory("codepunk-tui-trust-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "PROJECT_RULE_SENTINEL\n",
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "Project trust", "trust prompt");
      assert.match(session.output(), /AGENTS\.md/u);
      assert.match(session.output(), /sha256:[a-f0-9]{12}\u2026/u);
      assert.doesNotMatch(session.output(), /sha256:[a-f0-9]{64}/u);
      assert.match(
        stripAnsi(session.output()),
        /Workspace trust\s+cwd: .+\s+checkout root: /u,
      );
      assert.match(
        stripAnsi(session.output()),
        /Trust only controls project config, policy, skills, and instruction files\./u,
      );
      assert.match(
        stripAnsi(session.output()),
        /It does not change approval, sandbox, or filesystem permissions\./u,
      );
      assert.match(
        stripAnsi(session.output()),
        /saved decision:\s+none for this checkout or an ancestor/u,
      );
      assert.doesNotMatch(
        stripAnsi(session.output()),
        new RegExp(
          `codepunk ${escapeRegExp(PRODUCT_VERSION)} · dist .+ · source current`,
          "u",
        ),
      );
      assert.match(
        stripAnsi(session.output()),
        /\u2191\u2193 navigate  enter select  esc\/ctrl\+c cancel/u,
      );
      assert.match(
        session.output(),
        /\u2192 Trust this workspace and remember/u,
      );
      assert.match(session.output(), /Load all resources · remember/u);
      assert.match(session.output(), /Skip all now · ask again next start/u);
      assert.doesNotMatch(
        session.output(),
        /1\. Trust this workspace and remember/u,
      );
      assert.doesNotMatch(session.output(), /1-3 to jump/u);
      assert.doesNotMatch(session.output(), /\[1\/2\/3\]/u);
      session.child.stdin.write("\u001b[B\u001b[B\r");
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const saved = JSON.parse(
        await fs.readFile(path.join(home, "trust.json"), "utf8"),
      );
      assert.equal(saved[await fs.realpath(project)], false);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
    const second = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(second, "codepunk · auto/auto", "saved decision");
      assert.doesNotMatch(second.output(), /Trust this workspace\?/u);
      second.child.stdin.write("/quit\r");
    } finally {
      await stopPty(second);
    }
  });
});

test("a real pty remembers the default trust choice", async () => {
  await withTempDirectory("codepunk-tui-trust-default-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "DEFAULT_TRUST_SENTINEL\n",
    );
    const cli = await ensureBuilt();
    const env = {
      ...BASE_ENV,
      CODEPUNK_HOME: home,
      PI_OFFLINE: "1",
      TERM: "xterm-256color",
      NO_COLOR: "1",
    };
    const first = startPty(process.execPath, [cli], { cwd: project, env });
    try {
      await waitForOutput(first, "Project trust", "first trust prompt");
      first.child.stdin.write("\r");
      await waitForOutput(first, "codepunk · auto/auto", "first startup");
      const store = JSON.parse(
        await fs.readFile(path.join(home, "trust.json"), "utf8"),
      );
      const realProject = await fs.realpath(project);
      assert.equal(store[realProject], true);
      first.child.stdin.write("/quit\r");
      const result = await Promise.race([
        first.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(first);
    }

    const second = startPty(process.execPath, [cli], { cwd: project, env });
    try {
      await waitForOutput(second, "codepunk · auto/auto", "trusted restart");
      assert.doesNotMatch(second.output(), /Trust this workspace\?/u);
      assert.match(second.output(), /trust trusted \(saved\)/u);
      second.child.stdin.write("/quit\r");
      const result = await Promise.race([
        second.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(second);
    }
  });
});

test("a real pty applies a custom per-resource trust decision", async () => {
  await withTempDirectory("codepunk-tui-trust-custom-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(path.join(project, ".codepunk", "skills", "team"), {
      recursive: true,
    });
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, ".codepunk", "config.toml"),
      "[memory]\nmax_tokens = 400\n",
    );
    await fs.writeFile(
      path.join(project, ".codepunk", "skills", "team", "SKILL.md"),
      "---\nname: team\ndescription: team\n---\nbody\n",
    );
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "CUSTOM_TRUST_SENTINEL\n",
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "Project trust", "trust prompt");
      assert.match(session.output(), /Customize resources/u);
      assert.doesNotMatch(
        session.output(),
        /1\. Trust this workspace and remember/u,
      );
      await waitForQuiet(session, 250);
      session.child.stdin.write("\u001b[B\u001b[B\r");
      await waitForOutput(
        session,
        "Load project resources",
        "resource checkbox",
      );
      await waitForQuiet(session, 250);
      assert.match(session.output(), /\[x\] Project configuration/u);
      assert.match(session.output(), /\[x\] Project skills/u);
      assert.match(session.output(), /\[x\] Project instructions/u);
      assert.match(session.output(), /space toggle  enter apply  esc back/u);
      // Turn config and skills off, leaving only project instructions.
      session.child.stdin.write(" \u001b[B \r");
      await waitForOutput(session, "Apply custom trust", "custom scope");
      await waitForQuiet(session, 250);
      assert.match(session.output(), /selected: instructions/u);
      session.child.stdin.write("\u001b[B\r");
      await waitForOutput(session, "codepunk · auto/auto", "custom startup");
      assert.match(session.output(), /trust custom \(instructions\)/u);
      const saved = JSON.parse(
        await fs.readFile(path.join(home, "workspace-trust.json"), "utf8"),
      );
      assert.deepEqual(saved.workspaces[await fs.realpath(project)].grants, {
        config: false,
        policy: false,
        skills: false,
        instructions: true,
      });
      const mark = session.output().length;
      session.child.stdin.write("/trust status\r");
      await waitForOutputAfter(
        session,
        mark,
        "saved resources:",
        "trust status",
      );
      assert.match(
        stripAnsi(session.output().slice(mark)),
        /config=skipped, policy=skipped, skills=skipped, instructions=allowed/u,
      );
      await runCommandAfter(
        session,
        "/trust grant config",
        "workspace trust saved as trusted",
      );
      const savedAfterGrant = JSON.parse(
        await fs.readFile(path.join(home, "workspace-trust.json"), "utf8"),
      );
      assert.deepEqual(
        savedAfterGrant.workspaces[await fs.realpath(project)].grants,
        {
          config: true,
          policy: false,
          skills: false,
          instructions: true,
        },
      );
      await runCommandAfter(
        session,
        "/trust revoke instructions",
        "workspace trust saved as untrusted",
      );
      const savedAfterRevoke = JSON.parse(
        await fs.readFile(path.join(home, "workspace-trust.json"), "utf8"),
      );
      assert.deepEqual(
        savedAfterRevoke.workspaces[await fs.realpath(project)].grants,
        {
          config: true,
          policy: false,
          skills: false,
          instructions: false,
        },
      );
      await waitForQuiet(session, 1_000);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(
        result,
        { code: 0, signal: null },
        stripAnsi(session.output()).slice(-4_000),
      );
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty labels an explicit one-run trust decision", async () => {
  await withTempDirectory("codepunk-tui-trust-flag-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "ONE_RUN_TRUST_SENTINEL\n",
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli, "--trust"], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      assert.match(session.output(), /trust trusted \(one run\)/u);
      await assert.rejects(
        fs.readFile(path.join(home, "trust.json"), "utf8"),
        /ENOENT/u,
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty explains an ancestor trust decision without inheriting it", async () => {
  await withTempDirectory("codepunk-tui-trust-parent-", async (root) => {
    const workspace = path.join(root, "workspace");
    const project = path.join(workspace, "packages", "app");
    const home = path.join(root, "home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "NESTED_PARENT_TRUST_SENTINEL\n",
    );
    await trustWorkspace(home, workspace);
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "Project trust", "trust prompt");
      const output = stripAnsi(session.output()).replace(/\s+/gu, " ");
      assert.match(
        output,
        /saved decision: trusted for parent .+; this checkout needs its own decision/u,
      );
      assert.ok(output.includes(`checkout root: ${project}`));
      session.child.stdin.write("\u001b");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 8_000),
        ),
      ]);
      assert.deepEqual(result, { code: 1, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty cancels workspace trust without hanging", async () => {
  await withTempDirectory("codepunk-tui-trust-cancel-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "CANCEL_TRUST_SENTINEL\n",
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "Project trust", "trust prompt");
      session.child.stdin.write("\u001b");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 8_000),
        ),
      ]);
      assert.deepEqual(result, { code: 1, signal: null });
      assert.match(
        stripAnsi(session.output()),
        /workspace trust was not decided/u,
      );
      await assert.rejects(
        fs.readFile(path.join(home, "trust.json"), "utf8"),
        /ENOENT/u,
      );
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty can deny workspace trust for one session without saving", async () => {
  await withTempDirectory("codepunk-tui-trust-deny-session-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(project, "AGENTS.md"),
      "DENY_SESSION_SENTINEL\n",
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "Project trust", "trust prompt");
      assert.match(
        stripAnsi(session.output()),
        /Do not trust for this session only/u,
      );
      session.child.stdin.write("\u001b[B\u001b[B\u001b[B\r");
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      assert.match(session.output(), /trust untrusted \(session only\)/u);
      await assert.rejects(
        fs.readFile(path.join(home, "trust.json"), "utf8"),
        /ENOENT/u,
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("--no-skills keeps project skills out of the /trust view", async () => {
  await withTempDirectory("codepunk-tui-trust-noskills-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(path.join(project, "AGENTS.md"), "PROJECT_RULE\n");
    await fs.mkdir(path.join(project, ".codepunk", "skills", "team"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(project, ".codepunk", "skills", "team", "SKILL.md"),
      "---\nname: team\ndescription: team\n---\nbody\n",
    );
    await trustWorkspace(home, project);
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli, "--no-skills"], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const mark = session.output().length;
      session.child.stdin.write("/trust\r");
      await waitForOutputAfter(
        session,
        mark,
        "excluded from this session's trust check",
        "/trust under --no-skills",
      );
      const view = session.output().slice(mark);
      assert.match(view, /AGENTS\.md/u);
      assert.match(view, /project skills \(--no-skills or --bare\)/u);
      // A resource that was never part of this session's decision must not be
      // presented as one the user is being asked to trust.
      assert.doesNotMatch(view, /\.codepunk\/skills/u);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("header and footer can be disabled without disabling the session", async () => {
  await withTempDirectory("codepunk-tui-hidden-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[tui]",
        "header = false",
        "footer = false",
        "status = false",
        "widgets = false",
        "",
      ].join("\n"),
    );
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "No model configured.", "startup");
      await waitForOutput(
        session,
        "codepunk warning: sandbox mode is uncovered",
        "startup warning",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      await runCommandAfter(
        session,
        "/evidence",
        "No evidence in the current run.",
      );
      assert.doesNotMatch(session.output(), /codepunk · auto\/auto/u);
      assert.doesNotMatch(session.output(), /approvals ask · autonomy ask/u);
      assert.doesNotMatch(session.output(), /project [0-9a-f]{16}/u);
      await waitForQuiet(session, 250);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(
        result,
        { code: 0, signal: null },
        stripAnsi(session.output()).slice(-4_000),
      );
    } finally {
      await stopPty(session);
    }
  });
});

test(
  "a real pty approval selector allows and denies shell commands",
  {
    skip:
      process.platform === "win32"
        ? "the fixture uses POSIX date and rm commands"
        : false,
  },
  async () => {
    await withTempDirectory("codepunk-tui-approval-", async (root) => {
      const project = path.join(root, "project");
      await fs.mkdir(project);
      const home = path.join(root, "home");
      await fs.mkdir(home);
      await execFileAsync("git", ["init", "-q"], { cwd: project });
      const cli = await ensureBuilt();
      const session = startPty(process.execPath, [cli], {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      });
      try {
        await waitForOutput(session, "codepunk · auto/auto", "startup");

        const dateMark = session.output().length;
        session.child.stdin.write("!date +%A\r");
        const dateRecord = await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (record) =>
                record.command === "date +%A" && record.decision === "allow",
            ) ?? null,
          "read-only date evidence",
        );
        assert.equal(dateRecord.exit_code, 0);
        assert.doesNotMatch(
          session.output().slice(dateMark),
          /Approval required/u,
        );
        await waitForBashResult(home, "date +%A");
        await new Promise((resolve) => setTimeout(resolve, 300));

        const allowMark = session.output().length;
        session.child.stdin.write("!touch approved.txt\r");
        await waitForOutputAfter(
          session,
          allowMark,
          "Approval required",
          "allow approval prompt",
        );
        await waitForOutputAfter(
          session,
          allowMark,
          "why:",
          "approval policy reason",
        );
        assert.match(
          session.output().slice(allowMark),
          /command: touch approved\.txt/u,
        );
        assert.match(session.output().slice(allowMark), /why: .+/u);
        assert.match(
          session.output().slice(allowMark),
          /coverage: (?:srt [^;]+ enforced|no srt sandbox; this command runs directly)/u,
        );
        assert.match(session.output().slice(allowMark), /Allow for session/u);
        assert.match(session.output().slice(allowMark), /Always allow exact/u);
        session.child.stdin.write("a");
        await waitFor(
          () =>
            fs
              .stat(path.join(project, "approved.txt"))
              .then(() => true)
              .catch(() => null),
          "approved command execution",
        );
        const allowed = await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (record) =>
                record.command === "touch approved.txt" &&
                record.decision === "allow",
            ) ?? null,
          "allowed command evidence",
        );
        assert.equal(allowed.exit_code, 0);
        assert.equal(allowed.rule, "policy.default");
        assert.equal(allowed.approval.channel, "tui");
        assert.equal(allowed.approval.scope, "once");
        assert.equal(allowed.approval.tool_call_id, allowed.tool_call_id);
        assert.equal(allowed.approval.worker_id, "local");
        assert.equal(allowed.approval.session_id, allowed.session_id);
        assert.match(allowed.approval.request_id, /^[0-9a-f-]{36}$/u);
        assert.match(allowed.approval.nonce_sha256, /^sha256:[0-9a-f]{64}$/u);
        assert.ok(allowed.approval.ttl_ms > 0);
        await waitForBashResult(home, "touch approved.txt");

        await submitUserBashWhenIdle(
          session,
          "!touch denied.txt",
          "deny approval prompt",
        );
        session.child.stdin.write("d");
        const denied = await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (record) =>
                record.command === "touch denied.txt" &&
                record.decision === "deny",
            ) ?? null,
          "denied command evidence",
        );
        assert.equal(denied.rule, "approval.denied");
        assert.equal(denied.approval.answer, "deny");
        assert.equal(denied.approval.scope, "once");
        assert.equal(
          await fs.stat(path.join(project, "denied.txt")).catch(() => null),
          null,
        );

        await submitUserBashWhenIdle(
          session,
          "!!touch excluded.txt",
          "excluded shell approval prompt",
        );
        session.child.stdin.write("a");
        await waitFor(
          () =>
            fs
              .stat(path.join(project, "excluded.txt"))
              .then(() => true)
              .catch(() => null),
          "excluded command execution",
        );
        const excluded = await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (record) =>
                record.command === "touch excluded.txt" &&
                record.decision === "allow",
            ) ?? null,
          "excluded command evidence",
        );
        assert.equal(excluded.exit_code, 0);
        await waitForBashResult(home, "touch excluded.txt");

        await waitForQuiet(session, 250);
        session.child.stdin.write("/quit\r");
        const result = await Promise.race([
          session.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(
          result,
          { code: 0, signal: null },
          stripAnsi(session.output()).slice(-2_000),
        );
      } finally {
        await stopPty(session);
      }
    });
  },
);

test(
  "a real pty persists an exact approval rule for later sessions",
  {
    skip:
      process.platform === "win32"
        ? "the fixture uses POSIX touch and shell syntax"
        : false,
  },
  async () => {
    await withTempDirectory("codepunk-tui-persist-approval-", async (root) => {
      const project = path.join(root, "project");
      await fs.mkdir(project);
      const home = path.join(root, "home");
      await fs.mkdir(home);
      await execFileAsync("git", ["init", "-q"], { cwd: project });
      const cli = await ensureBuilt();
      const env = {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      };
      const first = startPty(process.execPath, [cli], { cwd: project, env });
      try {
        await waitForOutput(first, "codepunk · auto/auto", "startup");
        const mark = first.output().length;
        first.child.stdin.write("!touch persisted-exact.txt\r");
        await waitForOutputAfter(
          first,
          mark,
          "Always allow exact",
          "persistent approval option",
        );
        first.child.stdin.write("p");
        await waitForOutputAfter(
          first,
          mark,
          "Persistent rule preview",
          "persistent approval confirmation",
        );
        const persistentPreview = first.output().slice(mark);
        assert.match(
          persistentPreview,
          /exact argv: \["touch","persisted-exact\.txt"\]/u,
        );
        assert.match(persistentPreview, /cwd: \S+/u);
        assert.match(persistentPreview, /storage: user scoped-rule file/u);
        assert.match(
          persistentPreview,
          /next session: autonomy switches to scoped/u,
        );
        first.child.stdin.write("\r");
        const allowed = await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (record) =>
                record.command === "touch persisted-exact.txt" &&
                record.decision === "allow" &&
                record.approval?.scope === "persistent",
            ) ?? null,
          "persistent approval evidence",
        );
        assert.match(allowed.rule, /^policy\.default$/u);

        await submitUserBashWhenIdle(
          first,
          "!touch cancelled-rule.txt",
          "cancelled persistent approval",
        );
        const cancelMark = first.output().length;
        first.child.stdin.write("p");
        await waitForOutputAfter(
          first,
          cancelMark,
          "Persistent rule preview",
          "cancelled persistent approval confirmation",
        );
        first.child.stdin.write("\u001b");
        await new Promise((resolve) => setTimeout(resolve, 100));
        first.child.stdin.write("\u001b");
        await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (record) =>
                record.command === "touch cancelled-rule.txt" &&
                record.decision === "deny",
            ) ?? null,
          "cancelled persistent approval evidence",
        );
        assert.equal(
          await fs
            .stat(path.join(project, "cancelled-rule.txt"))
            .catch(() => null),
          null,
        );

        const configPath = path.join(home, "config.toml");
        const config = await waitFor(async () => {
          try {
            const text = await fs.readFile(configPath, "utf8");
            return /profile = "scoped"/u.test(text) ? text : null;
          } catch {
            return null;
          }
        }, "scoped autonomy config");
        const rulesPath = /scoped_rules = "(.*)"/u.exec(config)?.[1];
        assert.ok(rulesPath);
        const rules = await fs.readFile(rulesPath, "utf8");
        assert.match(rules, /argv = \["touch", "persisted-exact\.txt"\]/u);
        assert.doesNotMatch(rules, /cancelled-rule/u);
        await assertPrivateFile(rulesPath);
        // Forcing "ask" must not silently drop the stored scoped rules.
        const askMark = first.output().length;
        first.child.stdin.write("/permissions autonomy ask\r");
        await waitForOutputAfter(
          first,
          askMark,
          "autonomy set to ask",
          "ask autonomy profile",
        );
        const askConfig = await fs.readFile(configPath, "utf8");
        assert.match(askConfig, /profile = "ask"/u);
        assert.match(askConfig, /scoped_rules = "/u);
        const rulesMark = first.output().length;
        first.child.stdin.write("/permissions rules\r");
        await waitForOutputAfter(
          first,
          rulesMark,
          "Scoped rules: 1 (profile ask)",
          "scoped rules command",
        );
        assert.match(
          first.output().slice(rulesMark),
          /touch persisted-exact\.txt/u,
        );
        assert.match(first.output().slice(rulesMark), /ARGV/u);
        assert.match(first.output().slice(rulesMark), /HASH/u);
        assert.match(first.output().slice(rulesMark), /esc close/u);
        await closeOverlay(first);
        const restoreMark = first.output().length;
        first.child.stdin.write("/permissions autonomy scoped\r");
        await waitForOutputAfter(
          first,
          restoreMark,
          "autonomy set to scoped",
          "scoped autonomy profile",
        );
        await waitForQuiet(first, 250);
        first.child.stdin.write("/quit\r");
        const exited = await Promise.race([
          first.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(
          exited,
          { code: 0, signal: null },
          stripAnsi(first.output()).slice(-4_000),
        );
      } finally {
        await stopPty(first);
      }

      await fs.unlink(path.join(project, "persisted-exact.txt"));
      const second = startPty(process.execPath, [cli], { cwd: project, env });
      try {
        await waitForOutput(second, "codepunk · auto/auto", "second startup");
        const mark = second.output().length;
        second.child.stdin.write("!touch persisted-exact.txt\r");
        try {
          await waitFor(
            () =>
              fs
                .stat(path.join(project, "persisted-exact.txt"))
                .then(() => true)
                .catch(() => null),
            "persisted rule execution",
          );
        } catch (error) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n${second.output().slice(-4000)}`,
          );
        }
        assert.doesNotMatch(second.output().slice(mark), /Approval required/u);
        const reused = await waitFor(
          async () =>
            (await readEvidence(home)).find(
              (record) =>
                record.command === "touch persisted-exact.txt" &&
                record.decision === "allow" &&
                record.approval === null &&
                record.rule.startsWith("scoped.approval-"),
            ) ?? null,
          "persisted rule evidence",
        );
        assert.equal(reused.autonomy.profile, "scoped");
        await waitForBashResult(home, "touch persisted-exact.txt", 2);
        await waitForQuiet(second, 250);
        second.child.stdin.write("/quit\r");
        const exited = await Promise.race([
          second.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(
          exited,
          { code: 0, signal: null },
          stripAnsi(second.output()).slice(-4_000),
        );
      } finally {
        await stopPty(second);
      }
    });
  },
);

test("the editor disables ! before user_bash when plugins are on", async () => {
  await withTempDirectory("codepunk-tui-plugins-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli, "--allow-plugins"], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await waitForOutput(
        session,
        "Plugins are trusted in-process code",
        "plugin trust warning",
      );
      const mark = session.output().length;
      session.child.stdin.write("!touch blocked.txt\r");
      await waitForOutputAfter(
        session,
        mark,
        "! is disabled while Pi plugins are enabled",
        "plugin shell interception",
      );
      assert.doesNotMatch(session.output().slice(mark), /Approval required/u);
      assert.equal(
        await fs.stat(path.join(project, "blocked.txt")).catch(() => null),
        null,
      );
      const configBefore = await fs.readFile(
        path.join(home, "config.toml"),
        "utf8",
      );
      await runCommandAfter(
        session,
        "/permissions autonomy read-only",
        "cannot switch to read-only while user plugins",
      );
      assert.equal(
        await fs.readFile(path.join(home, "config.toml"), "utf8"),
        configBefore,
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test(
  "read-only live switch refuses an already-writable srt profile",
  {
    skip:
      process.platform === "win32"
        ? "the fixture uses POSIX shell syntax"
        : false,
  },
  async () => {
    await withTempDirectory("codepunk-tui-readonly-srt-", async (root) => {
      const project = path.join(root, "project");
      await fs.mkdir(project);
      await execFileAsync("git", ["init", "-q"], { cwd: project });
      const home = path.join(root, "home");
      await fs.mkdir(home);
      await fs.writeFile(
        path.join(home, "models.json"),
        JSON.stringify({
          providers: {
            test: {
              name: "Test",
              baseUrl: "http://127.0.0.1:1/v1",
              api: "openai-completions",
              apiKey: "test",
              models: [
                {
                  id: "fake",
                  name: "Fake model",
                  reasoning: false,
                  contextWindow: 128000,
                  maxTokens: 1024,
                },
              ],
            },
          },
        }),
      );
      const cli = await ensureBuilt();
      const environment = {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      };
      await execFileAsync(
        process.execPath,
        [cli, "models", "set", "test/fake"],
        {
          cwd: project,
          env: environment,
        },
      );
      const session = startPty(process.execPath, [cli], {
        cwd: project,
        env: environment,
      });
      try {
        await waitForOutput(session, "shell srt", "writable srt startup");
        const configBefore = await fs.readFile(
          path.join(home, "config.toml"),
          "utf8",
        );
        await runCommandAfter(
          session,
          "/permissions autonomy read-only",
          "cannot switch to read-only while srt workspace write grants",
        );
        assert.equal(
          await fs.readFile(path.join(home, "config.toml"), "utf8"),
          configBefore,
        );
        session.child.stdin.write("/quit\r");
        const result = await Promise.race([
          session.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(result, { code: 0, signal: null });
      } finally {
        await stopPty(session);
      }
    });
  },
);

test(
  "read-only live switch refuses widening a read-only srt profile",
  {
    skip:
      process.platform === "win32"
        ? "the fixture uses POSIX shell syntax"
        : false,
  },
  async () => {
    await withTempDirectory("codepunk-tui-readonly-widen-", async (root) => {
      const project = path.join(root, "project");
      await fs.mkdir(project);
      await execFileAsync("git", ["init", "-q"], { cwd: project });
      const home = path.join(root, "home");
      await fs.mkdir(home);
      await fs.writeFile(
        path.join(home, "models.json"),
        JSON.stringify({
          providers: {
            test: {
              name: "Test",
              baseUrl: "http://127.0.0.1:1/v1",
              api: "openai-completions",
              apiKey: "test",
              models: [
                {
                  id: "fake",
                  name: "Fake model",
                  reasoning: false,
                  contextWindow: 128000,
                  maxTokens: 1024,
                },
              ],
            },
          },
        }),
      );
      const cli = await ensureBuilt();
      const environment = {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      };
      await execFileAsync(
        process.execPath,
        [cli, "models", "set", "test/fake"],
        {
          cwd: project,
          env: environment,
        },
      );
      const session = startPty(
        process.execPath,
        [cli, "--permission-mode", "read-only"],
        {
          cwd: project,
          env: environment,
        },
      );
      try {
        await waitForOutput(session, "shell srt", "read-only srt startup");
        const configBefore = await fs.readFile(
          path.join(home, "config.toml"),
          "utf8",
        );
        await runCommandAfter(
          session,
          "/permissions autonomy ask",
          "cannot switch from read-only to ask while the srt sandbox was started read-only",
        );
        assert.equal(
          await fs.readFile(path.join(home, "config.toml"), "utf8"),
          configBefore,
        );
        session.child.stdin.write("/quit\r");
        const result = await Promise.race([
          session.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(result, { code: 0, signal: null });
      } finally {
        await stopPty(session);
      }
    });
  },
);

test("a real pty selects and persists a configured model", async () => {
  await withTempDirectory("codepunk-tui-model-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          test: {
            name: "Test",
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "fake",
                name: "Fake model",
                reasoning: true,
                contextWindow: 128000,
                maxTokens: 1024,
              },
              {
                id: "other",
                name: "Other Choice",
                reasoning: true,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "No default model configured.", "startup");
      await runCommandAfter(
        session,
        "/model test/fake",
        "model set to test/fake",
      );
      const partialMark = session.output().length;
      session.child.stdin.write("/model oth\r");
      await waitForOutputAfter(
        session,
        partialMark,
        "Other Choice",
        "Pi fuzzy model search",
      );
      assert.doesNotMatch(
        session.output().slice(partialMark),
        /usage: \/model/u,
      );
      assert.doesNotMatch(session.output().slice(partialMark), /Fake model/u);
      session.child.stdin.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 200));
      const searchMark = session.output().length;
      session.child.stdin.write("/model\r");
      await waitForOutputAfter(
        session,
        searchMark,
        "Other Choice",
        "Pi model selector",
      );
      session.child.stdin.write("other\r");
      await waitForOutputAfter(
        session,
        searchMark,
        "codepunk · test/other",
        "Pi model selection",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const sessionOnly = await fs.readFile(
        path.join(home, "config.toml"),
        "utf8",
      );
      assert.match(sessionOnly, /id = "fake"/u);
      await runCommandAfter(
        session,
        "/model test/other",
        "model set to test/other",
      );
      const config = await waitFor(async () => {
        try {
          const text = await fs.readFile(
            path.join(home, "config.toml"),
            "utf8",
          );
          return /id = "other"/u.test(text) ? text : null;
        } catch {
          return null;
        }
      }, "model config persistence");
      assert.match(config, /\[model\]/u);
      assert.match(config, /provider = "test"/u);
      assert.match(config, /id = "other"/u);
      assert.doesNotMatch(session.output(), /Pi-only command intercepted/u);

      const saveMark = session.output().length;
      session.child.stdin.write("/model\r");
      await waitForOutputAfter(
        session,
        saveMark,
        "Other Choice",
        "Pi model selector for default save",
      );
      session.child.stdin.write("fake");
      await waitForOutputAfter(
        session,
        saveMark,
        "Fake model",
        "Pi model filter for default save",
      );
      session.child.stdin.write("\u0013");
      await waitForOutputAfter(
        session,
        saveMark,
        "Default model: test/fake",
        "Pi default model save",
      );
      const savedDefault = await waitFor(async () => {
        try {
          const text = await fs.readFile(
            path.join(home, "config.toml"),
            "utf8",
          );
          return /id = "fake"/u.test(text) ? text : null;
        } catch {
          return null;
        }
      }, "saved default model");
      assert.match(savedDefault, /provider = "test"/u);

      const thinkingMark = session.output().length;
      session.child.stdin.write("/thinking high\r");
      await waitForOutputAfter(
        session,
        thinkingMark,
        "Thinking level: high",
        "Pi thinking selection",
      );
      const thinkingConfig = await waitFor(async () => {
        try {
          const text = await fs.readFile(
            path.join(home, "config.toml"),
            "utf8",
          );
          return /thinking = "high"/u.test(text) ? text : null;
        } catch {
          return null;
        }
      }, "thinking config persistence");
      assert.match(thinkingConfig, /provider = "test"/u);
      assert.match(thinkingConfig, /id = "fake"/u);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty scopes the model picker to physical fallback members", async () => {
  await withTempDirectory("codepunk-tui-fallback-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[model]",
        'provider = "test"',
        'id = "fake"',
        'fallback = ["test/other"]',
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          test: {
            name: "Test",
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "fake",
                name: "Fake model",
                reasoning: true,
                contextWindow: 128000,
                maxTokens: 1024,
              },
              {
                id: "other",
                name: "Other Choice",
                reasoning: true,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto -> test/fake", "startup");
      const mark = session.output().length;
      session.child.stdin.write("/model\r");
      await waitForOutputAfter(
        session,
        mark,
        "Other Choice",
        "physical fallback member",
      );
      const picker = session
        .output()
        .slice(mark)
        .replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, "");
      assert.match(picker, /Scope:\s*all\s*\|\s*scoped/u);
      assert.doesNotMatch(picker, /codepunk\/auto/u);
      session.child.stdin.write("\u001b[B");
      session.child.stdin.write("\u0013");
      await waitForOutputAfter(
        session,
        mark,
        "Default model: test/other",
        "fallback default persistence",
      );
      const config = await waitFor(async () => {
        const value = await fs.readFile(path.join(home, "config.toml"), "utf8");
        return value.includes('id = "other"') ? value : false;
      }, "fallback default config persistence");
      assert.match(config, /provider = "test"/u);
      assert.match(config, /id = "other"/u);
      assert.doesNotMatch(config, /id = "auto"/u);
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty selects recent and favorite models without replacing Pi search", async () => {
  await withTempDirectory("codepunk-tui-model-history-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          test: {
            name: "Test",
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "fake",
                name: "Fake model",
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 1024,
              },
              {
                id: "other",
                name: "Other Choice",
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "No default model configured.", "startup");
      await runCommandAfter(
        session,
        "/model test/fake",
        "model set to test/fake",
      );
      await runCommandAfter(
        session,
        "/favorite",
        "Added to favorites: test/fake",
      );
      await runCommandAfter(
        session,
        "/model test/other",
        "model set to test/other",
      );

      const menuMark = session.output().length;
      session.child.stdin.write("/models\r");
      await waitForOutputAfter(
        session,
        menuMark,
        "★ test/fake",
        "favorite model menu",
      );
      await waitForOutputAfter(
        session,
        menuMark,
        "↺ test/other (current)",
        "recent model menu",
      );
      await waitForOutputAfter(
        session,
        menuMark,
        "Search all models (Pi)",
        "Pi search escape hatch",
      );
      session.child.stdin.write("\r");
      await waitForOutputAfter(
        session,
        menuMark,
        "model set to test/fake",
        "favorite model selection",
      );
      await runCommandAfter(
        session,
        "/favorite",
        "Removed from favorites: test/fake",
      );
      const history = JSON.parse(
        await fs.readFile(path.join(home, "model-history.json"), "utf8"),
      );
      assert.deepEqual(history.favorites, []);
      assert.equal(history.recent[0], "test/fake");
      assert.equal(history.recent[1], "test/other");

      const cycleMark = session.output().length;
      session.child.stdin.write("\u001bOQ");
      await waitForOutputAfter(
        session,
        cycleMark,
        "model set to test/other",
        "F2 recent model cycle",
      );

      const searchMark = session.output().length;
      session.child.stdin.write("/model\r");
      await waitForOutputAfter(
        session,
        searchMark,
        "Other Choice",
        "Pi search still works after Codepunk history",
      );
      session.child.stdin.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 500));

      session.child.stdin.write("/quit\r");
      const exited = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(exited, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty persists a Pi default even when the picker keeps the current model", async () => {
  await withTempDirectory("codepunk-tui-default-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          test: {
            name: "Test",
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "fake",
                name: "Fake model",
                reasoning: true,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · test/fake", "startup");
      const mark = session.output().length;
      session.child.stdin.write("/model\r");
      await waitForOutputAfter(
        session,
        mark,
        "Fake model",
        "default model picker",
      );
      session.child.stdin.write("\u0013");
      await waitForOutputAfter(
        session,
        mark,
        "Default model: test/fake",
        "Pi default model status",
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
      const config = await fs.readFile(path.join(home, "config.toml"), "utf8");
      assert.match(config, /provider = "test"/u);
      assert.match(config, /id = "fake"/u);
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty shows and persists permission modes", async () => {
  await withTempDirectory("codepunk-tui-permissions-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--allow-unsandboxed-shell"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const summaryMark = session.output().length;
      await runCommandAfter(session, "/permissions", "profile: custom");
      assert.match(
        session.output().slice(summaryMark),
        /codepunk permissions/u,
      );
      assert.match(session.output().slice(summaryMark), /Profile/u);
      assert.match(session.output().slice(summaryMark), /Approvals/u);
      assert.match(session.output().slice(summaryMark), /esc close/u);
      assert.match(session.output().slice(summaryMark), /approvals: ask/u);
      assert.match(
        session.output().slice(summaryMark),
        /current shell: explicit-unsandboxed/u,
      );
      await closeOverlay(session);
      const emptyRulesMark = session.output().length;
      await runCommandAfter(
        session,
        "/permissions rules",
        "Scoped rules: none",
      );
      assert.match(session.output().slice(emptyRulesMark), /No scoped rules/u);
      assert.match(session.output().slice(emptyRulesMark), /esc close/u);
      await closeOverlay(session);
      await runCommandAfter(
        session,
        "/permissions reviewer",
        "scope: network commands and headless argv exec",
      );
      await runCommandAfter(
        session,
        "/permissions reviewer model gateway/reviewer",
        "reviewer: model",
      );
      await runCommandAfter(
        session,
        "/permissions reviewer timeout 5000",
        "reviewer timeout: 5000 ms",
      );
      await runCommandAfter(
        session,
        "/permissions reviewer off",
        "reviewer: off",
      );
      const whyMark = session.output().length;
      await runCommandAfter(
        session,
        "/permissions why date +%A",
        "rule: shell.read.date",
      );
      assert.match(session.output().slice(whyMark), /requires approval: no/u);
      assert.match(session.output().slice(whyMark), /execution: available/u);
      const dashedWhyMark = session.output().length;
      await runCommandAfter(
        session,
        "/permissions why -- touch probe.txt",
        "decision: ask",
      );
      assert.match(
        session.output().slice(dashedWhyMark),
        /rule: policy\.default/u,
      );
      await runCommandAfter(
        session,
        "/permissions approval",
        "Permission approval",
      );
      const approvalMark = session.output().length;
      session.child.stdin.write("\u001b[B\r");
      await waitForOutputAfter(
        session,
        approvalMark,
        "approvals set to deny",
        "approval picker",
      );
      const deniedMark = session.output().length;
      session.child.stdin.write("!touch denied-by-permission.txt\r");
      await waitForOutputAfter(
        session,
        deniedMark,
        "denied: approval.denied",
        "live approval mode",
      );
      assert.equal(
        await fs
          .stat(path.join(project, "denied-by-permission.txt"))
          .catch(() => null),
        null,
      );
      await runCommandAfter(
        session,
        "/permissions autonomy read-only",
        "autonomy set to read-only",
      );
      await runCommandAfter(
        session,
        "/permissions sandbox required",
        "sandbox set to required for the next session",
      );
      const config = await fs.readFile(path.join(home, "config.toml"), "utf8");
      assert.match(config, /mode = "deny"/u);
      assert.match(config, /profile = "read-only"/u);
      assert.match(config, /mode = "required"/u);
      await runCommandAfter(
        session,
        "/permissions autonomy ask",
        "autonomy set to ask",
      );
      await runCommandAfter(
        session,
        "/permissions profile full-access",
        "full-access cannot be enabled from a running session",
      );
      await runCommandAfter(
        session,
        "/permissions profile read-only",
        "permission profile set to read-only",
      );
      const profiled = await fs.readFile(
        path.join(home, "config.toml"),
        "utf8",
      );
      assert.match(profiled, /mode = "ask"/u);
      assert.match(profiled, /profile = "read-only"/u);
      assert.match(profiled, /mode = "required"/u);
      const finalPermissionsMark = session.output().length;
      await runCommandAfter(session, "/permissions", "profile: read-only");
      assert.match(
        session.output().slice(finalPermissionsMark),
        /autonomy: read-only/u,
      );
      assert.match(
        session.output().slice(finalPermissionsMark),
        /current shell: explicit-unsandboxed/u,
      );
      assert.match(
        session.output().slice(finalPermissionsMark),
        /next session sandbox: required/u,
      );
      assert.match(
        session.output().slice(finalPermissionsMark),
        /codepunk permissions/u,
      );
      await closeOverlay(session);
      assert.match(
        session.output(),
        /permissions read-only · trust trusted · shell explicit-unsandboxed/u,
      );
      await runCommandAfter(
        session,
        "/permissions sandbox uncovered",
        "sandbox set to uncovered for the next session",
      );
      assert.match(
        session.output(),
        /no shell unless started with --allow-unsandboxed-shell/u,
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("product commands and intercepted Pi builtins render through a real pty", async () => {
  await withTempDirectory("codepunk-tui-commands-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await runCommandAfter(session, "/cp-sessions", "events  (untitled)");
      await runCommandAfter(
        session,
        "/evidence",
        "No evidence in the current run.",
      );
      await runCommandAfter(session, "/doctor", "codepunk doctor (");
      await runCommandAfter(session, "/policy", "approval: ask");
      await runCommandAfter(
        session,
        "/cp-export",
        "Exported redacted transcript:",
      );
      await runCommandAfter(session, "/mcp", "MCP servers (user scope)");
      await runCommandAfter(session, "/skills", "Skills (0)");
      await runCommandAfter(session, "/plugins", "Plugins (disabled, 0 files)");
      await runCommandAfter(
        session,
        "/sign",
        "the current run has no durable run/end",
      );
      await runCommandAfter(session, "/session", "session: ");
      assert.match(session.output(), /model: unknown\/unknown/u);
      assert.match(session.output(), /evidence: 0 record/u);
      await runCommandAfter(session, "/resume", "Already in session ");
      assert.match(session.output(), /events  \(untitled\)/u);
      await runCommandAfter(
        session,
        "/export",
        "Exported redacted transcript:",
      );
      await runCommandAfter(session, "/new", "Start a new codepunk session?");
      session.child.stdin.write("\u001b");
      await waitForQuiet(session, 250);
      await runCommandAfter(
        session,
        "/import probe.jsonl",
        "Codepunk sessions keep their own evidence chain; use /cp-sessions or `codepunk --session <id>`.",
      );
      assert.doesNotMatch(session.output(), /codepunk --resume/u);
      await runCommandAfter(session, "/compact", "Compaction");
      await runCommandAfter(session, "/remember probe fact", "remembered mem_");
      await runCommandAfter(
        session,
        "/memory search probe",
        "[project] probe fact",
      );
      await runCommandAfter(
        session,
        "/remember list marker",
        "remembered mem_",
      );
      await runCommandAfter(session, "/memory list", "list marker");
      await runCommandAfter(
        session,
        "/remember archive marker",
        "remembered mem_",
      );
      const archiveCandidates = [
        ...session.output().matchAll(/remembered (mem_[a-z0-9]+)/gu),
      ];
      const archiveId = archiveCandidates.at(-1)?.[1];
      assert.ok(archiveId);
      await runCommandAfter(
        session,
        `/memory archive ${archiveId}`,
        `archived ${archiveId}`,
      );
      await runCommandAfter(
        session,
        "/memory search archive marker",
        "No memory records matched.",
      );
      await runCommandAfter(
        session,
        "/remember user preference --scope user",
        "remembered mem_",
      );
      await runCommandAfter(
        session,
        "/memory search user preference",
        "[user] user preference",
      );
      const remembered = [
        ...session.output().matchAll(/remembered (mem_[a-z0-9]+)/gu),
      ];
      const memoryId = remembered.at(-1)?.[1];
      assert.ok(memoryId);
      await runCommandAfter(
        session,
        `/memory delete ${memoryId}`,
        `deleted ${memoryId}`,
      );
      await runCommandAfter(
        session,
        "/memory search user preference",
        "No memory records matched.",
      );
      await runCommandAfter(session, "/permissions", "approvals: ask");
      await closeOverlay(session);
      await runCommandAfter(session, "/model", "No authenticated models.");
      assert.match(session.output(), /Add a provider first:/u);
      assert.match(session.output(), /Then run \/model to choose a model\./u);
      await runCommandAfter(
        session,
        "/model test/fake",
        "No authenticated models.",
      );
      await runCommandAfter(
        session,
        "/settings",
        "codepunk settings are file-backed",
      );
      await runCommandAfter(
        session,
        "/scoped-models",
        "Model scope is file-backed in codepunk.",
      );
      await runCommandAfter(session, "/trust", "project resources: none");
      await runCommandAfter(
        session,
        "/trust grant",
        "workspace trust saved as trusted",
      );
      await runCommandAfter(
        session,
        "/trust status",
        "saved decision: trusted",
      );
      await runCommandAfter(
        session,
        "/import session.jsonl",
        "Pi session import is not supported",
      );
      await runCommandAfter(session, "/share", "Use /cp-export");
      await runCommandAfter(
        session,
        "/bug a synthetic report hint",
        "Pi's /bug flow can upload a session transcript",
      );
      await runCommandAfter(
        session,
        "/reload",
        "Reloaded Pi resources and MCP configuration.",
      );
      await runCommandAfter(
        session,
        "/skills",
        "run /reload after changing skills",
      );
      await runCommandAfter(
        session,
        "/mcp",
        "run /reload after changing MCP configuration",
      );
      await runCommandAfter(session, "/fork", "forked ");
      await runCommandAfter(session, "/tree list", "Session tree");
      await runCommandAfter(
        session,
        "/definitely-not-a-command",
        "Unknown command /definitely-not-a-command.",
      );
      assert.match(
        session.output(),
        /Type \/help for the available Codepunk commands\./u,
      );
      await runCommandAfter(
        session,
        "/help",
        "Host commands that would bypass the Codepunk session",
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
      assert.match(session.output(), /exported|Exported/u);
    } finally {
      await stopPty(session);
    }
  });
});

test("/login and /logout reach the Pi host instead of being intercepted", async () => {
  await withTempDirectory("codepunk-tui-auth-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");

      const loginMark = session.output().length;
      session.child.stdin.write("/login\r");
      await waitForOutputAfter(
        session,
        loginMark,
        "Select authentication method:",
        "/login",
      );
      assert.doesNotMatch(
        session.output().slice(loginMark),
        /Pi-only command intercepted/u,
      );
      session.child.stdin.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 250));

      const logoutMark = session.output().length;
      session.child.stdin.write("/logout\r");
      await waitForOutputAfter(
        session,
        logoutMark,
        "No stored credentials to remove.",
        "/logout",
      );
      assert.doesNotMatch(
        session.output().slice(logoutMark),
        /Pi-only command intercepted/u,
      );

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty resumes another session without restarting the CLI", async () => {
  await withTempDirectory("codepunk-tui-resume-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const model = await startTextModelServer();
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "chat",
                name: "Chat",
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    try {
      const cli = await ensureBuilt();
      const env = {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      };
      const first = startPty(process.execPath, [cli], { cwd: project, env });
      let firstId;
      try {
        await waitForOutput(first, "codepunk · local/chat", "first startup");
        first.child.stdin.write("first question\r");
        await waitForOutput(first, "CHILD_OK", "first model reply");
        const firstMarker = first.output().length;
        first.child.stdin.write("unique-body-marker\r");
        await waitForOutputAfter(
          first,
          firstMarker,
          "CHILD_OK",
          "first marker reply",
        );
        await runCommandAfter(first, "/session", "session: ");
        const ids = [...first.output().matchAll(/session: ([0-9A-Z]{10,})/gu)];
        firstId = ids.at(-1)?.[1];
        assert.ok(firstId);
        first.child.stdin.write("/quit\r");
        const exited = await Promise.race([
          first.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(exited, { code: 0, signal: null });
      } finally {
        await stopPty(first);
      }

      const second = startPty(process.execPath, [cli, "--new-session"], {
        cwd: project,
        env,
      });
      try {
        await waitForOutput(second, "codepunk · local/chat", "second startup");
        second.child.stdin.write("second question\r");
        await waitForOutput(second, "CHILD_OK", "second model reply");
        await runCommandAfter(second, "/session", "session: ");
        const ids = [...second.output().matchAll(/session: ([0-9A-Z]{10,})/gu)];
        const secondId = ids.at(-1)?.[1];
        assert.ok(secondId);
        assert.notEqual(secondId, firstId);

        await runCommandAfter(
          second,
          "/resume unique-body-marker",
          `resumed session ${firstId}`,
        );
        await runCommandAfter(second, "/session", `session: ${firstId}`);
        second.child.stdin.write("after resume\r");
        await waitForOutput(second, "CHILD_OK", "model reply after resume");
        second.child.stdin.write("/quit\r");
        const exited = await Promise.race([
          second.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(exited, { code: 0, signal: null });
      } finally {
        await stopPty(second);
      }
    } finally {
      model.server.closeAllConnections?.();
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test("a real pty starts a new session in place", async () => {
  await withTempDirectory("codepunk-tui-new-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const cli = await ensureBuilt();
    const session = startPty(process.execPath, [cli], {
      cwd: project,
      env: {
        ...BASE_ENV,
        CODEPUNK_HOME: home,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      await runCommandAfter(session, "/session", "session: ");
      const firstMatches = [
        ...session.output().matchAll(/session: ([0-9A-Z]{10,})/gu),
      ];
      const firstId = firstMatches.at(-1)?.[1];
      assert.ok(firstId);
      await runCommandAfter(session, "/new", "Start a new codepunk session?");
      session.child.stdin.write("\r");
      await waitForOutput(session, "started session ", "new session");
      await runCommandAfter(session, "/session", "session: ");
      const secondMatches = [
        ...session.output().matchAll(/session: ([0-9A-Z]{10,})/gu),
      ];
      const secondId = secondMatches.at(-1)?.[1];
      assert.ok(secondId);
      assert.notEqual(secondId, firstId);
      session.child.stdin.write("/quit\r");
      const exited = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(exited, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});

test("a real pty navigates the session tree and forks into a child session", async () => {
  await withTempDirectory("codepunk-tui-fork-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const model = await startTextModelServer();
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "chat",
                name: "Chat",
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    try {
      const cli = await ensureBuilt();
      const session = startPty(process.execPath, [cli], {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      });
      try {
        await waitForOutput(session, "codepunk · local/chat", "startup");
        session.child.stdin.write("first branch prompt\r");
        await waitForOutput(session, "CHILD_OK", "first reply");
        session.child.stdin.write("second branch prompt\r");
        await waitForOutput(session, "CHILD_OK", "second reply");
        await runCommandAfter(session, "/session", "session: ");
        const idMatches = [
          ...session.output().matchAll(/session: ([0-9A-Z]{10,})/gu),
        ];
        const parentId = idMatches.at(-1)?.[1];
        assert.ok(parentId);
        const stateEntry = await waitFor(
          async () =>
            (await fs.readdir(home, { recursive: true })).find((entry) =>
              entry.endsWith(
                path.join("sessions", parentId, "agent-state.json"),
              ),
            ) ?? null,
          "parent agent state",
        );
        const statePath = path.join(home, stateEntry);
        const parentState = JSON.parse(await fs.readFile(statePath, "utf8"));
        const firstEntry = parentState.branch.find(
          (entry) => entry.type === "message" && entry.message?.role === "user",
        );
        assert.ok(firstEntry);

        session.child.stdin.write("/tree\r");
        await waitForOutput(session, "Session Tree", "Pi tree selector");
        session.child.stdin.write("\u001b");
        await new Promise((resolve) => setTimeout(resolve, 250));
        await runCommandAfter(
          session,
          `/tree ${firstEntry.id}`,
          `moved to ${firstEntry.id}`,
        );
        const sessionLog = await waitFor(
          async () =>
            (await fs.readdir(home, { recursive: true })).find((entry) =>
              entry.endsWith(path.join("sessions", parentId, "session.jsonl")),
            ) ?? null,
          "parent session log",
        );
        const logRecords = (
          await fs.readFile(path.join(home, sessionLog), "utf8")
        )
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line));
        assert.ok(
          logRecords.some(
            (record) =>
              record.kind === "session/tree" &&
              record.data?.target_entry_id === firstEntry.id &&
              record.data?.to_entry_id === (firstEntry.parentId ?? null),
          ),
          JSON.stringify({
            firstEntryId: firstEntry.id,
            treeRecords: logRecords.filter(
              (record) => record.kind === "session/tree",
            ),
          }),
        );

        session.child.stdin.write("third branch prompt\r");
        await waitForOutput(session, "CHILD_OK", "reply after tree move");
        await runCommandAfter(session, "/fork", "forked ");
        await runCommandAfter(session, "/session", "session: ");
        const childMatches = [
          ...session.output().matchAll(/session: ([0-9A-Z]{10,})/gu),
        ];
        const childId = childMatches.at(-1)?.[1];
        assert.ok(childId);
        assert.notEqual(childId, parentId);
        const childStateEntry = await waitFor(
          async () =>
            (await fs.readdir(home, { recursive: true })).find((entry) =>
              entry.endsWith(
                path.join("sessions", childId, "agent-state.json"),
              ),
            ) ?? null,
          "child agent state",
        );
        const childState = JSON.parse(
          await fs.readFile(path.join(home, childStateEntry), "utf8"),
        );
        assert.equal(childState.header.id, childId);
        const childLogEntry = await waitFor(
          async () =>
            (await fs.readdir(home, { recursive: true })).find((entry) =>
              entry.endsWith(path.join("sessions", childId, "session.jsonl")),
            ) ?? null,
          "child session log",
        );
        const childLog = (
          await fs.readFile(path.join(home, childLogEntry), "utf8")
        )
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line));
        assert.equal(childLog[0].type, "codepunk/session");
        assert.equal(childLog[0].parent_session_id, parentId);
        const forkedEvent = childLog.find(
          (record) => record.kind === "session/forked",
        );
        assert.ok(forkedEvent);
        assert.equal(forkedEvent.data.parent_session_id, parentId);
        assert.equal(forkedEvent.data.mode, "live");

        session.child.stdin.write("/quit\r");
        const exited = await Promise.race([
          session.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(exited, { code: 0, signal: null });
      } finally {
        await stopPty(session);
      }
    } finally {
      model.server.closeAllConnections?.();
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test("a real pty queues input as steering while the model is streaming", async () => {
  await withTempDirectory("codepunk-tui-steer-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    const model = await startHeldModelServer();
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "chat",
                name: "Chat",
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    try {
      const cli = await ensureBuilt();
      const session = startPty(process.execPath, [cli], {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      });
      try {
        await waitForOutput(session, "codepunk · local/chat", "startup");
        session.child.stdin.write("first question\r");
        await waitFor(
          () => (model.requests.length === 1 ? true : null),
          "first model request",
        );
        session.child.stdin.write("steer now\r");
        await waitForOutput(
          session,
          "Steering: steer now",
          "queued steering message",
        );
        assert.equal(model.requests.length, 1);
        model.releaseFirst();
        await waitForOutput(session, "FIRST_DONE", "first model reply");
        await waitForOutput(session, "STEER_DONE", "steered model reply");
        const files = await fs.readdir(home, { recursive: true });
        const logEntry = files.find((entry) => entry.endsWith("session.jsonl"));
        assert.ok(logEntry);
        const inputs = (await fs.readFile(path.join(home, logEntry), "utf8"))
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line))
          .filter((record) => record.kind === "user/input")
          .map((record) => record.data.text);
        assert.ok(inputs.includes("first question"));
        assert.ok(inputs.includes("steer now"));
        session.child.stdin.write("/quit\r");
        const exited = await Promise.race([
          session.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(exited, { code: 0, signal: null });
      } finally {
        await stopPty(session);
      }
    } finally {
      model.server.closeAllConnections?.();
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test("a real pty surfaces a stopped budget and refuses more model calls", async () => {
  await withTempDirectory("codepunk-tui-budget-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(
      path.join(home, "config.toml"),
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[budget]",
        "max_tokens = 1",
        "",
      ].join("\n"),
    );
    const model = await startTextModelServer();
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "chat",
                name: "Chat",
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    try {
      const cli = await ensureBuilt();
      const session = startPty(process.execPath, [cli], {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
      });
      try {
        await waitForOutput(session, "codepunk · local/chat", "startup");
        assert.match(stripAnsi(session.output()), /budget 0\/1 tokens/u);
        session.child.stdin.write("first question\r");
        await waitForOutput(session, "CHILD_OK", "first model reply");
        await waitForOutput(
          session,
          "budget stopped at 5/1 tokens",
          "budget status line",
        );
        await runCommandAfter(
          session,
          "/budget",
          "budget: stopped at 5/1 tokens; start a new session with /new",
        );
        await runCommandAfter(
          session,
          "/status",
          "budget: stopped at 5/1 tokens; start a new session with /new",
        );
        session.child.stdin.write("\u001b");
        await waitForQuiet(session, 250);
        await runCommandAfter(
          session,
          "/session",
          "budget: stopped at 5/1 tokens; start a new session with /new",
        );
        const requestsBefore = model.requests.length;
        assert.equal(requestsBefore, 1);
        session.child.stdin.write("second question\r");
        await waitForOutput(
          session,
          "session budget exhausted (5/1 tokens)",
          "budget refusal",
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(model.requests.length, requestsBefore);
        session.child.stdin.write("/quit\r");
        const exited = await Promise.race([
          session.exited,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: "timeout", signal: null }),
              20_000,
            ),
          ),
        ]);
        assert.deepEqual(exited, { code: 0, signal: null });
      } finally {
        await stopPty(session);
      }
    } finally {
      model.server.closeAllConnections?.();
      await new Promise((resolve) => model.server.close(resolve));
    }
  });
});

test("a real pty runs /subagent as a read-only child session", async () => {
  await withTempDirectory("codepunk-tui-subagent-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(home);
    await fs.mkdir(path.join(home, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(home, "agents", "reviewer.md"),
      [
        "---",
        "name: reviewer",
        "description: Review a bounded change set",
        "tools: read, search",
        "---",
        "Review the requested change.",
        "",
      ].join("\n"),
    );
    await fs.writeFile(path.join(project, "hello.txt"), "hello\n");
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.email=child@example.test",
        "-c",
        "user.name=Child Test",
        "add",
        "hello.txt",
      ],
      { cwd: project },
    );
    await execFileAsync(
      "git",
      [
        "-c",
        "user.email=child@example.test",
        "-c",
        "user.name=Child Test",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: project },
    );
    const modelServer = await startHeldModelServer();
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ local: { type: "api_key", key: "sk-child-test" } }),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: modelServer.baseUrl,
            apiKey: "sk-child-test",
            api: "openai-completions",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 4_000,
                maxTokens: 1_000,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          TERM: "xterm-256color",
          NO_COLOR: "1",
          PI_OFFLINE: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      await runCommandAfter(session, "/agents", "No subagents");
      assert.match(session.output(), /Background subagents/u);
      assert.match(session.output(), /esc close/u);
      await closeOverlay(session);
      await runCommandAfter(session, "/agents profiles", "reviewer (user)");
      const mark = session.output().length;
      session.child.stdin.write(
        "/subagent --profile reviewer reply with exactly CHILD_OK\r",
      );
      await waitForOutputAfter(
        session,
        mark,
        "subagent started:",
        "/subagent start",
      );
      await waitForOutputAfter(
        session,
        mark,
        "profile: reviewer (user)",
        "/subagent profile",
      );
      const childSessionId = session
        .output()
        .slice(mark)
        .match(/subagent started: ([A-Za-z0-9_-]+)/u)?.[1];
      assert.ok(childSessionId);
      await waitFor(
        () => modelServer.requests.length > 0,
        "the held child model request",
      );

      const transcriptMark = session.output().length;
      session.child.stdin.write(`/agents transcript ${childSessionId}\r`);
      await waitForOutputAfter(
        session,
        transcriptMark,
        "CODEPUNK SUBAGENT TRANSCRIPT",
        "/agents transcript browser",
      );
      await waitForOutputAfter(
        session,
        transcriptMark,
        "live",
        "/agents transcript live state",
      );
      modelServer.releaseFirst();
      await waitForOutputAfter(
        session,
        transcriptMark,
        "FIRST_DONE",
        "/agents transcript live output",
      );
      session.child.stdin.write("\u001b");
      await waitForOutputAfter(
        session,
        transcriptMark,
        "codepunk · local/local-test",
        "/agents transcript close",
      );
      await waitForOutputAfter(
        session,
        mark,
        `completed; use /agents result ${childSessionId}`,
        "/subagent completion",
      );
      assert.match(session.output().slice(mark), /FIRST_DONE/u);
      await runCommandAfter(
        session,
        `/agents result ${childSessionId}`,
        "FIRST_DONE",
      );
      const agentsMark = session.output().length;
      await runCommandAfter(session, "/agents", "completed");
      assert.match(session.output().slice(agentsMark), /AGENT/u);
      assert.match(session.output().slice(agentsMark), /SESSION/u);
      assert.match(session.output().slice(agentsMark), /STATUS/u);
      assert.match(session.output().slice(agentsMark), /NEXT/u);
      assert.match(session.output().slice(agentsMark), /esc close/u);
      await closeOverlay(session);
      await runCommandAfter(
        session,
        `/agents stop ${childSessionId}`,
        `subagent ${childSessionId} is already completed`,
      );
      assert.doesNotMatch(session.output().slice(mark), /failed:/u);
      assert.doesNotMatch(session.output().slice(mark), /parent waits/u);

      const logs = [];
      for (const entry of await fs.readdir(home, { recursive: true })) {
        if (!entry.endsWith("session.jsonl")) {
          continue;
        }
        const lines = (await fs.readFile(path.join(home, entry), "utf8"))
          .split("\n")
          .filter((line) => line.length > 0);
        for (const line of lines.slice(1)) {
          logs.push({ entry, event: JSON.parse(line) });
        }
      }
      const linked = logs.find(({ event }) => event.kind === "subagent/result");
      assert.ok(linked);
      assert.equal(linked.event.data.status, "completed");
      assert.equal(linked.event.data.depth, 1);
      assert.equal(linked.event.data.isolation, "shared");
      assert.equal(linked.event.data.model, "local/local-test");
      assert.equal(linked.event.data.profile, "reviewer");
      assert.match(linked.event.data.profile_sha256, /^sha256:[a-f0-9]{64}$/u);
      assert.equal(linked.event.data.summary, "FIRST_DONE");
      assert.equal(linked.event.data.evidence_head, null);
      assert.equal(linked.event.data.worktree, null);
      assert.equal(linked.event.data.changed_files, 0);
      assert.ok(
        logs.some(({ entry }) =>
          entry.endsWith(
            path.join(linked.event.data.child_session_id, "session.jsonl"),
          ),
        ),
      );

      const capabilitiesMark = session.output().length;
      session.child.stdin.write("/capabilities\r");
      await waitForOutputAfter(
        session,
        capabilitiesMark,
        "codepunk capabilities",
        "/capabilities",
      );
      await waitForOutputAfter(
        session,
        capabilitiesMark,
        "Skills (0)",
        "/capabilities skills",
      );

      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
      modelServer.server.closeAllConnections?.();
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("a real pty reviews, signs, and merges a mutating subagent worktree", async () => {
  await withTempDirectory("codepunk-tui-subagent-delivery-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(path.join(home, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(home, "agents", "worker.md"),
      [
        "---",
        "name: worker",
        "description: Write a bounded child change",
        "tools: read, write",
        "---",
        "Write the requested file in the child worktree.",
        "",
      ].join("\n"),
    );
    await fs.writeFile(path.join(project, "hello.txt"), "hello\n");
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "child@example.test"], {
      cwd: project,
    });
    await execFileAsync("git", ["config", "user.name", "Child Test"], {
      cwd: project,
    });
    await execFileAsync("git", ["config", "core.autocrlf", "false"], {
      cwd: project,
    });
    await execFileAsync("git", ["add", "hello.txt"], { cwd: project });
    await execFileAsync("git", ["commit", "-qm", "fixture"], {
      cwd: project,
    });
    await trustWorkspace(home, project);
    const modelServer = await startWriteModelServer({
      path: "child-output.txt",
      content: "merged by child\n",
    });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ local: { type: "api_key", key: "sk-child-test" } }),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: modelServer.baseUrl,
            apiKey: "sk-child-test",
            api: "openai-completions",
            models: [
              {
                id: "local-test",
                name: "Local Test",
                api: "openai-completions",
                contextWindow: 4_000,
                maxTokens: 1_000,
              },
            ],
          },
        },
      }),
    );
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--model", "local/local-test"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          TERM: "xterm-256color",
          NO_COLOR: "1",
          PI_OFFLINE: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · local/local-test", "startup");
      await runCommandAfter(session, "/agents profiles", "worker (user)");
      const startMark = session.output().length;
      session.child.stdin.write(
        "/subagent --profile worker write child-output.txt\r",
      );
      await waitForOutputAfter(
        session,
        startMark,
        "subagent started:",
        "/subagent start",
      );
      const childSessionId = session
        .output()
        .slice(startMark)
        .match(/subagent started: ([A-Za-z0-9_-]+)/u)?.[1];
      assert.ok(childSessionId);
      await waitForOutputAfter(
        session,
        startMark,
        `completed; use /agents result ${childSessionId}`,
        "/subagent completion",
      );
      await waitForOutputAfter(
        session,
        startMark,
        "transcript.jsonl",
        "/agents completion transcript",
      );
      assert.match(session.output().slice(startMark), /transcript:/u);
      const transcriptMark = session.output().length;
      session.child.stdin.write(`/agents transcript ${childSessionId}\r`);
      await waitForOutputAfter(
        session,
        transcriptMark,
        "CODEPUNK SUBAGENT TRANSCRIPT",
        "/agents transcript browser",
      );
      await waitForOutputAfter(
        session,
        transcriptMark,
        "TOOL write [ok",
        "/agents transcript tool output",
      );
      await waitForOutputAfter(
        session,
        transcriptMark,
        "WRITE_DONE",
        "/agents transcript assistant output",
      );
      session.child.stdin.write("\u001b");
      await waitForOutputAfter(
        session,
        transcriptMark,
        "codepunk · local/local-test",
        "/agents transcript close",
      );
      await runCommandAfter(
        session,
        `/agents review ${childSessionId}`,
        "child-output.txt",
      );

      const signMark = session.output().length;
      session.child.stdin.write(`/agents sign ${childSessionId}\r`);
      await waitForOutputAfter(
        session,
        signMark,
        `Sign subagent ${childSessionId}`,
        "/agents sign menu",
      );
      session.child.stdin.write("\r");
      await waitForOutputAfter(
        session,
        signMark,
        "signed complete",
        "/agents sign complete",
      );

      const mergeMark = session.output().length;
      session.child.stdin.write(`/agents merge ${childSessionId}\r`);
      await waitForOutputAfter(
        session,
        mergeMark,
        `Merge subagent ${childSessionId}?`,
        "/agents merge menu",
      );
      session.child.stdin.write("\r");
      await waitForOutputAfter(
        session,
        mergeMark,
        "merge commit:",
        "/agents merge commit",
      );
      assert.equal(
        await fs.readFile(path.join(project, "child-output.txt"), "utf8"),
        "merged by child\n",
      );
      assert.match(session.output().slice(mergeMark), /worktree removed/u);
      await runCommandAfter(session, "/agents", childSessionId);
      assert.match(session.output(), /merged/u);
      await closeOverlay(session);
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
      modelServer.server.closeAllConnections?.();
      await new Promise((resolve) => modelServer.server.close(resolve));
    }
  });
});

test("a read-only parent rejects a mutating subagent profile", async () => {
  await withTempDirectory("codepunk-tui-subagent-ceiling-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project);
    await fs.mkdir(path.join(home, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(home, "agents", "worker.md"),
      [
        "---",
        "name: worker",
        "description: Write in a child worktree",
        "tools: read, write",
        "---",
        "Write the requested file.",
        "",
      ].join("\n"),
    );
    await fs.writeFile(path.join(project, "hello.txt"), "hello\n");
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "child@example.test"], {
      cwd: project,
    });
    await execFileAsync("git", ["config", "user.name", "Child Test"], {
      cwd: project,
    });
    await execFileAsync("git", ["add", "hello.txt"], { cwd: project });
    await execFileAsync("git", ["commit", "-qm", "fixture"], {
      cwd: project,
    });
    const cli = await ensureBuilt();
    const session = startPty(
      process.execPath,
      [cli, "--permission-mode", "read-only"],
      {
        cwd: project,
        env: {
          ...BASE_ENV,
          CODEPUNK_HOME: home,
          TERM: "xterm-256color",
          NO_COLOR: "1",
          PI_OFFLINE: "1",
        },
      },
    );
    try {
      await waitForOutput(session, "codepunk · auto/auto", "startup");
      const mark = session.output().length;
      session.child.stdin.write(
        "/subagent --profile worker write child-output.txt\r",
      );
      await waitForOutputAfter(
        session,
        mark,
        "failed: a read-only parent cannot spawn a mutating subagent",
        "parent ceiling rejection",
      );
      session.child.stdin.write("/quit\r");
      const result = await Promise.race([
        session.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "timeout", signal: null }), 20_000),
        ),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally {
      await stopPty(session);
    }
  });
});
