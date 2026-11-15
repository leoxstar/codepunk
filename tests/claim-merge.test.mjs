import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import {
  makeProject,
  withTempDirectory,
  writeFile,
} from "./support/helpers.mjs";
import { readRecord, RUN_ID, SESSION_ID } from "./support/fixtures.mjs";

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

test("a stale claim or mismatched fence cannot merge", async () => {
  await withTempDirectory("codepunk-claim-merge-", async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await git(project, ["init", "-q"]);
    await git(project, ["config", "user.email", "test@example.invalid"]);
    await git(project, ["config", "user.name", "Test User"]);
    await writeFile(path.join(project, ".gitignore"), ".codepunk/\n");
    await writeFile(path.join(project, "src", "app.txt"), "base\n");
    await git(project, ["add", "."]);
    await git(project, ["commit", "-q", "-m", "base"]);
    const baseCommit = (await git(project, ["rev-parse", "HEAD"])).trim();
    const { paths } = await makeProject(root);
    const context = await core.findDeliveryRoot(project);
    const realPaths = core.projectPaths(context, paths.home);
    await core.ensureProjectRegistration(context, realPaths);
    await core.ensureProjectConfigDir(realPaths);
    const spec = core.createTaskSpec({
      taskId: "claim-task",
      title: "Claim task",
      objective: "Test claim admission",
      baseCommit,
      writeSet: ["src/"],
      acceptance: ["done"],
      budget: { maxWallMs: 60_000, maxToolCalls: 20, maxDiskBytes: 10_000 },
    });
    const worktree = await core.createDetachedWorktree({
      deliveryRoot: project,
      projectId: realPaths.projectId,
      workerId: "worker-claim",
      baseCommit,
      tempRoot: path.join(root, "worktrees"),
    });
    await writeFile(path.join(worktree.path, "src", "app.txt"), "changed\n");
    await git(worktree.path, ["add", "src/app.txt"]);
    await git(worktree.path, ["commit", "-q", "-m", "change"]);
    const evidencePath = path.join(
      realPaths.evidenceDir,
      SESSION_ID,
      `${RUN_ID}.jsonl`,
    );
    const ledger = await core.EvidenceLedger.open(evidencePath);
    const evidence = await ledger.append(
      readRecord({ run_id: RUN_ID, session_id: SESSION_ID }),
    );
    const head = core.evidenceRecordHash(evidence);
    let now = new Date("2026-11-13T04:00:00.000Z");
    const claimStore = new core.ClaimStore({
      paths: realPaths,
      leaseMs: 1_000,
      now: () => new Date(now),
    });
    const claim = await claimStore.acquire("claim-task", "worker-claim");
    const handoff = await core.createHandoff({
      spec,
      worktree: worktree.path,
      workerId: "worker-claim",
      runId: RUN_ID,
      evidencePath,
      verdict: {
        verdict: "complete",
        sign_off_id: "sign-off-claim",
        evidence_head: head,
      },
      claim: {
        claim_id: claim.claim_id,
        fence: claim.fence,
        lease: null,
        acquired_at: claim.acquired_at,
      },
    });
    now = new Date("2026-11-13T04:00:02.000Z");
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: realPaths,
          repoRoot: project,
          sourceWorktree: worktree.path,
          spec,
          handoff,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
          claimStore,
          claim: { ...claim, fence: claim.fence + 1 },
        }),
      /does not match the merge claim/u,
    );
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: realPaths,
          repoRoot: project,
          sourceWorktree: worktree.path,
          spec,
          handoff,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
        }),
      /live claim/u,
    );
    await assert.rejects(
      () =>
        core.mergeHandoff({
          paths: realPaths,
          repoRoot: project,
          sourceWorktree: worktree.path,
          spec,
          handoff,
          actor: "local-user",
          human: true,
          taskState: "review_passed",
          claimStore,
          claim,
        }),
      /stale/u,
    );
  });
});
