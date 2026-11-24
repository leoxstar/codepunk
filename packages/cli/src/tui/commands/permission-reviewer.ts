import {
  writeUserPermissionSelection,
  type CodepunkRuntime,
} from "codepunk-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { permissionUsage } from "../format/permissions.ts";

function formatReviewer(runtime: CodepunkRuntime): string {
  return [
    `reviewer: ${runtime.config.approval.reviewer}`,
    `reviewer model: ${runtime.config.approval.reviewer_model ?? "session model"}`,
    `reviewer timeout: ${runtime.config.approval.reviewer_timeout_ms} ms`,
    "scope: network commands and headless argv exec only; other asks stay human",
    "failure: ask a human interactively; deny when no channel is available",
  ].join("\n");
}

export async function handleReviewer(
  runtime: CodepunkRuntime,
  context: ExtensionContext,
  value: string | undefined,
  rest: string[],
): Promise<void> {
  const action = value ?? "show";
  if (action === "show") {
    context.ui.notify(formatReviewer(runtime), "info");
    return;
  }
  if (action === "off") {
    try {
      await writeUserPermissionSelection(runtime.paths, { reviewer: "off" });
    } catch (error) {
      context.ui.notify(
        `reviewer was not saved: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
      return;
    }
    runtime.config.approval.reviewer = "off";
    runtime.config.approval.reviewer_model = null;
    context.ui.notify(
      `${formatReviewer(runtime)}\napplies to the next session`,
      "info",
    );
    return;
  }
  if (action === "timeout") {
    const timeout = Number(rest[0]);
    if (
      rest[0] === undefined ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1_000
    ) {
      context.ui.notify(
        "usage: /permissions reviewer timeout <ms at least 1000>",
        "warning",
      );
      return;
    }
    try {
      await writeUserPermissionSelection(runtime.paths, {
        reviewerTimeoutMs: timeout,
      });
    } catch (error) {
      context.ui.notify(
        `reviewer timeout was not saved: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
      return;
    }
    runtime.config.approval.reviewer_timeout_ms = timeout;
    context.ui.notify(
      `${formatReviewer(runtime)}\napplies to the next session`,
      "info",
    );
    return;
  }
  if (action !== "model") {
    context.ui.notify(permissionUsage(), "warning");
    return;
  }
  const model = rest[0];
  if (model !== undefined && (!model.includes("/") || /\s/u.test(model))) {
    context.ui.notify(
      "usage: /permissions reviewer model [provider/model]",
      "warning",
    );
    return;
  }
  try {
    await writeUserPermissionSelection(runtime.paths, {
      reviewer: "model",
      ...(model === undefined ? {} : { reviewerModel: model }),
    });
  } catch (error) {
    context.ui.notify(
      `reviewer was not saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
    return;
  }
  runtime.config.approval.reviewer = "model";
  if (model !== undefined) {
    runtime.config.approval.reviewer_model = model;
  }
  context.ui.notify(
    [
      formatReviewer(runtime),
      runtime.config.approval.mode === "auto"
        ? "applies to the next session"
        : "inactive until approval.mode is auto; use /permissions approval auto",
    ].join("\n"),
    "info",
  );
}
