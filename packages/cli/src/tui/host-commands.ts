import path from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

export interface PiBuiltinSlashCommand {
  name: string;
  description: string;
}

/**
 * Pi's root export intentionally omits the builtin slash table. Read the
 * installed package's real table instead of copying it; if a Pi upgrade moves
 * that module, the session start fails loudly rather than silently rejecting
 * a legal command.
 */
export async function loadPiBuiltinSlashCommands(): Promise<
  readonly PiBuiltinSlashCommand[]
> {
  const modulePath = path.join(
    getPackageDir(),
    "dist",
    "core",
    "slash-commands.js",
  );
  const moduleUrl = pathToFileURL(modulePath).href;
  const loaded = (await import(moduleUrl)) as {
    BUILTIN_SLASH_COMMANDS?: unknown;
  };
  if (
    !Array.isArray(loaded.BUILTIN_SLASH_COMMANDS) ||
    loaded.BUILTIN_SLASH_COMMANDS.some(
      (command) =>
        command === null ||
        typeof command !== "object" ||
        typeof (command as PiBuiltinSlashCommand).name !== "string" ||
        typeof (command as PiBuiltinSlashCommand).description !== "string",
    )
  ) {
    throw new Error(
      `Pi builtin slash commands are missing or malformed at ${modulePath}`,
    );
  }
  return loaded.BUILTIN_SLASH_COMMANDS as PiBuiltinSlashCommand[];
}

export function isSlashCommand(text: string, name: string): boolean {
  return text === name || text.startsWith(`${name} `);
}

const INTERCEPTED_PI_COMMANDS = new Set([
  "settings",
  "scoped-models",
  "import",
  "share",
  "bug",
]);

export function filterInterceptedAutocomplete<T extends { value: string }>(
  items: readonly T[],
): T[] {
  return items.filter((item) => !INTERCEPTED_PI_COMMANDS.has(item.value));
}
