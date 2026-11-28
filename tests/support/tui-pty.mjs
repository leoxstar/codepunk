import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { REPO_ROOT, withoutAmbientProviderEnv } from "./helpers.mjs";
import { importCore } from "./core.mjs";

export const execFileAsync = promisify(execFile);
export const core = await importCore();
export const SRT_PTY_SKIP =
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
export const PTY_RUNNER =
  process.platform === "win32"
    ? [
        process.execPath,
        path.join(REPO_ROOT, "tests", "support", "pty-run.mjs"),
      ]
    : ["python3", path.join(REPO_ROOT, "tests", "support", "pty-run.py")];

// These tests assert what the TUI shows before a model is configured, so the
// provider credentials of the machine running the suite must not reach the
// child process.
export const BASE_ENV = withoutAmbientProviderEnv();
export const IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAANCAIAAAAv2XlzAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAADQAAAACsJSLBAAACGUlEQVQoFQ2Py27TQABF5z1+JnaSIipEQUKCVgIJBKwoO8TH8BF8Enu2SEj8ABUFWqrEzcNJ6vd4xh7PkP25R/fAz58+IhoAYBwvqIRKFkvCOOeslQ1EJPScOs8gMC6j27yZTEZkEsWdxdgOo/GYOb0UDSH8sD8/f+/5/mQ6+/b1S5UXlMLe2OdnT0kYeJT72yyfp3fTOJ5Fo8EAL/DH0bTrZK/10TQOGRpM7/t+qzVCYPBc7nO2WKVlWXBijVGuS+typ2Sjyjs9DFEcEsriaCS0Qr2szaBdBk9mwX0fAdO3QnBGhJTQmng6BQgCiKXQRVYzYknfq7atrv/Ot0nyJnq50v335doPwpvLHy+ePcZcKyW1tLubxbqoW9clZjBV3c5vkiMKoexV01ZCFkU5o32Mh18XF/kuyzKBalnV6nK+J0labev8Oi3C4yjZ7FLVxJy8On1UJBZyVG3K31fLg/xk7EoD8krhbd3N00YBlpZiVVTWKkLwu9dnmDt/btchxU2jbld7zul4HNZ1ixEhFhHf5aofEMMIWs8hFMNoFP68+EekeBK5MUe+S91x7FFzEDGHQmQHgCiBNqv745mf7vPFbZpv9g4bsO3LRlxtqnUuPrw9xZ5LXAqsGZrOAnB4KdrOwk7uVkvG2cjjm1xkldBaH7Dddo8xQZ7DEACV1NbYrlPZoQwDqAdRCdOppmpED2YBuheghw/i/+orRkAlNmTDAAAAAElFTkSuQmCC";

export async function startTextModelServer() {
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

export async function startHeldModelServer() {
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

export function sendTextResponse(response, text) {
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

export async function startReviewModelServer(responses, options = {}) {
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

export async function startPlanRoundModelServer() {
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

export async function startToolProjectionModelServer() {
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

export async function startWriteModelServer({ path: targetPath, content }) {
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

export function startPty(command, args, { cwd, env }) {
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

export async function waitForPtyExit(exited, timeoutMs) {
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

export async function killPtyGroup(session) {
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

export async function stopPty(
  session,
  { gracefulMs = 2_000, killMs = 5_000, closeMs = 250 } = {},
) {
  const startedAt = Date.now();
  let ptyPid = null;
  try {
    ptyPid = await killPtyGroup(session);
    if (session.child.exitCode === null && session.child.signalCode === null) {
      if (process.platform === "win32" && session.child.pid !== undefined) {
        await new Promise((resolve) => {
          execFile(
            "taskkill",
            ["/PID", String(session.child.pid), "/T", "/F"],
            { windowsHide: true, timeout: 5_000 },
            () => resolve(),
          );
        });
      }
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

export async function waitForOutput(session, marker, label) {
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

export async function waitForOutputAfter(session, mark, marker, label) {
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

export function stripAnsi(value) {
  return value.replace(
    // CSI, OSC, and simple two-byte escape sequences emitted by the TUI.
    /\u001b(?:\][^\u0007]*?(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/gu,
    "",
  );
}

export async function waitForAnyOutputAfter(session, mark, markers, label) {
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

export async function submitUserBashWhenIdle(session, command, label) {
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

export async function waitForQuiet(session, quietMs = 100, timeoutMs = 10_000) {
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

export async function runCommandAfter(session, command, marker) {
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

export async function closeOverlay(session) {
  session.child.stdin.write("\u001b");
  await waitForQuiet(session, 250);
}

export async function waitFor(predicate, label, timeoutMs = 20_000) {
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

export async function readEvidence(home) {
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

export async function waitForBashResult(home, command, minimumMatches = 1) {
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
