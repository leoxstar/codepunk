import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalChannel } from "codepunk-core";
import type {
  ApprovalAnswer,
  ApprovalRequest,
  ApprovalScope,
} from "codepunk-protocol";
import type { ApprovalChoice } from "../components/approval-card.ts";
import { formatApproval, persistentApprovalPreview } from "./text.ts";

const APPROVAL_CHOICES: readonly ApprovalChoice[] = [
  { key: "a", label: "Allow once", decision: "allow", scope: "once" },
  {
    key: "s",
    label: "Allow for session",
    decision: "allow",
    scope: "session",
  },
  {
    key: "p",
    label: "Always allow exact",
    decision: "allow",
    scope: "persistent",
  },
  { key: "d", label: "Deny", decision: "deny", scope: "once" },
  {
    key: "g",
    label: "Deny with guidance",
    decision: "deny",
    scope: "once",
    guidance: true,
  },
];
const PERSIST_APPROVAL = "Save exact rule and allow";
const PERSIST_BACK = "Back";

interface InlineResult {
  readonly used: boolean;
  readonly choice: ApprovalChoice | null;
}

export class TuiApprovalChannel implements ApprovalChannel {
  readonly id = "codepunk-tui";
  readonly kind = "tui" as const;
  readonly isTTY: boolean;
  private context: ExtensionContext | null = null;
  private persist: ((request: ApprovalRequest) => Promise<boolean>) | null =
    null;
  private workspaceTrusted = false;

  constructor(isTTY = process.stdin.isTTY === true) {
    this.isTTY = isTTY;
  }

  attach(context: ExtensionContext): void {
    this.context = context;
  }

  setPersistHandler(
    handler: (request: ApprovalRequest) => Promise<boolean>,
  ): void {
    this.persist = handler;
  }

  /**
   * An untrusted workspace may only answer `once`. The broker enforces the
   * same rule, but the selector must not offer a choice that would be
   * rejected after the user already confirmed it.
   */
  setWorkspaceTrusted(trusted: boolean): void {
    this.workspaceTrusted = trusted;
  }

  async ask(request: ApprovalRequest): Promise<ApprovalAnswer | null> {
    if (!this.isTTY || this.context === null) {
      return null;
    }
    const canPersistExact =
      request.argv !== undefined &&
      request.argv.length > 0 &&
      request.cwd !== undefined;
    const choices = APPROVAL_CHOICES.filter((choice) =>
      choice.scope === "persistent"
        ? canPersistExact && this.workspaceTrusted
        : true,
    );
    const inline = await this.askInline(request, choices);
    if (inline.used) {
      return this.resolveChoice(request, inline.choice);
    }
    return this.askWithSelect(request, choices);
  }

  private async askInline(
    request: ApprovalRequest,
    choices: readonly ApprovalChoice[],
  ): Promise<InlineResult> {
    if (this.context === null || !this.isTTY) {
      return { used: false, choice: null };
    }
    const ui = this.context.ui;
    if (typeof ui.custom !== "function") {
      return { used: false, choice: null };
    }
    try {
      const { createApprovalCard } =
        await import("../components/approval-card.ts");
      const choice = await ui.custom<ApprovalChoice | null>(
        (_tui, theme, keybindings, done) =>
          createApprovalCard(
            {
              request,
              choices,
              workspaceTrusted: this.workspaceTrusted,
            },
            theme,
            keybindings,
            done,
          ),
      );
      return { used: true, choice: choice ?? null };
    } catch {
      return { used: false, choice: null };
    }
  }

  private async resolveChoice(
    request: ApprovalRequest,
    choice: ApprovalChoice | null,
  ): Promise<ApprovalAnswer> {
    if (choice === null || choice.decision === "deny") {
      const ui = this.context?.ui;
      const guidance =
        choice?.guidance === true && ui !== undefined
          ? (
              await ui.input(
                "Denial guidance (optional)",
                "Tell the model what to do instead",
              )
            )?.trim()
          : undefined;
      return this.answer(
        request,
        "deny",
        "once",
        guidance === undefined || guidance.length === 0 ? undefined : guidance,
      );
    }
    if (choice.scope === "persistent") {
      if (!this.workspaceTrusted) {
        return this.answer(request, "deny", "once");
      }
      const stored = await this.persist?.(request);
      if (stored !== true) {
        this.context?.ui.notify(
          "the exact rule was not stored; allowing this call only",
          "warning",
        );
        return this.answer(request, "allow", "once");
      }
    }
    return this.answer(request, "allow", choice.scope);
  }

  private async askWithSelect(
    request: ApprovalRequest,
    choices: readonly ApprovalChoice[],
  ): Promise<ApprovalAnswer> {
    if (this.context === null) {
      return this.answer(request, "deny", "once");
    }
    const ui = this.context.ui;
    const options = choices.map((choice) => choice.label);
    const prompt = this.workspaceTrusted
      ? formatApproval(request)
      : `${formatApproval(request)}\n\nworkspace is untrusted; session approval stays in memory, persistent rules need /trust grant.`;
    while (true) {
      const selected = await ui.select(prompt, options);
      const choice = choices.find((candidate) => candidate.label === selected);
      if (choice === undefined || choice.decision === "deny") {
        return this.resolveChoice(request, choice ?? null);
      }
      if (choice.scope === "persistent") {
        if (!this.workspaceTrusted) {
          return this.answer(request, "deny", "once");
        }
        const confirmed = await ui.select(persistentApprovalPreview(request), [
          PERSIST_APPROVAL,
          PERSIST_BACK,
        ]);
        if (confirmed === PERSIST_BACK) {
          continue;
        }
        if (confirmed !== PERSIST_APPROVAL) {
          return this.answer(request, "deny", "once");
        }
        const stored = await this.persist?.(request);
        if (stored !== true) {
          ui.notify(
            "the exact rule was not stored; allowing this call only",
            "warning",
          );
          return this.answer(request, "allow", "once");
        }
      }
      return this.answer(request, "allow", choice.scope);
    }
  }

  private answer(
    request: ApprovalRequest,
    decision: "allow" | "deny",
    scope: ApprovalScope,
    guidance?: string,
  ): ApprovalAnswer {
    return {
      request_id: request.request_id,
      answer: decision,
      scope,
      ...(guidance === undefined ? {} : { guidance }),
      channel: this.kind,
      channel_id: request.channel_id,
      nonce_sha256: request.nonce_sha256,
      worker_id: request.worker_id,
      session_id: request.session_id,
      tool_call_id: request.tool_call_id,
      answered_at: new Date().toISOString(),
    };
  }
}
