import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256Bytes } from "../platform/hash.ts";
import { isInsidePath, normalizeAbsolute } from "../platform/path.ts";

export const MAX_CUSTOM_COMMAND_BYTES = 64 * 1024;
const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export interface CustomCommandTemplate {
  readonly name: string;
  readonly description: string;
  readonly scope: "user" | "project";
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly template: string;
}

export interface CustomCommandBundle {
  readonly commands: CustomCommandTemplate[];
  readonly warnings: string[];
}

function parseCommandMarkdown(raw: string): {
  description: string | null;
  body: string;
} {
  const normalized = raw.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith("---\n")) {
    return { description: null, body: normalized.trim() };
  }
  const endMarker = normalized.indexOf("\n---\n", 4);
  if (endMarker < 0) {
    return { description: null, body: normalized.trim() };
  }
  const frontmatter = normalized.slice(4, endMarker);
  const body = normalized.slice(endMarker + 5).trim();
  let description: string | null = null;
  for (const line of frontmatter.split("\n")) {
    const match = /^description\s*:\s*(.+)$/u.exec(line.trim());
    if (match !== null) {
      const value = (match[1] ?? "").trim().replace(/^["']|["']$/gu, "");
      if (value.length > 0) {
        description = value.slice(0, 120);
      }
    }
  }
  return { description, body };
}

function defaultDescription(body: string, scope: "user" | "project"): string {
  const firstLine = body
    .split(/\r?\n/u)
    .map((line) => line.replace(/^#+\s*/u, "").trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) {
    return `${scope} custom prompt template`;
  }
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function splitCommandArgs(rawArgs: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/gu;
  for (const match of rawArgs.matchAll(pattern)) {
    const value =
      match[1] !== undefined
        ? match[1].replace(/\\(["\\])/gu, "$1")
        : (match[2] ?? match[3] ?? "");
    tokens.push(value);
  }
  return tokens;
}

export function expandCustomCommand(
  command: Pick<CustomCommandTemplate, "template">,
  rawArgs: string,
): string {
  const trimmedArgs = rawArgs.trim();
  const positional = splitCommandArgs(trimmedArgs);
  const usesPlaceholders = /\$ARGUMENTS|\$[1-9]\b/u.test(command.template);
  const replaced = command.template
    .replace(/\$ARGUMENTS/gu, () => trimmedArgs)
    .replace(/\$([1-9])\b/gu, (_full, indexText: string) => {
      const idx = Number.parseInt(indexText, 10) - 1;
      return positional[idx] ?? "";
    })
    .trim();
  if (!usesPlaceholders && trimmedArgs.length > 0) {
    return `${replaced}\n\n${trimmedArgs}`;
  }
  return replaced;
}

async function readScopeCommands(
  directory: string,
  rootBoundary: string,
  scope: "user" | "project",
  warnings: string[],
): Promise<CustomCommandTemplate[]> {
  let dirStat;
  try {
    dirStat = await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    warnings.push(`${scope} commands directory could not be inspected`);
    return [];
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    warnings.push(`${scope} commands path must be a regular directory`);
    return [];
  }
  const realRoot = normalizeAbsolute(await fs.realpath(rootBoundary));
  const realDir = normalizeAbsolute(await fs.realpath(directory));
  if (!isInsidePath(realRoot, realDir)) {
    warnings.push(`${scope} commands directory escapes its root`);
    return [];
  }
  const entries = (await fs.readdir(realDir, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  const loaded: CustomCommandTemplate[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) {
      continue;
    }
    const name = entry.name.slice(0, -".md".length);
    if (!COMMAND_NAME_PATTERN.test(name)) {
      warnings.push(
        `skipped ${scope} command ${entry.name}: name must match [a-z0-9][a-z0-9_-]*`,
      );
      continue;
    }
    const fullPath = path.join(realDir, entry.name);
    let stat;
    try {
      stat = await fs.lstat(fullPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      warnings.push(
        `skipped ${scope} command ${entry.name}: file must not be a symlink`,
      );
      continue;
    }
    if (stat.size > MAX_CUSTOM_COMMAND_BYTES) {
      warnings.push(
        `skipped ${scope} command ${entry.name}: exceeds ${MAX_CUSTOM_COMMAND_BYTES} bytes`,
      );
      continue;
    }
    const bytes = await fs.readFile(fullPath);
    if (bytes.includes(0)) {
      warnings.push(
        `skipped ${scope} command ${entry.name}: binary content is not allowed`,
      );
      continue;
    }
    const parsed = parseCommandMarkdown(bytes.toString("utf8"));
    if (parsed.body.length === 0) {
      warnings.push(
        `skipped ${scope} command ${entry.name}: template is empty`,
      );
      continue;
    }
    loaded.push({
      name,
      description: parsed.description ?? defaultDescription(parsed.body, scope),
      scope,
      path: fullPath,
      sha256: sha256Bytes(bytes),
      bytes: bytes.byteLength,
      template: parsed.body,
    });
  }
  return loaded;
}

export async function loadCustomCommands(options: {
  codepunkHome: string;
  deliveryRoot: string;
  projectTrusted: boolean;
}): Promise<CustomCommandBundle> {
  const warnings: string[] = [];
  const home = normalizeAbsolute(options.codepunkHome);
  const deliveryRoot = normalizeAbsolute(options.deliveryRoot);
  const userCommands = await readScopeCommands(
    path.join(home, "commands"),
    home,
    "user",
    warnings,
  );
  const byName = new Map<string, CustomCommandTemplate>();
  for (const command of userCommands) {
    byName.set(command.name, command);
  }

  const projectCommandsDir = path.join(deliveryRoot, ".codepunk", "commands");
  if (!options.projectTrusted) {
    try {
      const entries = await fs.readdir(projectCommandsDir);
      if (entries.some((name) => name.endsWith(".md"))) {
        warnings.push(
          "project custom commands in .codepunk/commands skipped because workspace config is not trusted",
        );
      }
    } catch {
      // Directory absent; nothing skipped.
    }
  } else {
    const projectCommands = await readScopeCommands(
      projectCommandsDir,
      deliveryRoot,
      "project",
      warnings,
    );
    for (const command of projectCommands) {
      if (byName.has(command.name)) {
        warnings.push(
          `project custom command ${command.name} shadowed by user command of the same name`,
        );
        continue;
      }
      byName.set(command.name, command);
    }
  }

  return {
    commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  };
}

export function formatCustomCommands(bundle: CustomCommandBundle): string {
  const lines: string[] = [];
  if (bundle.commands.length === 0) {
    lines.push(
      "custom commands: none (add Markdown templates in $CODEPUNK_HOME/commands/<name>.md or trusted .codepunk/commands/<name>.md)",
    );
  } else {
    lines.push(`custom commands (${bundle.commands.length}):`);
    for (const cmd of bundle.commands) {
      lines.push(`  /run ${cmd.name} [${cmd.scope}] — ${cmd.description}`);
    }
  }
  for (const warning of bundle.warnings) {
    lines.push(`warning: ${warning}`);
  }
  return lines.join("\n");
}
