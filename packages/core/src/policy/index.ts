import { homedir } from "node:os";
import path from "node:path";
import type {
  Coverage,
  Decision,
  Effects,
  PolicyDecision,
  PolicyLayer,
} from "codepunk-protocol";
import {
  effectiveApprovalDecision,
  type ApprovalClass,
} from "../config/index.ts";
import { recordHash } from "../platform/hash.ts";
import {
  isInsidePath,
  isInstructionFile,
  isSensitivePath,
  normalizeAbsolute,
  resolveRealPath,
} from "../platform/path.ts";
import { isShellLauncher } from "../platform/shell.ts";
import { MCP_RESOURCE_TOOL_NAMES, isMcpResourceTool } from "../mcp/names.ts";
import { ruleMatches, type PolicyRequest, type PolicyRule } from "./match.ts";

export type {
  PolicyLayerInput,
  PolicyRequest,
  PolicyRule,
  PolicyRuleFixture,
} from "./match.ts";
export { policyRequestForCall, ruleMatches } from "./match.ts";

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

export function isMcpProductTool(tool: string): boolean {
  return tool.startsWith("mcp__") || isMcpResourceTool(tool);
}

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

function toolEffects(tool: string): Effects {
  switch (tool) {
    case "read":
    case "search":
    case "memory_search":
      return { fs: "read", shell: false, network: false };
    case "plan":
    case "todo":
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
  if (tool === "bash" || tool === "exec" || tool === "user_bash") {
    return sandbox === "allow" ? "enforced" : "uncovered";
  }
  if (tool === "read" || tool === "search" || tool === "memory_search") {
    return "app-layer";
  }
  if (tool === "web_fetch") {
    return "app-layer";
  }
  if (tool === "plan" || tool === "todo") {
    return "app-layer";
  }
  if (tool === "write" || tool === "edit") {
    return "app-layer";
  }
  return "uncovered";
}

interface PathDecision {
  decision: Decision;
  reason: string;
  target: string | null;
  approvalClass: ApprovalClass;
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

function decisionForPath(
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

interface ShellScan {
  dangerous: boolean;
  destructive: boolean;
  complex: boolean;
  firstWord: string | null;
  words: string[];
  commandWords: string[];
  environment: string[];
  readTargets: string[];
  writeTargets: string[];
  sedTargets: string[];
}

function shellScan(command: string): ShellScan {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  // The Windows shell treats `\` as a path separator, not as an escape.
  // Stripping it here turned `C:\work\...` into a drive-relative string
  // before the path policy saw it, which could make an outside path look
  // like it belonged to the workspace.
  const backslashEscapes = process.platform !== "win32";
  let complex = false;
  const words: string[] = [];
  let current = "";
  let pendingRedirection = false;
  const writeTargets: string[] = [];
  const sedTargets: string[] = [];
  let commandSubstitution = false;

  const pushWord = () => {
    if (current.length > 0) {
      words.push(current);
      if (pendingRedirection) {
        const nullDevice =
          current === "/dev/null" ||
          (process.platform === "win32" && current.toLowerCase() === "nul");
        if (!nullDevice) {
          writeTargets.push(current);
        }
        pendingRedirection = false;
      }
      current = "";
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (backslashEscapes && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
        continue;
      }
      if (backslashEscapes && quote === '"' && character === "\\") {
        escaped = true;
        continue;
      }
      if (
        quote === '"' &&
        (character === "`" || (character === "$" && command[index + 1] === "("))
      ) {
        complex = true;
        commandSubstitution = true;
      }
      current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (
      character === ";" ||
      character === "|" ||
      character === "&" ||
      character === "\n" ||
      character === "\r"
    ) {
      complex = true;
      pushWord();
      continue;
    }
    if (character === "`") {
      complex = true;
      commandSubstitution = true;
      continue;
    }
    if (
      character === "$" &&
      (command[index + 1] === "(" || command[index + 1] === "{")
    ) {
      complex = true;
      commandSubstitution = true;
      continue;
    }
    if (
      (character === "<" || character === ">") &&
      command[index + 1] === "("
    ) {
      complex = true;
      commandSubstitution = true;
      continue;
    }
    if (character === ">" || character === "<") {
      complex = true;
      // A leading file-descriptor number is part of the redirection
      // operator (`2>/dev/null`), not a command argument.
      if (/^\d+$/u.test(current)) {
        current = "";
      }
      pushWord();
      if (character === ">") {
        pendingRedirection = true;
        if (command[index + 1] === ">") {
          index += 1;
        }
      }
      continue;
    }
    if (/\s/u.test(character)) {
      pushWord();
      continue;
    }
    current += character;
  }
  pushWord();
  if (quote !== null) {
    complex = true;
  }
  let commandIndex = 0;
  while (
    commandIndex < words.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=[-A-Za-z0-9_./:+,]*$/u.test(words[commandIndex]!)
  ) {
    commandIndex += 1;
  }
  const environment = words.slice(0, commandIndex);
  const commandWords = words.slice(commandIndex);
  const firstWord = commandWords[0] ?? null;
  const normalized = command.replace(/\s+/gu, " ").trim();
  const dangerous =
    /^(?:sudo\s+)?rm\s+(?:-[A-Za-z]*[rR][A-Za-z]*\s+)+(?:\/|\/\*)\s*$/u.test(
      normalized,
    ) ||
    /^(?:sudo\s+)?(?:mkfs(?:\.\w+)?|shutdown|reboot|halt)\b/u.test(
      normalized,
    ) ||
    /^dd\s+[^\n]*\bof=\/dev\//u.test(normalized) ||
    /:\(\)\s*\{\s*:\|:&\s*\};:/u.test(normalized);
  if (firstWord === "sed") {
    const inPlace = words.some(
      (word) => /^-[A-Za-z]*i/u.test(word) || /^--in-place(?:=|$)/u.test(word),
    );
    if (inPlace) {
      const args = words.slice(1);
      let scriptSeen = false;
      for (let index = 0; index < args.length; index += 1) {
        const word = args[index]!;
        if (word === "--") {
          continue;
        }
        if (word.startsWith("-")) {
          if (
            word === "-e" ||
            word === "-f" ||
            word === "--expression" ||
            word === "--file"
          ) {
            scriptSeen = true;
            index += 1;
          } else if (
            /^-e.+/u.test(word) ||
            /^-f.+/u.test(word) ||
            /^--(?:expression|file)=/u.test(word)
          ) {
            scriptSeen = true;
          }
          continue;
        }
        if (!scriptSeen) {
          scriptSeen = true;
          continue;
        }
        sedTargets.push(word);
      }
    }
  }
  if (
    commandSubstitution ||
    (firstWord === "find" &&
      words.some((word) =>
        /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/u.test(word),
      )) ||
    (firstWord === "rg" && words.some((word) => /^--pre(?:=|$)/u.test(word)))
  ) {
    complex = true;
  }
  return {
    dangerous,
    destructive: isDestructiveShellCommand(commandWords, complex),
    complex,
    firstWord,
    words,
    commandWords,
    environment,
    readTargets: [],
    writeTargets,
    sedTargets,
  };
}

function hasShortShellFlag(
  arguments_: readonly string[],
  letters: readonly string[],
): boolean {
  for (const argument of arguments_) {
    if (argument === "--") {
      return false;
    }
    if (!/^-[^-]/u.test(argument)) {
      continue;
    }
    if ([...argument.slice(1)].some((letter) => letters.includes(letter))) {
      return true;
    }
  }
  return false;
}

function hasLongShellFlag(
  arguments_: readonly string[],
  names: readonly string[],
): boolean {
  return arguments_.some((argument) =>
    names.some((name) => argument === name || argument.startsWith(`${name}=`)),
  );
}

function isDestructiveGitCommand(
  subcommand: string,
  args: readonly string[],
): boolean {
  if (subcommand === "reset") {
    return hasLongShellFlag(args, ["--hard", "--merge", "--keep"]);
  }
  if (subcommand === "config") {
    const readOnly = args.some((argument) =>
      ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(argument),
    );
    return !readOnly;
  }
  if (subcommand === "clean" || subcommand === "restore") {
    return true;
  }
  if (subcommand === "checkout") {
    return (
      args.includes("--") ||
      hasShortShellFlag(args, ["f"]) ||
      hasLongShellFlag(args, ["--force"])
    );
  }
  if (subcommand === "branch") {
    return (
      hasShortShellFlag(args, ["d", "D", "m", "M"]) ||
      hasLongShellFlag(args, ["--delete", "--move", "--copy"])
    );
  }
  if (subcommand === "stash") {
    return args[0] === "drop" || args[0] === "clear";
  }
  if (subcommand === "push") {
    return true;
  }
  if (subcommand === "rebase" || subcommand === "filter-branch") {
    return true;
  }
  if (
    subcommand === "filter-repo" ||
    subcommand === "replace" ||
    subcommand === "update-ref" ||
    subcommand === "reflog"
  ) {
    return true;
  }
  if (subcommand === "tag") {
    return (
      hasShortShellFlag(args, ["d"]) || hasLongShellFlag(args, ["--delete"])
    );
  }
  if (subcommand === "remote") {
    return args[0] === "remove" || args[0] === "rm";
  }
  return false;
}

/**
 * Shell commands in auto mode are approved only when their data-loss surface
 * is bounded. Deleting, overwriting, rewriting history, or composing an
 * opaque shell expression stays at the normal approval gate. This is a risk
 * classifier, not a second sandbox: unknown simple commands still rely on the
 * execution sandbox and the remaining policy layers.
 */
function isDestructiveShellCommand(
  commandWords: readonly string[],
  complex: boolean,
): boolean {
  if (complex) {
    return true;
  }
  const firstWord = commandWords[0];
  if (firstWord === undefined) {
    return false;
  }
  const args = commandWords.slice(1);
  if (
    firstWord === "rm" ||
    firstWord === "rmdir" ||
    firstWord === "unlink" ||
    firstWord === "shred" ||
    firstWord === "truncate" ||
    firstWord === "dd" ||
    firstWord === "mv" ||
    firstWord === "chmod" ||
    firstWord === "chown" ||
    firstWord === "chgrp" ||
    firstWord === "setfacl"
  ) {
    return true;
  }
  if (
    (firstWord === "sed" || firstWord === "perl") &&
    (hasShortShellFlag(args, ["i"]) || hasLongShellFlag(args, ["--in-place"]))
  ) {
    return true;
  }
  if (firstWord === "tee" && !hasShortShellFlag(args, ["a"])) {
    return true;
  }
  if (
    firstWord === "sort" &&
    (hasShortShellFlag(args, ["o"]) || hasLongShellFlag(args, ["--output"]))
  ) {
    return true;
  }
  if (firstWord === "rsync") {
    return hasLongShellFlag(args, ["--delete", "--remove-source-files"]);
  }
  if (firstWord === "git") {
    const subcommand = args[0];
    return subcommand === undefined
      ? false
      : isDestructiveGitCommand(subcommand, args.slice(1));
  }
  return false;
}

/**
 * Commands whose normal use reaches the network or a remote package index.
 * `auto` mode approves routine local work; it must not silently pre-approve
 * supply-chain or exfiltration surfaces. This is classification only: the
 * sandbox still denies egress in `required` mode, and `auto-approve`/`allow`
 * remain the explicit blanket modes.
 */
const NETWORK_EXECUTABLES = new Set([
  "curl",
  "wget",
  "http",
  "https",
  "xh",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ftp",
  "sftp",
  "ssh",
  "scp",
  "ping",
  "dig",
  "nslookup",
  "host",
  "whois",
  "traceroute",
  "gh",
  "npx",
]);

const NETWORK_PACKAGE_SUBCOMMANDS: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  npm: new Set([
    "install",
    "i",
    "add",
    "ci",
    "update",
    "upgrade",
    "publish",
    "audit",
    "view",
    "search",
    "exec",
    "dlx",
    "outdated",
  ]),
  pnpm: new Set([
    "install",
    "i",
    "add",
    "update",
    "up",
    "publish",
    "audit",
    "view",
    "search",
    "exec",
    "dlx",
    "outdated",
    "fetch",
  ]),
  yarn: new Set([
    "install",
    "add",
    "up",
    "upgrade",
    "publish",
    "audit",
    "info",
    "dlx",
    "create",
    "npm",
  ]),
  bun: new Set([
    "install",
    "i",
    "add",
    "update",
    "publish",
    "audit",
    "x",
    "create",
    "outdated",
  ]),
  pip: new Set(["install", "download", "wheel", "index"]),
  pip3: new Set(["install", "download", "wheel", "index"]),
  uv: new Set(["add", "sync", "lock", "pip", "tool", "publish"]),
  poetry: new Set(["add", "install", "update", "lock"]),
  cargo: new Set(["install", "publish", "search", "update", "add", "fetch"]),
  go: new Set(["get", "install", "download"]),
  brew: new Set(["install", "update", "upgrade", "tap", "search", "fetch"]),
  gem: new Set(["install", "update", "fetch", "push", "search"]),
  composer: new Set(["install", "require", "update", "create-project"]),
  docker: new Set(["pull", "push", "login"]),
  podman: new Set(["pull", "push", "login"]),
};

function executableName(word: string): string {
  const base = path.basename(word);
  return process.platform === "win32"
    ? base.replace(/\.(?:exe|cmd|bat)$/iu, "")
    : base;
}

function isNetworkShellCommand(commandWords: readonly string[]): boolean {
  const firstWord = commandWords[0];
  if (firstWord === undefined) {
    return false;
  }
  const name = executableName(firstWord);
  if (NETWORK_EXECUTABLES.has(name)) {
    return true;
  }
  const subcommand = commandWords[1];
  if (subcommand === undefined) {
    return false;
  }
  if (name === "git") {
    if (
      subcommand === "fetch" ||
      subcommand === "pull" ||
      subcommand === "clone" ||
      subcommand === "ls-remote"
    ) {
      return true;
    }
    if (subcommand === "remote") {
      return commandWords[2] === "update" || commandWords[2] === "prune";
    }
    if (subcommand === "submodule") {
      return commandWords[2] === "update" || commandWords[2] === "add";
    }
    return false;
  }
  return NETWORK_PACKAGE_SUBCOMMANDS[name]?.has(subcommand) ?? false;
}

export function simpleShellArgv(command: string): string[] | null {
  const scan = shellScan(command);
  if (
    scan.complex ||
    scan.dangerous ||
    scan.commandWords.length === 0 ||
    scan.environment.length > 0
  ) {
    return null;
  }
  const executable = scan.commandWords[0] ?? "";
  if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(executable)) {
    return null;
  }
  if (
    scan.commandWords.some(
      (word) =>
        /[*?\[\]{}]/u.test(word) ||
        /[$~#]/u.test(word) ||
        /[\0\n\r]/u.test(word),
    )
  ) {
    return null;
  }
  return [...scan.commandWords];
}

const READ_ONLY_SHELL_WORDS = new Set([
  "printf",
  "echo",
  "pwd",
  "ls",
  "cat",
  "grep",
  "head",
  "tail",
  "wc",
  "rg",
  "find",
  "date",
  "uname",
  "whoami",
  "hostname",
  "id",
  "sw_vers",
  "stat",
  "file",
  "tree",
  "du",
  "df",
  "which",
  "git",
  "true",
  "false",
]);

const GIT_GLOBAL_REJECTIONS = [
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--work-tree",
  "--upload-pack",
  "--receive-pack",
];

const GIT_FLAG_REJECTIONS = [
  "--ext-diff",
  "--textconv",
  "--open-files-in-pager",
  "--output",
  "--paginate",
];

function gitFlagIsRejected(word: string): boolean {
  return [...GIT_GLOBAL_REJECTIONS, ...GIT_FLAG_REJECTIONS].some(
    (flag) => word === flag || word.startsWith(`${flag}=`),
  );
}

function isReadOnlyGitCommand(words: readonly string[]): boolean {
  const subcommand = words[1];
  if (subcommand === undefined || subcommand.startsWith("-")) {
    return false;
  }
  if (words.some(gitFlagIsRejected)) {
    return false;
  }
  const args = words.slice(2);
  const onlyFlags = (allowed: (word: string) => boolean): boolean =>
    args.every((word, index) =>
      word === "--" && index === args.length - 1
        ? true
        : word.startsWith("-") && word !== "--" && allowed(word),
    );
  if (subcommand === "status") {
    return onlyFlags(
      (word) =>
        [
          "-s",
          "-sb",
          "-bs",
          "--short",
          "-b",
          "--branch",
          "--long",
          "--show-stash",
          "--ahead-behind",
          "--no-ahead-behind",
          "--no-renames",
          "--renames",
          "--ignored",
          "-uno",
          "-unormal",
          "-uall",
        ].includes(word) ||
        /^--(?:porcelain|untracked-files)(?:=|$)/u.test(word),
    );
  }
  if (subcommand === "diff") {
    const hasDisplayMode = args.some((word) =>
      [
        "--stat",
        "--shortstat",
        "--numstat",
        "--name-only",
        "--name-status",
        "--dirstat",
        "--summary",
      ].some((flag) => word === flag || word.startsWith(`${flag}=`)),
    );
    return (
      hasDisplayMode &&
      onlyFlags(
        (word) =>
          word.startsWith("--stat") ||
          word.startsWith("--dirstat") ||
          [
            "--shortstat",
            "--numstat",
            "--name-only",
            "--name-status",
            "--summary",
            "--cached",
            "--staged",
            "--no-color",
            "--no-renames",
            "--find-renames",
            "--find-copies",
          ].includes(word),
      )
    );
  }
  if (subcommand === "log") {
    const hasDisplayMode = args.some(
      (word) =>
        word === "--oneline" ||
        word === "--stat" ||
        word === "--name-only" ||
        word === "--name-status" ||
        word === "--no-patch",
    );
    return (
      hasDisplayMode &&
      onlyFlags(
        (word) =>
          [
            "--oneline",
            "--stat",
            "--name-only",
            "--name-status",
            "--no-patch",
            "--decorate",
            "--graph",
            "--all",
            "--branches",
            "--tags",
            "--no-color",
            "--no-merges",
            "--first-parent",
          ].includes(word) ||
          /^--(?:max-count|format|pretty)(?:=|$)/u.test(word) ||
          /^-\d+$/u.test(word),
      )
    );
  }
  if (subcommand === "branch") {
    return onlyFlags((word) =>
      [
        "--show-current",
        "--list",
        "-a",
        "-r",
        "-v",
        "-vv",
        "--no-color",
      ].includes(word),
    );
  }
  if (subcommand === "rev-parse") {
    return true;
  }
  if (subcommand === "ls-files") {
    return onlyFlags((word) =>
      [
        "--cached",
        "--deleted",
        "--modified",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--stage",
        "-s",
      ].includes(word),
    );
  }
  if (subcommand === "grep") {
    return (
      args.every((word) => !word.startsWith("-O")) &&
      args.filter((word) => !word.startsWith("-")).length === 1 &&
      !args.includes("--")
    );
  }
  return false;
}

function isReadOnlyShellCommand(scan: ShellScan): boolean {
  const firstWord = scan.firstWord;
  if (firstWord === null || !READ_ONLY_SHELL_WORDS.has(firstWord)) {
    return false;
  }
  if (scan.environment.length > 0) {
    // Timezone and locale are generic read-only context for `date`, not a
    // weekday lookup. Only `date` may consume these prefixes; every other
    // command, and every loader-style variable such as LD_PRELOAD or PATH,
    // still falls through to approval.
    const safeDateEnvironment = new Set(["TZ", "LC_TIME", "LC_ALL", "LANG"]);
    if (
      firstWord !== "date" ||
      !scan.environment.every((assignment) =>
        safeDateEnvironment.has(
          assignment.slice(0, assignment.indexOf("=")).toUpperCase(),
        ),
      )
    ) {
      return false;
    }
  }
  if (firstWord === "date") {
    return isReadOnlyDateCommand(scan.commandWords.slice(1));
  }
  if (firstWord === "hostname") {
    return scan.commandWords
      .slice(1)
      .every((word) =>
        ["-s", "-f", "-d", "-i", "-I", "-a", "-A"].includes(word),
      );
  }
  if (firstWord === "tail") {
    return !scan.commandWords.some(
      (word) => word === "-f" || word === "-F" || word.startsWith("--follow"),
    );
  }
  if (firstWord === "tree") {
    return !scan.commandWords.some(
      (word) =>
        word === "-o" ||
        word.startsWith("--output") ||
        word.startsWith("--fromfile"),
    );
  }
  if (firstWord === "file") {
    return !scan.commandWords.some(
      (word) =>
        word === "-f" ||
        word === "-C" ||
        word === "-m" ||
        word.startsWith("--files-from") ||
        word.startsWith("--compile") ||
        word.startsWith("--magic-file"),
    );
  }
  if (firstWord === "du") {
    return !scan.commandWords.some(
      (word) =>
        word.startsWith("--files0-from") ||
        word === "-X" ||
        word.startsWith("--exclude-from"),
    );
  }
  if (firstWord === "git") {
    return isReadOnlyGitCommand(scan.commandWords);
  }
  return true;
}

function isReadOnlyDateCommand(arguments_: readonly string[]): boolean {
  let index = 0;
  let endOfOptions = false;
  let noSync = false;

  const consumeValue = (attached: string | undefined): boolean => {
    if (attached !== undefined) {
      return true;
    }
    index += 1;
    return index < arguments_.length;
  };

  while (index < arguments_.length) {
    const word = arguments_[index]!;
    if (word.startsWith("+")) {
      index += 1;
      continue;
    }
    if (endOfOptions || !word.startsWith("-") || word === "-") {
      if (!noSync) {
        return false;
      }
      index += 1;
      continue;
    }
    if (word === "--") {
      endOfOptions = true;
      index += 1;
      continue;
    }
    if (word.startsWith("--")) {
      const [name, attached] = word.split("=", 2) as [
        string,
        string | undefined,
      ];
      if (name === "--date") {
        if (!consumeValue(attached)) {
          return false;
        }
      } else if (name === "--file") {
        if (!noSync || !consumeValue(attached)) {
          return false;
        }
      } else if (
        [
          "--debug",
          "--iso-8601",
          "--rfc-2822",
          "--rfc-email",
          "--universal",
          "--utc",
        ].includes(name)
      ) {
      } else {
        return false;
      }
      index += 1;
      continue;
    }

    for (let offset = 1; offset < word.length; offset += 1) {
      const option = word[offset]!;
      const attached = word.slice(offset + 1);
      if (option === "u" || option === "R") {
        continue;
      }
      if (option === "j") {
        noSync = true;
        continue;
      }
      if (option === "I") {
        break;
      }
      if (option === "d") {
        if (!consumeValue(attached.length > 0 ? attached : undefined)) {
          return false;
        }
        break;
      }
      if (option === "f") {
        if (
          !noSync ||
          !consumeValue(attached.length > 0 ? attached : undefined)
        ) {
          return false;
        }
        break;
      }
      if (option === "v") {
        // BSD date's relative adjustment is a display operation. GNU date
        // rejects -v, so accepting it does not create a mutation path.
        break;
      }
      return false;
    }
    index += 1;
  }
  return true;
}

function addReadTargets(scan: ShellScan): void {
  const firstWord = scan.firstWord;
  if (firstWord === null || !isReadOnlyShellCommand(scan)) {
    return;
  }
  const args = scan.commandWords.slice(1);
  const read = (word: string): void => {
    if (word.length > 0 && !word.startsWith("-")) {
      scan.readTargets.push(word);
    }
  };
  if (firstWord === "find") {
    for (const word of args) {
      if (
        word === "!" ||
        word === "(" ||
        word === ")" ||
        word.startsWith("-")
      ) {
        break;
      }
      if (word !== "--") {
        read(word);
      }
    }
    return;
  }
  if (firstWord === "rg") {
    let patternSeen = args.includes("--files");
    for (let index = 0; index < args.length; index += 1) {
      const word = args[index]!;
      if (word === "--") {
        continue;
      }
      if (word === "-f" || word === "--file" || word === "--ignore-file") {
        const value = args[index + 1];
        if (value !== undefined) {
          read(value);
          index += 1;
        }
        continue;
      }
      if (word.startsWith("--file=")) {
        read(word.slice("--file=".length));
        continue;
      }
      if (word.startsWith("--ignore-file=")) {
        read(word.slice("--ignore-file=".length));
        continue;
      }
      if (/^-f.+/u.test(word)) {
        read(word.slice(2));
        continue;
      }
      if (word === "-e" || word === "--regexp") {
        patternSeen = true;
        index += 1;
        continue;
      }
      if (
        (word.startsWith("-e") && word.length > 2) ||
        word.startsWith("--regexp=")
      ) {
        patternSeen = true;
        continue;
      }
      if (
        word === "-g" ||
        word === "--glob" ||
        word === "-t" ||
        word === "--type" ||
        word === "--type-not"
      ) {
        index += 1;
        continue;
      }
      if (
        word.startsWith("--glob=") ||
        word.startsWith("--type=") ||
        word.startsWith("--type-not=")
      ) {
        continue;
      }
      if (word.startsWith("-")) {
        continue;
      }
      if (!patternSeen) {
        patternSeen = true;
        continue;
      }
      read(word);
    }
    return;
  }
  if (firstWord === "grep") {
    let patternSeen = false;
    for (let index = 0; index < args.length; index += 1) {
      const word = args[index]!;
      if (word === "--") {
        continue;
      }
      if (word === "-f" || word === "--file") {
        const value = args[index + 1];
        if (value !== undefined) {
          read(value);
          index += 1;
        }
        continue;
      }
      if (word.startsWith("--file=")) {
        read(word.slice("--file=".length));
        continue;
      }
      if (/^-f.+/u.test(word)) {
        read(word.slice(2));
        continue;
      }
      if (word === "-e" || word === "--regexp") {
        patternSeen = true;
        index += 1;
        continue;
      }
      if (
        (word.startsWith("-e") && word.length > 2) ||
        word.startsWith("--regexp=")
      ) {
        patternSeen = true;
        continue;
      }
      if (word.startsWith("-")) {
        continue;
      }
      if (!patternSeen) {
        patternSeen = true;
        continue;
      }
      read(word);
    }
    return;
  }
  if (
    firstWord === "printf" ||
    firstWord === "echo" ||
    firstWord === "pwd" ||
    firstWord === "date" ||
    firstWord === "uname" ||
    firstWord === "whoami" ||
    firstWord === "hostname" ||
    firstWord === "id" ||
    firstWord === "sw_vers" ||
    firstWord === "true" ||
    firstWord === "false"
  ) {
    return;
  }
  for (const word of args) {
    if (/^\d+$/u.test(word) || /^\+\d+$/u.test(word)) {
      continue;
    }
    read(word);
  }
}

const MUTATING_SHELL_WORDS = new Set([
  "chmod",
  "chown",
  "cp",
  "dd",
  "install",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "tee",
  "touch",
  "truncate",
]);

function addMutationTargets(scan: ShellScan): void {
  const firstWord = scan.firstWord;
  if (firstWord === null || !MUTATING_SHELL_WORDS.has(firstWord)) {
    return;
  }
  if (firstWord === "dd") {
    for (const word of scan.commandWords) {
      if (word.startsWith("of=") && word.length > 3) {
        scan.writeTargets.push(word.slice(3));
      }
    }
    return;
  }
  const words = scan.commandWords
    .slice(1)
    .filter((word) => !word.startsWith("-"));
  if (
    firstWord === "cp" ||
    firstWord === "ln" ||
    firstWord === "install" ||
    firstWord === "mv"
  ) {
    const destination = words.at(-1);
    if (destination !== undefined && destination.length > 0) {
      scan.writeTargets.push(destination);
    }
    if (firstWord === "mv") {
      for (const word of words
        .slice(1)
        .filter((word) => !word.startsWith("-"))) {
        scan.writeTargets.push(word);
      }
    }
    return;
  }
  if (firstWord === "chmod" || firstWord === "chown") {
    for (const word of words.slice(1).filter((word) => !word.startsWith("-"))) {
      scan.writeTargets.push(word);
    }
    return;
  }
  for (const word of words) {
    if (word.length > 0) {
      scan.writeTargets.push(word);
    }
  }
}

function splitReadOnlyShellPipeline(command: string): string[] | null {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = (end: number): boolean => {
    const segment = command.slice(start, end).trim();
    if (segment.length === 0) {
      return false;
    }
    segments.push(segment);
    return true;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "$" || character === "`") {
      return null;
    }
    if (
      character === ";" ||
      character === "<" ||
      character === ">" ||
      character === "\n" ||
      character === "\r" ||
      character === "(" ||
      character === ")"
    ) {
      return null;
    }
    if (character === "&") {
      if (command[index + 1] !== "&") {
        return null;
      }
      if (!push(index)) {
        return null;
      }
      index += 1;
      start = index + 1;
      continue;
    }
    if (character === "|") {
      if (command[index + 1] === "|") {
        return null;
      }
      if (!push(index)) {
        return null;
      }
      start = index + 1;
    }
  }
  if (quote !== null || escaped) {
    return null;
  }
  if (!push(command.length)) {
    return null;
  }
  return segments;
}

/**
 * Read-only pipelines are allowed only when every segment is independently
 * classifiable as a read. The parser deliberately accepts only `&&` and `|`;
 * redirection, command substitution, boolean `||`, and background separators
 * remain at the normal approval gate.
 */
function readOnlyPipelineDecision(
  request: PolicyRequest,
  command: string,
): PathDecision | null {
  const segments = splitReadOnlyShellPipeline(command);
  if (segments === null) {
    return null;
  }
  let currentCwd = request.cwd;
  let pathTarget: string | null = null;
  for (const [index, segment] of segments.entries()) {
    const scan = shellScan(segment);
    if (scan.dangerous) {
      return {
        decision: "deny",
        reason: "dangerous shell pipeline segment is denied",
        target: null,
        approvalClass: "destructive",
      };
    }
    if (scan.complex) {
      return null;
    }
    if (scan.firstWord === "cd") {
      if (index !== 0 || segments.length < 2 || scan.environment.length > 0) {
        return null;
      }
      const args = scan.commandWords.slice(1);
      if (
        args.length !== 1 ||
        args[0]!.length === 0 ||
        args[0]!.startsWith("-") ||
        /[$`{}*?[\]()]/u.test(args[0]!)
      ) {
        return null;
      }
      const check = decisionForPath(
        { ...request, cwd: currentCwd },
        args[0],
        false,
      );
      if (check.decision !== "allow") {
        return check;
      }
      if (check.target !== null) {
        currentCwd = check.target;
      }
      pathTarget = check.target;
      continue;
    }
    if (
      scan.environment.length > 0 ||
      scan.writeTargets.length > 0 ||
      scan.sedTargets.length > 0 ||
      !isReadOnlyShellCommand(scan)
    ) {
      return null;
    }
    addReadTargets(scan);
    for (const target of scan.readTargets) {
      if (/\$|[{}*?[\]]/u.test(target)) {
        return {
          decision: "ask",
          reason: "dynamic read path requires approval",
          target: null,
          approvalClass: "sensitive",
        };
      }
      const check = decisionForPath(
        { ...request, cwd: currentCwd },
        target,
        false,
      );
      pathTarget = check.target ?? pathTarget;
      if (check.decision !== "allow") {
        return check;
      }
    }
  }
  return {
    decision: "allow",
    reason: "read-only shell pipeline is allowed",
    target: pathTarget,
    approvalClass: "routine",
  };
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
  if (request.tool === "web_fetch") {
    return {
      decision: "allow",
      reason:
        "public web reads are allowed; the fetch tool still enforces private-host and deny-list guards",
      rule: {
        id: "web.fetch.allow",
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
