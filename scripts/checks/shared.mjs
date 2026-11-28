import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export function npmExecutable(environment = process.env) {
  if (process.platform !== "win32") {
    return { command: "npm", prefixArgs: [] };
  }
  const candidates = [];
  const execPath = environment["npm_execpath"];
  if (
    execPath !== undefined &&
    path.basename(execPath).toLowerCase() === "npm-cli.js"
  ) {
    candidates.push(execPath);
  }
  candidates.push(
    path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
    path.join(
      path.dirname(process.execPath),
      "..",
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  );
  const cli = candidates.find((candidate) => existsSync(candidate));
  return cli === undefined
    ? { command: "npm", prefixArgs: [] }
    : { command: process.execPath, prefixArgs: [cli] };
}

export const ROOT_ENTRIES = new Set([
  ".editorconfig",
  ".github",
  ".gitattributes",
  ".gitignore",
  ".node-version",
  ".prettierignore",
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "docs",
  "eslint.config.mjs",
  "eval",
  "package.json",
  "packages",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts",
  "tests",
  "tsconfig.base.json",
  "tsconfig.json",
]);

export const TRANSIENT_ROOT_ENTRY = /^_tmp_\d+_[a-z0-9]{8}$/u;
export const TRANSIENT_ROOT_SETTLE_MS = 1_000;
export const WORKTREES_ROOT_ENTRY = ".worktrees";

export const REQUIRED_PRODUCT_FILES = [
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "AGENTS.md",
  ".node-version",
  "eslint.config.mjs",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  ".gitignore",
  ".github/workflows/ci.yml",
  "docs/ARCHITECTURE.md",
  "docs/DEVELOPMENT.md",
  "packages/protocol/README.md",
  "packages/core/README.md",
  "packages/cli/README.md",
  "packages/cli/build.mjs",
  "tests/repository.test.mjs",
];

export const REVIEWED_CATALOG = {
  "@anthropic-ai/sandbox-runtime": "0.0.82",
  "@earendil-works/pi-ai": "1.6.0",
  "@earendil-works/pi-coding-agent": "1.6.0",
  "@earendil-works/pi-mcp": "1.6.0",
  "@earendil-works/pi-tui": "1.6.0",
  "@eslint/js": "10.0.1",
  "@types/node": "22.19.1",
  "@typescript/native": "npm:typescript@7.0.2",
  esbuild: "0.25.11",
  eslint: "10.15.0",
  "eslint-plugin-import-x": "4.18.1",
  "node-pty": "1.1.0",
  prettier: "3.10.1",
  typebox: "1.3.27",
  typescript: "npm:@typescript/typescript6@6.0.2",
  "typescript-eslint": "8.74.0",
};

export const PACKAGE_SPECS = [
  {
    dir: "packages/protocol",
    name: "codepunk-protocol",
    layer: 0,
    publishable: false,
    buildScript: "tsc -b",
    typecheckPaths: {},
    external: ["typebox"],
    internal: [],
  },
  {
    dir: "packages/core",
    name: "codepunk-core",
    layer: 1,
    publishable: false,
    buildScript: "tsc -b",
    typecheckPaths: {
      "codepunk-protocol": ["../protocol/src/index.ts"],
    },
    external: [
      "@anthropic-ai/sandbox-runtime",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-mcp",
    ],
    internal: ["codepunk-protocol"],
  },
  {
    dir: "packages/cli",
    name: "codepunk-cli",
    layer: 2,
    publishable: true,
    buildScript: "tsc -b && node build.mjs",
    bundledExtras: [
      {
        output: "dist/host-child.js",
        source: "packages/core/src/plugin/host-child.ts",
      },
    ],
    typecheckPaths: {
      "codepunk-protocol": ["../protocol/src/index.ts"],
      "codepunk-core": ["../core/src/index.ts"],
    },
    external: [
      "@anthropic-ai/sandbox-runtime",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-mcp",
      "@earendil-works/pi-tui",
    ],
    internal: ["codepunk-core", "codepunk-protocol"],
    buildDevDependencies: ["esbuild"],
  },
];

export const PACKAGE_BY_NAME = new Map(
  PACKAGE_SPECS.map((spec) => [spec.name, spec]),
);

export const ROOT_DEV_DEPENDENCIES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@eslint/js",
  "@types/node",
  "@typescript/native",
  "eslint",
  "eslint-plugin-import-x",
  "node-pty",
  "prettier",
  "typescript",
  "typescript-eslint",
];

export const REVIEWED_INSTALL_SCRIPTS = new Map([
  ["@google/genai@2.32.0", "no-op preinstall; install scripts remain disabled"],
  ["koffi@3.3.8", "native prebuild/build; install scripts remain disabled"],
  ["node-pty@1.1.0", "native prebuild/build; install scripts remain disabled"],
  ["protobufjs@7.6.6", "postinstall script; install scripts remain disabled"],
]);

export const REVIEWED_COMPUTED_IMPORTS = new Map([
  [
    "packages/core/src/plugin/host-child.ts",
    {
      argument: /^entryUrl$/u,
      anchors: [
        /\bverifyLaunch\(\)/u,
        /const entryPath = path\.resolve\(entry\);/u,
        /const entryUrl = pathToFileURL\(entryPath\)\.href;/u,
      ],
      reason:
        "loads the manifest-validated plugin entry inside the isolated child",
    },
  ],
  [
    "packages/core/dist/plugin/host-child.js",
    {
      argument: /^(?:__rewriteRelativeImportExtension\()?entryUrl\)?$/u,
      anchors: [
        /\bverifyLaunch\(\)/u,
        /const entryPath = path\.resolve\(entry\);/u,
        /const entryUrl = pathToFileURL\(entryPath\)\.href;/u,
      ],
      reason:
        "loads the manifest-validated plugin entry inside the isolated child",
    },
  ],
  [
    "packages/cli/src/tui/host-commands.ts",
    {
      argument: /^moduleUrl$/u,
      anchors: [
        /\bgetPackageDir\b/u,
        /const modulePath = path\.join\(\s*getPackageDir\(\),\s*"dist",\s*"core",\s*"slash-commands\.js",?\s*\);/u,
        /const moduleUrl = pathToFileURL\(modulePath\)\.href;/u,
      ],
      reason:
        "loads Pi's installed builtin slash table because the package root does not export it",
    },
  ],
  [
    "packages/cli/dist/tui/host-commands.js",
    {
      argument: /^__rewriteRelativeImportExtension\(moduleUrl$/u,
      anchors: [
        /\bgetPackageDir\b/u,
        /const modulePath = path\.join\(\s*getPackageDir\(\),\s*"dist",\s*"core",\s*"slash-commands\.js",?\s*\);/u,
        /const moduleUrl = pathToFileURL\(modulePath\)\.href;/u,
      ],
      reason:
        "TypeScript wraps the reviewed Pi slash-table import with its relative-extension helper",
    },
  ],
]);

export const CLI_SOURCE_FILE_LIMIT = 600;
export const CLI_FUNCTION_LIMIT = 150;
export const CORE_SOURCE_FILE_LIMIT = 1500;
export const CLI_SIZE_EXEMPTIONS = new Map([
  [
    "packages/cli/src/subagent-transcript.ts",
    "spec 0014 §2.1 keeps the standalone transcript browser in place; splitting it belongs to the TUI renderer spec",
  ],
]);

export const EXPECTED_CI_RUNNERS = ["macos-15", "windows-latest"];

export const EXPECTED_FULL_CI_RUNNERS = [
  "ubuntu-24.04",
  "ubuntu-24.04-arm",
  "ubuntu-26.04",
  "macos-15",
  "macos-15-intel",
  "macos-26",
  "windows-latest",
];

export const EXPECTED_RELEASE_SMOKE_RUNNERS = EXPECTED_FULL_CI_RUNNERS.filter(
  (runner) => runner !== "windows-latest",
);

export const EXPECTED_ROOT_SCRIPTS = {
  build: "tsc -b && node packages/cli/build.mjs",
  check: "node scripts/check-repo.mjs",
  eval: "node eval/run.mjs",
  format: "prettier --write . --ignore-path .prettierignore",
  "format:check": "prettier --check . --ignore-path .prettierignore",
  lint: "eslint .",
  test: "node --test --test-timeout=300000 tests/*.test.mjs",
  "test:compat": "node --test --test-timeout=300000 tests/compat.test.mjs",
  "test:coverage":
    "node --test --experimental-test-coverage --test-timeout=300000 tests/*.test.mjs",
  "test:pty": "node scripts/run-tests.mjs pty",
  "test:repo":
    "node --test --test-timeout=300000 tests/repository.test.mjs tests/cli-surface.test.mjs",
  "test:unit": "node scripts/run-tests.mjs unit",
  typecheck:
    "pnpm --filter codepunk-protocol typecheck && pnpm --filter codepunk-core typecheck && pnpm --filter codepunk-cli typecheck",
  verify:
    "pnpm run format:check && pnpm run lint && pnpm run check && pnpm run typecheck && pnpm test && pnpm run build && node scripts/check-repo.mjs --require-built",
};

export const PROHIBITED_LIFECYCLE_SCRIPTS = new Set([
  "install",
  "postinstall",
  "preinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
]);

export const PROHIBITED_ROOT_KEYS = new Set([
  "bundleDependencies",
  "bundledDependencies",
  "overrides",
  "resolutions",
]);

export const CI_RUN_COMMANDS = [
  "pnpm install --frozen-lockfile --ignore-scripts",
  "bash scripts/ci-install-sandbox-deps.sh",
  "pnpm run format:check",
  "pnpm run lint",
  "pnpm run check",
  "pnpm run typecheck",
  "pnpm test",
  "pnpm run eval",
  "pnpm run build",
  "node scripts/check-repo.mjs --require-built",
];

export const LOCAL_STATE_DIRECTORIES = new Set([
  ".codepunk",
  ".deja",
  ".idea",
  ".nyc_output",
  ".pi",
  ".vscode",
]);

export const IGNORED_PRODUCT_STATE_DIRECTORIES = new Set([
  ".codepunk",
  ".deja",
]);

export const RUNTIME_STATE_DIRECTORIES = new Set([
  "artifacts",
  "cache",
  "evidence",
  "logs",
  "sessions",
]);

export const RESEARCH_ARTIFACT_DIRECTORIES = new Set([
  "archive",
  "demo",
  "probe",
  "research",
  "screenshots",
  "spike",
  "verify",
]);

export const GENERATED_DIRECTORIES = new Set([
  "build",
  "coverage",
  "dist",
  "node_modules",
  "tmp",
]);

export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const EXACT_NPM_ALIAS =
  /^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;
export const NODE_ENGINE = ">=22.19.0";
export const EXPECTED_NODE_VERSION = "22.19.0";
export const EXPECTED_PACKAGE_MANAGER = "pnpm@12.18.0";
export const EXPECTED_WORKSPACE_GLOB = "packages/*";

export function toPosix(value) {
  return value.split(path.sep).join("/");
}

export function projectPath(root, absolutePath) {
  return toPosix(path.relative(root, absolutePath));
}

export function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function isExactVersion(value) {
  return typeof value === "string" && EXACT_VERSION.test(value);
}

export function parseCatalogSpec(name, value) {
  if (typeof value !== "string") {
    return null;
  }
  if (EXACT_VERSION.test(value)) {
    return { packageName: name, version: value, isAlias: false };
  }
  const alias = EXACT_NPM_ALIAS.exec(value);
  if (alias !== null) {
    return { packageName: alias[1], version: alias[2], isAlias: true };
  }
  return null;
}

export function ownKeys(value) {
  return value && typeof value === "object" ? Object.keys(value) : [];
}

export function sorted(value) {
  return [...value].sort((left, right) => left.localeCompare(right));
}

export function sameSet(left, right) {
  const leftSorted = sorted(left);
  const rightSorted = sorted(right);
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  );
}

export function sameOrderedArray(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function sameStringArrayMap(actual, expected) {
  const actualNames = sorted(ownKeys(actual));
  const expectedNames = sorted(ownKeys(expected));
  if (!sameSet(actualNames, expectedNames)) {
    return false;
  }
  return expectedNames.every((name) => {
    const actualValues = actual[name];
    const expectedValues = expected[name];
    return (
      Array.isArray(actualValues) &&
      Array.isArray(expectedValues) &&
      actualValues.length === expectedValues.length &&
      actualValues.every((value, index) => value === expectedValues[index])
    );
  });
}

export async function readJson(root, relativePath, add) {
  const absolutePath = path.join(root, relativePath);
  try {
    return JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    add("repo.internal", relativePath, `cannot read JSON: ${error.message}`);
    return undefined;
  }
}

export function gitFiles(root, args) {
  const output = execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.split("\0").filter(Boolean);
}

export function isGitRepository(root) {
  return existsSync(path.join(root, ".git"));
}

export function isGitIgnored(root, relativePath) {
  if (!isGitRepository(root)) {
    return false;
  }
  const result = spawnSync(
    "git",
    ["-C", root, "check-ignore", "-q", "--", relativePath],
    { stdio: "ignore" },
  );
  return result.status === 0;
}

export function collectTrackedDirectories(tracked) {
  const directories = new Set();
  for (const relativePath of tracked) {
    const segments = relativePath.split("/");
    segments.pop();
    let current = "";
    for (const segment of segments) {
      current = current === "" ? segment : `${current}/${segment}`;
      directories.add(current);
    }
  }
  return directories;
}

export async function walkFiles(root, directoriesWithTrackedFiles) {
  const files = [];

  async function walk(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.name === ".git") {
        continue;
      }
      if (
        entry.name === "node_modules" &&
        !directoriesWithTrackedFiles.has(relativePath)
      ) {
        continue;
      }
      if (directory === root && TRANSIENT_ROOT_ENTRY.test(entry.name)) {
        continue;
      }
      if (directory === root && entry.name === WORKTREES_ROOT_ENTRY) {
        continue;
      }
      if (
        entry.isDirectory() &&
        !directoriesWithTrackedFiles.has(relativePath) &&
        GENERATED_DIRECTORIES.has(entry.name.toLowerCase()) &&
        isGitIgnored(root, relativePath)
      ) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push(projectPath(root, absolutePath));
      }
    }
  }

  await walk(root, "");
  return files;
}

export async function listFiles(root) {
  const tracked = isGitRepository(root)
    ? gitFiles(root, ["ls-files", "--cached", "-z"])
    : [];
  const trackedDirectories = collectTrackedDirectories(tracked);
  return {
    tracked,
    trackedDirectories,
    scanned: await walkFiles(root, trackedDirectories),
  };
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
