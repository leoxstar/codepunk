import {
  normalizeNetworkAllow,
  normalizeNetworkDeny,
  writeUserPermissionSelection,
  type CodepunkRuntime,
} from "codepunk-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function formatNetworkList(runtime: CodepunkRuntime): string {
  return [
    `network allow: ${
      runtime.config.sandbox.network_allow.length === 0
        ? "none (deny by default)"
        : runtime.config.sandbox.network_allow.join(", ")
    }`,
    `network deny: ${
      runtime.config.sandbox.network_deny.length === 0
        ? "none"
        : runtime.config.sandbox.network_deny.join(", ")
    }`,
  ].join("\n");
}

async function handleSandboxNetworkClear(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
  which: string | undefined,
): Promise<void> {
  if (which !== undefined && which !== "allow" && which !== "deny") {
    context.ui.notify(
      "usage: /permissions sandbox network clear [allow|deny]",
      "warning",
    );
    return;
  }
  try {
    await writeUserPermissionSelection(runtime.paths, {
      ...(which === undefined || which === "allow" ? { networkAllow: [] } : {}),
      ...(which === undefined || which === "deny" ? { networkDeny: [] } : {}),
    });
  } catch (error) {
    context.ui.notify(
      `network lists were not saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
    return;
  }
  if (which === undefined || which === "allow") {
    runtime.config.sandbox.network_allow = [];
  }
  if (which === undefined || which === "deny") {
    runtime.config.sandbox.network_deny = [];
  }
  context.ui.notify(
    `${formatNetworkList(runtime)}\napplies to the next session`,
    "info",
  );
}

export async function handleSandboxNetwork(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
  rest: string[],
): Promise<void> {
  const formatNetwork = (): string => formatNetworkList(runtime);
  if (rest.length === 0 || (rest.length === 1 && rest[0] === "show")) {
    context.ui.notify(formatNetwork(), "info");
    return;
  }
  if (rest[0] === "clear") {
    await handleSandboxNetworkClear(runtime, context, rest[1]);
    return;
  }
  const list = rest[0] === "allow" || rest[0] === "deny" ? rest[0] : "allow";
  const requested =
    rest[0] === "allow" || rest[0] === "deny" ? rest.slice(1) : rest;
  if (requested.length === 0) {
    context.ui.notify(
      `usage: /permissions sandbox network ${list} <domain>...`,
      "warning",
    );
    return;
  }
  let normalized: string[];
  try {
    normalized =
      list === "allow"
        ? normalizeNetworkAllow(requested)
        : normalizeNetworkDeny(requested);
  } catch (error) {
    context.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
    return;
  }
  const other =
    list === "allow"
      ? runtime.config.sandbox.network_deny
      : runtime.config.sandbox.network_allow;
  const overlap = normalized.filter((entry) => other.includes(entry));
  if (overlap.length > 0) {
    context.ui.notify(
      `sandbox.network_deny also lists ${overlap.join(", ")}; clear the other list first`,
      "error",
    );
    return;
  }
  try {
    await writeUserPermissionSelection(
      runtime.paths,
      list === "allow"
        ? { networkAllow: normalized }
        : { networkDeny: normalized },
    );
  } catch (error) {
    context.ui.notify(
      `network list was not saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
    return;
  }
  if (list === "allow") {
    runtime.config.sandbox.network_allow = normalized;
  } else {
    runtime.config.sandbox.network_deny = normalized;
  }
  context.ui.notify(
    `${formatNetwork()}\napplies to the next session; each network command still needs its own approval`,
    "info",
  );
}
