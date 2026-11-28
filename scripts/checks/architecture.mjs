import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import {
  CLI_FUNCTION_LIMIT,
  CLI_SIZE_EXEMPTIONS,
  CLI_SOURCE_FILE_LIMIT,
  CORE_SOURCE_FILE_LIMIT,
  PACKAGE_BY_NAME,
  PACKAGE_SPECS,
  REVIEWED_COMPUTED_IMPORTS,
  isInside,
} from "./shared.mjs";

const { createScanner, LanguageVariant, ScriptTarget, SyntaxKind } = ts;

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
      relativePath !== `${packageDirectory}/build.mjs` &&
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
  const scanner = createScanner(
    ScriptTarget.Latest,
    false,
    LanguageVariant.Standard,
    content,
  );
  let previousToken;
  const templateBraceDepths = [];
  for (let token = scanner.scan(); token !== SyntaxKind.EndOfFileToken;) {
    if (token === SyntaxKind.TemplateHead) {
      templateBraceDepths.push(0);
    } else if (templateBraceDepths.length > 0) {
      const frame = templateBraceDepths.length - 1;
      if (token === SyntaxKind.OpenBraceToken) {
        templateBraceDepths[frame] += 1;
      } else if (token === SyntaxKind.CloseBraceToken) {
        if (templateBraceDepths[frame] === 0) {
          token = scanner.reScanTemplateToken(false);
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
      token !== SyntaxKind.EndOfFileToken &&
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

function physicalLineCount(content) {
  if (content.length === 0) {
    return 0;
  }
  const withoutTrailingNewline = content.endsWith("\n")
    ? content.slice(0, -1)
    : content;
  return withoutTrailingNewline.split("\n").length;
}

function maskNonCode(content, ranges) {
  const characters = content.split("");
  for (const [start, end] of ranges) {
    for (let index = start; index < end; index += 1) {
      if (characters[index] !== "\n") {
        characters[index] = " ";
      }
    }
  }
  return characters.join("");
}

function matchingBrace(masked, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < masked.length; index += 1) {
    if (masked[index] === "{") {
      depth += 1;
    } else if (masked[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function lineOf(content, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content[cursor] === "\n") {
      line += 1;
    }
  }
  return line;
}

const FUNCTION_BLOCK_PATTERNS = [
  /\bfunction\b[^{;]*?\{/gu,
  /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=;]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=;{]+)?=>\s*\{/gu,
  /(?:^|\n)[ \t]*(?:(?:public|private|protected|static|async|readonly|override)\s+)*[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{;]+)?\{/gu,
];

const FUNCTION_BLOCK_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "return",
  "typeof",
  "new",
  "await",
  "import",
]);

function inspectFunctionSizes(relativePath, content, add) {
  const masked = maskNonCode(content, nonCodeRanges(content));
  const starts = new Set();
  for (const pattern of FUNCTION_BLOCK_PATTERNS) {
    for (const match of masked.matchAll(pattern)) {
      if (typeof match.index !== "number") {
        continue;
      }
      const leadingWhitespace = match[0].search(/\S/u);
      const start = match.index + Math.max(0, leadingWhitespace);
      const firstToken = /[A-Za-z_$][\w$]*/u.exec(
        masked.slice(start, start + 80),
      )?.[0];
      if (firstToken !== undefined && FUNCTION_BLOCK_KEYWORDS.has(firstToken)) {
        continue;
      }
      const openIndex = match.index + match[0].lastIndexOf("{");
      const closeIndex = matchingBrace(masked, openIndex);
      if (closeIndex === -1) {
        continue;
      }
      starts.add(`${start}:${closeIndex}`);
    }
  }
  for (const span of starts) {
    const [start, end] = span.split(":").map(Number);
    const lines = lineOf(content, end) - lineOf(content, start) + 1;
    if (lines > CLI_FUNCTION_LIMIT) {
      add(
        "cli.size",
        relativePath,
        `function starting at line ${lineOf(content, start)} has ${lines} lines; limit is ${CLI_FUNCTION_LIMIT}`,
      );
    }
  }
}

export async function checkCliSize(root, files, add) {
  const cliRoot = "packages/cli";
  for (const relativePath of sourceFilesForPackage(files, cliRoot)) {
    if (CLI_SIZE_EXEMPTIONS.has(relativePath)) {
      continue;
    }
    const content = await readFile(path.join(root, relativePath), "utf8");
    const lines = physicalLineCount(content);
    if (lines > CLI_SOURCE_FILE_LIMIT) {
      add(
        "cli.size",
        relativePath,
        `file has ${lines} lines; limit is ${CLI_SOURCE_FILE_LIMIT}`,
      );
    }
    inspectFunctionSizes(relativePath, content, add);
  }

  const eagerDirectories = [
    "packages/cli/src/args/",
    "packages/cli/src/commands/",
  ];
  for (const relativePath of sourceFilesForPackage(files, cliRoot)) {
    if (
      !eagerDirectories.some((directory) => relativePath.startsWith(directory))
    ) {
      continue;
    }
    const content = await readFile(path.join(root, relativePath), "utf8");
    if (
      /^(?![ \t]*\/\/)[ \t]*import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']@earendil-works\/pi-tui(?:\/[^"']*)?["']/mu.test(
        content,
      ) ||
      /^(?![ \t]*\/\/)[ \t]*import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["'](?:\.\.?\/)+tui(?:\.ts)?(?:\/[^"']*)?["']/mu.test(
        content,
      )
    ) {
      add(
        "cli.import",
        relativePath,
        "eager CLI argument and command modules must not statically import the TUI",
      );
    }
  }
}

export async function checkCoreSize(root, files, add) {
  const coreRoot = "packages/core/src";
  for (const relativePath of sourceFilesForPackage(files, coreRoot)) {
    const content = await readFile(path.join(root, relativePath), "utf8");
    const lines = physicalLineCount(content);
    if (lines > CORE_SOURCE_FILE_LIMIT) {
      add(
        "core.size",
        relativePath,
        `file has ${lines} lines; limit is ${CORE_SOURCE_FILE_LIMIT}`,
      );
    }
  }
}

export async function checkSourceImports(root, files, add) {
  for (const spec of PACKAGE_SPECS) {
    const packageRoot = path.join(root, spec.dir);
    const allowedInternal = new Set(spec.internal);
    const declaredDependencies = new Set([...spec.external, ...spec.internal]);

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
        if (packageName?.startsWith("codepunk-")) {
          const allowedSegments = packageName.startsWith("@") ? 2 : 1;
          const packageSegments = specifier.split("/").length;
          if (packageSegments > allowedSegments) {
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
