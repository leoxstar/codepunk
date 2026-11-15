import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { importCore, importProtocol } from "./support/core.mjs";
import {
  ensureBuilt,
  fixedClock,
  withTempDirectory,
} from "./support/helpers.mjs";

const core = await importCore();
const protocol = await importProtocol();
const execFileAsync = promisify(execFile);

async function makeDaemonProject(root) {
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(path.join(home, "run"), { recursive: true, mode: 0o700 });
  await execFileAsync("git", ["init", "-q"], { cwd: project });
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
  return { project, home, paths };
}

async function seedSession(paths, project) {
  const store = await core.SessionStore.create({
    rootDir: paths.home,
    cwd: project,
    projectRoot: project,
    projectId: paths.projectId,
    now: fixedClock("2026-11-13T08:00:00.000Z"),
  });
  const writer = await store.acquireWriter();
  try {
    await store.append("run/start", {
      run_id: "run-daemon",
      session_id: store.sessionId,
    });
    await store.append("user/input", {
      run_id: "run-daemon",
      text: "read the session without changing it",
    });
  } finally {
    await writer.release();
  }
  return store;
}

async function fileSha256(filePath) {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

function request(method, params = {}, version = 1) {
  return {
    type: "codepunk/daemon-request",
    version,
    request_id: `daemon-${method.replaceAll("/", "-")}-${version}`,
    method,
    params,
  };
}

async function rawRequest(socketPath, payload, options = {}) {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const line =
    payload === null || payload === undefined
      ? null
      : typeof payload === "string"
        ? payload
        : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== null) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      finish(new Error("raw daemon request timed out"), null);
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", (error) => {
      finish(error, null);
    });
    socket.once("close", () => {
      if (!settled) {
        finish(new Error("daemon closed before a complete response"), null);
      }
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      try {
        finish(null, JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        finish(error, null);
      }
    });
    socket.once("connect", () => {
      if (line !== null) {
        socket.write(line.endsWith("\n") ? line : `${line}\n`);
      }
    });
  });
}

function waitForJsonLine(child) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`daemon start timed out: ${stderr}`));
    }, 10_000);
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onStderr);
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    };
    const onStderr = (chunk) => {
      stderr += chunk;
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onStderr);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited before startup: code ${code} ${stderr}`));
    });
  });
}

async function waitForExit(child) {
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  const [code] = await once(child, "exit");
  return code;
}

test("two clients interoperate and concurrent reads preserve the session", async () => {
  await withTempDirectory("codepunk-daemon-protocol-", async (root) => {
    assert.deepEqual(
      [
        protocol.DAEMON_REQUEST_MAX_BYTES,
        protocol.DAEMON_RESPONSE_MAX_BYTES,
        protocol.DAEMON_DEFAULT_PAGE_SIZE,
        protocol.DAEMON_MAX_PAGE_SIZE,
        protocol.DAEMON_MAX_CONNECTIONS,
        protocol.DAEMON_REQUEST_TIMEOUT_MS,
      ],
      [64 * 1024, 1024 * 1024, 100, 100, 32, 5_000],
    );
    const { project, paths } = await makeDaemonProject(root);
    const store = await seedSession(paths, project);
    const logBefore = await fileSha256(store.paths.logPath);
    await fs.unlink(store.paths.metaPath);

    const server = await core.DaemonServer.start({
      paths,
      now: fixedClock("2026-11-13T09:00:00.000Z"),
    });
    try {
      const socketStat = await fs.lstat(server.socketPath);
      assert.equal(socketStat.isSocket(), true);
      assert.equal(socketStat.mode & 0o777, 0o600);
      const directoryStat = await fs.stat(path.dirname(server.socketPath));
      assert.equal(directoryStat.mode & 0o777, 0o700);

      const first = new core.DaemonClient({ socketPath: server.socketPath });
      const second = new core.DaemonClient({ socketPath: server.socketPath });
      const [hello, listed, readByFirst, readBySecond] = await Promise.all([
        first.hello(),
        second.listSessions(),
        first.readAllSession(store.sessionId),
        second.readAllSession(store.sessionId),
      ]);

      assert.equal(hello.protocol_version, protocol.DAEMON_PROTOCOL_VERSION);
      assert.equal(hello.read_only, true);
      assert.deepEqual(hello.methods, [...protocol.DAEMON_METHODS]);
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0].id, store.sessionId);
      assert.equal(listed.sessions[0].last_seq, 2);
      assert.equal(readByFirst.header.id, store.sessionId);
      assert.equal(readBySecond.header.id, store.sessionId);
      assert.equal(readByFirst.events.length, 2);
      assert.deepEqual(
        readByFirst.events.map((event) => event.seq),
        [1, 2],
      );
      assert.equal(readByFirst.metadata.log_seq, 2);
      assert.equal(readByFirst.metadata.updated_at, store.header.created_at);
      assert.equal(
        protocol.validateSchema(protocol.DaemonHelloResultSchema, hello).ok,
        true,
      );
      assert.equal(
        protocol.validateSchema(protocol.DaemonSessionListResultSchema, listed)
          .ok,
        true,
      );
      assert.equal(
        protocol.validateSchema(
          protocol.DaemonSessionReadResultSchema,
          readByFirst,
        ).ok,
        true,
      );
      await assert.rejects(fs.access(store.paths.metaPath), /ENOENT/u);
      assert.equal(await fileSha256(store.paths.logPath), logBefore);
    } finally {
      await server.close();
    }
  });
});

test("mismatched versions and mutating methods are refused", async () => {
  await withTempDirectory("codepunk-daemon-refusal-", async (root) => {
    const { project, paths } = await makeDaemonProject(root);
    const store = await seedSession(paths, project);
    const logBefore = await fileSha256(store.paths.logPath);
    const server = await core.DaemonServer.start({ paths });
    try {
      for (const version of [0, 2]) {
        const response = await rawRequest(
          server.socketPath,
          request("session/list", {}, version),
        );
        assert.equal(response.ok, false);
        assert.equal(response.error.code, "protocol.version_mismatch");
      }
      for (const method of [
        "session/append",
        "approval/answer",
        "verdict/sign_off",
      ]) {
        const response = await rawRequest(server.socketPath, request(method));
        assert.equal(response.ok, false);
        assert.equal(response.error.code, "daemon.read_only");
      }
      const extraField = {
        ...request("session/list"),
        write: "src/file.ts",
      };
      assert.equal(
        (await rawRequest(server.socketPath, extraField)).error.code,
        "protocol.invalid_request",
      );
      const pathTraversal = request("session/read", {
        session_id: "../outside",
      });
      assert.equal(
        (await rawRequest(server.socketPath, pathTraversal)).error.code,
        "protocol.invalid_request",
      );
      assert.equal(
        (await rawRequest(server.socketPath, "{not-json")).error.code,
        "protocol.invalid_request",
      );
      const oversized = `{"type":"codepunk/daemon-request","padding":"${"x".repeat(
        protocol.DAEMON_REQUEST_MAX_BYTES,
      )}"}`;
      assert.equal(
        (await rawRequest(server.socketPath, oversized)).error.code,
        "daemon.request_too_large",
      );

      const client = new core.DaemonClient({ socketPath: server.socketPath });
      const after = await client.readAllSession(store.sessionId);
      assert.equal(after.events.length, 2);
      assert.equal(await fileSha256(store.paths.logPath), logBefore);
    } finally {
      await server.close();
    }
  });
});

test("session reads enforce ordering, page limits, and the response limit", async () => {
  await withTempDirectory("codepunk-daemon-limits-", async (root) => {
    const { project, paths } = await makeDaemonProject(root);
    const store = await seedSession(paths, project);
    const server = await core.DaemonServer.start({ paths });
    try {
      const firstPage = await rawRequest(
        server.socketPath,
        request("session/read", {
          session_id: store.sessionId,
          limit: 1,
        }),
      );
      assert.equal(firstPage.ok, true);
      assert.deepEqual(
        firstPage.result.events.map((event) => event.seq),
        [1],
      );
      assert.equal(firstPage.result.next_seq, 1);
      assert.equal(firstPage.result.has_more, true);

      const secondPage = await rawRequest(
        server.socketPath,
        request("session/read", {
          session_id: store.sessionId,
          after_seq: firstPage.result.next_seq,
          limit: 1,
        }),
      );
      assert.equal(secondPage.ok, true);
      assert.deepEqual(
        secondPage.result.events.map((event) => event.seq),
        [2],
      );
      assert.equal(secondPage.result.has_more, false);

      const tooMany = await rawRequest(
        server.socketPath,
        request("session/read", {
          session_id: store.sessionId,
          limit: protocol.DAEMON_MAX_PAGE_SIZE + 1,
        }),
      );
      assert.equal(tooMany.error.code, "protocol.invalid_request");
    } finally {
      await server.close();
    }
    const limited = await core.DaemonServer.start({
      paths,
      maxResponseBytes: 300,
    });
    try {
      const tooLarge = await rawRequest(
        limited.socketPath,
        request("session/read", {
          session_id: store.sessionId,
          limit: protocol.DAEMON_MAX_PAGE_SIZE,
        }),
      );
      assert.equal(tooLarge.error.code, "daemon.response_too_large");
    } finally {
      await limited.close();
    }
  });
});

test("socket paths reject symlinks and long paths fall back under /tmp", async () => {
  await withTempDirectory("codepunk-daemon-link-", async (root) => {
    const { paths } = await makeDaemonProject(root);
    const socketPath = core.daemonSocketPath(paths);
    await fs.symlink(path.join(root, "socket-target"), socketPath);
    await assert.rejects(
      () => core.DaemonServer.start({ paths }),
      /symbolic link/u,
    );
    assert.equal((await fs.lstat(socketPath)).isSymbolicLink(), true);

    const fallback = core.daemonSocketPath({
      home: path.join(os.tmpdir(), "x".repeat(120), "home"),
      projectId: "0123456789abcdef",
    });
    assert.match(
      fallback,
      new RegExp(
        `^/tmp/codepunk-${process.getuid()}/0123456789abcdef\\.sock$`,
        "u",
      ),
    );
    assert.equal(Buffer.byteLength(fallback, "utf8") <= 103, true);
  });
});

test("the daemon exposes at most 32 concurrent connections", async () => {
  await withTempDirectory("codepunk-daemon-connections-", async (root) => {
    const { paths } = await makeDaemonProject(root);
    const server = await core.DaemonServer.start({
      paths,
      requestTimeoutMs: 10_000,
    });
    const idle = [];
    try {
      for (let index = 0; index < protocol.DAEMON_MAX_CONNECTIONS; index += 1) {
        const socket = net.createConnection({ path: server.socketPath });
        socket.on("error", () => {});
        socket.once("connect", () => socket.write("{"));
        idle.push(socket);
        await once(socket, "connect");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      const overflow = net.createConnection({ path: server.socketPath });
      const overflowClosed = new Promise((resolve) =>
        overflow.once("close", resolve),
      );
      overflow.on("error", () => {});
      let received = "";
      overflow.setEncoding("utf8");
      overflow.on("data", (chunk) => {
        received += chunk;
      });
      await once(overflow, "connect");
      try {
        overflow.write(`${JSON.stringify(request("daemon/hello"))}\n`);
      } catch (error) {
        assert.equal(error.code, "EPIPE");
      }
      await overflowClosed;
      assert.equal(received, "");
    } finally {
      for (const socket of idle) {
        socket.destroy();
      }
      await server.close();
    }
  });
});

test("the daemon path fails closed on Windows", () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: "win32",
  });
  try {
    assert.throws(
      () =>
        core.daemonSocketPath({
          home: "/tmp/codepunk-win32",
          projectId: "0123456789abcdef",
        }),
      /Windows is not supported/u,
    );
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});

test("stale sockets are replaced, non-sockets are preserved, and idle requests time out", async () => {
  await withTempDirectory("codepunk-daemon-socket-", async (root) => {
    const { paths } = await makeDaemonProject(root);
    const socketPath = core.daemonSocketPath(paths);
    const holder = spawn(
      process.execPath,
      [
        "-e",
        "const net=require('node:net');const s=net.createServer();s.listen(process.argv[1],()=>process.stdout.write('ready\\n'));",
        socketPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("socket holder did not start")),
        5_000,
      );
      holder.stdout.once("data", (chunk) => {
        clearTimeout(timer);
        if (chunk.toString().includes("ready")) {
          resolve();
          return;
        }
        reject(new Error("socket holder returned an unexpected response"));
      });
      holder.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`socket holder exited early: ${code}`));
      });
    });
    holder.kill("SIGKILL");
    await waitForExit(holder);
    assert.equal((await fs.lstat(socketPath)).isSocket(), true);

    const server = await core.DaemonServer.start({
      paths,
      requestTimeoutMs: 80,
    });
    try {
      const client = new core.DaemonClient({ socketPath: server.socketPath });
      assert.equal((await client.hello()).read_only, true);
      await assert.rejects(
        () => core.DaemonServer.start({ paths }),
        /already running/u,
      );
      const timeout = await rawRequest(server.socketPath, null);
      assert.equal(timeout.error.code, "daemon.timeout");
    } finally {
      await server.close();
    }

    await fs.writeFile(socketPath, "not a socket\n", { mode: 0o600 });
    await assert.rejects(
      () => core.DaemonServer.start({ paths }),
      /not a socket/u,
    );
    assert.equal(await fs.readFile(socketPath, "utf8"), "not a socket\n");
    await fs.unlink(socketPath);
  });
});

test("the CLI daemon serves the second read-only view surface", async () => {
  await withTempDirectory("codepunk-daemon-cli-", async (root) => {
    const { project, home, paths } = await makeDaemonProject(root);
    const store = await seedSession(paths, project);
    const cli = await ensureBuilt();
    const environment = {
      ...process.env,
      CODEPUNK_HOME: home,
      NO_COLOR: "1",
    };
    const daemon = spawn(process.execPath, [cli, "daemon", "--json"], {
      cwd: project,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let socketPath;
    try {
      const started = await waitForJsonLine(daemon);
      assert.equal(started.read_only, true);
      assert.equal(started.protocol_version, protocol.DAEMON_PROTOCOL_VERSION);
      assert.equal(typeof started.socket, "string");
      socketPath = started.socket;

      const listed = await execFileAsync(
        process.execPath,
        [cli, "view", "--json"],
        { cwd: project, env: environment },
      );
      const listResult = JSON.parse(listed.stdout);
      assert.equal(listResult.sessions.length, 1);
      assert.equal(listResult.sessions[0].id, store.sessionId);

      const read = await execFileAsync(
        process.execPath,
        [cli, "view", store.sessionId, "--json"],
        { cwd: project, env: environment },
      );
      const readResult = JSON.parse(read.stdout);
      assert.equal(readResult.read_only, true);
      assert.equal(readResult.header.id, store.sessionId);
      assert.equal(readResult.events.length, 2);
    } finally {
      daemon.kill("SIGTERM");
    }
    assert.equal(await waitForExit(daemon), 0);
    await assert.rejects(fs.access(socketPath), /ENOENT/u);
  });
});
