import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importSource } from "./support/core.mjs";

const diffModule = await importSource("packages/core/src/ops/diff.ts");
const reviewModule = await importSource(
  "packages/core/src/reviewer/structured.ts",
);

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function withRepository(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepunk-review-"));
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    await writeFile(
      path.join(root, "tracked.txt"),
      "one\ntwo\nthree\nfour\nfive\n",
    );
    await writeFile(path.join(root, "other.txt"), "unchanged\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "base"]);
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function stageAndModify(root) {
  const tracked = path.join(root, "tracked.txt");
  await writeFile(tracked, "one\ntwo staged\nthree\nfour\nfive\n");
  git(root, ["add", "tracked.txt"]);
  await writeFile(tracked, "one\ntwo staged\nthree\nfour unstaged\nfive\n");
  await mkdir(path.join(root, "notes"));
  await writeFile(path.join(root, "notes", "new.txt"), "alpha\nbeta\ngamma\n");
}

function findings() {
  return [
    {
      severity: "high",
      file: "tracked.txt",
      line: 2,
      reason: "staged regression",
    },
    {
      severity: "medium",
      file: "tracked.txt",
      line: 4,
      reason: "unstaged regression",
    },
    {
      severity: "low",
      file: "notes/new.txt",
      line: 3,
      reason: "untracked issue",
    },
  ];
}

function lineRangesFor(snapshot, file) {
  return snapshot.line_ranges.find((entry) => entry.path === file)?.ranges;
}

test("real git snapshot yields a deterministic bound structured review", async () => {
  await withRepository(async (root) => {
    await stageAndModify(root);
    const snapshot = await diffModule.readWorkspaceDiffSnapshot({ root });
    assert.deepEqual(snapshot.changed_paths, ["notes/new.txt", "tracked.txt"]);
    assert.match(snapshot.staged, /two staged/u);
    assert.match(snapshot.unstaged, /four unstaged/u);
    assert.equal(snapshot.untracked.length, 1);
    assert.equal(snapshot.untracked[0].path, "notes/new.txt");
    assert.match(snapshot.untracked[0].content, /alpha\nbeta\ngamma/u);
    assert.deepEqual(lineRangesFor(snapshot, "notes/new.txt"), [[1, 3]]);

    let appended = null;
    const review = await reviewModule.createStructuredReview(snapshot, {
      session_id: "session-0010",
      run_id: "run-0010",
      findings: findings(),
      review_id: "review-0010",
      now: () => new Date("2026-01-02T03:04:05.000Z"),
      append: (value) => {
        appended = value;
      },
    });

    assert.equal(appended, review);
    assert.equal(review.review_id, "review-0010");
    assert.equal(review.session_id, "session-0010");
    assert.equal(review.run_id, "run-0010");
    assert.equal(review.created_at, "2026-01-02T03:04:05.000Z");
    assert.equal(
      review.diff_sha256,
      diffModule.workspaceDiffSnapshotSha256(snapshot),
    );
    assert.match(review.diff_sha256, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(review.changed_paths, snapshot.changed_paths);
    assert.deepEqual(
      review.findings.map((finding) => finding.severity),
      ["high", "medium", "low"],
    );
    for (const forbidden of ["action", "apply", "fix"]) {
      assert.equal(Object.hasOwn(review, forbidden), false, forbidden);
    }
    assert.doesNotThrow(() =>
      reviewModule.validateStructuredReview(review, snapshot, {
        session_id: "session-0010",
        run_id: "run-0010",
      }),
    );

    const reread = await diffModule.readWorkspaceDiffSnapshot({ root });
    assert.equal(
      diffModule.workspaceDiffSnapshotSha256(reread),
      review.diff_sha256,
    );
    assert.deepEqual(reread, snapshot);
  });
});

test("a mutated diff or stale hash rejects the old review", async () => {
  await withRepository(async (root) => {
    await stageAndModify(root);
    const snapshot = await diffModule.readWorkspaceDiffSnapshot({ root });
    const review = await reviewModule.createStructuredReview(snapshot, {
      session_id: "session-a",
      run_id: "run-a",
      findings: findings(),
    });
    assert.throws(
      () =>
        reviewModule.validateStructuredReview(review, snapshot, {
          session_id: "session-b",
        }),
      /session_id/u,
    );

    const tampered = structuredClone(snapshot);
    tampered.unstaged += "\n# tampered\n";
    assert.throws(
      () => reviewModule.validateStructuredReview(review, tampered),
      /diff_sha256/u,
    );

    const oldHash = {
      ...review,
      diff_sha256: `sha256:${"0".repeat(64)}`,
    };
    assert.throws(
      () => reviewModule.validateStructuredReview(oldHash, snapshot),
      /diff_sha256/u,
    );
    let appended = false;
    await assert.rejects(
      () =>
        reviewModule.appendStructuredReview(oldHash, snapshot, () => {
          appended = true;
        }),
      /diff_sha256/u,
    );
    assert.equal(appended, false);

    await writeFile(
      path.join(root, "tracked.txt"),
      "one\ntwo staged\nthree\nfour unstaged\nfive\nsix\n",
    );
    const changed = await diffModule.readWorkspaceDiffSnapshot({ root });
    assert.throws(
      () => reviewModule.validateStructuredReview(review, changed),
      /diff_sha256/u,
    );
  });
});

test(
  "a retargeted untracked symlink invalidates the old review",
  { skip: process.platform === "win32" ? "POSIX symlink target" : false },
  async () => {
    await withRepository(async (root) => {
      await writeFile(path.join(root, "target-one"), "one\n");
      await writeFile(path.join(root, "target-two"), "two\n");
      const link = path.join(root, "link");
      await symlink("target-one", link);

      const first = await diffModule.readWorkspaceDiffSnapshot({ root });
      const review = await reviewModule.createStructuredReview(first, {
        session_id: "session-link",
        run_id: "run-link",
        findings: [],
      });
      const linked = first.untracked.find((file) => file.path === "link");
      assert.equal(linked.kind, "symlink");
      assert.equal(linked.link_target, "target-one");
      assert.match(linked.sha256, /^sha256:[0-9a-f]{64}$/u);

      await unlink(link);
      await symlink("target-two", link);
      const second = await diffModule.readWorkspaceDiffSnapshot({ root });
      assert.notEqual(
        diffModule.workspaceDiffSnapshotSha256(first),
        diffModule.workspaceDiffSnapshotSha256(second),
      );
      assert.throws(
        () => reviewModule.validateStructuredReview(review, second),
        /diff_sha256/u,
      );
    });
  },
);

test(
  "a symlink target with non-UTF-8 bytes remains bound to its raw bytes",
  { skip: process.platform === "win32" ? "POSIX symlink target" : false },
  async () => {
    await withRepository(async (root) => {
      const link = path.join(root, "raw-link");
      await symlink(Buffer.from([0x80, 0x41]), link);

      const first = await diffModule.readWorkspaceDiffSnapshot({ root });
      const review = await reviewModule.createStructuredReview(first, {
        session_id: "session-raw-link",
        run_id: "run-raw-link",
        findings: [],
      });
      const linked = first.untracked.find((file) => file.path === "raw-link");
      assert.equal(linked.kind, "symlink");
      assert.equal(linked.size, 2);
      assert.match(linked.sha256, /^sha256:[0-9a-f]{64}$/u);

      await unlink(link);
      await symlink(Buffer.from([0x81, 0x41]), link);
      const second = await diffModule.readWorkspaceDiffSnapshot({ root });
      assert.notEqual(
        diffModule.workspaceDiffSnapshotSha256(first),
        diffModule.workspaceDiffSnapshotSha256(second),
      );
      assert.throws(
        () => reviewModule.validateStructuredReview(review, second),
        /diff_sha256/u,
      );
    });
  },
);

test(
  "an untracked file type change invalidates the old review",
  { skip: process.platform === "win32" ? "POSIX symlink target" : false },
  async () => {
    await withRepository(async (root) => {
      await writeFile(path.join(root, "target-one"), "one\n");
      const item = path.join(root, "item");
      await writeFile(item, "target-one");

      const first = await diffModule.readWorkspaceDiffSnapshot({ root });
      const review = await reviewModule.createStructuredReview(first, {
        session_id: "session-type",
        run_id: "run-type",
        findings: [],
      });
      const fileEntry = first.untracked.find((file) => file.path === "item");
      assert.equal(fileEntry.kind, "file");

      await unlink(item);
      await symlink("target-one", item);
      const second = await diffModule.readWorkspaceDiffSnapshot({ root });
      const linkEntry = second.untracked.find((file) => file.path === "item");
      assert.equal(linkEntry.kind, "symlink");
      // The file bytes and the link target bytes are identical, so only the
      // recorded file type and link metadata can distinguish the two states.
      assert.equal(fileEntry.sha256, linkEntry.sha256);
      assert.notEqual(
        diffModule.workspaceDiffSnapshotSha256(first),
        diffModule.workspaceDiffSnapshotSha256(second),
      );
      assert.throws(
        () => reviewModule.validateStructuredReview(review, second),
        /diff_sha256/u,
      );
    });
  },
);

test("invalid UTF-8 byte changes invalidate the old review", async () => {
  await withRepository(async (root) => {
    const file = path.join(root, "invalid-bytes.bin");
    await writeFile(file, Buffer.from([0x80, 0x0a]));
    const first = await diffModule.readWorkspaceDiffSnapshot({ root });
    const review = await reviewModule.createStructuredReview(first, {
      session_id: "session-bytes",
      run_id: "run-bytes",
      findings: [],
    });

    await writeFile(file, Buffer.from([0x81, 0x0a]));
    const second = await diffModule.readWorkspaceDiffSnapshot({ root });
    assert.notEqual(
      diffModule.workspaceDiffSnapshotSha256(first),
      diffModule.workspaceDiffSnapshotSha256(second),
    );
    assert.throws(
      () => reviewModule.validateStructuredReview(review, second),
      /diff_sha256/u,
    );
  });
});

test("tracked non-UTF-8 byte changes invalidate the old review", async () => {
  await withRepository(async (root) => {
    const file = path.join(root, "tracked.txt");
    await writeFile(file, Buffer.from([0x80, 0x0a]));
    const first = await diffModule.readWorkspaceDiffSnapshot({ root });
    const review = await reviewModule.createStructuredReview(first, {
      session_id: "session-tracked-bytes",
      run_id: "run-tracked-bytes",
      findings: [],
    });

    await writeFile(file, Buffer.from([0x81, 0x0a]));
    const second = await diffModule.readWorkspaceDiffSnapshot({ root });
    assert.notEqual(
      diffModule.workspaceDiffSnapshotSha256(first),
      diffModule.workspaceDiffSnapshotSha256(second),
    );
    assert.throws(
      () => reviewModule.validateStructuredReview(review, second),
      /diff_sha256/u,
    );
  });
});

test("a truncated snapshot cannot produce a bound review", async () => {
  await withRepository(async (root) => {
    await writeFile(path.join(root, "large.txt"), "x".repeat(1_000));
    const snapshot = await diffModule.readWorkspaceDiffSnapshot({
      root,
      maxBytes: 64,
    });
    assert.equal(snapshot.truncated, true);
    await assert.rejects(
      () =>
        reviewModule.createStructuredReview(snapshot, {
          session_id: "session-truncated",
          run_id: "run-truncated",
          findings: [],
        }),
      /truncated/u,
    );
  });
});

test("create, validate, and append all reject a truncated snapshot", async () => {
  await withRepository(async (root) => {
    await stageAndModify(root);
    const snapshot = await diffModule.readWorkspaceDiffSnapshot({ root });
    const review = await reviewModule.createStructuredReview(snapshot, {
      session_id: "session-truncated-all",
      run_id: "run-truncated-all",
      findings: [],
    });
    const truncated = { ...structuredClone(snapshot), truncated: true };

    assert.throws(
      () => reviewModule.validateStructuredReview(review, truncated),
      /truncated/u,
    );

    let appended = false;
    await assert.rejects(
      () =>
        reviewModule.appendStructuredReview(review, truncated, () => {
          appended = true;
        }),
      /truncated/u,
    );
    assert.equal(appended, false);

    let created = false;
    await assert.rejects(
      () =>
        reviewModule.createStructuredReview(truncated, {
          session_id: "session-truncated-all",
          run_id: "run-truncated-all",
          findings: [],
          append: () => {
            created = true;
          },
        }),
      /truncated/u,
    );
    assert.equal(created, false);
  });
});

test("missing, unknown, unsafe, and out-of-range findings fail closed", async () => {
  await withRepository(async (root) => {
    await stageAndModify(root);
    const snapshot = await diffModule.readWorkspaceDiffSnapshot({ root });
    const invalidFindings = [
      ["missing severity", { file: "tracked.txt", line: 2, reason: "x" }],
      ["missing file", { severity: "high", line: 2, reason: "x" }],
      ["missing reason", { severity: "high", file: "tracked.txt", line: 2 }],
      [
        "unknown property",
        {
          severity: "high",
          file: "tracked.txt",
          line: 2,
          reason: "x",
          action: "apply",
        },
      ],
      [
        "unknown severity",
        { severity: "blocker", file: "tracked.txt", line: 2, reason: "x" },
      ],
      [
        "absolute path",
        { severity: "high", file: "/etc/passwd", line: 1, reason: "x" },
      ],
      [
        "traversal",
        { severity: "high", file: "../outside.txt", line: 1, reason: "x" },
      ],
      [
        "backslash",
        { severity: "high", file: "src\\main.ts", line: 1, reason: "x" },
      ],
      [
        "line zero",
        { severity: "high", file: "tracked.txt", line: 0, reason: "x" },
      ],
      [
        "out-of-scope path",
        { severity: "high", file: "other.txt", line: 1, reason: "x" },
      ],
      [
        "out-of-range tracked line",
        { severity: "high", file: "tracked.txt", line: 99, reason: "x" },
      ],
      [
        "out-of-range untracked line",
        { severity: "high", file: "notes/new.txt", line: 4, reason: "x" },
      ],
    ];
    for (const [name, finding] of invalidFindings) {
      await assert.rejects(
        reviewModule.createStructuredReview(snapshot, {
          session_id: "session-a",
          run_id: "run-a",
          findings: [finding],
        }),
        (error) => {
          assert.ok(
            error instanceof reviewModule.StructuredReviewValidationError,
            `${name}: ${String(error)}`,
          );
          return true;
        },
        name,
      );
    }
  });
});

test("validate rejects malformed findings independently of create", async () => {
  await withRepository(async (root) => {
    await stageAndModify(root);
    const snapshot = await diffModule.readWorkspaceDiffSnapshot({ root });
    const review = await reviewModule.createStructuredReview(snapshot, {
      session_id: "session-v",
      run_id: "run-v",
      findings: findings(),
    });

    for (const field of [
      "version",
      "review_id",
      "session_id",
      "run_id",
      "diff_sha256",
      "changed_paths",
      "findings",
      "created_at",
    ]) {
      const incomplete = structuredClone(review);
      delete incomplete[field];
      assert.throws(
        () => reviewModule.validateStructuredReview(incomplete, snapshot),
        (error) =>
          error instanceof reviewModule.StructuredReviewValidationError,
        `missing ${field}`,
      );
    }

    const missingSeverity = structuredClone(review);
    delete missingSeverity.findings[0].severity;
    assert.throws(
      () => reviewModule.validateStructuredReview(missingSeverity, snapshot),
      /severity|invalid/u,
    );

    const unknownSeverity = structuredClone(review);
    unknownSeverity.findings[0].severity = "blocker";
    assert.throws(
      () => reviewModule.validateStructuredReview(unknownSeverity, snapshot),
      /severity|invalid/u,
    );

    const nonIntegerLine = structuredClone(review);
    nonIntegerLine.findings[0].line = 1.5;
    assert.throws(
      () => reviewModule.validateStructuredReview(nonIntegerLine, snapshot),
      /line|integer|invalid/u,
    );

    const outOfScope = structuredClone(review);
    outOfScope.findings = [
      { severity: "high", file: "other.txt", line: 1, reason: "x" },
    ];
    assert.throws(
      () => reviewModule.validateStructuredReview(outOfScope, snapshot),
      /outside the changed paths/u,
    );

    const outOfRange = structuredClone(review);
    outOfRange.findings = [
      { severity: "high", file: "tracked.txt", line: 99, reason: "x" },
    ];
    assert.throws(
      () => reviewModule.validateStructuredReview(outOfRange, snapshot),
      /real hunk/u,
    );
  });
});

test("byte caps are enforced and truncation is explicit", async () => {
  await withRepository(async (root) => {
    await stageAndModify(root);
    await writeFile(path.join(root, "big.txt"), "x".repeat(1_000));
    const snapshot = await diffModule.readWorkspaceDiffSnapshot({
      root,
      maxBytes: 64,
    });
    assert.equal(snapshot.truncated, true);
    assert.ok(Buffer.byteLength(snapshot.staged, "utf8") <= 64);
    assert.ok(Buffer.byteLength(snapshot.unstaged, "utf8") <= 64);
    const big = snapshot.untracked.find((file) => file.path === "big.txt");
    assert.ok(big);
    assert.equal(big.truncated, true);
    assert.ok(big.included_bytes <= 64);
    const total = snapshot.untracked.reduce(
      (sum, file) => sum + file.included_bytes,
      0,
    );
    assert.ok(total <= 64);
  });
});

test("non-ASCII paths with spaces still map to reviewable hunks", async () => {
  await withRepository(async (root) => {
    const name = "说明 文件.txt";
    const file = path.join(root, name);
    await writeFile(file, "第一行\n第二行\n");
    git(root, ["add", name]);
    git(root, ["commit", "-qm", "unicode"]);
    await writeFile(file, "第一行\n第二行改\n");

    const snapshot = await diffModule.readWorkspaceDiffSnapshot({ root });
    assert.deepEqual(snapshot.changed_paths, [name]);
    assert.match(snapshot.unstaged, /第二行改/u);
    assert.equal(
      lineRangesFor(snapshot, name)?.some(
        ([start, end]) => 2 >= start && 2 <= end,
      ),
      true,
    );

    const review = await reviewModule.createStructuredReview(snapshot, {
      session_id: "session-unicode",
      run_id: "run-unicode",
      findings: [
        { severity: "info", file: name, line: 2, reason: "unicode path" },
      ],
    });
    assert.equal(review.findings[0].file, name);
  });
});

test("prototype-shaped file names stay data, not object keys", async () => {
  await withRepository(async (root) => {
    const name = "__proto__";
    const file = path.join(root, name);
    await writeFile(file, "one\ntwo\n");
    git(root, ["add", name]);
    git(root, ["commit", "-qm", "prototype name"]);
    await writeFile(file, "one\nchanged\n");

    const snapshot = await diffModule.readWorkspaceDiffSnapshot({ root });
    assert.equal(snapshot.changed_paths.includes(name), true);
    assert.deepEqual(lineRangesFor(snapshot, name), [[1, 2]]);
    const review = await reviewModule.createStructuredReview(snapshot, {
      session_id: "session-proto",
      run_id: "run-proto",
      findings: [
        { severity: "high", file: name, line: 2, reason: "prototype path" },
      ],
    });
    assert.equal(review.findings[0].file, name);
    assert.equal(Object.getPrototypeOf(review), Object.prototype);
  });
});

test("external diff helpers and hooks are never executed", async () => {
  await withRepository(async (root) => {
    const marker = path.join(root, ".executed");
    const script = path.join(root, "external-diff.sh");
    const command = `#!/bin/sh\nprintf ran >> ${JSON.stringify(marker)}\nexit 0\n`;
    await writeFile(script, command);
    await chmod(script, 0o755);
    git(root, ["config", "diff.external", script]);
    await writeFile(path.join(root, ".gitattributes"), "*.txt diff=evil\n");
    git(root, ["config", "diff.evil.command", script]);
    git(root, ["config", "diff.evil.textconv", script]);

    const hooks = path.join(root, ".hooks");
    await mkdir(hooks);
    const hook = path.join(hooks, "post-index-change");
    await writeFile(hook, command);
    await chmod(hook, 0o755);
    git(root, ["config", "core.hooksPath", hooks]);

    await stageAndModify(root);
    await rm(marker, { force: true });
    await diffModule.readWorkspaceDiffSnapshot({ root });
    await assert.rejects(readFile(marker, "utf8"), /ENOENT/u);
  });
});
