import type { PolicyRequest } from "./match.ts";
import { decisionForPath, type PathDecision } from "./path-rules.ts";
import { shellScan, type ShellScan } from "./shell-scan.ts";

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
  "fd",
  "find",
  "sort",
  "uniq",
  "cut",
  "tr",
  "nl",
  "basename",
  "dirname",
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

export function isReadOnlyShellCommand(scan: ShellScan): boolean {
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
  if (firstWord === "sort") {
    return !scan.commandWords.some(
      (word) =>
        word === "-o" ||
        word.startsWith("-o") ||
        word.startsWith("--output") ||
        word.startsWith("--files0-from") ||
        word.startsWith("--compress-program") ||
        word === "-T" ||
        word.startsWith("--temporary-directory"),
    );
  }
  if (firstWord === "uniq") {
    // `uniq input output` writes to the second positional operand; allow at most
    // one non-flag operand (input file or stdin).
    const positionals = scan.commandWords
      .slice(1)
      .filter((word) => !word.startsWith("-"));
    return positionals.length <= 1;
  }
  if (firstWord === "fd") {
    return !scan.commandWords.some(
      (word) =>
        word === "-x" ||
        word === "-X" ||
        word === "--exec" ||
        word.startsWith("--exec=") ||
        word === "--exec-batch" ||
        word.startsWith("--exec-batch="),
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
        // Known read-only date formatting flags take no value.
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

export function addReadTargets(scan: ShellScan): void {
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
  if (firstWord === "cut") {
    for (let index = 0; index < args.length; index += 1) {
      const word = args[index]!;
      if (word === "--") {
        continue;
      }
      if (word === "-d" || word === "-f" || word === "-b" || word === "-c") {
        index += 1;
        continue;
      }
      if (word.startsWith("-")) {
        continue;
      }
      read(word);
    }
    return;
  }
  if (firstWord === "fd") {
    let patternSeen = false;
    for (let index = 0; index < args.length; index += 1) {
      const word = args[index]!;
      if (word === "--") {
        continue;
      }
      if (
        word === "-e" ||
        word === "--extension" ||
        word === "-t" ||
        word === "--type" ||
        word === "-E" ||
        word === "--exclude" ||
        word === "-d" ||
        word === "--max-depth"
      ) {
        index += 1;
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
    firstWord === "tr" ||
    firstWord === "basename" ||
    firstWord === "dirname" ||
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

export function addMutationTargets(scan: ShellScan): void {
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
export function readOnlyPipelineDecision(
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
