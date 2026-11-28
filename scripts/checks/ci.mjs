import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CI_RUN_COMMANDS,
  EXPECTED_CI_RUNNERS,
  EXPECTED_FULL_CI_RUNNERS,
  EXPECTED_NODE_VERSION,
  EXPECTED_PACKAGE_MANAGER,
  EXPECTED_RELEASE_SMOKE_RUNNERS,
  sameOrderedArray,
  sameSet,
} from "./shared.mjs";

const SETUP_ACTION_PATH = ".github/actions/setup/action.yml";
const CI_PATH = ".github/workflows/ci.yml";
const FULL_CI_PATH = ".github/workflows/full-ci.yml";
const RELEASE_SMOKE_PATH = ".github/workflows/release-smoke.yml";
const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";

const ALLOWED_GITHUB_FILES = new Set([
  SETUP_ACTION_PATH,
  CI_PATH,
  FULL_CI_PATH,
  RELEASE_SMOKE_PATH,
  RELEASE_WORKFLOW_PATH,
  ".github/CODEOWNERS",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/dependabot.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
]);

const CI_WORKFLOW_USES = ["actions/checkout@v7", "./.github/actions/setup"];

const SETUP_ACTION_USES = ["pnpm/action-setup@v6", "actions/setup-node@v7"];

const RELEASE_SMOKE_USES = [
  "actions/checkout@v7",
  "pnpm/action-setup@v6",
  "actions/setup-node@v7",
];

const CI_INSTALL_COMMAND = "pnpm install --frozen-lockfile --ignore-scripts";
const CI_WORKFLOW_COMMANDS = CI_RUN_COMMANDS.filter(
  (command) => command !== CI_INSTALL_COMMAND,
);
const EXPECTED_PNPM_VERSION = EXPECTED_PACKAGE_MANAGER.replace(/^pnpm@/u, "");

function extractMatrixRunners(content) {
  const matrixMatch = content.match(
    /\n[ \t]+os:[ \t]*\n((?:[ \t]+-[ \t]+\S+[ \t]*\n?)+)/u,
  );
  return matrixMatch?.[1]
    ? [...matrixMatch[1].matchAll(/-\s+(\S+)/gu)].map((match) => match[1])
    : [];
}

function extractUses(content) {
  return [...content.matchAll(/^\s*uses:\s*(\S+)\s*$/gmu)].map(
    (match) => match[1],
  );
}

function extractRunCommands(content) {
  return [...content.matchAll(/^\s*run:\s*(.+?)\s*$/gmu)].map(
    (match) => match[1],
  );
}

async function checkSetupActionContract(root, files, add) {
  const absolutePath = path.join(root, SETUP_ACTION_PATH);
  if (!files.includes(SETUP_ACTION_PATH)) {
    add("ci.contract", SETUP_ACTION_PATH, "composite setup action is missing");
    return;
  }
  const content = await readFile(absolutePath, "utf8");
  for (const required of [
    "using: composite",
    "uses: pnpm/action-setup@v6",
    "run_install: false",
    "uses: actions/setup-node@v7",
    "node-version-file: .node-version",
    "cache: pnpm",
    `run: ${CI_INSTALL_COMMAND}`,
  ]) {
    if (!content.includes(required)) {
      add(
        "ci.contract",
        SETUP_ACTION_PATH,
        `missing setup action contract: ${required}`,
      );
    }
  }
  const uses = extractUses(content);
  if (!sameOrderedArray(uses, SETUP_ACTION_USES)) {
    add(
      "ci.contract",
      SETUP_ACTION_PATH,
      "setup action may use only the reviewed pnpm and setup-node actions",
    );
  }
  if (/\bcontinue-on-error\s*:/iu.test(content)) {
    add(
      "ci.contract",
      SETUP_ACTION_PATH,
      "setup action contains a non-blocking step",
    );
  }
}

async function checkFullCiContract(root, files, add) {
  const absolutePath = path.join(root, FULL_CI_PATH);
  if (!files.includes(FULL_CI_PATH)) {
    add("ci.contract", FULL_CI_PATH, "full CI workflow is missing");
    return;
  }
  const content = await readFile(absolutePath, "utf8");
  if (!sameSet(new Set(extractRunCommands(content)), CI_WORKFLOW_COMMANDS)) {
    add(
      "ci.contract",
      FULL_CI_PATH,
      "full CI run commands differ from the reviewed gate sequence",
    );
  }
  const runners = extractMatrixRunners(content);
  if (!sameOrderedArray(runners, EXPECTED_FULL_CI_RUNNERS)) {
    add(
      "ci.contract",
      FULL_CI_PATH,
      `full CI matrix must require ${EXPECTED_FULL_CI_RUNNERS.join(", ")}`,
    );
  }
  for (const required of [
    "workflow_dispatch:",
    "tags:",
    '- "v*"',
    "permissions:\n  contents: read",
    "runs-on: ${{ matrix.os }}",
    "persist-credentials: false",
    ...CI_WORKFLOW_USES.map((action) => `uses: ${action}`),
  ]) {
    if (!content.includes(required)) {
      add("ci.contract", FULL_CI_PATH, `missing full CI contract: ${required}`);
    }
  }
  const allowedSet = new Set(CI_WORKFLOW_USES);
  const uses = extractUses(content);
  if (uses.some((action) => !allowedSet.has(action))) {
    add(
      "ci.contract",
      FULL_CI_PATH,
      "full CI may use only the reviewed checkout and workspace setup actions",
    );
  }
  for (const forbidden of [
    /\bcontinue-on-error\s*:/iu,
    /^\s*(?:if|shell|defaults|env)\s*:/gmu,
    /\bpull_request\s*:/iu,
    /^\s*branches\s*:/gmu,
    /\bschedule\s*:/iu,
  ]) {
    if (forbidden.test(content)) {
      add(
        "ci.contract",
        FULL_CI_PATH,
        "full CI contains a condition, shell override, environment block, branch trigger, pull request trigger, or schedule",
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
  const runners = extractMatrixRunners(content);
  if (!sameOrderedArray(runners, EXPECTED_RELEASE_SMOKE_RUNNERS)) {
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
    `node-version: ${EXPECTED_NODE_VERSION}`,
    `version: ${EXPECTED_PNPM_VERSION}`,
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
  const uses = extractUses(content);
  if (!sameOrderedArray(uses, RELEASE_SMOKE_USES)) {
    add(
      "release-smoke",
      relativePath,
      "release smoke may use only the reviewed checkout, pnpm setup, and setup-node actions",
    );
  }
  for (const forbidden of [
    /\bnpm\s+publish\b/iu,
    /\bpnpm\s+.*publish\b/iu,
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

async function checkReleaseWorkflowContract(root, files, add) {
  const relativePath = RELEASE_WORKFLOW_PATH;
  const absolutePath = path.join(root, relativePath);
  if (!files.includes(relativePath)) {
    return;
  }
  const content = await readFile(absolutePath, "utf8");
  for (const required of [
    "tags:",
    '- "v*"',
    "permissions:\n  contents: write",
    "uses: actions/checkout@v7",
    "persist-credentials: false",
    "CHANGELOG.md",
  ]) {
    if (!content.includes(required)) {
      add(
        "ci.contract",
        relativePath,
        `missing release workflow contract: ${required}`,
      );
    }
  }
  const uses = extractUses(content);
  if (!sameOrderedArray(uses, ["actions/checkout@v7"])) {
    add(
      "ci.contract",
      relativePath,
      "release workflow may use only actions/checkout@v7",
    );
  }
  for (const forbidden of [
    /\bnpm\s+publish\b/iu,
    /\bpnpm\s+.*publish\b/iu,
    /\bsecrets\./iu,
    /\bpull_request\s*:/iu,
    /^\s*branches\s*:/gmu,
    /\bschedule\s*:/iu,
    /\bcontinue-on-error\s*:/iu,
  ]) {
    if (forbidden.test(content)) {
      add(
        "ci.contract",
        relativePath,
        "release workflow must not publish to npm, read external secrets, or trigger outside v* tags",
      );
    }
  }
}

export async function checkCiContract(root, files, add) {
  for (const relativePath of files) {
    if (
      relativePath.startsWith(".github/") &&
      !ALLOWED_GITHUB_FILES.has(relativePath)
    ) {
      add(
        "ci.contract",
        relativePath,
        "only reviewed .github files and workflows are permitted",
      );
    }
  }
  await checkSetupActionContract(root, files, add);
  await checkReleaseSmokeContract(root, files, add);
  await checkReleaseWorkflowContract(root, files, add);
  await checkFullCiContract(root, files, add);

  const absoluteCi = path.join(root, CI_PATH);
  if (!existsSync(absoluteCi)) {
    return;
  }

  const content = await readFile(absoluteCi, "utf8");
  if (!sameSet(new Set(extractRunCommands(content)), CI_WORKFLOW_COMMANDS)) {
    add(
      "ci.contract",
      CI_PATH,
      "CI run commands differ from the reviewed gate sequence",
    );
  }
  const runners = extractMatrixRunners(content);
  if (!sameOrderedArray(runners, EXPECTED_CI_RUNNERS)) {
    add(
      "ci.contract",
      CI_PATH,
      `CI matrix must require ${EXPECTED_CI_RUNNERS.join(", ")}`,
    );
  }
  for (const required of [
    "permissions:\n  contents: read",
    "runs-on: ${{ matrix.os }}",
    "persist-credentials: false",
    ...CI_WORKFLOW_USES.map((action) => `uses: ${action}`),
  ]) {
    if (!content.includes(required)) {
      add("ci.contract", CI_PATH, `missing CI contract: ${required}`);
    }
  }
  const allowedSet = new Set(CI_WORKFLOW_USES);
  const uses = extractUses(content);
  if (
    uses.some((action) => !allowedSet.has(action)) ||
    CI_WORKFLOW_USES.some((action) => !uses.includes(action))
  ) {
    add(
      "ci.contract",
      CI_PATH,
      "CI may use only the reviewed checkout and workspace setup actions",
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
        CI_PATH,
        "CI contains a condition, shell override, environment block, or alternate trigger",
      );
    }
  }
}
