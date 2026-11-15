import { writeFileSync } from "node:fs";
import readline from "node:readline";

const mode = process.env.CODEPUNK_MCP_FIXTURE_MODE ?? "normal";
const pidFile = process.env.CODEPUNK_MCP_FIXTURE_PID_FILE;
if (pidFile !== undefined && pidFile.length > 0) {
  writeFileSync(pidFile, `${process.pid}\n`);
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

input.on("line", (line) => {
  if (line.trim().length === 0) {
    return;
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) {
    return;
  }
  if (request.method === "initialize") {
    if (mode === "hang-initialize") {
      return;
    }
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "echo", version: "1.0.0" },
      },
    });
    return;
  }
  if (request.method === "tools/list") {
    if (mode === "hang-tools-list") {
      return;
    }
    if (mode === "naming") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: [
            {
              name: "a-b",
              description: "Dash name",
              inputSchema: {
                properties: { text: { type: "string" } },
              },
            },
            {
              name: "a_b",
              description: "Underscore name",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
              },
            },
            {
              name: `long-${"x".repeat(80)}`,
              description: "Long name",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
              },
            },
          ],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo the provided text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              additionalProperties: false,
            },
          },
        ],
      },
    });
    return;
  }
  if (request.method === "tools/call") {
    if (mode === "hang-tools-call") {
      return;
    }
    const text = request.params?.arguments?.text;
    if (typeof text !== "string") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          isError: true,
          content: [{ type: "text", text: "text is required" }],
        },
      });
      return;
    }
    if (mode === "large") {
      const payload = `START:${"x".repeat(28 * 1024)}:END`;
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: payload }],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: `echo:${text}` }],
      },
    });
    return;
  }
  send({
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32601, message: `unknown method ${request.method}` },
  });
});

input.on("close", () => {
  process.exit(0);
});
