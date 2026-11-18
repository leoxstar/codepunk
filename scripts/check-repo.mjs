#!/usr/bin/env node

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createScanner,
  LanguageVariant,
  SyntaxKind,
} from "typescript/unstable/ast";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const execFileAsync = promisify(execFile);

const ROOT_ENTRIES = new Set([
  ".github",
  ".gitattributes",
  ".gitignore",
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "docs",
  "package.json",
  "packages",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts",
  "tests",
  "tsconfig.json",
]);

// pnpm creates and removes this directory in the repository root while
// packing a workspace. It is not product content, but a directory with the
// same shape that persists is still an unreviewed root entry.
const TRANSIENT_ROOT_ENTRY = /^_tmp_\d+_[a-z0-9]{8}$/u;
const TRANSIENT_ROOT_SETTLE_MS = 1_000;

const REQUIRED_PRODUCT_FILES = [
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "AGENTS.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  ".gitignore",
  ".github/workflows/ci.yml",
  "docs/ARCHITECTURE.md",
  "docs/DEVELOPMENT.md",
  "packages/protocol/README.md",
  "packages/core/README.md",
  "packages/cli/README.md",
  "tests/repository.test.mjs",
];

const PACKAGE_SPECS = [
  {
    dir: "packages/protocol",
    name: "@codepunk/protocol",
    layer: 0,
    typecheckPaths: {},
    external: {
      typebox: "1.3.27",
    },
    internal: [],
  },
  {
    dir: "packages/core",
    name: "@codepunk/core",
    layer: 1,
    typecheckPaths: {
      "@codepunk/protocol": ["../protocol/src/index.ts"],
    },
    external: {
      "@anthropic-ai/sandbox-runtime": "0.0.82",
      "@earendil-works/pi-ai": "1.5.2",
      "@earendil-works/pi-coding-agent": "1.5.2",
      "@earendil-works/pi-mcp": "1.5.2",
    },
    internal: ["@codepunk/protocol"],
  },
  {
    dir: "packages/cli",
    name: "@codepunk/cli",
    layer: 2,
    typecheckPaths: {
      "@codepunk/protocol": ["../protocol/src/index.ts"],
      "@codepunk/core": ["../core/src/index.ts"],
    },
    external: {
      "@earendil-works/pi-coding-agent": "1.5.2",
      "@earendil-works/pi-tui": "1.5.2",
    },
    internal: ["@codepunk/core", "@codepunk/protocol"],
  },
];

const PACKAGE_BY_NAME = new Map(PACKAGE_SPECS.map((spec) => [spec.name, spec]));

const ROOT_DEV_DEPENDENCIES = {
  "@earendil-works/pi-ai": "1.5.2",
  "@earendil-works/pi-coding-agent": "1.5.2",
  "@types/node": "22.19.1",
  "node-pty": "1.1.0",
  prettier: "3.10.1",
  typescript: "7.0.2",
};

const REVIEWED_EXTERNAL_VERSIONS = new Map([
  ...PACKAGE_SPECS.flatMap((spec) => Object.entries(spec.external)),
  ...Object.entries(ROOT_DEV_DEPENDENCIES),
]);

const REVIEWED_INSTALL_SCRIPTS = new Map([
  ["@google/genai@2.21.0", "no-op preinstall; install scripts remain disabled"],
  ["koffi@3.3.8", "native prebuild/build; install scripts remain disabled"],
  ["node-pty@1.1.0", "native prebuild/build; install scripts remain disabled"],
  ["protobufjs@7.6.6", "postinstall script; install scripts remain disabled"],
]);

const REVIEWED_COMPUTED_IMPORTS = new Map([
  [
    "packages/cli/src/tui.ts",
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
    "packages/cli/dist/tui.js",
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

const EXPECTED_LOCKFILE_SHA256 =
  "a525e3148f8139c3b02189b39d350333c3fd8d99f08f810978196679497a5c32";

const EXPECTED_CI_SHA256 =
  "21c9daa3d98d65a4c7da8cd6149b6ecc892873a51d148e0fe366102cd9037922";

const EXPECTED_CI_RUNNERS = [
  "ubuntu-24.04",
  "ubuntu-24.04-arm",
  "ubuntu-26.04",
  "macos-15",
  "macos-15-intel",
  "macos-26",
  "windows-latest",
];

const RELEASE_SMOKE_PATH = ".github/workflows/release-smoke.yml";

const EXPECTED_RELEASE_SMOKE_SHA256 =
  "413ede79bf04146aa1571a616eb3888e0c2b5c5da6065f9869213e6742ec0552";

const EXPECTED_RELEASE_SMOKE_RUNNERS = EXPECTED_CI_RUNNERS.filter(
  (runner) => runner !== "windows-latest",
);

const EXPECTED_CONTROL_CORPUS_SHA256 =
  "1a38a177dc016df21b2418d2073fe27bd5360e3c6ef0b285b292fb4ddd9ba66d";

const EXPECTED_ROOT_SCRIPTS = {
  build:
    "pnpm --filter @codepunk/protocol build && pnpm --filter @codepunk/core build && pnpm --filter @codepunk/cli build",
  check: "node scripts/check-repo.mjs",
  format: "prettier --write . --ignore-path .gitignore",
  "format:check": "prettier --check . --ignore-path .gitignore",
  test: "node --test tests/*.test.mjs",
  typecheck:
    "pnpm --filter @codepunk/protocol typecheck && pnpm --filter @codepunk/core typecheck && pnpm --filter @codepunk/cli typecheck",
  verify:
    "pnpm run format:check && pnpm run check && pnpm run typecheck && pnpm test && pnpm run build && node scripts/check-repo.mjs --require-built",
};

const PROHIBITED_LIFECYCLE_SCRIPTS = new Set([
  "install",
  "postinstall",
  "preinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
]);

const PROHIBITED_ROOT_KEYS = new Set([
  "bundleDependencies",
  "bundledDependencies",
  "overrides",
  "resolutions",
]);

const CI_RUN_COMMANDS = [
  "pnpm install --frozen-lockfile --ignore-scripts",
  "bash scripts/ci-install-sandbox-deps.sh",
  "pnpm run format:check",
  "pnpm run check",
  "pnpm run typecheck",
  "pnpm test",
  "pnpm run build",
  "node scripts/check-repo.mjs --require-built",
];

const LOCAL_STATE_DIRECTORIES = new Set([
  ".codepunk",
  ".deja",
  ".idea",
  ".nyc_output",
  ".pi",
  ".vscode",
]);

const IGNORED_PRODUCT_STATE_DIRECTORIES = new Set([".codepunk", ".deja"]);

const RUNTIME_STATE_DIRECTORIES = new Set([
  "artifacts",
  "cache",
  "evidence",
  "logs",
  "sessions",
]);

const RESEARCH_ARTIFACT_DIRECTORIES = new Set([
  "archive",
  "demo",
  "probe",
  "research",
  "screenshots",
  "spike",
  "verify",
]);

const GENERATED_DIRECTORIES = new Set([
  "build",
  "coverage",
  "dist",
  "node_modules",
  "tmp",
]);

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const NODE_ENGINE = ">=22.19.0";
const EXPECTED_PACKAGE_MANAGER = "pnpm@12.18.0";
const EXPECTED_WORKSPACE_GLOB = "packages/*";

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function projectPath(root, absolutePath) {
  return toPosix(path.relative(root, absolutePath));
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isExactVersion(value) {
  return typeof value === "string" && EXACT_VERSION.test(value);
}

function ownKeys(value) {
  return value && typeof value === "object" ? Object.keys(value) : [];
}

function sorted(value) {
  return [...value].sort((left, right) => left.localeCompare(right));
}

function sameSet(left, right) {
  const leftSorted = sorted(left);
  const rightSorted = sorted(right);
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  );
}

function sameStringArrayMap(actual, expected) {
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

async function readJson(root, relativePath, add) {
  const absolutePath = path.join(root, relativePath);
  try {
    return JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    add("repo.internal", relativePath, `cannot read JSON: ${error.message}`);
    return undefined;
  }
}

function gitFiles(root, args) {
  const output = execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.split("\0").filter(Boolean);
}

function isGitRepository(root) {
  return existsSync(path.join(root, ".git"));
}

function isGitIgnored(root, relativePath) {
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

function collectTrackedDirectories(tracked) {
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

async function walkFiles(root, directoriesWithTrackedFiles) {
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
      // An installed node_modules tree is skipped, but a tracked file inside
      // one is still part of the product and must reach the content and
      // import scans.
      if (
        entry.name === "node_modules" &&
        !directoriesWithTrackedFiles.has(relativePath)
      ) {
        continue;
      }
      if (directory === root && TRANSIENT_ROOT_ENTRY.test(entry.name)) {
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

async function listFiles(root) {
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

function hasForbiddenSegment(relativePath) {
  const packageSource = isPackageSourcePath(relativePath);
  const productPackage = isProductPackagePath(relativePath);
  for (const rawSegment of relativePath.split("/")) {
    const segment = rawSegment.toLowerCase();
    if (
      // A package source tree may name a directory build, dist, or tmp, but a
      // tracked node_modules is an installed tree and never belongs in Git.
      segment === "node_modules" ||
      (RESEARCH_ARTIFACT_DIRECTORIES.has(segment) && !productPackage) ||
      LOCAL_STATE_DIRECTORIES.has(segment) ||
      (!packageSource &&
        (RUNTIME_STATE_DIRECTORIES.has(segment) ||
          GENERATED_DIRECTORIES.has(segment)))
    ) {
      return segment;
    }
  }
  return undefined;
}

function isPackageSourcePath(relativePath) {
  const segments = relativePath.toLowerCase().split("/");
  return segments[0] === "packages" && segments[2] === "src";
}

function isProductPackagePath(relativePath) {
  return relativePath.toLowerCase().split("/")[0] === "packages";
}

function isForbiddenDirectory(relativePath, name) {
  const normalizedName = name.toLowerCase();
  if (
    (RESEARCH_ARTIFACT_DIRECTORIES.has(normalizedName) &&
      !isProductPackagePath(relativePath)) ||
    LOCAL_STATE_DIRECTORIES.has(normalizedName)
  ) {
    return true;
  }
  if (isPackageSourcePath(relativePath)) {
    return false;
  }
  return (
    RUNTIME_STATE_DIRECTORIES.has(normalizedName) ||
    GENERATED_DIRECTORIES.has(normalizedName)
  );
}

function classifyForbiddenFile(name) {
  const normalizedName = name.toLowerCase();
  if (
    normalizedName === ".envrc" ||
    (normalizedName.startsWith(".env.") &&
      normalizedName !== ".env.example" &&
      normalizedName !== ".env.template") ||
    normalizedName === ".env"
  ) {
    return ["hygiene.env", "local environment file"];
  }
  if (
    normalizedName === ".npmrc" ||
    normalizedName === ".netrc" ||
    normalizedName === "auth.json" ||
    normalizedName === "credentials.json" ||
    normalizedName.endsWith(".local") ||
    normalizedName.endsWith(".local.toml")
  ) {
    return ["hygiene.env", "local configuration or credential file"];
  }
  if (
    normalizedName === ".ds_store" ||
    normalizedName === "thumbs.db" ||
    normalizedName.endsWith(".bak") ||
    normalizedName.endsWith(".log") ||
    normalizedName.endsWith(".tgz") ||
    normalizedName.endsWith(".tmp") ||
    normalizedName.endsWith(".tsbuildinfo")
  ) {
    return ["hygiene.forbidden", "generated, log, or local editor artifact"];
  }
  return undefined;
}

async function scanWorkingTreeHygiene(root, add, directoriesWithTrackedFiles) {
  async function walk(directory, relativeDirectory, insideGenerated = false) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(directory, entry.name);

      const normalizedName = entry.name.toLowerCase();
      if (normalizedName === ".git") {
        continue;
      }
      if (
        normalizedName === "node_modules" &&
        !directoriesWithTrackedFiles.has(relativePath)
      ) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        add(
          "hygiene.forbidden",
          relativePath,
          "symbolic links are not permitted in the product tree",
        );
        continue;
      }
      if (
        !relativeDirectory &&
        entry.isDirectory() &&
        TRANSIENT_ROOT_ENTRY.test(entry.name)
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        if (
          !insideGenerated &&
          isForbiddenDirectory(relativePath, entry.name)
        ) {
          if (
            (GENERATED_DIRECTORIES.has(normalizedName) ||
              IGNORED_PRODUCT_STATE_DIRECTORIES.has(normalizedName)) &&
            isGitIgnored(root, relativePath)
          ) {
            await walk(absolutePath, relativePath, true);
            continue;
          }
          add(
            "hygiene.forbidden",
            relativePath,
            `forbidden directory "${entry.name}"`,
          );
          continue;
        }
        await walk(absolutePath, relativePath, insideGenerated);
        continue;
      }
      if (entry.isFile()) {
        const classification = classifyForbiddenFile(entry.name);
        if (classification) {
          add(classification[0], relativePath, classification[1]);
        }
      }
    }
  }

  await walk(root, "");
}

async function settleTransientRootEntries(root) {
  const deadline = Date.now() + TRANSIENT_ROOT_SETTLE_MS;
  do {
    const entries = await readdir(root);
    if (!entries.some((entry) => TRANSIENT_ROOT_ENTRY.test(entry))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
}

async function checkRootEntries(root, add) {
  await settleTransientRootEntries(root);
  const entries = (await readdir(root, { withFileTypes: true })).map(
    (entry) => entry.name,
  );

  for (const entry of entries) {
    if (entry === ".git") {
      continue;
    }
    if (ROOT_ENTRIES.has(entry)) {
      continue;
    }
    if (
      (GENERATED_DIRECTORIES.has(entry) ||
        IGNORED_PRODUCT_STATE_DIRECTORIES.has(entry)) &&
      isGitIgnored(root, entry)
    ) {
      continue;
    }
    add("repo.root", entry, "root entry is outside the reviewed allowlist");
  }
}

async function checkLineEndingPolicy(root, add) {
  const relativePath = ".gitattributes";
  try {
    const content = await readFile(path.join(root, relativePath), "utf8");
    const hasLfPolicy = content
      .split(/\r?\n/u)
      .some((line) => line === "* text=auto eol=lf");
    if (!hasLfPolicy) {
      add(
        "repo.lineEndings",
        relativePath,
        'missing reviewed policy "* text=auto eol=lf"',
      );
    }
  } catch (error) {
    add(
      "repo.lineEndings",
      relativePath,
      `cannot read line-ending policy: ${error.message}`,
    );
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const POSIX_USER_ROOTS = [
  ["", "Users", ""].join("/"),
  ["", "home", ""].join("/"),
];
const REGEX_BACKSLASH = String.fromCharCode(92).repeat(2);
const ABSOLUTE_USER_PATTERNS = [
  ...POSIX_USER_ROOTS.map(
    (rootPath) =>
      new RegExp(`${escapeRegExp(rootPath)}[A-Za-z0-9._-]+(?:[/\\\\]|$)`, "u"),
  ),
  new RegExp(
    `[A-Za-z]:${REGEX_BACKSLASH}Users${REGEX_BACKSLASH}[^${REGEX_BACKSLASH}s]+`,
    "u",
  ),
];

const SECRET_PATTERNS = [
  {
    name: "AWS access key",
    pattern: new RegExp(["AKIA", "[0-9A-Z]{16}"].join(""), "u"),
  },
  {
    name: "GitHub token",
    pattern: new RegExp(["gh", "[pousr]_[A-Za-z0-9]{30,}"].join(""), "u"),
  },
  {
    name: "private key block",
    pattern: new RegExp(`${["-----BEGIN ", "PRIVATE KEY-----"].join("")}`, "u"),
  },
  {
    name: "OpenAI-style key",
    pattern: new RegExp(["sk", "-[A-Za-z0-9_-]{20,}"].join(""), "u"),
  },
  {
    name: "JWT",
    pattern: new RegExp(
      ["eyJ[A-Za-z0-9_-]{8,}", "\\.eyJ[A-Za-z0-9_-]{8,}"].join("") +
        "\\.[A-Za-z0-9_-]{16,}",
      "u",
    ),
  },
  {
    name: "secret assignment",
    pattern: new RegExp(
      [
        "\\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password|secret)\\b",
        "\\s*[:=]\\s*[\"']?[A-Za-z0-9+/_=-]{16,}[\"']?",
      ].join(""),
      "iu",
    ),
  },
];

async function scanFileContents(root, files, add) {
  for (const relativePath of files) {
    let buffer;
    try {
      buffer = await readFile(path.join(root, relativePath));
    } catch (error) {
      add(
        "repo.internal",
        relativePath,
        `cannot read source file: ${error.message}`,
      );
      continue;
    }
    if (buffer.includes(0)) {
      add(
        "hygiene.binary",
        relativePath,
        "binary or NUL-containing files are not permitted in the product tree",
      );
      continue;
    }
    const content = buffer.toString("utf8");
    if (content.includes("\r")) {
      add(
        "repo.lineEndings",
        relativePath,
        "text file contains a carriage return; repository text must use LF line endings",
      );
    }

    for (const pattern of ABSOLUTE_USER_PATTERNS) {
      if (pattern.test(content)) {
        add(
          "security.absolute-path",
          relativePath,
          "contains a local personal absolute path",
        );
        break;
      }
    }

    for (const secret of SECRET_PATTERNS) {
      if (secret.pattern.test(content)) {
        add(
          "security.credential",
          relativePath,
          `contains a credential-shaped value (${secret.name})`,
        );
      }
    }
  }
}

function checkRequiredDocs(root, add) {
  for (const relativePath of REQUIRED_PRODUCT_FILES) {
    if (!existsSync(path.join(root, relativePath))) {
      add("repo.docs", relativePath, "required product file is missing");
    }
  }
}

async function checkCiContract(root, files, add) {
  const relativeCi = ".github/workflows/ci.yml";
  const absoluteCi = path.join(root, relativeCi);
  const allowedWorkflows = new Set([relativeCi, RELEASE_SMOKE_PATH]);
  for (const relativePath of files) {
    if (
      relativePath.startsWith(".github/") &&
      !allowedWorkflows.has(relativePath)
    ) {
      add(
        "ci.contract",
        relativePath,
        "only the reviewed CI and release-smoke workflows are permitted",
      );
    }
  }
  await checkReleaseSmokeContract(root, files, add);
  if (!existsSync(absoluteCi)) {
    return;
  }

  const content = await readFile(absoluteCi, "utf8");
  const digest = createHash("sha256").update(content).digest("hex");
  if (digest !== EXPECTED_CI_SHA256) {
    add(
      "ci.contract",
      relativeCi,
      "workflow digest differs from the reviewed CI contract",
    );
  }
  const runCommands = [...content.matchAll(/^\s*run:\s*(.+?)\s*$/gmu)].map(
    (match) => match[1],
  );
  if (!sameSet(runCommands, CI_RUN_COMMANDS)) {
    add(
      "ci.contract",
      relativeCi,
      "CI run commands differ from the reviewed gate sequence",
    );
  }

  const matrixMatch = content.match(
    /\n[ \t]+os:[ \t]*\n((?:[ \t]+-[ \t]+\S+[ \t]*\n?)+)/u,
  );
  const runners = matrixMatch?.[1]
    ? [...matrixMatch[1].matchAll(/-\s+(\S+)/gu)].map((match) => match[1])
    : [];
  if (
    runners.length !== EXPECTED_CI_RUNNERS.length ||
    !runners.every((runner, index) => runner === EXPECTED_CI_RUNNERS[index])
  ) {
    add(
      "ci.contract",
      relativeCi,
      `CI matrix must require ${EXPECTED_CI_RUNNERS.join(", ")}`,
    );
  }

  for (const required of [
    "permissions:\n  contents: read",
    "runs-on: ${{ matrix.os }}",
    "node-version: 22.19.0",
    "uses: actions/checkout@v4",
    "uses: pnpm/action-setup@v4",
    "uses: actions/setup-node@v4",
    "cache: pnpm",
    "version: 12.18.0",
  ]) {
    if (!content.includes(required)) {
      add("ci.contract", relativeCi, `missing CI contract: ${required}`);
    }
  }
  const uses = [...content.matchAll(/^\s*uses:\s*(\S+)\s*$/gmu)].map(
    (match) => match[1],
  );
  if (
    uses.length !== 3 ||
    uses[0] !== "actions/checkout@v4" ||
    uses[1] !== "pnpm/action-setup@v4" ||
    uses[2] !== "actions/setup-node@v4"
  ) {
    add(
      "ci.contract",
      relativeCi,
      "CI may use only the reviewed checkout, pnpm setup, and setup-node actions",
    );
  }
  for (const forbidden of [
    /\bcontinue-on-error\s*:/iu,
    /^\s*(?:if|shell|defaults|env)\s*:/gmu,
    /\bworkflow_dispatch\b/iu,
  ]) {
    if (forbidden.test(content)) {
      add(
        "ci.contract",
        relativeCi,
        "CI contains a condition, shell override, environment block, or alternate trigger",
      );
    }
  }
}

async function checkReleaseSmokeContract(root, files, add) {
  const relativePath = RELEASE_SMOKE_PATH;
  const absolutePath = path.join(root, relativePath);
  if (!files.includes(relativePath)) {
    add(
      "release-smoke",
      relativePath,
      "reviewed release-smoke workflow is missing",
    );
    return;
  }
  const content = await readFile(absolutePath, "utf8");
  const digest = createHash("sha256").update(content).digest("hex");
  if (digest !== EXPECTED_RELEASE_SMOKE_SHA256) {
    add(
      "release-smoke",
      relativePath,
      "workflow digest differs from the reviewed release-smoke contract",
    );
  }
  if (!content.startsWith("name: release-smoke\n")) {
    add(
      "release-smoke",
      relativePath,
      "workflow name must remain release-smoke",
    );
  }
  const trigger = content.match(/\non:\n([\s\S]*?)\npermissions:/u)?.[1] ?? "";
  if (!/^\s{2}workflow_dispatch:\s*$/mu.test(trigger)) {
    add(
      "release-smoke",
      relativePath,
      "only workflow_dispatch may trigger the release smoke",
    );
  }
  if (
    /^\s{2}(?:push|pull_request|schedule|workflow_call|workflow_run|release|issues|discussion|merge_group):/mu.test(
      trigger,
    )
  ) {
    add(
      "release-smoke",
      relativePath,
      "release smoke must not run on push, pull_request, schedule, or another repository event",
    );
  }
  const matrixMatch = content.match(
    /\n[ \t]+os:[ \t]*\n((?:[ \t]+-[ \t]+\S+[ \t]*\n?)+)/u,
  );
  const runners = matrixMatch?.[1]
    ? [...matrixMatch[1].matchAll(/-\s+(\S+)/gu)].map((match) => match[1])
    : [];
  if (
    runners.length !== EXPECTED_RELEASE_SMOKE_RUNNERS.length ||
    !runners.every(
      (runner, index) => runner === EXPECTED_RELEASE_SMOKE_RUNNERS[index],
    )
  ) {
    add(
      "release-smoke",
      relativePath,
      `release-smoke matrix must require ${EXPECTED_RELEASE_SMOKE_RUNNERS.join(
        ", ",
      )}`,
    );
  }
  for (const required of [
    "permissions:\n  contents: read",
    "runs-on: ${{ matrix.os }}",
    "node-version: 22.19.0",
    "version: 12.18.0",
    "persist-credentials: false",
    "ref: v${{ inputs.version }}",
    "run: bash scripts/ci-install-sandbox-deps.sh",
    'run: bash scripts/release-smoke.sh "$VERSION"',
    "type: string",
  ]) {
    if (!content.includes(required)) {
      add(
        "release-smoke",
        relativePath,
        `missing release-smoke contract: ${required}`,
      );
    }
  }
  const uses = [...content.matchAll(/^\s*uses:\s*(\S+)\s*$/gmu)].map(
    (match) => match[1],
  );
  if (
    uses.length !== 3 ||
    uses[0] !== "actions/checkout@v4" ||
    uses[1] !== "pnpm/action-setup@v4" ||
    uses[2] !== "actions/setup-node@v4"
  ) {
    add(
      "release-smoke",
      relativePath,
      "release smoke may use only the reviewed checkout, pnpm setup, and setup-node actions",
    );
  }
  for (const forbidden of [
    /\bnpm\s+publish\b/iu,
    /\bsecrets\b/iu,
    /\bcontinue-on-error\s*:/iu,
  ]) {
    if (forbidden.test(content)) {
      add(
        "release-smoke",
        relativePath,
        "release smoke contains a publish command, secret reference, or non-blocking step",
      );
    }
  }
}

async function checkPlatformDocumentation(root, add) {
  const runnerLine = `CI runners: ${EXPECTED_CI_RUNNERS.map(
    (runner) => `\`${runner}\``,
  ).join(", ")}.`;
  const documents = ["README.md", "docs/DEVELOPMENT.md", "docs/PLATFORMS.md"];
  const contents = new Map();

  for (const relativePath of documents) {
    try {
      const content = await readFile(path.join(root, relativePath), "utf8");
      contents.set(relativePath, content);
      const occurrences = content
        .split(/\r?\n/u)
        .filter((line) => line === runnerLine).length;
      if (occurrences !== 1) {
        add(
          "docs.platforms",
          relativePath,
          `expected exactly one CI runner line, found ${occurrences}: ${runnerLine}`,
        );
      }
    } catch (error) {
      add(
        "docs.platforms",
        relativePath,
        `cannot read platform documentation: ${error.message}`,
      );
    }
  }

  const relativePath = "docs/PLATFORMS.md";
  const content = contents.get(relativePath);
  if (content === undefined) {
    return;
  }
  const startMarker = "<!-- ci-targets:start -->";
  const endMarker = "<!-- ci-targets:end -->";
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    add(
      "docs.platforms",
      relativePath,
      "missing or misplaced ci-targets start/end markers",
    );
    return;
  }

  const section = content.slice(start + startMarker.length, end);
  const lines = section.split(/\r?\n/u);
  const headerIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\|.*\|\s*$/u.test(lines[index])) {
      const cells = lines[index]
        .trim()
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      if (cells.includes("CI runner")) {
        headerIndexes.push({ index, runnerColumn: cells.indexOf("CI runner") });
      }
    }
  }
  if (headerIndexes.length !== 1) {
    add(
      "docs.platforms",
      relativePath,
      "ci-targets must contain exactly one table with a CI runner column",
    );
    return;
  }

  const { index: headerIndex, runnerColumn } = headerIndexes[0];
  const runners = [];
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s*\|.*\|\s*$/u.test(line)) {
      break;
    }
    const cells = line
      .trim()
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    const cell = cells[runnerColumn];
    if (cell === undefined) {
      runners.push("");
      continue;
    }
    runners.push(
      cell.startsWith("`") && cell.endsWith("`") ? cell.slice(1, -1) : cell,
    );
  }
  if (
    runners.length !== EXPECTED_CI_RUNNERS.length ||
    !runners.every((runner, index) => runner === EXPECTED_CI_RUNNERS[index])
  ) {
    add(
      "docs.platforms",
      relativePath,
      `CI runner table must require ${EXPECTED_CI_RUNNERS.join(", ")} in order`,
    );
  }
}

async function checkDocumentationContract(root, add) {
  const relativeDevelopment = "docs/DEVELOPMENT.md";
  if (!existsSync(path.join(root, relativeDevelopment))) {
    return;
  }
  const development = await readFile(
    path.join(root, relativeDevelopment),
    "utf8",
  );
  for (const requiredValue of [
    "`>=22.19.0`",
    "`12.18.0`",
    "`1.5.2`",
    "`0.0.82`",
    "`1.3.27`",
    "`22.19.1`",
    "`3.10.1`",
    "`7.0.2`",
  ]) {
    if (!development.includes(requiredValue)) {
      add(
        "docs.contract",
        relativeDevelopment,
        `missing reviewed value ${requiredValue}`,
      );
    }
  }
  for (const requiredCommand of [
    "pnpm install --frozen-lockfile --ignore-scripts",
    "pnpm run format:check",
    "pnpm run check",
    "pnpm run typecheck",
    "pnpm test",
    "pnpm run build",
    "node scripts/check-repo.mjs --require-built",
    "pnpm run verify",
  ]) {
    if (!development.includes(requiredCommand)) {
      add(
        "docs.contract",
        relativeDevelopment,
        `missing command ${requiredCommand}`,
      );
    }
  }
  for (const requiredStatement of [
    "### Dependency review snapshot",
    "GHSA-mrhx-c7xc-m3w5",
    "accepted-for-development review item",
    "The dependency audit is not clean",
    "## Repository checks",
  ]) {
    if (!development.includes(requiredStatement)) {
      add(
        "docs.contract",
        relativeDevelopment,
        `missing reviewed statement ${requiredStatement}`,
      );
    }
  }

  for (const relativePath of ["README.md", "CONTRIBUTING.md"]) {
    if (!existsSync(path.join(root, relativePath))) {
      continue;
    }
    const content = await readFile(path.join(root, relativePath), "utf8");
    for (const requiredText of ["Node.js `>=22.19.0`", "pnpm `12.18.0`"]) {
      if (!content.includes(requiredText)) {
        add(
          "docs.contract",
          relativePath,
          `missing toolchain statement ${requiredText}`,
        );
      }
    }
  }

  // Help and README must describe the same human delivery commands. The
  // earlier review found `/agents review|sign|merge|discard|transcript` in the
  // TUI help while README listed only result/wait/stop.
  const readmePath = "README.md";
  if (existsSync(path.join(root, readmePath))) {
    const readme = await readFile(path.join(root, readmePath), "utf8");
    for (const requiredCommand of [
      "/agents review",
      "/agents sign",
      "/agents merge",
      "/agents discard",
      "/agents transcript",
    ]) {
      if (!readme.includes(requiredCommand)) {
        add(
          "docs.contract",
          readmePath,
          `missing documented command ${requiredCommand}`,
        );
      }
    }
  }
}

function stripMarkdownCode(content) {
  return content
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gmu, "")
    .replace(/^(?: {4}|\t).*$/gmu, "")
    .replace(/`[^`\n]*`/gu, "");
}

function normalizeMarkdownTarget(rawTarget) {
  const trimmed = rawTarget.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1);
  }
  const titledTarget = trimmed.match(
    /^(\S+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/u,
  );
  return titledTarget?.[1] ?? trimmed;
}

function extractMarkdownTargets(content) {
  const targets = [];
  const searchable = stripMarkdownCode(content);
  const inlineLink = /!?\[[^\]]*\]\(([^)\n]*)\)/gu;
  const referenceLink = /^\s*\[[^\]]+\]:\s*(\S+)\s*$/gmu;
  for (const pattern of [inlineLink, referenceLink]) {
    for (const match of searchable.matchAll(pattern)) {
      if (match[1]) {
        targets.push(normalizeMarkdownTarget(match[1]));
      }
    }
  }
  return targets;
}

async function checkMarkdownLinks(root, files, add) {
  for (const relativePath of files) {
    if (path.extname(relativePath).toLowerCase() !== ".md") {
      continue;
    }
    const content = await readFile(path.join(root, relativePath), "utf8");
    for (const rawTarget of extractMarkdownTargets(content)) {
      if (
        rawTarget.startsWith("#") ||
        /^https?:\/\//iu.test(rawTarget) ||
        /^mailto:/iu.test(rawTarget)
      ) {
        continue;
      }
      if (
        rawTarget.startsWith("/") ||
        /^[A-Za-z]:[\\/]/u.test(rawTarget) ||
        rawTarget.startsWith("file:")
      ) {
        add(
          "docs.absolute",
          relativePath,
          `absolute Markdown target: ${rawTarget}`,
        );
        continue;
      }
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(rawTarget)) {
        continue;
      }

      const withoutFragment = rawTarget.split("#", 1)[0].split("?", 1)[0];
      if (!withoutFragment) {
        continue;
      }
      let decodedTarget;
      try {
        decodedTarget = decodeURIComponent(withoutFragment);
      } catch {
        add(
          "docs.link",
          relativePath,
          `invalid percent encoding: ${rawTarget}`,
        );
        continue;
      }
      const targetPath = path.resolve(
        path.dirname(path.join(root, relativePath)),
        decodedTarget,
      );
      if (!isInside(root, targetPath)) {
        add(
          "docs.link",
          relativePath,
          `link escapes the repository: ${rawTarget}`,
        );
        continue;
      }
      if (!existsSync(targetPath)) {
        add("docs.link", relativePath, `broken local link: ${rawTarget}`);
      }
    }
  }
}

function checkExports(root, spec, manifest, add) {
  const relativeManifest = `${spec.dir}/package.json`;
  const exportsValue = manifest.exports;
  if (!exportsValue || typeof exportsValue !== "object") {
    add("pkg.exports", relativeManifest, "missing exports map");
    return;
  }
  const exportKeys = ownKeys(exportsValue);
  if (!sameSet(exportKeys, ["."])) {
    add(
      "pkg.exports",
      relativeManifest,
      "only the package root export is permitted",
    );
  }
  const rootExport = exportsValue["."];
  if (
    !rootExport ||
    typeof rootExport !== "object" ||
    !sameSet(ownKeys(rootExport), ["import", "types"])
  ) {
    add(
      "pkg.exports",
      relativeManifest,
      "root export must declare exactly import and types",
    );
    return;
  }

  const importTarget = rootExport.import;
  const typesTarget = rootExport.types;
  if (
    typeof importTarget !== "string" ||
    !importTarget.startsWith("./dist/") ||
    !importTarget.endsWith(".js") ||
    importTarget.includes("*") ||
    importTarget.split("/").includes("..")
  ) {
    add("pkg.exports", relativeManifest, "invalid ESM import target");
  }
  if (
    typeof typesTarget !== "string" ||
    !typesTarget.startsWith("./dist/") ||
    !typesTarget.endsWith(".d.ts") ||
    typesTarget.includes("*") ||
    typesTarget.split("/").includes("..")
  ) {
    add(
      "pkg.exports",
      relativeManifest,
      "invalid TypeScript declaration target",
    );
  }

  const sourceEntry = path.join(root, spec.dir, "src", "index.ts");
  if (!existsSync(sourceEntry)) {
    add("pkg.exports", relativeManifest, "missing src/index.ts entry source");
  }
}

function checkPackageManifest(root, spec, manifest, add, workspaceVersion) {
  const relativeManifest = `${spec.dir}/package.json`;
  if (manifest.name !== spec.name) {
    add("pkg.manifest", relativeManifest, `expected package name ${spec.name}`);
  }
  if (!isExactVersion(manifest.version)) {
    add(
      "pkg.manifest",
      relativeManifest,
      "package version must be an exact semantic version",
    );
  } else if (
    typeof workspaceVersion === "string" &&
    manifest.version !== workspaceVersion
  ) {
    add(
      "pkg.manifest",
      relativeManifest,
      `package version must match the workspace version ${workspaceVersion}`,
    );
  }
  if (manifest.license !== "MIT") {
    add("pkg.manifest", relativeManifest, "package license must be MIT");
  }
  if (
    manifest.repository?.url !== "git+https://github.com/leoxstar/codepunk.git"
  ) {
    add(
      "pkg.manifest",
      relativeManifest,
      "repository.url must be git+https://github.com/leoxstar/codepunk.git",
    );
  }
  if (manifest.publishConfig?.access !== "public") {
    add(
      "pkg.manifest",
      relativeManifest,
      "publishConfig.access must be public",
    );
  }
  if (manifest.type !== "module") {
    add("pkg.manifest", relativeManifest, "package must be ESM");
  }
  if (manifest.private === true) {
    add(
      "pkg.manifest",
      relativeManifest,
      "product package must be publishable",
    );
  }
  if (manifest.engines?.node !== NODE_ENGINE) {
    add("pkg.manifest", relativeManifest, `Node engine must be ${NODE_ENGINE}`);
  }
  if (manifest.scripts?.build !== "tsc -p tsconfig.json") {
    add("pkg.manifest", relativeManifest, "missing canonical build script");
  }
  if (
    manifest.scripts?.typecheck !== "tsc -p tsconfig.typecheck.json --noEmit"
  ) {
    add(
      "pkg.manifest",
      relativeManifest,
      "missing clean-tree typecheck script",
    );
  }
  if (!sameSet(ownKeys(manifest.scripts), ["build", "typecheck"])) {
    add(
      "pkg.manifest",
      relativeManifest,
      "package scripts must be exactly build and typecheck",
    );
  }
  if (
    JSON.stringify(manifest.files) !== JSON.stringify(["dist", "README.md"])
  ) {
    add(
      "pkg.manifest",
      relativeManifest,
      'published files must be exactly ["dist", "README.md"]',
    );
  }

  const relativeTypecheck = `${spec.dir}/tsconfig.typecheck.json`;
  const typecheckPath = path.join(root, relativeTypecheck);
  if (!existsSync(typecheckPath)) {
    add(
      "pkg.manifest",
      relativeTypecheck,
      "missing clean-tree typecheck config",
    );
  } else {
    try {
      const config = JSON.parse(readFileSync(typecheckPath, "utf8"));
      if (config.extends !== "./tsconfig.json") {
        add(
          "pkg.manifest",
          relativeTypecheck,
          "typecheck config must extend the build config",
        );
      }
      if (config.compilerOptions?.noEmit !== true) {
        add(
          "pkg.manifest",
          relativeTypecheck,
          "typecheck config must disable emit",
        );
      }
      if (
        !sameStringArrayMap(
          config.compilerOptions?.paths ?? {},
          spec.typecheckPaths,
        )
      ) {
        add(
          "pkg.manifest",
          relativeTypecheck,
          "typecheck paths must resolve internal packages to source",
        );
      }
    } catch (error) {
      add(
        "pkg.manifest",
        relativeTypecheck,
        `cannot read typecheck config: ${error.message}`,
      );
    }
  }

  checkExports(root, spec, manifest, add);

  const dependencies = manifest.dependencies ?? {};
  const expectedDependencies = {
    ...spec.external,
    ...Object.fromEntries(
      spec.internal.map((name) => [name, workspaceVersion]),
    ),
  };
  const expectedNames = Object.keys(expectedDependencies);
  const actualNames = Object.keys(dependencies);
  const internalNames = spec.internal;
  const internalPrefix = "@codepunk/";

  for (const name of actualNames) {
    if (!(name in expectedDependencies)) {
      if (name.startsWith(internalPrefix)) {
        add(
          "deps.direction",
          relativeManifest,
          `internal dependency ${name} is not allowed for ${spec.name}`,
        );
      } else {
        add(
          "deps.review",
          relativeManifest,
          `unreviewed runtime dependency ${name}`,
        );
      }
    }
  }

  for (const name of expectedNames) {
    if (!(name in dependencies)) {
      add("deps.pin", relativeManifest, `missing reviewed dependency ${name}`);
      continue;
    }
    const actualVersion = dependencies[name];
    if (!isExactVersion(actualVersion)) {
      add("deps.pin", relativeManifest, `${name} must use an exact version`);
    }
    if (actualVersion !== expectedDependencies[name]) {
      add(
        "deps.pin",
        relativeManifest,
        `${name} must be pinned to ${expectedDependencies[name]}`,
      );
    }
  }

  for (const name of internalNames) {
    if (!(name in dependencies)) {
      add(
        "deps.direction",
        relativeManifest,
        `missing internal dependency ${name}`,
      );
    }
  }

  for (const section of [
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    if (ownKeys(manifest[section]).length > 0) {
      add(
        "deps.review",
        relativeManifest,
        `${section} is not approved for product packages`,
      );
    }
  }

  for (const prohibitedKey of PROHIBITED_ROOT_KEYS) {
    if (manifest[prohibitedKey] !== undefined) {
      add(
        "deps.review",
        relativeManifest,
        `manifest field ${prohibitedKey} is not approved`,
      );
    }
  }
}

function packageNameForSpecifier(specifier) {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

function sourceFilesForPackage(files, packageDirectory) {
  return files.filter(
    (relativePath) =>
      relativePath.startsWith(`${packageDirectory}/`) &&
      [".cjs", ".cts", ".js", ".mjs", ".mts", ".ts"].includes(
        path.extname(relativePath),
      ),
  );
}

const NON_CODE_TOKEN_KINDS = new Set([
  SyntaxKind.SingleLineCommentTrivia,
  SyntaxKind.MultiLineCommentTrivia,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateHead,
  SyntaxKind.TemplateMiddle,
  SyntaxKind.TemplateTail,
]);

const EXPRESSION_END_TOKEN_KINDS = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseBraceToken,
  SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
]);

function nonCodeRanges(content) {
  const ranges = [];
  const scanner = createScanner(false, LanguageVariant.Standard, content);
  let previousToken;
  const templateBraceDepths = [];
  for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile;) {
    if (token === SyntaxKind.TemplateHead) {
      templateBraceDepths.push(0);
    } else if (templateBraceDepths.length > 0) {
      const frame = templateBraceDepths.length - 1;
      if (token === SyntaxKind.OpenBraceToken) {
        templateBraceDepths[frame] += 1;
      } else if (token === SyntaxKind.CloseBraceToken) {
        if (templateBraceDepths[frame] === 0) {
          token = scanner.reScanTemplateToken();
          if (token === SyntaxKind.TemplateTail) {
            templateBraceDepths.pop();
          }
        } else {
          templateBraceDepths[frame] -= 1;
        }
      }
    }
    if (
      token === SyntaxKind.SlashToken &&
      (previousToken === undefined ||
        !EXPRESSION_END_TOKEN_KINDS.has(previousToken))
    ) {
      token = scanner.reScanSlashToken();
    }
    if (NON_CODE_TOKEN_KINDS.has(token)) {
      ranges.push([scanner.getTokenStart(), scanner.getTokenEnd()]);
    }
    if (
      token !== SyntaxKind.EndOfFile &&
      scanner.getTokenEnd() <= scanner.getTokenStart()
    ) {
      throw new Error(
        `TypeScript scanner made no progress at offset ${scanner.getTokenStart()}`,
      );
    }
    previousToken = token;
    token = scanner.scan();
  }
  return ranges;
}

function startsInNonCodeRange(match, ranges) {
  if (typeof match.index !== "number") {
    return false;
  }
  return ranges.some(
    ([start, end]) => match.index >= start && match.index < end,
  );
}

function extractImportSpecifiers(content, ranges) {
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\bimport\s*\(\s*`([^`$]*)`\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1] && !startsInNonCodeRange(match, ranges)) {
        specifiers.add(match[1]);
      }
    }
  }
  return specifiers;
}

function hasComputedModuleCall(content, ranges, reviewed = null) {
  const argumentsList = [];
  for (const pattern of [
    /\bimport\s*\(\s*([\s\S]*?)\s*\)/gu,
    /\brequire\s*\(\s*([\s\S]*?)\s*\)/gu,
  ]) {
    for (const match of content.matchAll(pattern)) {
      if (startsInNonCodeRange(match, ranges)) {
        continue;
      }
      const argument = match[1].trim();
      const literal =
        /^(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\$])*`)$/u.test(
          argument,
        );
      if (literal) {
        continue;
      }
      argumentsList.push(argument.replace(/,\s*$/u, ""));
    }
  }
  const createRequire = [...content.matchAll(/\bcreateRequire\s*\(/gu)].some(
    (match) => !startsInNonCodeRange(match, ranges),
  );
  if (createRequire) {
    return true;
  }
  if (argumentsList.length === 0) {
    return false;
  }
  if (reviewed === null) {
    return true;
  }
  return (
    !reviewed.anchors.every((anchor) => anchor.test(content)) ||
    argumentsList.some((argument) => !reviewed.argument.test(argument))
  );
}

async function checkSourceImports(root, files, add) {
  for (const spec of PACKAGE_SPECS) {
    const packageRoot = path.join(root, spec.dir);
    const allowedInternal = new Set(spec.internal);
    const declaredDependencies = new Set([
      ...Object.keys(spec.external),
      ...spec.internal,
    ]);

    for (const relativePath of sourceFilesForPackage(files, spec.dir)) {
      const content = await readFile(path.join(root, relativePath), "utf8");
      const ranges = nonCodeRanges(content);
      if (
        hasComputedModuleCall(
          content,
          ranges,
          REVIEWED_COMPUTED_IMPORTS.get(relativePath) ?? null,
        )
      ) {
        add(
          "source.import",
          relativePath,
          "computed import/require specifiers cannot be boundary-verified",
        );
      }
      for (const specifier of extractImportSpecifiers(content, ranges)) {
        if (specifier.startsWith("node:")) {
          continue;
        }
        if (specifier.includes("verify/")) {
          add(
            "security.research-import",
            relativePath,
            `imports research material: ${specifier}`,
          );
          continue;
        }
        if (specifier.startsWith(".")) {
          const resolved = path.resolve(
            path.dirname(path.join(root, relativePath)),
            specifier,
          );
          if (!isInside(packageRoot, resolved)) {
            add(
              "source.import",
              relativePath,
              `relative import escapes ${spec.name}: ${specifier}`,
            );
          }
          continue;
        }

        const packageName = packageNameForSpecifier(specifier);
        if (packageName?.startsWith("@codepunk/")) {
          const packageSegments =
            packageName.startsWith("@") && packageName.includes("/")
              ? specifier.split("/").length
              : 1;
          if (packageSegments > 2) {
            add(
              "source.import",
              relativePath,
              `deep internal import is forbidden: ${specifier}`,
            );
          }
          if (!PACKAGE_BY_NAME.has(packageName)) {
            add(
              "source.import",
              relativePath,
              `unknown internal package: ${packageName}`,
            );
          } else if (!allowedInternal.has(packageName)) {
            add(
              "deps.direction",
              relativePath,
              `${spec.name} cannot import ${packageName}`,
            );
          }
          continue;
        }

        if (packageName && !declaredDependencies.has(packageName)) {
          add(
            "deps.review",
            relativePath,
            `source imports undeclared dependency ${packageName}`,
          );
        }
      }
    }
  }
}

async function checkControlCorpus(root, add) {
  const relativePath = "tests/repository.test.mjs";
  try {
    const digest = createHash("sha256")
      .update(await readFile(path.join(root, relativePath)))
      .digest("hex");
    if (digest !== EXPECTED_CONTROL_CORPUS_SHA256) {
      add(
        "repo.controls",
        relativePath,
        "negative-control corpus differs from the reviewed snapshot",
      );
    }
  } catch (error) {
    add(
      "repo.controls",
      relativePath,
      `cannot read negative-control corpus: ${error.message}`,
    );
  }
}

function yamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function parsePackageIdentity(value) {
  const key = yamlScalar(value.endsWith(":") ? value.slice(0, -1) : value);
  const withoutPeers = key.replace(/\([^)]*\)$/u, "");
  const separator = withoutPeers.lastIndexOf("@");
  if (separator <= 0) {
    return undefined;
  }
  const name = withoutPeers.slice(0, separator);
  const version = withoutPeers.slice(separator + 1);
  return isExactVersion(version) ? { name, version } : undefined;
}

function parsePnpmLock(content) {
  const documents = content.split(/\n---\r?\n/u);
  const lines = documents.at(-1).split(/\r?\n/u);
  const importers = new Map();
  const packages = new Map();
  const dependencySections = new Set([
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]);
  let lockfileVersion;
  let section;
  let importerPath;
  let importer;
  let dependencySection;
  let dependencyName;
  let packageEntry;

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      const separator = trimmed.indexOf(":");
      if (separator === -1) {
        continue;
      }
      const key = trimmed.slice(0, separator);
      const value = trimmed.slice(separator + 1).trim();
      if (key === "lockfileVersion") {
        lockfileVersion = yamlScalar(value);
      }
      section = value === "" ? key : undefined;
      importerPath = undefined;
      importer = undefined;
      dependencySection = undefined;
      dependencyName = undefined;
      packageEntry = undefined;
      continue;
    }

    if (section === "importers") {
      if (indent === 2 && trimmed.endsWith(":")) {
        importerPath = yamlScalar(trimmed.slice(0, -1));
        importer = {
          dependencies: {},
          devDependencies: {},
          optionalDependencies: {},
        };
        importers.set(importerPath, importer);
        dependencySection = undefined;
        dependencyName = undefined;
        continue;
      }
      if (!importer) {
        continue;
      }
      if (indent === 4 && trimmed.endsWith(":")) {
        const key = yamlScalar(trimmed.slice(0, -1));
        dependencySection = dependencySections.has(key) ? key : undefined;
        dependencyName = undefined;
        continue;
      }
      if (indent === 6 && trimmed.endsWith(":") && dependencySection) {
        dependencyName = yamlScalar(trimmed.slice(0, -1));
        importer[dependencySection][dependencyName] = {};
        continue;
      }
      if (indent === 8 && dependencyName && dependencySection) {
        const separator = trimmed.indexOf(":");
        if (separator !== -1) {
          const key = trimmed.slice(0, separator);
          importer[dependencySection][dependencyName][key] = yamlScalar(
            trimmed.slice(separator + 1),
          );
        }
      }
      continue;
    }

    if (section === "packages") {
      if (indent === 2 && trimmed.endsWith(":")) {
        const identity = parsePackageIdentity(trimmed);
        if (!identity) {
          packageEntry = undefined;
          continue;
        }
        packageEntry = { ...identity, integrity: undefined };
        if (!packages.has(identity.name)) {
          packages.set(identity.name, new Map());
        }
        packages.get(identity.name).set(identity.version, packageEntry);
        continue;
      }
      if (indent >= 4 && packageEntry) {
        const inline = trimmed.match(
          /^resolution:.*\bintegrity:\s*([^,}\s]+)/u,
        );
        const multiline = trimmed.match(/^integrity:\s*([^,}\s]+)/u);
        const integrity = inline?.[1] ?? multiline?.[1];
        if (integrity) {
          packageEntry.integrity = integrity;
        }
      }
    }
  }

  return { lockfileVersion, importers, packages };
}

function lockedDependency(lock, importerPath, section, packageName) {
  return lock.importers.get(importerPath)?.[section]?.[packageName];
}

function relativeWorkspaceLink(fromDirectory, toDirectory) {
  return `link:${path.posix.relative(fromDirectory, toDirectory)}`;
}

function checkLockfile(lock, lockfileDigest, add, workspaceVersion) {
  const relativeLock = "pnpm-lock.yaml";
  if (lock.lockfileVersion !== "9.0") {
    add("deps.lock", relativeLock, "lockfileVersion must be 9.0");
  }
  if (lockfileDigest !== EXPECTED_LOCKFILE_SHA256) {
    add(
      "deps.lock",
      relativeLock,
      "lockfile digest differs from the reviewed snapshot",
    );
  }

  for (const [name, version] of Object.entries(ROOT_DEV_DEPENDENCIES)) {
    const dependency = lockedDependency(lock, ".", "devDependencies", name);
    if (!dependency) {
      add("deps.lock", relativeLock, `missing root dependency ${name}`);
      continue;
    }
    if (
      dependency.specifier !== version ||
      (dependency.version !== version &&
        !dependency.version.startsWith(`${version}(`))
    ) {
      add(
        "deps.lock",
        relativeLock,
        `${name} root lock entry does not match ${version}`,
      );
    }
  }

  for (const spec of PACKAGE_SPECS) {
    const importer = lock.importers.get(spec.dir);
    if (!importer) {
      add("deps.lock", relativeLock, `missing lock entry for ${spec.dir}`);
      continue;
    }
    for (const [name, version] of Object.entries(spec.external)) {
      const dependency = lockedDependency(lock, spec.dir, "dependencies", name);
      if (!dependency) {
        add(
          "deps.lock",
          relativeLock,
          `missing locked dependency ${name} for ${spec.dir}`,
        );
        continue;
      }
      if (
        dependency.specifier !== version ||
        (dependency.version !== version &&
          !dependency.version.startsWith(`${version}(`))
      ) {
        add(
          "deps.lock",
          relativeLock,
          `${name} lock entry for ${spec.dir} does not match ${version}`,
        );
      }
    }
    for (const name of spec.internal) {
      const version = workspaceVersion;
      const internalSpec = PACKAGE_BY_NAME.get(name);
      if (!internalSpec) {
        continue;
      }
      const dependency = lockedDependency(lock, spec.dir, "dependencies", name);
      const expectedLink = relativeWorkspaceLink(spec.dir, internalSpec.dir);
      if (!dependency) {
        add(
          "deps.lock",
          relativeLock,
          `missing workspace dependency ${name} for ${spec.dir}`,
        );
        continue;
      }
      if (
        dependency.specifier !== version ||
        dependency.version !== expectedLink
      ) {
        add(
          "deps.lock",
          relativeLock,
          `${name} must link through ${expectedLink} for ${spec.dir}`,
        );
      }
    }
  }

  for (const [name, expectedVersion] of REVIEWED_EXTERNAL_VERSIONS) {
    const installed = lock.packages.get(name)?.get(expectedVersion);
    if (!installed) {
      add(
        "deps.lock",
        relativeLock,
        `missing locked package ${name}@${expectedVersion}`,
      );
      continue;
    }
    if (
      typeof installed.integrity !== "string" ||
      !installed.integrity.startsWith("sha512-")
    ) {
      add(
        "deps.lock",
        relativeLock,
        `${name} is missing a SHA-512 integrity value`,
      );
    }
  }

  for (const identity of REVIEWED_INSTALL_SCRIPTS.keys()) {
    const parsed = parsePackageIdentity(identity);
    if (!parsed || !lock.packages.get(parsed.name)?.has(parsed.version)) {
      add(
        "deps.review",
        relativeLock,
        `reviewed install-script package ${identity} is missing`,
      );
    }
  }
}

function checkRootManifest(manifest, add) {
  if (manifest.name !== "codepunk") {
    add("pkg.manifest", "package.json", "root package name must be codepunk");
  }
  if (!isExactVersion(manifest.version)) {
    add(
      "pkg.manifest",
      "package.json",
      "root version must be an exact semantic version",
    );
  }
  if (manifest.private !== true) {
    add("pkg.manifest", "package.json", "root package must be private");
  }
  if (manifest.type !== "module") {
    add("pkg.manifest", "package.json", "root package must be ESM");
  }
  if (manifest.engines?.node !== NODE_ENGINE) {
    add("pkg.manifest", "package.json", `Node engine must be ${NODE_ENGINE}`);
  }
  if (manifest.packageManager !== EXPECTED_PACKAGE_MANAGER) {
    add(
      "pkg.manifest",
      "package.json",
      `package manager must be ${EXPECTED_PACKAGE_MANAGER}`,
    );
  }
  if (manifest.workspaces !== undefined) {
    add(
      "pkg.manifest",
      "package.json",
      "workspace definitions belong in pnpm-workspace.yaml",
    );
  }
  const scripts = manifest.scripts ?? {};
  if (!sameSet(ownKeys(scripts), Object.keys(EXPECTED_ROOT_SCRIPTS))) {
    add(
      "pkg.manifest",
      "package.json",
      "root script set is not the approved gate set",
    );
  }
  for (const [script, command] of Object.entries(EXPECTED_ROOT_SCRIPTS)) {
    if (scripts[script] !== command) {
      add(
        "pkg.manifest",
        "package.json",
        `script ${script} must be exactly: ${command}`,
      );
    }
  }

  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    if (ownKeys(manifest[section]).length > 0) {
      add("deps.review", "package.json", `root ${section} is not allowed`);
    }
  }

  const devDependencies = manifest.devDependencies ?? {};
  if (
    !sameSet(Object.keys(devDependencies), Object.keys(ROOT_DEV_DEPENDENCIES))
  ) {
    add(
      "deps.review",
      "package.json",
      "root development dependency set is not approved",
    );
  }
  for (const [name, expectedVersion] of Object.entries(ROOT_DEV_DEPENDENCIES)) {
    if (!isExactVersion(devDependencies[name])) {
      add("deps.pin", "package.json", `${name} must use an exact version`);
    }
    if (devDependencies[name] !== expectedVersion) {
      add(
        "deps.pin",
        "package.json",
        `${name} must be pinned to ${expectedVersion}`,
      );
    }
  }

  for (const prohibitedKey of PROHIBITED_ROOT_KEYS) {
    if (manifest[prohibitedKey] !== undefined) {
      add(
        "deps.review",
        "package.json",
        `root manifest field ${prohibitedKey} is not approved`,
      );
    }
  }

  for (const script of Object.keys(scripts)) {
    if (PROHIBITED_LIFECYCLE_SCRIPTS.has(script)) {
      add(
        "deps.review",
        "package.json",
        `lifecycle script ${script} is not approved`,
      );
    }
  }
}

async function checkPnpmWorkspace(root, add) {
  const relativePath = "pnpm-workspace.yaml";
  let content;
  try {
    content = await readFile(path.join(root, relativePath), "utf8");
  } catch (error) {
    add(
      "pkg.manifest",
      relativePath,
      `cannot read pnpm workspace: ${error.message}`,
    );
    return;
  }
  const listValues = (key) => {
    const block = new RegExp(
      `^${key}:[^\\n]*\\n((?:[ \\t]+-[^\\n]*(?:\\n|$))+)`,
      "mu",
    ).exec(content)?.[1];
    return block === undefined
      ? []
      : [
          ...block.matchAll(
            /^[ \t]+-\s+["']?([^"'\s#]+)["']?[ \t]*(?:#.*)?$/gmu,
          ),
        ].map((match) => match[1]);
  };
  const packagePatterns = listValues("packages");
  if (
    packagePatterns.length !== 1 ||
    packagePatterns[0] !== EXPECTED_WORKSPACE_GLOB
  ) {
    add(
      "pkg.manifest",
      relativePath,
      `workspace glob must be ${EXPECTED_WORKSPACE_GLOB}`,
    );
  }
  if (!/^linkWorkspacePackages:\s*true\s*$/mu.test(content)) {
    add(
      "pkg.manifest",
      relativePath,
      "workspace packages must be linked locally",
    );
  }
  if (
    listValues("ignoredBuiltDependencies").join("\n") !==
    ["@google/genai", "koffi", "node-pty", "protobufjs"].join("\n")
  ) {
    add(
      "pkg.manifest",
      relativePath,
      "ignored dependency build scripts differ from the reviewed set",
    );
  }
  if (!/^strictDepBuilds:\s*false\s*$/mu.test(content)) {
    add(
      "pkg.manifest",
      relativePath,
      "strict dependency build checks must stay disabled with explicit denials",
    );
  }
}

async function checkPackagePackaging(
  root,
  spec,
  rootLicense,
  requireBuilt,
  add,
) {
  const relativeLicense = `${spec.dir}/LICENSE`;
  try {
    const license = await readFile(path.join(root, relativeLicense));
    if (rootLicense && !license.equals(rootLicense)) {
      add(
        "pkg.license",
        relativeLicense,
        "package LICENSE must be byte-for-byte identical to root LICENSE",
      );
    }
  } catch (error) {
    add(
      "pkg.license",
      relativeLicense,
      `cannot read package LICENSE: ${error.message}`,
    );
  }

  let output;
  try {
    const result = await execFileAsync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline"],
      {
        cwd: path.join(root, spec.dir),
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1_048_576,
        shell: process.platform === "win32",
        env: { ...process.env, npm_config_update_notifier: "false" },
      },
    );
    output = result.stdout;
  } catch (error) {
    const reason = error.killed
      ? "timed out after 10000 ms"
      : `${error.code ?? "unknown"}: ${(error.stderr?.trim() || error.message).slice(0, 1_000)}`;
    add("pkg.pack", spec.dir, `npm pack --dry-run failed (${reason})`);
    return;
  }

  let packages;
  try {
    packages = JSON.parse(output);
  } catch {
    add("pkg.pack", spec.dir, "npm pack did not return valid JSON");
    return;
  }
  if (
    !Array.isArray(packages) ||
    packages.length !== 1 ||
    !Array.isArray(packages[0]?.files) ||
    !packages[0].files.every((file) => typeof file?.path === "string")
  ) {
    add(
      "pkg.pack",
      spec.dir,
      "npm pack must return one package with a file path list",
    );
    return;
  }
  const packedPaths = packages[0].files.map((file) => file.path);
  const requiredPaths = ["README.md", "LICENSE", "package.json"];
  for (const packedPath of packedPaths) {
    if (
      !packedPath.startsWith("dist/") &&
      !requiredPaths.includes(packedPath)
    ) {
      add(
        "pkg.pack",
        spec.dir,
        `tarball contains unreviewed path ${packedPath}`,
      );
    }
  }
  for (const requiredPath of requiredPaths) {
    if (!packedPaths.includes(requiredPath)) {
      add("pkg.pack", spec.dir, `tarball is missing ${requiredPath}`);
    }
  }
  if (
    requireBuilt &&
    !packedPaths.some((packedPath) => packedPath.startsWith("dist/"))
  ) {
    add(
      "pkg.pack",
      spec.dir,
      "tarball is missing dist output; run pnpm run build",
    );
  }
}

async function checkBuiltEntries(root, files, add) {
  for (const spec of PACKAGE_SPECS) {
    const manifestPath = path.join(root, spec.dir, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    const rootExport = manifest.exports?.["."];
    if (!rootExport || typeof rootExport !== "object") {
      continue;
    }
    const sourceCandidates = files.filter(
      (relativePath) =>
        relativePath.startsWith(`${spec.dir}/src/`) ||
        relativePath === `${spec.dir}/package.json` ||
        relativePath === `${spec.dir}/tsconfig.json`,
    );
    const sourceTimes = await Promise.all(
      sourceCandidates.map(async (relativePath) => {
        return (await stat(path.join(root, relativePath))).mtimeMs;
      }),
    );
    const newestSourceTime = Math.max(0, ...sourceTimes);
    for (const field of ["types", "import"]) {
      const target = rootExport[field];
      if (typeof target !== "string") {
        continue;
      }
      const absoluteTarget = path.resolve(path.dirname(manifestPath), target);
      if (!isInside(path.join(root, spec.dir), absoluteTarget)) {
        add(
          "pkg.built",
          `${spec.dir}/package.json`,
          `${field} target escapes the package`,
        );
      } else if (!existsSync(absoluteTarget)) {
        add(
          "pkg.built",
          projectPath(root, absoluteTarget),
          `${field} target is missing; run pnpm run build`,
        );
      } else if ((await stat(absoluteTarget)).mtimeMs < newestSourceTime) {
        add(
          "pkg.built",
          projectPath(root, absoluteTarget),
          `${field} target is older than its source; run pnpm run build`,
        );
      }
    }
  }
}

export async function checkRepository({
  root = SCRIPT_ROOT,
  requireBuilt = false,
} = {}) {
  const normalizedRoot = path.resolve(root);
  const errors = [];
  const seen = new Set();
  const add = (rule, relativePath, message) => {
    const key = `${rule}\0${relativePath}\0${message}`;
    if (!seen.has(key)) {
      seen.add(key);
      errors.push({ rule, path: relativePath, message });
    }
  };

  if (!existsSync(normalizedRoot)) {
    add("repo.internal", ".", "repository root does not exist");
    return { root: normalizedRoot, errors, fileCount: 0 };
  }

  await checkRootEntries(normalizedRoot, add);
  await checkLineEndingPolicy(normalizedRoot, add);
  checkRequiredDocs(normalizedRoot, add);

  const { tracked, trackedDirectories, scanned } =
    await listFiles(normalizedRoot);
  for (const relativePath of tracked) {
    const forbiddenSegment = hasForbiddenSegment(relativePath);
    if (forbiddenSegment) {
      add(
        "hygiene.forbidden",
        relativePath,
        `tracked forbidden path segment "${forbiddenSegment}"`,
      );
    }
    const name = path.basename(relativePath);
    const classification = classifyForbiddenFile(name);
    if (classification) {
      add(classification[0], relativePath, classification[1]);
    }
  }

  await scanWorkingTreeHygiene(normalizedRoot, add, trackedDirectories);
  await scanFileContents(normalizedRoot, scanned, add);
  await checkMarkdownLinks(normalizedRoot, scanned, add);
  await checkCiContract(normalizedRoot, scanned, add);
  await checkDocumentationContract(normalizedRoot, add);
  await checkPlatformDocumentation(normalizedRoot, add);
  await checkControlCorpus(normalizedRoot, add);
  // A pack started after the first root scan can still disappear before this
  // point. Ignore it during the scans above, but require it to be gone here;
  // a persistent entry is reported by both root checks.
  await checkRootEntries(normalizedRoot, add);

  const rootManifest = await readJson(normalizedRoot, "package.json", add);
  const workspaceVersion = rootManifest?.version;
  if (rootManifest) {
    checkRootManifest(rootManifest, add);
  }
  await checkPnpmWorkspace(normalizedRoot, add);

  const packagesPath = path.join(normalizedRoot, "packages");
  if (existsSync(packagesPath)) {
    const packageEntries = (
      await readdir(packagesPath, {
        withFileTypes: true,
      })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const expectedDirectories = PACKAGE_SPECS.map((spec) =>
      path.basename(spec.dir),
    );
    if (!sameSet(packageEntries, expectedDirectories)) {
      add(
        "pkg.layout",
        "packages",
        `expected only ${expectedDirectories.join(", ")}`,
      );
    }
  }

  let rootLicense;
  try {
    rootLicense = await readFile(path.join(normalizedRoot, "LICENSE"));
  } catch (error) {
    add("pkg.license", "LICENSE", `cannot read root LICENSE: ${error.message}`);
  }
  const packagingChecks = [];
  for (const spec of PACKAGE_SPECS) {
    const manifest = await readJson(
      normalizedRoot,
      `${spec.dir}/package.json`,
      add,
    );
    if (manifest) {
      checkPackageManifest(
        normalizedRoot,
        spec,
        manifest,
        add,
        workspaceVersion,
      );
      packagingChecks.push(
        checkPackagePackaging(
          normalizedRoot,
          spec,
          rootLicense,
          requireBuilt,
          add,
        ),
      );
    }
  }
  await Promise.all(packagingChecks);

  const relativeLockfile = "pnpm-lock.yaml";
  let lockfileContent;
  let lockfileDigest;
  try {
    lockfileContent = await readFile(
      path.join(normalizedRoot, relativeLockfile),
      "utf8",
    );
    lockfileDigest = createHash("sha256").update(lockfileContent).digest("hex");
  } catch (error) {
    add(
      "deps.lock",
      relativeLockfile,
      `cannot read pnpm lockfile: ${error.message}`,
    );
    lockfileContent = undefined;
    lockfileDigest = undefined;
  }
  if (lockfileContent) {
    checkLockfile(
      parsePnpmLock(lockfileContent),
      lockfileDigest,
      add,
      workspaceVersion,
    );
  }

  await checkSourceImports(normalizedRoot, scanned, add);

  if (requireBuilt) {
    await checkBuiltEntries(normalizedRoot, scanned, add);
  }

  return {
    root: normalizedRoot,
    errors,
    fileCount: scanned.length,
  };
}

function parseArguments(argv) {
  let root = SCRIPT_ROOT;
  let requireBuilt = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--root requires a path");
      }
      root = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--require-built") {
      requireBuilt = true;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return { root, requireBuilt };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[check.usage] ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const result = await checkRepository(options);
    if (result.errors.length > 0) {
      process.stderr.write(
        `Repository check failed with ${result.errors.length} finding(s):\n`,
      );
      for (const error of result.errors) {
        process.stderr.write(
          `[${error.rule}] ${error.path}: ${error.message}\n`,
        );
      }
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Repository check passed: ${result.fileCount} files, ${PACKAGE_SPECS.length} packages.\n`,
    );
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(
      `[repo.internal] unexpected failure: ${error.stack}\n`,
    );
    process.exitCode = 1;
  }
}

function isSameRealPath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

const isDirectInvocation =
  process.argv[1] && isSameRealPath(process.argv[1], SCRIPT_PATH);

if (isDirectInvocation) {
  await main();
}
