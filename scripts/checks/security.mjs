import { readFile } from "node:fs/promises";
import path from "node:path";
import { escapeRegExp } from "./shared.mjs";

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

export async function scanFileContents(root, files, add) {
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
