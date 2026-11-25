import { captureClipboardImage } from "../format/clipboard-image.ts";
import {
  assertImageGenerationAllowed,
  assertImageInputAllowed,
  appendImageInputEvidence,
  imageMessage,
  recordImageGenerationFailure,
  type ConfirmedImageInput,
  type TuiApprovalEvidence,
} from "../format/image.ts";
import {
  confirmImageInput,
  generateImage,
  ImageCapabilityError,
  modelMatchesEnabledScope,
  recordHash,
  sha256Text,
  type CodepunkRuntime,
  type GeneratedImage,
} from "codepunk-core";
import path from "node:path";
import type { TuiCommand } from "../define-command.ts";
import { commandContext } from "../command-context.ts";
import type { TuiState } from "../state.ts";
import { defineCommand } from "../define-command.ts";

interface ImageGenerationState {
  reference: string | null;
  approval: TuiApprovalEvidence | null;
  networkAttempted: boolean;
}

async function selectImageGenerationModel(
  runtime: CodepunkRuntime,
  requestedModel: string | null,
  state: ImageGenerationState,
) {
  const imageModels =
    await runtime.host.services.modelRuntime.getAvailableOfType("image");
  const selected = (available: typeof imageModels, wanted: string | null) => {
    if (wanted === null) {
      return available[0];
    }
    return available.find(
      (model) => `${model.provider}/${model.id}` === wanted,
    );
  };
  if (imageModels.length === 0) {
    throw new ImageCapabilityError(
      "image.adapter_missing",
      "no image generation adapter is configured; add an authenticated image model to models.json",
    );
  }
  const enabledModels = runtime.config.model.enabled;
  const scopedImageModels =
    enabledModels.length === 0
      ? imageModels
      : imageModels.filter((model) =>
          modelMatchesEnabledScope(model, enabledModels),
        );
  if (scopedImageModels.length === 0) {
    state.reference = requestedModel;
    throw new ImageCapabilityError(
      "image.model_scope",
      "no image generation model is inside model.enabled",
    );
  }
  const selectedModel = selected(scopedImageModels, requestedModel);
  if (selectedModel === undefined) {
    state.reference = requestedModel;
    const outsideScope =
      requestedModel !== null &&
      imageModels.some(
        (model) => `${model.provider}/${model.id}` === requestedModel,
      );
    throw new ImageCapabilityError(
      outsideScope ? "image.model_scope" : "image.adapter_missing",
      outsideScope
        ? `image model ${requestedModel} is outside model.enabled`
        : `image model ${requestedModel} is not available`,
    );
  }
  const selectedReference = `${selectedModel.provider}/${selectedModel.id}`;
  state.reference = selectedReference;
  return { selectedModel, selectedReference };
}

type SelectedImageModel = Awaited<
  ReturnType<typeof selectImageGenerationModel>
>["selectedModel"];

function imageGenerationAdapter(
  runtime: CodepunkRuntime,
  state: ImageGenerationState,
  selectedModel: SelectedImageModel,
  selectedReference: string,
) {
  return {
    id: selectedReference,
    generate: async (request: { prompt: string }) => {
      state.networkAttempted = true;
      const result = await runtime.host.services.modelRuntime.generateImages(
        selectedModel,
        {
          input: [{ type: "text", text: request.prompt }],
        },
      );
      if (result.stopReason !== "stop") {
        throw new ImageCapabilityError(
          "image.generation_failed",
          result.errorMessage ??
            `image model stopped with ${result.stopReason}`,
        );
      }
      const image = result.output.find((block) => block.type === "image");
      if (image === undefined) {
        throw new ImageCapabilityError(
          "image.generation_failed",
          "image model returned no image",
        );
      }
      return Buffer.from(image.data, "base64");
    },
  };
}

async function appendImageGenerationEvidence(
  runtime: CodepunkRuntime,
  state: ImageGenerationState,
  selectedReference: string,
  started: number,
  record: GeneratedImage,
): Promise<void> {
  const rule = "product.image.generate";
  const ruleSha256 = recordHash({ rule });
  await runtime.ledger.append({
    task_id: null,
    run_id: runtime.ledger.activeRunId,
    session_id: runtime.session.sessionId,
    source: "tool",
    tool: "image_generate",
    tool_call_id: `image:${record.id}`,
    decision: "allow",
    outcome: "completed",
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
    approval: state.approval,
    approval_mode: runtime.config.approval.mode,
    command: `image-generate ${selectedReference}`,
    command_argv: ["image-generate", selectedReference],
    cwd: runtime.paths.cwd,
    workspace_root: runtime.paths.deliveryRoot,
    path_check: { performed: true, target: record.path },
    sandbox: {
      backend: "none",
      version: null,
      profile_sha256: null,
    },
    effects: { fs: "write", shell: false, network: true },
    coverage: "uncovered",
    coverage_basis: ["product-action", "image-model"],
    exit_code: 0,
    duration_ms: Date.now() - started,
    before_sha256: null,
    after_sha256: record.sha256,
    diff_sha256: null,
    output_ref: path
      .relative(runtime.paths.projectDir, record.path)
      .split(path.sep)
      .join("/"),
    output_sha256: record.sha256,
    output_preview: `generated ${record.mime} image with ${selectedReference} (${record.bytes} bytes)`,
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

export function imageCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "image",
    description: "Confirm an image and send it with the next prompt",
    handler: commandContext(state, async (runtime, context, args) => {
      const trimmed = args.trim();
      if (trimmed.length === 0) {
        context.ui.notify(
          "usage: /image <path|--clipboard|paste> [prompt]",
          "warning",
        );
        return;
      }
      const [requested, ...promptParts] = trimmed.split(/\s+/u);
      let imagePath: string;
      if (requested === "--clipboard" || requested === "paste") {
        try {
          imagePath = await captureClipboardImage(runtime.paths.deliveryRoot);
        } catch (error) {
          context.ui.notify(
            `/image clipboard failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "warning",
          );
          return;
        }
      } else {
        imagePath = path.resolve(runtime.paths.cwd, requested!);
      }
      const started = Date.now();
      let approval: TuiApprovalEvidence | null = null;
      let image: ConfirmedImageInput | null = null;
      try {
        const activeModel = context.model;
        if (activeModel === undefined || !activeModel.input.includes("image")) {
          throw new ImageCapabilityError(
            "image.model",
            activeModel === undefined
              ? "select a model before sending an image"
              : `current model ${activeModel.provider}/${activeModel.id} does not accept image input`,
          );
        }
        approval = await assertImageInputAllowed(runtime, imagePath);
        image = await confirmImageInput({
          path: imagePath,
          allowedRoot: runtime.paths.deliveryRoot,
          confirmed: true,
          assertAllowed: async () => undefined,
        });
        context.ui.notify(
          [
            `image confirmed: ${image.display_path}`,
            `type: ${image.mime} · bytes: ${image.bytes}`,
            `sha256: ${image.sha256}`,
            "The image is untrusted input; the prompt will be sent now.",
          ].join("\n"),
          "info",
        );
        await runtime.host.session.sendUserMessage(
          imageMessage(image, promptParts.join(" ")),
        );
      } catch (error) {
        let evidenceFailure: string | null = null;
        try {
          await appendImageInputEvidence(runtime, {
            image,
            path: imagePath,
            approval,
            started,
            error,
          });
        } catch (recordError) {
          evidenceFailure =
            recordError instanceof Error
              ? recordError.message
              : String(recordError);
        }
        const message = error instanceof Error ? error.message : String(error);
        context.ui.notify(
          evidenceFailure === null
            ? `/image failed: ${message}`
            : `/image failed: ${message}\nFailure evidence could not be written: ${evidenceFailure}`,
          error instanceof ImageCapabilityError ? "warning" : "error",
        );
        return;
      }
      try {
        await appendImageInputEvidence(runtime, {
          image: image!,
          path: imagePath,
          approval,
          started,
        });
      } catch (error) {
        context.ui.notify(
          `image sent, but evidence could not be written: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "warning",
        );
      }
    }),
  });
}

export function image_genCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "image-gen",
    description: "Generate an image through an available image model",
    handler: commandContext(state, async (runtime, context, args) => {
      const trimmed = args.trim();
      if (trimmed.length === 0) {
        context.ui.notify(
          "usage: /image-gen [--model <provider/model>] <prompt>",
          "warning",
        );
        return;
      }
      const tokens = trimmed.split(/\s+/u);
      let requestedModel: string | null = null;
      if (tokens[0] === "--model") {
        requestedModel = tokens[1] ?? null;
        tokens.splice(0, 2);
        if (requestedModel === null || tokens.length === 0) {
          context.ui.notify(
            "usage: /image-gen [--model <provider/model>] <prompt>",
            "warning",
          );
          return;
        }
      }
      const prompt = tokens.join(" ").trim();
      const started = Date.now();
      const generation: ImageGenerationState = {
        reference: null,
        approval: null,
        networkAttempted: false,
      };
      try {
        const { selectedModel, selectedReference } =
          await selectImageGenerationModel(runtime, requestedModel, generation);
        generation.approval = await assertImageGenerationAllowed(
          runtime,
          selectedReference,
          prompt,
        );
        const generated = await generateImage({
          prompt,
          adapter: imageGenerationAdapter(
            runtime,
            generation,
            selectedModel,
            selectedReference,
          ),
          artifactDir: path.join(runtime.paths.artifactsDir, "images"),
          assertAllowed: async () => undefined,
          appendEvidence: async (record) => {
            await appendImageGenerationEvidence(
              runtime,
              generation,
              selectedReference,
              started,
              record,
            );
          },
        });
        context.ui.notify(
          [
            `image generated: ${generated.path}`,
            `model: ${selectedReference}`,
            `type: ${generated.mime} · bytes: ${generated.bytes}`,
            `sha256: ${generated.sha256}`,
            "The artifact and policy decision were written to evidence.",
          ].join("\n"),
          "info",
        );
      } catch (error) {
        let evidenceFailure: string | null = null;
        try {
          await recordImageGenerationFailure(runtime, {
            reference: generation.reference,
            approval: generation.approval,
            started,
            networkAttempted: generation.networkAttempted,
            error,
          });
        } catch (recordError) {
          evidenceFailure =
            recordError instanceof Error
              ? recordError.message
              : String(recordError);
        }
        const message = error instanceof Error ? error.message : String(error);
        context.ui.notify(
          evidenceFailure === null
            ? `/image-gen failed: ${message}`
            : `/image-gen failed: ${message}\nFailure evidence could not be written: ${evidenceFailure}`,
          error instanceof ImageCapabilityError ? "warning" : "error",
        );
      }
    }),
  });
}
