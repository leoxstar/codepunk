import { promises as fs } from "node:fs";
import path from "node:path";
import {
  WORKSPACE_TRUST_RESOURCE_KINDS,
  allWorkspaceTrustGrants,
  applyWorkspaceTrustGrantChanges,
  findDeliveryRoot,
  formatWorkspaceTrust,
  previewWorkspaceTrustResources,
  projectPaths,
  readSavedWorkspaceTrustGrants,
  resolveWorkspaceTrust,
  saveWorkspaceTrustGrants,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";

export async function commandTrust(options: CliOptions): Promise<number> {
  const actions = new Set(["status", "grant", "revoke"]);
  let action = options.positionals[1] ?? "status";
  let targetArgument = options.positionals[2];
  if (!actions.has(action)) {
    targetArgument = action;
    action = "status";
  }
  const consumed = targetArgument === undefined ? 2 : 3;
  if (options.positionals.length > consumed) {
    throw new Error(
      "usage: codepunk trust [status|grant|revoke] [path] [--resources <kinds>]",
    );
  }
  if (options.resources !== undefined && action === "status") {
    throw new Error("--resources only applies to trust grant or trust revoke");
  }
  const target = path.resolve(targetArgument ?? process.cwd());
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new Error(`trust path does not exist: ${target}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`trust path is not a directory: ${target}`);
  }
  const project = await findDeliveryRoot(target);
  const paths = projectPaths(project);
  if (action === "grant" || action === "revoke") {
    const trusted = action === "grant";
    const grants =
      options.resources === undefined
        ? allWorkspaceTrustGrants(trusted)
        : applyWorkspaceTrustGrantChanges(
            await readSavedWorkspaceTrustGrants(
              paths.home,
              project.deliveryRoot,
            ),
            options.resources,
            trusted,
          );
    const saved = await saveWorkspaceTrustGrants(
      paths.home,
      project.deliveryRoot,
      grants,
      "cli",
    );
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          action,
          root: project.deliveryRoot,
          decision: trusted ? "trusted" : "untrusted",
          grants,
          store: saved.storePath,
          resource_store: saved.resourceStorePath,
          applies: "future-sessions",
        })}\n`,
      );
    } else {
      process.stdout.write(
        [
          `trust decision saved: ${trusted ? "trusted" : "untrusted"}`,
          `root: ${project.deliveryRoot}`,
          `resources: ${WORKSPACE_TRUST_RESOURCE_KINDS.map(
            (kind) => `${kind}=${grants[kind] ? "allowed" : "skipped"}`,
          ).join(", ")}`,
          `store: ${saved.storePath}`,
          `resource store: ${saved.resourceStorePath}`,
          "applies to future sessions; restart Codepunk to load or skip project resources",
        ].join("\n") + "\n",
      );
    }
    return 0;
  }
  const workspaceTrust = await resolveWorkspaceTrust({
    cwd: project.cwd,
    root: project.deliveryRoot,
    home: paths.home,
  });
  const previews = await previewWorkspaceTrustResources(
    project.deliveryRoot,
    project.cwd,
  );
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        trusted: workspaceTrust.trusted,
        mode: workspaceTrust.mode,
        grants: workspaceTrust.grants,
        available: workspaceTrust.available,
        source: workspaceTrust.source,
        cwd: workspaceTrust.cwd,
        root: workspaceTrust.root,
        saved_path: workspaceTrust.savedPath,
        resources: workspaceTrust.resources,
        resource_details: previews,
        store: workspaceTrust.storePath,
        resource_store: workspaceTrust.resourceStorePath,
      })}\n`,
    );
  } else {
    process.stdout.write(
      `${formatWorkspaceTrust(workspaceTrust, previews)}\n` +
        "Use codepunk trust grant|revoke [--resources <kinds>] to save a decision; --trust, --no-trust, and --trust-resources apply to one run.\n",
    );
  }
  return 0;
}
