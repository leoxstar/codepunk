import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importCore } from "./support/core.mjs";

const core = await importCore();

test("text files are forced to LF on every checkout", async () => {
  const attributes = await fs.readFile(
    path.resolve(import.meta.dirname, "..", ".gitattributes"),
    "utf8",
  );
  assert.match(attributes, /^\* text=auto eol=lf$/mu);
});

test("sensitive path matching is case-insensitive", () => {
  const root = path.join(os.tmpdir(), "codepunk-sensitive-path");
  assert.equal(core.isSensitivePath(path.join(root, "notes.md")), false);
  assert.equal(core.isSensitivePath(path.join(root, "src", "index.ts")), false);
  assert.equal(core.isSensitivePath(path.join(root, ".ENV")), true);
  assert.equal(core.isSensitivePath(path.join(root, ".ENV.LOCAL")), true);
  assert.equal(core.isSensitivePath(path.join(root, ".SSH", "config")), true);
  assert.equal(core.isSensitivePath(path.join(root, "AUTH.JSON")), true);
  assert.equal(core.isSensitivePath(path.join(root, "ID_RSA")), true);
  assert.equal(
    core.isSensitivePath(
      path.join(root, "project", ".CODEPUNK", "config.toml"),
      undefined,
      path.join(root, "project"),
    ),
    true,
  );
  assert.equal(
    core.isSensitivePath(
      path.join(root, "PROJECT", ".CODEPUNK", "config.toml"),
      undefined,
      path.join(root, "project"),
    ),
    true,
  );
  assert.equal(
    core.isSensitivePath(
      path.join(root, "PROJECT", "notes", ".codepunk", "config.toml"),
      undefined,
      path.join(root, "project"),
    ),
    false,
  );
  assert.equal(
    core.isSensitivePath(
      path.join(root, "HOME", ".codepunk", "config.toml"),
      path.join(root, "home"),
    ),
    true,
  );
  assert.equal(core.isSensitivePath(path.join(root, ".ENV.EXAMPLE")), false);
  assert.equal(core.isSensitivePath(path.join(root, ".env.template")), true);
});
