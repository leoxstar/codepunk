import { promises as fs } from "node:fs";
import path from "node:path";
import {
  policyRequestForCall,
  ruleMatches,
  type PolicyLayerInput,
  type PolicyRequest,
  type PolicyRule,
  type PolicyRuleFixture,
} from "../policy/match.ts";
import { sha256Text } from "../platform/hash.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import { isInsidePath, normalizeAbsolute } from "../platform/path.ts";
import { isShellLauncher } from "../platform/shell.ts";
import {
  assertProjectConfigFileSafe,
  assertProjectConfigSafe,
} from "../platform/paths.ts";
import { ConfigError } from "./index.ts";
import { parseToml, TomlError, type TomlTable } from "./toml.ts";

export interface PolicyFiles {
  writeSet: string[];
  userRules: PolicyRule[];
  projectRules: PolicyRule[];
  layers: PolicyLayerInput[];
  userPath: string;
  projectPath: string;
  warnings: string[];
}

export interface HeadlessCommandRule {
  argv: string[];
  executable_sha256: string;
  script_sha256: string | null;
  cwd: string;
}

export interface HeadlessPolicy {
  version: 1;
  path: string;
  sha256: string;
  tools: string[];
  write: string[];
  commands: HeadlessCommandRule[];
  rules: PolicyRule[];
}

const POLICY_KEYS = new Set(["version", "write_set", "rules"]);
const LEGACY_RULE_KEYS = new Set([
  "id",
  "tool",
  "decision",
  "path",
  "command",
  "argv",
]);
const V2_RULE_KEYS = new Set([
  ...LEGACY_RULE_KEYS,
  "justification",
  "match",
  "not_match",
]);
const FIXTURE_KEYS = new Set(["tool", "path", "command", "argv", "cwd"]);
const MIGRATE_HINT =
  "policy.migrate_hint: set version = 2 and add a non-empty justification, " +
  "at least one match and not_match fixture, and absolute shell commands";

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new ConfigError(
      `cannot read ${filePath}: ${(error as Error).message}`,
    );
  }
}

function parsePolicyFile(
  content: string,
  source: "user" | "project",
  fixtureRoot: string,
): { writeSet: string[]; rules: PolicyRule[]; warnings: string[] } {
  let parsed: TomlTable;
  try {
    parsed = parseToml(content);
  } catch (error) {
    if (error instanceof TomlError) {
      throw new ConfigError(`${source} policy: ${error.message}`);
    }
    throw error;
  }
  for (const key of Object.keys(parsed)) {
    if (!POLICY_KEYS.has(key)) {
      throw new ConfigError(`unknown ${source} policy key: ${key}`, key);
    }
  }
  const version = parsed["version"];
  if (version !== 1 && version !== 2) {
    throw new ConfigError(
      `${source} policy version must be 1 or 2; ${MIGRATE_HINT}`,
      "version",
    );
  }
  const warnings: string[] = [];
  if (version === 1) {
    warnings.push(
      `${source} policy uses legacy version 1 without rule self-check; ${MIGRATE_HINT}`,
    );
  }
  const writeSet = parsed["write_set"] ?? [];
  if (
    !Array.isArray(writeSet) ||
    writeSet.some((entry) => typeof entry !== "string")
  ) {
    throw new ConfigError(
      `${source} policy write_set must be an array of strings`,
      "write_set",
    );
  }
  const rulesValue = parsed["rules"] ?? {};
  if (
    rulesValue === null ||
    typeof rulesValue !== "object" ||
    Array.isArray(rulesValue)
  ) {
    throw new ConfigError(`${source} policy rules must be tables`, "rules");
  }
  const rules: PolicyRule[] = [];
  for (const [id, ruleValue] of Object.entries(rulesValue)) {
    if (
      ruleValue === null ||
      typeof ruleValue !== "object" ||
      Array.isArray(ruleValue)
    ) {
      throw new ConfigError(`${source} policy rule ${id} must be a table`);
    }
    const allowedKeys = version === 1 ? LEGACY_RULE_KEYS : V2_RULE_KEYS;
    for (const key of Object.keys(ruleValue)) {
      if (!allowedKeys.has(key)) {
        throw new ConfigError(
          `unknown ${source} policy rule key: ${key}`,
          `rules.${id}.${key}`,
        );
      }
    }
    const tool = ruleValue["tool"];
    const decision = ruleValue["decision"];
    if (typeof tool !== "string" || tool.length === 0) {
      throw new ConfigError(`${source} policy rule ${id} needs a tool`);
    }
    if (decision !== "allow" && decision !== "ask" && decision !== "deny") {
      throw new ConfigError(
        `${source} policy rule ${id} needs a valid decision`,
      );
    }
    if (source === "project" && decision === "allow") {
      throw new ConfigError(
        "project policy rules cannot grant allow; user is the floor",
      );
    }
    const rule: PolicyRule = {
      id,
      tool,
      decision,
    };
    const rulePath = ruleValue["path"];
    const command = ruleValue["command"];
    const argv = ruleValue["argv"];
    if (rulePath !== undefined) {
      if (typeof rulePath !== "string") {
        throw new ConfigError(
          `${source} policy rule ${id} path must be a string`,
        );
      }
      rule.path = rulePath;
    }
    if (command !== undefined) {
      if (typeof command !== "string") {
        throw new ConfigError(
          `${source} policy rule ${id} command must be a string`,
        );
      }
      rule.command = command;
    }
    if (argv !== undefined) {
      if (
        !Array.isArray(argv) ||
        argv.some((entry) => typeof entry !== "string")
      ) {
        throw new ConfigError(
          `${source} policy rule ${id} argv must be a string array`,
        );
      }
      rule.argv = argv as string[];
    }
    if (version === 2) {
      parseV2Rule(rule, ruleValue, source, fixtureRoot);
    }
    rules.push(rule);
  }
  return { writeSet: writeSet as string[], rules, warnings };
}

function parseV2Rule(
  rule: PolicyRule,
  ruleValue: TomlTable,
  source: "user" | "project",
  fixtureRoot: string,
): void {
  const justification = ruleValue["justification"];
  if (typeof justification !== "string" || justification.trim().length === 0) {
    throw new ConfigError(
      `${source} policy rule ${rule.id} needs a non-empty justification; ${MIGRATE_HINT}`,
      `rules.${rule.id}.justification`,
    );
  }
  rule.justification = justification;

  rule.match = parseFixtures(rule, ruleValue["match"], "match", source);
  rule.not_match = parseFixtures(
    rule,
    ruleValue["not_match"],
    "not_match",
    source,
  );

  if (rule.tool === "exec" && rule.argv === undefined) {
    // The accepted version 2 example states the exact argv in its match
    // fixture instead of repeating it on the rule. Use that one shape only
    // when every positive example agrees, so the rule still matches exactly
    // one argv rather than a prefix.
    const derived = fixtureArgv(rule.match);
    if (derived === null) {
      throw new ConfigError(
        `${source} policy rule ${rule.id} exec rule needs an exact argv shared by every match fixture; ${MIGRATE_HINT}`,
        `rules.${rule.id}.argv`,
      );
    }
    rule.argv = derived;
  }
  if (rule.tool === "bash" && rule.argv !== undefined) {
    throw new ConfigError(
      `${source} policy rule ${rule.id} bash rules carry a command and no argv; ${MIGRATE_HINT}`,
      `rules.${rule.id}.argv`,
    );
  }
  if (rule.argv !== undefined && rule.tool !== "exec") {
    throw new ConfigError(
      `${source} policy rule ${rule.id} argv is only valid for exec rules; ${MIGRATE_HINT}`,
      `rules.${rule.id}.argv`,
    );
  }
  if (rule.argv !== undefined && isShellLauncher(rule.argv)) {
    throw new ConfigError(
      `${source} policy rule ${rule.id} argv starts a shell or interpreter; ${MIGRATE_HINT}`,
      `rules.${rule.id}.argv`,
    );
  }
  if (rule.tool === "exec") {
    if (rule.argv === undefined || rule.argv.length === 0) {
      throw new ConfigError(
        `${source} policy rule ${rule.id} exec rule needs an exact argv; ${MIGRATE_HINT}`,
        `rules.${rule.id}.argv`,
      );
    }
    if (rule.command === undefined) {
      const executable = rule.argv[0];
      if (executable === undefined) {
        throw new ConfigError(
          `${source} policy rule ${rule.id} exec rule needs an executable; ${MIGRATE_HINT}`,
          `rules.${rule.id}.argv`,
        );
      }
      rule.command = executable;
    } else if (rule.command !== rule.argv[0]) {
      throw new ConfigError(
        `${source} policy rule ${rule.id} exec command must equal argv[0]; ${MIGRATE_HINT}`,
        `rules.${rule.id}.command`,
      );
    }
    if (!path.isAbsolute(rule.command) || isShellLauncher([rule.command])) {
      throw new ConfigError(
        `${source} policy rule ${rule.id} exec command must be an absolute non-launcher executable path; ${MIGRATE_HINT}`,
        `rules.${rule.id}.command`,
      );
    }
  } else if (rule.command !== undefined && rule.tool !== "bash") {
    if (
      rule.command.length === 0 ||
      !path.isAbsolute(rule.command) ||
      isShellLauncher([rule.command])
    ) {
      throw new ConfigError(
        `${source} policy rule ${rule.id} command must be an absolute non-launcher executable path; ${MIGRATE_HINT}`,
        `rules.${rule.id}.command`,
      );
    }
  }

  checkFixtures(rule, rule.match, "match", source, fixtureRoot);
  checkFixtures(rule, rule.not_match, "not_match", source, fixtureRoot);
}

function parseFixtures(
  rule: PolicyRule,
  value: unknown,
  kind: "match" | "not_match",
  source: "user" | "project",
): PolicyRuleFixture[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(
      `${source} policy rule ${rule.id} needs at least one ${kind} fixture; ${MIGRATE_HINT}`,
      `rules.${rule.id}.${kind}`,
    );
  }
  return value.map((entry, index) =>
    parseFixture(entry, rule, kind, index, source),
  );
}

function fixtureArgv(fixtures: readonly PolicyRuleFixture[]): string[] | null {
  const first = fixtures[0]?.argv;
  if (first === undefined || first.length === 0) {
    return null;
  }
  for (const fixture of fixtures) {
    if (
      fixture.argv === undefined ||
      fixture.argv.length !== first.length ||
      fixture.argv.some((value, index) => value !== first[index])
    ) {
      return null;
    }
  }
  return [...first];
}

function checkFixtures(
  rule: PolicyRule,
  fixtures: readonly PolicyRuleFixture[],
  kind: "match" | "not_match",
  source: "user" | "project",
  fixtureRoot: string,
): void {
  const expected = kind === "match";
  fixtures.forEach((fixture, index) => {
    const actual = ruleMatches(rule, fixtureRequest(fixture, fixtureRoot));
    if (actual !== expected) {
      throw new ConfigError(
        `${source} policy rule ${rule.id} ${kind}[${index}] expected ${expected} but got ${actual}; ${MIGRATE_HINT}`,
        `rules.${rule.id}.${kind}[${index}]`,
      );
    }
  });
}

function parseFixture(
  value: unknown,
  rule: PolicyRule,
  kind: "match" | "not_match",
  index: number,
  source: "user" | "project",
): PolicyRuleFixture {
  const key = `rules.${rule.id}.${kind}[${index}]`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(
      `${source} policy rule ${rule.id} ${kind}[${index}] must be a table; ${MIGRATE_HINT}`,
      key,
    );
  }
  const table = value as TomlTable;
  for (const fixtureKey of Object.keys(table)) {
    if (!FIXTURE_KEYS.has(fixtureKey)) {
      throw new ConfigError(
        `${source} policy rule ${rule.id} ${kind}[${index}] has unknown key ${fixtureKey}; ${MIGRATE_HINT}`,
        `${key}.${fixtureKey}`,
      );
    }
  }
  const tool = table["tool"];
  if (typeof tool !== "string" || tool.length === 0) {
    throw new ConfigError(
      `${source} policy rule ${rule.id} ${kind}[${index}] needs a tool; ${MIGRATE_HINT}`,
      `${key}.tool`,
    );
  }
  const fixture: PolicyRuleFixture = { tool };
  for (const field of ["path", "command", "cwd"] as const) {
    const fieldValue = table[field];
    if (fieldValue !== undefined) {
      if (typeof fieldValue !== "string") {
        throw new ConfigError(
          `${source} policy rule ${rule.id} ${kind}[${index}] ${field} must be a string; ${MIGRATE_HINT}`,
          `${key}.${field}`,
        );
      }
      fixture[field] = fieldValue;
    }
  }
  const argv = table["argv"];
  if (argv !== undefined) {
    if (
      !Array.isArray(argv) ||
      argv.some((entry) => typeof entry !== "string")
    ) {
      throw new ConfigError(
        `${source} policy rule ${rule.id} ${kind}[${index}] argv must be a string array; ${MIGRATE_HINT}`,
        `${key}.argv`,
      );
    }
    fixture.argv = argv as string[];
  }
  if (fixture.tool === "bash") {
    if (fixture.argv !== undefined) {
      throw new ConfigError(
        `${source} policy rule ${rule.id} ${kind}[${index}] bash fixtures carry a command and no argv; ${MIGRATE_HINT}`,
        `${key}.argv`,
      );
    }
    if (fixture.command === undefined || fixture.command.length === 0) {
      throw new ConfigError(
        `${source} policy rule ${rule.id} ${kind}[${index}] bash fixture needs a command; ${MIGRATE_HINT}`,
        `${key}.command`,
      );
    }
  }
  if (fixture.tool === "exec") {
    if (fixture.argv === undefined || fixture.argv.length === 0) {
      throw new ConfigError(
        `${source} policy rule ${rule.id} ${kind}[${index}] exec fixture needs argv; ${MIGRATE_HINT}`,
        `${key}.argv`,
      );
    }
    if (fixture.command !== undefined && fixture.command !== fixture.argv[0]) {
      throw new ConfigError(
        `${source} policy rule ${rule.id} ${kind}[${index}] exec command must equal argv[0]; ${MIGRATE_HINT}`,
        `${key}.command`,
      );
    }
    const executable = fixture.argv[0];
    if (
      executable === undefined ||
      !path.isAbsolute(executable) ||
      isShellLauncher([executable])
    ) {
      throw new ConfigError(
        `${source} policy rule ${rule.id} ${kind}[${index}] exec argv[0] must be an absolute non-launcher executable path; ${MIGRATE_HINT}`,
        `${key}.argv`,
      );
    }
  } else if (fixture.argv !== undefined) {
    throw new ConfigError(
      `${source} policy rule ${rule.id} ${kind}[${index}] argv is only valid for exec fixtures; ${MIGRATE_HINT}`,
      `${key}.argv`,
    );
  }
  return fixture;
}

function fixtureRequest(
  fixture: PolicyRuleFixture,
  fixtureRoot: string,
): PolicyRequest {
  const cwd = normalizeAbsolute(path.resolve(fixtureRoot, fixture.cwd ?? "."));
  const args: Record<string, unknown> = {};
  if (fixture.path !== undefined) {
    args["path"] = fixture.path;
  }
  if (fixture.command !== undefined) {
    args["command"] = fixture.command;
  }
  if (fixture.argv !== undefined) {
    args["argv"] = [...fixture.argv];
  }
  return policyRequestForCall({
    tool: fixture.tool,
    args,
    cwd,
    workspaceRoot: normalizeAbsolute(fixtureRoot),
    deliveryRoot: normalizeAbsolute(fixtureRoot),
    mode: "interactive",
  });
}

export async function loadPolicyFiles(
  paths: ProjectPaths,
  options: { projectTrusted?: boolean } = {},
): Promise<PolicyFiles> {
  const userPath = path.join(paths.home, "policy.toml");
  const projectPath = path.join(paths.projectConfigDir, "policy.toml");
  const warnings: string[] = [];
  const userContent = await readOptional(userPath);
  const projectSafety =
    options.projectTrusted === false
      ? "project policy resource is not trusted"
      : await assertProjectConfigSafe(paths);
  if (projectSafety !== null) {
    warnings.push(`project policy ignored: ${projectSafety}`);
  }
  let projectContent: string | null = null;
  if (projectSafety === null) {
    const projectFileSafety = await assertProjectConfigFileSafe(projectPath);
    if (projectFileSafety !== null) {
      warnings.push(`project policy ignored: ${projectFileSafety}`);
    } else {
      projectContent = await readOptional(projectPath);
    }
  }
  const user =
    userContent === null
      ? null
      : parsePolicyFile(userContent, "user", paths.cwd);
  const project =
    projectContent === null
      ? null
      : parsePolicyFile(projectContent, "project", paths.cwd);
  for (const warning of user?.warnings ?? []) {
    warnings.push(`${userPath}: ${warning}`);
  }
  for (const warning of project?.warnings ?? []) {
    warnings.push(`${projectPath}: ${warning}`);
  }
  const userWriteSet = user?.writeSet ?? [];
  const projectWriteSet = project?.writeSet ?? [];
  if (
    user !== null &&
    project !== null &&
    userWriteSet.length > 0 &&
    !writeSetCoveredBy(projectWriteSet, userWriteSet, paths.cwd)
  ) {
    throw new ConfigError(
      "project policy write_set cannot widen the user write set",
      "write_set",
    );
  }
  const writeSet = projectWriteSet.length > 0 ? projectWriteSet : userWriteSet;
  const layers: PolicyLayerInput[] = [];
  if (userContent !== null) {
    layers.push({
      layer: "user",
      source: userPath,
      sha256: sha256Text(userContent),
      rules: user?.rules ?? [],
    });
  }
  if (projectContent !== null) {
    layers.push({
      layer: "project",
      source: projectPath,
      sha256: sha256Text(projectContent),
      rules: project?.rules ?? [],
    });
  }
  return {
    writeSet,
    userRules: user?.rules ?? [],
    projectRules: project?.rules ?? [],
    layers,
    userPath,
    projectPath,
    warnings,
  };
}

function writeSetCoveredBy(
  candidate: readonly string[],
  floor: readonly string[],
  cwd: string,
): boolean {
  const floorPaths = floor.map((entry) =>
    normalizeAbsolute(
      path.isAbsolute(entry) ? entry : path.resolve(cwd, entry),
    ),
  );
  return candidate.every((entry) => {
    const target = normalizeAbsolute(
      path.isAbsolute(entry) ? entry : path.resolve(cwd, entry),
    );
    return floorPaths.some((floorPath) => isInsidePath(floorPath, target));
  });
}

function stringArray(value: unknown, key: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new ConfigError(`headless policy ${key} must be a string array`, key);
  }
  return value as string[];
}

export async function loadHeadlessPolicy(
  filePath: string,
  paths: ProjectPaths,
): Promise<HeadlessPolicy> {
  const absolutePath = normalizeAbsolute(filePath);
  if (isInsidePath(paths.deliveryRoot, absolutePath)) {
    throw new ConfigError(
      "headless policy must be outside the repository",
      "headless-policy",
    );
  }
  const content = await readOptional(absolutePath);
  if (content === null) {
    throw new ConfigError(
      "headless policy file does not exist",
      "headless-policy",
    );
  }
  let parsed: TomlTable;
  try {
    parsed = parseToml(content);
  } catch (error) {
    if (error instanceof TomlError) {
      throw new ConfigError(`headless policy: ${error.message}`);
    }
    throw error;
  }
  if (parsed["version"] !== 1) {
    throw new ConfigError("headless policy version must be 1");
  }
  const allow = parsed["allow"];
  if (allow === null || typeof allow !== "object" || Array.isArray(allow)) {
    throw new ConfigError("headless policy must contain [allow]");
  }
  const tools = stringArray(allow["tools"] ?? [], "allow.tools");
  for (const tool of tools) {
    if (
      !["read", "write", "edit", "search", "exec", "memory_search"].includes(
        tool,
      )
    ) {
      throw new ConfigError(`headless policy tool ${tool} is not supported`);
    }
  }
  const write = stringArray(allow["write"] ?? [], "allow.write").map((entry) =>
    normalizeAbsolute(path.resolve(paths.cwd, entry)),
  );
  for (const entry of write) {
    if (!isInsidePath(paths.deliveryRoot, entry)) {
      throw new ConfigError("headless write path escapes the delivery root");
    }
  }
  const commandValues = allow["commands"] ?? [];
  if (!Array.isArray(commandValues)) {
    throw new ConfigError("headless policy allow.commands must be an array");
  }
  const commands: HeadlessCommandRule[] = [];
  for (const value of commandValues) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ConfigError("headless command rule must be a table");
    }
    const argv = stringArray(value["argv"], "allow.commands.argv");
    const executableSha = value["executable_sha256"];
    if (
      typeof executableSha !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(executableSha)
    ) {
      throw new ConfigError(
        "headless command executable_sha256 must be sha256:<64 hex>",
      );
    }
    const scriptSha = value["script_sha256"];
    if (
      scriptSha !== undefined &&
      (typeof scriptSha !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(scriptSha))
    ) {
      throw new ConfigError(
        "headless command script_sha256 must be sha256:<64 hex>",
      );
    }
    const cwdValue = value["cwd"] ?? ".";
    if (typeof cwdValue !== "string") {
      throw new ConfigError("headless command cwd must be a string");
    }
    const cwd = normalizeAbsolute(path.resolve(paths.cwd, cwdValue));
    if (!isInsidePath(paths.deliveryRoot, cwd)) {
      throw new ConfigError("headless command cwd escapes the delivery root");
    }
    commands.push({
      argv,
      executable_sha256: executableSha,
      script_sha256: typeof scriptSha === "string" ? scriptSha : null,
      cwd,
    });
  }
  const rules: PolicyRule[] = [];
  if (tools.includes("read")) {
    rules.push({
      id: "headless.read",
      tool: "read",
      decision: "allow",
      path: paths.deliveryRoot,
    });
  }
  if (tools.includes("search")) {
    rules.push({
      id: "headless.search",
      tool: "search",
      decision: "allow",
      path: paths.deliveryRoot,
    });
  }
  if (tools.includes("memory_search")) {
    rules.push({
      id: "headless.memory_search",
      tool: "memory_search",
      decision: "allow",
    });
  }
  if (tools.includes("write") || tools.includes("edit")) {
    for (const entry of write) {
      if (tools.includes("write")) {
        rules.push({
          id: `headless.write.${path.basename(entry)}`,
          tool: "write",
          decision: "allow",
          path: entry,
        });
      }
      rules.push({
        id: `headless.edit.${path.basename(entry)}`,
        tool: "edit",
        decision: "allow",
        path: entry,
      });
    }
  }
  for (const [index, command] of commands.entries()) {
    rules.push({
      id: `headless.exec.${index + 1}`,
      tool: "exec",
      decision: "allow",
      argv: command.argv,
    });
  }
  return {
    version: 1,
    path: absolutePath,
    sha256: sha256Text(content),
    tools,
    write,
    commands,
    rules,
  };
}

export function headlessLayer(policy: HeadlessPolicy): PolicyLayerInput {
  return {
    layer: "headless",
    source: policy.path,
    sha256: policy.sha256,
    rules: policy.rules,
  };
}
