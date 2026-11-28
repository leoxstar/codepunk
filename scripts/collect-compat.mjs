#!/usr/bin/env node
/**
 * Collect an immutable compatibility corpus from a published single-package
 * `codepunk-cli@<version>` tarball (0.1.1+).
 *
 * Usage:
 *   node scripts/collect-compat.mjs --version 0.1.1
 *   node scripts/collect-compat.mjs --version 0.1.1 --cli-root /path/to/codepunk-cli
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  let version = null;
  let cliRoot = null;
  let overwrite = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version" && argv[i + 1] !== undefined) {
      version = argv[++i];
    } else if (arg === "--cli-root" && argv[i + 1] !== undefined) {
      cliRoot = argv[++i];
    } else if (arg === "--overwrite") {
      overwrite = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (
    version === null ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)
  ) {
    throw new Error(
      "usage: collect-compat.mjs --version <semver> [--cli-root <dir>]",
    );
  }
  return { version, cliRoot, overwrite };
}

async function startStubModelServer() {
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && (request.url ?? "").endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "compat-model", object: "model" }],
        }),
      );
      return;
    }
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = raw.length > 0 ? JSON.parse(raw) : {};
      const system =
        Array.isArray(body.messages) &&
        typeof body.messages[0]?.content === "string"
          ? body.messages[0].content
          : "";
      const text = system.includes("durable project memory summaries")
        ? "Compat session captured durable project facts."
        : "COMPAT_OK";
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const send = (value) => {
        response.write(`data: ${JSON.stringify(value)}\n\n`);
      };
      send({
        id: "compat-response",
        object: "chat.completion.chunk",
        created: 1,
        model: "compat-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: text },
            finish_reason: null,
          },
        ],
      });
      send({
        id: "compat-response",
        object: "chat.completion.chunk",
        created: 1,
        model: "compat-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      });
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function runCli(entryPath, args, { cwd, home }) {
  const env = {
    ...process.env,
    CODEPUNK_HOME: home,
    PI_OFFLINE: "1",
    NO_COLOR: "1",
  };
  return execFileAsync(process.execPath, [entryPath, ...args], {
    cwd,
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function walkFiles(root) {
  const output = [];
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        output.push(full);
      }
    }
  }
  await visit(root);
  return output.sort();
}

function escapeJsonString(value) {
  return JSON.stringify(value).slice(1, -1);
}

async function main() {
  const {
    version,
    cliRoot: providedCliRoot,
    overwrite,
  } = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const corpusRoot = path.join(
    repoRoot,
    "tests",
    "fixtures",
    "compat",
    version,
  );
  try {
    await fs.access(corpusRoot);
    if (!overwrite) {
      throw new Error(
        `refusing to overwrite existing corpus directory: ${corpusRoot} (pass --overwrite to replace)`,
      );
    }
    await fs.rm(corpusRoot, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const workRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), `codepunk-compat-${version}-`),
  );
  const npmPrefix = path.join(workRoot, "npm-prefix");
  const home = path.join(workRoot, "home");
  const project = path.join(workRoot, "project");
  const stub = await startStubModelServer();

  try {
    await fs.mkdir(npmPrefix, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(project, { recursive: true });

    let cliRoot = providedCliRoot;
    let distMeta = { integrity: "local", shasum: "local" };
    if (cliRoot === null) {
      const view = await execFileAsync(
        "npm",
        ["view", `codepunk-cli@${version}`, "dist", "--json"],
        { cwd: workRoot },
      );
      distMeta = JSON.parse(view.stdout);
      await execFileAsync(
        "npm",
        [
          "install",
          "--prefix",
          npmPrefix,
          "--no-audit",
          "--no-fund",
          "--ignore-scripts",
          `codepunk-cli@${version}`,
        ],
        { cwd: workRoot, maxBuffer: 20 * 1024 * 1024 },
      );
      cliRoot = path.join(npmPrefix, "node_modules", "codepunk-cli");
    }

    const pkg = JSON.parse(
      await fs.readFile(path.join(cliRoot, "package.json"), "utf8"),
    );
    if (pkg.name !== "codepunk-cli" || pkg.version !== version) {
      throw new Error(
        `expected codepunk-cli@${version}, got ${pkg.name}@${pkg.version}`,
      );
    }
    const entryPath = path.join(cliRoot, "dist", "index.js");

    // Initialize clean git project for delivery root
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: project });
    await execFileAsync("git", ["config", "user.name", "Compat Capture"], {
      cwd: project,
    });
    await execFileAsync(
      "git",
      ["config", "user.email", "compat@example.invalid"],
      { cwd: project },
    );
    await execFileAsync("git", ["config", "core.autocrlf", "false"], {
      cwd: project,
    });
    await fs.writeFile(path.join(project, "README.md"), "# compat project\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: project });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], {
      cwd: project,
    });

    const captureCommands = [
      `npm install codepunk-cli@${version} --prefix {{NPM_PREFIX}} --ignore-scripts`,
      `models import --provider compat --base-url {{COMPAT_BASE_URL}} --api-key {{COMPAT_API_KEY}} --model compat-model`,
      `models set compat/compat-model`,
      `trust grant {{PROJECT}}`,
      `-p --cwd {{PROJECT}} "First compat turn."`,
      `sessions list --json`,
      `-p --cwd {{PROJECT}} --fork <parent-session-id> "Forked compat turn."`,
      `mcp add compat-auth --url http://127.0.0.1:48762/mcp`,
      `mcp logout compat-auth`,
      `memory add --scope project "compat project note"`,
      `memory add --scope user "compat user note"`,
      `migrate --apply`,
      `backup create --json`,
    ];

    await runCli(
      entryPath,
      [
        "models",
        "import",
        "--provider",
        "compat",
        "--api",
        "openai-completions",
        "--base-url",
        stub.baseUrl,
        "--api-key",
        "compat-capture-api-key",
        "--model",
        "compat-model",
      ],
      { cwd: project, home },
    );
    await runCli(entryPath, ["models", "set", "compat/compat-model"], {
      cwd: project,
      home,
    });
    await runCli(entryPath, ["trust", "grant", project], {
      cwd: project,
      home,
    });
    await runCli(entryPath, ["-p", "--cwd", project, "First compat turn."], {
      cwd: project,
      home,
    });
    const listedSessions = await runCli(
      entryPath,
      ["sessions", "list", "--json"],
      { cwd: project, home },
    );
    const parsedSessions = JSON.parse(listedSessions.stdout);
    const sessionArray = Array.isArray(parsedSessions)
      ? parsedSessions
      : parsedSessions.sessions;
    const parentSessionId = sessionArray?.[0]?.id;
    if (typeof parentSessionId !== "string" || parentSessionId.length === 0) {
      throw new Error(
        `could not determine created session id: ${listedSessions.stdout}`,
      );
    }
    await runCli(
      entryPath,
      [
        "-p",
        "--cwd",
        project,
        "--fork",
        parentSessionId,
        "Forked compat turn.",
      ],
      { cwd: project, home },
    );
    await runCli(
      entryPath,
      ["mcp", "add", "compat-auth", "--url", "http://127.0.0.1:48762/mcp"],
      { cwd: project, home },
    );
    await runCli(entryPath, ["mcp", "logout", "compat-auth"], {
      cwd: project,
      home,
    });
    await runCli(
      entryPath,
      ["memory", "add", "--scope", "project", "compat project note"],
      { cwd: project, home },
    );
    await runCli(
      entryPath,
      ["memory", "add", "--scope", "user", "compat user note"],
      { cwd: project, home },
    );
    await runCli(entryPath, ["migrate", "--apply"], { cwd: project, home });
    await runCli(entryPath, ["backup", "create", "--json"], {
      cwd: project,
      home,
    });

    // Remove excluded capture artifacts (backups, .git, live locks, shadow-git)
    await fs.rm(path.join(home, "backups"), { recursive: true, force: true });
    await fs.rm(path.join(project, ".git"), { recursive: true, force: true });

    const realHome = await fs.realpath(home);
    const realProject = await fs.realpath(project);
    const realNpmPrefix = await fs.realpath(npmPrefix);
    const realPiDocs = path.join(
      realNpmPrefix,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );

    const replacements = [
      [realPiDocs, "{{PI_AGENT_DOCS}}"],
      [
        path.join(
          npmPrefix,
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
        ),
        "{{PI_AGENT_DOCS}}",
      ],
      [realNpmPrefix, "{{NPM_PREFIX}}"],
      [npmPrefix, "{{NPM_PREFIX}}"],
      [realProject, "{{PROJECT}}"],
      [project, "{{PROJECT}}"],
      [realHome, "{{HOME}}"],
      [home, "{{HOME}}"],
      [stub.baseUrl, "{{COMPAT_BASE_URL}}"],
      ["compat-capture-api-key", "{{COMPAT_API_KEY}}"],
    ];

    // Copy normalized files into corpusRoot
    await fs.mkdir(corpusRoot, { recursive: true });
    const manifestFiles = [];
    for (const [label, dir] of [
      ["home", home],
      ["project", project],
    ]) {
      const files = await walkFiles(dir);
      for (const file of files) {
        const relInside = path.relative(dir, file).split(path.sep).join("/");
        if (
          relInside.endsWith("/session.lock") ||
          relInside === "session.lock" ||
          relInside.includes("/shadow-git/")
        ) {
          continue;
        }
        const relCorpus = `${label}/${relInside}`;
        const dest = path.join(corpusRoot, relCorpus);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        let bytes = await fs.readFile(file);
        if (!bytes.includes(0)) {
          let text = bytes.toString("utf8");
          for (const [needle, placeholder] of replacements) {
            text = text.replaceAll(needle, placeholder);
            const escaped = escapeJsonString(needle);
            if (escaped !== needle) {
              text = text.replaceAll(escaped, placeholder);
            }
          }
          bytes = Buffer.from(text, "utf8");
        }
        await fs.writeFile(dest, bytes);
        manifestFiles.push({
          path: relCorpus,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
        });
      }
    }

    manifestFiles.sort((a, b) => a.path.localeCompare(b.path));
    const projectIds = await fs.readdir(
      path.join(corpusRoot, "home", "projects"),
    );
    const manifest = {
      source: {
        package: "codepunk-cli",
        version,
        integrity: distMeta.integrity,
        tarballSha1: distMeta.shasum,
      },
      environment: {
        os: `${os.type()} ${os.arch()} ${os.release()}`,
        node: process.version,
        codepunkHome: "{{HOME}}",
        project: "{{PROJECT}}",
        projectId: projectIds[0] ?? null,
        collectionDate: new Date().toISOString(),
      },
      pathPlaceholders: {
        "{{HOME}}": "restored CODEPUNK_HOME directory",
        "{{PROJECT}}": "restored project directory",
        "{{NPM_PREFIX}}":
          "temporary npm prefix that installed the published codepunk-cli tarball",
        "{{COMPAT_BASE_URL}}":
          "loopback OpenAI-compatible stub used during capture",
        "{{COMPAT_API_KEY}}":
          "placeholder API key used by the loopback capture stub",
        "{{PI_AGENT_DOCS}}":
          "published pi-coding-agent documentation directory inside the temporary npm installation",
      },
      coverage: {
        sessions: ["print turn", "fork from compat-parent"],
        mcpAuth: "mcp add + mcp logout",
        memory: "project and user memory add",
        trust: "workspace trust grant",
        retention: "migrate --apply + backup create operations ledger",
      },
      notCovered: [],
      captureCommands,
      files: manifestFiles,
      excludedCaptureArtifacts: [
        "home/backups/** (duplicate snapshot created by backup create)",
        "project/.git/** (source-control internals)",
        "session.lock files (live locks are not compatibility data)",
        "shadow-git/** (git pack/object internals)",
      ],
    };

    await fs.writeFile(
      path.join(corpusRoot, "MANIFEST.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(
      `collected ${manifestFiles.length} files for codepunk-cli@${version} -> ${corpusRoot}\n`,
    );
  } finally {
    await stub.close();
    await fs.rm(workRoot, { recursive: true, force: true });
  }
}

await main();
