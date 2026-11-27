import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type {
  AutonomyProfile,
  AutonomyRule,
  AutonomyEvidence,
} from "codepunk-protocol";
import { recordHash, sha256Bytes } from "../platform/hash.ts";
import { normalizeAbsolute, resolveRealPath } from "../platform/path.ts";
import { isShellLauncher } from "../platform/shell.ts";
import { simpleShellArgv } from "../policy/index.ts";

export interface ScopedRule extends AutonomyRule {}

export interface AutonomyRegistration {
  profile: AutonomyProfile;
  source: "cli" | "user-config" | "default";
  rules: readonly ScopedRule[];
  rulesSha256: string | null;
}

export class AutonomyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AutonomyError";
    this.code = code;
  }
}

export function autonomyRuleHash(
  rule: Omit<ScopedRule, "rule_sha256">,
): string {
  return recordHash({
    id: rule.id,
    argv: rule.argv,
    cwd: normalizeAbsolute(rule.cwd),
    executable_sha256: rule.executable_sha256,
  });
}

export function autonomyRulesHash(rules: readonly ScopedRule[]): string {
  return recordHash({ rules: rules.map((rule) => rule.rule_sha256) });
}

export const SCOPED_SINGLE_WILDCARD = "*" as const;
export const SCOPED_REST_WILDCARD = "**" as const;

const DANGEROUS_WILDCARD_FLAGS = new Set([
  "-f",
  "-rf",
  "-fr",
  "--force",
  "--force-with-lease",
  "--hard",
  "--no-verify",
  "--delete",
  "-D",
]);

function isSafeWildcardArgument(token: string): boolean {
  if (token.length === 0 || /[\0\n\r]/u.test(token)) {
    return false;
  }
  if (/[;&|<>`]/u.test(token) || token.includes("$(")) {
    return false;
  }
  if (DANGEROUS_WILDCARD_FLAGS.has(token)) {
    return false;
  }
  return true;
}

export function matchScopedArgv(
  pattern: readonly string[],
  candidate: readonly string[],
): boolean {
  if (pattern.length === 0 || candidate.length === 0) {
    return false;
  }
  if (
    pattern[0] === SCOPED_SINGLE_WILDCARD ||
    pattern[0] === SCOPED_REST_WILDCARD ||
    pattern[0] !== candidate[0]
  ) {
    return false;
  }
  const hasTrailingRest =
    pattern.length >= 3 && pattern[pattern.length - 1] === SCOPED_REST_WILDCARD;
  if (hasTrailingRest) {
    const fixedPrefix = pattern.slice(0, -1);
    if (candidate.length < fixedPrefix.length) {
      return false;
    }
    for (let index = 1; index < fixedPrefix.length; index += 1) {
      const ruleToken = fixedPrefix[index]!;
      const value = candidate[index]!;
      if (ruleToken === SCOPED_REST_WILDCARD) {
        return false;
      }
      if (ruleToken === SCOPED_SINGLE_WILDCARD) {
        if (!isSafeWildcardArgument(value)) {
          return false;
        }
        continue;
      }
      if (ruleToken !== value) {
        return false;
      }
    }
    for (let index = fixedPrefix.length; index < candidate.length; index += 1) {
      if (!isSafeWildcardArgument(candidate[index]!)) {
        return false;
      }
    }
    return true;
  }
  if (pattern.length !== candidate.length) {
    return false;
  }
  for (let index = 1; index < pattern.length; index += 1) {
    const ruleToken = pattern[index]!;
    const value = candidate[index]!;
    if (ruleToken === SCOPED_REST_WILDCARD) {
      return false;
    }
    if (ruleToken === SCOPED_SINGLE_WILDCARD) {
      if (!isSafeWildcardArgument(value)) {
        return false;
      }
      continue;
    }
    if (ruleToken !== value) {
      return false;
    }
  }
  return true;
}

export { isShellLauncher };

export async function resolveExecutable(
  argv0: string,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const candidates: string[] = [];
  if (argv0.includes("/") || argv0.includes("\\")) {
    candidates.push(
      normalizeAbsolute(
        path.isAbsolute(argv0) ? argv0 : path.resolve(cwd, argv0),
      ),
    );
  } else {
    for (const entry of (environment["PATH"] ?? "").split(path.delimiter)) {
      if (entry.length === 0) {
        continue;
      }
      candidates.push(path.resolve(entry, argv0));
      if (process.platform === "win32") {
        candidates.push(path.resolve(entry, `${argv0}.exe`));
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) {
        continue;
      }
      await fs.access(candidate, fsConstants.X_OK);
      return normalizeAbsolute(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

export async function executableDigest(executable: string): Promise<string> {
  const bytes = await fs.readFile(executable);
  return sha256Bytes(bytes);
}

export async function verifyScopedRule(
  rule: ScopedRule,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (isShellLauncher(rule.argv)) {
    return "scoped rules cannot launch a shell or interpreter";
  }
  const executable = await resolveExecutable(
    rule.argv[0]!,
    rule.cwd,
    environment,
  );
  if (executable === null) {
    return "scoped rule executable cannot be resolved";
  }
  const digest = await executableDigest(executable);
  if (digest !== rule.executable_sha256) {
    return "scoped rule executable digest changed";
  }
  return null;
}

export class AutonomyController {
  private activeProfile: AutonomyProfile;
  readonly source: "cli" | "user-config" | "default";
  private activeRules: ScopedRule[];
  private activeRulesSha256: string | null;
  private revoked = false;

  constructor(registration: AutonomyRegistration) {
    this.activeProfile = registration.profile;
    this.source = registration.source;
    this.activeRules = [...registration.rules];
    this.activeRulesSha256 = registration.rulesSha256;
    if (this.profile !== "scoped" && this.rules.length > 0) {
      throw new AutonomyError(
        "autonomy.rules_without_scoped",
        "scoped rules require the scoped autonomy profile",
      );
    }
    if (this.profile === "scoped" && this.rules.length === 0) {
      throw new AutonomyError(
        "autonomy.scoped_empty",
        "scoped autonomy requires at least one named rule",
      );
    }
  }

  get isRevoked(): boolean {
    return this.revoked;
  }

  get profile(): AutonomyProfile {
    return this.activeProfile;
  }

  get rules(): readonly ScopedRule[] {
    return this.activeRules;
  }

  get rulesSha256(): string | null {
    return this.activeRulesSha256;
  }

  replaceRules(rules: readonly ScopedRule[], rulesSha256: string | null): void {
    if (this.activeProfile === "scoped" && rules.length === 0) {
      throw new AutonomyError(
        "autonomy.scoped_empty",
        "scoped autonomy requires at least one named rule",
      );
    }
    this.activeRules = [...rules];
    this.activeRulesSha256 = rulesSha256;
  }

  setProfile(profile: AutonomyProfile): void {
    if (profile === "scoped" && this.rules.length === 0) {
      throw new AutonomyError(
        "autonomy.scoped_empty",
        "scoped autonomy requires at least one named rule",
      );
    }
    this.activeProfile = profile;
  }

  revoke(): void {
    this.revoked = true;
  }

  evidence(rule: ScopedRule | null): AutonomyEvidence {
    return {
      profile: this.profile,
      rule_id: rule?.id ?? null,
      rule_sha256: rule?.rule_sha256 ?? null,
      rules_sha256: this.profile === "scoped" ? this.rulesSha256 : null,
    };
  }

  async authorize(input: {
    tool: string;
    argv?: readonly string[] | null;
    command?: string | null;
    cwd: string;
    environment?: NodeJS.ProcessEnv;
  }): Promise<ScopedRule | null> {
    if (this.profile !== "scoped" || this.revoked) {
      return null;
    }
    if (
      input.tool !== "bash" &&
      input.tool !== "exec" &&
      input.tool !== "user_bash"
    ) {
      return null;
    }
    let argv: string[] | null;
    if (input.tool === "exec") {
      argv =
        input.argv === undefined || input.argv === null
          ? null
          : [...input.argv];
    } else {
      argv =
        input.command === undefined || input.command === null
          ? null
          : simpleShellArgv(input.command);
    }
    if (argv === null) {
      return null;
    }
    const cwd = resolveRealPath(input.cwd);
    for (const rule of this.rules) {
      if (resolveRealPath(rule.cwd) !== cwd) {
        continue;
      }
      if (!matchScopedArgv(rule.argv, argv)) {
        continue;
      }
      const issue = await verifyScopedRule(
        rule,
        input.environment ?? process.env,
      );
      if (issue === null) {
        return rule;
      }
    }
    return null;
  }
}

export function childAutonomy(): AutonomyRegistration {
  return {
    profile: "ask",
    source: "default",
    rules: [],
    rulesSha256: null,
  };
}
