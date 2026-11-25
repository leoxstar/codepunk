import type { ApprovalRequest } from "codepunk-protocol";

export function formatApproval(request: ApprovalRequest): string {
  const lines = [
    "Approval required",
    ...(request.tool === undefined ? [] : [`action: ${request.tool}`]),
    ...(request.command === undefined ? [] : [`command: ${request.command}`]),
    ...(request.argv === undefined
      ? []
      : [`exact argv: ${request.argv.join(" ")}`]),
    ...(request.cwd === undefined ? [] : [`cwd: ${request.cwd}`]),
    ...(request.path === undefined ? [] : [`path: ${request.path}`]),
    ...(request.reason === undefined ? [] : [`why: ${request.reason}`]),
    ...(request.args_preview === undefined
      ? []
      : ["arguments:", request.args_preview]),
    ...(request.coverage_preview === undefined
      ? []
      : [`coverage: ${request.coverage_preview}`]),
    ...(request.diff_preview === undefined
      ? []
      : ["proposed diff:", request.diff_preview]),
  ];
  return lines.join("\n");
}

export function persistentApprovalPreview(request: ApprovalRequest): string {
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
