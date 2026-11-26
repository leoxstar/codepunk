import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type AgentSession,
  type AgentSessionServices,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { AGENT_STATE_SCHEMA_VERSION, type AgentState } from "codepunk-protocol";
import { FormatVersionError, checkFormatVersion } from "../../compat/index.ts";
import { normalizeAbsolute } from "../../platform/path.ts";
import type { ShellProvider } from "../../sandbox/index.ts";
import type { ToolWrapOptions } from "../../wrap/index.ts";
import {
  HostIsolationError,
  type ExtensionPathLoader,
  type RestoredPiEntries,
  type ToolRegistrySnapshot,
} from "./types.ts";

export function resolveSandbox(
  sandbox: ToolWrapOptions["sandbox"],
): ShellProvider | null {
  return typeof sandbox === "function" ? sandbox() : (sandbox ?? null);
}

export function additionalExtensionPaths(resourceLoader: unknown): string[] {
  // SAFETY: Pi's public ResourceLoader interface does not expose this private
  // array, but pinned 1.6.0 initializes it from DefaultResourceLoaderOptions
  // and retains the same array reference for session.reload().
  if (typeof resourceLoader !== "object" || resourceLoader === null) {
    throw new HostIsolationError("Pi resource loader is not available");
  }
  const loader = resourceLoader as Partial<ExtensionPathLoader>;
  const paths = loader.additionalExtensionPaths;
  if (!Array.isArray(paths)) {
    throw new HostIsolationError(
      "pinned Pi resource loader no longer exposes additionalExtensionPaths",
    );
  }
  return paths;
}

function extensionListFor(
  services: AgentSessionServices,
): readonly { path: string }[] {
  return services.resourceLoader.getExtensions().extensions;
}

export function assertWrappedToolRegistry(
  session: AgentSession,
  wrapped: readonly ToolDefinition<any, any, any>[],
): ToolRegistrySnapshot {
  const wrappedByName = new Map(
    wrapped.map((definition) => [definition.name, definition]),
  );
  const active = session.getActiveToolNames();
  const registered = new Set<string>();
  for (const tool of session.getAllTools()) {
    registered.add(tool.name);
  }
  for (const tool of session.extensionRunner.getAllRegisteredTools()) {
    registered.add(tool.definition.name);
  }
  for (const name of session.getCallableToolNames()) {
    registered.add(name);
  }
  const issues: string[] = [];
  for (const name of active) {
    if (!wrappedByName.has(name)) {
      issues.push(`active tool "${name}" is not wrapped`);
      continue;
    }
    if (session.getToolDefinition(name) !== wrappedByName.get(name)) {
      issues.push(`active tool "${name}" is not the wrapped definition`);
    }
  }
  for (const name of registered) {
    if (!wrappedByName.has(name)) {
      issues.push(`registered tool "${name}" is not wrapped`);
    }
  }
  if (issues.length > 0) {
    throw new HostIsolationError(issues.join("; "));
  }
  return {
    active: [...active],
    registered: [...registered].sort(),
    wrapped: wrapped.map((definition) => definition.name).sort(),
  };
}

export function assertHostResources(
  services: AgentSessionServices,
  allowedExtensionPaths: readonly string[] = [],
): void {
  const extensions = extensionListFor(services);
  const productExtensionPath = "<inline:codepunk-product>";
  const productExtensionPaths = new Set([
    productExtensionPath,
    "<inline:codepunk-tui>",
  ]);
  const productExtensions = extensions.filter(
    (extension) => extension.path === productExtensionPath,
  );
  if (productExtensions.length !== 1) {
    throw new HostIsolationError(
      `unexpected product extension set: ${extensions
        .map((extension) => extension.path)
        .join(", ")}`,
    );
  }
  const allowed = new Set(
    allowedExtensionPaths.map((candidate) => normalizeAbsolute(candidate)),
  );
  const unexpected = extensions.filter(
    (extension) =>
      !productExtensionPaths.has(extension.path) &&
      !allowed.has(normalizeAbsolute(extension.path)),
  );
  if (unexpected.length > 0) {
    throw new HostIsolationError(
      `unexpected extension set: ${unexpected
        .map((extension) => extension.path)
        .join(", ")}`,
    );
  }
  if (services.resourceLoader.getSkills().skills.length > 0) {
    throw new HostIsolationError("skills were loaded despite isolation");
  }
  if (services.resourceLoader.getPrompts().prompts.length > 0) {
    throw new HostIsolationError(
      "prompt templates were loaded despite isolation",
    );
  }
  if (services.resourceLoader.getThemes().themes.length > 0) {
    throw new HostIsolationError("themes were loaded despite isolation");
  }
  if (services.resourceLoader.getAgentsFiles().agentsFiles.length > 0) {
    throw new HostIsolationError("context files were loaded despite isolation");
  }
  if (services.resourceLoader.getSystemPromptSource() !== undefined) {
    throw new HostIsolationError("SYSTEM.md was loaded despite isolation");
  }
  if (services.resourceLoader.getAppendSystemPromptSources().length > 0) {
    throw new HostIsolationError(
      "APPEND_SYSTEM.md was loaded despite isolation",
    );
  }
}

function sessionEntryId(entry: unknown): string | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const id = (entry as Record<string, unknown>)["id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function restoreEntries(
  state: AgentState,
  cwd: string,
): RestoredPiEntries {
  // Spec 0016 C1: compatibility is decided by format versions, not by the
  // pinned Pi package version. `pi_version` stays written for diagnostics.
  try {
    checkFormatVersion(
      "agent-state",
      "version",
      state.version,
      AGENT_STATE_SCHEMA_VERSION,
    );
    checkFormatVersion(
      "agent-state",
      "session_version",
      state.session_version,
      CURRENT_SESSION_VERSION,
    );
  } catch (error) {
    if (error instanceof FormatVersionError) {
      throw new HostIsolationError(error.message);
    }
    throw error;
  }
  const header = state.header;
  if (header === null || typeof header !== "object" || Array.isArray(header)) {
    throw new HostIsolationError("agent-state header is missing");
  }
  const record = header as Record<string, unknown>;
  if (record["type"] !== "session") {
    throw new HostIsolationError(
      "agent-state header is not a Pi session header",
    );
  }
  const headerId = record["id"];
  if (typeof headerId !== "string" || headerId.length === 0) {
    throw new HostIsolationError("agent-state header has no session id");
  }
  let restoredHeader = header;
  let migratedHeaderId = false;
  if (headerId !== state.session_id) {
    // Older Codepunk releases let Pi generate its own UUID header id. Only
    // that known shape is migrated; arbitrary mismatches still fail closed.
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        headerId,
      )
    ) {
      throw new HostIsolationError(
        "agent-state header id does not match the Codepunk session",
      );
    }
    restoredHeader = { ...record, id: state.session_id };
    migratedHeaderId = true;
  }
  if (record["cwd"] !== cwd) {
    throw new HostIsolationError(
      "agent-state header belongs to a different workspace",
    );
  }
  if ((state.entries === undefined) !== (state.leaf_id === undefined)) {
    throw new HostIsolationError(
      "agent-state entry tree and leaf must be saved together",
    );
  }
  const entries = state.entries ?? state.branch;
  return {
    entries: [restoredHeader, ...entries],
    activeBranch: state.branch,
    ...(state.leaf_id === undefined ? {} : { leafId: state.leaf_id }),
    migratedHeaderId,
  };
}

export function restoreSessionLeaf(
  sessionManager: SessionManager,
  restored: RestoredPiEntries,
): void {
  if (restored.leafId !== undefined) {
    if (restored.leafId === null) {
      sessionManager.resetLeaf();
    } else {
      if (sessionManager.getEntry(restored.leafId) === undefined) {
        throw new HostIsolationError(
          "agent-state leaf is not present in the saved entry tree",
        );
      }
      sessionManager.branch(restored.leafId);
    }
  }
  const actual = sessionManager.getBranch().map(sessionEntryId);
  const expected = restored.activeBranch.map(sessionEntryId);
  if (
    actual.length !== expected.length ||
    actual.some((id) => id === null) ||
    expected.some((id) => id === null) ||
    actual.some((id, index) => id !== expected[index])
  ) {
    throw new HostIsolationError(
      "agent-state active branch does not match the saved tree and leaf",
    );
  }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function assertNoForbiddenPiState(
  cwd: string,
  deliveryRoot: string,
  codepunkHome: string,
): Promise<void> {
  const forbidden = [
    path.join(codepunkHome, "mcp.json"),
    path.join(deliveryRoot, ".pi", "mcp.json"),
    path.join(cwd, ".pi", "mcp.json"),
  ];
  for (const candidate of new Set(forbidden.map(normalizeAbsolute))) {
    if (await exists(candidate)) {
      throw new HostIsolationError(
        `Pi MCP configuration is forbidden: ${candidate}`,
      );
    }
  }
}

export async function assertNoPiSessionFiles(
  codepunkHome: string,
): Promise<void> {
  const sessionsDir = path.join(codepunkHome, "sessions");
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const sessionFiles = entries.filter((entry) => entry.endsWith(".jsonl"));
  if (sessionFiles.length > 0) {
    throw new HostIsolationError(
      `Pi session files are forbidden: ${sessionFiles.join(", ")}`,
    );
  }
}

export async function setHostEnvironment(
  codepunkHome: string,
): Promise<() => void> {
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const previousSessionDir = process.env["PI_CODING_AGENT_SESSION_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = codepunkHome;
  process.env["PI_CODING_AGENT_SESSION_DIR"] = path.join(
    codepunkHome,
    "sessions",
  );
  return () => {
    if (previousAgentDir === undefined) {
      delete process.env["PI_CODING_AGENT_DIR"];
    } else {
      process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    }
    if (previousSessionDir === undefined) {
      delete process.env["PI_CODING_AGENT_SESSION_DIR"];
    } else {
      process.env["PI_CODING_AGENT_SESSION_DIR"] = previousSessionDir;
    }
  };
}
