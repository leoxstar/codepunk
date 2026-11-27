import { homedir } from "node:os";
import path from "node:path";
import type {
  Coverage,
  Decision,
  Effects,
  PolicyDecision,
} from "codepunk-protocol";
import type { ApprovalClass } from "../config/index.ts";
import { isMcpResourceTool } from "../mcp/names.ts";
import {
  isInsidePath,
  isInstructionFile,
  isSensitivePath,
  normalizeAbsolute,
  resolveRealPath,
} from "../platform/path.ts";
import type { PolicyRequest } from "./match.ts";

export interface PathDecision {
  decision: Decision;
  reason: string;
  target: string | null;
  approvalClass: ApprovalClass;
}

export function isMcpProductTool(tool: string): boolean {
  return tool.startsWith("mcp__") || isMcpResourceTool(tool);
}

export function isPluginProductTool(tool: string): boolean {
  return tool.startsWith("plugin__");
}

export function toolEffects(tool: string): Effects {
  switch (tool) {
    case "read":
    case "search":
    case "lsp_query":
    case "memory_search":
    case "subagent":
      return { fs: "read", shell: false, network: false };
    case "plan":
    case "todo":
    case "ask_user":
    case "tool_search":
      return { fs: "none", shell: false, network: false };
    case "write":
    case "edit":
      return { fs: "write", shell: false, network: false };
    case "bash":
    case "exec":
    case "user_bash":
      return { fs: "unknown", shell: true, network: true };
    case "list_mcp_resources":
    case "list_mcp_resource_templates":
    case "read_mcp_resource":
    case "web_fetch":
    case "web_search":
      return { fs: "none", shell: false, network: true };
    default:
      return { fs: "unknown", shell: false, network: false };
  }
}

export function effectsForTool(tool: string): Effects {
  return toolEffects(tool);
}

export function coverageFor(
  tool: string,
  sandbox: PolicyDecision["decision"] | undefined,
): Coverage {
  if (isMcpProductTool(tool)) {
    return "uncovered";
  }
  if (isPluginProductTool(tool)) {
    return "app-layer";
  }
  if (tool === "bash" || tool === "exec" || tool === "user_bash") {
    return sandbox === "allow" ? "enforced" : "uncovered";
  }
  if (
    tool === "read" ||
    tool === "search" ||
    tool === "lsp_query" ||
    tool === "memory_search"
  ) {
    return "app-layer";
  }
  if (tool === "web_fetch" || tool === "web_search") {
    return "app-layer";
  }
  if (
    tool === "plan" ||
    tool === "todo" ||
    tool === "ask_user" ||
    tool === "subagent" ||
    tool === "tool_search"
  ) {
    return "app-layer";
  }
  if (tool === "write" || tool === "edit") {
    return "app-layer";
  }
  return "uncovered";
}

function expandHome(candidate: string): string {
  if (candidate === "~") {
    return homedir();
  }
  if (candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    return path.join(homedir(), candidate.slice(2));
  }
  return candidate;
}

export function decisionForPath(
  request: PolicyRequest,
  candidate: string | undefined,
  mutating: boolean,
): PathDecision {
  if (candidate === undefined || candidate.length === 0) {
    return {
      decision: "deny",
      reason: "path is missing",
      target: null,
      approvalClass: "unknown",
    };
  }
  const expanded = expandHome(candidate);
  const target = normalizeAbsolute(
    path.isAbsolute(expanded) ? expanded : path.resolve(request.cwd, expanded),
  );
  // A discovered skill is the only exact-file exception to the protected
  // home/project roots. Check it before the lexical workspace boundary so the
  // documented "read this skill file" path remains usable.
  const realTarget = resolveRealPath(target);
  if (
    !mutating &&
    request.readableSkillFiles?.some(
      (file) => resolveRealPath(file) === realTarget,
    ) === true
  ) {
    return {
      decision: "allow",
      reason: "discovered skill file",
      target: realTarget,
      approvalClass: "routine",
    };
  }
  if (!mutating && request.artifactRoot !== undefined) {
    const realArtifactRoot = resolveRealPath(request.artifactRoot);
    if (isInsidePath(realArtifactRoot, realTarget)) {
      return {
        decision: "allow",
        reason: "tool output artifact is readable",
        target: realTarget,
        approvalClass: "routine",
      };
    }
  }
  const workspaceRoots = [
    request.workspaceRoot,
    ...(request.additionalRoots ?? []),
  ].map((root) => normalizeAbsolute(root));
  const fullFilesystem = request.filesystem === "full";
  if (
    !fullFilesystem &&
    !workspaceRoots.some((root) => isInsidePath(root, target))
  ) {
    return {
      decision: "deny",
      reason: "path is outside the workspace",
      target,
      approvalClass: "protected",
    };
  }
  // Lexical containment is not enough: a symlink inside the workspace can
  // resolve outside it. Re-check the real location before allowing the path.
  const realWorkspaceRoots = workspaceRoots.map((root) =>
    resolveRealPath(root),
  );
  if (
    !fullFilesystem &&
    !realWorkspaceRoots.some((root) => isInsidePath(root, realTarget))
  ) {
    return {
      decision: "deny",
      reason: "path resolves through a symlink outside the workspace",
      target: realTarget,
      approvalClass: "protected",
    };
  }
  const realHome =
    request.codepunkHome === undefined
      ? null
      : resolveRealPath(request.codepunkHome);
  if (realHome !== null && isInsidePath(realHome, realTarget)) {
    return {
      decision: "deny",
      reason: "path resolves into codepunk home",
      target: realTarget,
      approvalClass: "protected",
    };
  }
  const realProjectRoots = [
    ...new Set([
      ...realWorkspaceRoots,
      ...(request.deliveryRoot === undefined
        ? []
        : [resolveRealPath(request.deliveryRoot)]),
    ]),
  ];
  if (
    realProjectRoots.some((root) =>
      isInsidePath(path.join(root, ".codepunk"), realTarget),
    )
  ) {
    return {
      decision: "deny",
      reason: "project codepunk state is protected from tools",
      target: realTarget,
      approvalClass: "protected",
    };
  }
  if (
    realProjectRoots.some((root) =>
      isInsidePath(resolveRealPath(path.join(root, ".git")), realTarget),
    )
  ) {
    return {
      decision: mutating ? "deny" : "ask",
      reason: "git metadata is protected",
      target: realTarget,
      approvalClass: "protected",
    };
  }
  if (isSensitivePath(realTarget, realHome ?? undefined, realProjectRoots)) {
    return {
      decision: "ask",
      reason: "sensitive path requires approval",
      target: realTarget,
      approvalClass: "sensitive",
    };
  }
  if (mutating) {
    if (isInstructionFile(realTarget)) {
      return {
        decision:
          request.mode === "headless" || request.mode === "worker"
            ? "deny"
            : "ask",
        reason: "instruction or configuration file is protected",
        target: realTarget,
        approvalClass: "protected",
      };
    }
    const writeSet = request.writeSet ?? [];
    if (
      !fullFilesystem &&
      (writeSet.length === 0 ||
        !writeSet.some((entry) =>
          isInsidePath(
            resolveRealPath(
              path.isAbsolute(entry) ? entry : path.resolve(request.cwd, entry),
            ),
            realTarget,
          ),
        ))
    ) {
      return {
        decision: "deny",
        reason: "path is outside the write set",
        target: realTarget,
        approvalClass: "protected",
      };
    }
  }
  return {
    decision: "allow",
    reason: "path is inside the allowed set",
    target,
    approvalClass: "routine",
  };
}
