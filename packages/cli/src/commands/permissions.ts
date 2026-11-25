import path from "node:path";
import {
  APPROVAL_MODE_NAMES,
  AutonomyController,
  ConfigError,
  PERMISSION_PROFILES,
  PERMISSION_PROFILE_NAMES,
  SrtSandbox,
  configSummary,
  decidePolicy,
  explainPermission,
  filesystemFullStartupIssue,
  formatPermissionExplanation,
  isPermissionProfile,
  loadPolicyFiles,
  loadScopedRules,
  normalizeNetworkAllow,
  normalizeNetworkDeny,
  permissionBehaviorSummary,
  permissionProfileFor,
  probeSrtSandbox,
  shellUnavailableReason,
  writeUserPermissionProfile,
  writeUserPermissionSelection,
  type CodepunkConfig,
  type FilesystemMode,
  type PermissionConfigUpdate,
  type PermissionExecution,
  type PermissionProfile,
  type ScopedRule,
  type WorkspaceTrust,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { resolveProject } from "../run/project.ts";

type ProjectPaths = Awaited<ReturnType<typeof resolveProject>>["paths"];

function formatPermissions(
  config: CodepunkConfig,
  configPath: string,
  workspaceTrust: WorkspaceTrust,
  additionalRoots: readonly string[] = [],
): string {
  const profile = permissionProfileFor(config);
  const trustWord =
    workspaceTrust.mode === "all"
      ? "trusted"
      : workspaceTrust.mode === "none"
        ? "untrusted"
        : "custom";
  return [
    `profile: ${profile}`,
    `trust: ${trustWord} (${workspaceTrust.source})`,
    ...(workspaceTrust.available.length === 0
      ? []
      : [
          `trust resources: ${workspaceTrust.available
            .map(
              (kind) =>
                `${kind}=${
                  workspaceTrust.grants[kind] ? "allowed" : "skipped"
                }`,
            )
            .join(", ")}`,
        ]),
    `approvals: ${config.approval.mode}`,
    `approval reviewer: ${config.approval.reviewer}${
      config.approval.reviewer === "off"
        ? ""
        : ` (${config.approval.reviewer_model ?? "session model"}, ${config.approval.reviewer_timeout_ms} ms)`
    }`,
    `autonomy: ${config.autonomy.profile}`,
    `behavior: ${permissionBehaviorSummary(config)}`,
    `sandbox: ${config.sandbox.mode}`,
    `network allow: ${
      config.sandbox.network_allow.length === 0
        ? "none (deny by default)"
        : config.sandbox.network_allow.join(", ")
    }`,
    ...(config.sandbox.network_deny.length === 0
      ? []
      : [`network deny: ${config.sandbox.network_deny.join(", ")}`]),
    `filesystem: ${config.filesystem.mode}`,
    ...(additionalRoots.length === 0
      ? []
      : [`extra file roots: ${additionalRoots.join(", ")}`]),
    ...(config.filesystem.mode === "full"
      ? [
          "startup: blocked until --dangerously-bypass-approvals-and-sandbox is supplied; this view is not the current execution state",
        ]
      : []),
    config.sandbox.mode === "required"
      ? "shell: srt when available; run codepunk doctor if unavailable"
      : "shell: disabled unless started with --allow-unsandboxed-shell; uncovered executions are recorded",
    "safe reads: date, identity, and workspace inspection need no approval",
    `config: ${configPath}`,
    `trust store: ${workspaceTrust.storePath}`,
    "",
    "usage:",
    `  codepunk permissions profile ${PERMISSION_PROFILE_NAMES.join("|")}`,
    `  codepunk permissions approval ${APPROVAL_MODE_NAMES.join("|")}`,
    "  codepunk permissions reviewer show|off|model [provider/model]|timeout <ms>",
    "  codepunk permissions autonomy read-only|ask|scoped",
    "  codepunk permissions sandbox required|uncovered",
    "  codepunk permissions sandbox network [allow|deny <domain>...|clear]",
    "  codepunk permissions filesystem workspace|full",
    "  codepunk permissions rules",
    "  codepunk permissions why -- <shell command>",
    "  codepunk trust [status|grant|revoke] [path] [--resources <kinds>]",
  ].join("\n");
}

async function permissionExecutionForWhy(
  options: CliOptions,
  paths: ProjectPaths,
  config: CodepunkConfig,
  writeSet: readonly string[],
  additionalRoots: readonly string[],
): Promise<PermissionExecution> {
  const filesystemIssue = filesystemFullStartupIssue(
    config.filesystem.mode,
    false,
  );
  if (filesystemIssue !== null) {
    return {
      status: "blocked",
      reason: filesystemIssue,
    };
  }
  if (config.sandbox.mode === "uncovered") {
    return options.allowUnsandboxedShell
      ? { status: "available", reason: null }
      : {
          status: "blocked",
          reason: shellUnavailableReason("uncovered"),
        };
  }
  if (process.platform === "win32") {
    const issue = await probeSrtSandbox({
      cwd: paths.cwd,
      workspaceRoot: paths.deliveryRoot,
      deliveryRoot: paths.deliveryRoot,
      additionalRoots,
      codepunkHome: paths.home,
      writeSet,
    });
    return issue === null
      ? { status: "available", reason: null }
      : {
          status: "blocked",
          reason: `${shellUnavailableReason("required")} (${issue})`,
        };
  }
  try {
    const sandbox = await SrtSandbox.create({
      cwd: paths.cwd,
      workspaceRoot: paths.deliveryRoot,
      deliveryRoot: paths.deliveryRoot,
      additionalRoots,
      codepunkHome: paths.home,
      writeSet,
    });
    await sandbox.close();
    return { status: "available", reason: null };
  } catch (error) {
    return {
      status: "blocked",
      reason: `${shellUnavailableReason("required")} (${
        error instanceof Error ? error.message : String(error)
      })`,
    };
  }
}

export async function commandPermissions(options: CliOptions): Promise<number> {
  if (options.positionals.length < 2 || options.positionals[1] === "show") {
    return permissionsShow(options);
  }
  const group = options.positionals[1];
  const value = options.positionals[2];
  if (group === "rules") {
    return permissionsRules(options);
  }
  if (group === "why") {
    return permissionsWhy(options);
  }
  if (group === "reviewer") {
    return permissionsReviewer(options, value);
  }
  if (group === "profile") {
    return permissionsProfile(options, value);
  }
  if (
    group !== "approval" &&
    group !== "autonomy" &&
    group !== "sandbox" &&
    group !== "filesystem"
  ) {
    throw new Error(
      "permissions requires profile, approval, reviewer, autonomy, sandbox, filesystem, or why",
    );
  }
  if (value === undefined) {
    throw new Error(`permissions ${group} requires a value`);
  }
  if (group === "sandbox" && value === "network") {
    return permissionsNetwork(options);
  }
  return permissionsUpdate(options, group, value);
}

async function permissionsShow(options: CliOptions): Promise<number> {
  const { paths, config, workspaceTrust } = await resolveProject(options);
  const text = formatPermissions(
    config,
    path.join(paths.home, "config.toml"),
    workspaceTrust,
    paths.additionalRoots,
  );
  process.stdout.write(
    options.json
      ? `${JSON.stringify({
          summary: configSummary(config, paths.additionalRoots),
          config_path: path.join(paths.home, "config.toml"),
          workspace_trust: workspaceTrust,
          additional_roots: paths.additionalRoots,
        })}\n`
      : `${text}\n`,
  );
  return 0;
}

async function permissionsRules(options: CliOptions): Promise<number> {
  const { paths, config } = await resolveProject(options);
  if (config.autonomy.scoped_rules === null) {
    if (options.json) {
      process.stdout.write("[]\n");
      return 0;
    }
    process.stdout.write(
      'scoped rules: none; choose "Always allow this exact command" in an approval, or pass --scoped-rules <path>\n',
    );
    return 0;
  }
  const loaded = await loadScopedRules(config.autonomy.scoped_rules, paths);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(loaded.rules)}\n`);
    return 0;
  }
  process.stdout.write(
    [
      `scoped rules: ${loaded.rules.length}`,
      `file: ${loaded.path}`,
      ...loaded.rules.map(
        (rule) => `  ${rule.id}: ${rule.argv.join(" ")} (cwd ${rule.cwd})`,
      ),
    ].join("\n") + "\n",
  );
  return 0;
}

async function permissionsWhy(options: CliOptions): Promise<number> {
  const command = options.positionals.slice(2).join(" ").trim();
  if (command.length === 0) {
    throw new Error("permissions why requires a shell command");
  }
  const { paths, config, workspaceTrust } = await resolveProject(options);
  const policy = await loadPolicyFiles(paths, {
    projectTrusted: workspaceTrust.grants.policy,
  });
  const writeSet = [
    ...new Set([
      ...(policy.writeSet.length > 0 ? policy.writeSet : [paths.cwd]),
      ...paths.additionalRoots,
    ]),
  ];
  const decision = decidePolicy({
    tool: "bash",
    command,
    cwd: paths.cwd,
    workspaceRoot: paths.deliveryRoot,
    additionalRoots: paths.additionalRoots,
    deliveryRoot: paths.deliveryRoot,
    codepunkHome: paths.home,
    autonomy: config.autonomy.profile,
    filesystem: config.filesystem.mode,
    writeSet,
    userRules: policy.userRules,
    projectRules: policy.projectRules,
    layers: policy.layers,
  });
  let scopedRules: ScopedRule[] = [];
  let scopedRulesSha256: string | null = null;
  if (config.autonomy.profile === "scoped") {
    const loaded = await loadScopedRules(config.autonomy.scoped_rules!, paths);
    scopedRules = loaded.rules;
    scopedRulesSha256 = loaded.rulesSha256;
  }
  const autonomy = new AutonomyController({
    profile: config.autonomy.profile,
    source: "user-config",
    rules: scopedRules,
    rulesSha256: scopedRulesSha256,
  });
  const explanation = await explainPermission({
    policy: decision,
    autonomy,
    approvalMode: config.approval.mode,
    tool: "bash",
    command,
    cwd: paths.cwd,
    networkAllow: config.sandbox.network_allow,
    networkDeny: config.sandbox.network_deny,
    execution: await permissionExecutionForWhy(
      options,
      paths,
      config,
      writeSet,
      paths.additionalRoots,
    ),
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(explanation)}\n`);
    return 0;
  }
  process.stdout.write(`${formatPermissionExplanation(explanation)}\n`);
  return 0;
}

async function permissionsReviewer(
  options: CliOptions,
  value: string | undefined,
): Promise<number> {
  const { paths, config } = await resolveProject(options);
  const action = value ?? "show";
  const formatReviewer = (): string[] => [
    `reviewer: ${config.approval.reviewer}`,
    `reviewer model: ${config.approval.reviewer_model ?? "session model"}`,
    `reviewer timeout: ${config.approval.reviewer_timeout_ms} ms`,
    "scope: network commands and headless argv exec only; other asks stay human",
    "failure: ask a human interactively; deny when no channel is available",
    `config: ${path.join(paths.home, "config.toml")}`,
  ];
  if (action === "show") {
    process.stdout.write(`${formatReviewer().join("\n")}\n`);
    return 0;
  }
  if (action === "off") {
    await writeUserPermissionSelection(paths, { reviewer: "off" });
    process.stdout.write(
      [
        "approval reviewer disabled",
        "applies to the next session",
        `config: ${path.join(paths.home, "config.toml")}`,
      ].join("\n") + "\n",
    );
    return 0;
  }
  if (action === "timeout") {
    const timeout = Number(options.positionals[3]);
    if (
      options.positionals[3] === undefined ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1_000
    ) {
      throw new Error(
        "permissions reviewer timeout requires an integer of at least 1000 ms",
      );
    }
    await writeUserPermissionSelection(paths, {
      reviewerTimeoutMs: timeout,
    });
    process.stdout.write(
      [
        `approval reviewer timeout set to ${timeout} ms`,
        "applies to the next session",
        `config: ${path.join(paths.home, "config.toml")}`,
      ].join("\n") + "\n",
    );
    return 0;
  }
  if (action !== "model") {
    throw new Error(
      "permissions reviewer requires show, off, model, or timeout",
    );
  }
  const model = options.positionals[3];
  if (model !== undefined && (!model.includes("/") || /\s/u.test(model))) {
    throw new Error(
      "permissions reviewer model requires provider/model or no argument",
    );
  }
  await writeUserPermissionSelection(paths, {
    reviewer: "model",
    ...(model === undefined ? {} : { reviewerModel: model }),
  });
  process.stdout.write(
    [
      "approval reviewer set to model",
      `reviewer model: ${model ?? config.approval.reviewer_model ?? "session model"}`,
      config.approval.mode === "auto"
        ? "applies to the next session"
        : "inactive until approval.mode is auto; set it with codepunk permissions approval auto",
      `config: ${path.join(paths.home, "config.toml")}`,
    ].join("\n") + "\n",
  );
  return 0;
}

async function permissionsProfile(
  options: CliOptions,
  value: string | undefined,
): Promise<number> {
  if (value === undefined || !isPermissionProfile(value)) {
    if (value === "trusted") {
      throw new Error(
        "permission profile trusted was removed because it collides with workspace trust; use auto-approve for blanket approval or codepunk trust grant for the workspace",
      );
    }
    throw new Error(
      `permissions profile requires ${PERMISSION_PROFILE_NAMES.join(", ")}`,
    );
  }
  const { paths } = await resolveProject(options);
  await writeUserPermissionProfile(paths, value as PermissionProfile);
  const settings = PERMISSION_PROFILES[value as PermissionProfile];
  process.stdout.write(
    [
      `permission profile set to ${value}`,
      `approvals ${settings.approval} · autonomy ${settings.autonomy} · sandbox ${settings.sandbox} · filesystem ${settings.filesystem}`,
      value === "full-access"
        ? "applies to the next session; it will not start without --dangerously-bypass-approvals-and-sandbox"
        : settings.sandbox === "required"
          ? "applies to the next session; run codepunk doctor if srt is unavailable"
          : "applies to the next session; no shell unless started with --allow-unsandboxed-shell",
      `config: ${path.join(paths.home, "config.toml")}`,
    ].join("\n") + "\n",
  );
  return 0;
}

async function permissionsNetwork(options: CliOptions): Promise<number> {
  const args = options.positionals.slice(3);
  const { paths, config } = await resolveProject(options);
  const formatNetwork = (
    allow: readonly string[],
    deny: readonly string[],
  ): string[] => [
    `network allow: ${
      allow.length === 0 ? "none (deny by default)" : allow.join(", ")
    }`,
    `network deny: ${deny.length === 0 ? "none" : deny.join(", ")}`,
  ];
  if (args.length === 0 || (args.length === 1 && args[0] === "show")) {
    process.stdout.write(
      [
        ...formatNetwork(
          config.sandbox.network_allow,
          config.sandbox.network_deny,
        ),
        `config: ${path.join(paths.home, "config.toml")}`,
      ].join("\n") + "\n",
    );
    return 0;
  }
  if (args[0] === "clear") {
    const which = args[1];
    if (which !== undefined && which !== "allow" && which !== "deny") {
      throw new Error(
        "permissions sandbox network clear requires allow, deny, or no argument",
      );
    }
    await writeUserPermissionSelection(paths, {
      ...(which === undefined || which === "allow" ? { networkAllow: [] } : {}),
      ...(which === undefined || which === "deny" ? { networkDeny: [] } : {}),
    });
    const nextAllow = which === "deny" ? config.sandbox.network_allow : [];
    const nextDeny = which === "allow" ? config.sandbox.network_deny : [];
    process.stdout.write(
      [
        ...formatNetwork(nextAllow, nextDeny),
        "applies to the next session",
        `config: ${path.join(paths.home, "config.toml")}`,
      ].join("\n") + "\n",
    );
    return 0;
  }
  const list = args[0] === "allow" || args[0] === "deny" ? args[0] : "allow";
  const requested =
    args[0] === "allow" || args[0] === "deny" ? args.slice(1) : args;
  if (requested.length === 0) {
    throw new Error(
      `permissions sandbox network ${list} requires at least one domain`,
    );
  }
  const normalized =
    list === "allow"
      ? normalizeNetworkAllow(requested)
      : normalizeNetworkDeny(requested);
  const overlap = normalized.filter((entry) =>
    (list === "allow"
      ? config.sandbox.network_deny
      : config.sandbox.network_allow
    ).includes(entry),
  );
  if (overlap.length > 0) {
    throw new Error(
      `sandbox.network_deny also lists ${overlap.join(", ")}; remove it with \`codepunk permissions sandbox network clear ${list === "allow" ? "deny" : "allow"}\` first`,
    );
  }
  await writeUserPermissionSelection(
    paths,
    list === "allow"
      ? { networkAllow: normalized }
      : { networkDeny: normalized },
  );
  const nextAllow =
    list === "allow" ? normalized : config.sandbox.network_allow;
  const nextDeny = list === "deny" ? normalized : config.sandbox.network_deny;
  process.stdout.write(
    [
      ...formatNetwork(nextAllow, nextDeny),
      "applies to the next session; each approved network command still needs its own approval",
      `config: ${path.join(paths.home, "config.toml")}`,
    ].join("\n") + "\n",
  );
  return 0;
}

async function permissionsUpdate(
  options: CliOptions,
  group: string,
  value: string,
): Promise<number> {
  let update: PermissionConfigUpdate;
  if (group === "approval") {
    if (!(APPROVAL_MODE_NAMES as readonly string[]).includes(value)) {
      throw new Error(
        `permissions approval requires ${APPROVAL_MODE_NAMES.join(", ")}`,
      );
    }
    update = {
      approval: value as NonNullable<PermissionConfigUpdate["approval"]>,
    };
  } else if (group === "autonomy") {
    if (!["read-only", "ask", "scoped"].includes(value)) {
      throw new Error(
        "permissions autonomy requires read-only, ask, or scoped",
      );
    }
    update = {
      autonomy: value as NonNullable<PermissionConfigUpdate["autonomy"]>,
    };
  } else if (group === "sandbox") {
    if (!["required", "uncovered"].includes(value)) {
      throw new Error("permissions sandbox requires required or uncovered");
    }
    update = {
      sandbox: value as NonNullable<PermissionConfigUpdate["sandbox"]>,
    };
  } else {
    if (value !== "workspace" && value !== "full") {
      throw new Error("permissions filesystem requires workspace or full");
    }
    update = {
      filesystem: value as FilesystemMode,
    };
  }
  const { paths, config } = await resolveProject(options);
  if (group === "autonomy" && value === "scoped") {
    const rulesPath = config.autonomy.scoped_rules;
    if (rulesPath === null || rulesPath.length === 0) {
      throw new ConfigError(
        "scoped autonomy requires autonomy.scoped_rules in the user config; set an absolute rules file path first, then rerun this command",
        "autonomy.scoped_rules",
      );
    }
    await loadScopedRules(rulesPath, paths);
  }
  await writeUserPermissionSelection(paths, update);
  process.stdout.write(
    [
      `permissions ${group} set to ${value}`,
      group === "sandbox"
        ? value === "required"
          ? "shell applies to the next session; run codepunk doctor if srt is unavailable"
          : "next session has no shell unless started with --allow-unsandboxed-shell; executions are recorded as uncovered"
        : "applies to the next session",
      `config: ${path.join(paths.home, "config.toml")}`,
    ].join("\n") + "\n",
  );
  return 0;
}
