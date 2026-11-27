import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, type CodepunkConfig } from "../config/index.ts";
import { loadPolicyFiles } from "../config/policy.ts";
import { probeConfiguredModel } from "../model/index.ts";
import {
  assertProjectConfigSafe,
  type ProjectPaths,
} from "../platform/paths.ts";
import { resolveSearchBinary } from "../search/index.ts";
import {
  probeSrtSandbox,
  resolveWindowsShell,
  SrtSandbox as SandboxProvider,
} from "../sandbox/index.ts";
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
  /**
   * Test seam for platform-specific doctor behavior. Production uses the
   * running platform.
   */
  platform?: NodeJS.Platform;
  /**
   * Test seam for the platform version. Windows uses the OS build number to
   * tell Windows 11 from Windows 10; production uses the running kernel.
   */
  platformVersion?: string;
  /**
   * Test seam for the reported architecture. Production uses the running
   * process architecture.
   */
  arch?: string;
  projectTrusted?: boolean;
  projectPolicyTrusted?: boolean;
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
  /**
   * Test seam for the configured shell preflight. Production resolves the
   * shell selected by `tools.shell` on Windows.
   */
  shellProbe?: () => Promise<string | null>;
}

const WINDOWS_11_MINIMUM_BUILD = 22_000;

function windowsBuildNumber(version: string): number {
  const build = Number.parseInt(version.split(".")[2] ?? "", 10);
  return Number.isFinite(build) ? build : 0;
}

function platformIsSupported(
  platform: NodeJS.Platform,
  arch: string,
  platformVersion: string,
): boolean {
  if (platform === "darwin" || platform === "linux") {
    return true;
  }
  if (platform !== "win32") {
    return false;
  }
  return (
    arch === "x64" &&
    windowsBuildNumber(platformVersion) >= WINDOWS_11_MINIMUM_BUILD
  );
}

async function defaultSandboxProbe(
  paths: ProjectPaths,
  platform: NodeJS.Platform,
): Promise<string | null> {
  // Windows initialize() stamps persistent ACLs over the workspace. A
  // doctor probe must answer "can this shell run?" without changing the
  // filesystem, so it uses the stateless dependency check there.
  if (platform === "win32") {
    return probeSrtSandbox({
      cwd: paths.cwd,
      workspaceRoot: paths.deliveryRoot,
      deliveryRoot: paths.deliveryRoot,
      codepunkHome: paths.home,
      writeSet: [paths.cwd],
    });
  }
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

async function defaultShellProbe(
  config: CodepunkConfig,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (platform !== "win32") {
    return null;
  }
  try {
    await resolveWindowsShell(config.tools.shell, environment, platform);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function sandboxFixHint(
  platform: NodeJS.Platform,
  sandboxIssue: string,
): string {
  if (/Windows sandbox|srt-win|not provisioned/u.test(sandboxIssue)) {
    return "provision the Windows sandbox once with `npx --yes @anthropic-ai/sandbox-runtime@0.0.82 windows-install`; add `--skip-profile-grant` when the user profile must stay unreadable; shell tools stay disabled until then";
  }
  if (platform === "linux") {
    if (/apparmor|userns|namespace|bwrap/iu.test(sandboxIssue)) {
      return [
        "install sandbox packages: sudo apt-get install -y bubblewrap socat ripgrep",
        "on Ubuntu 24.04+, allow unprivileged user namespaces: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
        "shell tools stay disabled until the sandbox initializes",
      ].join("\n");
    }
    return "install sandbox packages (e.g. `sudo apt-get install -y bubblewrap socat ripgrep`); shell tools stay disabled without srt";
  }
  return "install the pinned srt dependency; shell tools stay disabled without it";
}

function searchBinaryHint(
  platform: NodeJS.Platform,
  binaryName: "rg" | "fd",
): string {
  const install =
    platform === "darwin"
      ? binaryName === "rg"
        ? "brew install ripgrep"
        : "brew install fd"
      : platform === "linux"
        ? binaryName === "rg"
          ? "sudo apt-get install -y ripgrep"
          : "sudo apt-get install -y fd-find"
        : binaryName === "rg"
          ? "winget install BurntSushi.ripgrep.MSVC"
          : "winget install sharkdp.fd";
  return `install ${binaryName} (e.g. \`${install}\`); codepunk never downloads it at tool-call time`;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const platformVersion =
    options.platformVersion ??
    (platform === "win32" ? os.release() : process.versions.node);
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
    status: platformIsSupported(platform, arch, platformVersion)
      ? "ok"
      : "error",
    message: `${platform} ${arch}`,
    hint: platformIsSupported(platform, arch, platformVersion)
      ? null
      : platform === "win32"
        ? `Windows support requires Windows 11 x64 (build ${WINDOWS_11_MINIMUM_BUILD} or newer); this host reports ${arch} build ${windowsBuildNumber(platformVersion)}`
        : `${platform} is not currently supported; doctor must not report ready until the platform has real install, sandbox, TUI, and ACL evidence`,
  });
  const shellIssue =
    typeof options.shellProbe === "function"
      ? await options.shellProbe()
      : await defaultShellProbe(options.config, platform, environment);
  if (platform === "win32") {
    checks.push({
      id: "tools.shell",
      status: shellIssue === null ? "ok" : "error",
      message:
        shellIssue === null
          ? `${options.config.tools.shell} shell is available`
          : shellIssue,
      hint:
        shellIssue === null
          ? null
          : "install the selected shell or set tools.shell=auto; codepunk does not fall back to cmd.exe",
    });
  }
  const sandboxIssue =
    typeof options.sandboxProbe === "function"
      ? await options.sandboxProbe()
      : await defaultSandboxProbe(options.paths, platform);
  checks.push({
    id: "srt",
    status: sandboxIssue === null ? "ok" : "error",
    message: sandboxIssue ?? "srt sandbox is available",
    hint: sandboxIssue === null ? null : sandboxFixHint(platform, sandboxIssue),
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
          : "run `codepunk setup` or `codepunk models list` and `codepunk models set <provider/model>`",
  });
  for (const binaryName of ["rg", "fd"] as const) {
    const binary = await resolveSearchBinary(binaryName, environment);
    checks.push({
      id: `search-${binaryName}`,
      status: binary === null ? "warn" : "ok",
      message:
        binary === null ? `${binaryName} was not found on PATH` : binary.path,
      hint: binary === null ? searchBinaryHint(platform, binaryName) : null,
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
  checks.push(await inspectPolicyDoctorCheck(options));
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
        ? "publish codepunk-cli or install from the repository checkout"
        : null,
  });
  return {
    ok: checks.every((check) => check.status !== "error"),
    platform,
    codepunkHome: options.paths.home,
    checks,
  };
}

function sanitizeDoctorPolicyText(text: string, paths: ProjectPaths): string {
  return text
    .replaceAll(paths.projectConfigDir, ".codepunk")
    .replaceAll(paths.home, "~/.codepunk")
    .replaceAll(paths.cwd, ".");
}

async function pathExistsNoFollow(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function inspectPolicyDoctorCheck(
  options: DoctorOptions,
): Promise<DoctorCheck> {
  const projectPolicyTrusted =
    options.projectPolicyTrusted ?? options.projectTrusted === true;
  try {
    const policy = await loadPolicyFiles(options.paths, {
      projectTrusted: projectPolicyTrusted,
    });
    const legacyWarnings = policy.warnings.filter((warning) =>
      warning.includes("legacy version 1"),
    );
    if (legacyWarnings.length > 0) {
      return {
        id: "policy",
        status: "warn",
        message: sanitizeDoctorPolicyText(
          legacyWarnings.join("; "),
          options.paths,
        ),
        hint: "upgrade policy.toml to version = 2 with justification, match, and not_match fixtures",
      };
    }
    const projectPolicyExists = await pathExistsNoFollow(policy.projectPath);
    const ignoredWarnings = projectPolicyExists
      ? policy.warnings.filter((warning) =>
          warning.startsWith("project policy ignored:"),
        )
      : [];
    if (ignoredWarnings.length > 0) {
      return {
        id: "policy",
        status: "warn",
        message: sanitizeDoctorPolicyText(
          ignoredWarnings.join("; "),
          options.paths,
        ),
        hint: "run `codepunk trust grant --policy` to enable .codepunk/policy.toml",
      };
    }
    const totalRules = policy.userRules.length + policy.projectRules.length;
    return {
      id: "policy",
      status: "ok",
      message:
        policy.layers.length === 0
          ? "no custom policy files configured"
          : `${totalRules} version 2 policy rule(s) verified`,
      hint: null,
    };
  } catch (error) {
    const rawMessage =
      error instanceof ConfigError && error.key !== undefined
        ? `[${error.key}] ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      id: "policy",
      status: "error",
      message: sanitizeDoctorPolicyText(rawMessage, options.paths),
      hint: "fix policy.toml syntax or version = 2 justification/match/not_match fixtures",
    };
  }
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
