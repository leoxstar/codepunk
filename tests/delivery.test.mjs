import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import {
  chainRecords,
  headOf,
  readRecord,
  RUN_ID,
  SESSION_ID,
} from "./support/fixtures.mjs";
import {
  makeProject,
  withTempDirectory,
  writeFile,
} from "./support/helpers.mjs";

const core = await importCore();
const execFileAsync = promisify(execFile);
const NOW = new Date("2026-11-13T01:00:00.000Z");

async function git(cwd, args) {
  return (
    await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout;
}

async function makeRepo(root, name = "project") {
  const project = path.join(root, name);
  await fs.mkdir(project);
  await git(project, ["init", "-q"]);
  await git(project, ["config", "user.email", "test@example.invalid"]);
  await git(project, ["config", "user.name", "Test User"]);
  await writeFile(path.join(project, "src", "app.txt"), "base\n");
  await writeFile(path.join(project, "README.md"), "readme\n");
  await writeFile(path.join(project, "AGENTS.md"), "instructions\n");
  await writeFile(path.join(project, ".gitignore"), ".codepunk/\n");
  await git(project, ["add", "."]);
  await git(project, ["commit", "-q", "-m", "base"]);
  const baseCommit = (await git(project, ["rev-parse", "HEAD"])).trim();
  const { paths } = await makeProject(root, name);
  const context = await core.findDeliveryRoot(project);
  const realPaths = core.projectPaths(context, paths.home);
  await core.ensureProjectRegistration(context, realPaths);
  await core.ensureProjectConfigDir(realPaths);
  return { project, baseCommit, paths: realPaths };
}

async function commitWorkerChange(worktree, relativePath, content, message) {
  await writeFile(path.join(worktree, relativePath), content);
  await git(worktree, ["add", "--", relativePath]);
  await git(worktree, ["commit", "-q", "-m", message]);
  return (await git(worktree, ["rev-parse", "HEAD"])).trim();
}

async function makeEvidence(paths, runId = RUN_ID) {
  const evidencePath = path.join(
    paths.evidenceDir,
    SESSION_ID,
    `${runId}.jsonl`,
  );
  const ledger = await core.EvidenceLedger.open(evidencePath);
  const record = await ledger.append(
    readRecord({ run_id: runId, session_id: SESSION_ID }),
  );
  return {
    evidencePath,
    head: core.evidenceRecordHash(record),
    record,
  };
}

function specFor(baseCommit, writeSet = ["src/"]) {
  return core.createTaskSpec({
    taskId: "TASK-1",
    title: "Update app",
    objective: "Change the app file",
    baseCommit,
    writeSet,
    acceptance: ["app file changes"],
    now: () => NOW,
  });
}

async function setupDelivery(root, writeSet = ["src/"], name = "project") {
  const { project, baseCommit, paths } = await makeRepo(root, name);
  const spec = specFor(baseCommit, writeSet);
  const worktree = await core.createDetachedWorktree({
    deliveryRoot: project,
    projectId: paths.projectId,
    workerId: "worker-a",
    baseCommit,
    tempRoot: path.join(root, "worktrees"),
  });
  await commitWorkerChange(
    worktree.path,
    "src/app.txt",
    "changed\n",
    "worker change",
  );
  const evidence = await makeEvidence(paths);
  const handoff = await core.createHandoff({
    spec,
    worktree: worktree.path,
    workerId: "worker-a",
    runId: RUN_ID,
    evidencePath: evidence.evidencePath,
    verdict: {
      verdict: "complete",
      sign_off_id: "sign-off-1",
      evidence_head: evidence.head,
    },
    now: () => NOW,
  });
  return { project, baseCommit, paths, spec, worktree, evidence, handoff };
}

test("a single worker merges by exact commit and verifies post-merge", async () => {
  await withTempDirectory("codepunk-delivery-", async (root) => {
    const delivery = await setupDelivery(root);
    assert.deepEqual(delivery.handoff.claim, {
      claim_id: null,
      fence: null,
      lease: null,
      acquired_at: null,
    });
    const record = await core.mergeHandoff({
      paths: delivery.paths,
      repoRoot: delivery.project,
      sourceWorktree: delivery.worktree.path,
      spec: delivery.spec,
      handoff: delivery.handoff,
      actor: "local-user",
      human: true,
      taskState: "review_passed",
      now: () => NOW,
    });
    assert.equal(record.handoff_head, delivery.handoff.head_commit);
    assert.equal(
      record.merge_commit,
      (await git(delivery.project, ["rev-parse", "HEAD"])).trim(),
    );
    assert.notEqual(record.merge_commit, delivery.handoff.head_commit);

    const verdict = {
      version: 1,
      run_id: RUN_ID,
      session_id: SESSION_ID,
      verdict: "complete",
      evidence_head: delivery.evidence.head,
      sign_off_id: "sign-off-post-merge",
      signed_verdict: "complete",
      coverage: "app-layer",
      reasons: [],
      computed_at: NOW.toISOString(),
      vcs: {
        commit: record.merge_commit,
        tree: record.tree,
        base_commit: delivery.baseCommit,
        merge_commit: record.merge_commit,
      },
    };
    const verified = await core.verifyPostMerge({
      repoRoot: delivery.project,
      spec: delivery.spec,
      handoff: delivery.handoff,
      record,
      run: {
        runId: RUN_ID,
        sessionId: SESSION_ID,
        evidencePath: delivery.evidence.evidencePath,
        verdict,
      },
    });
    assert.equal(verified.verdict, "complete");
    assert.deepEqual(verified.issues, []);

    const wrongCommit = await core.verifyPostMerge({
      repoRoot: delivery.project,
      spec: delivery.spec,
      handoff: delivery.handoff,
      record,
      run: {
        runId: RUN_ID,
        sessionId: SESSION_ID,
        evidencePath: delivery.evidence.evidencePath,
        verdict: {
          ...verdict,
          vcs: { ...verdict.vcs, commit: delivery.baseCommit },
        },
      },
    });
    assert.equal(wrongCommit.verdict, "unverifiable");
    assert.match(wrongCommit.issues.join(" "), /different commit/u);

    const wrongHandoffTree = await core.verifyPostMerge({
      repoRoot: delivery.project,
      spec: delivery.spec,
      handoff: { ...delivery.handoff, tree: "0".repeat(40) },
      record,
      run: {
        runId: RUN_ID,
        sessionId: SESSION_ID,
        evidencePath: delivery.evidence.evidencePath,
        verdict,
      },
    });
    assert.equal(wrongHandoffTree.verdict, "unverifiable");
    assert.match(wrongHandoffTree.issues.join(" "), /handoff tree/u);

    const wrongRunId = await core.verifyPostMerge({
      repoRoot: delivery.project,
      spec: delivery.spec,
      handoff: delivery.handoff,
      record,
      run: {
        runId: RUN_ID,
        sessionId: SESSION_ID,
        evidencePath: delivery.evidence.evidencePath,
        verdict: { ...verdict, run_id: "another-run" },
      },
    });
    assert.equal(wrongRunId.verdict, "unverifiable");
    assert.match(wrongRunId.issues.join(" "), /run id/u);
  });
});

test("no evidence, non-human merge, moved worktree, and base mismatch are rejected", async () => {
  await withTempDirectory("codepunk-delivery-negative-", async (root) => {
    const delivery = await setupDelivery(root);
    await assert.rejects(
      () =>
        core.createHandoff({
          spec: delivery.spec,
          worktree: delivery.worktree.path,
          workerId: "worker-a",
          runId: "other-run",
          evidencePath: path.join(root, "missing.jsonl"),
          verdict: {
            verdict: "complete",
            sign_off_id: "sign-off-1",
            evidence_head: delivery.evidence.head,
          },
        }),
      /requires evidence|invalid/u,
    );
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: delivery.paths,
          repoRoot: delivery.project,
          sourceWorktree: delivery.worktree.path,
          spec: delivery.spec,
          handoff: delivery.handoff,
          actor: "local-user",
          human: false,
          taskState: "review_passed",
        }),
      /human-only/u,
    );
    for (const taskState of [
      "queued",
      "claimed",
      "running",
      "submitted",
      "merged",
      "closed",
      "blocked",
      "failed",
      "abandoned",
    ]) {
      await assert.rejects(
        () =>
          core.mergeHandoff({
            paths: delivery.paths,
            repoRoot: delivery.project,
            sourceWorktree: delivery.worktree.path,
            spec: delivery.spec,
            handoff: delivery.handoff,
            actor: "local-user",
            human: true,
            taskState,
          }),
        /review_passed/u,
      );
    }
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: delivery.paths,
          repoRoot: delivery.project,
          sourceWorktree: delivery.worktree.path,
          spec: delivery.spec,
          handoff: delivery.handoff,
          actor: "local-user",
          human: true,
          taskState: undefined,
        }),
      /review_passed/u,
    );
    assert.equal(
      await fs
        .readdir(path.join(delivery.paths.projectDir, "merges"))
        .catch(() => null),
      null,
    );
    await commitWorkerChange(
      delivery.worktree.path,
      "src/app.txt",
      "moved\n",
      "moved after handoff",
    );
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: delivery.paths,
          repoRoot: delivery.project,
          sourceWorktree: delivery.worktree.path,
          spec: delivery.spec,
          handoff: delivery.handoff,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
        }),
      /moved after handoff/u,
    );
    const wrongBaseSpec = { ...delivery.spec, base_commit: "a".repeat(40) };
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: delivery.paths,
          repoRoot: delivery.project,
          sourceWorktree: delivery.worktree.path,
          spec: wrongBaseSpec,
          handoff: delivery.handoff,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
        }),
      /task spec|base|descend/u,
    );
  });
});

test("write-set and protected-path commits are rejected before merge", async () => {
  await withTempDirectory("codepunk-delivery-paths-", async (root) => {
    const outside = await setupDelivery(root, ["src/"]);
    await commitWorkerChange(
      outside.worktree.path,
      "README.md",
      "outside write set\n",
      "outside write set",
    );
    const outsideEvidence = await makeEvidence(outside.paths, "run-outside");
    const outsideHandoff = await core.createHandoff({
      spec: outside.spec,
      worktree: outside.worktree.path,
      workerId: "worker-a",
      runId: "run-outside",
      evidencePath: outsideEvidence.evidencePath,
      verdict: {
        verdict: "complete",
        sign_off_id: "sign-off-1",
        evidence_head: outsideEvidence.head,
      },
    });
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: outside.paths,
          repoRoot: outside.project,
          sourceWorktree: outside.worktree.path,
          spec: outside.spec,
          handoff: outsideHandoff,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
        }),
      /outside the write set/u,
    );

    const protectedDelivery = await setupDelivery(
      root,
      ["AGENTS.md"],
      "protected-project",
    );
    await commitWorkerChange(
      protectedDelivery.worktree.path,
      "AGENTS.md",
      "protected change\n",
      "protected change",
    );
    const protectedEvidence = await makeEvidence(
      protectedDelivery.paths,
      "run-protected",
    );
    const protectedHandoff = await core.createHandoff({
      spec: protectedDelivery.spec,
      worktree: protectedDelivery.worktree.path,
      workerId: "worker-a",
      runId: "run-protected",
      evidencePath: protectedEvidence.evidencePath,
      verdict: {
        verdict: "complete",
        sign_off_id: "sign-off-1",
        evidence_head: protectedEvidence.head,
      },
    });
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: protectedDelivery.paths,
          repoRoot: protectedDelivery.project,
          sourceWorktree: protectedDelivery.worktree.path,
          spec: protectedDelivery.spec,
          handoff: protectedHandoff,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
        }),
      /protected path/u,
    );
  });
});

test("handoff trees, diff hashes, and evidence chains are enforced", async () => {
  await withTempDirectory("codepunk-delivery-integrity-", async (root) => {
    const delivery = await setupDelivery(root);
    const badTree = {
      ...delivery.handoff,
      tree: "0".repeat(40),
    };
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: delivery.paths,
          repoRoot: delivery.project,
          sourceWorktree: delivery.worktree.path,
          spec: delivery.spec,
          handoff: badTree,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
        }),
      /tree does not match/u,
    );
    const droppedPaths = {
      ...delivery.handoff,
      changed_paths: [],
    };
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: delivery.paths,
          repoRoot: delivery.project,
          sourceWorktree: delivery.worktree.path,
          spec: delivery.spec,
          handoff: droppedPaths,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
        }),
      /changed paths do not match/u,
    );
    const droppedFiles = {
      ...delivery.handoff,
      files: [],
    };
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: delivery.paths,
          repoRoot: delivery.project,
          sourceWorktree: delivery.worktree.path,
          spec: delivery.spec,
          handoff: droppedFiles,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
        }),
      /file list does not match/u,
    );
    const mismatchedEvidenceHead = {
      ...delivery.handoff,
      verdict: {
        ...delivery.handoff.verdict,
        evidence_head: `sha256:${"0".repeat(64)}`,
      },
    };
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: delivery.paths,
          repoRoot: delivery.project,
          sourceWorktree: delivery.worktree.path,
          spec: delivery.spec,
          handoff: mismatchedEvidenceHead,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
        }),
      /evidence chain does not match/u,
    );
    const forged = {
      ...delivery.handoff,
      files: delivery.handoff.files.map((file, index) =>
        index === 0
          ? { ...file, after_sha256: headOf(chainRecords([readRecord()])) }
          : file,
      ),
    };
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: delivery.paths,
          repoRoot: delivery.project,
          sourceWorktree: delivery.worktree.path,
          spec: delivery.spec,
          handoff: forged,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
        }),
      /file hash mismatch/u,
    );
    const badDiff = {
      ...delivery.handoff,
      diff_sha256: "sha256:" + "0".repeat(64),
    };
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: delivery.paths,
          repoRoot: delivery.project,
          sourceWorktree: delivery.worktree.path,
          spec: delivery.spec,
          handoff: badDiff,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
        }),
      /diff hash/u,
    );
    const noSignoff = {
      ...delivery.handoff,
      verdict: { ...delivery.handoff.verdict, sign_off_id: null },
    };
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: delivery.paths,
          repoRoot: delivery.project,
          sourceWorktree: delivery.worktree.path,
          spec: delivery.spec,
          handoff: noSignoff,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
        }),
      /human sign-off/u,
    );
  });
});

test("TaskGraph rejects invalid transitions and worktrees preserve commits", async () => {
  await withTempDirectory("codepunk-delivery-graph-", async (root) => {
    const { baseCommit, paths, project } = await makeRepo(root);
    const spec = specFor(baseCommit);
    assert.deepEqual(spec.protected_paths, [
      "AGENTS.override.md",
      "AGENTS.md",
      "AGENTS.MD",
      "CLAUDE.md",
      "CLAUDE.MD",
      ".codepunk/",
    ]);
    const graph = new core.TaskGraph({ now: () => NOW });
    graph.add(spec);
    assert.equal(graph.get(spec.task_id).state, "queued");
    graph.transition(spec.task_id, "claimed");
    graph.transition(spec.task_id, "running");
    assert.throws(
      () => graph.transition(spec.task_id, "merged"),
      /invalid task transition/u,
    );

    const worktree = await core.createDetachedWorktree({
      deliveryRoot: project,
      projectId: paths.projectId,
      workerId: "worker-b",
      baseCommit,
      tempRoot: path.join(root, "worktrees"),
    });
    assert.equal((await fs.stat(worktree.path)).mode & 0o777, 0o700);
    const linkedContext = await core.findDeliveryRoot(worktree.path);
    assert.equal(linkedContext.deliveryRoot, await fs.realpath(worktree.path));
    assert.equal(linkedContext.isGitRepository, true);
    assert.notEqual(linkedContext.projectId, paths.projectId);
    assert.equal(linkedContext.projectId, core.projectIdFor(worktree.path));
    await commitWorkerChange(
      worktree.path,
      "src/app.txt",
      "preserved\n",
      "work",
    );
    await assert.rejects(() => worktree.remove(), /worker commits/u);
  });
});

test("review, branch refs, evidence tampering, and merge records are enforced", async () => {
  await withTempDirectory("codepunk-delivery-records-", async (root) => {
    const delivery = await setupDelivery(root);
    const incomplete = {
      ...delivery.handoff,
      verdict: { ...delivery.handoff.verdict, value: "incomplete" },
    };
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: delivery.paths,
          repoRoot: delivery.project,
          sourceWorktree: delivery.worktree.path,
          spec: delivery.spec,
          handoff: incomplete,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
        }),
      /review-passed/u,
    );
    const branchRef = {
      ...delivery.handoff,
      head_commit: "refs/heads/main",
    };
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: delivery.paths,
          repoRoot: delivery.project,
          sourceWorktree: delivery.worktree.path,
          spec: delivery.spec,
          handoff: branchRef,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
        }),
      /moved after handoff|commit id/u,
    );

    const original = await fs.readFile(delivery.evidence.evidencePath, "utf8");
    await fs.appendFile(delivery.evidence.evidencePath, '{"partial":');
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: delivery.paths,
          repoRoot: delivery.project,
          sourceWorktree: delivery.worktree.path,
          spec: delivery.spec,
          handoff: delivery.handoff,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
        }),
      /truncated tail/u,
    );
    await fs.writeFile(delivery.evidence.evidencePath, original);

    const lines = original.trim().split("\n");
    const first = JSON.parse(lines[0]);
    first.output_preview = "tampered";
    await fs.writeFile(
      delivery.evidence.evidencePath,
      `${JSON.stringify(first)}\n`,
    );
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: delivery.paths,
          repoRoot: delivery.project,
          sourceWorktree: delivery.worktree.path,
          spec: delivery.spec,
          handoff: delivery.handoff,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
        }),
      /prev_sha256|evidence|hash/u,
    );
    await fs.writeFile(delivery.evidence.evidencePath, original);

    const record = await core.mergeHandoff({
      paths: delivery.paths,
      repoRoot: delivery.project,
      sourceWorktree: delivery.worktree.path,
      spec: delivery.spec,
      handoff: delivery.handoff,
      actor: "local-user",
      human: true,
      taskState: "review_passed",
      now: () => NOW,
    });
    const postEvidence = await makeEvidence(delivery.paths, "run-post-merge");
    const postVerdict = {
      version: 1,
      run_id: "run-post-merge",
      session_id: SESSION_ID,
      verdict: "complete",
      evidence_head: postEvidence.head,
      sign_off_id: "sign-off-post",
      signed_verdict: "complete",
      coverage: "enforced",
      reasons: [],
      computed_at: NOW.toISOString(),
      vcs: {
        commit: record.merge_commit,
        tree: record.tree,
        base_commit: delivery.baseCommit,
        merge_commit: record.merge_commit,
      },
    };
    const verified = await core.verifyPostMerge({
      repoRoot: delivery.project,
      spec: delivery.spec,
      handoff: delivery.handoff,
      record,
      paths: delivery.paths,
      run: {
        runId: "run-post-merge",
        sessionId: SESSION_ID,
        evidencePath: postEvidence.evidencePath,
        verdict: postVerdict,
      },
    });
    assert.equal(verified.verdict, "complete");

    const recordPath = path.join(
      delivery.paths.projectDir,
      "merges",
      delivery.spec.task_id,
      `${record.merge_id}.json`,
    );
    const stored = await fs.readFile(recordPath, "utf8");
    await fs.writeFile(
      recordPath,
      `${JSON.stringify({ ...record, tree: "0".repeat(40) })}\n`,
    );
    const mismatched = await core.verifyPostMerge({
      repoRoot: delivery.project,
      spec: delivery.spec,
      handoff: delivery.handoff,
      record,
      paths: delivery.paths,
      run: {
        runId: "run-post-merge",
        sessionId: SESSION_ID,
        evidencePath: postEvidence.evidencePath,
        verdict: postVerdict,
      },
    });
    assert.equal(mismatched.verdict, "unverifiable");
    assert.match(mismatched.issues.join(" "), /on disk/u);
    await fs.writeFile(recordPath, stored);

    await fs.writeFile(
      recordPath,
      `${JSON.stringify({ ...record, actor: "someone-else" })}\n`,
    );
    const actorTampered = await core.verifyPostMerge({
      repoRoot: delivery.project,
      spec: delivery.spec,
      handoff: delivery.handoff,
      record,
      paths: delivery.paths,
      run: {
        runId: "run-post-merge",
        sessionId: SESSION_ID,
        evidencePath: postEvidence.evidencePath,
        verdict: postVerdict,
      },
    });
    assert.equal(actorTampered.verdict, "unverifiable");
    assert.match(actorTampered.issues.join(" "), /on disk/u);
    await fs.writeFile(recordPath, stored);

    await fs.unlink(recordPath);
    const missing = await core.verifyPostMerge({
      repoRoot: delivery.project,
      spec: delivery.spec,
      handoff: delivery.handoff,
      record,
      paths: delivery.paths,
      run: {
        runId: "run-post-merge",
        sessionId: SESSION_ID,
        evidencePath: postEvidence.evidencePath,
        verdict: postVerdict,
      },
    });
    assert.equal(missing.verdict, "unverifiable");
    assert.match(missing.issues.join(" "), /missing or unreadable/u);
  });
});
