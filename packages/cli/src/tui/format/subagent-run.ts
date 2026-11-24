import path from "node:path";
import {
  type AgentProfile,
  type SubagentParentPolicy,
  type SubagentToolMask,
  type SubagentPermissionMode,
  assertSubagentWithinParentPolicy,
  createUlid,
  loadAgentProfiles,
  type CodepunkRuntime,
} from "codepunk-core";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BackgroundSubagent, TuiState } from "../state.ts";
import { physicalModel } from "../chrome/model.ts";
import {
  parseSubagentInvocation,
  profilePool,
  profileTools,
  type SubagentInvocation,
  updateSubagentStatus,
} from "./subagent-common.ts";
import {
  runSubagentPromise,
  type SubagentExecutionContext,
} from "./subagent-execution.ts";
import { configureSubagentModel } from "./subagent-model.ts";

function parentPolicyFor(runtime: CodepunkRuntime): SubagentParentPolicy {
  return {
    approval: runtime.config.approval.mode,
    autonomy: runtime.autonomy.profile,
    tools: runtime.config.tools.enabled,
    permission:
      runtime.autonomy.profile === "read-only" ||
      runtime.config.approval.mode === "deny"
        ? ("read-only" as const)
        : ("standard" as const),
    networkAllow: runtime.config.sandbox.network_allow,
    networkDeny: runtime.config.sandbox.network_deny,
  };
}

function buildSubagentRecord(
  runtime: CodepunkRuntime,
  invocation: SubagentInvocation,
  profile: AgentProfile | undefined,
  isolation: "shared" | "worktree",
  childSessionId: string,
  controller: AbortController,
): BackgroundSubagent {
  return {
    childSessionId,
    prompt: invocation.task,
    profile: profile?.name ?? null,
    isolation,
    startedAt: Date.now(),
    status: "running",
    result: null,
    error: null,
    worktree: null,
    transcriptPath: path.join(
      runtime.paths.artifactsDir,
      "subagents",
      childSessionId,
      "transcript.jsonl",
    ),
    streamTail: "",
    lastTool: null,
    lastStreamUpdate: 0,
    delivery: null,
    controller,
    promise: Promise.resolve(),
  };
}

interface SubagentProfileResolution {
  ok: boolean;
  profile: AgentProfile | undefined;
}

async function resolveSubagentProfile(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  invocation: SubagentInvocation,
): Promise<SubagentProfileResolution> {
  const bundle = await loadAgentProfiles(runtime.paths, {
    projectTrusted: runtime.workspaceTrust.grants.config,
  });
  if (bundle.warnings.length > 0) {
    context.ui.notify(bundle.warnings.join("\n"), "warning");
  }
  const profile =
    invocation.profileName === undefined
      ? undefined
      : bundle.profiles.find(
          (candidate) => candidate.name === invocation.profileName,
        );
  if (invocation.profileName !== undefined && profile === undefined) {
    context.ui.notify(
      `agent profile ${invocation.profileName} was not found${
        bundle.profiles.length === 0
          ? ""
          : `; available: ${bundle.profiles.map((entry) => entry.name).join(", ")}`
      }`,
      "error",
    );
    return { ok: false, profile: undefined };
  }
  return { ok: true, profile };
}

function configuredModelFor(runtime: CodepunkRuntime): string | undefined {
  const activeModel = physicalModel(runtime);
  return activeModel !== undefined
    ? `${activeModel.provider}/${activeModel.id}`
    : runtime.config.model.provider !== null && runtime.config.model.id !== null
      ? `${runtime.config.model.provider}/${runtime.config.model.id}`
      : undefined;
}

interface SubagentPolicyCheck {
  ok: boolean;
  parentPolicy: SubagentParentPolicy;
  mutatingChild: boolean;
}

function checkSubagentPolicy(
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  profile: AgentProfile | undefined,
  releaseModelLease: () => void,
): SubagentPolicyCheck {
  const childMask: SubagentToolMask = profile?.tools ?? {
    read: true,
    write: false,
    edit: false,
    shell: false,
    search: true,
    memory_search: false,
  };
  const parentPolicy = parentPolicyFor(runtime);
  const mutatingChild = childMask.write || childMask.edit || childMask.shell;
  const childPermission: SubagentPermissionMode =
    profile?.permission === "read-only" || !mutatingChild
      ? "read-only"
      : childMask.shell
        ? "scoped"
        : "ask";
  try {
    assertSubagentWithinParentPolicy(
      childMask,
      childPermission,
      parentPolicy,
      profile === undefined
        ? undefined
        : {
            permission: profile.permission,
            networkAllow: profile.networkAllow,
            networkDeny: profile.networkDeny,
          },
    );
  } catch (error) {
    releaseModelLease();
    context.ui.notify(
      `subagent failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
    return { ok: false, parentPolicy, mutatingChild };
  }
  return { ok: true, parentPolicy, mutatingChild };
}

function checkSubagentProfileGuards(
  context: ExtensionCommandContext,
  invocation: SubagentInvocation,
  profile: AgentProfile | undefined,
  pool: string[],
  mutatingChild: boolean,
  releaseModelLease: () => void,
): boolean {
  if (invocation.model !== undefined && pool.length > 0) {
    if (!pool.includes(invocation.model)) {
      releaseModelLease();
      context.ui.notify(
        `model ${invocation.model} is outside profile ${profile!.name}'s pool: ${pool.join(", ")}`,
        "error",
      );
      return false;
    }
  }
  const mutating = profile !== undefined && mutatingChild;
  if (invocation.shared && mutating) {
    releaseModelLease();
    context.ui.notify(
      `profile ${profile!.name} can mutate files and requires a worktree; remove --shared`,
      "error",
    );
    return false;
  }
  return true;
}

function subagentRegistry(
  state: TuiState,
  context: ExtensionCommandContext,
  releaseModelLease: () => void,
): Map<string, BackgroundSubagent> | null {
  const registry = (state.subagents ??= new Map());
  const running = [...registry.values()].filter(
    (record) => record.status === "running",
  );
  if (running.length >= 4) {
    releaseModelLease();
    context.ui.notify(
      "four background subagents are already running; stop one with /agents stop <id>",
      "warning",
    );
    return null;
  }
  return registry;
}

function subagentStartNotification(
  profile: AgentProfile | undefined,
  isolation: "shared" | "worktree",
  childSessionId: string,
  primaryModel: string | undefined,
  fallbackModels: string[] | undefined,
): string {
  return [
    `subagent started: ${childSessionId}`,
    `profile: ${profile === undefined ? "built-in read-only" : `${profile.name} (${profile.source})`}`,
    `isolation: ${isolation}`,
    `permission: ${profile?.permission ?? "read-only"}`,
    `tools: ${profileTools(profile).join(", ")}`,
    `shell allow: ${
      profile === undefined || profile.shellAllow.length === 0
        ? "none"
        : `${profile.shellAllow.length} exact rule(s)`
    }`,
    `network: ${
      profile === undefined ||
      (profile.networkAllow.length === 0 && profile.networkDeny.length === 0)
        ? "deny-by-default"
        : `${profile.networkAllow.join(",") || "deny-by-default"}${
            profile.networkDeny.length === 0
              ? ""
              : `; deny ${profile.networkDeny.join(",")}`
          }`
    }`,
    `model: ${
      primaryModel === undefined
        ? "inherited"
        : `${primaryModel}${
            fallbackModels === undefined || fallbackModels.length === 0
              ? ""
              : ` (+${fallbackModels.join(",")})`
          }`
    }`,
    "background: use /agents, /agents result <id>, /agents transcript <id> (live), or /agents stop <id>",
  ].join("\n");
}

export async function runSubagent(
  state: TuiState,
  runtime: CodepunkRuntime,
  context: ExtensionCommandContext,
  args: string,
): Promise<void> {
  let invocation: SubagentInvocation;
  try {
    invocation = parseSubagentInvocation(args);
  } catch (error) {
    context.ui.notify(
      error instanceof Error ? error.message : String(error),
      "warning",
    );
    return;
  }
  if (state.childHostArgv.length === 0) {
    context.ui.notify(
      "subagent host is not available in this invocation",
      "error",
    );
    return;
  }
  const resolution = await resolveSubagentProfile(runtime, context, invocation);
  if (!resolution.ok) {
    return;
  }
  const profile = resolution.profile;
  const configuredModel = configuredModelFor(runtime);
  const modelSelection = await configureSubagentModel(
    state,
    runtime,
    context,
    invocation,
    configuredModel,
  );
  if (modelSelection === null) {
    return;
  }
  let modelLease = modelSelection.modelLease;
  const releaseModelLease = (): void => {
    if (modelLease !== undefined) {
      state.modelPool?.release(modelLease.lease_id);
      modelLease = undefined;
    }
  };
  const policy = checkSubagentPolicy(
    runtime,
    context,
    profile,
    releaseModelLease,
  );
  if (!policy.ok) {
    return;
  }
  const { parentPolicy, mutatingChild } = policy;
  const pool = profile === undefined ? [] : profilePool(profile);
  if (
    !checkSubagentProfileGuards(
      context,
      invocation,
      profile,
      pool,
      mutatingChild,
      releaseModelLease,
    )
  ) {
    return;
  }
  const mutating = profile !== undefined && mutatingChild;
  const isolation: "shared" | "worktree" =
    mutating || invocation.worktree ? "worktree" : "shared";
  const registry = subagentRegistry(state, context, releaseModelLease);
  if (registry === null) {
    return;
  }
  const parentSessionId = runtime.session.sessionId;
  const parentRunId = runtime.host.currentRunId;
  const childSessionId = createUlid();
  const primaryModel =
    invocation.model ??
    modelSelection.roleSelection?.model ??
    modelLease?.models[0] ??
    profile?.model ??
    configuredModel ??
    undefined;
  const profileFallbacks =
    pool.length === 0 && (modelLease?.models.length ?? 0) <= 1
      ? []
      : [
          ...new Set(
            [...pool, ...(modelLease?.models.slice(1) ?? [])].filter(
              (entry) => entry !== (primaryModel ?? undefined),
            ),
          ),
        ];
  const execution: SubagentExecutionContext = {
    invocation,
    profile,
    parentPolicy,
    isolation,
    primaryModel,
    fallbackModels:
      profileFallbacks.length === 0 ? undefined : profileFallbacks,
    thinking: profile?.thinking ?? runtime.host.session.thinkingLevel,
    parentSessionId,
    workspaceTrustOverride:
      isolation === "worktree"
        ? runtime.workspaceTrust.grants
        : runtime.workspaceTrust.source === "saved" ||
            runtime.workspaceTrust.source === "no-resources"
          ? undefined
          : runtime.workspaceTrust.grants,
  };
  const record = buildSubagentRecord(
    runtime,
    invocation,
    profile,
    isolation,
    childSessionId,
    new AbortController(),
  );
  registry.set(childSessionId, record);
  updateSubagentStatus(state);
  context.ui.notify(
    subagentStartNotification(
      profile,
      isolation,
      childSessionId,
      primaryModel,
      execution.fallbackModels,
    ),
    "info",
  );
  record.promise = runSubagentPromise(
    state,
    runtime,
    record,
    execution,
    parentRunId,
  ).finally(() => releaseModelLease());
}
