import path from "node:path";
import {
  createUlid,
  decidePolicy,
  ImageCapabilityError,
  type confirmImageInput,
  recordHash,
  sha256Text,
  redactOutputPreview,
  type CodepunkRuntime,
} from "codepunk-core";

export async function assertImageInputAllowed(
  runtime: CodepunkRuntime,
  imagePath: string,
): Promise<
  Awaited<ReturnType<CodepunkRuntime["approval"]["request"]>>["evidence"] | null
> {
  const decision = decidePolicy({
    tool: "read",
    args: { path: imagePath },
    cwd: runtime.paths.cwd,
    workspaceRoot: runtime.paths.deliveryRoot,
    deliveryRoot: runtime.paths.deliveryRoot,
    codepunkHome: runtime.paths.home,
    mode: "interactive",
    autonomy: runtime.autonomy.profile,
    approvalMode: runtime.config.approval.mode,
    filesystem: runtime.config.filesystem.mode,
    writeSet: runtime.policy.writeSet,
    userRules: runtime.policy.userRules,
    projectRules: runtime.policy.projectRules,
    layers: runtime.policy.layers,
  });
  if (decision.decision === "deny") {
    throw new ImageCapabilityError(
      "image.policy",
      `image input was denied by policy: ${decision.reason}`,
    );
  }
  if (decision.decision !== "ask") {
    return null;
  }
  const approval = await runtime.approval.request({
    sessionId: runtime.session.sessionId,
    workerId: runtime.session.sessionId,
    toolCallId: createUlid(),
    tool: "read",
    path: imagePath,
    cwd: runtime.paths.cwd,
    reason: `confirm image input: ${decision.reason}`,
    argsPreview: "image input",
  });
  if (!approval.approved) {
    throw new ImageCapabilityError(
      "image.policy",
      `image input approval was denied: ${approval.reason}`,
    );
  }
  return approval.evidence;
}

export type TuiApprovalEvidence = Awaited<
  ReturnType<CodepunkRuntime["approval"]["request"]>
>["evidence"];

export type ConfirmedImageInput = Awaited<ReturnType<typeof confirmImageInput>>;

export function imageDisplayPath(
  runtime: CodepunkRuntime,
  imagePath: string,
): string {
  const relative = path.relative(runtime.paths.cwd, imagePath);
  return relative.startsWith("..")
    ? path.basename(imagePath)
    : relative.split(path.sep).join("/");
}

export async function appendImageInputEvidence(
  runtime: CodepunkRuntime,
  options: {
    image: ConfirmedImageInput | null;
    path: string;
    approval: TuiApprovalEvidence | null;
    started: number;
    error?: unknown;
  },
): Promise<void> {
  const failed = options.error !== undefined;
  const denied =
    failed &&
    options.error instanceof ImageCapabilityError &&
    (options.error.code === "image.confirmation_required" ||
      options.error.code === "image.model" ||
      options.error.code === "image.policy");
  const rule = denied
    ? "product.image.input_denied"
    : failed
      ? "product.image.input_failed"
      : "product.image.input";
  const ruleSha256 = recordHash({ rule });
  const displayPath =
    options.image?.display_path ?? imageDisplayPath(runtime, options.path);
  const failureMessage =
    options.error instanceof Error
      ? options.error.message
      : String(options.error);
  const outputPreview = failed
    ? redactOutputPreview(failureMessage, runtime.paths.home).slice(0, 4_096)
    : [
        `confirmed ${options.image!.mime} image: ${displayPath}`,
        `bytes: ${options.image!.bytes}`,
        `sha256: ${options.image!.sha256}`,
        `redactions: ${options.image!.redactions.join(",")}`,
      ].join("\n");
  await runtime.ledger.append({
    task_id: null,
    run_id: runtime.ledger.activeRunId,
    session_id: runtime.session.sessionId,
    source: "tool",
    tool: "image_input",
    tool_call_id: `image-input:${options.image?.sha256 ?? createUlid()}`,
    decision: denied ? "deny" : "allow",
    outcome: failed ? (denied ? "denied" : "failed") : "completed",
    rule,
    rule_sha256: ruleSha256,
    policy_layers: [
      {
        layer: "user",
        source: "product:/image",
        sha256: sha256Text("product:/image"),
        rule_sha256: ruleSha256,
      },
    ],
    approval: options.approval,
    approval_mode: runtime.config.approval.mode,
    command: `image-confirm ${displayPath}`,
    command_argv: ["image-confirm", displayPath],
    cwd: runtime.paths.cwd,
    workspace_root: runtime.paths.deliveryRoot,
    path_check: { performed: true, target: displayPath },
    sandbox: {
      backend: "none",
      version: null,
      profile_sha256: null,
    },
    effects: {
      fs: options.image === null ? "none" : "read",
      shell: false,
      network: !failed,
    },
    coverage: "uncovered",
    coverage_basis: ["product-action", "image-input"],
    exit_code: failed ? 1 : 0,
    duration_ms: Date.now() - options.started,
    before_sha256: null,
    after_sha256: null,
    diff_sha256: null,
    output_ref: null,
    output_sha256: options.image?.sha256 ?? sha256Text(outputPreview),
    output_preview: outputPreview,
    empty_result: false,
    executor: "codepunk-image-input",
    vcs: {
      commit: null,
      tree: null,
      base_commit: null,
    },
    memory: {
      ids: [],
      action: "none",
      query_sha256: null,
      cap: 0,
      truncated: false,
    },
  });
}

export async function assertImageGenerationAllowed(
  runtime: CodepunkRuntime,
  modelReference: string,
  prompt: string,
): Promise<TuiApprovalEvidence | null> {
  const command = `image-generate ${modelReference}`;
  const decision = decidePolicy({
    tool: "bash",
    args: { command },
    command,
    cwd: runtime.paths.cwd,
    workspaceRoot: runtime.paths.deliveryRoot,
    deliveryRoot: runtime.paths.deliveryRoot,
    codepunkHome: runtime.paths.home,
    mode: "interactive",
    autonomy: runtime.autonomy.profile,
    approvalMode: runtime.config.approval.mode,
    filesystem: runtime.config.filesystem.mode,
    writeSet: runtime.policy.writeSet,
    userRules: runtime.policy.userRules,
    projectRules: runtime.policy.projectRules,
    layers: runtime.policy.layers,
  });
  if (decision.decision === "deny") {
    throw new ImageCapabilityError(
      "image.policy",
      `image generation was denied by policy: ${decision.reason}`,
    );
  }
  if (decision.decision !== "ask") {
    return null;
  }
  const approval = await runtime.approval.request({
    sessionId: runtime.session.sessionId,
    workerId: runtime.session.sessionId,
    toolCallId: createUlid(),
    tool: "bash",
    command,
    cwd: runtime.paths.cwd,
    reason: `confirm image generation: ${decision.reason}`,
    argsPreview: [
      `model: ${modelReference}`,
      `prompt: ${prompt.length} character(s)`,
    ].join("\n"),
    argsSha256: sha256Text(prompt),
    coveragePreview:
      "network request to the configured image provider; content-addressed artifact write",
  });
  if (!approval.approved) {
    throw new ImageCapabilityError(
      "image.policy",
      `image generation approval was denied: ${approval.reason}`,
    );
  }
  return approval.evidence;
}

export async function recordImageGenerationFailure(
  runtime: CodepunkRuntime,
  options: {
    reference: string | null;
    approval: TuiApprovalEvidence | null;
    started: number;
    networkAttempted: boolean;
    error: unknown;
  },
): Promise<void> {
  const message =
    options.error instanceof Error
      ? options.error.message
      : String(options.error);
  const preview = redactOutputPreview(message, runtime.paths.home).slice(
    0,
    4_096,
  );
  const denied =
    options.error instanceof ImageCapabilityError &&
    (options.error.code === "image.adapter_missing" ||
      options.error.code === "image.model_scope" ||
      options.error.code === "image.policy" ||
      options.error.code === "image.prompt");
  const rule = denied
    ? "product.image.generate_denied"
    : "product.image.generate_failed";
  const ruleSha256 = recordHash({ rule });
  await runtime.ledger.append({
    task_id: null,
    run_id: runtime.ledger.activeRunId,
    session_id: runtime.session.sessionId,
    source: "tool",
    tool: "image_generate",
    tool_call_id: `image-generate:${createUlid()}`,
    decision: denied ? "deny" : "allow",
    outcome: denied ? "denied" : "failed",
    rule,
    rule_sha256: ruleSha256,
    policy_layers: [
      {
        layer: "user",
        source: "product:/image-gen",
        sha256: sha256Text("product:/image-gen"),
        rule_sha256: ruleSha256,
      },
    ],
    approval: options.approval,
    approval_mode: runtime.config.approval.mode,
    command:
      options.reference === null
        ? "image-generate"
        : `image-generate ${options.reference}`,
    command_argv:
      options.reference === null
        ? ["image-generate"]
        : ["image-generate", options.reference],
    cwd: runtime.paths.cwd,
    workspace_root: runtime.paths.deliveryRoot,
    path_check: { performed: false, target: null },
    sandbox: { backend: "none", version: null, profile_sha256: null },
    effects: {
      fs: options.networkAttempted ? "write" : "none",
      shell: false,
      network: options.networkAttempted,
    },
    coverage: "uncovered",
    coverage_basis: ["product-action", "image-model"],
    exit_code: 1,
    duration_ms: Date.now() - options.started,
    before_sha256: null,
    after_sha256: null,
    diff_sha256: null,
    output_ref: null,
    output_sha256: sha256Text(preview),
    output_preview: preview,
    empty_result: false,
    executor: "codepunk-image-generation",
    vcs: {
      commit: null,
      tree: null,
      base_commit: null,
    },
    memory: {
      ids: [],
      action: "none",
      query_sha256: null,
      cap: 0,
      truncated: false,
    },
  });
}

export function imageMessage(
  image: Awaited<ReturnType<typeof confirmImageInput>>,
  prompt: string,
): Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
> {
  return [
    {
      type: "text",
      text:
        prompt.trim().length === 0
          ? "Describe this image and call out anything relevant to the task."
          : prompt.trim(),
    },
    {
      type: "image",
      data: image.data.toString("base64"),
      mimeType: image.mime,
    },
  ];
}
