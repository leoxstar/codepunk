import { promises as fs } from "node:fs";
import path from "node:path";
import type { PolicyLayerInput, PolicyRule } from "../policy/index.ts";
import { sha256Text } from "../platform/hash.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import { isInsidePath, normalizeAbsolute } from "../platform/path.ts";
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
const RULE_KEYS = new Set([
  "id",
  "tool",
  "decision",
  "path",
  "command",
  "argv",
]);

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
): { writeSet: string[]; rules: PolicyRule[] } {
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
  if (parsed["version"] !== 1) {
    throw new ConfigError(`${source} policy version must be 1`, "version");
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
    for (const key of Object.keys(ruleValue)) {
      if (!RULE_KEYS.has(key)) {
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
    rules.push(rule);
  }
  return { writeSet: writeSet as string[], rules };
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
      ? "workspace is not trusted"
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
    userContent === null ? null : parsePolicyFile(userContent, "user");
  const project =
    projectContent === null ? null : parsePolicyFile(projectContent, "project");
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
