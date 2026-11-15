import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { importCore } from "./support/core.mjs";

const core = await importCore();
const execFileAsync = promisify(execFile);

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
    }),
    /dependency check failed/u,
  );
});

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
    { manager },
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

test("srt runs allowed commands and confines reads and writes", async () => {
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
});

test("srt protects git config and hook execution surfaces", async () => {
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
});

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
  const fakeGit = path.join(bin, "git");
  await fs.writeFile(
    fakeGit,
    "#!/bin/sh\nprintf '%s' \"${GIT_OPTIONAL_LOCKS-unset}\" > \"$PROBE_FILE\"\nprintf ' M a.txt\\n'\n",
    { mode: 0o755 },
  );
  const controlProbe = path.join(root, "control.txt");
  const controlEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    PROBE_FILE: controlProbe,
  };
  delete controlEnv["GIT_OPTIONAL_LOCKS"];
  await execFileAsync("git", ["status", "--short"], {
    cwd: project,
    env: controlEnv,
  });
  assert.equal(
    await fs.readFile(controlProbe, "utf8"),
    "unset",
    "positive control: the probe must see no guard by default",
  );

  await fs.writeFile(tracked, "b\n");
  const beforeAgent = await fs.readFile(indexPath);
  const shell = new core.UnsandboxedShell();
  const agentProbe = path.join(root, "agent.txt");
  try {
    const operations = core.createSandboxBashOperations(shell);
    const result = await operations.exec("git status --short", project, {
      timeout: 5_000,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        PROBE_FILE: agentProbe,
      },
    });
    assert.equal(result.exitCode, 0);
  } finally {
    await shell.close();
  }
  assert.equal(
    await fs.readFile(agentProbe, "utf8"),
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

test("read-only autonomy removes the workspace write grant", async () => {
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
});
