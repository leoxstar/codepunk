import path from "node:path";

export interface ShellScan {
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

export function shellScan(command: string): ShellScan {
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

export function isNetworkShellCommand(
  commandWords: readonly string[],
): boolean {
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
