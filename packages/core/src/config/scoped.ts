import { promises as fs } from "node:fs";
import path from "node:path";
import {
  SCOPED_REST_WILDCARD,
  SCOPED_SINGLE_WILDCARD,
  autonomyRuleHash,
  autonomyRulesHash,
  executableDigest,
  isShellLauncher,
  resolveExecutable,
  verifyScopedRule,
  type ScopedRule,
} from "../autonomy/index.ts";
import { sha256Text } from "../platform/hash.ts";
import { atomicWriteFile, posixMetadataIsReliable } from "../platform/fs.ts";
import {
  isInsidePath,
  normalizeAbsolute,
  resolveRealPath,
} from "../platform/path.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import { ConfigError } from "./index.ts";
import { parseToml, TomlError, type TomlTable } from "./toml.ts";

export interface LoadedScopedRules {
  path: string;
  sha256: string;
  rules: ScopedRule[];
  rulesSha256: string;
}

export interface PersistScopedRuleInput {
  paths: ProjectPaths;
  argv: readonly string[];
  cwd: string;
  filePath?: string | null;
  environment?: NodeJS.ProcessEnv;
}

export interface PersistedScopedRule {
  path: string;
  rule: ScopedRule;
  created: boolean;
}

const ROOT_KEYS = new Set(["version", "rules"]);
const RULE_KEYS = new Set(["id", "argv", "cwd", "executable_sha256"]);
const PATTERN_KEYS = new Set([
  "glob",
  "globs",
  "prefix",
  "regex",
  "pattern",
  "command",
  "shell",
]);

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new ConfigError(`${label} must be a non-empty string array`);
  }
  return [...value] as string[];
}

function validateRule(entry: unknown, index: number): ScopedRule {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new ConfigError(`scoped rule ${index + 1} must be a table`);
  }
  const table = entry as TomlTable;
  for (const key of Object.keys(table)) {
    if (PATTERN_KEYS.has(key)) {
      throw new ConfigError(
        `scoped rule ${index + 1} uses unsupported match key ${key}; scoped rules are exact argv arrays`,
      );
    }
    if (!RULE_KEYS.has(key)) {
      throw new ConfigError(`scoped rule ${index + 1} has unknown key ${key}`);
    }
  }
  const id = table["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new ConfigError(`scoped rule ${index + 1} needs an id`);
  }
  const argv = stringArray(table["argv"], `scoped rule ${id} argv`);
  let sawWildcard = false;
  let sawFixedSubarg = false;
  for (const [tokenIndex, token] of argv.entries()) {
    if (/[\0\n\r]/u.test(token)) {
      throw new ConfigError(
        `scoped rule ${id} argv contains a control character`,
      );
    }
    if (/[;&|<>`]/u.test(token) || token.includes("$(")) {
      throw new ConfigError(`scoped rule ${id} argv contains a shell fragment`);
    }
    if (tokenIndex >= 1 && token === SCOPED_SINGLE_WILDCARD) {
      sawWildcard = true;
      continue;
    }
    if (
      tokenIndex >= 2 &&
      tokenIndex === argv.length - 1 &&
      token === SCOPED_REST_WILDCARD
    ) {
      sawWildcard = true;
      continue;
    }
    if (/[*?[\]{}]/u.test(token)) {
      throw new ConfigError(
        `scoped rule ${id} argv contains a glob or pattern token`,
      );
    }
    if (tokenIndex >= 1) {
      sawFixedSubarg = true;
    }
  }
  if (sawWildcard && !sawFixedSubarg) {
    throw new ConfigError(
      `scoped rule ${id} wildcard argv requires at least one fixed subcommand or flag (glob or pattern-only argv is not allowed)`,
    );
  }
  if (isShellLauncher(argv)) {
    throw new ConfigError(
      `scoped rule ${id} cannot launch a shell or interpreter`,
    );
  }
  const cwd = table["cwd"];
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new ConfigError(`scoped rule ${id} cwd must be an absolute path`);
  }
  const executable = table["executable_sha256"];
  if (
    typeof executable !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(executable)
  ) {
    throw new ConfigError(
      `scoped rule ${id} executable_sha256 must be sha256:<64 hex>`,
    );
  }
  const normalized: Omit<ScopedRule, "rule_sha256"> = {
    id,
    argv,
    cwd: resolveRealPath(normalizeAbsolute(cwd)),
    executable_sha256: executable,
  };
  return { ...normalized, rule_sha256: autonomyRuleHash(normalized) };
}

export async function loadScopedRules(
  filePath: string,
  paths: ProjectPaths,
): Promise<LoadedScopedRules> {
  const requested = normalizeAbsolute(filePath);
  let linkStat;
  try {
    linkStat = await fs.lstat(requested);
  } catch {
    throw new ConfigError(
      "scoped rules file does not exist",
      "autonomy.scoped_rules",
    );
  }
  if (linkStat.isSymbolicLink()) {
    throw new ConfigError(
      "scoped rules file must not be a symlink",
      "autonomy.scoped_rules",
    );
  }
  if (!linkStat.isFile()) {
    throw new ConfigError(
      "scoped rules path must be a regular file",
      "autonomy.scoped_rules",
    );
  }
  const realPath = normalizeAbsolute(await fs.realpath(requested));
  if (isInsidePath(paths.deliveryRoot, realPath)) {
    throw new ConfigError(
      "scoped rules must be outside the repository",
      "autonomy.scoped_rules",
    );
  }
  const posixMetadata = await posixMetadataIsReliable(realPath);
  if (posixMetadata && (linkStat.mode & 0o022) !== 0) {
    throw new ConfigError(
      "scoped rules file must not be group or world writable",
      "autonomy.scoped_rules",
    );
  }
  const uid = process.getuid?.();
  if (posixMetadata && uid !== undefined && linkStat.uid !== uid) {
    throw new ConfigError(
      "scoped rules file must be owned by the invoking user",
      "autonomy.scoped_rules",
    );
  }
  const content = await fs.readFile(realPath, "utf8");
  let parsed: TomlTable;
  try {
    parsed = parseToml(content);
  } catch (error) {
    if (error instanceof TomlError) {
      throw new ConfigError(`scoped rules: ${error.message}`);
    }
    throw error;
  }
  for (const key of Object.keys(parsed)) {
    if (!ROOT_KEYS.has(key)) {
      throw new ConfigError(`scoped rules has unknown key ${key}`);
    }
  }
  if (parsed["version"] !== 1) {
    throw new ConfigError("scoped rules version must be 1");
  }
  const rawRules = parsed["rules"];
  if (!Array.isArray(rawRules) || rawRules.length === 0) {
    throw new ConfigError("scoped rules must contain at least one rule");
  }
  const rules: ScopedRule[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of rawRules.entries()) {
    const rule = validateRule(entry, index);
    if (ids.has(rule.id)) {
      throw new ConfigError(`duplicate scoped rule id ${rule.id}`);
    }
    ids.add(rule.id);
    const issue = await verifyScopedRule(rule);
    if (issue !== null) {
      throw new ConfigError(`scoped rule ${rule.id}: ${issue}`);
    }
    rules.push(rule);
  }
  return {
    path: realPath,
    sha256: sha256Text(content),
    rules,
    rulesSha256: autonomyRulesHash(rules),
  };
}

function serializeScopedRules(rules: readonly ScopedRule[]): string {
  const lines = ["version = 1", ""];
  for (const rule of rules) {
    lines.push(
      "[[rules]]",
      `id = ${JSON.stringify(rule.id)}`,
      `argv = [${rule.argv.map((value) => JSON.stringify(value)).join(", ")}]`,
      `cwd = ${JSON.stringify(rule.cwd)}`,
      `executable_sha256 = ${JSON.stringify(rule.executable_sha256)}`,
      "",
    );
  }
  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}

export async function persistScopedRule(
  input: PersistScopedRuleInput,
): Promise<PersistedScopedRule> {
  if (!path.isAbsolute(input.cwd)) {
    throw new ConfigError(
      "scoped rule cwd must be an absolute path",
      "autonomy.scoped_rules",
    );
  }
  const cwd = resolveRealPath(normalizeAbsolute(input.cwd));
  const argv = [...input.argv];
  // Refuse a shell launcher before resolving it. The refusal must not depend
  // on whether this host happens to have /bin/sh or cmd.exe on disk.
  if (isShellLauncher(argv)) {
    throw new ConfigError(
      "scoped rule cannot launch a shell or interpreter",
      "autonomy.scoped_rules",
    );
  }
  const executable = await resolveExecutable(
    argv[0] ?? "",
    cwd,
    input.environment ?? process.env,
  );
  if (executable === null) {
    throw new ConfigError(
      "scoped rule executable cannot be resolved",
      "autonomy.scoped_rules",
    );
  }
  const digest = await executableDigest(executable);
  const fingerprint = sha256Text(JSON.stringify({ argv, cwd, digest })).slice(
    "sha256:".length,
    "sha256:".length + 12,
  );
  const candidate = validateRule(
    {
      id: `approval-${fingerprint}`,
      argv,
      cwd,
      executable_sha256: digest,
    },
    0,
  );
  const filePath = normalizeAbsolute(
    input.filePath ?? path.join(input.paths.home, "scoped-rules.toml"),
  );
  if (isInsidePath(input.paths.deliveryRoot, filePath)) {
    throw new ConfigError(
      "scoped rules must be outside the repository",
      "autonomy.scoped_rules",
    );
  }
  let existing: LoadedScopedRules | null = null;
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  try {
    existing = await loadScopedRules(filePath, input.paths);
  } catch (error) {
    if (
      !(error instanceof ConfigError) ||
      !/does not exist/u.test(error.message)
    ) {
      throw error;
    }
  }
  const rules = existing === null ? [] : [...existing.rules];
  const duplicate = rules.find(
    (rule) =>
      rule.cwd === candidate.cwd &&
      rule.executable_sha256 === candidate.executable_sha256 &&
      rule.argv.length === candidate.argv.length &&
      rule.argv.every((value, index) => value === candidate.argv[index]),
  );
  if (duplicate !== undefined) {
    return { path: filePath, rule: duplicate, created: false };
  }
  let rule = candidate;
  let suffix = 1;
  while (rules.some((entry) => entry.id === rule.id)) {
    suffix += 1;
    rule = {
      ...candidate,
      id: `${candidate.id}-${suffix}`,
    };
    rule = {
      ...rule,
      rule_sha256: autonomyRuleHash({
        id: rule.id,
        argv: rule.argv,
        cwd: rule.cwd,
        executable_sha256: rule.executable_sha256,
      }),
    };
  }
  rules.push(rule);
  await atomicWriteFile(filePath, serializeScopedRules(rules), 0o600);
  const verified = await loadScopedRules(filePath, input.paths);
  const stored = verified.rules.find((entry) => entry.id === rule.id);
  if (stored === undefined) {
    throw new ConfigError(
      "scoped rule was written but could not be reloaded",
      "autonomy.scoped_rules",
    );
  }
  return { path: verified.path, rule: stored, created: true };
}
