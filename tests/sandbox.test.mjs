import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { importCore } from "./support/core.mjs";
import {
  readFakeEnv,
  writeFakeExecutable,
} from "./support/fake-executable.mjs";
import {
  windowsSrtSkipReason,
  withSandboxTempDirectory,
} from "./support/helpers.mjs";

const core = await importCore();
const execFileAsync = promisify(execFile);
const POSIX_SRT_SKIP =
  process.platform === "win32"
    ? "the assertion uses POSIX shell commands and paths"
    : false;
const WINDOWS_SRT_SKIP = await windowsSrtSkipReason(core);

async function setup() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "codepunk-sandbox-")),
  );
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const writable = path.join(project, "writable");
  await fs.mkdir(path.join(project, ".codepunk"), { recursive: true });
  await fs.mkdir(writable, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(
    path.join(project, ".codepunk", "policy.toml"),
    "protected\n",
  );
  return { root, home, project, writable };
}

test("missing srt dependencies disable execution", async () => {
  const input = {
    cwd: "/workspace",
    workspaceRoot: "/workspace",
    deliveryRoot: "/workspace",
    codepunkHome: "/srv/codepunk-home",
    writeSet: ["."],
  };
  await assert.rejects(
    core.SrtSandbox.create(input, {
      manager: {
        isSupportedPlatform: () => false,
        checkDependencies: () => ({ errors: [], warnings: [] }),
        initialize: async () => {},
      },
    }),
    /does not support this platform/u,
  );
  await assert.rejects(
    core.SrtSandbox.create(input, {
      manager: {
        isSupportedPlatform: () => true,
        checkDependencies: () => ({
          errors: ["srt executable is missing"],
          warnings: [],
        }),
        initialize: async () => {},
      },
      platform: "linux",
    }),
    /dependency check failed/u,
  );
});

test("windows initialization passes the vendored srt-win helper", async () => {
  const calls = [];
  let captured = null;
  const manager = {
    isSupportedPlatform: () => true,
    checkDependencies: () => ({
      errors: ["unexpected manager probe"],
      warnings: [],
    }),
    initialize: async (config) => {
      calls.push("initialize");
      captured = config;
    },
    cleanupAfterCommand: () => {},
  };
  const sandbox = await core.SrtSandbox.create(
    {
      cwd: "C:\\workspace",
      workspaceRoot: "C:\\workspace",
      deliveryRoot: "C:\\workspace",
      codepunkHome: "C:\\codepunk-home",
      writeSet: ["."],
    },
    {
      manager,
      platform: "win32",
      windowsDependencyCheck: async (config) => {
        calls.push("check");
        captured = config;
        return { errors: [], warnings: [] };
      },
    },
  );
  try {
    assert.deepEqual(calls, ["check", "initialize"]);
    assert.match(
      captured.windows.srtWin.path,
      /srt-win[\\/](?:x64|arm64)[\\/]srt-win\.exe$/u,
    );
    assert.equal(sandbox.descriptor.backend, "srt");
  } finally {
    await sandbox.close();
  }
});

test("windows dependency failures happen before initialization", async () => {
  let initialized = false;
  const manager = {
    isSupportedPlatform: () => true,
    checkDependencies: () => ({ errors: [], warnings: [] }),
    initialize: async () => {
      initialized = true;
    },
    cleanupAfterCommand: () => {},
  };
  await assert.rejects(
    core.SrtSandbox.create(
      {
        cwd: "C:\\workspace",
        workspaceRoot: "C:\\workspace",
        deliveryRoot: "C:\\workspace",
        codepunkHome: "C:\\codepunk-home",
        writeSet: ["."],
      },
      {
        manager,
        platform: "win32",
        windowsSrtWinPath: "C:\\runtime\\srt-win.exe",
        windowsDependencyCheck: async () => ({
          errors: ["Windows sandbox user is not provisioned"],
          warnings: [],
        }),
      },
    ),
    /srt dependency check failed: Windows sandbox user is not provisioned/u,
  );
  assert.equal(initialized, false);
});

test("windows initialization retries a transient proxy port collision", async () => {
  let attempts = 0;
  const manager = {
    isSupportedPlatform: () => true,
    checkDependencies: () => ({ errors: [], warnings: [] }),
    initialize: async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error(
          "listen EADDRINUSE: address already in use 127.0.0.1:60089",
        );
        error.code = "EADDRINUSE";
        throw error;
      }
    },
    cleanupAfterCommand: () => {},
  };
  const sandbox = await core.SrtSandbox.create(
    {
      cwd: "C:\\workspace",
      workspaceRoot: "C:\\workspace",
      deliveryRoot: "C:\\workspace",
      codepunkHome: "C:\\codepunk-home",
      writeSet: ["."],
    },
    {
      manager,
      platform: "win32",
      windowsDependencyCheck: async () => ({ errors: [], warnings: [] }),
    },
  );
  try {
    assert.equal(attempts, 3);
  } finally {
    await sandbox.close();
  }
});

test("windows probe checks dependencies without initialization", async () => {
  let initialized = false;
  let checked = false;
  const issue = await core.probeSrtSandbox(
    {
      cwd: "C:\\workspace",
      workspaceRoot: "C:\\workspace",
      deliveryRoot: "C:\\workspace",
      codepunkHome: "C:\\codepunk-home",
      writeSet: ["."],
    },
    {
      manager: {
        isSupportedPlatform: () => true,
        checkDependencies: () => ({
          errors: ["unexpected manager probe"],
          warnings: [],
        }),
        initialize: async () => {
          initialized = true;
        },
      },
      platform: "win32",
      windowsDependencyCheck: async () => {
        checked = true;
        return {
          errors: ["Windows sandbox user is not provisioned"],
          warnings: [],
        };
      },
    },
  );
  assert.equal(checked, true);
  assert.equal(initialized, false);
  assert.match(issue, /Windows sandbox user is not provisioned/u);
});

test("windows shell commands use argv wrapping without a shell", async () => {
  let captured = null;
  const cwd = process.cwd();
  const manager = {
    isSupportedPlatform: () => true,
    checkDependencies: () => ({
      errors: ["unexpected manager probe"],
      warnings: [],
    }),
    initialize: async () => {},
    wrapWithSandbox: async () => {
      throw new Error("Windows must not use the string shell wrapper");
    },
    wrapWithSandboxArgv: async (
      command,
      _shell,
      _config,
      _signal,
      cwd,
      options,
    ) => {
      captured = { command, cwd, options };
      return {
        argv: [process.execPath, "-e", "process.stdout.write('argv-shell-ok')"],
        env: { ...process.env, CODEPUNK_ARGV_PROBE: "yes" },
      };
    },
    annotateStderrWithSandboxFailures: (_command, stderr) => stderr,
    cleanupAfterCommand: () => {},
  };
  const sandbox = await core.SrtSandbox.create(
    {
      cwd: "C:\\workspace",
      workspaceRoot: "C:\\workspace",
      deliveryRoot: "C:\\workspace",
      codepunkHome: "C:\\codepunk-home",
      writeSet: ["."],
    },
    {
      manager,
      platform: "win32",
      windowsDependencyCheck: async () => ({ errors: [], warnings: [] }),
    },
  );
  try {
    const result = await sandbox.execCommand("echo argv-shell-ok", cwd);
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(result.output, "argv-shell-ok");
    assert.equal(result.executor, "srt");
    assert.equal(captured.command, "echo argv-shell-ok");
    assert.equal(captured.cwd, cwd);
    assert.match(captured.options.commandId, /^[0-9a-f-]{36}$/u);
  } finally {
    await sandbox.close();
  }
});

test("windows shell output decodes the OEM code page after strict UTF-8", () => {
  assert.equal(
    core.decodeShellOutput(Buffer.from("plain ascii")),
    "plain ascii",
  );
  assert.equal(
    core.decodeShellOutput(Buffer.from("拒绝访问。", "utf8"), "win32"),
    "拒绝访问。",
  );
  assert.equal(
    core.decodeShellOutput(
      Buffer.from([0xbe, 0xdc, 0xbe, 0xf8, 0xb7, 0xc3, 0xce, 0xca, 0xa1, 0xa3]),
      "win32",
    ),
    "拒绝访问。",
  );
  assert.equal(
    core.decodeShellOutput(Buffer.from("wide", "utf16le"), "win32"),
    "wide",
  );
});

test("windows execArgv replaces the runtime shell tail with argv", async () => {
  let captured = null;
  const cwd = process.cwd();
  const manager = {
    isSupportedPlatform: () => true,
    checkDependencies: () => ({
      errors: ["unexpected manager probe"],
      warnings: [],
    }),
    initialize: async () => {},
    wrapWithSandboxArgv: async (
      command,
      binShell,
      _config,
      _signal,
      _cwd,
      options,
    ) => {
      captured = { command, binShell, options };
      return {
        argv: [
          process.execPath,
          "-e",
          "console.log(JSON.stringify(process.argv.slice(1)))",
          binShell.exe,
          command,
        ],
        env: process.env,
      };
    },
    annotateStderrWithSandboxFailures: (_command, stderr) => stderr,
    cleanupAfterCommand: () => {},
  };
  const sandbox = await core.SrtSandbox.create(
    {
      cwd: "C:\\workspace",
      workspaceRoot: "C:\\workspace",
      deliveryRoot: "C:\\workspace",
      codepunkHome: "C:\\codepunk-home",
      writeSet: ["."],
    },
    {
      manager,
      platform: "win32",
      windowsDependencyCheck: async () => ({ errors: [], warnings: [] }),
    },
  );
  try {
    const target = [process.execPath, "--version"];
    const result = await sandbox.execArgv(target, cwd);
    assert.equal(result.exitCode, 0, result.output);
    assert.deepEqual(JSON.parse(result.output), target);
    assert.equal(captured.command, "__CODEPUNK_ARGV_SENTINEL__");
    assert.equal(captured.binShell.exe, "C:\\__codepunk_argv__\\runner.exe");
    assert.match(captured.options.commandText, /node(?:\.exe)?/u);
  } finally {
    await sandbox.close();
  }
});

test("windows execArgv rejects script launchers", async () => {
  const manager = {
    isSupportedPlatform: () => true,
    checkDependencies: () => ({
      errors: ["unexpected manager probe"],
      warnings: [],
    }),
    initialize: async () => {},
    wrapWithSandboxArgv: async () => {
      throw new Error("script launchers must be rejected before wrapping");
    },
    annotateStderrWithSandboxFailures: (_command, stderr) => stderr,
    cleanupAfterCommand: () => {},
  };
  const sandbox = await core.SrtSandbox.create(
    {
      cwd: "C:\\workspace",
      workspaceRoot: "C:\\workspace",
      deliveryRoot: "C:\\workspace",
      codepunkHome: "C:\\codepunk-home",
      writeSet: ["."],
    },
    {
      manager,
      platform: "win32",
      windowsDependencyCheck: async () => ({ errors: [], warnings: [] }),
    },
  );
  try {
    await assert.rejects(
      sandbox.execArgv(["C:\\tools\\run.cmd", "arg"], "C:\\workspace"),
      /cannot start a Windows script/u,
    );
  } finally {
    await sandbox.close();
  }
});

test(
  "windows executable resolution uses PATH and PATHEXT",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codepunk-which-"));
    try {
      const bin = path.join(root, "bin");
      await fs.mkdir(bin);
      const executable = path.join(bin, "probe-tool.EXE");
      await fs.writeFile(executable, "");
      assert.equal(
        core.resolveWindowsExecutable("probe-tool", {
          PATH: bin,
          PATHEXT: ".EXE",
        }),
        executable,
      );
      assert.equal(
        core.resolveWindowsExecutable("probe-tool", {
          PaTh: bin,
          pAtHeXt: ".EXE",
        }),
        executable,
      );
      await assert.rejects(
        async () =>
          core.resolveWindowsExecutable("missing-probe-tool", {
            PATH: bin,
            PATHEXT: ".EXE",
          }),
        /not found on PATH/u,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test("network allowlist reaches the srt profile and descriptor", async () => {
  let captured = null;
  const manager = {
    isSupportedPlatform: () => true,
    checkDependencies: () => ({ errors: [], warnings: [] }),
    initialize: async (config) => {
      captured = config;
    },
    wrapWithSandbox: async () => "true",
    wrapWithSandboxArgv: async () => ({ argv: ["true"], env: {} }),
    annotateStderrWithSandboxFailures: (_command, stderr) => stderr,
  };
  const sandbox = await core.SrtSandbox.create(
    {
      cwd: "/workspace",
      workspaceRoot: "/workspace",
      deliveryRoot: "/workspace",
      codepunkHome: "/srv/codepunk-home",
      writeSet: ["."],
      networkAllow: ["registry.npmjs.org", "*.npmjs.org"],
      networkDeny: ["evil.npmjs.org"],
    },
    { manager, platform: "linux" },
  );
  assert.deepEqual(captured.network.allowedDomains, [
    "*.npmjs.org",
    "registry.npmjs.org",
  ]);
  assert.deepEqual(captured.network.deniedDomains, ["evil.npmjs.org"]);
  assert.deepEqual(sandbox.descriptor.network_allowed_domains, [
    "*.npmjs.org",
    "registry.npmjs.org",
  ]);
  assert.deepEqual(sandbox.descriptor.network_denied_domains, [
    "evil.npmjs.org",
  ]);
});

test(
  "srt runs allowed commands and confines reads and writes",
  {
    skip: POSIX_SRT_SKIP,
  },
  async () => {
    const paths = await setup();
    const sandbox = await core.SrtSandbox.create({
      cwd: paths.project,
      workspaceRoot: paths.project,
      deliveryRoot: paths.project,
      codepunkHome: paths.home,
      writeSet: [paths.writable],
    });

    try {
      const allowed = await sandbox.execCommand("printf ok", paths.project);
      assert.equal(allowed.exitCode, 0);
      assert.equal(allowed.output, "ok");
      assert.equal(allowed.executor, "srt");
      assert.equal(allowed.descriptor.backend, "srt");
      assert.match(allowed.descriptor.profile_sha256, /^sha256:/u);

      const inside = await sandbox.execCommand(
        "printf inside > inside.txt",
        paths.writable,
      );
      assert.equal(inside.exitCode, 0);
      assert.equal(
        await fs.readFile(path.join(paths.writable, "inside.txt"), "utf8"),
        "inside",
      );

      const outsideTarget = path.join(paths.project, "outside.txt");
      const outside = await sandbox.execCommand(
        `printf outside > ${JSON.stringify(outsideTarget)}`,
        paths.project,
      );
      assert.notEqual(outside.exitCode, 0);
      await assert.rejects(fs.readFile(outsideTarget), { code: "ENOENT" });

      const protectedRead = await sandbox.execCommand(
        "cat .codepunk/policy.toml",
        paths.project,
      );
      assert.notEqual(protectedRead.exitCode, 0);
      assert.doesNotMatch(protectedRead.output, /^protected$/mu);

      const argv = await sandbox.execArgv(
        ["/usr/bin/printf", "%s", "argv-ok"],
        paths.project,
      );
      assert.equal(argv.exitCode, 0, argv.output);
      assert.equal(argv.output, "argv-ok", argv.output);
    } finally {
      await sandbox.close();
    }
  },
);

test(
  "srt protects git config and hook execution surfaces",
  {
    skip: POSIX_SRT_SKIP,
  },
  async () => {
    const paths = await setup();
    await fs.mkdir(path.join(paths.project, ".git", "hooks"), {
      recursive: true,
    });
    await fs.mkdir(path.join(paths.project, ".git", "info"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(paths.project, ".git", "config"),
      "[core]\n\trepositoryformatversion = 0\n",
    );
    await fs.writeFile(
      path.join(paths.project, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\nexit 0\n",
    );
    await fs.writeFile(path.join(paths.project, ".git", "info", "exclude"), "");
    const sandbox = await core.SrtSandbox.create({
      cwd: paths.project,
      workspaceRoot: paths.project,
      deliveryRoot: paths.project,
      codepunkHome: paths.home,
      writeSet: [paths.project],
    });
    try {
      const normal = await sandbox.execCommand(
        "printf normal > normal.txt",
        paths.project,
      );
      assert.equal(normal.exitCode, 0, normal.output);
      for (const target of [
        ".git/config",
        ".git/hooks/pre-commit",
        ".git/info/exclude",
      ]) {
        const denied = await sandbox.execCommand(
          `printf changed > ${target}`,
          paths.project,
        );
        assert.notEqual(denied.exitCode, 0, target);
      }
      assert.match(
        await fs.readFile(path.join(paths.project, ".git", "config"), "utf8"),
        /repositoryformatversion/u,
      );
      assert.match(
        await fs.readFile(
          path.join(paths.project, ".git", "hooks", "pre-commit"),
          "utf8",
        ),
        /exit 0/u,
      );
    } finally {
      await sandbox.close();
    }
  },
);

test("agent shell disables optional git locks so status cannot rewrite the index", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "codepunk-git-locks-")),
  );
  const project = path.join(root, "project");
  const bin = path.join(root, "bin");
  await fs.mkdir(project);
  await fs.mkdir(bin);
  await execFileAsync("git", ["init", "-q"], { cwd: project });
  await execFileAsync("git", ["config", "user.email", "probe@example.com"], {
    cwd: project,
  });
  await execFileAsync("git", ["config", "user.name", "probe"], {
    cwd: project,
  });
  const tracked = path.join(project, "a.txt");
  const indexPath = path.join(project, ".git", "index");
  await fs.writeFile(tracked, "a\n");
  await execFileAsync("git", ["add", "a.txt"], { cwd: project });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd: project });

  // Apple Git may leave the index untouched even when the default lock mode
  // allows a refresh, so probe the environment contract directly instead of
  // assuming one Git build's index-refresh behavior.
  await writeFakeExecutable(bin, "git", {
    stdout: " M a.txt\n",
    captureEnv: "GIT_OPTIONAL_LOCKS",
  });
  const controlEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  delete controlEnv["GIT_OPTIONAL_LOCKS"];
  await execFileAsync("git", ["status", "--short"], {
    cwd: project,
    env: controlEnv,
  });
  assert.equal(
    await readFakeEnv(bin, "git"),
    "unset",
    "positive control: the probe must see no guard by default",
  );

  await fs.writeFile(tracked, "b\n");
  const beforeAgent = await fs.readFile(indexPath);
  const shell = new core.UnsandboxedShell();
  try {
    const operations = core.createSandboxBashOperations(shell);
    const result = await operations.exec("git status --short", project, {
      timeout: 5_000,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(result.exitCode, 0);
  } finally {
    await shell.close();
  }
  assert.equal(
    await readFakeEnv(bin, "git"),
    "0",
    "agent shell must disable optional Git locks",
  );
  const afterAgent = await fs.readFile(indexPath);
  assert.equal(
    beforeAgent.equals(afterAgent),
    true,
    "agent shell must not rewrite the index",
  );
});

test(
  "read-only autonomy removes the workspace write grant",
  {
    skip: POSIX_SRT_SKIP,
  },
  async () => {
    const paths = await setup();
    const readOnly = await core.SrtSandbox.create({
      cwd: paths.project,
      workspaceRoot: paths.project,
      deliveryRoot: paths.project,
      codepunkHome: paths.home,
      writeSet: [paths.writable],
      readOnly: true,
    });
    try {
      const write = await readOnly.execCommand(
        `printf blocked > ${JSON.stringify(path.join(paths.writable, "ro.txt"))}`,
        paths.writable,
      );
      assert.notEqual(write.exitCode, 0, write.output);
      await assert.rejects(
        fs.readFile(path.join(paths.writable, "ro.txt")),
        { code: "ENOENT" },
        "a read-only profile must not create files in the write set",
      );

      const mkdir = await readOnly.execCommand(
        `mkdir ${JSON.stringify(path.join(paths.writable, "ro-dir"))}`,
        paths.writable,
      );
      assert.notEqual(mkdir.exitCode, 0, mkdir.output);
      await assert.rejects(fs.stat(path.join(paths.writable, "ro-dir")), {
        code: "ENOENT",
      });

      const read = await readOnly.execCommand("printf readable", paths.project);
      assert.equal(read.exitCode, 0, read.output);
      assert.equal(read.output, "readable");
    } finally {
      await readOnly.close();
    }
  },
);

test(
  "windows srt runs shell commands, confines writes, and executes argv",
  {
    skip: WINDOWS_SRT_SKIP,
  },
  async () => {
    await withSandboxTempDirectory("codepunk-sandbox-win-", async (root) => {
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      const writable = path.join(project, "writable");
      await fs.mkdir(path.join(project, ".codepunk"), { recursive: true });
      await fs.mkdir(writable, { recursive: true });
      await fs.mkdir(home, { recursive: true });
      await fs.writeFile(
        path.join(project, ".codepunk", "policy.toml"),
        "protected\n",
      );

      const sandbox = await core.SrtSandbox.create({
        cwd: project,
        workspaceRoot: project,
        deliveryRoot: project,
        codepunkHome: home,
        writeSet: [writable],
      });
      try {
        const shell = await sandbox.execCommand("echo shell-ok", project);
        assert.equal(shell.exitCode, 0, shell.output);
        assert.equal(shell.output.trim(), "shell-ok");
        assert.equal(shell.executor, "srt");

        const inside = await sandbox.execCommand(
          `node -e "require('fs').writeFileSync('inside.txt','inside')"`,
          writable,
        );
        assert.equal(inside.exitCode, 0, inside.output);
        assert.equal(
          await fs.readFile(path.join(writable, "inside.txt"), "utf8"),
          "inside",
        );

        const outsideTarget = path.join(project, "outside.txt");
        const outside = await sandbox.execCommand(
          `node -e "require('fs').writeFileSync('..\\\\outside.txt','outside')"`,
          writable,
        );
        assert.notEqual(outside.exitCode, 0, outside.output);
        await assert.rejects(fs.readFile(outsideTarget), { code: "ENOENT" });

        const protectedRead = await sandbox.execCommand(
          `node -e "process.stdout.write(require('fs').readFileSync('.codepunk/policy.toml','utf8'))"`,
          project,
        );
        assert.notEqual(protectedRead.exitCode, 0, protectedRead.output);
        assert.doesNotMatch(protectedRead.output, /^protected$/mu);

        const argv = await sandbox.execArgv(
          [process.execPath, "-e", "process.stdout.write('argv-ok')"],
          project,
        );
        assert.equal(argv.exitCode, 0, argv.output);
        assert.equal(argv.output, "argv-ok");
      } finally {
        await sandbox.close();
      }
    });
  },
);

test(
  "windows srt blocks network egress unless the destination is allowed",
  {
    skip: WINDOWS_SRT_SKIP,
  },
  async () => {
    await withSandboxTempDirectory("codepunk-network-win-", async (root) => {
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      await fs.mkdir(home, { recursive: true });
      await fs.mkdir(project, { recursive: true });
      await fs.writeFile(
        path.join(project, "probe.mjs"),
        [
          "const target = process.argv[2];",
          "fetch(target, { signal: AbortSignal.timeout(15000) })",
          '  .then((response) => { console.log("OK", response.status); process.exit(0); })',
          '  .catch((error) => { console.error("FAIL", error.name, error.message); process.exit(1); });',
          "",
        ].join("\n"),
      );

      const loopback = http.createServer((_request, response) => {
        response.end("loopback-ok");
      });
      await new Promise((resolve) => {
        loopback.listen(0, "127.0.0.1", resolve);
      });
      const address = loopback.address();
      assert.ok(address && typeof address === "object");
      const loopbackUrl = `http://127.0.0.1:${address.port}/`;

      try {
        const denied = await core.SrtSandbox.create({
          cwd: project,
          workspaceRoot: project,
          deliveryRoot: project,
          codepunkHome: home,
          writeSet: [project],
        });
        try {
          const external = await denied.execCommand(
            "node probe.mjs https://example.com/",
            project,
          );
          assert.notEqual(external.exitCode, 0, external.output);
          assert.match(external.output, /deny network-outbound example\.com/u);

          const local = await denied.execCommand(
            `node probe.mjs ${loopbackUrl}`,
            project,
          );
          assert.notEqual(local.exitCode, 0, local.output);
          assert.match(local.output, /deny network-outbound 127\.0\.0\.1/u);
        } finally {
          await denied.close();
        }

        const allowed = await core.SrtSandbox.create({
          cwd: project,
          workspaceRoot: project,
          deliveryRoot: project,
          codepunkHome: home,
          writeSet: [project],
          networkAllow: ["example.com"],
        });
        try {
          const external = await allowed.execCommand(
            "node probe.mjs https://example.com/",
            project,
          );
          assert.equal(external.exitCode, 0, external.output);
          assert.match(external.output, /OK 200/u);
        } finally {
          await allowed.close();
        }
      } finally {
        await new Promise((resolve) => loopback.close(resolve));
      }
    });
  },
);
