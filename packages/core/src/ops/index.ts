import { promises as fs } from "node:fs";
import path from "node:path";
import type { CodepunkConfig } from "../config/index.ts";
import { probeConfiguredModel } from "../model/index.ts";
import {
  assertProjectConfigSafe,
  type ProjectPaths,
} from "../platform/paths.ts";
import { resolveSearchBinary } from "../search/index.ts";
import { SrtSandbox as SandboxProvider } from "../sandbox/index.ts";
import { loadMcpTools, readMcpConfig } from "../mcp/index.ts";

export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  message: string;
  hint: string | null;
}

export interface DoctorReport {
  ok: boolean;
  platform: NodeJS.Platform;
  codepunkHome: string;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  paths: ProjectPaths;
  config: CodepunkConfig;
  projectTrusted?: boolean;
  environment?: NodeJS.ProcessEnv;
  /**
   * Test seam for the documented Node floor. Production uses the running
   * process version.
   */
  nodeVersion?: string;
  /**
   * Version of the installed CLI package. An unpublished 0.0.0 checkout is
   * reported as a warning instead of claiming the npm distribution is ready.
   */
  packageVersion?: string;
  pluginEnabled?: boolean;
  sandboxProbe?: () => Promise<string | null>;
  modelProbe?: () => Promise<string | null>;
}

async function defaultSandboxProbe(
  paths: ProjectPaths,
): Promise<string | null> {
  try {
    const sandbox = await SandboxProvider.create({
      cwd: paths.cwd,
      workspaceRoot: paths.deliveryRoot,
      deliveryRoot: paths.deliveryRoot,
      codepunkHome: paths.home,
      writeSet: [paths.cwd],
    });
    await sandbox.close();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function defaultModelProbe(
  paths: ProjectPaths,
  config: CodepunkConfig,
): Promise<string | null> {
  return probeConfiguredModel(paths, config);
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const environment =
    options.environment ??
    (options.paths.home
      ? { ...process.env, CODEPUNK_HOME: options.paths.home }
      : process.env);
  const checks: DoctorCheck[] = [];
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const [nodeMajor = 0, nodeMinor = 0] = nodeVersion.split(".").map(Number);
  const nodeMeetsMinimum =
    nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 19);
  checks.push({
    id: "node",
    status: nodeMeetsMinimum ? "ok" : "error",
    message: `Node.js ${nodeVersion}`,
    hint: nodeMeetsMinimum ? null : "install Node.js >=22.19.0",
  });
  checks.push({
    id: "platform",
    status:
      process.platform === "darwin" || process.platform === "linux"
        ? "ok"
        : "warn",
    message: `${process.platform} ${process.arch}`,
    hint:
      process.platform === "darwin" || process.platform === "linux"
        ? null
        : "Windows is not currently supported",
  });
  const sandboxIssue =
    typeof options.sandboxProbe === "function"
      ? await options.sandboxProbe()
      : await defaultSandboxProbe(options.paths);
  checks.push({
    id: "srt",
    status: sandboxIssue === null ? "ok" : "error",
    message: sandboxIssue ?? "srt sandbox is available",
    hint:
      sandboxIssue === null
        ? null
        : "install the pinned srt dependency; shell tools stay disabled without it",
  });
  const modelIssue =
    typeof options.modelProbe === "function"
      ? await options.modelProbe()
      : await defaultModelProbe(options.paths, options.config);
  checks.push({
    id: "model",
    status: modelIssue === null ? "ok" : "error",
    message:
      modelIssue === null
        ? "model catalog and credential are configured"
        : (modelIssue.split("\n")[0] ?? modelIssue),
    hint:
      modelIssue === null
        ? null
        : modelIssue.includes("\n")
          ? modelIssue
          : "run `codepunk models list`; set a default with `codepunk models set <provider/model>`",
  });
  for (const binaryName of ["rg", "fd"] as const) {
    const binary = await resolveSearchBinary(binaryName, environment);
    checks.push({
      id: `search-${binaryName}`,
      status: binary === null ? "warn" : "ok",
      message:
        binary === null ? `${binaryName} was not found on PATH` : binary.path,
      hint:
        binary === null
          ? "install the local search binary; codepunk never downloads it at tool-call time"
          : null,
    });
  }
  try {
    const servers = await readMcpConfig(options.paths);
    if (servers.length === 0) {
      checks.push({
        id: "mcp",
        status: "ok",
        message: "no user MCP servers configured",
        hint: null,
      });
    } else {
      const bundle = await loadMcpTools({
        paths: options.paths,
        strict: false,
      });
      try {
        const failed = bundle.failures;
        checks.push({
          id: "mcp",
          status: failed.length === 0 ? "ok" : "warn",
          message:
            failed.length === 0
              ? `${bundle.servers.length} user MCP server(s) connected; tool calls are uncovered by the sandbox`
              : `${failed.length} of ${servers.length} user MCP server(s) failed: ${failed
                  .map((failure) => `${failure.server}: ${failure.message}`)
                  .join("; ")}`,
          hint:
            failed.length === 0
              ? null
              : "run `codepunk mcp test` to see each server; startup will skip a failed server",
        });
      } finally {
        await bundle.close();
      }
    }
  } catch (error) {
    checks.push({
      id: "mcp",
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      hint: "use user-scope ~/.codepunk/mcp.toml only",
    });
  }
  const projectIssue = await assertProjectConfigSafe(options.paths);
  checks.push({
    id: "project-config",
    status: projectIssue === null ? "ok" : "error",
    message: projectIssue ?? "project .codepunk directory is local and safe",
    hint: projectIssue === null ? null : "fix ownership or symlink state first",
  });
  const pluginDirectory = path.join(options.paths.home, "extensions");
  let pluginCount = 0;
  try {
    pluginCount = (await fs.readdir(pluginDirectory)).length;
  } catch {
    pluginCount = 0;
  }
  checks.push({
    id: "plugins",
    status:
      pluginCount === 0
        ? "ok"
        : options.pluginEnabled === true || options.config.plugins.enabled
          ? "warn"
          : "ok",
    message:
      pluginCount === 0
        ? "no user plugins installed"
        : options.pluginEnabled === true || options.config.plugins.enabled
          ? `${pluginCount} user plugin(s) enabled; ! is disabled and direct plugin effects are uncovered`
          : `${pluginCount} user plugin(s) installed but disabled`,
    hint:
      pluginCount > 0 &&
      options.pluginEnabled !== true &&
      !options.config.plugins.enabled
        ? "run `codepunk plugins enable`, or rerun with --allow-plugins"
        : null,
  });
  checks.push({
    id: "distribution",
    status:
      options.packageVersion === undefined || options.packageVersion === "0.0.0"
        ? "warn"
        : "ok",
    message:
      options.packageVersion === undefined
        ? "package version was not provided to doctor"
        : options.packageVersion === "0.0.0"
          ? "local checkout version is 0.0.0; npm distribution is not published"
          : `package version ${options.packageVersion}`,
    hint:
      options.packageVersion === undefined || options.packageVersion === "0.0.0"
        ? "publish @codepunk/cli or install from the repository checkout"
        : null,
  });
  return {
    ok: checks.every((check) => check.status !== "error"),
    platform: process.platform,
    codepunkHome: options.paths.home,
    checks,
  };
}

export function formatDoctor(report: DoctorReport): string {
  const lines = [`codepunk doctor (${report.platform})`];
  for (const check of report.checks) {
    const symbol =
      check.status === "ok" ? "ok" : check.status === "warn" ? "warn" : "error";
    lines.push(`[${symbol}] ${check.id}: ${check.message}`);
    if (check.hint !== null) {
      lines.push(...check.hint.split("\n").map((line) => `       ${line}`));
    }
  }
  lines.push(report.ok ? "doctor: ready" : "doctor: blocking issues remain");
  return lines.join("\n");
}
