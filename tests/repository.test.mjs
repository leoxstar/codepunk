import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkRepository } from "../scripts/check-repo.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CHECK_SCRIPT = path.join(REPO_ROOT, "scripts", "check-repo.mjs");
const COPY_EXCLUSIONS = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "tmp",
]);

function runCheck(root, { requireBuilt = false, script = CHECK_SCRIPT } = {}) {
  const argumentsList = [
    script,
    "--root",
    root,
    ...(requireBuilt ? ["--require-built"] : []),
  ];
  return spawnSync(process.execPath, argumentsList, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 20_000,
  });
}

function outputOf(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function assertClean(result, label) {
  assert.equal(result.status, 0, `${label} should pass\n${outputOf(result)}`);
  assert.match(outputOf(result), /Repository check passed/u);
}

function assertRuleFailure(result, rule, expectedPath) {
  assert.equal(result.status, 1, outputOf(result));
  const escapedRule = rule.replaceAll(".", "\\.");
  assert.match(outputOf(result), new RegExp(`\\[${escapedRule}\\]`, "u"));
  if (expectedPath) {
    const escapedPath = expectedPath.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.match(
      outputOf(result),
      new RegExp(`\\[${escapedRule}\\] ${escapedPath}:`, "u"),
    );
  }
}

async function replaceFile(root, relativePath, transform) {
  const absolutePath = path.join(root, relativePath);
  const original = await readFile(absolutePath, "utf8");
  await writeFile(absolutePath, transform(original), "utf8");
  return async () => {
    await writeFile(absolutePath, original, "utf8");
  };
}

async function mutateJson(root, relativePath, transform) {
  return replaceFile(root, relativePath, (content) => {
    const value = JSON.parse(content);
    transform(value);
    return `${JSON.stringify(value, null, 2)}\n`;
  });
}

async function createDirectoryFixture(root, relativePath, fileName, content) {
  const directory = path.join(root, relativePath);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, fileName), content, "utf8");
  return async () => {
    await rm(directory, { recursive: true, force: true });
  };
}

async function createFileFixture(root, relativePath, content) {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  return async () => {
    await rm(absolutePath, { force: true });
  };
}

async function stageTrackedFile(root, relativePath) {
  execFileSync("git", ["-C", root, "add", "-f", "--", relativePath]);
  return async () => {
    execFileSync(
      "git",
      ["-C", root, "rm", "--cached", "-f", "--", relativePath],
      { stdio: "ignore" },
    );
  };
}

async function plantStaleBuiltEntries(root) {
  for (const packageDirectory of ["protocol", "core", "cli"]) {
    const directory = path.join(root, "packages", packageDirectory);
    const manifest = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    );
    for (const field of ["types", "import"]) {
      const target = path.join(directory, manifest.exports["."][field]);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "", "utf8");
      await utimes(target, new Date(0), new Date(0));
    }
  }
}

async function copyRepositoryToTemporaryDirectory() {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "codepunk-repository-check-"),
  );
  const productRoot = path.join(temporaryRoot, "product");
  await cp(REPO_ROOT, productRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(REPO_ROOT, source);
      if (!relative || relative.startsWith("..")) {
        return true;
      }
      return !relative
        .split(path.sep)
        .some((segment) => COPY_EXCLUSIONS.has(segment));
    },
  });
  execFileSync("git", ["-C", productRoot, "init", "-q"]);
  execFileSync("git", ["-C", productRoot, "add", "-A"]);
  return {
    temporaryRoot,
    root: productRoot,
    cleanup: async () => {
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

const NEGATIVE_CASES = [
  {
    name: "wrong dependency direction",
    rule: "deps.direction",
    path: "packages/protocol/package.json",
    async apply(root) {
      return mutateJson(root, "packages/protocol/package.json", (manifest) => {
        manifest.dependencies["@codepunk/core"] = "0.0.0";
      });
    },
  },
  {
    name: "package version drift",
    rule: "pkg.manifest",
    path: "packages/core/package.json",
    async apply(root) {
      return mutateJson(root, "packages/core/package.json", (manifest) => {
        manifest.version = "0.0.1";
      });
    },
  },
  {
    name: "internal dependency pin drift",
    rule: "deps.pin",
    path: "packages/cli/package.json",
    async apply(root) {
      return mutateJson(root, "packages/cli/package.json", (manifest) => {
        manifest.dependencies["@codepunk/protocol"] = "0.0.0";
      });
    },
  },
  {
    name: "broken local Markdown link",
    rule: "docs.link",
    path: "README.md",
    async apply(root) {
      return replaceFile(
        root,
        "README.md",
        (content) => `${content}\n[missing](docs/does-not-exist.md)\n`,
      );
    },
  },
  {
    name: "absolute Markdown link",
    rule: "docs.absolute",
    path: "README.md",
    async apply(root) {
      return replaceFile(root, "README.md", (content) => {
        const absoluteTarget = ["", "docs", "ARCHITECTURE.md"].join("/");
        return `${content}\n[absolute](${absoluteTarget})\n`;
      });
    },
  },
  {
    name: "invalid spaced Markdown target",
    rule: "docs.link",
    path: "README.md",
    async apply(root) {
      return replaceFile(
        root,
        "README.md",
        (content) => `${content}\n[invalid](docs/a b.md)\n`,
      );
    },
  },
  {
    name: "local personal absolute path",
    rule: "security.absolute-path",
    path: "docs/ARCHITECTURE.md",
    async apply(root) {
      const personalPath = ["", "home", "fixture-user", "notes.txt"].join("/");
      return replaceFile(
        root,
        "docs/ARCHITECTURE.md",
        (content) => `${content}\nFixture path: ${personalPath}\n`,
      );
    },
  },
  {
    name: "forbidden research artifact",
    rule: "hygiene.forbidden",
    path: "probe",
    async apply(root) {
      return createDirectoryFixture(
        root,
        "probe",
        "notes.md",
        "# Transient fixture\n",
      );
    },
  },
  {
    name: "wrong dependency pin",
    rule: "deps.pin",
    path: "packages/core/package.json",
    async apply(root) {
      return mutateJson(root, "packages/core/package.json", (manifest) => {
        manifest.dependencies["@earendil-works/pi-coding-agent"] = "1.5.3";
      });
    },
  },
  {
    name: "disabled repository check script",
    rule: "pkg.manifest",
    path: "package.json",
    async apply(root) {
      return mutateJson(root, "package.json", (manifest) => {
        manifest.scripts.check = "exit 0";
      });
    },
  },
  {
    name: "prohibited lifecycle script",
    rule: "deps.review",
    path: "package.json",
    async apply(root) {
      return mutateJson(root, "package.json", (manifest) => {
        manifest.scripts.postinstall = "echo unexpected";
      });
    },
  },
  {
    name: "unapproved dependency override",
    rule: "deps.review",
    path: "package.json",
    async apply(root) {
      return mutateJson(root, "package.json", (manifest) => {
        manifest.overrides = { zod: "3.25.75" };
      });
    },
  },
  {
    name: "secret-shaped value",
    rule: "security.credential",
    path: "docs/security-fixture.md",
    async apply(root) {
      const accessKey = ["AK", "IA"].join("") + "A".repeat(16);
      return createFileFixture(
        root,
        "docs/security-fixture.md",
        `Fixture value: ${accessKey}\n`,
      );
    },
  },
  {
    name: "extensionless secret-shaped file",
    rule: "security.credential",
    path: "docs/notes",
    async apply(root) {
      const accessKey = ["AK", "IA"].join("") + "A".repeat(16);
      return createFileFixture(root, "docs/notes", `Fixture: ${accessKey}\n`);
    },
  },
  {
    name: "ignored file still participates in content checks",
    rule: "security.credential",
    path: "docs/ignored-secret.md",
    async apply(root) {
      const restoreIgnore = await replaceFile(root, ".gitignore", (content) => {
        return `${content}\ndocs/ignored-secret.md\n`;
      });
      const accessKey = ["AK", "IA"].join("") + "A".repeat(16);
      const removeSecret = await createFileFixture(
        root,
        "docs/ignored-secret.md",
        `Fixture: ${accessKey}\n`,
      );
      return async () => {
        await removeSecret();
        await restoreIgnore();
      };
    },
  },
  {
    name: "missing required product document",
    rule: "repo.docs",
    path: "SECURITY.md",
    async apply(root) {
      const absolutePath = path.join(root, "SECURITY.md");
      const original = await readFile(absolutePath, "utf8");
      await rm(absolutePath);
      return async () => {
        await writeFile(absolutePath, original, "utf8");
      };
    },
  },
  {
    name: "invalid public entry point",
    rule: "pkg.exports",
    path: "packages/core/package.json",
    async apply(root) {
      return mutateJson(root, "packages/core/package.json", (manifest) => {
        delete manifest.exports;
      });
    },
  },
  {
    name: "deep internal import",
    rule: "source.import",
    path: "packages/core/src/index.ts",
    async apply(root) {
      return replaceFile(root, "packages/core/src/index.ts", () => {
        return [
          'import type { ProtocolFixture } from "@codepunk/protocol/dist/index.js";',
          "export type CoreFixture = ProtocolFixture;",
          "",
        ].join("\n");
      });
    },
  },
  {
    name: "computed module import",
    rule: "source.import",
    path: "packages/core/src/index.ts",
    async apply(root) {
      return replaceFile(root, "packages/core/src/index.ts", () => {
        return [
          'const moduleName = "@codepunk/protocol/dist/index.js";',
          "export const load = () => import(moduleName);",
          "",
        ].join("\n");
      });
    },
  },
  {
    name: "reviewed computed import cannot hide another computed import",
    rule: "source.import",
    path: "packages/cli/src/tui.ts",
    async apply(root) {
      return replaceFile(root, "packages/cli/src/tui.ts", (content) => {
        return `${content}
const extraModuleSpecifier = "@codepunk/protocol";
export const loadExtraModule = () => import(extraModuleSpecifier);
`;
      });
    },
  },
  {
    name: "research import",
    rule: "security.research-import",
    path: "packages/core/src/index.ts",
    async apply(root) {
      return replaceFile(root, "packages/core/src/index.ts", () => {
        const specifier = ["..", "..", "..", "..", "verify", "probe.mjs"].join(
          "/",
        );
        return `import "${specifier}";\n`;
      });
    },
  },
  {
    name: "local environment file",
    rule: "hygiene.env",
    path: ".env",
    async apply(root) {
      return createFileFixture(root, ".env", "PLACEHOLDER=value\n");
    },
  },
  {
    name: "direnv environment file",
    rule: "hygiene.env",
    path: ".envrc",
    async apply(root) {
      return createFileFixture(root, ".envrc", "export PLACEHOLDER=value\n");
    },
  },
  {
    name: "unreviewed runtime dependency",
    rule: "deps.review",
    path: "packages/core/package.json",
    async apply(root) {
      return mutateJson(root, "packages/core/package.json", (manifest) => {
        manifest.dependencies["left-pad"] = "1.3.0";
      });
    },
  },
  {
    name: "wrong package manager pin",
    rule: "pkg.manifest",
    path: "package.json",
    async apply(root) {
      return mutateJson(root, "package.json", (manifest) => {
        manifest.packageManager = "pnpm@latest";
      });
    },
  },
  {
    name: "npm workspaces reintroduced",
    rule: "pkg.manifest",
    path: "package.json",
    async apply(root) {
      return mutateJson(root, "package.json", (manifest) => {
        manifest.workspaces = ["packages/*"];
      });
    },
  },
  {
    name: "pnpm workspace glob drift",
    rule: "pkg.manifest",
    path: "pnpm-workspace.yaml",
    async apply(root) {
      return replaceFile(root, "pnpm-workspace.yaml", (content) =>
        content.replace('"packages/*"', '"apps/*"'),
      );
    },
  },
  {
    name: "pnpm workspace no longer links local packages",
    rule: "pkg.manifest",
    path: "pnpm-workspace.yaml",
    async apply(root) {
      return replaceFile(root, "pnpm-workspace.yaml", (content) =>
        content.replace(
          "linkWorkspacePackages: true",
          "linkWorkspacePackages: false",
        ),
      );
    },
  },
  {
    name: "ignored dependency build scripts drift",
    rule: "pkg.manifest",
    path: "pnpm-workspace.yaml",
    async apply(root) {
      return replaceFile(root, "pnpm-workspace.yaml", (content) =>
        content.replace("  - protobufjs\n", "  - esbuild\n"),
      );
    },
  },
  {
    name: "strict dependency build checks re-enabled",
    rule: "pkg.manifest",
    path: "pnpm-workspace.yaml",
    async apply(root) {
      return replaceFile(root, "pnpm-workspace.yaml", (content) =>
        content.replace("strictDepBuilds: false", "strictDepBuilds: true"),
      );
    },
  },
  {
    name: "wrong Node engine",
    rule: "pkg.manifest",
    path: "package.json",
    async apply(root) {
      return mutateJson(root, "package.json", (manifest) => {
        manifest.engines.node = ">=20.0.0";
      });
    },
  },
  {
    name: "typecheck depends on stale build output",
    rule: "pkg.manifest",
    path: "packages/core/package.json",
    async apply(root) {
      return mutateJson(root, "packages/core/package.json", (manifest) => {
        manifest.scripts.typecheck = "tsc -p tsconfig.json --noEmit";
      });
    },
  },
  {
    name: "typecheck bypasses internal source mapping",
    rule: "pkg.manifest",
    path: "packages/core/tsconfig.typecheck.json",
    async apply(root) {
      return mutateJson(
        root,
        "packages/core/tsconfig.typecheck.json",
        (config) => {
          config.compilerOptions.paths = {};
        },
      );
    },
  },
  {
    name: "extra package",
    rule: "pkg.layout",
    path: "packages",
    async apply(root) {
      return createDirectoryFixture(
        root,
        "packages/unreviewed",
        "README.md",
        "# Unreviewed\n",
      );
    },
  },
  {
    name: "unexpected root entry",
    rule: "repo.root",
    path: "notes.txt",
    async apply(root) {
      return createFileFixture(root, "notes.txt", "local notes\n");
    },
  },
  {
    name: "local editor state",
    rule: "hygiene.forbidden",
    path: ".vscode",
    async apply(root) {
      return createDirectoryFixture(root, ".vscode", "settings.json", "{}\n");
    },
  },
  {
    name: "unignored product runtime state",
    rule: "hygiene.forbidden",
    path: ".codepunk",
    async apply(root) {
      const restoreIgnore = await replaceFile(root, ".gitignore", (content) =>
        content.replace(/^\.codepunk\/$/mu, ""),
      );
      const removeState = await createDirectoryFixture(
        root,
        ".codepunk",
        "config.toml",
        "[model]\n",
      );
      return async () => {
        await removeState();
        await restoreIgnore();
      };
    },
  },
  {
    name: "case-insensitive research directory",
    rule: "hygiene.forbidden",
    path: "docs/Research",
    async apply(root) {
      return createDirectoryFixture(root, "docs/Research", "note.md", "# x\n");
    },
  },
  {
    name: "binary or NUL-containing file",
    rule: "hygiene.binary",
    path: "docs/nul.md",
    async apply(root) {
      return createFileFixture(
        root,
        "docs/nul.md",
        Buffer.from("Fixture text\0with a NUL byte\n", "utf8"),
      );
    },
  },
  {
    name: "ignored generated environment file",
    rule: "hygiene.env",
    path: "dist/.env",
    async apply(root) {
      return createFileFixture(root, "dist/.env", "PLACEHOLDER=value\n");
    },
  },
  {
    name: "CI install command drift",
    rule: "ci.contract",
    path: ".github/workflows/ci.yml",
    async apply(root) {
      return replaceFile(root, ".github/workflows/ci.yml", (content) =>
        content.replace(
          "run: pnpm install --frozen-lockfile --ignore-scripts",
          "run: pnpm install --no-frozen-lockfile",
        ),
      );
    },
  },
  {
    name: "CI check made non-blocking",
    rule: "ci.contract",
    path: ".github/workflows/ci.yml",
    async apply(root) {
      return replaceFile(root, ".github/workflows/ci.yml", (content) =>
        content.replace(
          "      - name: Check repository\n        run: pnpm run check",
          "      - name: Check repository\n        run: pnpm run check\n        continue-on-error: true",
        ),
      );
    },
  },
  {
    name: "CI quality job disabled",
    rule: "ci.contract",
    path: ".github/workflows/ci.yml",
    async apply(root) {
      return replaceFile(root, ".github/workflows/ci.yml", (content) =>
        content.replace(
          "    timeout-minutes: 20\n",
          "    timeout-minutes: 20\n    if: false\n",
        ),
      );
    },
  },
  {
    name: "CI alternate trigger",
    rule: "ci.contract",
    path: ".github/workflows/ci.yml",
    async apply(root) {
      return replaceFile(root, ".github/workflows/ci.yml", (content) =>
        content.replace(
          "on:\n  push:\n  pull_request:",
          "on:\n  workflow_dispatch:",
        ),
      );
    },
  },
  {
    name: "CI unreviewed action",
    rule: "ci.contract",
    path: ".github/workflows/ci.yml",
    async apply(root) {
      return replaceFile(root, ".github/workflows/ci.yml", (content) =>
        content.replace(
          "      - name: Check out repository\n",
          "      - name: Unreviewed action\n        uses: example/action@main\n\n      - name: Check out repository\n",
        ),
      );
    },
  },
  {
    name: "unreviewed workflow",
    rule: "ci.contract",
    path: ".github/workflows/deploy.yml",
    async apply(root) {
      return createFileFixture(
        root,
        ".github/workflows/deploy.yml",
        "name: deploy\n",
      );
    },
  },
  {
    name: "negative-control corpus replacement",
    rule: "repo.controls",
    path: "tests/repository.test.mjs",
    async apply(root) {
      return replaceFile(
        root,
        "tests/repository.test.mjs",
        () => 'import test from "node:test";\ntest("ok", () => {});\n',
      );
    },
  },
  {
    name: "documentation pin drift",
    rule: "docs.contract",
    path: "docs/DEVELOPMENT.md",
    async apply(root) {
      return replaceFile(root, "docs/DEVELOPMENT.md", (content) =>
        content.replaceAll("`1.5.2`", "`1.5.3`"),
      );
    },
  },
  {
    name: "dependency review snapshot removal",
    rule: "docs.contract",
    path: "docs/DEVELOPMENT.md",
    async apply(root) {
      return replaceFile(root, "docs/DEVELOPMENT.md", (content) =>
        content.replace(/### Dependency review snapshot[\s\S]*?(?=\n## )/u, ""),
      );
    },
  },
  {
    name: "repository checks documentation removal",
    rule: "docs.contract",
    path: "docs/DEVELOPMENT.md",
    async apply(root) {
      return replaceFile(root, "docs/DEVELOPMENT.md", (content) =>
        content.replace(/\n## Repository checks[\s\S]*$/u, "\n"),
      );
    },
  },
  {
    name: "security advisory id rewrite",
    rule: "docs.contract",
    path: "docs/DEVELOPMENT.md",
    async apply(root) {
      return replaceFile(root, "docs/DEVELOPMENT.md", (content) =>
        content.replace("GHSA-mrhx-c7xc-m3w5", "GHSA-0000-0000-0000"),
      );
    },
  },
  {
    name: "lockfile drift",
    rule: "deps.lock",
    path: "pnpm-lock.yaml",
    async apply(root) {
      return replaceFile(root, "pnpm-lock.yaml", (content) =>
        content.replace(
          /lockfileVersion: ['"]9\.0['"]/u,
          'lockfileVersion: "8.0"',
        ),
      );
    },
  },
  {
    name: "reviewed install-script package version drift",
    rule: "deps.review",
    path: "pnpm-lock.yaml",
    async apply(root) {
      return replaceFile(root, "pnpm-lock.yaml", (content) =>
        content.replaceAll("koffi@3.3.8", "koffi@3.3.7"),
      );
    },
  },
  {
    name: "transitive lockfile drift",
    rule: "deps.lock",
    path: "pnpm-lock.yaml",
    async apply(root) {
      return replaceFile(root, "pnpm-lock.yaml", (content) =>
        content.replaceAll("undici@8.12.3", "undici@8.0.0"),
      );
    },
  },
  {
    name: "product package license drift",
    rule: "pkg.manifest",
    path: "packages/core/package.json",
    async apply(root) {
      return mutateJson(root, "packages/core/package.json", (manifest) => {
        manifest.license = "GPL-3.0";
      });
    },
  },
  {
    name: "tracked file inside a source node_modules directory",
    rule: "hygiene.forbidden",
    path: "packages/core/src/node_modules/probe.ts",
    async apply(root) {
      const removeFile = await createFileFixture(
        root,
        "packages/core/src/node_modules/probe.ts",
        'import "../../../../cli/src/index.ts";\nexport const probe = 1;\n',
      );
      const unstage = await stageTrackedFile(
        root,
        "packages/core/src/node_modules/probe.ts",
      );
      return async () => {
        await unstage();
        await removeFile();
      };
    },
  },
];

test("clean repository passes the repository checks", async () => {
  const result = await checkRepository({ root: REPO_ROOT });
  assert.deepEqual(result.errors, []);
  assert.ok(result.fileCount > 0);
});

test("a transient pack directory does not race the root-entry check", async () => {
  const fixture = await copyRepositoryToTemporaryDirectory();
  const transientName = `_tmp_${process.pid}_a1b2c3d4`;
  const transientPath = path.join(fixture.root, transientName);
  let removed = false;
  try {
    await mkdir(transientPath);
    const removal = setTimeout(() => {
      removed = true;
      rm(transientPath, { recursive: true, force: true }).catch(() => {});
    }, 100);
    try {
      const result = await checkRepository({ root: fixture.root });
      assert.deepEqual(result.errors, []);
    } finally {
      clearTimeout(removal);
    }
    assert.equal(removed, true);
  } finally {
    await rm(transientPath, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("a persistent pack-shaped root directory still fails", async () => {
  const fixture = await copyRepositoryToTemporaryDirectory();
  const transientName = `_tmp_${process.pid}_a1b2c3d4`;
  try {
    await mkdir(path.join(fixture.root, transientName));
    const result = await checkRepository({ root: fixture.root });
    assert.ok(
      result.errors.some(
        (error) => error.rule === "repo.root" && error.path === transientName,
      ),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("built-entry check fails when build output is absent", async () => {
  const fixture = await copyRepositoryToTemporaryDirectory();
  try {
    const result = runCheck(fixture.root, { requireBuilt: true });
    assertRuleFailure(result, "pkg.built");
  } finally {
    await fixture.cleanup();
  }
});

test("built-entry check fails when output is older than source", async () => {
  const fixture = await copyRepositoryToTemporaryDirectory();
  try {
    await plantStaleBuiltEntries(fixture.root);
    const result = runCheck(fixture.root, { requireBuilt: true });
    assertRuleFailure(result, "pkg.built");
    assert.match(outputOf(result), /older than its source/u);
  } finally {
    await fixture.cleanup();
  }
});

test("symlinked checker invocation is not a silent no-op", async () => {
  const fixture = await copyRepositoryToTemporaryDirectory();
  try {
    const linkedScript = path.join(fixture.temporaryRoot, "check-link.mjs");
    await symlink(CHECK_SCRIPT, linkedScript);
    const result = runCheck(fixture.root, { script: linkedScript });
    assertClean(result, "symlinked checker invocation");
  } finally {
    await fixture.cleanup();
  }
});

test("code blocks, comments, strings, and environment templates do not create false positives", async () => {
  const fixture = await copyRepositoryToTemporaryDirectory();
  try {
    const restoreReadme = await replaceFile(
      fixture.root,
      "README.md",
      (content) => {
        return [
          content,
          "```text",
          "[example](docs/not-created.md)",
          "```",
          "",
          "    [indented example](docs/not-created.md)",
          "",
        ].join("\n");
      },
    );
    const restoreSource = await replaceFile(
      fixture.root,
      "packages/core/src/index.ts",
      () => {
        return [
          "// never use import(x) here",
          "export const help = 'you must import(x) first';",
          "export const notice = `never use require(y) here`;",
          "export const pattern = /[$~#]/u;",
          "// still ignore import(z) after the regular expression",
          "",
        ].join("\n");
      },
    );
    const removeTemplate = await createFileFixture(
      fixture.root,
      "docs/.env.example",
      "API_KEY=\n",
    );
    try {
      assertClean(
        runCheck(fixture.root),
        "code examples, import text, and env template",
      );
    } finally {
      await removeTemplate();
      await restoreSource();
      await restoreReadme();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("product feature names do not look like research artifacts", async () => {
  const fixture = await copyRepositoryToTemporaryDirectory();
  try {
    const removeFiles = await Promise.all([
      createFileFixture(
        fixture.root,
        "packages/core/src/archive.ts",
        "export const archived = true;\n",
      ),
      createFileFixture(
        fixture.root,
        "packages/core/src/verify.ts",
        "export const verified = true;\n",
      ),
      createFileFixture(
        fixture.root,
        "packages/core/memory/archive/index.ts",
        "export const memoryArchive = true;\n",
      ),
      createFileFixture(
        fixture.root,
        "docs/verify-notes.md",
        "# Verification notes\n",
      ),
    ]);
    try {
      assertClean(runCheck(fixture.root), "product archive and verify names");
    } finally {
      await Promise.all(removeFiles.map((remove) => remove()));
    }
  } finally {
    await fixture.cleanup();
  }
});

test("ignored product runtime state is scanned but not rejected", async () => {
  const fixture = await copyRepositoryToTemporaryDirectory();
  try {
    const removeState = await createDirectoryFixture(
      fixture.root,
      ".codepunk",
      "config.toml",
      '[model]\nprovider = "local"\nid = "chat"\n',
    );
    assertClean(runCheck(fixture.root), "ignored product runtime state");

    const accessKey = ["AK", "IA"].join("") + "A".repeat(16);
    const removeSecret = await createFileFixture(
      fixture.root,
      ".codepunk/session-evidence.txt",
      `Fixture value: ${accessKey}\n`,
    );
    try {
      assertRuleFailure(
        runCheck(fixture.root),
        "security.credential",
        ".codepunk/session-evidence.txt",
      );
    } finally {
      await removeSecret();
      await removeState();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("each planted violation fails and removal restores zero", async (t) => {
  const fixture = await copyRepositoryToTemporaryDirectory();
  try {
    assertClean(runCheck(fixture.root), "copied product tree");

    for (const negativeCase of NEGATIVE_CASES) {
      await t.test(negativeCase.name, async () => {
        let restore;
        try {
          restore = await negativeCase.apply(fixture.root);
          assertRuleFailure(
            runCheck(fixture.root),
            negativeCase.rule,
            negativeCase.path,
          );
        } finally {
          if (restore) {
            await restore();
          }
        }
        assertClean(
          runCheck(fixture.root),
          `copied product tree after removing ${negativeCase.name}`,
        );
      });
    }
  } finally {
    await fixture.cleanup();
  }
});

test("temporary fixture did not leak into the product tree", () => {
  assert.equal(existsSync(path.join(REPO_ROOT, "probe")), false);
  assert.equal(existsSync(path.join(REPO_ROOT, ".env")), false);
});
