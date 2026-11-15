import path from "node:path";

const SHELL_LAUNCHERS = new Set([
  "sh",
  "bash",
  "dash",
  "ash",
  "ksh",
  "mksh",
  "pdksh",
  "zsh",
  "fish",
  "csh",
  "tcsh",
  "pwsh",
  "powershell",
  "cmd",
  "env",
  "busybox",
  "xargs",
  "python",
  "perl",
  "ruby",
  "php",
  "node",
  "nodejs",
  "deno",
  "bun",
  "osascript",
]);

/**
 * Whether the argv starts a process that can interpret another command or
 * program supplied at runtime. This is shared by policy classification,
 * scoped-rule validation, and headless exec verification so those boundaries
 * cannot drift apart.
 */
export function isShellLauncher(argv: readonly string[]): boolean {
  const base = path
    .basename(argv[0] ?? "")
    .replace(/\.exe$/iu, "")
    .toLowerCase();
  return (
    SHELL_LAUNCHERS.has(base) ||
    /^(?:python|perl|ruby|node|php)(?:\d+(?:\.\d+)*)?$/u.test(base)
  );
}
