import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  isInsidePath,
  normalizeAbsolute,
  PI_INSTRUCTION_FILE_NAMES,
} from "../platform/path.ts";
import type { SrtProfileInput } from "./types.ts";
import { writeRoots } from "./windows.ts";

function standardGitDenyPaths(gitDir: string): string[] {
  return [
    path.join(gitDir, "config"),
    path.join(gitDir, "config.worktree"),
    path.join(gitDir, "hooks"),
    path.join(gitDir, "info"),
    path.join(gitDir, "objects", "info"),
    path.join(gitDir, "objects", "pack"),
  ];
}

function resolveWorktreeGitPaths(root: string, gitFile: string): string[] {
  const denied = new Set<string>([gitFile]);
  let rawPointer = "";
  try {
    rawPointer = readFileSync(gitFile, "utf8");
  } catch {
    return [...denied];
  }
  const match = rawPointer.match(/^\s*gitdir:\s*(.+?)\s*$/mu);
  if (match === null || match[1] === undefined || match[1].length === 0) {
    return [...denied];
  }
  const rawGitDir = match[1].trim();
  const worktreeGitDir = normalizeAbsolute(
    path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(root, rawGitDir),
  );
  let commonGitDir: string | null = null;
  try {
    const rawCommon = readFileSync(
      path.join(worktreeGitDir, "commondir"),
      "utf8",
    ).trim();
    if (rawCommon.length > 0) {
      commonGitDir = normalizeAbsolute(
        path.isAbsolute(rawCommon)
          ? rawCommon
          : path.resolve(worktreeGitDir, rawCommon),
      );
    }
  } catch {
    // Standalone gitdir pointer without commondir (e.g. submodule or custom gitdir).
  }
  if (commonGitDir !== null && commonGitDir !== worktreeGitDir) {
    for (const entry of [
      path.join(worktreeGitDir, "config"),
      path.join(worktreeGitDir, "config.worktree"),
      path.join(worktreeGitDir, "hooks"),
      path.join(worktreeGitDir, "info"),
      ...standardGitDenyPaths(commonGitDir),
    ]) {
      denied.add(entry);
    }
  } else {
    for (const entry of standardGitDenyPaths(worktreeGitDir)) {
      denied.add(entry);
    }
  }
  return [...denied];
}

function protectedGitPathsForRoot(root: string): string[] {
  const rootGitPath = path.join(root, ".git");
  try {
    const stat = lstatSync(rootGitPath);
    if (stat.isFile()) {
      return resolveWorktreeGitPaths(root, rootGitPath);
    }
  } catch {
    // Missing or unreadable .git keeps the standard directory deny paths.
  }
  return standardGitDenyPaths(rootGitPath);
}

export function srtProfile(input: SrtProfileInput): SandboxRuntimeConfig {
  const codepunkHome = normalizeAbsolute(input.codepunkHome);
  const allowedDomains = [...new Set(input.networkAllow ?? [])].sort();
  const deniedDomains = [...new Set(input.networkDeny ?? [])].sort();
  const networkGuard = input.networkGuard ?? null;
  const filterRequest = networkGuard?.filterRequest;
  const projectConfig = path.join(
    normalizeAbsolute(input.deliveryRoot),
    ".codepunk",
  );
  if (input.worker !== undefined) {
    const worker = input.worker;
    const commonGitDir = normalizeAbsolute(worker.commonGitDir);
    return {
      network: {
        allowedDomains,
        deniedDomains,
        ...(filterRequest !== undefined ? { filterRequest } : {}),
      },
      filesystem: {
        denyRead: [
          normalizeAbsolute(worker.parentRoot),
          normalizeAbsolute(worker.siblingRoot),
          codepunkHome,
          projectConfig,
          ...(worker.installRoots ?? []).map((entry) =>
            normalizeAbsolute(entry),
          ),
        ],
        allowRead: [
          normalizeAbsolute(worker.worktree),
          normalizeAbsolute(worker.runDir),
          path.join(commonGitDir, "objects"),
          path.join(commonGitDir, "config"),
          path.join(commonGitDir, "HEAD"),
          path.join(commonGitDir, "refs"),
          normalizeAbsolute(worker.worktreeGitDir),
        ],
        allowWrite: [
          normalizeAbsolute(worker.worktree),
          normalizeAbsolute(worker.runDir),
          path.join(commonGitDir, "objects"),
          normalizeAbsolute(worker.worktreeGitDir),
        ],
        denyWrite: [
          ...PI_INSTRUCTION_FILE_NAMES.map((name) =>
            path.join(normalizeAbsolute(worker.worktree), name),
          ),
          path.join(normalizeAbsolute(worker.worktree), ".codepunk"),
          path.join(commonGitDir, "hooks"),
          path.join(commonGitDir, "config"),
          path.join(commonGitDir, "info"),
          path.join(commonGitDir, "packed-refs"),
          path.join(commonGitDir, "refs"),
          path.join(commonGitDir, "objects", "info"),
          path.join(commonGitDir, "objects", "pack"),
        ],
      },
    };
  }
  const workspaceRoot = normalizeAbsolute(input.workspaceRoot);
  const additionalRoots = (input.additionalRoots ?? []).map((entry) =>
    normalizeAbsolute(entry),
  );
  const allRoots = [workspaceRoot, ...additionalRoots];
  const protectedConfigDirs = [
    projectConfig,
    ...additionalRoots.map((root) => path.join(root, ".codepunk")),
  ];
  const protectedGitPaths = [
    ...new Set(allRoots.flatMap((root) => protectedGitPathsForRoot(root))),
  ];
  const sensitiveHomeDirs =
    input.userHome === undefined || input.userHome.trim().length === 0
      ? []
      : [".ssh", ".aws", ".gnupg", ".kube", ".docker"]
          .map((dir) => path.join(normalizeAbsolute(input.userHome!), dir))
          .filter(
            (candidate) =>
              !allRoots.some(
                (root) =>
                  isInsidePath(candidate, root) ||
                  isInsidePath(root, candidate),
              ),
          );
  const readOnly = input.readOnly === true;
  return {
    network: {
      allowedDomains,
      deniedDomains,
      ...(filterRequest !== undefined ? { filterRequest } : {}),
    },
    filesystem: {
      denyRead: [
        ...new Set([
          codepunkHome,
          ...protectedConfigDirs,
          ...sensitiveHomeDirs,
        ]),
      ],
      allowWrite: readOnly ? [] : writeRoots(input),
      denyWrite: [
        ...(readOnly ? allRoots : []),
        codepunkHome,
        ...protectedConfigDirs,
        ...protectedGitPaths,
      ],
    },
  };
}
