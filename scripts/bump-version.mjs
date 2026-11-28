#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;

const MANIFEST_PATHS = [
  "package.json",
  "packages/protocol/package.json",
  "packages/core/package.json",
  "packages/cli/package.json",
];

function usage() {
  process.stderr.write(
    "usage: node scripts/bump-version.mjs <semver> [--dry-run]\n",
  );
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positionals = args.filter((arg) => arg !== "--dry-run");
  if (positionals.length !== 1) {
    usage();
  }
  const nextVersion = positionals[0];
  if (!SEMVER_RE.test(nextVersion) || nextVersion === "0.0.0") {
    process.stderr.write(
      `error: invalid release version ${JSON.stringify(nextVersion)} (must be semver and not 0.0.0)\n`,
    );
    process.exit(2);
  }

  for (const relPath of MANIFEST_PATHS) {
    const absPath = path.join(REPO_ROOT, relPath);
    const raw = await fs.readFile(absPath, "utf8");
    const parsed = JSON.parse(raw);
    const previous = parsed.version;
    parsed.version = nextVersion;
    const updated = `${JSON.stringify(parsed, null, 2)}\n`;
    if (dryRun) {
      process.stdout.write(
        `[dry-run] ${relPath}: ${previous} -> ${nextVersion}\n`,
      );
    } else {
      await fs.writeFile(absPath, updated, "utf8");
      process.stdout.write(`${relPath}: ${previous} -> ${nextVersion}\n`);
    }
  }

  const changelogPath = path.join(REPO_ROOT, "CHANGELOG.md");
  try {
    const changelog = await fs.readFile(changelogPath, "utf8");
    const headingRe = new RegExp(
      `^## \\[${nextVersion.replaceAll(".", "\\.")}\\]`,
      "mu",
    );
    if (!headingRe.test(changelog)) {
      process.stderr.write(
        `warning: CHANGELOG.md does not yet contain a "## [${nextVersion}]" section\n`,
      );
    }
  } catch {
    process.stderr.write("warning: CHANGELOG.md could not be read\n");
  }
}

await main();
