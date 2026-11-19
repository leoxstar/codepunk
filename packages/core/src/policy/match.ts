import path from "node:path";
import type { AutonomyProfile, Decision, PolicyLayer } from "codepunk-protocol";
import type { ApprovalMode, FilesystemMode } from "../config/index.ts";
import { isInsidePath, normalizeAbsolute } from "../platform/path.ts";

/**
 * One request example carried by a version 2 policy rule. The fields mirror
 * the runtime request shape: `bash` has a raw command and no argv, while
 * `exec` derives its command from argv[0].
 */
export interface PolicyRuleFixture {
  tool: string;
  path?: string;
  command?: string;
  argv?: readonly string[];
  cwd?: string;
}

export interface PolicyRule {
  id: string;
  tool: string;
  decision: Decision;
  path?: string;
  command?: string;
  argv?: readonly string[];
  justification?: string;
  match?: readonly PolicyRuleFixture[];
  not_match?: readonly PolicyRuleFixture[];
}

export interface PolicyLayerInput {
  layer: PolicyLayer["layer"];
  source: string;
  sha256: string;
  rules: readonly PolicyRule[];
}

export interface PolicyRequest {
  tool: string;
  args?: Record<string, unknown>;
  command?: string;
  argv?: readonly string[];
  cwd: string;
  workspaceRoot: string;
  /**
   * Explicit extra file roots from `--add-dir`. They extend path containment
   * only; project config, policy, skills, MCP servers, and instructions are
   * never discovered from these roots.
   */
  additionalRoots?: readonly string[];
  deliveryRoot?: string;
  codepunkHome?: string;
  mode?: "interactive" | "headless" | "worker";
  autonomy?: AutonomyProfile;
  approvalMode?: ApprovalMode;
  /** Headless policy may defer an unresolved ask to an enabled model reviewer. */
  reviewerAvailable?: boolean;
  filesystem?: FilesystemMode;
  writeSet?: readonly string[];
  /**
   * Exact skill files discovered and validated by the product. They remain
   * readable even though their user/project roots are otherwise protected.
   * This is an exact-file exception, not a directory-wide home exemption.
   */
  readableSkillFiles?: readonly string[];
  userRules?: readonly PolicyRule[];
  projectRules?: readonly PolicyRule[];
  layers?: readonly PolicyLayerInput[];
  userDefault?: Decision;
  projectDefault?: Decision;
}

/**
 * Derive the shell fields the runtime and policy fixtures both use. `bash`
 * carries one raw command string; `exec` carries an exact argv and derives
 * its command from argv[0]. Other tools have neither field.
 */
export function shellRequestFields(
  tool: string,
  args: Record<string, unknown> | undefined,
): { command?: string; argv?: readonly string[] } {
  if (tool === "exec") {
    const candidate = args?.["argv"];
    if (
      !Array.isArray(candidate) ||
      candidate.length === 0 ||
      candidate.some((value) => typeof value !== "string" || value.length === 0)
    ) {
      return {};
    }
    return { command: candidate[0] as string, argv: [...candidate] };
  }
  if (tool === "bash") {
    const command = args?.["command"];
    return typeof command === "string" ? { command } : {};
  }
  return {};
}

/**
 * Build the exact request policy rules see from a tool call. Runtime wrappers
 * and `version = 2` fixture self-checks must call this function so a fixture
 * cannot describe a shape the product never produces.
 */
export function policyRequestForCall(
  input: Omit<PolicyRequest, "tool" | "args" | "command" | "argv"> & {
    tool: string;
    args?: Record<string, unknown>;
    /** Raw `!` command input, which is not a tool argument. */
    rawCommand?: string;
  },
): PolicyRequest {
  const { tool, args, rawCommand, ...rest } = input;
  const fields =
    rawCommand === undefined
      ? shellRequestFields(tool, args)
      : { command: rawCommand };
  return {
    ...rest,
    tool,
    ...(args === undefined ? {} : { args }),
    ...(fields.command === undefined ? {} : { command: fields.command }),
    ...(fields.argv === undefined ? {} : { argv: fields.argv }),
  };
}

function resolveRulePath(rulePath: string, cwd: string): string {
  return path.isAbsolute(rulePath) ? rulePath : path.resolve(cwd, rulePath);
}

/**
 * Pure rule matcher shared by runtime policy evaluation and load-time
 * self-checks. Keeping one function is the point of version 2: a rule's
 * examples prove exactly the behavior the runtime will use.
 */
export function ruleMatches(rule: PolicyRule, request: PolicyRequest): boolean {
  if (rule.tool !== "*" && rule.tool !== request.tool) {
    return false;
  }
  if (rule.command !== undefined && rule.command !== request.command) {
    return false;
  }
  if (rule.argv !== undefined) {
    if (
      request.argv === undefined ||
      rule.argv.length !== request.argv.length ||
      rule.argv.some((value, index) => value !== request.argv?.[index])
    ) {
      return false;
    }
  }
  if (rule.path !== undefined) {
    const candidate = request.args?.["path"];
    if (typeof candidate !== "string") {
      return false;
    }
    const expected = resolveRulePath(rule.path, request.cwd);
    const actual = normalizeAbsolute(
      path.isAbsolute(candidate)
        ? candidate
        : path.resolve(request.cwd, candidate),
    );
    if (!isInsidePath(expected, actual)) {
      return false;
    }
  }
  return true;
}
