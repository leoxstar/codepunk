import { parseArgs } from "node:util";
import { DAEMON_SCOPES, type DaemonScope } from "codepunk-protocol";
import {
  APPROVAL_MODE_NAMES,
  ConfigError,
  PERMISSION_PROFILE_NAMES,
  WORKSPACE_TRUST_RESOURCE_KINDS,
  isPermissionProfile,
  type FilesystemMode,
  type PermissionProfile,
  type WorkspaceTrustResourceKind,
} from "codepunk-core";
import type { CliOptions } from "./options.ts";
import { parseTrustConflicts, parseTrustFlags } from "./parse-trust.ts";

type ParsedValues = ReturnType<typeof parseArguments>["values"];

function normalizeWorktreeArgv(argv: string[]): string[] {
  const out: string[] = [];
  let afterTerminator = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!afterTerminator && token === "--") {
      afterTerminator = true;
      out.push(token);
      continue;
    }
    if (!afterTerminator && (token === "--worktree" || token === "-w")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        out.push("--worktree=auto");
        continue;
      }
    }
    out.push(token);
  }
  return out;
}

function parseArguments(argv: string[]) {
  return parseArgs({
    args: normalizeWorktreeArgv(argv),
    allowPositionals: true,
    strict: true,
    options: {
      print: { type: "boolean", short: "p" },
      mode: { type: "string" },
      "json-schema": { type: "string" },
      continue: { type: "boolean" },
      session: { type: "string" },
      fork: { type: "string" },
      "new-session-id": { type: "string" },
      "parent-session-id": { type: "string" },
      "new-session": { type: "boolean" },
      worktree: { type: "string", short: "w" },
      model: { type: "string" },
      provider: { type: "string" },
      thinking: { type: "string" },
      tools: { type: "string" },
      "model-fallback": { type: "string" },
      "fallback-allow-cross-provider": { type: "boolean" },
      "append-system-prompt": { type: "string" },
      "permission-mode": { type: "string" },
      approval: { type: "string" },
      "approval-reviewer": { type: "string" },
      "reviewer-model": { type: "string" },
      "reviewer-timeout-ms": { type: "string" },
      autonomy: { type: "string" },
      "scoped-rules": { type: "string" },
      "allow-unsandboxed-shell": { type: "boolean" },
      "dangerously-bypass-approvals-and-sandbox": { type: "boolean" },
      sandbox: { type: "string" },
      filesystem: { type: "string" },
      "network-allow": { type: "string" },
      "network-deny": { type: "string" },
      trust: { type: "boolean" },
      "no-trust": { type: "boolean" },
      "trust-resources": { type: "string" },
      resources: { type: "string" },
      memory: { type: "string" },
      "allow-plugins": { type: "boolean" },
      bare: { type: "boolean" },
      "no-skills": { type: "boolean" },
      "no-plugins": { type: "boolean" },
      "no-mcp": { type: "boolean" },
      "headless-policy": { type: "string" },
      apply: { type: "boolean" },
      check: { type: "boolean" },
      unpin: { type: "boolean" },
      "all-projects": { type: "boolean" },
      "include-archived": { type: "boolean" },
      confirm: { type: "boolean" },
      verdict: { type: "string" },
      actor: { type: "string" },
      output: { type: "string" },
      scope: { type: "string" },
      prefix: { type: "string" },
      "package-version": { type: "string" },
      "base-url": { type: "string" },
      api: { type: "string" },
      "api-key": { type: "string" },
      "auth-header": { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      socket: { type: "string" },
      scopes: { type: "string" },
      limit: { type: "string" },
      env: { type: "string", multiple: true },
      url: { type: "string" },
      header: { type: "string", multiple: true },
      cwd: { type: "string" },
      "add-dir": { type: "string", multiple: true },
      force: { type: "boolean" },
      "guarded-host-launch": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

function parseModeFlags(values: ParsedValues): {
  mode: "text" | "json";
  approval: "ask" | "deny" | "auto" | "allow" | undefined;
  reviewer: "off" | "model" | undefined;
  reviewerModel: string | undefined;
  reviewerTimeoutMs: number | undefined;
} {
  const mode = values.mode ?? "text";
  if (mode !== "text" && mode !== "json") {
    throw new Error("--mode must be text or json");
  }
  const approval = values.approval as
    (typeof APPROVAL_MODE_NAMES)[number] | undefined;
  if (
    approval !== undefined &&
    !(APPROVAL_MODE_NAMES as readonly string[]).includes(approval)
  ) {
    throw new Error(`--approval must be ${APPROVAL_MODE_NAMES.join(", ")}`);
  }
  const reviewer = values["approval-reviewer"];
  if (reviewer !== undefined && reviewer !== "off" && reviewer !== "model") {
    throw new Error("--approval-reviewer must be off or model");
  }
  const reviewerModel = values["reviewer-model"];
  if (
    reviewerModel !== undefined &&
    (!reviewerModel.includes("/") || /\s/u.test(reviewerModel))
  ) {
    throw new Error("--reviewer-model must use provider/model");
  }
  const reviewerTimeoutMs =
    values["reviewer-timeout-ms"] === undefined
      ? undefined
      : Number(values["reviewer-timeout-ms"]);
  if (
    reviewerTimeoutMs !== undefined &&
    (!Number.isSafeInteger(reviewerTimeoutMs) || reviewerTimeoutMs < 1_000)
  ) {
    throw new Error(
      "--reviewer-timeout-ms must be an integer of at least 1000",
    );
  }
  return { mode, approval, reviewer, reviewerModel, reviewerTimeoutMs };
}

function parseNetworkFlags(values: ParsedValues): {
  filesystem: FilesystemMode | undefined;
  networkAllow: string[] | undefined;
  networkDeny: string[] | undefined;
  autonomy: "read-only" | "ask" | "scoped" | undefined;
} {
  const filesystem = values.filesystem;
  if (
    filesystem !== undefined &&
    filesystem !== "workspace" &&
    filesystem !== "full"
  ) {
    throw new Error("--filesystem must be workspace or full");
  }
  const domainList = (
    value: string | undefined,
    flag: string,
  ): string[] | undefined => {
    if (value === undefined) {
      return undefined;
    }
    const entries = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (value.trim().length > 0 && entries.length === 0) {
      throw new Error(`${flag} needs at least one domain`);
    }
    return entries;
  };
  const networkAllow = domainList(values["network-allow"], "--network-allow");
  const networkDeny = domainList(values["network-deny"], "--network-deny");
  const autonomy = values.autonomy;
  if (
    autonomy !== undefined &&
    autonomy !== "read-only" &&
    autonomy !== "ask" &&
    autonomy !== "scoped"
  ) {
    throw new Error("--autonomy must be read-only, ask, or scoped");
  }
  if (values["scoped-rules"] !== undefined && autonomy !== "scoped") {
    throw new Error("--scoped-rules requires --autonomy scoped");
  }
  if (autonomy === "scoped" && values["scoped-rules"] === undefined) {
    throw new Error("--autonomy scoped requires --scoped-rules <path>");
  }
  return { filesystem, networkAllow, networkDeny, autonomy };
}

function parseSessionSelectionFlags(values: ParsedValues): {
  sandbox: "required" | "uncovered" | undefined;
} {
  const sandbox = values.sandbox;
  if (
    values.fork !== undefined &&
    (values.session !== undefined ||
      values.continue === true ||
      values["new-session"] === true ||
      values["new-session-id"] !== undefined)
  ) {
    throw new Error(
      "--fork cannot be combined with --session, --continue, --new-session, or --new-session-id",
    );
  }
  if (
    values["parent-session-id"] !== undefined &&
    values["new-session"] !== true &&
    values["new-session-id"] === undefined
  ) {
    throw new Error(
      "--parent-session-id requires --new-session or --new-session-id",
    );
  }
  if (
    values["parent-session-id"] !== undefined &&
    (values.session !== undefined ||
      values.continue === true ||
      values.fork !== undefined)
  ) {
    throw new Error(
      "--parent-session-id cannot be combined with --session, --continue, or --fork",
    );
  }
  if (
    sandbox !== undefined &&
    sandbox !== "required" &&
    sandbox !== "uncovered"
  ) {
    throw new Error("--sandbox must be required or uncovered");
  }
  if (
    values.worktree !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(values.worktree)
  ) {
    throw new ConfigError(
      "--worktree name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
    );
  }
  return { sandbox };
}

function parsePermissionFlags(
  values: ParsedValues,
  positionals: readonly string[],
  prior: {
    approval: ReturnType<typeof parseModeFlags>["approval"];
    autonomy: string | undefined;
    sandbox: ReturnType<typeof parseSessionSelectionFlags>["sandbox"];
    filesystem: FilesystemMode | undefined;
  },
): {
  permissionMode: PermissionProfile | undefined;
  dangerouslyBypass: boolean;
} {
  const { approval, autonomy, sandbox, filesystem } = prior;
  const permissionModeValue = values["permission-mode"];
  if (
    permissionModeValue !== undefined &&
    !isPermissionProfile(permissionModeValue)
  ) {
    throw new Error(
      `--permission-mode must be ${PERMISSION_PROFILE_NAMES.join(", ")}`,
    );
  }
  const permissionMode = permissionModeValue as PermissionProfile | undefined;
  if (
    permissionMode !== undefined &&
    (approval !== undefined ||
      autonomy !== undefined ||
      sandbox !== undefined ||
      filesystem !== undefined ||
      values["scoped-rules"] !== undefined)
  ) {
    throw new Error(
      "--permission-mode cannot be combined with --approval, --autonomy, --sandbox, --filesystem, or --scoped-rules",
    );
  }
  const dangerouslyBypass =
    values["dangerously-bypass-approvals-and-sandbox"] === true;
  if (
    dangerouslyBypass &&
    permissionMode !== undefined &&
    permissionMode !== "full-access"
  ) {
    throw new Error(
      "--dangerously-bypass-approvals-and-sandbox can only be combined with --permission-mode full-access",
    );
  }
  if (dangerouslyBypass && autonomy !== undefined && autonomy !== "ask") {
    throw new Error(
      "--dangerously-bypass-approvals-and-sandbox implies full-access autonomy=ask; do not combine it with --autonomy read-only or --autonomy scoped",
    );
  }
  if (dangerouslyBypass) {
    if (filesystem !== undefined && filesystem !== "full") {
      throw new Error(
        "--dangerously-bypass-approvals-and-sandbox implies --filesystem full",
      );
    }
    if (sandbox !== undefined && sandbox !== "uncovered") {
      throw new Error(
        "--dangerously-bypass-approvals-and-sandbox implies --sandbox uncovered",
      );
    }
    if (approval !== undefined && approval !== "allow") {
      throw new Error(
        "--dangerously-bypass-approvals-and-sandbox implies --approval allow",
      );
    }
  }
  const permissionIntrospection =
    (positionals[0] === "permissions" || positionals[0] === "permission") &&
    (positionals[1] === undefined ||
      positionals[1] === "show" ||
      positionals[1] === "insights" ||
      positionals[1] === "why");
  if (
    permissionMode === "full-access" &&
    !dangerouslyBypass &&
    !permissionIntrospection
  ) {
    throw new Error(
      "--permission-mode full-access requires --dangerously-bypass-approvals-and-sandbox and is interactive only",
    );
  }
  return { permissionMode, dangerouslyBypass };
}

function parseToolFlags(values: ParsedValues) {
  const tools =
    values.tools === undefined
      ? undefined
      : values.tools
          .split(",")
          .map((tool) => tool.trim())
          .filter((tool) => tool.length > 0);
  if (tools !== undefined && tools.length === 0) {
    throw new Error("--tools must contain at least one tool name");
  }
  const modelFallback =
    values["model-fallback"] === undefined
      ? undefined
      : values["model-fallback"]
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
  if (modelFallback !== undefined && modelFallback.length === 0) {
    throw new Error(
      "--model-fallback must contain at least one provider/model",
    );
  }
  return { tools, modelFallback };
}

function parseMemoryFlags(values: ParsedValues) {
  let memory: boolean | undefined;
  if (values.memory !== undefined) {
    if (values.memory !== "true" && values.memory !== "false") {
      throw new Error("--memory must be true or false");
    }
    memory = values.memory === "true";
  }
  const bare = values.bare === true;
  const noSkills = bare || values["no-skills"] === true;
  const noPlugins = bare || values["no-plugins"] === true;
  if (bare && memory === true) {
    throw new Error("--bare cannot be combined with --memory true");
  }
  if ((bare || noPlugins) && values["allow-plugins"] === true) {
    throw new Error(
      "--allow-plugins cannot be combined with --bare or --no-plugins",
    );
  }
  return { memory, bare, noSkills, noPlugins };
}

function parseMiscFlags(values: ParsedValues): {
  scope: "user" | "project" | undefined;
  limit: number | undefined;
  scopes: string[] | undefined;
  verdict: "complete" | "incomplete" | undefined;
} {
  const scope = values.scope;
  if (scope !== undefined && scope !== "user" && scope !== "project") {
    throw new Error("--scope must be user or project");
  }
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
  ) {
    throw new Error("--limit must be an integer from 1 to 100");
  }
  const scopes =
    values.scopes === undefined
      ? undefined
      : [
          ...new Set(
            values.scopes
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
          ),
        ];
  if (scopes !== undefined) {
    if (scopes.length === 0) {
      throw new Error("--scopes must contain at least one daemon scope");
    }
    for (const scope of scopes) {
      if (!(DAEMON_SCOPES as readonly string[]).includes(scope)) {
        throw new Error(
          `--scopes has unknown scope ${scope}; use ${DAEMON_SCOPES.join(",")}`,
        );
      }
    }
  }
  const verdict = values.verdict;
  if (
    verdict !== undefined &&
    verdict !== "complete" &&
    verdict !== "incomplete"
  ) {
    throw new Error("--verdict must be complete or incomplete");
  }
  return { scope, limit, scopes, verdict };
}

export function parseCli(argv: string[]): CliOptions {
  const parsed = parseArguments(argv);
  const values = parsed.values;
  const modeFlags = parseModeFlags(values);
  const network = parseNetworkFlags(values);
  const selection = parseSessionSelectionFlags(values);
  const permission = parsePermissionFlags(values, parsed.positionals, {
    approval: modeFlags.approval,
    autonomy: network.autonomy,
    sandbox: selection.sandbox,
    filesystem: network.filesystem,
  });
  parseTrustConflicts(values);
  const toolFlags = parseToolFlags(values);
  const trustFlags = parseTrustFlags(values);
  const memoryFlags = parseMemoryFlags(values);
  const misc = parseMiscFlags(values);
  return {
    print: values.print === true,
    mode: modeFlags.mode,
    jsonSchema: values["json-schema"],
    continueSession: values.continue === true,
    session: values.session,
    fork: values.fork,
    newSessionId: values["new-session-id"],
    parentSessionId: values["parent-session-id"],
    newSession: values["new-session"] === true,
    worktree: values.worktree,
    model: values.model,
    provider: values.provider,
    thinking: values.thinking,
    tools: toolFlags.tools,
    modelFallback: toolFlags.modelFallback,
    fallbackAllowCrossProvider:
      values["fallback-allow-cross-provider"] === true,
    appendSystemPrompt: values["append-system-prompt"],
    permissionMode: permission.permissionMode,
    approval: modeFlags.approval,
    reviewer: modeFlags.reviewer,
    reviewerModel: modeFlags.reviewerModel,
    reviewerTimeoutMs: modeFlags.reviewerTimeoutMs,
    autonomy: network.autonomy,
    scopedRules: values["scoped-rules"],
    allowUnsandboxedShell: values["allow-unsandboxed-shell"] === true,
    dangerouslyBypass: permission.dangerouslyBypass,
    sandbox: selection.sandbox,
    filesystem: network.filesystem,
    networkAllow: network.networkAllow,
    networkDeny: network.networkDeny,
    trust: trustFlags.trust,
    trustResources: trustFlags.trustResources?.filter(
      (kind): kind is WorkspaceTrustResourceKind =>
        (WORKSPACE_TRUST_RESOURCE_KINDS as readonly string[]).includes(kind),
    ),
    resources: trustFlags.resources?.filter(
      (kind): kind is WorkspaceTrustResourceKind =>
        (WORKSPACE_TRUST_RESOURCE_KINDS as readonly string[]).includes(kind),
    ),
    memory: memoryFlags.memory,
    allowPlugins: values["allow-plugins"] === true,
    noMcp: memoryFlags.bare || values["no-mcp"] === true,
    noSkills: memoryFlags.noSkills,
    noPlugins: memoryFlags.noPlugins,
    bare: memoryFlags.bare,
    headlessPolicy: values["headless-policy"],
    apply: values.apply === true,
    check: values.check === true,
    unpin: values.unpin === true,
    allProjects: values["all-projects"] === true,
    includeArchived: values["include-archived"] === true,
    confirm: values.confirm === true,
    verdict: misc.verdict,
    actor: values.actor,
    output: values.output,
    scope: misc.scope,
    prefix: values.prefix,
    packageVersion: values["package-version"],
    baseUrl: values["base-url"],
    api: values.api,
    apiKey: values["api-key"],
    authHeader: values["auth-header"] === true,
    dryRun: values["dry-run"] === true,
    json: values.json === true,
    socket: values.socket,
    scopes: misc.scopes as DaemonScope[] | undefined,
    limit: misc.limit,
    env: values.env ?? [],
    url: values.url,
    headers: values.header ?? [],
    cwd: values.cwd,
    additionalDirs: values["add-dir"] ?? [],
    force: values.force === true,
    guardedHostLaunch: values["guarded-host-launch"] === true,
    help: values.help === true,
    version: values.version === true,
    positionals: parsed.positionals,
  };
}
