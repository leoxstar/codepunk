import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalChannel } from "codepunk-core";
import type {
  ApprovalAnswer,
  ApprovalRequest,
  ApprovalScope,
} from "codepunk-protocol";
import { formatApproval } from "./text.ts";

const APPROVAL_CHOICES: ReadonlyArray<{
  label: string;
  decision: "allow" | "deny";
  scope: ApprovalScope;
  guidance?: boolean;
}> = [
  { label: "Allow once", decision: "allow", scope: "once" },
  {
    label: "Allow this exact command for the session",
    decision: "allow",
    scope: "session",
  },
  {
    label: "Always allow this exact command",
    decision: "allow",
    scope: "persistent",
  },
  { label: "Deny", decision: "deny", scope: "once" },
  {
    label: "Deny with guidance for the model",
    decision: "deny",
    scope: "once",
    guidance: true,
  },
];
const PERSIST_APPROVAL = "Save exact rule and allow";
const PERSIST_BACK = "Back";

function persistentApprovalPreview(request: ApprovalRequest): string {
  const argv =
    request.argv === undefined || request.argv.length === 0
      ? "(missing; persistent approval is unavailable)"
      : JSON.stringify(request.argv);
  return [
    "Persistent rule preview",
    "This choice writes a scoped rule for later sessions.",
    `tool: ${request.tool ?? "(unknown)"}`,
    `exact argv: ${argv}`,
    `cwd: ${request.cwd ?? "(missing)"}`,
    "match: identical argv only, from this exact cwd",
    "storage: user scoped-rule file; inspect it with /permissions rules",
    "next session: autonomy switches to scoped so this exact rule can apply",
    "",
    "Save this exact rule?",
  ].join("\n");
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
    const canReuseExact =
      request.argv !== undefined &&
      request.argv.length > 0 &&
      request.cwd !== undefined;
    const choices = APPROVAL_CHOICES.filter(
      (choice) =>
        choice.scope === "once" || (canReuseExact && this.workspaceTrusted),
    );
    const options = choices.map((choice) => choice.label);
    const prompt = this.workspaceTrusted
      ? formatApproval(request)
      : `${formatApproval(request)}\n\nworkspace is untrusted; only "Allow once" is available for this call.`;
    while (true) {
      const selected = await this.context.ui.select(prompt, options);
      const choice = choices.find((candidate) => candidate.label === selected);
      if (choice === undefined || choice.decision === "deny") {
        const guidance =
          choice?.guidance === true
            ? (
                await this.context.ui.input(
                  "Denial guidance (optional)",
                  "Tell the model what to do instead",
                )
              )?.trim()
            : undefined;
        return this.answer(
          request,
          "deny",
          "once",
          guidance === undefined || guidance.length === 0
            ? undefined
            : guidance,
        );
      }
      if (choice.scope === "persistent") {
        if (!this.workspaceTrusted) {
          return this.answer(request, "deny", "once");
        }
        const confirmed = await this.context.ui.select(
          persistentApprovalPreview(request),
          [PERSIST_APPROVAL, PERSIST_BACK],
        );
        if (confirmed === PERSIST_BACK) {
          continue;
        }
        if (confirmed !== PERSIST_APPROVAL) {
          return this.answer(request, "deny", "once");
        }
        const stored = await this.persist?.(request);
        if (stored !== true) {
          this.context.ui.notify(
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
