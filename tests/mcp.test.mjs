import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import {
  assertPrivateFile,
  ensureBuilt,
  trustWorkspace,
  withTempDirectory,
  writeFile,
} from "./support/helpers.mjs";
import { TEST_MODEL } from "./support/pi-model.mjs";

const core = await importCore();
const execFileAsync = promisify(execFile);
const FIXTURE = path.join(
  import.meta.dirname,
  "support",
  "mcp-echo-server.mjs",
);

async function makeRepo(root) {
  const project = path.join(root, "project");
  await fs.mkdir(project);
  await execFileAsync("git", ["init", "-q"], { cwd: project });
  await trustWorkspace(path.join(root, "home"), project);
  return project;
}

async function startHttpMcpServer(expectedToken = "http-test-token") {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({
      method: message.method,
      authorization: request.headers.authorization ?? null,
    });
    if (request.headers.authorization !== `Bearer ${expectedToken}`) {
      response.statusCode = 401;
      response.end();
      return;
    }
    if (message.id === undefined) {
      response.statusCode = 202;
      response.end();
      return;
    }
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "http-echo", version: "1.0.0" },
      };
    } else if (message.method === "tools/list") {
      result = {
        tools: [
          {
            name: "echo",
            description: "Echo text over HTTP",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      };
    } else if (message.method === "tools/call") {
      result = {
        content: [
          { type: "text", text: `http:${message.params.arguments.text}` },
        ],
      };
    } else {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "unknown method" }));
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startOAuthMcpServer(options = {}) {
  const refreshDelayMs = options.refreshDelayMs ?? 0;
  const validAccessTokens = new Set();
  const registrations = [];
  let refreshCounter = 1;
  let signalRefreshStarted;
  const refreshStarted = new Promise((resolve) => {
    signalRefreshStarted = resolve;
  });
  const server = http.createServer(async (request, response) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(request.url ?? "/", base);
    const sendJson = (value, status = 200) => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(value));
    };
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-protected-resource/mcp"
    ) {
      sendJson({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ["mcp.read"],
        bearer_methods_supported: ["header"],
      });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-authorization-server"
    ) {
      sendJson({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["mcp.read"],
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/register") {
      const body = JSON.parse(await readRequestBody(request));
      registrations.push(body);
      sendJson({
        client_id: "oauth-test-client",
        redirect_uris: body.redirect_uris,
        token_endpoint_auth_method: "none",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/authorize") {
      const redirect = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (redirect === null || state === null) {
        response.statusCode = 400;
        response.end("missing redirect_uri or state");
        return;
      }
      const target = new URL(redirect);
      target.searchParams.set("code", "oauth-code");
      target.searchParams.set("state", state);
      response.statusCode = 302;
      response.setHeader("location", target.href);
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/token") {
      const body = new URLSearchParams(await readRequestBody(request));
      if (body.get("grant_type") === "authorization_code") {
        if (body.get("code") !== "oauth-code") {
          sendJson({ error: "invalid_grant" }, 400);
          return;
        }
        validAccessTokens.add("access-1");
        sendJson({
          access_token: "access-1",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "refresh-1",
          scope: "mcp.read",
        });
        return;
      }
      if (body.get("grant_type") === "refresh_token") {
        if (body.get("refresh_token") === "revoked") {
          sendJson({ error: "invalid_grant" }, 400);
          return;
        }
        signalRefreshStarted?.();
        signalRefreshStarted = undefined;
        if (refreshDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, refreshDelayMs));
        }
        refreshCounter += 1;
        const access = `access-${refreshCounter}`;
        validAccessTokens.add(access);
        sendJson({
          access_token: access,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: `refresh-${refreshCounter}`,
          scope: "mcp.read",
        });
        return;
      }
      sendJson({ error: "unsupported_grant_type" }, 400);
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/mcp") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : null;
    if (token === null || !validAccessTokens.has(token)) {
      response.statusCode = 401;
      response.setHeader(
        "www-authenticate",
        `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      );
      response.end("unauthorized");
      return;
    }
    const message = JSON.parse(await readRequestBody(request));
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "oauth-echo", version: "1.0.0" },
      };
    } else if (message.method === "tools/list") {
      result = {
        tools: [
          {
            name: "echo",
            description: "Echo text over OAuth HTTP",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      };
    } else if (message.method === "tools/call") {
      result = {
        content: [
          { type: "text", text: `oauth:${message.params.arguments.text}` },
        ],
      };
    } else {
      sendJson({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "unknown method" },
      });
      return;
    }
    sendJson({ jsonrpc: "2.0", id: message.id, result });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    registrations,
    refreshStarted,
    validAccessTokens,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function projectPaths(root, project, home) {
  const context = await core.findDeliveryRoot(project);
  const paths = core.projectPaths(context, home);
  await core.ensureProjectRegistration(context, paths);
  await core.ensureProjectConfigDir(paths);
  return paths;
}

function serverTable(name, mode = "normal", pidFile = null) {
  return [
    `[servers.${name}]`,
    'command = "node"',
    `args = [${JSON.stringify(FIXTURE)}]`,
    "",
    `[servers.${name}.env]`,
    `CODEPUNK_MCP_FIXTURE_MODE = ${JSON.stringify(mode)}`,
    ...(pidFile === null
      ? []
      : [`CODEPUNK_MCP_FIXTURE_PID_FILE = ${JSON.stringify(pidFile)}`]),
    "",
  ].join("\n");
}

async function readPid(file) {
  const value = Number.parseInt((await fs.readFile(file, "utf8")).trim(), 10);
  assert.equal(Number.isSafeInteger(value), true);
  assert.ok(value > 0);
  return value;
}

async function waitForProcessExit(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`MCP process ${pid} did not exit`);
}

async function runCli(args, { cwd, home, env = {} }) {
  const cli = await ensureBuilt();
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: {
      ...process.env,
      CODEPUNK_HOME: home,
      NO_COLOR: "1",
      PI_OFFLINE: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function runCliUntil(args, pattern, { cwd, home, env = {} }) {
  const cli = await ensureBuilt();
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: {
      ...process.env,
      CODEPUNK_HOME: home,
      NO_COLOR: "1",
      PI_OFFLINE: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let matched = false;
  const match = new Promise((resolve, reject) => {
    const inspect = () => {
      if (matched) {
        return;
      }
      const result = pattern.exec(stdout);
      if (result !== null) {
        matched = true;
        resolve(result);
      }
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      inspect();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (!matched) {
        reject(
          new Error(
            `CLI exited ${code} before matching ${pattern}: ${stdout}\n${stderr}`,
          ),
        );
      }
    });
    inspect();
  });
  const exit = new Promise((resolve) => {
    child.on("close", (code) => resolve(code));
  });
  return { child, match, exit, stdout: () => stdout, stderr: () => stderr };
}

test("user Pi MCP config fails closed; project MCP files and .pi canaries stay inert", async () => {
  await withTempDirectory("codepunk-mcp-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const paths = await projectPaths(root, project, home);
    await writeFile(path.join(home, "mcp.json"), "{}\n");
    await assert.rejects(
      () => core.readMcpConfig(paths),
      /mcp\.json is not supported/u,
    );
    await fs.rm(path.join(home, "mcp.json"));
    await writeFile(path.join(paths.projectConfigDir, "mcp.toml"), "");
    assert.deepEqual(await core.readMcpConfig(paths), []);
    await fs.rm(path.join(paths.projectConfigDir, "mcp.toml"));
    await writeFile(path.join(paths.projectConfigDir, "mcp.json"), "{}\n");
    assert.deepEqual(await core.readMcpConfig(paths), []);
    await fs.rm(path.join(paths.projectConfigDir, "mcp.json"));
    await writeFile(
      path.join(home, "mcp.toml"),
      ["[servers.escape]", 'command = "node"', 'cwd = ".."', ""].join("\n"),
    );
    await assert.rejects(
      () => core.readMcpConfig(paths),
      /cwd must stay inside the delivery root/u,
    );
    await fs.rm(path.join(home, "mcp.toml"));
    const marker = path.join(root, "pi-mcp-spawned");
    await writeFile(
      path.join(project, ".pi", "mcp.json"),
      `${JSON.stringify({
        mcpServers: {
          canary: { command: "touch", args: [marker] },
        },
      })}\n`,
    );
    assert.deepEqual(await core.readMcpConfig(paths), []);
    await assert.rejects(() => fs.access(marker));
  });
});

test("an untrusted project MCP file stays inert instead of blocking startup", async () => {
  await withTempDirectory("codepunk-mcp-trust-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await writeFile(
      path.join(project, ".codepunk", "mcp.toml"),
      '[servers.probe]\ncommand = "probe"\n',
    );
    const home = path.join(root, "home");
    await fs.mkdir(home);
    const paths = await projectPaths(root, project, home);
    assert.deepEqual(await core.readMcpConfig(paths), []);

    const doctor = await runCli(["doctor", "--no-trust"], {
      cwd: project,
      home,
    });
    assert.match(doctor.stdout, /\[ok\] mcp: no user MCP servers configured/u);
  });
});

test("a user-scope server exposes wrapped tools with uncovered coverage", async () => {
  await withTempDirectory("codepunk-mcp-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const paths = await projectPaths(root, project, home);
    await writeFile(
      path.join(home, "mcp.toml"),
      [
        "[servers.echo]",
        'command = "node"',
        `args = [${JSON.stringify(FIXTURE)}]`,
        "",
      ].join("\n"),
    );
    const starts = [];
    assert.equal(core.MCP_REQUEST_TIMEOUT_MS, 15_000);
    const bundle = await core.loadMcpTools({
      paths,
      onServerStart: (start) => starts.push(start),
    });
    try {
      assert.deepEqual(bundle.servers, ["echo"]);
      assert.equal(bundle.tools.length, 1);
      assert.equal(bundle.tools[0].name, "mcp__echo__echo");
      assert.equal(starts.length, 1);
      assert.equal(starts[0].coverage, "uncovered");
      assert.match(starts[0].command_sha256, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(Number.isSafeInteger(starts[0].pid), true);
      assert.ok(starts[0].pid > 0);
      const direct = await bundle.tools[0].execute("call-1", { text: "hi" });
      assert.equal(direct.content[0].text, "echo:hi");

      const ledger = await core.EvidenceLedger.open(
        path.join(paths.evidenceDir, "mcp-run.jsonl"),
      );
      const broker = new core.ApprovalBroker();
      let approvalRequest = null;
      broker.registerChannel({
        id: "test-approval",
        kind: "cli",
        isTTY: true,
        async ask(request) {
          approvalRequest = request;
          return {
            request_id: request.request_id,
            answer: "allow",
            channel: "cli",
            channel_id: request.channel_id,
            nonce_sha256: request.nonce_sha256,
            worker_id: request.worker_id,
            session_id: request.session_id,
            tool_call_id: request.tool_call_id,
            answered_at: new Date().toISOString(),
          };
        },
      });
      const wrapped = await core.wrapToolDefinition(bundle.tools[0], {
        cwd: project,
        workspaceRoot: project,
        deliveryRoot: project,
        codepunkHome: home,
        sessionId: "mcp-session",
        runId: "mcp-run",
        ledger,
        approval: broker,
      });
      const result = await wrapped.execute(
        "call-2",
        { text: "wrapped sk-secret-value" },
        undefined,
        undefined,
        {},
      );
      assert.equal(result.content[0].text, "echo:wrapped sk-secret-value");
      const record = ledger.all.at(-1);
      assert.equal(record.source, "mcp");
      assert.equal(record.tool, "mcp__echo__echo");
      assert.equal(record.coverage, "uncovered");
      assert.equal(record.rule, "mcp.tool.ask");
      assert.equal(record.approval.channel, "cli");
      assert.ok(approvalRequest);
      assert.match(approvalRequest.args_preview, /wrapped/u);
      assert.doesNotMatch(approvalRequest.args_preview, /sk-secret-value/u);
      assert.equal(
        approvalRequest.args_sha256,
        core.sha256Value({ text: "wrapped sk-secret-value" }),
      );
      assert.equal(record.approval.args_sha256, approvalRequest.args_sha256);
    } finally {
      await bundle.close();
    }
  });
});

test("MCP results use Pi's model-facing output limit", async () => {
  await withTempDirectory("codepunk-mcp-large-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const paths = await projectPaths(root, project, home);
    await writeFile(path.join(home, "mcp.toml"), serverTable("echo", "large"));
    const bundle = await core.loadMcpTools({ paths });
    try {
      const result = await bundle.tools[0].execute("call-large", {
        text: "ignored",
      });
      const text = result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      assert.match(text, /Warning: truncated output/u);
      assert.ok(Buffer.byteLength(text, "utf8") < 28 * 1024);
      assert.equal(result.structuredContent.output.includes("START:"), true);
      assert.equal(result.structuredContent.output.includes(":END"), true);
    } finally {
      await bundle.close();
    }
  });
});

test("MCP resources use Pi client operations and filter MCP Apps", async () => {
  await withTempDirectory("codepunk-mcp-resources-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const paths = await projectPaths(root, project, home);
    await writeFile(path.join(home, "mcp.toml"), serverTable("echo"));
    const bundle = await core.loadMcpTools({ paths });
    try {
      assert.deepEqual(
        bundle.tools.map((tool) => tool.name),
        ["mcp__echo__echo"],
      );
      assert.deepEqual(bundle.resourceServers, ["echo"]);
      assert.deepEqual(
        bundle.resourceTools.map((tool) => tool.name),
        [
          "list_mcp_resources",
          "list_mcp_resource_templates",
          "read_mcp_resource",
        ],
      );

      const list = bundle.resourceTools.find(
        (tool) => tool.name === "list_mcp_resources",
      );
      const listed = await list.execute("list-resources", {});
      assert.deepEqual(
        listed.structuredContent.resources.map((resource) => resource.uri),
        ["echo://greeting", "echo://image", "echo://binary"],
      );
      assert.equal(
        listed.structuredContent.resources.some(
          (resource) => resource.uri === "ui://panel",
        ),
        false,
      );

      const firstPage = await list.execute("list-resources-page", {
        server: "echo",
      });
      assert.equal(firstPage.structuredContent.nextCursor, "page-2");
      assert.deepEqual(
        firstPage.structuredContent.resources.map((resource) => resource.uri),
        ["echo://greeting", "echo://image"],
      );

      const templates = bundle.resourceTools.find(
        (tool) => tool.name === "list_mcp_resource_templates",
      );
      const templateResult = await templates.execute(
        "list-resource-templates",
        { server: "echo" },
      );
      assert.deepEqual(
        templateResult.structuredContent.resourceTemplates.map(
          (template) => template.uriTemplate,
        ),
        ["echo://items/{id}"],
      );

      const read = bundle.resourceTools.find(
        (tool) => tool.name === "read_mcp_resource",
      );
      const text = await read.execute("read-text", {
        server: "echo",
        uri: "echo://greeting",
      });
      assert.equal(text.content[0].text, "hello from resource");
      assert.deepEqual(text.structuredContent.contents, [
        {
          uri: "echo://greeting",
          mimeType: "text/plain",
          text: "hello from resource",
        },
      ]);

      const image = await read.execute("read-image", {
        server: "echo",
        uri: "echo://image",
      });
      assert.equal(image.content[0].type, "image");
      const binary = await read.execute("read-binary", {
        server: "echo",
        uri: "echo://binary",
      });
      assert.match(binary.content[0].text, /binary resource echo:\/\/binary/u);

      const unknown = await read
        .execute("read-unknown", {
          server: "missing",
          uri: "echo://greeting",
        })
        .then(
          () => null,
          (error) => error,
        );
      assert.match(String(unknown), /has no resources/u);
    } finally {
      await bundle.close();
    }
  });
});

test("MCP resource reads require approval and record uncovered evidence", async () => {
  await withTempDirectory("codepunk-mcp-resource-approval-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const paths = await projectPaths(root, project, home);
    await writeFile(path.join(home, "mcp.toml"), serverTable("echo"));
    const bundle = await core.loadMcpTools({ paths });
    try {
      const read = bundle.resourceTools.find(
        (tool) => tool.name === "read_mcp_resource",
      );
      const ledger = await core.EvidenceLedger.open(
        path.join(paths.evidenceDir, "mcp-resource-run.jsonl"),
      );
      const broker = new core.ApprovalBroker();
      let approvalRequest = null;
      broker.registerChannel({
        id: "resource-approval",
        kind: "cli",
        isTTY: true,
        async ask(request) {
          approvalRequest = request;
          return {
            request_id: request.request_id,
            answer: "allow",
            channel: "cli",
            channel_id: request.channel_id,
            nonce_sha256: request.nonce_sha256,
            worker_id: request.worker_id,
            session_id: request.session_id,
            tool_call_id: request.tool_call_id,
            answered_at: new Date().toISOString(),
          };
        },
      });
      const options = {
        cwd: project,
        workspaceRoot: project,
        deliveryRoot: project,
        codepunkHome: home,
        sessionId: "mcp-resource-session",
        runId: "mcp-resource-run",
        ledger,
        approval: broker,
      };
      const wrapped = await core.wrapToolDefinition(read, options);
      const result = await wrapped.execute(
        "read-approved",
        { server: "echo", uri: "echo://greeting" },
        undefined,
        undefined,
        {},
      );
      assert.equal(result.content[0].text, "hello from resource");
      const record = ledger.all.at(-1);
      assert.equal(record.source, "mcp");
      assert.equal(record.tool, "read_mcp_resource");
      assert.equal(record.coverage, "uncovered");
      assert.equal(record.rule, "mcp.resource.ask");
      assert.equal(record.approval.channel, "cli");
      assert.ok(approvalRequest);
      assert.match(approvalRequest.args_preview, /echo:\/\/greeting/u);

      const denied = await core.wrapToolDefinition(read, {
        ...options,
        sessionId: "mcp-resource-denied-session",
        runId: "mcp-resource-denied-run",
        ledger,
        approval: new core.ApprovalBroker(),
      });
      const deniedResult = await denied.execute(
        "read-denied",
        { server: "echo", uri: "echo://greeting" },
        undefined,
        undefined,
        {},
      );
      assert.equal(deniedResult.isError, true);
      assert.match(deniedResult.content[0].text, /approval\.unavailable/u);
      assert.doesNotMatch(deniedResult.content[0].text, /hello from resource/u);
      assert.equal(ledger.all.at(-1).decision, "deny");
      assert.equal(ledger.all.at(-1).rule, "approval.unavailable");
    } finally {
      await bundle.close();
    }
  });
});

test("tolerant MCP startup reports one failed server and keeps the rest", async () => {
  await withTempDirectory("codepunk-mcp-fatal-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const paths = await projectPaths(root, project, home);
    await writeFile(
      path.join(home, "mcp.toml"),
      [
        "[servers.good]",
        'command = "node"',
        `args = [${JSON.stringify(FIXTURE)}]`,
        "",
        "[servers.bad]",
        'command = "node"',
        `args = [${JSON.stringify(FIXTURE)}]`,
        "",
        "[servers.bad.env]",
        'MISSING_MCP_LAUNCH_VALUE = "${MISSING_MCP_LAUNCH_VALUE}"',
        "",
      ].join("\n"),
    );
    const previous = process.env["MISSING_MCP_LAUNCH_VALUE"];
    delete process.env["MISSING_MCP_LAUNCH_VALUE"];
    try {
      const bundle = await core.loadMcpTools({
        paths,
        strict: false,
      });
      try {
        assert.deepEqual(bundle.servers, ["good"]);
        assert.equal(bundle.failures.length, 1);
        assert.equal(bundle.failures[0].server, "bad");
        assert.match(
          bundle.failures[0].message,
          /missing environment variables/u,
        );
      } finally {
        await bundle.close();
      }
    } finally {
      if (previous !== undefined) {
        process.env["MISSING_MCP_LAUNCH_VALUE"] = previous;
      }
    }
  });
});

test("MCP tool names and schemas reuse Pi normalization", async () => {
  await withTempDirectory("codepunk-mcp-naming-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const paths = await projectPaths(root, project, home);
    await writeFile(path.join(home, "mcp.toml"), serverTable("echo", "naming"));
    const bundle = await core.loadMcpTools({ paths });
    try {
      assert.equal(bundle.tools.length, 3);
      const names = bundle.tools.map((tool) => tool.name);
      assert.equal(new Set(names).size, 3);
      assert.equal(names[0].startsWith("mcp__echo__a_b"), true);
      assert.equal(names[1].startsWith("mcp__echo__a_b"), true);
      assert.notEqual(names[0], names[1]);
      assert.match(names[1], /_[0-9a-f]{8}$/u);
      assert.equal(names[2].length <= 64, true);
      assert.match(names[2], /_[0-9a-f]{8}$/u);
      for (const name of names) {
        assert.match(name, /^[A-Za-z0-9_]+$/u);
      }
      assert.equal(bundle.tools[0].parameters.type, "object");
      assert.deepEqual(bundle.tools[0].parameters.properties, {
        text: { type: "string" },
      });
    } finally {
      await bundle.close();
    }
  });
});

test("a user-scope Streamable HTTP server reuses Pi transport and expands headers", async () => {
  await withTempDirectory("codepunk-mcp-http-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const paths = await projectPaths(root, project, home);
    const server = await startHttpMcpServer("http-test-token");
    const previous = process.env["MCP_HTTP_TOKEN"];
    process.env["MCP_HTTP_TOKEN"] = "http-test-token";
    try {
      await writeFile(
        path.join(home, "mcp.toml"),
        [
          "[servers.remote]",
          `url = ${JSON.stringify(server.url)}`,
          "",
          "[servers.remote.headers]",
          'Authorization = "Bearer ${MCP_HTTP_TOKEN}"',
          "",
        ].join("\n"),
      );
      const starts = [];
      const bundle = await core.loadMcpTools({
        paths,
        onServerStart: (start) => starts.push(start),
      });
      try {
        assert.deepEqual(bundle.servers, ["remote"]);
        assert.equal(bundle.tools.length, 1);
        assert.equal(bundle.tools[0].name, "mcp__remote__echo");
        assert.deepEqual(starts, [
          {
            server: "remote",
            command_sha256: starts[0].command_sha256,
            pid: 0,
            transport: "http",
            coverage: "uncovered",
          },
        ]);
        assert.match(starts[0].command_sha256, /^sha256:[0-9a-f]{64}$/u);
        const result = await bundle.tools[0].execute("call-http", {
          text: "hello",
        });
        assert.equal(result.content[0].text, "http:hello");
        assert.ok(
          server.requests.some(
            (request) =>
              request.method === "initialize" &&
              request.authorization === "Bearer http-test-token",
          ),
        );
      } finally {
        await bundle.close();
      }
    } finally {
      if (previous === undefined) {
        delete process.env["MCP_HTTP_TOKEN"];
      } else {
        process.env["MCP_HTTP_TOKEN"] = previous;
      }
      await server.close();
    }
  });
});

test("a rejected static HTTP Authorization header explains the header", async () => {
  await withTempDirectory("codepunk-mcp-http-auth-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const paths = await projectPaths(root, project, home);
    const server = await startHttpMcpServer("http-test-token");
    try {
      await writeFile(
        path.join(home, "mcp.toml"),
        [
          "[servers.remote]",
          `url = ${JSON.stringify(server.url)}`,
          "",
          "[servers.remote.headers]",
          'Authorization = "Bearer wrong-token"',
          "",
        ].join("\n"),
      );
      const bundle = await core.loadMcpTools({ paths, strict: false });
      try {
        assert.equal(bundle.failures.length, 1);
        assert.equal(bundle.failures[0].code, "mcp.auth_required");
        assert.match(
          bundle.failures[0].message,
          /rejected its configured Authorization header/u,
        );
        assert.doesNotMatch(bundle.failures[0].message, /mcp login/u);
      } finally {
        await bundle.close();
      }
    } finally {
      await server.close();
    }
  });
});

test("HTTP MCP configuration accepts OAuth settings and rejects unsafe variants", async () => {
  await withTempDirectory("codepunk-mcp-http-invalid-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const paths = await projectPaths(root, project, home);
    await writeFile(
      path.join(home, "mcp.toml"),
      [
        "[servers.remote]",
        'url = "https://example.com/mcp"',
        "",
        "[servers.remote.oauth]",
        'clientId = "client"',
        'scope = "mcp.read"',
        "callbackPort = 43123",
        "",
      ].join("\n"),
    );
    const configs = await core.readMcpConfig(paths);
    assert.deepEqual(configs[0].oauth, {
      clientId: "client",
      scope: "mcp.read",
      callbackPort: 43123,
    });
    assert.throws(
      () => core.oauthSettings({ clientSecret: "!op read secret" }, "remote"),
      /cannot use !command expansion/u,
    );
    await writeFile(
      path.join(home, "mcp.toml"),
      [
        "[servers.remote]",
        'url = "https://example.com/mcp"',
        "",
        "[servers.remote.oauth]",
        'clientRegistration = "cimd"',
        "",
      ].join("\n"),
    );
    await assert.rejects(
      () => core.readMcpConfig(paths),
      /Client ID Metadata Document/u,
    );
    await writeFile(
      path.join(home, "mcp.toml"),
      [
        "[servers.remote]",
        'url = "https://example.com/mcp"',
        "",
        "[servers.remote.oauth]",
        'clientId = "client"',
        "",
        "[servers.remote.headers]",
        'Authorization = "Bearer static"',
        "",
      ].join("\n"),
    );
    await assert.rejects(
      () => core.readMcpConfig(paths),
      /cannot combine an Authorization header with oauth/u,
    );
    await writeFile(
      path.join(home, "mcp.toml"),
      [
        "[servers.remote]",
        'url = "https://example.com/mcp"',
        "",
        "[servers.remote.headers]",
        'Authorization = "Bearer ok\\nX-Injected: yes"',
        "",
      ].join("\n"),
    );
    await assert.rejects(
      () => core.readMcpConfig(paths),
      /cannot contain CR or LF/u,
    );
  });
});

test("OAuth MCP login persists tokens, refreshes them, and fails closed when revoked", async () => {
  await withTempDirectory("codepunk-mcp-oauth-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const paths = await projectPaths(root, project, home);
    const server = await startOAuthMcpServer();
    try {
      await writeFile(
        path.join(home, "mcp.toml"),
        [
          "[servers.remote]",
          `url = ${JSON.stringify(server.url)}`,
          "",
          "[servers.remote.oauth]",
          'scope = "mcp.read"',
          "",
        ].join("\n"),
      );

      const before = await core.loadMcpTools({ paths, strict: false });
      try {
        assert.deepEqual(before.servers, []);
        assert.equal(before.failures.length, 1);
        assert.equal(before.failures[0].code, "mcp.auth_required");
        assert.match(before.failures[0].message, /codepunk mcp login remote/u);
      } finally {
        await before.close();
      }

      const store = new core.McpAuthStore(home);
      let resolveAuthorization;
      const authorization = new Promise((resolve) => {
        resolveAuthorization = resolve;
      });
      const login = core.loginMcpServer({
        server: "remote",
        serverUrl: server.url,
        store,
        settings: core.oauthSettings(undefined, "remote"),
        onAuthorizationUrl: (url) => resolveAuthorization(url),
      });
      const authorizationUrl = await authorization;
      const browser = await fetch(authorizationUrl);
      assert.equal(browser.status, 200);
      const loginResult = await login;
      assert.equal(loginResult.already_authorized, false);
      assert.equal(server.registrations.length, 1);

      const status = await store.status("remote", server.url);
      assert.equal(status.signed_in, true);
      assert.equal(status.scope, "mcp.read");
      assert.match(status.expires_at, /^\d{4}-\d{2}-\d{2}T/u);
      await assertPrivateFile(store.path);

      const connected = await core.loadMcpTools({ paths });
      try {
        assert.deepEqual(connected.servers, ["remote"]);
        const result = await connected.tools[0].execute("oauth-call", {
          text: "hello",
        });
        assert.equal(result.content[0].text, "oauth:hello");
      } finally {
        await connected.close();
      }

      const serverStore = store.forServer("remote", server.url);
      const stored = await serverStore.load();
      assert.ok(stored);
      await serverStore.save({
        ...stored,
        tokens: {
          ...stored.tokens,
          access_token: "stale",
          refresh_token: "refresh-1",
        },
        tokensExpireAt: Date.now() - 1_000,
      });
      const refreshed = await core.loadMcpTools({ paths });
      try {
        const result = await refreshed.tools[0].execute("oauth-refresh", {
          text: "again",
        });
        assert.equal(result.content[0].text, "oauth:again");
        assert.equal(server.validAccessTokens.has("access-2"), true);
      } finally {
        await refreshed.close();
      }

      await serverStore.save({
        ...stored,
        tokens: {
          ...stored.tokens,
          access_token: "stale",
          refresh_token: "revoked",
        },
        tokensExpireAt: Date.now() - 1_000,
      });
      const revoked = await core.loadMcpTools({ paths, strict: false });
      try {
        assert.deepEqual(revoked.servers, []);
        assert.equal(revoked.failures[0].code, "mcp.auth_required");
        assert.match(revoked.failures[0].message, /mcp login remote/u);
      } finally {
        await revoked.close();
      }
    } finally {
      await server.close();
    }
  });
});

test("closing an MCP bundle waits for an in-flight OAuth refresh", async () => {
  await withTempDirectory("codepunk-mcp-oauth-close-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const paths = await projectPaths(root, project, home);
    const server = await startOAuthMcpServer({ refreshDelayMs: 200 });
    try {
      await writeFile(
        path.join(home, "mcp.toml"),
        [
          "[servers.remote]",
          `url = ${JSON.stringify(server.url)}`,
          "",
          "[servers.remote.oauth]",
          'scope = "mcp.read"',
          "",
        ].join("\n"),
      );
      const store = new core.McpAuthStore(home);
      let resolveAuthorization;
      const authorization = new Promise((resolve) => {
        resolveAuthorization = resolve;
      });
      const login = core.loginMcpServer({
        server: "remote",
        serverUrl: server.url,
        store,
        settings: core.oauthSettings(undefined, "remote"),
        onAuthorizationUrl: (url) => resolveAuthorization(url),
      });
      const authorizationUrl = await authorization;
      await fetch(authorizationUrl);
      await login;

      const connected = await core.loadMcpTools({ paths });
      const serverStore = store.forServer("remote", server.url);
      const stored = await serverStore.load();
      assert.ok(stored);
      await serverStore.save({
        ...stored,
        tokens: {
          ...stored.tokens,
          access_token: "stale",
          refresh_token: "refresh-1",
        },
        tokensExpireAt: Date.now() - 1_000,
      });

      const pending = connected.tools[0]
        .execute("oauth-close", { text: "race" })
        .catch((error) => error);
      await server.refreshStarted;
      const startedClosing = Date.now();
      await connected.close();
      const closeWaitedMs = Date.now() - startedClosing;
      assert.ok(
        closeWaitedMs >= 100,
        `close returned before the refresh settled (${closeWaitedMs} ms)`,
      );
      const afterClose = await serverStore.load();
      assert.equal(afterClose?.tokens?.access_token, "access-2");
      assert.equal(afterClose?.tokens?.refresh_token, "refresh-2");
      await pending;
    } finally {
      await server.close();
    }
  });
});

test("MCP CLI signs in, reports status, tests the connection, and signs out", async () => {
  await withTempDirectory("codepunk-mcp-oauth-cli-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    await fs.mkdir(home, { recursive: true });
    const server = await startOAuthMcpServer();
    try {
      await writeFile(
        path.join(home, "mcp.toml"),
        [
          "[servers.remote]",
          `url = ${JSON.stringify(server.url)}`,
          "",
          "[servers.remote.oauth]",
          'scope = "mcp.read"',
          "",
        ].join("\n"),
      );

      const before = await runCli(["mcp", "status", "remote", "--json"], {
        cwd: project,
        home,
      });
      assert.equal(before.code, 0, before.stderr);
      const beforeStatus = JSON.parse(before.stdout);
      assert.equal(beforeStatus.servers[0].auth, "oauth");
      assert.equal(beforeStatus.servers[0].signed_in, false);

      const login = await runCliUntil(
        ["mcp", "login", "remote"],
        /Open this URL in a browser:\n(\S+)/u,
        { cwd: project, home },
      );
      const authorizationUrl = (await login.match)[1];
      let browser;
      try {
        browser = await fetch(authorizationUrl);
      } catch (error) {
        throw new Error(
          `fetch ${authorizationUrl} failed: ${error}\nstdout:\n${login.stdout()}\nstderr:\n${login.stderr()}`,
        );
      }
      assert.equal(browser.status, 200);
      const loginCode = await login.exit;
      assert.equal(loginCode, 0, login.stderr());
      assert.match(login.stdout(), /signed in to MCP server remote/u);

      const after = await runCli(["mcp", "status", "remote", "--json"], {
        cwd: project,
        home,
      });
      assert.equal(after.code, 0, after.stderr);
      const afterStatus = JSON.parse(after.stdout);
      assert.equal(afterStatus.servers[0].signed_in, true);
      assert.equal(afterStatus.servers[0].scope, "mcp.read");
      assert.equal(after.stdout.includes("access-1"), false);
      assert.equal(after.stdout.includes("refresh-1"), false);

      const tested = await runCli(["mcp", "test", "remote", "--json"], {
        cwd: project,
        home,
      });
      assert.equal(tested.code, 0, tested.stderr);
      assert.deepEqual(JSON.parse(tested.stdout).tools, ["mcp__remote__echo"]);

      const logout = await runCli(["mcp", "logout", "remote"], {
        cwd: project,
        home,
      });
      assert.equal(logout.code, 0, logout.stderr);
      assert.match(logout.stdout, /removed OAuth credentials/u);

      const cleared = await runCli(["mcp", "status", "remote", "--json"], {
        cwd: project,
        home,
      });
      assert.equal(cleared.code, 0, cleared.stderr);
      assert.equal(JSON.parse(cleared.stdout).servers[0].signed_in, false);
    } finally {
      await server.close();
    }
  });
});

test("MCP CLI adds, lists, tests, and removes a Streamable HTTP server", async () => {
  await withTempDirectory("codepunk-mcp-http-cli-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    await fs.mkdir(home, { recursive: true });
    const server = await startHttpMcpServer("http-test-token");
    try {
      const added = await runCli(
        [
          "mcp",
          "add",
          "remote",
          "--url",
          server.url,
          "--header",
          "Authorization: Bearer ${MCP_HTTP_TOKEN}",
        ],
        { cwd: project, home },
      );
      assert.equal(added.code, 0, added.stderr);
      assert.match(added.stdout, /added HTTP MCP server remote/u);
      const config = await fs.readFile(path.join(home, "mcp.toml"), "utf8");
      assert.match(config, /^url = /mu);
      assert.match(config, /Authorization = "Bearer \$\{MCP_HTTP_TOKEN\}"/u);

      const listed = await runCli(["mcp", "list", "--json"], {
        cwd: project,
        home,
      });
      assert.equal(listed.code, 0, listed.stderr);
      const snapshot = JSON.parse(listed.stdout);
      assert.equal(snapshot.servers[0].transport, "http");
      assert.equal(snapshot.servers[0].url, server.url);
      assert.deepEqual(snapshot.servers[0].header_keys, ["Authorization"]);
      assert.equal(listed.stdout.includes("http-test-token"), false);

      const tested = await runCli(["mcp", "test", "remote", "--json"], {
        cwd: project,
        home,
        env: { MCP_HTTP_TOKEN: "http-test-token" },
      });
      assert.equal(tested.code, 0, tested.stderr);
      const result = JSON.parse(tested.stdout);
      assert.deepEqual(result.servers, ["remote"]);
      assert.deepEqual(result.tools, ["mcp__remote__echo"]);

      const removed = await runCli(["mcp", "remove", "remote"], {
        cwd: project,
        home,
      });
      assert.equal(removed.code, 0, removed.stderr);
    } finally {
      await server.close();
    }
  });
});

test("MCP requests time out during initialize, listing, and tool calls", async () => {
  await withTempDirectory("codepunk-mcp-timeout-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const paths = await projectPaths(root, project, home);
    const scenarios = [
      {
        mode: "hang-initialize",
        error: /did not answer initialize/u,
        call: false,
      },
      {
        mode: "hang-tools-list",
        error: /did not answer tools\/list/u,
        call: false,
      },
      {
        mode: "hang-tools-call",
        error: /did not answer tools\/call/u,
        call: true,
      },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const pidFile = path.join(root, `timeout-${index}.pid`);
      await writeFile(
        path.join(home, "mcp.toml"),
        serverTable("hang", scenario.mode, pidFile),
      );
      if (scenario.call) {
        const bundle = await core.loadMcpTools({
          paths,
          requestTimeoutMs: 500,
        });
        try {
          await assert.rejects(
            () => bundle.tools[0].execute("call-timeout", { text: "wait" }),
            scenario.error,
          );
        } finally {
          await bundle.close();
        }
      } else {
        await assert.rejects(
          () =>
            core.loadMcpTools({
              paths,
              requestTimeoutMs: 500,
            }),
          scenario.error,
        );
      }
      await waitForProcessExit(await readPid(pidFile));
    }
  });
});

test("a failed MCP startup stops every spawned server", async () => {
  await withTempDirectory("codepunk-mcp-cleanup-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const paths = await projectPaths(root, project, home);
    const failedPidFile = path.join(root, "failed.pid");
    await writeFile(
      path.join(home, "mcp.toml"),
      [
        serverTable("a-echo"),
        serverTable("b-hang", "hang-initialize", failedPidFile),
      ].join("\n"),
    );
    const starts = [];
    await assert.rejects(
      () =>
        core.loadMcpTools({
          paths,
          requestTimeoutMs: 500,
          onServerStart: (start) => starts.push(start),
        }),
      /did not answer initialize/u,
    );
    assert.equal(starts.length, 1);
    assert.equal(starts[0].server, "a-echo");
    await waitForProcessExit(starts[0].pid);
    await waitForProcessExit(await readPid(failedPidFile));
  });
});

test("runtime starts user-scope servers and records the start", async () => {
  await withTempDirectory("codepunk-mcp-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await writeFile(
      path.join(home, "mcp.toml"),
      [
        "[servers.echo]",
        'command = "node"',
        `args = [${JSON.stringify(FIXTURE)}]`,
        "",
      ].join("\n"),
    );
    const runtime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      model: TEST_MODEL,
    });
    try {
      assert.deepEqual(runtime.mcpServers, ["echo"]);
      assert.ok(runtime.host.wrappedToolNames.includes("mcp__echo__echo"));
      assert.ok(runtime.host.wrappedToolNames.includes("read_mcp_resource"));
      const start = runtime.session.allEvents.find(
        (event) => event.kind === "mcp/server_start",
      );
      assert.ok(start);
      assert.equal(start.data.server, "echo");
    } finally {
      await runtime.dispose();
    }
  });
});

test("runtime MCP reload swaps servers, tools, and stops the old process", async () => {
  await withTempDirectory("codepunk-mcp-reload-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const firstPidFile = path.join(root, "first.pid");
    const secondPidFile = path.join(root, "second.pid");
    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await writeFile(
      path.join(home, "mcp.toml"),
      serverTable("first", "normal", firstPidFile),
    );
    const runtime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      model: TEST_MODEL,
    });
    try {
      assert.deepEqual(runtime.mcpServers, ["first"]);
      assert.ok(runtime.host.wrappedToolNames.includes("mcp__first__echo"));
      assert.ok(
        runtime.host.session.getActiveToolNames().includes("mcp__first__echo"),
      );
      const firstPid = await readPid(firstPidFile);

      await writeFile(
        path.join(home, "mcp.toml"),
        serverTable("second", "normal", secondPidFile),
      );
      const result = await runtime.reloadMcp();
      assert.equal(result.error, null);
      assert.equal(result.skipped, null);
      assert.deepEqual(result.servers, ["second"]);
      assert.deepEqual(runtime.mcpServers, ["second"]);
      assert.ok(runtime.host.wrappedToolNames.includes("mcp__second__echo"));
      assert.equal(
        runtime.host.wrappedToolNames.some((name) =>
          name.startsWith("mcp__first__"),
        ),
        false,
      );
      assert.ok(
        runtime.host.session.getActiveToolNames().includes("mcp__second__echo"),
      );
      assert.equal(
        runtime.host.session.getActiveToolNames().includes("mcp__first__echo"),
        false,
      );
      await waitForProcessExit(firstPid);
      const secondPid = await readPid(secondPidFile);
      assert.ok(secondPid > 0);
      assert.equal(
        runtime.session.allEvents.some(
          (event) =>
            event.kind === "mcp/server_start" && event.data.server === "second",
        ),
        true,
      );
    } finally {
      await runtime.dispose();
    }
  });
});

test("runtime MCP reload keeps the previous surface on an invalid config", async () => {
  await withTempDirectory("codepunk-mcp-reload-bad-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const pidFile = path.join(root, "kept.pid");
    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await writeFile(
      path.join(home, "mcp.toml"),
      serverTable("kept", "normal", pidFile),
    );
    const runtime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      model: TEST_MODEL,
    });
    try {
      const keptPid = await readPid(pidFile);
      await writeFile(
        path.join(home, "mcp.toml"),
        '[servers.broken\ncommand = "node"\n',
      );
      const result = await runtime.reloadMcp();
      assert.match(
        result.error ?? "",
        /MCP configuration could not be loaded/u,
      );
      assert.deepEqual(result.servers, ["kept"]);
      assert.deepEqual(runtime.mcpServers, ["kept"]);
      assert.ok(runtime.host.wrappedToolNames.includes("mcp__kept__echo"));
      assert.ok(
        runtime.host.session.getActiveToolNames().includes("mcp__kept__echo"),
      );
      process.kill(keptPid, 0);
    } finally {
      await runtime.dispose();
    }
  });
});

test("an untrusted project MCP file is skipped with a warning and starts only when workspace config is trusted", async () => {
  await withTempDirectory("codepunk-mcp-project-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const pidFile = path.join(root, "project-mcp.pid");
    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await writeFile(
      path.join(project, ".codepunk", "mcp.toml"),
      serverTable("project", "normal", pidFile),
    );
    const untrusted = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      model: TEST_MODEL,
      projectTrust: {
        config: false,
        policy: false,
        skills: false,
        instructions: false,
      },
    });
    try {
      assert.deepEqual(untrusted.mcpServers, []);
      assert.match(
        untrusted.loadedConfig.warnings.join("\n"),
        /project MCP configuration \.codepunk\/mcp\.toml skipped because workspace config is not trusted/u,
      );
      await assert.rejects(() => fs.access(pidFile));
    } finally {
      await untrusted.dispose();
    }

    const trusted = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      model: TEST_MODEL,
      projectTrust: {
        config: true,
        policy: true,
        skills: true,
        instructions: true,
      },
    });
    try {
      assert.deepEqual(trusted.mcpServers, ["project"]);
      await fs.access(pidFile);
    } finally {
      await trusted.dispose();
    }
  });
});

test("--no-mcp skips user-scope servers without starting them", async () => {
  await withTempDirectory("codepunk-mcp-disabled-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const pidFile = path.join(root, "disabled-mcp.pid");
    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await writeFile(
      path.join(home, "mcp.toml"),
      serverTable("echo", "normal", pidFile),
    );
    const runtime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      disableMcp: true,
    });
    try {
      assert.deepEqual(runtime.mcpServers, []);
      assert.match(
        runtime.loadedConfig.warnings.join("\n"),
        /MCP is disabled by --no-mcp/u,
      );
      await assert.rejects(() => fs.access(pidFile));
    } finally {
      await runtime.dispose();
    }
  });
});

test("headless startup skips MCP when the model is missing", async () => {
  await withTempDirectory("codepunk-mcp-no-model-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const pidFile = path.join(root, "no-model-mcp.pid");
    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await writeFile(
      path.join(home, "mcp.toml"),
      serverTable("echo", "normal", pidFile),
    );
    const runtime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      headless: true,
    });
    try {
      assert.deepEqual(runtime.mcpServers, []);
      assert.match(
        runtime.loadedConfig.warnings.join("\n"),
        /MCP servers are not started because no model is selected/u,
      );
      assert.match(
        (await core.probeConfiguredModel(runtime.paths, runtime.config)) ?? "",
        /no model configured/u,
      );
      await assert.rejects(() => fs.access(pidFile));
    } finally {
      await runtime.dispose();
    }
  });
});

test("interactive onboarding skips MCP until a model is selected", async () => {
  await withTempDirectory("codepunk-mcp-no-model-tui-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const pidFile = path.join(root, "no-model-tui-mcp.pid");
    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await writeFile(
      path.join(home, "mcp.toml"),
      serverTable("echo", "normal", pidFile),
    );
    const runtime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      allowMissingModel: true,
    });
    try {
      assert.deepEqual(runtime.mcpServers, []);
      assert.match(
        runtime.loadedConfig.warnings.join("\n"),
        /select a model with \/model and run \/reload/u,
      );
      await assert.rejects(() => fs.access(pidFile));
    } finally {
      await runtime.dispose();
    }
  });
});

test("MCP reload starts servers after onboarding selects a model", async () => {
  await withTempDirectory("codepunk-mcp-reload-model-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    const pidFile = path.join(root, "selected.pid");
    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await writeFile(
      path.join(home, "mcp.toml"),
      serverTable("echo", "normal", pidFile),
    );
    const runtime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      allowMissingModel: true,
    });
    try {
      assert.deepEqual(runtime.mcpServers, []);
      await assert.rejects(() => fs.access(pidFile));
      runtime.primaryModel = TEST_MODEL;
      const result = await runtime.reloadMcp();
      assert.equal(result.error, null);
      assert.equal(result.skipped, null);
      assert.deepEqual(result.servers, ["echo"]);
      assert.deepEqual(runtime.mcpServers, ["echo"]);
      assert.ok(runtime.host.wrappedToolNames.includes("mcp__echo__echo"));
      assert.ok(
        runtime.host.session.getActiveToolNames().includes("mcp__echo__echo"),
      );
      assert.ok((await readPid(pidFile)) > 0);
    } finally {
      await runtime.dispose();
    }
  });
});

test("read-only autonomy does not start user-scope MCP servers", async () => {
  await withTempDirectory("codepunk-mcp-readonly-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    await writeFile(
      path.join(home, "config.toml"),
      [
        "[sandbox]",
        'mode = "uncovered"',
        "",
        "[autonomy]",
        'profile = "read-only"',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(home, "mcp.toml"),
      [
        "[servers.echo]",
        'command = "node"',
        `args = [${JSON.stringify(FIXTURE)}]`,
        "",
      ].join("\n"),
    );
    const runtime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      model: TEST_MODEL,
    });
    try {
      assert.deepEqual(runtime.mcpServers, []);
      assert.equal(
        runtime.host.wrappedToolNames.some((name) =>
          name.startsWith("mcp__echo__"),
        ),
        false,
      );
      assert.equal(
        runtime.session.allEvents.some(
          (event) => event.kind === "mcp/server_start",
        ),
        false,
      );
      assert.match(
        runtime.loadedConfig.warnings.join("\n"),
        /read-only autonomy does not start MCP servers/u,
      );
    } finally {
      await runtime.dispose();
    }
  });
});

test("runtime skips one failed MCP server and reports a warning", async () => {
  await withTempDirectory("codepunk-mcp-partial-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    await writeFile(
      path.join(home, "config.toml"),
      '[sandbox]\nmode = "uncovered"\n',
    );
    await writeFile(
      path.join(home, "mcp.toml"),
      [
        serverTable("good"),
        "[servers.bad]",
        'command = "/nonexistent/codepunk-mcp-server"',
        "",
      ].join("\n"),
    );
    const runtime = await core.createRuntime({
      cwd: project,
      environment: { CODEPUNK_HOME: home },
      model: TEST_MODEL,
    });
    try {
      assert.deepEqual(runtime.mcpServers, ["good"]);
      assert.match(
        runtime.loadedConfig.warnings.join("\n"),
        /MCP server bad skipped/u,
      );
      assert.equal(
        runtime.host.wrappedToolNames.some((name) =>
          name.startsWith("mcp__good__"),
        ),
        true,
      );
    } finally {
      await runtime.dispose();
    }
  });
});

test("MCP management preserves unrelated config and checks a real connection", async () => {
  await withTempDirectory("codepunk-mcp-manage-", async (root) => {
    const project = await makeRepo(root);
    const home = path.join(root, "home");
    await fs.mkdir(home, { recursive: true });
    const configPath = path.join(home, "mcp.toml");
    await writeFile(configPath, `# keep this comment\n${serverTable("keep")}`);

    const added = await runCli(
      [
        "mcp",
        "add",
        "echo",
        "--cwd",
        ".",
        "--env",
        "MCP_FIXTURE_TEXT=${MCP_FIXTURE_TEXT}",
        "--",
        "node",
        FIXTURE,
      ],
      { cwd: project, home },
    );
    assert.equal(added.code, 0, added.stderr);
    assert.match(added.stdout, /added MCP server echo/u);
    const config = await fs.readFile(configPath, "utf8");
    assert.match(config, /# keep this comment/u);
    assert.match(config, /\[servers\.keep\]/u);
    assert.match(config, /\[servers\.echo\]/u);
    assert.match(config, /MCP_FIXTURE_TEXT = "\$\{MCP_FIXTURE_TEXT\}"/u);
    await assertPrivateFile(configPath);

    const duplicate = await runCli(
      ["mcp", "add", "echo", "--", "node", FIXTURE],
      { cwd: project, home },
    );
    assert.equal(duplicate.code, 1);
    assert.match(duplicate.stderr, /already exists/u);

    const replaced = await runCli(
      [
        "mcp",
        "add",
        "echo",
        "--force",
        "--env",
        "MCP_FIXTURE_TEXT=${MCP_FIXTURE_TEXT}",
        "--",
        "node",
        FIXTURE,
      ],
      { cwd: project, home },
    );
    assert.equal(replaced.code, 0, replaced.stderr);
    const replacedConfig = await fs.readFile(configPath, "utf8");
    assert.equal([...replacedConfig.matchAll(/\[servers\.echo\]/gu)].length, 1);
    assert.match(replacedConfig, /# keep this comment/u);

    const listed = await runCli(["mcp", "list", "--json"], {
      cwd: project,
      home,
    });
    assert.equal(listed.code, 0, listed.stderr);
    const snapshot = JSON.parse(listed.stdout);
    assert.deepEqual(
      snapshot.servers.map((server) => server.name),
      ["echo", "keep"],
    );
    const echo = snapshot.servers.find((server) => server.name === "echo");
    assert.deepEqual(echo.env_keys, ["MCP_FIXTURE_TEXT"]);
    assert.equal(listed.stdout.includes("MCP_FIXTURE_TEXT="), false);

    const missing = await runCli(["mcp", "test", "echo", "--json"], {
      cwd: project,
      home,
    });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /MCP_FIXTURE_TEXT/u);

    const tested = await runCli(["mcp", "test", "echo", "--json"], {
      cwd: project,
      home,
      env: { MCP_FIXTURE_TEXT: "configured" },
    });
    assert.equal(tested.code, 0, tested.stderr);
    const result = JSON.parse(tested.stdout);
    assert.deepEqual(result.servers, ["echo"]);
    assert.deepEqual(result.tool_counts, { echo: 1 });
    assert.deepEqual(result.tools, ["mcp__echo__echo"]);
    assert.deepEqual(result.resource_servers, ["echo"]);
    assert.deepEqual(result.resource_tools, [
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource",
    ]);

    const removed = await runCli(["mcp", "remove", "echo"], {
      cwd: project,
      home,
    });
    assert.equal(removed.code, 0, removed.stderr);
    const removedConfig = await fs.readFile(configPath, "utf8");
    assert.doesNotMatch(removedConfig, /\[servers\.echo\]/u);
    assert.match(removedConfig, /\[servers\.keep\]/u);
    assert.match(removedConfig, /# keep this comment/u);

    const invalid = await runCli(
      ["mcp", "add", "Bad Name", "--", "node", FIXTURE],
      { cwd: project, home },
    );
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /server name must match/u);
  });
});

test("a corrupt OAuth store is recoverable through remove", async () => {
  await withTempDirectory("codepunk-mcp-auth-corrupt-", async (root) => {
    const home = path.join(root, "home");
    await fs.mkdir(home);
    const store = new core.McpAuthStore(home);
    await writeFile(store.path, "{not json");

    // The error text tells the user to remove and sign in again, so the
    // product path that does that must not fail on the same parse error.
    await assert.rejects(
      store.status("remote", "https://mcp.example.test/mcp"),
      (error) => error.code === "mcp.auth_corrupt",
    );
    const removed = await store.remove(
      "remote",
      "https://mcp.example.test/mcp",
    );
    assert.equal(removed, false);
    assert.deepEqual(JSON.parse(await fs.readFile(store.path, "utf8")), {
      version: 1,
      servers: {},
    });
    assert.deepEqual(
      await store.status("remote", "https://mcp.example.test/mcp"),
      { signed_in: false, expires_at: null, scope: null },
    );
  });
});

test("refresh lock stale window exceeds the waiter deadline", () => {
  assert.ok(
    core.MCP_REFRESH_LOCK_POLICY.staleMs > core.MCP_REFRESH_LOCK_POLICY.waitMs,
    "a waiter could steal a refresh lock before giving up on it",
  );
});

test("reading a custom-path auth store leaves the parent directory mode alone", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    return;
  }
  await withTempDirectory("codepunk-mcp-auth-mode-", async (root) => {
    const shared = path.join(root, "shared");
    await fs.mkdir(shared, { recursive: true });
    await fs.chmod(shared, 0o755);
    const store = new core.McpAuthStore(root, {
      path: path.join(shared, "auth.json"),
    });
    await writeFile(
      store.path,
      `${JSON.stringify({ version: 1, servers: {} }, null, 2)}\n`,
    );
    await store.status("remote", "https://mcp.example.test/mcp");
    const stat = await fs.stat(shared);
    assert.equal(stat.mode & 0o777, 0o755);
  });
});
