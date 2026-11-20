import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import {
  createLinkedEntry,
  makeProject,
  withTempDirectory,
} from "./support/helpers.mjs";

const core = await importCore();
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const SECOND_PNG = Buffer.concat([PNG, Buffer.from([0x01])]);

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function targetFor(directory, bytes) {
  const id = digest(bytes).slice("sha256:".length, "sha256:".length + 24);
  return path.join(directory, `${id}.png`);
}

test("image input requires confirmation and validates type and size", async () => {
  await withTempDirectory("codepunk-images-", async (root) => {
    const { projectRoot } = await makeProject(root);
    const imagePath = path.join(projectRoot, "pixel.png");
    await fs.writeFile(imagePath, PNG);
    await assert.rejects(
      core.confirmImageInput({
        path: path.join(projectRoot, "missing.png"),
        allowedRoot: projectRoot,
        confirmed: false,
        assertAllowed() {},
      }),
      (error) => error.code === "image.confirmation_required",
    );
    await assert.rejects(
      core.confirmImageInput({
        path: imagePath,
        allowedRoot: projectRoot,
        confirmed: "false",
        assertAllowed() {},
      }),
      (error) => error.code === "image.confirmation_required",
    );
    await assert.rejects(
      core.confirmImageInput({
        path: imagePath,
        allowedRoot: projectRoot,
        confirmed: true,
        assertAllowed() {
          throw new Error("input policy denied");
        },
      }),
      /input policy denied/u,
    );
    const image = await core.confirmImageInput({
      path: imagePath,
      allowedRoot: projectRoot,
      confirmed: true,
      assertAllowed() {},
    });
    assert.equal(image.mime, "image/png");
    assert.equal(image.display_path, "pixel.png");
    assert.equal(image.bytes, PNG.length);
    assert.match(image.sha256, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(image.redactions, ["path"]);
    await assert.rejects(
      core.confirmImageInput({
        path: imagePath,
        allowedRoot: projectRoot,
        confirmed: true,
        maxBytes: 4,
        assertAllowed() {},
      }),
      (error) => error.code === "image.too_large",
    );
    const unknown = path.join(projectRoot, "unknown.bin");
    await fs.writeFile(unknown, "not an image");
    await assert.rejects(
      core.confirmImageInput({
        path: unknown,
        allowedRoot: projectRoot,
        confirmed: true,
        assertAllowed() {},
      }),
      (error) => error.code === "image.unknown_format",
    );
    const outside = path.join(root, "outside.png");
    await fs.writeFile(outside, PNG);
    await assert.rejects(
      core.confirmImageInput({
        path: outside,
        allowedRoot: projectRoot,
        confirmed: true,
        assertAllowed() {},
      }),
      (error) => error.code === "image.outside_root",
    );
    const linked = path.join(projectRoot, "linked.png");
    await createLinkedEntry(outside, linked, root);
    await assert.rejects(
      core.confirmImageInput({
        path: linked,
        allowedRoot: projectRoot,
        confirmed: true,
        assertAllowed() {},
      }),
      (error) => error.code === "image.file",
    );
    const sensitive = path.join(projectRoot, "sensitive.png");
    await fs.writeFile(
      sensitive,
      Buffer.concat([PNG, Buffer.from("sk-" + "a".repeat(24))]),
    );
    await assert.rejects(
      core.confirmImageInput({
        path: sensitive,
        allowedRoot: projectRoot,
        confirmed: true,
        assertAllowed() {},
      }),
      (error) => error.code === "image.sensitive_content",
    );
  });
});

test("image generation requires an adapter, policy, and evidence", async () => {
  await withTempDirectory("codepunk-image-generate-", async (root) => {
    const { paths } = await makeProject(root);
    const adapter = {
      id: "local-test",
      async generate() {
        return PNG;
      },
    };
    const base = {
      prompt: "draw a pixel",
      adapter,
      artifactDir: path.join(paths.artifactsDir, "images"),
      assertAllowed() {},
      appendEvidence() {},
    };
    await assert.rejects(
      core.generateImage({ ...base, adapter: null }),
      (error) => error.code === "image.adapter_missing",
    );
    await assert.rejects(
      core.generateImage({
        prompt: base.prompt,
        adapter,
        artifactDir: base.artifactDir,
        appendEvidence() {},
      }),
      (error) => error.code === "image.policy_required",
    );
    await assert.rejects(
      core.generateImage({
        prompt: base.prompt,
        adapter,
        artifactDir: base.artifactDir,
        assertAllowed() {},
      }),
      (error) => error.code === "image.evidence_required",
    );
    await assert.rejects(
      core.generateImage({
        ...base,
        assertAllowed() {
          throw new Error("policy denied");
        },
      }),
      /policy denied/u,
    );
    const evidence = [];
    let allowed = 0;
    const generated = await core.generateImage({
      ...base,
      assertAllowed() {
        allowed += 1;
      },
      appendEvidence(record) {
        evidence.push(record);
      },
    });
    assert.equal(allowed, 1);
    assert.equal(generated.mime, "image/png");
    assert.equal(generated.policy_decision, "allow");
    assert.equal(generated.path, targetFor(base.artifactDir, PNG));
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].sha256, digest(PNG));
    assert.equal(
      evidence[0].prompt_sha256,
      digest(Buffer.from(base.prompt, "utf8")),
    );
    assert.equal((await fs.stat(generated.path)).mode & 0o777, 0o600);
    const duplicate = await core.generateImage({
      ...base,
      appendEvidence(record) {
        evidence.push(record);
      },
    });
    assert.equal(duplicate.path, generated.path);
    assert.equal(evidence.length, 2);
    const failedBytes = Buffer.concat([PNG, Buffer.from([0])]);
    const failedTarget = targetFor(base.artifactDir, failedBytes);
    await assert.rejects(
      core.generateImage({
        ...base,
        adapter: {
          id: "local-test-evidence-failure",
          async generate() {
            return failedBytes;
          },
        },
        appendEvidence() {
          throw new Error("evidence failed");
        },
      }),
      /evidence failed/u,
    );
    assert.equal((await fs.stat(failedTarget)).isFile(), true);
    await assert.rejects(
      core.generateImage({
        ...base,
        adapter: {
          id: "local-test-sensitive-output",
          async generate() {
            return Buffer.concat([PNG, Buffer.from("token=" + "x".repeat(24))]);
          },
        },
      }),
      (error) => error.code === "image.sensitive_content",
    );
    await fs.writeFile(generated.path, SECOND_PNG);
    await assert.rejects(
      core.generateImage(base),
      (error) => error.code === "image.artifact_conflict",
    );
    await fs.rm(generated.path);
    await fs.mkdir(generated.path);
    await assert.rejects(
      core.generateImage(base),
      (error) => error.code === "image.artifact_conflict",
    );
    await fs.rm(generated.path, { recursive: true });
    const preserved = await core.generateImage({
      ...base,
      adapter: {
        id: "preserve-existing",
        async generate() {
          return SECOND_PNG;
        },
      },
    });
    await assert.rejects(
      core.generateImage({
        ...base,
        adapter: {
          id: "preserve-existing",
          async generate() {
            return SECOND_PNG;
          },
        },
        appendEvidence() {
          throw new Error("evidence failed after existing artifact");
        },
      }),
      /evidence failed/u,
    );
    assert.equal((await fs.stat(preserved.path)).isFile(), true);
  });
});
