#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkCliSize,
  checkCoreSize,
  checkSourceImports,
} from "./checks/architecture.mjs";
import { checkCiContract } from "./checks/ci.mjs";
import {
  checkCompatCorpus,
  checkControlCorpus,
  checkEvalContract,
} from "./checks/compat.mjs";
import {
  checkDocumentationContract,
  checkMarkdownLinks,
  checkPlatformDocumentation,
} from "./checks/docs.mjs";
import {
  checkLineEndingPolicy,
  checkNodeVersion,
  checkRequiredDocs,
  checkRootEntries,
  classifyForbiddenFile,
  hasForbiddenSegment,
  scanWorkingTreeHygiene,
} from "./checks/hygiene.mjs";
import {
  checkBuiltEntries,
  checkLockfile,
  checkPackageManifest,
  checkPackagePackaging,
  checkPnpmWorkspace,
  checkRootManifest,
  parsePnpmLock,
} from "./checks/packages.mjs";
import { scanFileContents } from "./checks/security.mjs";
import {
  PACKAGE_SPECS,
  listFiles,
  readJson,
  sameSet,
} from "./checks/shared.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

export async function checkRepository({
  root = SCRIPT_ROOT,
  requireBuilt = false,
  skipPack = false,
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
  await checkNodeVersion(normalizedRoot, add);
  checkRequiredDocs(normalizedRoot, add);

  const { tracked, trackedDirectories, scanned } =
    await listFiles(normalizedRoot);
  const trackedSet = new Set(tracked);
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
    if (!relativePath.startsWith("tests/fixtures/compat/")) {
      const classification = classifyForbiddenFile(name);
      if (classification) {
        add(classification[0], relativePath, classification[1]);
      }
    }
  }

  await scanWorkingTreeHygiene(
    normalizedRoot,
    add,
    trackedDirectories,
    trackedSet,
  );
  await scanFileContents(normalizedRoot, scanned, add);
  await checkMarkdownLinks(normalizedRoot, scanned, add);
  await checkCiContract(normalizedRoot, scanned, add);
  await checkDocumentationContract(normalizedRoot, add);
  await checkPlatformDocumentation(normalizedRoot, add);
  await checkControlCorpus(normalizedRoot, add);
  await checkCompatCorpus(normalizedRoot, add);
  checkEvalContract(normalizedRoot, add);
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
          { skipPack },
        ),
      );
    }
  }
  await Promise.all(packagingChecks);

  const relativeLockfile = "pnpm-lock.yaml";
  let lockfileContent;
  try {
    lockfileContent = await readFile(
      path.join(normalizedRoot, relativeLockfile),
      "utf8",
    );
  } catch (error) {
    add(
      "deps.lock",
      relativeLockfile,
      `cannot read pnpm lockfile: ${error.message}`,
    );
    lockfileContent = undefined;
  }
  if (lockfileContent) {
    checkLockfile(parsePnpmLock(lockfileContent), add);
  }

  await checkSourceImports(normalizedRoot, scanned, add);
  await checkCliSize(normalizedRoot, scanned, add);
  await checkCoreSize(normalizedRoot, scanned, add);

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
