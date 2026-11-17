import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import {
  canCreateFileSymlink,
  createDirectoryLink,
  makeProject,
  withTempDirectory,
  writeFile,
} from "./support/helpers.mjs";

const core = await importCore();

// The policy layer resolves every path against the platform, so the
// expectation has to be built from the same absolute path the product sees.
const WORKSPACE = path.resolve("/workspace");
const CODEPUNK_HOME = path.resolve("/workspace/.codepunk-home");

function request(overrides = {}) {
  return {
    tool: "read",
    args: { path: "src/a.ts" },
    cwd: WORKSPACE,
    workspaceRoot: WORKSPACE,
    deliveryRoot: WORKSPACE,
    codepunkHome: CODEPUNK_HOME,
    ...overrides,
  };
}

test("read inside the workspace is allowed", () => {
  const decision = core.decidePolicy(request());
  assert.equal(decision.decision, "allow");
  assert.equal(decision.match.path, path.join(WORKSPACE, "src", "a.ts"));
});

test("search defaults to the workspace and still rejects explicit escapes", () => {
  const implicit = core.decidePolicy(
    request({
      tool: "search",
      args: {},
    }),
  );
  assert.equal(implicit.decision, "allow");
  assert.equal(implicit.match.path, WORKSPACE);

  const explicit = core.decidePolicy(
    request({
      tool: "search",
      args: { path: "/etc/passwd" },
    }),
  );
  assert.equal(explicit.decision, "deny");
  assert.match(explicit.reason, /outside the workspace/u);
});

test("an unknown action falls back to deny, not allow", () => {
  const decision = core.decidePolicy(
    request({
      tool: "browser",
      args: {},
      userDefault: "ask",
      projectDefault: "ask",
    }),
  );
  assert.equal(decision.decision, "deny");
  assert.equal(decision.rule, "policy.default");
});

test("a path escape is denied", () => {
  const decision = core.decidePolicy(
    request({ args: { path: "../outside.txt" } }),
  );
  assert.equal(decision.decision, "deny");
  assert.match(decision.reason, /outside the workspace/u);
});

test("symlinks cannot escape the workspace", async () => {
  await withTempDirectory("codepunk-policy-symlink-", async (root) => {
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    const home = path.join(root, "home");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    await fs.mkdir(home);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret\n");
    await fs.writeFile(path.join(workspace, "inside.txt"), "inside\n");
    await createDirectoryLink(outside, path.join(workspace, "escape"));
    const fileSymlinks = await canCreateFileSymlink();
    if (fileSymlinks) {
      await fs.symlink(
        path.join(workspace, "inside.txt"),
        path.join(workspace, "alias.txt"),
      );
    }
    const base = {
      cwd: workspace,
      workspaceRoot: workspace,
      deliveryRoot: workspace,
      codepunkHome: home,
    };
    const read = core.decidePolicy({
      ...base,
      tool: "read",
      args: { path: "escape/secret.txt" },
    });
    assert.equal(read.decision, "deny");
    assert.match(read.reason, /symlink outside the workspace/u);

    const write = core.decidePolicy({
      ...base,
      tool: "write",
      args: { path: "escape/new.txt" },
      writeSet: ["."],
    });
    assert.equal(write.decision, "deny");
    assert.match(write.reason, /symlink outside the workspace/u);

    if (fileSymlinks) {
      const inside = core.decidePolicy({
        ...base,
        tool: "read",
        args: { path: "alias.txt" },
      });
      assert.equal(inside.decision, "allow");
    }
  });
});

test("a broad allow cannot suppress a sensitive path ask", () => {
  const decision = core.decidePolicy(
    request({
      args: { path: ".env" },
      userRules: [{ id: "allow-all", tool: "*", decision: "allow", path: "." }],
    }),
  );
  assert.equal(decision.decision, "ask");
  assert.match(decision.reason, /sensitive path/u);
});

test("instruction writes ask interactively and deny headless", () => {
  const interactive = core.decidePolicy(
    request({
      tool: "write",
      args: { path: "AGENTS.md" },
      writeSet: ["."],
      userDefault: "allow",
    }),
  );
  assert.equal(interactive.decision, "ask");
  assert.match(interactive.reason, /instruction or configuration/u);

  const headless = core.decidePolicy(
    request({
      tool: "write",
      args: { path: "AGENTS.md" },
      writeSet: ["."],
      mode: "headless",
      userDefault: "allow",
    }),
  );
  assert.equal(headless.decision, "deny");

  const worker = core.decidePolicy(
    request({
      tool: "write",
      args: { path: "AGENTS.md" },
      writeSet: ["."],
      mode: "worker",
      userDefault: "allow",
    }),
  );
  assert.equal(worker.decision, "deny");
  assert.match(worker.reason, /instruction or configuration/u);

  const workerConfig = core.decidePolicy(
    request({
      tool: "write",
      args: { path: ".codepunk/config.toml" },
      writeSet: ["."],
      mode: "worker",
      userDefault: "allow",
    }),
  );
  assert.equal(workerConfig.decision, "deny");

  for (const path of [
    "AGENTS.override.md",
    "AGENTS.MD",
    "CLAUDE.md",
    "CLAUDE.MD",
    "claude.md",
    "agents.override.md",
  ]) {
    const decision = core.decidePolicy(
      request({
        tool: "write",
        args: { path },
        writeSet: ["."],
        userDefault: "allow",
      }),
    );
    assert.equal(decision.decision, "ask", path);
    assert.match(decision.reason, /instruction or configuration/u);
  }
});

test("a write outside the write set is denied", () => {
  const decision = core.decidePolicy(
    request({
      tool: "write",
      args: { path: "src/a.ts" },
      writeSet: ["tests/"],
      userDefault: "allow",
    }),
  );
  assert.equal(decision.decision, "deny");
  assert.match(decision.reason, /outside the write set/u);
});

test("a project allow cannot widen a user deny floor", () => {
  const decision = core.decidePolicy(
    request({
      tool: "bash",
      command: "ls",
      userRules: [{ id: "user-deny", tool: "bash", decision: "deny" }],
      projectRules: [{ id: "project-allow", tool: "bash", decision: "allow" }],
    }),
  );
  assert.equal(decision.decision, "deny");
});

test("project policy cannot widen the user write set", async () => {
  await withTempDirectory("codepunk-policy-floor-", async (root) => {
    const { paths } = await makeProject(root);
    await writeFile(
      path.join(paths.home, "policy.toml"),
      ["version = 1", 'write_set = ["src/"]', ""].join("\n"),
    );
    await writeFile(
      path.join(paths.projectConfigDir, "policy.toml"),
      ["version = 1", 'write_set = ["src/", "tests/"]', ""].join("\n"),
    );
    await assert.rejects(
      () => core.loadPolicyFiles(paths),
      /cannot widen the user write set/u,
    );

    await writeFile(
      path.join(paths.projectConfigDir, "policy.toml"),
      ["version = 1", 'write_set = ["src/lib/"]', ""].join("\n"),
    );
    const narrowed = await core.loadPolicyFiles(paths);
    assert.deepEqual(narrowed.writeSet, ["src/lib/"]);

    await writeFile(
      path.join(paths.projectConfigDir, "policy.toml"),
      ["version = 1", ""].join("\n"),
    );
    const inherited = await core.loadPolicyFiles(paths);
    assert.deepEqual(inherited.writeSet, ["src/"]);
  });
});

test("a project ask narrows a user allow", () => {
  const decision = core.decidePolicy(
    request({
      userRules: [{ id: "user-allow", tool: "read", decision: "allow" }],
      projectRules: [{ id: "project-ask", tool: "read", decision: "ask" }],
    }),
  );
  assert.equal(decision.decision, "ask");
});

test("explicit policy asks survive auto mode and identify their rule", async () => {
  const decision = core.decidePolicy(
    request({
      tool: "bash",
      command: "date +%A",
      userDefault: "allow",
      projectRules: [
        {
          id: "project-clock-review",
          tool: "bash",
          decision: "ask",
        },
      ],
    }),
  );
  assert.equal(decision.decision, "ask");
  assert.equal(decision.approval_class, "policy");
  assert.equal(decision.rule, "project-clock-review");
  assert.match(decision.reason, /policy rule project-clock-review/u);
  const auto = await core.resolvePermissionGate({
    policy: decision,
    autonomy: null,
    approvalMode: "auto",
    tool: "bash",
    command: "date +%A",
    cwd: WORKSPACE,
  });
  assert.equal(auto.decision, "ask");
  assert.equal(auto.requires_approval, true);
  const blanket = await core.resolvePermissionGate({
    policy: decision,
    autonomy: null,
    approvalMode: "allow",
    tool: "bash",
    command: "date +%A",
    cwd: WORKSPACE,
  });
  assert.equal(blanket.decision, "allow");

  const denied = core.decidePolicy(
    request({
      args: { path: "src/a.ts" },
      userRules: [
        {
          id: "user-read-deny",
          tool: "read",
          decision: "deny",
        },
      ],
    }),
  );
  assert.equal(denied.decision, "deny");
  assert.equal(denied.rule, "user-read-deny");
  assert.match(denied.reason, /policy rule user-read-deny/u);
});

test("shell redirects to protected paths ask or deny", () => {
  const interactive = core.decidePolicy(
    request({
      tool: "bash",
      command: "echo changed > AGENTS.md",
      userDefault: "allow",
    }),
  );
  assert.equal(interactive.decision, "ask");
  assert.match(interactive.reason, /instruction or configuration/u);

  const headless = core.decidePolicy(
    request({
      tool: "bash",
      command: "echo changed > AGENTS.md",
      mode: "headless",
      userDefault: "allow",
    }),
  );
  assert.equal(headless.decision, "deny");
});

test("sed -i on a sensitive file asks", () => {
  const decision = core.decidePolicy(
    request({
      tool: "bash",
      command: "sed -i 's/a/b/' .env",
      userDefault: "allow",
    }),
  );
  assert.equal(decision.decision, "ask");
  assert.match(decision.reason, /sensitive path/u);
});

test("mutating shell commands outside the write set are denied", () => {
  const decision = core.decidePolicy(
    request({
      tool: "bash",
      command: "cp src/a.ts ../outside.ts",
      writeSet: ["src/"],
      userDefault: "allow",
    }),
  );
  assert.equal(decision.decision, "deny");
  assert.match(decision.reason, /outside the workspace/u);
});

test("dangerous shell commands are denied before approval", () => {
  const decision = core.decidePolicy(
    request({
      tool: "bash",
      command: "rm -rf /",
      userDefault: "allow",
    }),
  );
  assert.equal(decision.decision, "deny");
  assert.equal(decision.rule, "shell.dangerous");
});

test("auto mode keeps destructive shell at the approval gate", async () => {
  for (const command of [
    "rm -rf build",
    "rm build/output.txt",
    "mv src/a.ts src/b.ts",
    "chmod -R 777 src",
    "sed -i 's/a/b/' src/a.ts",
    "truncate -s 0 src/a.ts",
    "git reset --hard",
    "git clean -fd",
    "git branch -D topic",
    "git push --force",
    "git push origin main",
    "echo ok | cat",
    "date +%A > clock.txt",
  ]) {
    const policy = core.decidePolicy(
      request({
        tool: "bash",
        command,
        writeSet: ["."],
        userDefault: "allow",
      }),
    );
    assert.equal(policy.decision, "ask", command);
    assert.equal(policy.approval_class, "destructive", command);
    const auto = await core.resolvePermissionGate({
      policy,
      autonomy: null,
      approvalMode: "auto",
      tool: "bash",
      command,
      cwd: WORKSPACE,
    });
    assert.equal(auto.decision, "ask", command);
    assert.equal(auto.requires_approval, true, command);
    const blanket = await core.resolvePermissionGate({
      policy,
      autonomy: null,
      approvalMode: "allow",
      tool: "bash",
      command,
      cwd: WORKSPACE,
    });
    assert.equal(blanket.decision, "allow", command);
  }

  const routine = core.decidePolicy(
    request({
      tool: "bash",
      command: "date +%A",
      userDefault: "allow",
    }),
  );
  assert.equal(routine.approval_class, "routine");
  const autoRoutine = await core.resolvePermissionGate({
    policy: routine,
    autonomy: null,
    approvalMode: "auto",
    tool: "bash",
    command: "date +%A",
    cwd: WORKSPACE,
  });
  assert.equal(autoRoutine.decision, "allow");

  const simpleMutation = core.decidePolicy(
    request({
      tool: "bash",
      command: "mkdir build",
      writeSet: ["."],
      userDefault: "allow",
    }),
  );
  assert.equal(simpleMutation.approval_class, "shell");
  const autoMutation = await core.resolvePermissionGate({
    policy: simpleMutation,
    autonomy: null,
    approvalMode: "auto",
    tool: "bash",
    command: "mkdir build",
    cwd: WORKSPACE,
  });
  assert.equal(autoMutation.decision, "allow");
});

test("auto mode keeps network and package-index commands at the approval gate", async () => {
  for (const command of [
    "curl https://example.com",
    "wget https://example.com/file.tgz",
    "ssh example.com",
    "git fetch origin",
    "git pull --ff-only",
    "git clone https://example.com/repo.git",
    "npm install",
    "pnpm add left-pad",
    "yarn install",
    "pip install requests",
    "cargo install ripgrep",
    "brew install jq",
    "docker pull alpine",
  ]) {
    const policy = core.decidePolicy(
      request({
        tool: "bash",
        command,
        writeSet: ["."],
        userDefault: "allow",
      }),
    );
    assert.equal(policy.decision, "ask", command);
    assert.equal(policy.approval_class, "network", command);
    const auto = await core.resolvePermissionGate({
      policy,
      autonomy: null,
      approvalMode: "auto",
      tool: "bash",
      command,
      cwd: WORKSPACE,
    });
    assert.equal(auto.decision, "ask", command);
    assert.equal(auto.requires_approval, true, command);
    const blanket = await core.resolvePermissionGate({
      policy,
      autonomy: null,
      approvalMode: "allow",
      tool: "bash",
      command,
      cwd: WORKSPACE,
    });
    assert.equal(blanket.decision, "allow", command);
  }

  for (const command of ["git remote -v", "git submodule status"]) {
    const policy = core.decidePolicy(
      request({
        tool: "bash",
        command,
        writeSet: ["."],
        userDefault: "allow",
      }),
    );
    assert.notEqual(policy.approval_class, "network", command);
    assert.equal(policy.decision, "ask", command);
  }
});

test("auto mode keeps dynamic launchers and interpreters at the approval gate", async () => {
  for (const command of [
    "python3 -c 'print(open(\"/etc/hosts\").read())'",
    'node -e \'require("fs").writeFileSync("probe.txt", "x")\'',
    "sh -c 'echo ok'",
    "env node -e 'process.exit(0)'",
    "xargs -0 echo",
    "osascript -e 'return 1'",
  ]) {
    const policy = core.decidePolicy(
      request({
        tool: "bash",
        command,
        writeSet: ["."],
        userDefault: "allow",
      }),
    );
    assert.equal(policy.decision, "ask", command);
    assert.equal(policy.approval_class, "dynamic", command);
    const auto = await core.resolvePermissionGate({
      policy,
      autonomy: null,
      approvalMode: "auto",
      tool: "bash",
      command,
      cwd: WORKSPACE,
    });
    assert.equal(auto.decision, "ask", command);
    assert.equal(auto.requires_approval, true, command);
    const blanket = await core.resolvePermissionGate({
      policy,
      autonomy: null,
      approvalMode: "allow",
      tool: "bash",
      command,
      cwd: WORKSPACE,
    });
    assert.equal(blanket.decision, "allow", command);
  }
});

test("shell parsing cannot hide mutation in quoted or chained segments", () => {
  for (const command of [
    "echo ok\nchmod +x AGENTS.md",
    'echo "$(chmod +x AGENTS.md)"',
    'echo "`chmod +x AGENTS.md`"',
    "find . -name AGENTS.md -delete",
    "find . -exec chmod +x {} \\;",
    "rg --pre 'chmod +x AGENTS.md' pattern .",
    "cat <(rm -rf /tmp/codepunk-policy)",
    "cat >(rm -rf /tmp/codepunk-policy)",
  ]) {
    const decision = core.decidePolicy(
      request({
        tool: "bash",
        command,
        writeSet: ["."],
        userDefault: "allow",
      }),
    );
    assert.equal(decision.decision, "ask", command);
    assert.match(decision.reason, /shell structure/u, command);
  }
  const git = core.decidePolicy(
    request({
      tool: "bash",
      command: "git -C /tmp status",
      userDefault: "allow",
    }),
  );
  assert.equal(git.decision, "ask");
  const literal = core.decidePolicy(
    request({
      tool: "bash",
      command: 'echo "\\$(date)"',
      userDefault: "allow",
    }),
  );
  // cmd.exe does not use a backslash to escape `$`, so a `$(` in the raw
  // command stays a substitution candidate and the conservative answer is
  // an approval request rather than an unconditional allow.
  assert.equal(
    literal.decision,
    process.platform === "win32" ? "ask" : "allow",
  );
});

test("environment queries are read-only but clock and hostname writes ask", () => {
  for (const command of [
    "date",
    "date +%A",
    "date -u +%A",
    "date -Iseconds",
    "date -j -f %Y-%m-%d 2026-11-14 +%A",
    "date -d 'next monday' +%A",
    "date --date='next monday' +%A",
    "TZ=Asia/Shanghai date +%A",
    "LC_TIME=zh_CN.UTF-8 date +%A",
    "LANG=C date +%A",
    "uname -a",
    "whoami",
    "hostname -f",
    "id -u",
    "sw_vers",
  ]) {
    const decision = core.decidePolicy(
      request({ tool: "bash", command, userDefault: "allow" }),
    );
    assert.equal(decision.decision, "allow", command);
    assert.match(decision.reason, /read-only shell/u, command);
  }
  for (const command of [
    "date -s 2026-11-15",
    "date -us20261115",
    "date -su20261115",
    "date --set=2026-11-15",
    "date --set 2026-11-15",
    "date 111409302026",
    "date -Z +%A",
    "date --file=/etc/passwd",
    "date -f /etc/passwd",
    "date --reference=/etc/passwd",
    "date -r /etc/passwd",
    "LD_PRELOAD=/tmp/unsafe.so date +%A",
    "PATH=/tmp date +%A",
    "FOO=bar date +%A",
    "hostname new-name",
  ]) {
    const decision = core.decidePolicy(
      request({ tool: "bash", command, userDefault: "allow" }),
    );
    assert.equal(decision.decision, "ask", command);
    assert.match(decision.reason, /not in a known safe class/u, command);
  }
});

test("null-device redirection asks without becoming a path denial", () => {
  for (const command of [
    "date +%A 2>/dev/null",
    "date +%A >/dev/null",
    "date +%A 2>>/dev/null",
  ]) {
    const decision = core.decidePolicy(
      request({ tool: "bash", command, userDefault: "allow" }),
    );
    assert.equal(decision.decision, "ask", command);
    assert.equal(decision.rule, "shell.complex", command);
  }

  const outside = core.decidePolicy(
    request({
      tool: "bash",
      command: "date +%A 2>/tmp/codepunk-policy.log",
      userDefault: "allow",
    }),
  );
  assert.equal(outside.decision, "deny");
  assert.match(outside.reason, /outside the workspace/u);

  const direct = core.decidePolicy(
    request({
      tool: "bash",
      command: "touch /dev/null",
      userDefault: "allow",
    }),
  );
  assert.equal(direct.decision, "deny");
  assert.match(direct.reason, /outside the workspace/u);
});

test("common workspace inspection commands stay read-only without approval", () => {
  for (const command of [
    "git status",
    "git status --short --branch",
    "git status -sb",
    "git diff --stat",
    "git diff --stat --",
    "git diff --name-only --cached",
    "git log --oneline -5",
    "git branch --show-current",
    "git rev-parse HEAD",
    "git ls-files",
    "git grep TODO",
    "stat package.json",
    "file README.md",
    "tree .",
    "du -sh .",
    "which git",
  ]) {
    const decision = core.decidePolicy(
      request({ tool: "bash", command, userDefault: "allow" }),
    );
    assert.equal(decision.decision, "allow", command);
    assert.match(decision.reason, /read-only shell/u, command);
  }

  for (const command of [
    "git -C /tmp status",
    "git status -- /etc/passwd",
    "git diff --stat /etc/passwd",
    "git branch -D main",
    "git diff --ext-diff --stat",
    "git grep TODO src",
    "tree -o tree.txt",
    "tree --fromfile",
    "file -C",
    "file --files-from list.txt",
    "du --files0-from list.txt",
    "tail -f log.txt",
    "git status; touch probe.txt",
    "rg needle | head",
  ]) {
    const decision = core.decidePolicy(
      request({ tool: "bash", command, userDefault: "allow" }),
    );
    assert.equal(decision.decision, "ask", command);
  }
  const outside = core.decidePolicy(
    request({
      tool: "bash",
      command: "stat /etc/passwd",
      userDefault: "allow",
    }),
  );
  assert.equal(outside.decision, "deny");
});

test("read-only shell commands cannot read outside the workspace", () => {
  for (const command of [
    "cat /etc/passwd",
    "head -n 5 /etc/hosts",
    "tail /etc/hosts",
    "find / -name passwd",
    "find . -fprint0 out",
    "rg needle /etc",
    "rg --files /etc",
    "rg -f /etc/passwd .",
    "ls /tmp",
  ]) {
    const decision = core.decidePolicy(
      request({ tool: "bash", command, userDefault: "allow" }),
    );
    if (command === "find . -fprint0 out") {
      assert.equal(decision.decision, "ask", command);
      assert.match(decision.reason, /shell structure/u, command);
    } else {
      assert.equal(decision.decision, "deny", command);
      assert.match(decision.reason, /outside the workspace/u, command);
    }
  }

  for (const command of ["rg --files src", "rg -f patterns.txt ."]) {
    const decision = core.decidePolicy(
      request({ tool: "bash", command, userDefault: "allow" }),
    );
    assert.equal(decision.decision, "allow", command);
    assert.match(decision.reason, /read-only shell/u, command);
  }

  const home = core.decidePolicy(
    request({
      tool: "bash",
      command: "cat ~/.aws/credentials",
      userDefault: "allow",
    }),
  );
  assert.equal(home.decision, "deny");
  assert.match(home.reason, /outside the workspace/u);
});

test("read-only shell commands protect sensitive and dynamic paths", () => {
  for (const command of [
    "cat .env",
    "rg needle .env",
    "cat $HOME/src/secret.txt",
    "cat '*.pem'",
  ]) {
    const decision = core.decidePolicy(
      request({ tool: "bash", command, userDefault: "allow" }),
    );
    assert.equal(decision.decision, "ask", command);
  }

  const local = core.decidePolicy(
    request({
      tool: "bash",
      command: "rg needle src",
      userDefault: "allow",
    }),
  );
  assert.equal(local.decision, "allow");
});

test("sed long-form in-place edits still hit path protection", () => {
  const decision = core.decidePolicy(
    request({
      tool: "bash",
      command: "sed --in-place 's/a/b/' .env",
      userDefault: "allow",
    }),
  );
  assert.equal(decision.decision, "ask");
  assert.match(decision.reason, /sensitive path/u);

  for (const command of [
    "sed -i 's/a/b/' harmless .env",
    "sed -i 's/a/b/' .env harmless",
    "sed -i -e 's/a/b/' .env harmless",
  ]) {
    const multiTarget = core.decidePolicy(
      request({
        tool: "bash",
        command,
        writeSet: ["."],
        userDefault: "allow",
      }),
    );
    assert.equal(multiTarget.decision, "ask", command);
    assert.match(multiTarget.reason, /sensitive path/u, command);
  }
});

test("headless exec requires an exact argv rule", async () => {
  const base = request({
    tool: "exec",
    args: undefined,
    command: undefined,
    mode: "headless",
    userRules: [
      {
        id: "exact-echo",
        tool: "exec",
        decision: "allow",
        argv: ["/bin/echo", "ok"],
      },
    ],
  });
  const accepted = core.decidePolicy({
    ...base,
    argv: ["/bin/echo", "ok"],
  });
  assert.equal(accepted.decision, "allow");

  const changed = core.decidePolicy({
    ...base,
    argv: ["/bin/echo", "changed"],
  });
  assert.equal(changed.decision, "deny");

  for (const approvalMode of ["ask", "auto"]) {
    const unapproved = core.decidePolicy({
      ...base,
      approvalMode,
      userRules: [],
      argv: ["/bin/echo", "ok"],
    });
    assert.equal(unapproved.decision, "deny", approvalMode);
  }
  const blanket = core.decidePolicy({
    ...base,
    approvalMode: "allow",
    userRules: [],
    argv: ["/bin/echo", "ok"],
  });
  assert.equal(blanket.decision, "ask");
  const blanketGate = await core.resolvePermissionGate({
    policy: blanket,
    autonomy: null,
    approvalMode: "allow",
    tool: "exec",
    argv: ["/bin/echo", "ok"],
    cwd: WORKSPACE,
  });
  assert.equal(blanketGate.decision, "allow");
});

test("headless sessions honor pre-approval instead of denying every ask", async () => {
  const decide = (command, approvalMode, overrides = {}) =>
    core.decidePolicy(
      request({
        tool: "bash",
        command,
        mode: "headless",
        approvalMode,
        writeSet: ["."],
        userDefault: "allow",
        ...overrides,
      }),
    );
  const gate = (policy, approvalMode, command) =>
    core.resolvePermissionGate({
      policy,
      autonomy: null,
      approvalMode,
      tool: "bash",
      command,
      cwd: WORKSPACE,
    });

  const routine = decide("mkdir build", "auto");
  assert.equal(routine.decision, "ask");
  const routineGate = await gate(routine, "auto", "mkdir build");
  assert.equal(routineGate.decision, "allow");
  assert.equal(routineGate.requires_approval, false);

  for (const command of [
    "rm -rf build",
    "git push origin main",
    "curl https://example.com",
  ]) {
    const refused = decide(command, "auto");
    assert.equal(refused.decision, "deny", command);
    const refusedGate = await gate(refused, "auto", command);
    assert.equal(refusedGate.decision, "deny", command);
  }

  const blanket = decide("rm -rf build", "allow");
  assert.equal(blanket.decision, "ask");
  const blanketGate = await gate(blanket, "allow", "rm -rf build");
  assert.equal(blanketGate.decision, "allow");

  const standard = decide("mkdir build", "ask");
  assert.equal(standard.decision, "deny");
  const standardGate = await gate(standard, "ask", "mkdir build");
  assert.equal(standardGate.decision, "deny");

  const readOnly = decide("mkdir build", "allow", { autonomy: "read-only" });
  assert.equal(readOnly.decision, "deny");
  const readOnlyGate = await gate(readOnly, "allow", "mkdir build");
  assert.equal(readOnlyGate.decision, "deny");
});

test("unknown tools, MCP approval, and worker memory search are denied", () => {
  assert.equal(
    core.decidePolicy(
      request({
        tool: "browser",
        args: {},
        userDefault: "allow",
      }),
    ).decision,
    "deny",
  );
  assert.equal(
    core.decidePolicy(
      request({
        tool: "memory_search",
        args: { query: "x" },
        mode: "worker",
        userDefault: "allow",
      }),
    ).decision,
    "deny",
  );
  assert.equal(
    core.decidePolicy(
      request({
        tool: "memory_search",
        args: { query: "x" },
        userDefault: "allow",
      }),
    ).decision,
    "allow",
  );
  assert.equal(
    core.decidePolicy(
      request({
        tool: "mcp__echo__echo",
        args: {},
        mode: "interactive",
        userDefault: "allow",
      }),
    ).decision,
    "ask",
  );
  for (const mode of ["headless", "worker"]) {
    assert.equal(
      core.decidePolicy(
        request({
          tool: "mcp__echo__echo",
          args: {},
          mode,
          userDefault: "allow",
        }),
      ).decision,
      "deny",
    );
  }
  for (const tool of [
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
  ]) {
    const interactive = core.decidePolicy(
      request({
        tool,
        args: { server: "echo", uri: "echo://greeting" },
        mode: "interactive",
        userDefault: "allow",
      }),
    );
    assert.equal(interactive.decision, "ask", tool);
    assert.equal(interactive.rule, "mcp.resource.ask", tool);
    for (const mode of ["headless", "worker"]) {
      assert.equal(
        core.decidePolicy(
          request({
            tool,
            args: { server: "echo", uri: "echo://greeting" },
            mode,
            userDefault: "allow",
          }),
        ).decision,
        "deny",
        `${tool} in ${mode}`,
      );
    }
  }
});

test("codepunk state is never readable through file tools", () => {
  const homeState = core.decidePolicy(
    request({
      args: {
        path: "/workspace/.codepunk-home/projects/p/sessions/s/session.jsonl",
      },
      userRules: [{ id: "allow-all", tool: "*", decision: "allow", path: "/" }],
    }),
  );
  assert.equal(homeState.decision, "deny");
  assert.match(homeState.reason, /codepunk home/u);

  const projectState = core.decidePolicy(
    request({
      args: { path: ".codepunk/policy.toml" },
      userRules: [{ id: "allow-all", tool: "*", decision: "allow", path: "." }],
    }),
  );
  assert.equal(projectState.decision, "deny");
  assert.match(projectState.reason, /project codepunk state/u);
});

test("git metadata cannot be written and reads need approval", () => {
  for (const candidate of [
    ".git/hooks/pre-commit",
    ".git/config",
    ".git/config.worktree",
    ".git/info/exclude",
  ]) {
    const write = core.decidePolicy(
      request({
        tool: "write",
        args: { path: candidate, content: "probe\n" },
        writeSet: ["."],
        userDefault: "allow",
        userRules: [
          { id: "allow-all", tool: "*", decision: "allow", path: "." },
        ],
      }),
    );
    assert.equal(write.decision, "deny", candidate);
    assert.match(write.reason, /git metadata/u, candidate);
    assert.equal(write.approval_class, "protected", candidate);

    const edit = core.decidePolicy(
      request({
        tool: "edit",
        args: { path: candidate, edits: [] },
        writeSet: ["."],
        userDefault: "allow",
      }),
    );
    assert.equal(edit.decision, "deny", candidate);

    const redirect = core.decidePolicy(
      request({
        tool: "bash",
        command: `echo probe > ${candidate}`,
        writeSet: ["."],
        userDefault: "allow",
      }),
    );
    assert.equal(redirect.decision, "deny", candidate);
    assert.match(redirect.reason, /git metadata/u, candidate);

    const read = core.decidePolicy(
      request({ args: { path: candidate }, userDefault: "allow" }),
    );
    assert.equal(read.decision, "ask", candidate);
    assert.match(read.reason, /git metadata/u, candidate);
  }

  const hooksRead = core.decidePolicy(
    request({
      tool: "bash",
      command: "cat .git/hooks/pre-commit",
      userDefault: "allow",
    }),
  );
  assert.equal(hooksRead.decision, "ask");
  assert.match(hooksRead.reason, /git metadata/u);
});

test("git config writes stay at the auto-mode approval gate", async () => {
  for (const command of [
    "git config core.hooksPath .githooks",
    "git config --global core.pager less",
    "git config --unset core.hooksPath",
  ]) {
    const policy = core.decidePolicy(
      request({
        tool: "bash",
        command,
        writeSet: ["."],
        userDefault: "allow",
      }),
    );
    assert.equal(policy.decision, "ask", command);
    assert.equal(policy.approval_class, "destructive", command);
    const auto = await core.resolvePermissionGate({
      policy,
      autonomy: null,
      approvalMode: "auto",
      tool: "bash",
      command,
      cwd: WORKSPACE,
    });
    assert.equal(auto.decision, "ask", command);
  }

  for (const command of [
    "git config --get core.hooksPath",
    "git config --list",
    "git config -l",
  ]) {
    const policy = core.decidePolicy(
      request({
        tool: "bash",
        command,
        userDefault: "allow",
      }),
    );
    assert.equal(policy.decision, "ask", command);
    assert.notEqual(policy.approval_class, "destructive", command);
    const auto = await core.resolvePermissionGate({
      policy,
      autonomy: null,
      approvalMode: "auto",
      tool: "bash",
      command,
      cwd: WORKSPACE,
    });
    assert.equal(auto.decision, "allow", command);
  }
});

test("coverage is reported per surface", () => {
  assert.equal(core.coverageFor("bash", "allow"), "enforced");
  assert.equal(core.coverageFor("bash", "ask"), "uncovered");
  assert.equal(core.coverageFor("read", "allow"), "app-layer");
});

test("rule hashes are canonical", () => {
  assert.equal(
    core.policyRuleHash({ id: "a", tool: "*", decision: "allow" }),
    core.policyRuleHash({ decision: "allow", tool: "*", id: "a" }),
  );
});

test(
  "Windows absolute arguments keep their path separators",
  {
    skip: process.platform !== "win32",
  },
  () => {
    const argument = String.raw`C:\work\example\extra\a.txt`;
    assert.deepEqual(core.simpleShellArgv(`cat ${argument}`), [
      "cat",
      argument,
    ]);
  },
);
