import path from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  isInsidePath,
  normalizeAbsolute,
  PI_INSTRUCTION_FILE_NAMES,
} from "../platform/path.ts";
import type { SrtProfileInput } from "./types.ts";
import { writeRoots } from "./windows.ts";

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
  const protectedGitPaths = allRoots.flatMap((root) => {
    const rootGitDir = path.join(root, ".git");
    return [
      path.join(rootGitDir, "config"),
      path.join(rootGitDir, "config.worktree"),
      path.join(rootGitDir, "hooks"),
      path.join(rootGitDir, "info"),
      path.join(rootGitDir, "objects", "info"),
      path.join(rootGitDir, "objects", "pack"),
    ];
  });
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
