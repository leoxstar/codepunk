import { realpathSync } from "node:fs";
import path from "node:path";

export function normalizeAbsolute(value: string): string {
  return path.resolve(value);
}

export function isInsidePath(parent: string, child: string): boolean {
  const resolvedParent = normalizeAbsolute(parent);
  const resolvedChild = normalizeAbsolute(child);
  const relative = path.relative(resolvedParent, resolvedChild);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Resolve the existing portion of a path through symlinks.
 *
 * Lexical checks alone let a symlink inside the workspace point at a file
 * outside it. The longest existing prefix is realpath'd, and the remaining
 * non-existent suffix is appended again so a write to a new file is still
 * checked against its real parent directory.
 */
export function resolveRealPath(candidate: string): string {
  const resolved = normalizeAbsolute(candidate);
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return path.join(real, ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

const SENSITIVE_BASENAMES = new Set([
  ".npmrc",
  ".netrc",
  ".aws",
  ".ssh",
  ".config",
  ".docker",
  ".kube",
  "credentials.json",
  "auth.json",
]);

export function isSensitivePath(
  candidate: string,
  codepunkHome?: string,
  projectRoot?: string | readonly string[],
): boolean {
  const normalized = normalizeAbsolute(candidate);
  if (codepunkHome && isInsidePath(codepunkHome, normalized)) {
    return true;
  }
  const projectRoots =
    projectRoot === undefined
      ? []
      : typeof projectRoot === "string"
        ? [projectRoot]
        : projectRoot;
  if (
    projectRoots.some((root) =>
      isInsidePath(path.join(normalizeAbsolute(root), ".codepunk"), normalized),
    )
  ) {
    return true;
  }
  const base = path.basename(normalized);
  if (base === ".env.example") {
    return false;
  }
  if (base === ".env" || base.startsWith(".env.")) {
    return true;
  }
  if (base.endsWith(".pem") || base === "id_rsa" || base === "id_ed25519") {
    return true;
  }
  return normalized
    .split(path.sep)
    .some((segment) => SENSITIVE_BASENAMES.has(segment));
}

/**
 * Instruction filenames Pi 1.5.2 recognises, copied once from its
 * `loadContextFileFromDir` candidate list. Trust, bounded context discovery,
 * worker sandboxing, and write protection share this list, so the contract
 * test must fail when the pinned host changes its candidates.
 */
export const PI_INSTRUCTION_FILE_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

const INSTRUCTION_BASENAMES = new Set(
  PI_INSTRUCTION_FILE_NAMES.map((name) => name.toLowerCase()),
);

export function isInstructionFile(candidate: string): boolean {
  const normalized = normalizeAbsolute(candidate);
  // Compare case-insensitively: Pi accepts AGENTS.MD/CLAUDE.MD, and a
  // case-insensitive filesystem resolves claude.md to the same file. An
  // exact-case check would let that name bypass protection.
  if (INSTRUCTION_BASENAMES.has(path.basename(normalized).toLowerCase())) {
    return true;
  }
  const normalizedDirectory = normalized.toLowerCase();
  return (
    normalizedDirectory.endsWith(path.join(".codepunk", "config.toml")) ||
    normalizedDirectory.endsWith(path.join(".codepunk", "mcp.toml")) ||
    normalizedDirectory.endsWith(path.join(".codepunk", "mcp.json")) ||
    normalizedDirectory.endsWith(path.join(".codepunk", "policy.toml")) ||
    normalizedDirectory.endsWith(path.join(".codepunk", "local.toml"))
  );
}

export function relativeDisplayPath(root: string, candidate: string): string {
  const relative = path.relative(
    normalizeAbsolute(root),
    normalizeAbsolute(candidate),
  );
  return relative === "" ? "." : relative.split(path.sep).join("/");
}
