import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { EXPECTED_FULL_CI_RUNNERS, isInside } from "./shared.mjs";

export async function checkPlatformDocumentation(root, add) {
  const runnerLine = `CI runners: ${EXPECTED_FULL_CI_RUNNERS.map(
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
    runners.length !== EXPECTED_FULL_CI_RUNNERS.length ||
    !runners.every(
      (runner, index) => runner === EXPECTED_FULL_CI_RUNNERS[index],
    )
  ) {
    add(
      "docs.platforms",
      relativePath,
      `CI runner table must require ${EXPECTED_FULL_CI_RUNNERS.join(", ")} in order`,
    );
  }
}

export async function checkDocumentationContract(root, add) {
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
    "`1.6.0`",
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

export async function checkMarkdownLinks(root, files, add) {
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
