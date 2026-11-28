import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { walkFiles } from "./shared.mjs";

const EVAL_REQUIRED_FILES = [
  "eval/cases.jsonl",
  "eval/baseline.json",
  "eval/run.mjs",
];

const COMPAT_CORPUS_DIR = "tests/fixtures/compat";

const REQUIRED_CONTROL_RULES = [
  "deps.direction",
  "deps.pin",
  "deps.review",
  "deps.lock",
  "docs.link",
  "docs.absolute",
  "docs.contract",
  "docs.platforms",
  "security.absolute-path",
  "security.credential",
  "security.research-import",
  "hygiene.forbidden",
  "hygiene.env",
  "hygiene.binary",
  "repo.root",
  "repo.lineEndings",
  "repo.docs",
  "pkg.manifest",
  "pkg.exports",
  "pkg.layout",
  "pkg.license",
  "pkg.pack",
  "pkg.built",
  "source.import",
  "cli.size",
  "cli.import",
  "ci.contract",
  "release-smoke",
  "eval.baseline",
];

export function checkEvalBaseline(root, add) {
  const relativePath = "eval/baseline.json";
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
  } catch (error) {
    add(
      "eval.baseline",
      relativePath,
      `cannot read baseline: ${error.message}`,
    );
    return;
  }
  if (
    baseline === null ||
    typeof baseline !== "object" ||
    baseline.version !== 1 ||
    baseline.cases === null ||
    typeof baseline.cases !== "object" ||
    Object.keys(baseline.cases).length === 0 ||
    !Number.isInteger(baseline.min_passed) ||
    baseline.min_passed < Object.keys(baseline.cases).length ||
    !Number.isInteger(baseline.max_failed) ||
    baseline.max_failed !== 0
  ) {
    add(
      "eval.baseline",
      relativePath,
      "baseline must require every case to pass and allow zero failures",
    );
  }
}

export function checkEvalContract(root, add) {
  for (const relativePath of EVAL_REQUIRED_FILES) {
    if (!existsSync(path.join(root, relativePath))) {
      add("eval.contract", relativePath, "required eval file is missing");
    }
  }
  checkEvalBaseline(root, add);
}

/**
 * D84 structural control-corpus check: verifies tests/repository.test.mjs
 * exists and retains explicit negative-control coverage for every required
 * repository rule without pinning a brittle SHA-256 of the test file.
 */
export async function checkControlCorpus(root, add) {
  const relativePath = "tests/repository.test.mjs";
  let content;
  try {
    content = await readFile(path.join(root, relativePath), "utf8");
  } catch (error) {
    add(
      "repo.controls",
      relativePath,
      `cannot read negative-control corpus: ${error.message}`,
    );
    return;
  }
  const missing = REQUIRED_CONTROL_RULES.filter(
    (rule) => !content.includes(`"${rule}"`),
  );
  if (missing.length > 0) {
    add(
      "repo.controls",
      relativePath,
      `negative-control corpus is missing coverage for rule(s): ${missing.join(", ")}`,
    );
  }
}

function compatCorpusEntries(manifest) {
  const entries = [];
  const addEntry = (relativePath, digest) => {
    if (
      typeof relativePath === "string" &&
      typeof digest === "string" &&
      /^[a-f0-9]{64}$/u.test(digest)
    ) {
      entries.push([relativePath, digest]);
    }
  };
  const files = manifest?.files;
  if (Array.isArray(files)) {
    for (const file of files) {
      addEntry(file?.path, file?.sha256);
    }
  } else if (files !== null && typeof files === "object") {
    for (const [relativePath, digest] of Object.entries(files)) {
      addEntry(relativePath, digest);
    }
  }
  if (entries.length === 0 && Array.isArray(manifest)) {
    for (const file of manifest) {
      addEntry(file?.path, file?.sha256);
    }
  }
  return entries;
}

async function checkSingleCompatCorpus(root, corpusRelative, add) {
  const corpusRoot = path.join(root, corpusRelative);
  const manifestRelative = `${corpusRelative}/MANIFEST.json`;
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(root, manifestRelative), "utf8"),
    );
  } catch (error) {
    add(
      "compat.corpus",
      manifestRelative,
      `cannot read the compatibility corpus manifest: ${error.message}`,
    );
    return;
  }
  const entries = compatCorpusEntries(manifest);
  if (entries.length === 0) {
    add(
      "compat.corpus",
      manifestRelative,
      "the compatibility corpus manifest lists no files",
    );
    return;
  }
  const listed = new Set();
  for (const [relativePath, digest] of entries) {
    listed.add(relativePath);
    const absolutePath = path.join(corpusRoot, relativePath);
    let actual;
    try {
      actual = createHash("sha256")
        .update(await readFile(absolutePath))
        .digest("hex");
    } catch (error) {
      add(
        "compat.corpus",
        `${corpusRelative}/${relativePath}`,
        `corpus file listed in the manifest is missing: ${error.message}`,
      );
      continue;
    }
    if (actual !== digest) {
      add(
        "compat.corpus",
        `${corpusRelative}/${relativePath}`,
        `corpus digest ${actual} does not match the manifest digest ${digest}`,
      );
    }
  }
  for (const relativePath of await walkFiles(corpusRoot, new Set())) {
    if (relativePath === "MANIFEST.json" || listed.has(relativePath)) {
      continue;
    }
    add(
      "compat.corpus",
      `${corpusRelative}/${relativePath}`,
      "corpus file is not listed in the manifest",
    );
  }
}

export async function checkCompatCorpus(root, add) {
  const compatRoot = path.join(root, COMPAT_CORPUS_DIR);
  if (!existsSync(compatRoot)) {
    return;
  }
  const entries = await readdir(compatRoot, { withFileTypes: true });
  const versionDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const version of versionDirs) {
    await checkSingleCompatCorpus(root, `${COMPAT_CORPUS_DIR}/${version}`, add);
  }
}
