import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  EXPECTED_NODE_VERSION,
  GENERATED_DIRECTORIES,
  IGNORED_PRODUCT_STATE_DIRECTORIES,
  LOCAL_STATE_DIRECTORIES,
  REQUIRED_PRODUCT_FILES,
  RESEARCH_ARTIFACT_DIRECTORIES,
  ROOT_ENTRIES,
  RUNTIME_STATE_DIRECTORIES,
  TRANSIENT_ROOT_ENTRY,
  TRANSIENT_ROOT_SETTLE_MS,
  WORKTREES_ROOT_ENTRY,
  isGitIgnored,
} from "./shared.mjs";

export function isPackageSourcePath(relativePath) {
  const segments = relativePath.toLowerCase().split("/");
  return segments[0] === "packages" && segments[2] === "src";
}

export function isProductPackagePath(relativePath) {
  return relativePath.toLowerCase().split("/")[0] === "packages";
}

export function hasForbiddenSegment(relativePath) {
  if (relativePath.startsWith("tests/fixtures/compat/")) {
    return undefined;
  }
  const packageSource = isPackageSourcePath(relativePath);
  const productPackage = isProductPackagePath(relativePath);
  for (const rawSegment of relativePath.split("/")) {
    const segment = rawSegment.toLowerCase();
    if (
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

export function classifyForbiddenFile(name) {
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

export async function scanWorkingTreeHygiene(
  root,
  add,
  directoriesWithTrackedFiles,
  trackedFiles = new Set(),
) {
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
      if (
        !relativeDirectory &&
        entry.isDirectory() &&
        entry.name === WORKTREES_ROOT_ENTRY
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        if (
          relativePath === "tests/fixtures/compat" ||
          relativePath.startsWith("tests/fixtures/compat/")
        ) {
          continue;
        }
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
          if (
            normalizedName.endsWith(".tsbuildinfo") &&
            isGitIgnored(root, relativePath) &&
            !trackedFiles.has(relativePath)
          ) {
            continue;
          }
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

export async function checkRootEntries(root, add) {
  await settleTransientRootEntries(root);
  const entries = (await readdir(root, { withFileTypes: true })).map(
    (entry) => entry.name,
  );

  for (const entry of entries) {
    if (entry === ".git") {
      continue;
    }
    if (entry === WORKTREES_ROOT_ENTRY) {
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

export async function checkLineEndingPolicy(root, add) {
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

export async function checkNodeVersion(root, add) {
  const relativePath = ".node-version";
  try {
    const value = (
      await readFile(path.join(root, relativePath), "utf8")
    ).trim();
    if (value !== EXPECTED_NODE_VERSION) {
      add(
        "pkg.manifest",
        relativePath,
        `expected Node version ${EXPECTED_NODE_VERSION}, found ${value}`,
      );
    }
  } catch (error) {
    add(
      "pkg.manifest",
      relativePath,
      `cannot read .node-version: ${error.message}`,
    );
  }
}

export function checkRequiredDocs(root, add) {
  for (const relativePath of REQUIRED_PRODUCT_FILES) {
    if (!existsSync(path.join(root, relativePath))) {
      add("repo.docs", relativePath, "required product file is missing");
    }
  }
}
