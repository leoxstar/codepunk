import { readSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1024 * 1024;

interface ToolDefinition {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: unknown,
  ) => Promise<unknown> | unknown;
}

function fail(message: string): never {
  process.stderr.write(`codepunk plugin host: ${message}\n`);
  process.exit(2);
}

function readToken(fd: number): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(64);
  let total = 0;
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) {
        break;
      }
      total += count;
      if (total > 128) {
        fail("launch credential is too long");
      }
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
  } catch {
    fail("launch credential is missing");
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function verifyLaunch(): void {
  const token = readToken(3);
  const expected = readToken(4);
  if (token.length === 0 || token !== expected) {
    fail("launch credential does not match");
  }
}

function errorFrame(
  callId: string,
  pluginId: string,
  code: string,
  message: string,
  retryable = false,
): Record<string, unknown> {
  return {
    type: "codepunk/plugin-response",
    version: PROTOCOL_VERSION,
    call_id: callId,
    plugin_id: pluginId,
    ok: false,
    error: { code, message, retryable },
  };
}

function send(frame: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

async function main(): Promise<void> {
  verifyLaunch();
  const pluginDir = process.argv[2];
  const entry = process.argv[3];
  const pluginId = process.argv[4] ?? "plugin";
  if (pluginDir === undefined || entry === undefined) {
    fail("plugin directory, entry, and id are required");
  }
  const resolvedDir = path.resolve(pluginDir);
  const relative = path.relative(resolvedDir, path.resolve(entry));
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.length === 0
  ) {
    fail("entry escapes the plugin directory");
  }
  process.chdir(resolvedDir);

  const tools = new Map<string, ToolDefinition>();
  const commands: string[] = [];
  const controllers = new Map<string, AbortController>();
  delete process.env["CODEPUNK_HOME"];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CODEPUNK_")) {
      delete process.env[key];
    }
  }

  const api = {
    cwd: resolvedDir,
    registerTool(definition: ToolDefinition) {
      if (
        typeof definition?.name !== "string" ||
        definition.name.length === 0 ||
        typeof definition.execute !== "function"
      ) {
        throw new Error("registerTool requires name and execute");
      }
      tools.set(definition.name, definition);
    },
    registerCommand(
      command: string | { name?: unknown; description?: unknown },
      options?: { description?: unknown },
    ) {
      const name =
        typeof command === "string"
          ? command
          : typeof command?.name === "string"
            ? command.name
            : undefined;
      if (name === undefined || name.length === 0) {
        throw new Error("registerCommand requires a name");
      }
      void options;
      commands.push(name);
    },
    registerFlag() {
      // Plugin flags are not part of the isolated surface yet.
    },
    on() {
      // Host events are not forwarded into the plugin process.
    },
    async exec() {
      throw new Error("plugin.exec is unavailable; call a product tool");
    },
  };

  try {
    const entryPath = path.resolve(entry);
    const entryUrl = pathToFileURL(entryPath).href;
    const module = (await import(entryUrl)) as {
      default?: unknown;
    };
    if (typeof module.default !== "function") {
      fail("plugin entry must default-export a function");
    }
    await module.default(api);
  } catch (error) {
    fail(
      `plugin entry failed to load: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  input.on("line", (line) => {
    void (async () => {
      if (line.trim().length === 0) {
        return;
      }
      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
        send(
          errorFrame(
            "unknown",
            pluginId,
            "plugin.frame_too_large",
            `plugin frame exceeds ${MAX_FRAME_BYTES} bytes`,
          ),
        );
        return;
      }
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        send(
          errorFrame(
            "unknown",
            pluginId,
            "plugin.invalid_request",
            "request is not JSON",
          ),
        );
        return;
      }
      const callId =
        typeof frame["call_id"] === "string" ? frame["call_id"] : "unknown";
      if (
        frame["type"] !== "codepunk/plugin-request" ||
        frame["version"] !== PROTOCOL_VERSION ||
        typeof frame["method"] !== "string" ||
        callId === "unknown"
      ) {
        send(
          errorFrame(
            callId,
            pluginId,
            "plugin.invalid_request",
            "request frame is invalid",
          ),
        );
        return;
      }
      const method = frame["method"];
      if (method === "health") {
        send({
          type: "codepunk/plugin-response",
          version: PROTOCOL_VERSION,
          call_id: callId,
          plugin_id: pluginId,
          ok: true,
          result: {
            pid: process.pid,
            launch_verified: true,
            protocol: PROTOCOL_VERSION,
            tools: [...tools.keys()].sort(),
            commands: [...commands].sort(),
          },
        });
        return;
      }
      if (method === "tools/list") {
        send({
          type: "codepunk/plugin-response",
          version: PROTOCOL_VERSION,
          call_id: callId,
          plugin_id: pluginId,
          ok: true,
          result: [...tools.keys()].sort(),
        });
        return;
      }
      if (method === "shutdown") {
        send({
          type: "codepunk/plugin-response",
          version: PROTOCOL_VERSION,
          call_id: callId,
          plugin_id: pluginId,
          ok: true,
          result: { stopped: true },
        });
        setImmediate(() => process.exit(0));
        return;
      }
      if (method === "tools/cancel") {
        const params = frame["params"];
        const target =
          typeof params === "object" && params !== null
            ? (params as { call_id?: unknown }).call_id
            : undefined;
        if (typeof target === "string") {
          controllers.get(target)?.abort();
        }
        send({
          type: "codepunk/plugin-response",
          version: PROTOCOL_VERSION,
          call_id: callId,
          plugin_id: pluginId,
          ok: true,
          result: { cancelled: typeof target === "string" },
        });
        return;
      }
      if (method === "tools/call") {
        const params = frame["params"];
        if (typeof params !== "object" || params === null) {
          send(
            errorFrame(
              callId,
              pluginId,
              "plugin.invalid_request",
              "tools/call requires name and arguments",
            ),
          );
          return;
        }
        const { name, arguments: args } = params as {
          name?: unknown;
          arguments?: unknown;
        };
        if (typeof name !== "string") {
          send(
            errorFrame(
              callId,
              pluginId,
              "plugin.invalid_request",
              "tools/call requires a tool name",
            ),
          );
          return;
        }
        const definition = tools.get(name);
        if (definition === undefined) {
          send(
            errorFrame(
              callId,
              pluginId,
              "plugin.capability_denied",
              `tool ${name} is not declared by this plugin`,
            ),
          );
          return;
        }
        const controller = new AbortController();
        controllers.set(callId, controller);
        try {
          const result = await definition.execute(
            callId,
            args ?? {},
            controller.signal,
            undefined,
            { cwd: resolvedDir },
          );
          send({
            type: "codepunk/plugin-response",
            version: PROTOCOL_VERSION,
            call_id: callId,
            plugin_id: pluginId,
            ok: true,
            result: result ?? null,
          });
        } catch (error) {
          send(
            errorFrame(
              callId,
              pluginId,
              controller.signal.aborted
                ? "plugin.cancelled"
                : "plugin.internal",
              error instanceof Error ? error.message : String(error),
            ),
          );
        } finally {
          controllers.delete(callId);
        }
        return;
      }
      send(
        errorFrame(
          callId,
          pluginId,
          "plugin.unknown_method",
          `unknown plugin method ${method}`,
        ),
      );
    })();
  });
}

void main();
