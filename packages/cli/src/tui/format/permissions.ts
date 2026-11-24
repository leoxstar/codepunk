import {
  APPROVAL_MODE_NAMES,
  PERMISSION_PROFILE_NAMES,
  permissionProfileFor,
  type CodepunkRuntime,
} from "codepunk-core";

export const AUTONOMY_PROFILES = ["read-only", "ask", "scoped"] as const;
export const SANDBOX_MODES = ["required", "uncovered"] as const;
export const FILESYSTEM_MODES = ["workspace", "full"] as const;

export function permissionUsage(): string {
  return [
    "usage:",
    "  /permissions profile|approval|autonomy|sandbox|filesystem  choose with arrows",
    `  /permissions profile ${PERMISSION_PROFILE_NAMES.join("|")}`,
    `  /permissions approval ${APPROVAL_MODE_NAMES.join("|")} · reviewer off|model`,
    "  /permissions autonomy read-only|ask|scoped",
    "  /permissions sandbox required|uncovered",
    "  /permissions sandbox network [allow|deny <domain>...|clear]",
    "  /permissions filesystem workspace|full",
    "  /permissions rules",
    "  /permissions why -- <shell command>",
    "  /trust [status|grant|revoke] [config,policy,skills,instructions]",
  ].join("\n");
}

export function permissionPicker(
  runtime: CodepunkRuntime,
  group: string,
): { values: readonly string[]; current: string } | null {
  switch (group) {
    case "profile":
      return {
        values: PERMISSION_PROFILE_NAMES,
        current: permissionProfileFor(runtime.config),
      };
    case "approval":
      return {
        values: APPROVAL_MODE_NAMES,
        current: runtime.config.approval.mode,
      };
    case "autonomy":
      return {
        values: AUTONOMY_PROFILES,
        current: runtime.config.autonomy.profile,
      };
    case "sandbox":
      return {
        values: SANDBOX_MODES,
        current: runtime.config.sandbox.mode,
      };
    case "filesystem":
      return {
        values: FILESYSTEM_MODES,
        current: runtime.config.filesystem.mode,
      };
    default:
      return null;
  }
}

export function parsePermissionWhyCommand(argument: string): string | null {
  const trimmed = argument.trim();
  if (trimmed !== "why" && !trimmed.startsWith("why ")) {
    return null;
  }
  let command = trimmed.slice("why".length).trim();
  if (command === "--") {
    command = "";
  } else if (command.startsWith("-- ")) {
    command = command.slice(3).trim();
  }
  return command.length === 0 ? null : command;
}
