import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isInsidePath,
  normalizeAbsolute,
  PI_INSTRUCTION_FILE_NAMES,
} from "./path.ts";

/**
 * Find the first instruction file Pi would accept in one directory.
 *
 * Pi's public discovery helper walks from the invocation directory to the
 * filesystem root and reads every candidate before Codepunk can apply its
 * exact-root trust rule. This bounded copy keeps the same filename
 * precedence and symlink behavior without reading above the delivery root or
 * reading an untrusted project file before the decision is known.
 */
async function firstInstructionFile(directory: string): Promise<string | null> {
  for (const name of PI_INSTRUCTION_FILE_NAMES) {
    const candidate = path.join(directory, name);
    try {
      // Pi uses statSync, so a symlink to a regular file is discovered and
      // rejected later by the context reader's symlink check.
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return normalizeAbsolute(candidate);
      }
    } catch {
      // Missing or unreadable candidates are skipped, matching Pi's
      // existence check. A later candidate in the same directory may still
      // be valid.
    }
  }
  return null;
}

export async function discoverUserInstructionFile(
  agentDir: string,
): Promise<string | null> {
  return firstInstructionFile(normalizeAbsolute(agentDir));
}

/**
 * Discover project instruction files from the delivery root down to cwd.
 *
 * The returned order is root-to-cwd, matching Pi's ancestor ordering. Files
 * above the delivery root are never inspected, even when the session cwd is
 * nested deeply inside a checkout.
 */
export async function discoverProjectInstructionFiles(input: {
  root: string;
  cwd: string;
}): Promise<string[]> {
  const root = normalizeAbsolute(input.root);
  const cwd = normalizeAbsolute(input.cwd);
  if (!isInsidePath(root, cwd)) {
    const rootFile = await firstInstructionFile(root);
    return rootFile === null ? [] : [rootFile];
  }
  const directories: string[] = [];
  let current = cwd;
  for (;;) {
    directories.push(current);
    if (current === root) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current || !isInsidePath(root, parent)) {
      break;
    }
    current = parent;
  }
  const files: string[] = [];
  for (const directory of directories.reverse()) {
    const file = await firstInstructionFile(directory);
    if (file !== null) {
      files.push(file);
    }
  }
  return files;
}
