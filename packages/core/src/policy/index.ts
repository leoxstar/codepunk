import type { Decision, PolicyDecision, PolicyLayer } from "codepunk-protocol";
import {
  effectiveApprovalDecision,
  type ApprovalClass,
} from "../config/index.ts";
import { MCP_RESOURCE_TOOL_NAMES } from "../mcp/names.ts";
import { recordHash } from "../platform/hash.ts";
import { isShellLauncher } from "../platform/shell.ts";
import { ruleMatches, type PolicyRequest, type PolicyRule } from "./match.ts";
import {
  coverageFor,
  decisionForPath,
  effectsForTool,
  isMcpProductTool,
  type PathDecision,
} from "./path-rules.ts";
import {
  addMutationTargets,
  addReadTargets,
  isReadOnlyShellCommand,
  readOnlyPipelineDecision,
} from "./read-only-shell.ts";
import {
  isNetworkShellCommand,
  shellScan,
  simpleShellArgv,
} from "./shell-scan.ts";

export type {
  PolicyLayerInput,
  PolicyRequest,
  PolicyRule,
  PolicyRuleFixture,
} from "./match.ts";
export { policyRequestForCall, ruleMatches } from "./match.ts";
export { coverageFor, effectsForTool, isMcpProductTool };
export { simpleShellArgv };

export type PolicyMode = "interactive" | "headless" | "worker";

interface RuleResult {
  decision: Decision | null;
  rule: PolicyRule | null;
}

const SEVERITY: Record<Decision, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

export const DEFAULT_POLICY_MODE: PolicyMode = "interactive";

function evaluateRules(
  rules: readonly PolicyRule[],
  request: PolicyRequest,
): RuleResult {
  let selected: PolicyRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule, request)) {
      continue;
    }
    if (
      selected === null ||
      SEVERITY[rule.decision] > SEVERITY[selected.decision]
    ) {
      selected = rule;
    }
  }
  return {
    decision: selected?.decision ?? null,
    rule: selected,
  };
}

function ruleHash(rule: PolicyRule | null, fallback: string): string {
  return rule ? recordHash(rule) : recordHash({ fallback });
}

function layersFor(
  request: PolicyRequest,
  userRule: PolicyRule | null,
  projectRule: PolicyRule | null,
): PolicyLayer[] {
  if (request.layers && request.layers.length > 0) {
    return request.layers.map((layer) => ({
      layer: layer.layer,
      source: layer.source,
      sha256: layer.sha256,
      rule_sha256:
        layer.layer === "project"
          ? ruleHash(projectRule, layer.sha256)
          : ruleHash(userRule, layer.sha256),
      ...(layer.layer === "project"
        ? projectRule?.justification === undefined
          ? {}
          : { justification: projectRule.justification }
        : userRule?.justification === undefined
          ? {}
          : { justification: userRule.justification }),
    }));
  }
  return [
    {
      layer: "user",
      source: "user",
      sha256: recordHash({
        layer: "user",
        rules: request.userRules ?? [],
      }),
      rule_sha256: ruleHash(userRule, "user-floor"),
      ...(userRule?.justification === undefined
        ? {}
        : { justification: userRule.justification }),
    },
  ];
}

function findExactExecRule(request: PolicyRequest): PolicyRule | null {
  if (request.argv === undefined) {
    return null;
  }
  for (const rule of request.userRules ?? []) {
    if (
      rule.decision !== "allow" ||
      rule.argv === undefined ||
      rule.argv.length !== request.argv.length
    ) {
      continue;
    }
    if (rule.argv.every((value, index) => value === request.argv?.[index])) {
      return rule;
    }
  }
  return null;
}

function shellDecision(request: PolicyRequest): {
  decision: Decision;
  reason: string;
  rule: PolicyRule | null;
  pathTarget: string | null;
  approvalClass: ApprovalClass;
} {
  const command = request.command ?? "";
  if (command.length === 0) {
    return {
      decision: "deny",
      reason: "shell command is empty",
      rule: null,
      pathTarget: null,
      approvalClass: "unknown",
    };
  }
  const scan = shellScan(command);
  if (scan.dangerous) {
    return {
      decision: "deny",
      reason: "dangerous shell command is denied",
      rule: {
        id: "shell.dangerous",
        tool: request.tool,
        decision: "deny",
        command,
      },
      pathTarget: null,
      approvalClass: "destructive",
    };
  }
  addMutationTargets(scan);
  const mutationTargets = [...scan.writeTargets, ...scan.sedTargets];
  let pathTarget: string | null = null;
  let pathDecision: PathDecision | undefined;
  for (const target of mutationTargets) {
    const check = decisionForPath(request, target, true);
    pathTarget = check.target;
    pathDecision =
      pathDecision === undefined ||
      SEVERITY[check.decision] > SEVERITY[pathDecision.decision]
        ? check
        : pathDecision;
  }
  if (pathDecision && pathDecision.decision !== "allow") {
    return {
      decision: pathDecision.decision,
      reason: pathDecision.reason,
      rule: {
        id: `shell.write.${pathDecision.decision}`,
        tool: request.tool,
        decision: pathDecision.decision,
        command,
      },
      pathTarget,
      approvalClass: pathDecision.approvalClass,
    };
  }
  if (scan.complex) {
    const pipeline = readOnlyPipelineDecision(request, command);
    if (pipeline !== null) {
      if (pipeline.decision !== "allow") {
        return {
          decision: pipeline.decision,
          reason: pipeline.reason,
          rule: {
            id: `shell.read.${pipeline.decision}`,
            tool: request.tool,
            decision: pipeline.decision,
            command,
          },
          pathTarget: pipeline.target,
          approvalClass: pipeline.approvalClass,
        };
      }
      return {
        decision: "allow",
        reason: pipeline.reason,
        rule: {
          id: "shell.read.pipeline",
          tool: request.tool,
          decision: "allow",
          command,
        },
        pathTarget: pipeline.target ?? pathTarget,
        approvalClass: "routine",
      };
    }
    return {
      decision: "ask",
      reason: "shell structure requires approval",
      rule: {
        id: "shell.complex",
        tool: request.tool,
        decision: "ask",
        command,
      },
      pathTarget,
      approvalClass: "destructive",
    };
  }
  const firstWord = scan.firstWord;
  if (isReadOnlyShellCommand(scan)) {
    addReadTargets(scan);
    let readDecision: PathDecision | null = null;
    for (const target of scan.readTargets) {
      if (/\$|[{}*?[\]]/u.test(target)) {
        const dynamic: PathDecision = {
          decision: "ask",
          reason: "dynamic read path requires approval",
          target: null,
          approvalClass: "sensitive",
        };
        readDecision =
          readDecision === null ||
          SEVERITY[dynamic.decision] > SEVERITY[readDecision.decision]
            ? dynamic
            : readDecision;
        continue;
      }
      const check = decisionForPath(request, target, false);
      readDecision =
        readDecision === null ||
        SEVERITY[check.decision] > SEVERITY[readDecision.decision]
          ? check
          : readDecision;
    }
    if (readDecision !== null && readDecision.decision !== "allow") {
      return {
        decision: readDecision.decision,
        reason: readDecision.reason,
        rule: {
          id: `shell.read.${readDecision.decision}`,
          tool: request.tool,
          decision: readDecision.decision,
          command,
        },
        pathTarget: readDecision.target,
        approvalClass: readDecision.approvalClass,
      };
    }
    return {
      decision: "allow",
      reason: "read-only shell command is allowed",
      rule: {
        id: `shell.read.${firstWord}`,
        tool: request.tool,
        decision: "allow",
        command,
      },
      pathTarget,
      approvalClass: "routine",
    };
  }
  const network = isNetworkShellCommand(scan.commandWords);
  if (isShellLauncher(scan.commandWords)) {
    return {
      decision: "ask",
      reason:
        "shell launcher or interpreter requires approval; auto mode does not pre-approve dynamic execution",
      rule: null,
      pathTarget,
      approvalClass: "dynamic",
    };
  }
  return {
    decision: "ask",
    reason: scan.destructive
      ? "shell command is not in a known safe class"
      : network
        ? "network or package-index command requires approval; auto mode does not pre-approve it"
        : "shell command is not in a known safe class",
    rule: null,
    pathTarget,
    approvalClass: scan.destructive
      ? "destructive"
      : network
        ? "network"
        : "shell",
  };
}

function toolDecision(request: PolicyRequest): {
  decision: Decision;
  reason: string;
  rule: PolicyRule | null;
  pathTarget: string | null;
  approvalClass: ApprovalClass;
} {
  if (request.tool === "bash" || request.tool === "user_bash") {
    return shellDecision(request);
  }
  if (request.tool === "exec") {
    if (request.mode !== "headless") {
      return {
        decision: "deny",
        reason: "argv exec is only available in headless mode",
        rule: null,
        pathTarget: null,
        approvalClass: "unknown",
      };
    }
    if (!request.argv || request.argv.length === 0) {
      return {
        decision: "deny",
        reason: "argv is required for headless exec",
        rule: null,
        pathTarget: null,
        approvalClass: "unknown",
      };
    }
    const exact = findExactExecRule(request);
    if (exact !== null) {
      return {
        decision: "allow",
        reason: "exact headless argv rule is approved",
        rule: exact,
        pathTarget: null,
        approvalClass: "routine",
      };
    }
    return {
      decision: "ask",
      reason: "headless argv requires an exact approved rule",
      rule: null,
      pathTarget: null,
      approvalClass: "exec",
    };
  }
  if (request.tool === "read" || request.tool === "search") {
    const candidate =
      typeof request.args?.["path"] === "string"
        ? request.args["path"]
        : request.tool === "search"
          ? request.cwd
          : undefined;
    const check = decisionForPath(request, candidate, false);
    return {
      decision: check.decision,
      reason: check.reason,
      rule: {
        id: `path.read.${check.decision}`,
        tool: request.tool,
        decision: check.decision,
      },
      pathTarget: check.target,
      approvalClass: check.approvalClass,
    };
  }
  if (request.tool === "write" || request.tool === "edit") {
    if (request.autonomy === "read-only") {
      return {
        decision: "deny",
        reason: "read-only autonomy denies file mutation",
        rule: {
          id: "autonomy.read_only.write",
          tool: request.tool,
          decision: "deny",
        },
        pathTarget: null,
        approvalClass: "protected",
      };
    }
    const candidate =
      typeof request.args?.["path"] === "string"
        ? request.args["path"]
        : undefined;
    const check = decisionForPath(request, candidate, true);
    return {
      decision: check.decision,
      reason: check.reason,
      rule: {
        id: `path.write.${check.decision}`,
        tool: request.tool,
        decision: check.decision,
      },
      pathTarget: check.target,
      approvalClass: check.approvalClass,
    };
  }
  if (request.tool === "web_fetch" || request.tool === "web_search") {
    return {
      decision: "allow",
      reason:
        "public web reads are allowed; the tool still enforces private-host and deny-list guards",
      rule: {
        id:
          request.tool === "web_search"
            ? "web.search.allow"
            : "web.fetch.allow",
        tool: request.tool,
        decision: "allow",
      },
      pathTarget: null,
      approvalClass: "routine",
    };
  }
  if (request.tool === "ask_user") {
    if (request.mode === "worker" || request.mode === "headless") {
      return {
        decision: "deny",
        reason: "non-interactive sessions cannot prompt the user",
        rule: null,
        pathTarget: null,
        approvalClass: "unknown",
      };
    }
    return {
      decision: "allow",
      reason: "interactive user clarification is allowed",
      rule: {
        id: "ask_user.allow",
        tool: request.tool,
        decision: "allow",
      },
      pathTarget: null,
      approvalClass: "routine",
    };
  }
  if (request.tool === "subagent") {
    if (request.mode === "worker") {
      return {
        decision: "deny",
        reason: "depth-1 workers cannot spawn nested subagents",
        rule: null,
        pathTarget: null,
        approvalClass: "unknown",
      };
    }
    return {
      decision: "allow",
      reason: "read-only subagent delegation is allowed",
      rule: {
        id: "subagent.read_only.allow",
        tool: request.tool,
        decision: "allow",
      },
      pathTarget: null,
      approvalClass: "routine",
    };
  }
  if (request.tool === "memory_search") {
    if (request.mode === "worker") {
      return {
        decision: "deny",
        reason: "workers cannot query memory",
        rule: null,
        pathTarget: null,
        approvalClass: "unknown",
      };
    }
    return {
      decision: "allow",
      reason: "memory search is allowed",
      rule: {
        id: "memory.search.allow",
        tool: request.tool,
        decision: "allow",
      },
      pathTarget: null,
      approvalClass: "routine",
    };
  }
  if (request.tool === "plan" || request.tool === "todo") {
    return {
      decision: "allow",
      reason: "session work state is product-owned",
      rule: {
        id: "work.state.allow",
        tool: request.tool,
        decision: "allow",
      },
      pathTarget: null,
      approvalClass: "routine",
    };
  }
  if (request.tool.startsWith("mcp__")) {
    return {
      decision: "ask",
      reason: "MCP tool calls are uncovered by the sandbox and need approval",
      rule: {
        id: "mcp.tool.ask",
        tool: request.tool,
        decision: "ask",
      },
      pathTarget: null,
      approvalClass: "mcp",
    };
  }
  if (MCP_RESOURCE_TOOL_NAMES.has(request.tool)) {
    return {
      decision: "ask",
      reason:
        "MCP resource operations are uncovered by the sandbox and need approval",
      rule: {
        id: "mcp.resource.ask",
        tool: request.tool,
        decision: "ask",
      },
      pathTarget: null,
      approvalClass: "mcp",
    };
  }
  return {
    decision: "deny",
    reason: "unknown tool",
    rule: null,
    pathTarget: null,
    approvalClass: "unknown",
  };
}

export function decidePolicy(request: PolicyRequest): PolicyDecision {
  const user = evaluateRules(request.userRules ?? [], request);
  const project = evaluateRules(request.projectRules ?? [], request);
  const toolResult = toolDecision(request);
  let decision = toolResult.decision;
  let approvalClass = toolResult.approvalClass;
  let selectedRule = toolResult.rule;
  let reason = toolResult.reason;
  for (const layer of [
    {
      source: "user" as const,
      candidate: user.decision ?? request.userDefault,
      rule: user.rule,
    },
    {
      source: "project" as const,
      candidate: project.decision ?? request.projectDefault,
      rule: project.rule,
    },
  ]) {
    if (
      layer.candidate !== undefined &&
      SEVERITY[layer.candidate] > SEVERITY[decision]
    ) {
      decision = layer.candidate;
      selectedRule = layer.rule;
      reason =
        layer.rule === null
          ? `${layer.source} default policy`
          : `policy rule ${layer.rule.id}`;
      if (decision === "ask") {
        // An explicit ask rule is an instruction to stop for a person. Auto
        // mode may approve ordinary routine/shell work, but it must not erase
        // the rule author's request for review.
        approvalClass = "policy";
      }
    }
  }
  if (
    (request.autonomy ?? "ask") === "read-only" &&
    decision === "ask" &&
    request.tool !== "read" &&
    request.tool !== "search" &&
    request.tool !== "memory_search"
  ) {
    decision = "deny";
  }
  if (
    (request.mode ?? DEFAULT_POLICY_MODE) !== "interactive" &&
    decision === "ask" &&
    request.tool !== "read" &&
    request.tool !== "search" &&
    request.autonomy !== "scoped"
  ) {
    // Print and worker sessions have no approval channel. The configured
    // approval mode still decides which classes were pre-approved: `auto`
    // covers routine/shell, `allow` covers everything, `ask`/`deny` cannot
    // be resolved without a reviewer and therefore refuse. Scoped autonomy is
    // the exception: the gate must see the ask first so an exact argv rule can
    // allow it; an unmatched rule still fails closed in the gate.
    const approval = effectiveApprovalDecision(
      "ask",
      request.approvalMode ?? "ask",
      approvalClass,
    );
    if (
      approval.decision !== "allow" &&
      !(request.reviewerAvailable === true && request.approvalMode === "auto")
    ) {
      decision = "deny";
    }
  }
  if (
    (request.autonomy ?? "ask") === "read-only" &&
    toolResult.decision === "ask" &&
    decision === "deny"
  ) {
    reason = "read-only autonomy denies actions that require approval";
    selectedRule = {
      id: "autonomy.read_only.ask",
      tool: request.tool,
      decision: "deny",
      ...(request.command !== undefined ? { command: request.command } : {}),
    };
    approvalClass = "protected";
  } else if (
    (request.mode ?? DEFAULT_POLICY_MODE) !== "interactive" &&
    toolResult.decision === "ask" &&
    decision === "deny"
  ) {
    selectedRule = {
      id: "mode.non_interactive.ask",
      tool: request.tool,
      decision: "deny",
      ...(request.command !== undefined ? { command: request.command } : {}),
    };
    approvalClass = "protected";
  }
  return {
    version: 1,
    decision,
    approval_class: approvalClass,
    rule: selectedRule?.id ?? "policy.default",
    rule_sha256: ruleHash(selectedRule, "policy-default"),
    ...(selectedRule?.justification === undefined
      ? {}
      : { justification: selectedRule.justification }),
    reason,
    layers: layersFor(request, user.rule, project.rule),
    match: {
      tool: request.tool,
      ...(toolResult.pathTarget !== null
        ? { path: toolResult.pathTarget }
        : {}),
      ...(request.command !== undefined ? { command: request.command } : {}),
      ...(request.argv !== undefined ? { argv: [...request.argv] } : {}),
    },
    requires_approval: decision === "ask",
  };
}

export function policyRuleHash(rule: PolicyRule): string {
  return recordHash(rule);
}
