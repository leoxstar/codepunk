import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
  canCreateFileSymlink,
  FILE_SYMLINK_SKIP_REASON,
} from "./support/helpers.mjs";

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

function runCheck(
  root,
  { requireBuilt = false, script = CHECK_SCRIPT, env = process.env } = {},
) {
  const argumentsList = [
    script,
    "--root",
    root,
    ...(requireBuilt ? ["--require-built"] : []),
  ];
  return spawnSync(process.execPath, argumentsList, {
    cwd: root,
    encoding: "utf8",
    env: { ...env, NO_COLOR: "1" },
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

const CI_RUNNER_DOCUMENTATION_LINE =
  "CI runners: `ubuntu-24.04`, `ubuntu-24.04-arm`, `ubuntu-26.04`, `macos-15`, `macos-15-intel`, `macos-26`, `windows-latest`.";

async function createExecutableFixtureChecker(fixture) {
  const script = path.join(fixture.temporaryRoot, "check-repo.mjs");
  const content = await readFile(
    path.join(fixture.root, "scripts/check-repo.mjs"),
    "utf8",
  );
  await writeFile(
    script,
    content.replace(
      '"typescript/unstable/ast"',
      JSON.stringify(import.meta.resolve("typescript/unstable/ast")),
    ),
  );
  return script;
}

async function runFixtureCheck(fixture, options = {}) {
  return runCheck(fixture.root, {
    ...options,
    script: await createExecutableFixtureChecker(fixture),
  });
}

async function replaceExpectedDigest(root, constantName, digest) {
  return replaceFile(root, "scripts/check-repo.mjs", (content) =>
    content.replace(
      new RegExp(`(const ${constantName} =\\s*")[a-f0-9]{64}(";)`, "u"),
      `$1${digest}$2`,
    ),
  );
}

async function refreshFixtureWorkflowDigest(root) {
  const digest = createHash("sha256")
    .update(await readFile(path.join(root, ".github/workflows/ci.yml")))
    .digest("hex");
  return replaceExpectedDigest(root, "EXPECTED_CI_SHA256", digest);
}

async function refreshFixtureFullCiDigest(root) {
  const digest = createHash("sha256")
    .update(await readFile(path.join(root, ".github/workflows/full-ci.yml")))
    .digest("hex");
  return replaceExpectedDigest(root, "EXPECTED_FULL_CI_SHA256", digest);
}

async function refreshFixtureControlCorpusDigest(root) {
  const digest = createHash("sha256")
    .update(await readFile(path.join(root, "tests/repository.test.mjs")))
    .digest("hex");
  return replaceExpectedDigest(root, "EXPECTED_CONTROL_CORPUS_SHA256", digest);
}

async function refreshFixtureReleaseSmokeDigest(root) {
  const digest = createHash("sha256")
    .update(
      await readFile(path.join(root, ".github/workflows/release-smoke.yml")),
    )
    .digest("hex");
  return replaceExpectedDigest(root, "EXPECTED_RELEASE_SMOKE_SHA256", digest);
}

async function mutateReleaseSmokeAndRefreshDigest(root, transform) {
  const restoreWorkflow = await replaceFile(
    root,
    ".github/workflows/release-smoke.yml",
    transform,
  );
  const restoreDigest = await refreshFixtureReleaseSmokeDigest(root);
  return async () => {
    await restoreDigest();
    await restoreWorkflow();
  };
}

async function mutateWorkflowAndRefreshDigest(root, transform) {
  const restoreWorkflow = await replaceFile(
    root,
    ".github/workflows/ci.yml",
    transform,
  );
  const restoreDigest = await refreshFixtureWorkflowDigest(root);
  return async () => {
    await restoreDigest();
    await restoreWorkflow();
  };
}

async function mutateFullCiAndRefreshDigest(root, transform) {
  const restoreWorkflow = await replaceFile(
    root,
    ".github/workflows/full-ci.yml",
    transform,
  );
  const restoreDigest = await refreshFixtureFullCiDigest(root);
  return async () => {
    await restoreDigest();
    await restoreWorkflow();
  };
}

async function createPackagingFixture() {
  const fixture = await copyRepositoryToTemporaryDirectory();
  const license = await readFile(path.join(fixture.root, "LICENSE"));
  for (const packageName of ["protocol", "core", "cli"]) {
    const packageDirectory = `packages/${packageName}`;
    await mutateJson(
      fixture.root,
      `${packageDirectory}/package.json`,
      (manifest) => {
        manifest.repository = {
          type: "git",
          url: "git+https://github.com/leoxstar/codepunk.git",
        };
        manifest.publishConfig = { access: "public" };
      },
    );
    await writeFile(
      path.join(fixture.root, packageDirectory, "LICENSE"),
      license,
    );
  }
  await writeFile(path.join(fixture.root, "CHANGELOG.md"), "# Changelog\n");
  return fixture;
}

async function createNpmPackFixture(fixture, output, status = 0) {
  const directory = path.join(fixture.temporaryRoot, "bin");
  await mkdir(directory, { recursive: true });
  const script = [
    "#!/usr/bin/env node",
    `process.stdout.write(${JSON.stringify(output)});`,
    `process.exitCode = ${status};`,
    "",
  ].join("\n");
  await writeFile(path.join(directory, "npm"), script, { mode: 0o755 });
  await writeFile(
    path.join(directory, "npm.cmd"),
    '@echo off\r\nnode "%~dp0npm" %*\r\n',
  );
  return {
    ...process.env,
    PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

const PACKAGING_NEGATIVE_CASES = [
  {
    name: "missing repository URL",
    mutate(manifest) {
      delete manifest.repository;
    },
  },
  {
    name: "incorrect repository URL",
    mutate(manifest) {
      manifest.repository.url = "git+https://example.com/other.git";
    },
  },
  {
    name: "missing publish access",
    mutate(manifest) {
      delete manifest.publishConfig;
    },
  },
  {
    name: "nonpublic publish access",
    mutate(manifest) {
      manifest.publishConfig.access = "restricted";
    },
  },
  {
    name: "extra published source entry",
    mutate(manifest) {
      manifest.files.push("src");
    },
  },
  {
    name: "explicit LICENSE files entry",
    mutate(manifest) {
      manifest.files.push("LICENSE");
    },
  },
  {
    name: "missing published README entry",
    mutate(manifest) {
      manifest.files = ["dist"];
    },
  },
  {
    name: "reordered published files",
    mutate(manifest) {
      manifest.files.reverse();
    },
  },
  {
    name: "duplicated published files",
    mutate(manifest) {
      manifest.files.push("dist");
    },
  },
];

test("packaging accepts a synthetic release tree with real offline npm packing", async () => {
  const fixture = await createPackagingFixture();
  try {
    const result = await checkRepository({ root: fixture.root });
    assert.deepEqual(result.errors, []);
    for (const packageName of ["protocol", "core", "cli"]) {
      assert.equal(
        existsSync(
          path.join(
            fixture.root,
            "packages",
            packageName,
            `codepunk-${packageName}-0.1.0.tgz`,
          ),
        ),
        false,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("packaging requires the CHANGELOG root allowlist entry", async () => {
  const fixture = await createPackagingFixture();
  try {
    const script = path.join(fixture.temporaryRoot, "check-root-allowlist.mjs");
    const content = await readFile(CHECK_SCRIPT, "utf8");
    await writeFile(
      script,
      content
        .replace('  "CHANGELOG.md",\n', "")
        .replace(
          '"typescript/unstable/ast"',
          JSON.stringify(import.meta.resolve("typescript/unstable/ast")),
        ),
    );
    assertRuleFailure(
      runCheck(fixture.root, { script }),
      "repo.root",
      "CHANGELOG.md",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("packaging rejects each manifest and byte-level license violation", async (t) => {
  const fixture = await createPackagingFixture();
  try {
    for (const packageName of ["protocol", "core", "cli"]) {
      const manifestPath = `packages/${packageName}/package.json`;
      for (const negativeCase of PACKAGING_NEGATIVE_CASES) {
        await t.test(`${packageName}: ${negativeCase.name}`, async () => {
          const restore = await mutateJson(
            fixture.root,
            manifestPath,
            negativeCase.mutate,
          );
          try {
            assertRuleFailure(
              runCheck(fixture.root),
              "pkg.manifest",
              manifestPath,
            );
          } finally {
            await restore();
          }
        });
      }
      const licensePath = `packages/${packageName}/LICENSE`;
      const license = await readFile(path.join(fixture.root, licensePath));
      await t.test(`${packageName}: missing package LICENSE`, async () => {
        await rm(path.join(fixture.root, licensePath));
        try {
          assertRuleFailure(runCheck(fixture.root), "pkg.license", licensePath);
        } finally {
          await writeFile(path.join(fixture.root, licensePath), license);
        }
      });
      await t.test(`${packageName}: changed LICENSE bytes`, async () => {
        await writeFile(
          path.join(fixture.root, licensePath),
          Buffer.concat([license, Buffer.from("\n")]),
        );
        try {
          assertRuleFailure(runCheck(fixture.root), "pkg.license", licensePath);
        } finally {
          await writeFile(path.join(fixture.root, licensePath), license);
        }
      });
    }
    await t.test("missing root LICENSE", async () => {
      const license = await readFile(path.join(fixture.root, "LICENSE"));
      await rm(path.join(fixture.root, "LICENSE"));
      try {
        assertRuleFailure(runCheck(fixture.root), "pkg.license", "LICENSE");
      } finally {
        await writeFile(path.join(fixture.root, "LICENSE"), license);
      }
    });
  } finally {
    await fixture.cleanup();
  }
});

test("packaging validates npm tarball evidence and allowed paths", async (t) => {
  const fixture = await createPackagingFixture();
  const validFiles = ["dist/index.js", "README.md", "LICENSE", "package.json"];
  try {
    for (const fixtureCase of [
      { name: "accepted synthetic tarball", files: validFiles, clean: true },
      { name: "source-only synthetic tarball", files: ["src/index.ts"] },
      { name: "source leakage", files: [...validFiles, "src/index.ts"] },
      {
        name: "LICENSE absent from tarball",
        files: validFiles.filter((file) => file !== "LICENSE"),
      },
      {
        name: "README absent from tarball",
        files: validFiles.filter((file) => file !== "README.md"),
      },
      {
        name: "manifest absent from tarball",
        files: validFiles.filter((file) => file !== "package.json"),
      },
      { name: "empty tarball", files: [] },
      {
        name: "built tarball without dist output",
        files: ["README.md", "LICENSE", "package.json"],
        requireBuilt: true,
      },
      { name: "malformed tarball paths", output: '[{"files":[{}]}]' },
      { name: "missing tarball file list", output: "[{}]" },
      { name: "missing tarball result", output: "[]" },
      { name: "invalid npm JSON", output: "invalid JSON" },
      { name: "failed npm pack command", output: "pack failed", status: 1 },
    ]) {
      await t.test(fixtureCase.name, async () => {
        const env = await createNpmPackFixture(
          fixture,
          fixtureCase.output ??
            JSON.stringify([
              {
                files: fixtureCase.files.map((file) => ({
                  path: file,
                  size: 1,
                  mode: 420,
                })),
              },
            ]),
          fixtureCase.status,
        );
        const result = runCheck(fixture.root, {
          env,
          requireBuilt: fixtureCase.requireBuilt,
        });
        if (fixtureCase.clean) {
          assertClean(result, fixtureCase.name);
        } else {
          for (const packageName of ["protocol", "core", "cli"]) {
            assertRuleFailure(result, "pkg.pack", `packages/${packageName}`);
          }
        }
      });
    }
  } finally {
    await fixture.cleanup();
  }
});

const NEGATIVE_CASES = [
  {
    name: "wrong dependency direction",
    rule: "deps.direction",
    path: "packages/protocol/package.json",
    async apply(root) {
      return mutateJson(root, "packages/protocol/package.json", (manifest) => {
        manifest.dependencies["codepunk-core"] = "0.0.0";
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
        manifest.dependencies["codepunk-protocol"] = "0.0.0";
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
          'import type { ProtocolFixture } from "codepunk-protocol/dist/index.js";',
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
          'const moduleName = "codepunk-protocol/dist/index.js";',
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
const extraModuleSpecifier = "codepunk-protocol";
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
    name: "missing line-ending policy",
    rule: "repo.lineEndings",
    path: ".gitattributes",
    async apply(root) {
      const absolutePath = path.join(root, ".gitattributes");
      const original = await readFile(absolutePath);
      await rm(absolutePath);
      return async () => {
        await writeFile(absolutePath, original);
      };
    },
  },
  {
    name: "weakened line-ending policy",
    rule: "repo.lineEndings",
    path: ".gitattributes",
    async apply(root) {
      return replaceFile(root, ".gitattributes", (content) =>
        content.replace("* text=auto eol=lf", "* text=auto"),
      );
    },
  },
  {
    name: "CRLF text checkout",
    rule: "repo.lineEndings",
    path: "README.md",
    async apply(root) {
      return replaceFile(root, "README.md", (content) =>
        content.replaceAll("\n", "\r\n"),
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
    name: "CI job disabled",
    rule: "ci.contract",
    path: ".github/workflows/ci.yml",
    async apply(root) {
      return replaceFile(root, ".github/workflows/ci.yml", (content) =>
        content.replace(
          "    timeout-minutes: 10\n",
          "    timeout-minutes: 10\n    if: false\n",
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
          "on:\n  push:\n",
          "on:\n  workflow_dispatch:\n  push:\n",
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
    name: "fast CI matrix without Windows",
    rule: "ci.contract",
    path: ".github/workflows/ci.yml",
    async apply(root) {
      return replaceFile(root, ".github/workflows/ci.yml", (content) =>
        content.replace(
          "        os:\n          - macos-15\n          - windows-latest\n",
          "        os:\n          - macos-15\n",
        ),
      );
    },
  },
  {
    name: "CI matrix adds an unsupported Windows runner",
    rule: "ci.contract",
    path: ".github/workflows/ci.yml",
    async apply(root) {
      return replaceFile(root, ".github/workflows/ci.yml", (content) =>
        content.replace(
          "          - windows-latest\n",
          "          - windows-latest\n          - windows-11-arm\n",
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

test("0003 checker negative controls are isolated and reversible", async (t) => {
  const fixture = await copyRepositoryToTemporaryDirectory();
  const restoreControlDigest = await refreshFixtureControlCorpusDigest(
    fixture.root,
  );
  const assertRestored = async (label) => {
    assertClean(await runFixtureCheck(fixture), label);
  };
  const assertMatrixFailure = (result) => {
    assertRuleFailure(result, "ci.contract", ".github/workflows/ci.yml");
    assert.match(
      outputOf(result),
      /CI matrix must require macos-15, windows-latest/u,
    );
    assert.doesNotMatch(outputOf(result), /workflow digest differs/u);
    assert.doesNotMatch(
      outputOf(result),
      /Windows is not a supported CI runner/u,
    );
  };
  const assertFullMatrixFailure = (result) => {
    assertRuleFailure(result, "ci.contract", ".github/workflows/full-ci.yml");
    assert.match(
      outputOf(result),
      /full CI matrix must require ubuntu-24\.04, ubuntu-24\.04-arm, ubuntu-26\.04, macos-15, macos-15-intel, macos-26, windows-latest/u,
    );
    assert.doesNotMatch(outputOf(result), /workflow digest differs/u);
  };

  try {
    await assertRestored("0003 fixture before planting violations");

    for (const matrixCase of [
      {
        name: "ordered matrix rejects an omitted runner without a digest error",
        transform: (content) =>
          content.replace("          - windows-latest\n", ""),
      },
      {
        name: "ordered matrix rejects an unreviewed Windows runner without a permanent Windows rule",
        transform: (content) =>
          content.replace(
            "          - windows-latest\n",
            "          - windows-latest\n          - windows-11-arm\n",
          ),
      },
      {
        name: "ordered matrix rejects reordered runners without a digest error",
        transform: (content) =>
          content.replace(
            "          - macos-15\n          - windows-latest\n",
            "          - windows-latest\n          - macos-15\n",
          ),
      },
    ]) {
      await t.test(matrixCase.name, async () => {
        const restore = await mutateWorkflowAndRefreshDigest(
          fixture.root,
          matrixCase.transform,
        );
        try {
          const result = await runFixtureCheck(fixture);
          assertMatrixFailure(result);
        } finally {
          await restore();
        }
        await assertRestored(`restored ${matrixCase.name}`);
      });
    }

    await t.test(
      "full matrix rejects an omitted runner without a digest error",
      async () => {
        const restore = await mutateFullCiAndRefreshDigest(
          fixture.root,
          (content) => content.replace("          - macos-15-intel\n", ""),
        );
        try {
          assertFullMatrixFailure(await runFixtureCheck(fixture));
        } finally {
          await restore();
        }
        await assertRestored("restored full matrix runner");
      },
    );

    await t.test(
      "full CI rejects a scheduled trigger without a digest error",
      async () => {
        const restore = await mutateFullCiAndRefreshDigest(
          fixture.root,
          (content) =>
            content.replace(
              "on:\n  workflow_dispatch:\n",
              'on:\n  workflow_dispatch:\n  schedule:\n    - cron: "0 3 * * 1"\n',
            ),
        );
        try {
          const result = await runFixtureCheck(fixture);
          assertRuleFailure(
            result,
            "ci.contract",
            ".github/workflows/full-ci.yml",
          );
          assert.match(
            outputOf(result),
            /full CI contains a condition, shell override, environment block, branch trigger, pull request trigger, or schedule/u,
          );
          assert.doesNotMatch(outputOf(result), /workflow digest differs/u);
        } finally {
          await restore();
        }
        await assertRestored("restored full CI trigger");
      },
    );

    await t.test("platform table rejects a changed runner", async () => {
      const relativePath = "docs/PLATFORMS.md";
      const restore = await replaceFile(
        fixture.root,
        relativePath,
        (content) => {
          const mutated = content.replace(
            /`macos-15-intel`(?=\s+\|)/u,
            "`macos-14-intel`",
          );
          assert.notEqual(
            mutated,
            content,
            "table mutation must change a runner",
          );
          return mutated;
        },
      );
      try {
        const result = await runFixtureCheck(fixture);
        assertRuleFailure(result, "docs.platforms", relativePath);
        assert.match(outputOf(result), /CI runner table must require/u);
        assert.doesNotMatch(outputOf(result), /missing exact CI runner line/u);
      } finally {
        await restore();
      }
      await assertRestored("restored platform table runner");
    });

    for (const relativePath of [
      "README.md",
      "docs/DEVELOPMENT.md",
      "docs/PLATFORMS.md",
    ]) {
      await t.test(`fixed runner line identifies ${relativePath}`, async () => {
        const restore = await replaceFile(
          fixture.root,
          relativePath,
          (content) =>
            content.replace(
              CI_RUNNER_DOCUMENTATION_LINE,
              CI_RUNNER_DOCUMENTATION_LINE.replace(
                "macos-15-intel",
                "macos-14-intel",
              ),
            ),
        );
        try {
          const result = await runFixtureCheck(fixture);
          assertRuleFailure(result, "docs.platforms", relativePath);
          assert.match(
            outputOf(result),
            /expected exactly one CI runner line, found 0/u,
          );
        } finally {
          await restore();
        }
        await assertRestored(`restored fixed runner line in ${relativePath}`);
      });
    }

    await t.test("fixed runner line rejects a duplicate", async () => {
      const relativePath = "README.md";
      const restore = await replaceFile(
        fixture.root,
        relativePath,
        (content) => {
          const mutated = content.replace(
            CI_RUNNER_DOCUMENTATION_LINE,
            `${CI_RUNNER_DOCUMENTATION_LINE}\n${CI_RUNNER_DOCUMENTATION_LINE}`,
          );
          assert.notEqual(
            mutated,
            content,
            "line duplication must change the document",
          );
          return mutated;
        },
      );
      try {
        const result = await runFixtureCheck(fixture);
        assertRuleFailure(result, "docs.platforms", relativePath);
        assert.match(
          outputOf(result),
          /expected exactly one CI runner line, found 2/u,
        );
      } finally {
        await restore();
      }
      await assertRestored("restored duplicate fixed runner line");
    });

    for (const digestCase of [
      {
        name: "wrong workflow digest constant fails independently",
        constantName: "EXPECTED_CI_SHA256",
        rule: "ci.contract",
        expectedPath: ".github/workflows/ci.yml",
        message: /workflow digest differs/u,
      },
      {
        name: "wrong control-corpus digest constant fails independently",
        constantName: "EXPECTED_CONTROL_CORPUS_SHA256",
        rule: "repo.controls",
        expectedPath: "tests/repository.test.mjs",
        message: /negative-control corpus differs/u,
      },
    ]) {
      await t.test(digestCase.name, async () => {
        const restore = await replaceExpectedDigest(
          fixture.root,
          digestCase.constantName,
          "0".repeat(64),
        );
        try {
          const result = await runFixtureCheck(fixture);
          assertRuleFailure(result, digestCase.rule, digestCase.expectedPath);
          assert.match(outputOf(result), digestCase.message);
        } finally {
          await restore();
        }
        await assertRestored(`restored ${digestCase.name}`);
      });
    }

    await t.test(
      "whitespace-padded LF policy is not the exact policy",
      async () => {
        const restore = await replaceFile(
          fixture.root,
          ".gitattributes",
          (content) =>
            content.replace("* text=auto eol=lf", "  * text=auto eol=lf  "),
        );
        try {
          assertRuleFailure(
            await runFixtureCheck(fixture),
            "repo.lineEndings",
            ".gitattributes",
          );
        } finally {
          await restore();
        }
        await assertRestored("restored exact LF policy");
      },
    );
  } finally {
    await restoreControlDigest();
    await fixture.cleanup();
  }
});

test("0006 eval contract rejects removed gates and vacuous baselines", async (t) => {
  const fixture = await copyRepositoryToTemporaryDirectory();
  const restoreControlDigest = await refreshFixtureControlCorpusDigest(
    fixture.root,
  );
  const assertRestored = async (label) => {
    assertClean(await runFixtureCheck(fixture), label);
  };

  try {
    await assertRestored("0006 fixture before planting violations");

    const cases = [
      {
        name: "eval removed from root entries",
        rule: "repo.root",
        expectedPath: "eval",
        async apply(root) {
          return replaceFile(root, "scripts/check-repo.mjs", (content) =>
            content.replace('  "eval",\n', ""),
          );
        },
      },
      {
        name: "eval root script removed",
        rule: "pkg.manifest",
        expectedPath: "package.json",
        async apply(root) {
          return mutateJson(root, "package.json", (manifest) => {
            delete manifest.scripts.eval;
          });
        },
      },
      {
        name: "eval CI step removed",
        rule: "ci.contract",
        expectedPath: ".github/workflows/ci.yml",
        async apply(root) {
          return mutateWorkflowAndRefreshDigest(root, (content) =>
            content.replace(
              "      - name: Run deterministic eval regression\n        run: pnpm run eval\n\n",
              "",
            ),
          );
        },
      },
      {
        name: "eval baseline threshold made vacuous",
        rule: "eval.baseline",
        expectedPath: "eval/baseline.json",
        async apply(root) {
          return mutateJson(root, "eval/baseline.json", (baseline) => {
            baseline.min_passed = 0;
            baseline.max_failed = 999;
          });
        },
      },
      {
        name: "wrong control-corpus digest",
        rule: "repo.controls",
        expectedPath: "tests/repository.test.mjs",
        async apply(root) {
          return replaceExpectedDigest(
            root,
            "EXPECTED_CONTROL_CORPUS_SHA256",
            "0".repeat(64),
          );
        },
      },
    ];

    for (const negativeCase of cases) {
      await t.test(negativeCase.name, async () => {
        const restore = await negativeCase.apply(fixture.root);
        try {
          const result = await runFixtureCheck(fixture);
          assertRuleFailure(
            result,
            negativeCase.rule,
            negativeCase.expectedPath,
          );
        } finally {
          await restore();
        }
        await assertRestored(`restored ${negativeCase.name}`);
      });
    }
  } finally {
    await restoreControlDigest();
    await fixture.cleanup();
  }
});

test("0004 release-smoke contract rejects drift and extra workflows", async (t) => {
  const fixture = await copyRepositoryToTemporaryDirectory();
  const restoreControlDigest = await refreshFixtureControlCorpusDigest(
    fixture.root,
  );
  const assertRestored = async (label) => {
    assertClean(await runFixtureCheck(fixture), label);
  };

  try {
    await assertRestored("0004 fixture before planting violations");

    const cases = [
      {
        name: "release-smoke matrix rejects an omitted runner",
        transform: (content) =>
          content.replace("          - ubuntu-24.04-arm\n", ""),
        message:
          /release-smoke matrix must require ubuntu-24\.04, ubuntu-24\.04-arm, ubuntu-26\.04, macos-15, macos-15-intel, macos-26/u,
      },
      {
        name: "release-smoke rejects a push trigger",
        transform: (content) =>
          content.replace(
            "on:\n  workflow_dispatch:\n    inputs:\n      version:\n        description: Published codepunk-cli version, for example 0.1.0\n        required: true\n        type: string\n",
            "on:\n  push:\n",
          ),
        message: /only workflow_dispatch may trigger the release smoke/u,
      },
      {
        name: "release-smoke rejects an unreviewed Windows runner",
        transform: (content) =>
          content.replace(
            "          - macos-26\n",
            "          - macos-26\n          - windows-latest\n",
          ),
        message:
          /release-smoke matrix must require ubuntu-24\.04, ubuntu-24\.04-arm, ubuntu-26\.04, macos-15, macos-15-intel, macos-26/u,
      },
      {
        name: "release-smoke rejects an npm publish step",
        transform: (content) =>
          content.replace(
            "      - name: Run published-package smoke\n",
            "      - name: Publish\n        run: npm publish\n\n      - name: Run published-package smoke\n",
          ),
        message:
          /release smoke contains a publish command, secret reference, or non-blocking step/u,
      },
    ];

    for (const testCase of cases) {
      await t.test(testCase.name, async () => {
        const restore = await mutateReleaseSmokeAndRefreshDigest(
          fixture.root,
          testCase.transform,
        );
        try {
          const result = await runFixtureCheck(fixture);
          assertRuleFailure(
            result,
            "release-smoke",
            ".github/workflows/release-smoke.yml",
          );
          assert.match(outputOf(result), testCase.message);
        } finally {
          await restore();
        }
        await assertRestored(`restored ${testCase.name}`);
      });
    }

    await t.test("stale release-smoke digest fails first", async () => {
      const restore = await replaceExpectedDigest(
        fixture.root,
        "EXPECTED_RELEASE_SMOKE_SHA256",
        "0".repeat(64),
      );
      try {
        const result = await runFixtureCheck(fixture);
        assertRuleFailure(
          result,
          "release-smoke",
          ".github/workflows/release-smoke.yml",
        );
        assert.match(outputOf(result), /workflow digest differs/u);
      } finally {
        await restore();
      }
      await assertRestored("restored release-smoke digest");
    });

    await t.test("a third workflow is still rejected", async () => {
      const remove = await createFileFixture(
        fixture.root,
        ".github/workflows/unreviewed.yml",
        "name: unreviewed\n",
      );
      try {
        const result = await runFixtureCheck(fixture);
        assertRuleFailure(
          result,
          "ci.contract",
          ".github/workflows/unreviewed.yml",
        );
      } finally {
        await remove();
      }
      await assertRestored("removed the third workflow");
    });

    await t.test("a missing release-smoke workflow is rejected", async () => {
      const relativePath = ".github/workflows/release-smoke.yml";
      const absolutePath = path.join(fixture.root, relativePath);
      const original = await readFile(absolutePath);
      await rm(absolutePath);
      try {
        const result = await runFixtureCheck(fixture);
        assertRuleFailure(result, "release-smoke", relativePath);
        assert.match(
          outputOf(result),
          /reviewed release-smoke workflow is missing/u,
        );
      } finally {
        await writeFile(absolutePath, original);
      }
      await assertRestored("restored the release-smoke workflow");
    });
  } finally {
    await restoreControlDigest();
    await fixture.cleanup();
  }
});

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

test("symlinked checker invocation is not a silent no-op", async (t) => {
  if (!(await canCreateFileSymlink())) {
    t.skip(FILE_SYMLINK_SKIP_REASON);
    return;
  }
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

test("ignored deja runtime state is scanned but not rejected", async () => {
  const fixture = await copyRepositoryToTemporaryDirectory();
  try {
    const removeState = await createDirectoryFixture(
      fixture.root,
      ".deja",
      "session.json",
      '{"session":"local"}\n',
    );
    assertClean(runCheck(fixture.root), "ignored deja runtime state");

    const accessKey = ["AK", "IA"].join("") + "A".repeat(16);
    const removeSecret = await createFileFixture(
      fixture.root,
      ".deja/session-evidence.txt",
      `Fixture value: ${accessKey}\n`,
    );
    try {
      assertRuleFailure(
        runCheck(fixture.root),
        "security.credential",
        ".deja/session-evidence.txt",
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
