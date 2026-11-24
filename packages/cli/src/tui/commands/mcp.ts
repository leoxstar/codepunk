import { notify } from "../format/notify.ts";
import {
  addMcpServerInteractive,
  removeMcpServerInteractive,
  resolveMcpLoginTarget,
} from "../format/mcp.ts";
import {
  McpAuthStore,
  collectCapabilities,
  formatMcpServers,
  loginMcpServer,
  mcpUsesAuthorizationHeader,
  oauthSettings,
  readMcpConfig,
  type CodepunkRuntime,
} from "codepunk-core";
import type { TuiCommand } from "../define-command.ts";
import { commandContext } from "../command-context.ts";
import type { TuiState } from "../state.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineCommand } from "../define-command.ts";

async function mcpStatusOrLogout(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  action: "status" | "logout",
  parts: string[],
): Promise<void> {
  let name = parts[1];
  const configs = await readMcpConfig(runtime.paths);
  if (name === undefined && action === "logout") {
    const candidates = configs.filter(
      (config) =>
        config.transport === "http" && !mcpUsesAuthorizationHeader(config),
    );
    if (candidates.length === 0) {
      await notify(
        context,
        "No user MCP servers with OAuth credentials are configured.",
      );
      return;
    }
    if (candidates.length === 1) {
      name = candidates[0]!.name;
    } else {
      const selected = await context.ui.select(
        "MCP server to sign out",
        candidates.map((config) => config.name),
      );
      if (selected === undefined) {
        return;
      }
      name = selected;
    }
  }
  const selected =
    name === undefined
      ? configs
      : configs.filter((config) => config.name === name);
  if (name !== undefined && selected.length === 0) {
    context.ui.notify(`MCP server ${name} is not configured`, "warning");
    return;
  }
  if (selected.length === 0) {
    await notify(context, "no user MCP servers configured");
    return;
  }
  const store = new McpAuthStore(runtime.paths.home);
  const lines: string[] = [];
  for (const config of selected) {
    if (config.transport !== "http") {
      lines.push(`${config.name}: stdio (no OAuth)`);
      continue;
    }
    if (mcpUsesAuthorizationHeader(config)) {
      lines.push(`${config.name}: Authorization header`);
      continue;
    }
    if (action === "logout") {
      const removed = await store.remove(config.name, config.url);
      lines.push(
        `${config.name}: ${removed ? "signed out" : "no stored credentials"}`,
      );
      continue;
    }
    const status = await store.status(config.name, config.url);
    lines.push(
      `${config.name}: ${status.signed_in ? "signed in" : "signed out"}${
        status.expires_at === null ? "" : ` · expires ${status.expires_at}`
      }`,
    );
  }
  await notify(context, lines.join("\n"));
}

async function mcpLogin(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  parts: string[],
): Promise<void> {
  const controller = new AbortController();
  try {
    const configs = await readMcpConfig(runtime.paths);
    let requested = parts[1];
    if (requested === undefined) {
      const candidates = configs.filter(
        (config) =>
          config.transport === "http" && !mcpUsesAuthorizationHeader(config),
      );
      if (candidates.length > 1) {
        const selected = await context.ui.select(
          "MCP server to sign in",
          candidates.map((config) => config.name),
        );
        if (selected === undefined) {
          return;
        }
        requested = selected;
      }
    }
    const target = resolveMcpLoginTarget(configs, requested);
    const store = new McpAuthStore(runtime.paths.home);
    await notify(context, `Starting MCP sign-in for ${target.name}...`);
    const result = await loginMcpServer({
      server: target.name,
      serverUrl: target.url,
      store,
      settings: oauthSettings(target.oauth, target.name),
      signal: controller.signal,
      onAuthorizationUrl: (url) => {
        context.ui.notify(
          [
            `MCP server ${target.name} requires authorization.`,
            "Open this URL in a browser:",
            url.href,
            "Then paste the full redirect URL when prompted.",
          ].join("\n"),
          "info",
        );
      },
      promptForRedirectUrl: async () => {
        const value = await context.ui.input(
          "MCP redirect URL",
          "Paste the full redirect URL, or leave empty to cancel",
        );
        const trimmed = value?.trim() ?? "";
        if (trimmed.length === 0) {
          controller.abort();
        }
        return trimmed.length === 0 ? undefined : trimmed;
      },
    });
    const status = await store.status(target.name, target.url);
    await notify(
      context,
      [
        result.already_authorized
          ? `MCP server ${target.name} already had usable credentials`
          : `signed in to MCP server ${target.name}`,
        `signed in: ${status.signed_in ? "yes" : "no"}`,
        `expires: ${status.expires_at ?? "not reported"}`,
        `scope: ${status.scope ?? "not reported"}`,
        "run /reload to start this server",
      ].join("\n"),
    );
  } catch (error) {
    context.ui.notify(
      controller.signal.aborted
        ? "MCP sign-in cancelled"
        : `MCP sign-in failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
      "error",
    );
  }
}

export function mcpCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "mcp",
    description: "List, sign in to, or inspect user MCP servers",
    handler: commandContext(state, async (runtime, context, args) => {
      const parts = args
        .trim()
        .split(/\s+/u)
        .filter((part) => part.length > 0);
      const action = parts[0] ?? "list";
      if (action === "list") {
        const snapshot = await collectCapabilities(runtime.paths, {
          pluginEnabled: runtime.plugins.enabled,
          skills: runtime.skills,
          ...(runtime.plugins.paths.length > 0
            ? { pluginFiles: runtime.plugins.paths }
            : {}),
        });
        await notify(
          context,
          [
            ...formatMcpServers(snapshot.mcp),
            "",
            "usage: /mcp [list|add [name]|remove [name]|login [name]|status [name]|logout [name]]",
            "check:  codepunk mcp test [name]",
            "run /reload after changing MCP configuration",
          ].join("\n"),
        );
        return;
      }
      if (action === "add") {
        const result = await addMcpServerInteractive(
          runtime,
          context,
          parts[1],
        );
        if (result !== null) {
          (state.context ?? context).ui.notify(result.message, result.level);
        }
        return;
      }
      if (action === "remove") {
        const result = await removeMcpServerInteractive(
          runtime,
          context,
          parts[1],
        );
        if (result !== null) {
          (state.context ?? context).ui.notify(result.message, result.level);
        }
        return;
      }
      if (action === "status" || action === "logout") {
        await mcpStatusOrLogout(runtime, context, action, parts);
        return;
      }
      if (action === "login") {
        await mcpLogin(runtime, context, parts);
        return;
      }
      context.ui.notify(
        "usage: /mcp [list|add [name]|remove [name]|login [name]|status [name]|logout [name]]",
        "warning",
      );
    }),
  });
}
