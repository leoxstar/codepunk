import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import {
  ensureBuilt,
  escapeRegExp,
  PRODUCT_VERSION,
  makeProject,
  withTempDirectory,
  writeFile,
} from "./support/helpers.mjs";

const core = await importCore();
const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return (
    await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runGuarded(child, label) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ label, code, stdout, stderr }));
  });
}

function runGuardedCli(cli, args, options) {
  return new Promise((resolve, reject) => {
    const { cwd, env, token, expectedToken } = options;
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (token !== undefined) {
      child.stdio[3].end(token);
    }
    if (expectedToken !== undefined) {
      child.stdio[4].end(expectedToken);
    }
  });
}

async function makeRepo(root) {
  const project = path.join(root, "project");
  await fs.mkdir(project);
  await git(project, ["init", "-q"]);
  await git(project, ["config", "user.email", "test@example.invalid"]);
  await git(project, ["config", "user.name", "Test User"]);
  await writeFile(path.join(project, ".gitignore"), ".codepunk/\n");
  await writeFile(path.join(project, "AGENTS.md"), "base instructions\n");
  await writeFile(path.join(project, "src", "app.txt"), "base\n");
  await git(project, ["add", "."]);
  await git(project, ["commit", "-q", "-m", "base"]);
  const baseCommit = (await git(project, ["rev-parse", "HEAD"])).trim();
  const { paths } = await makeProject(root);
  const context = await core.findDeliveryRoot(project);
  const realPaths = core.projectPaths(context, paths.home);
  return { project, baseCommit, paths: realPaths };
}

test(
  "worker shell is confined to its worktree and git operations stay valid",
  {
    skip:
      process.platform === "win32"
        ? "the fixture uses POSIX shell commands, paths, and executable scripts"
        : false,
  },
  async () => {
    await withTempDirectory("codepunk-worker-sandbox-", async (root) => {
      const { project, baseCommit, paths } = await makeRepo(root);
      const worktreesRoot = path.join(root, "worktrees");
      const runDir = path.join(root, "run", "worker-a");
      const installRoot = path.join(root, "install", "codepunk");
      await fs.mkdir(runDir, { recursive: true });
      await writeFile(
        path.join(installRoot, "host-source.txt"),
        "installed host source\n",
      );
      assert.ok(
        core
          .defaultWorkerInstallRoots()
          .some((entry) => entry.endsWith(path.join("packages", "core"))),
      );
      const worktree = await core.createDetachedWorktree({
        deliveryRoot: project,
        projectId: paths.projectId,
        workerId: "worker-a",
        baseCommit,
        tempRoot: worktreesRoot,
      });
      await writeFile(
        path.join(worktree.path, ".codepunk", "config.toml"),
        "base config\n",
      );
      const protectedGitTargets = new Map([
        [
          path.join(project, ".git", "hooks", "pre-commit"),
          "#!/bin/sh\n# protected sentinel\n",
        ],
        [
          path.join(project, ".git", "info", "exclude"),
          "# protected sentinel\n",
        ],
        [
          path.join(project, ".git", "packed-refs"),
          "# pack-refs with: peeled fully-peeled sorted \n",
        ],
        [
          path.join(project, ".git", "refs", "heads", "protected-sentinel"),
          `${baseCommit}\n`,
        ],
        [path.join(project, ".git", "objects", "info", "alternates"), ""],
        [
          path.join(
            project,
            ".git",
            "objects",
            "pack",
            "protected-sentinel.tmp",
          ),
          "protected sentinel\n",
        ],
      ]);
      await writeFile(path.join(project, "escape.txt"), "parent sentinel\n");
      await writeFile(
        path.join(worktreesRoot, paths.projectId, "sibling-escape.txt"),
        "sibling sentinel\n",
      );
      const sandbox = await core.WorkerSandbox.create({
        worktree: worktree.path,
        runDir,
        deliveryRoot: project,
        parentRoot: project,
        siblingRoot: path.join(worktreesRoot, paths.projectId),
        codepunkHome: paths.home,
        installRoots: [...core.defaultWorkerInstallRoots(), installRoot],
        networkAllow: ["registry.npmjs.org"],
        networkDeny: ["evil.npmjs.org"],
        depth: 0,
      });
      try {
        assert.deepEqual(sandbox.descriptor.network_allowed_domains, [
          "registry.npmjs.org",
        ]);
        assert.deepEqual(sandbox.descriptor.network_denied_domains, [
          "evil.npmjs.org",
        ]);
        await writeFile(path.join(paths.home, "canary.txt"), "secret\n");
        await writeFile(
          path.join(worktreesRoot, paths.projectId, "sibling.txt"),
          "sibling\n",
        );
        await writeFile(
          path.join(project, ".codepunk", "secret.txt"),
          "project state\n",
        );
        const inside = await sandbox.execCommand(
          "printf worker-ok",
          worktree.path,
        );
        assert.equal(inside.exitCode, 0);
        assert.match(inside.output, /worker-ok/u);
        const runWrite = await sandbox.execCommand(
          `printf run-ok > ${JSON.stringify(path.join(runDir, "ok.txt"))}`,
          worktree.path,
        );
        assert.equal(runWrite.exitCode, 0, runWrite.output);
        const status = await sandbox.execCommand(
          "git status --short",
          worktree.path,
        );
        assert.equal(status.exitCode, 0, status.output);

        const instructionWrite = await sandbox.execCommand(
          `printf hacked >> ${JSON.stringify(path.join(worktree.path, "AGENTS.md"))}`,
          worktree.path,
        );
        assert.notEqual(instructionWrite.exitCode, 0);
        assert.equal(
          await fs.readFile(path.join(worktree.path, "AGENTS.md"), "utf8"),
          "base instructions\n",
        );
        const workerConfigWrite = await sandbox.execCommand(
          `printf hacked >> ${JSON.stringify(path.join(worktree.path, ".codepunk", "config.toml"))}`,
          worktree.path,
        );
        assert.notEqual(workerConfigWrite.exitCode, 0);
        assert.equal(
          await fs.readFile(
            path.join(worktree.path, ".codepunk", "config.toml"),
            "utf8",
          ),
          "base config\n",
        );
        assert.throws(
          () =>
            sandbox.assertWriteTarget(path.join(worktree.path, "AGENTS.md"), [
              "AGENTS.md",
            ]),
          /protected instruction or configuration/u,
        );
        assert.throws(
          () =>
            sandbox.assertWriteTarget(path.join(worktree.path, "claude.md"), [
              "claude.md",
            ]),
          /protected instruction or configuration/u,
        );
        assert.throws(
          () =>
            sandbox.assertWriteTarget(
              path.join(worktree.path, ".codepunk", "config.toml"),
              [".codepunk/"],
            ),
          /protected instruction or configuration/u,
        );

        await writeFile(path.join(worktree.path, "src", "new.txt"), "new\n");
        await git(worktree.path, ["add", "src/new.txt"]);
        await git(worktree.path, ["commit", "-q", "-m", "worker change"]);
        assert.match(
          await git(worktree.path, ["log", "-1", "--pretty=%s"]),
          /worker change/u,
        );

        const outside = await sandbox.execCommand(
          `printf altered > ${JSON.stringify(path.join(project, "escape.txt"))}`,
          worktree.path,
        );
        assert.equal(
          await fs.readFile(path.join(project, "escape.txt"), "utf8"),
          "parent sentinel\n",
          outside.output,
        );
        await sandbox.execCommand(
          `touch ${JSON.stringify(path.join(project, "escape-created.txt"))}`,
          worktree.path,
        );
        await assert.rejects(
          () => fs.access(path.join(project, "escape-created.txt")),
          /ENOENT/u,
        );
        const sibling = await sandbox.execCommand(
          `printf altered > ${JSON.stringify(
            path.join(worktreesRoot, paths.projectId, "sibling-escape.txt"),
          )}`,
          worktree.path,
        );
        assert.equal(
          await fs.readFile(
            path.join(worktreesRoot, paths.projectId, "sibling-escape.txt"),
            "utf8",
          ),
          "sibling sentinel\n",
          sibling.output,
        );
        await sandbox.execCommand(
          `touch ${JSON.stringify(
            path.join(worktreesRoot, paths.projectId, "sibling-created.txt"),
          )}`,
          worktree.path,
        );
        await assert.rejects(
          () =>
            fs.access(
              path.join(worktreesRoot, paths.projectId, "sibling-created.txt"),
            ),
          /ENOENT/u,
        );
        const canary = await sandbox.execCommand(
          `cat ${JSON.stringify(path.join(paths.home, "canary.txt"))}`,
          worktree.path,
        );
        assert.notEqual(canary.exitCode, 0);
        const siblingRead = await sandbox.execCommand(
          `cat ${JSON.stringify(
            path.join(worktreesRoot, paths.projectId, "sibling.txt"),
          )}`,
          worktree.path,
        );
        assert.notEqual(siblingRead.exitCode, 0);
        assert.doesNotMatch(siblingRead.output, /^sibling$/mu);
        const projectStateRead = await sandbox.execCommand(
          `cat ${JSON.stringify(path.join(project, ".codepunk", "secret.txt"))}`,
          worktree.path,
        );
        assert.notEqual(projectStateRead.exitCode, 0);
        assert.doesNotMatch(projectStateRead.output, /^project state$/mu);
        const installRead = await sandbox.execCommand(
          `cat ${JSON.stringify(path.join(installRoot, "host-source.txt"))}`,
          worktree.path,
        );
        assert.notEqual(installRead.exitCode, 0, installRead.output);
        assert.doesNotMatch(installRead.output, /installed host source/iu);
        const configWrite = await sandbox.execCommand(
          `printf x >> ${JSON.stringify(path.join(project, ".git", "config"))}`,
          worktree.path,
        );
        assert.notEqual(configWrite.exitCode, 0);
        assert.throws(
          () =>
            sandbox.assertWriteTarget(path.join(worktree.path, "other.txt"), [
              "src/",
            ]),
          /write set/u,
        );
        await assert.rejects(
          () =>
            sandbox.execCommand("GIT_DIR=../.git git status", worktree.path),
          /redirects are denied/u,
        );
        for (const redirect of [
          "GIT_WORK_TREE=../other git status",
          "GIT_COMMON_DIR=../.git git status",
          "GIT_INDEX_FILE=../index git status",
          "GIT_OBJECT_DIRECTORY=../objects git status",
        ]) {
          assert.throws(
            () => core.assertWorkerCommand(redirect),
            /redirects are denied/u,
          );
        }
        await assert.rejects(
          () =>
            sandbox.execCommand("git hash-object src/app.txt", worktree.path),
          /plumbing/u,
        );
        for (const plumbing of [
          "git update-index --add src/app.txt",
          "git commit-tree HEAD^{tree}",
          "git mktree",
          "git write-tree",
        ]) {
          assert.throws(() => core.assertWorkerCommand(plumbing), /plumbing/u);
        }
        for (const denied of [
          "git push origin HEAD",
          "git update-ref refs/heads/main HEAD",
          "git branch -f main HEAD",
          "git reset --hard HEAD",
          "gh pr merge 1",
          "gh api repos/x/y/pulls/1/merge",
        ]) {
          assert.throws(
            () => core.assertWorkerCommand(denied),
            /workers cannot/u,
          );
        }
        assert.throws(
          () =>
            core.assertWorkerCommand("env -u CODEPUNK_DEPTH codepunk doctor"),
          /host/u,
        );
        assert.doesNotThrow(() =>
          core.assertWorkerCommand("git commit -m 'pi and codepunk notes'"),
        );
        assert.throws(
          () =>
            core.assertWorkerArgv(["node", "/opt/pi-coding-agent/index.js"]),
          /host/u,
        );
        assert.throws(() => core.assertWorkerArgv(["/tmp/codepunk"]), /host/u);
        await assert.rejects(
          () => sandbox.execArgv(["codepunk", "doctor"], worktree.path),
          /host/u,
        );
        assert.throws(() => sandbox.assertHostLaunchToken("short"), /token/u);
        assert.doesNotThrow(() => sandbox.assertHostLaunchToken(sandbox.token));

        const sandboxModule = pathToFileURL(
          path.resolve("packages/core/src/workers/sandbox.ts"),
        ).href;
        const fdChild = (expected) => `
import { readHostLaunchToken } from ${JSON.stringify(sandboxModule)};
try {
  const token = readHostLaunchToken(3);
  readHostLaunchToken(4);
  if (token !== ${JSON.stringify(expected)}) {
    console.error("worker.depth_token_mismatch");
    process.exit(3);
  }
  process.stdout.write(JSON.stringify({
    token,
    env: process.env.CODEPUNK_DEPTH ?? null
  }));
} catch (error) {
  console.error(error.code + ":" + error.message);
  process.exit(2);
}
`;
        const guarded = core.spawnGuardedHost({
          argv: [
            process.execPath,
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            fdChild(sandbox.token),
          ],
          cwd: worktree.path,
          token: sandbox.token,
          env: { ...process.env, CODEPUNK_DEPTH: "forged" },
        });
        const guardedResult = await runGuarded(guarded, "matching token");
        assert.equal(guardedResult.code, 0, guardedResult.stderr);
        assert.deepEqual(JSON.parse(guardedResult.stdout), {
          token: sandbox.token,
          env: "forged",
        });
        assert.doesNotMatch(
          `${guardedResult.stdout}${guardedResult.stderr}`,
          /CODEPUNK_DEPTH=/u,
        );

        const strippedEnv = { ...process.env };
        delete strippedEnv.CODEPUNK_DEPTH;
        const stripped = core.spawnGuardedHost({
          argv: [
            process.execPath,
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            fdChild(sandbox.token),
          ],
          cwd: worktree.path,
          token: sandbox.token,
          env: strippedEnv,
        });
        const strippedResult = await runGuarded(stripped, "env -u");
        assert.equal(strippedResult.code, 0, strippedResult.stderr);
        assert.equal(JSON.parse(strippedResult.stdout).env, null);

        const wrong = core.spawnGuardedHost({
          argv: [
            process.execPath,
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            fdChild(sandbox.token),
          ],
          cwd: worktree.path,
          token: "0".repeat(32),
        });
        const wrongResult = await runGuarded(wrong, "wrong token");
        assert.equal(wrongResult.code, 3);
        assert.match(wrongResult.stderr, /depth_token_mismatch/u);

        const missing = await runProcess(
          process.execPath,
          [
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            fdChild(sandbox.token),
          ],
          { cwd: worktree.path },
        );
        assert.equal(missing.code, 2);
        assert.match(missing.stderr, /worker\.depth_token_missing/u);

        const cli = await ensureBuilt();
        const guardedHome = path.join(root, "guarded-home");
        const cliEnv = {
          ...process.env,
          CODEPUNK_HOME: guardedHome,
          CODEPUNK_DEPTH: "forged",
        };
        const cliToken = "ab".repeat(16);
        const guardedCli = await runGuardedCli(
          cli,
          ["--guarded-host-launch", "--version"],
          {
            cwd: worktree.path,
            env: cliEnv,
            token: cliToken,
            expectedToken: cliToken,
          },
        );
        assert.equal(guardedCli.code, 0, guardedCli.stderr);
        assert.match(
          guardedCli.stdout,
          new RegExp(
            `^codepunk ${escapeRegExp(PRODUCT_VERSION)}\\nentry: .+\\nbuilt: .+\\nsource: .+\\n$`,
            "u",
          ),
        );
        assert.doesNotMatch(
          `${guardedCli.stdout}${guardedCli.stderr}`,
          /ababab/u,
        );

        const forgedCli = await runGuardedCli(
          cli,
          ["--guarded-host-launch", "doctor"],
          {
            cwd: worktree.path,
            env: cliEnv,
            token: "cd".repeat(16),
            expectedToken: cliToken,
          },
        );
        assert.equal(forgedCli.code, 1);
        assert.match(forgedCli.stderr, /does not match/u);
        await assert.rejects(
          () => fs.access(path.join(guardedHome, "projects.json")),
          /ENOENT/u,
        );

        const absentCli = await runProcess(
          process.execPath,
          [cli, "--guarded-host-launch", "doctor"],
          { cwd: worktree.path, env: cliEnv },
        );
        assert.equal(absentCli.code, 1);
        assert.match(absentCli.stderr, /missing from fd 3/u);

        const copiedHost = path.join(worktree.path, "agent-copy");
        await fs.writeFile(
          copiedHost,
          "#!/usr/bin/env node\n// @earendil-works/pi-coding-agent\n",
          { mode: 0o755 },
        );
        await assert.rejects(
          () => sandbox.execArgv([copiedHost, "--version"], worktree.path),
          /copied or renamed/u,
        );
        const copiedModule = path.join(worktree.path, "agent-copy.mjs");
        await fs.writeFile(
          copiedModule,
          'export { createAgentSessionRuntime } from "@earendil-works/pi-coding-agent";\n',
        );
        await assert.rejects(
          () =>
            sandbox.execArgv(
              [process.execPath, copiedModule, "--version"],
              worktree.path,
            ),
          /copied or renamed/u,
        );

        for (const [target, content] of protectedGitTargets) {
          await writeFile(target, content);
        }
        for (const [target, content] of protectedGitTargets) {
          const write = await sandbox.execCommand(
            `printf altered >> ${JSON.stringify(target)}`,
            worktree.path,
          );
          assert.equal(
            await fs.readFile(target, "utf8"),
            content,
            write.output,
          );
        }
      } finally {
        await sandbox.close();
        await worktree.remove().catch(() => undefined);
      }
    });
  },
);
