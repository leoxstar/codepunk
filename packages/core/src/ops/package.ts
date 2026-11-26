import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CLI_PACKAGE_NAME = "codepunk-cli";

export interface NpmInvocation {
  command: string;
  args: string[];
}

export interface NpmResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type NpmRunner = (
  invocation: NpmInvocation,
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<NpmResult>;

export interface PackageActionOptions {
  prefix?: string | null;
  version?: string;
  cwd?: string;
  dryRun?: boolean;
  npmCommand?: string;
  run?: NpmRunner;
  environment?: NodeJS.ProcessEnv;
}

export interface PackageActionResult {
  verb: "install" | "upgrade" | "uninstall";
  packageName: string;
  version: string | null;
  previousVersion: string | null;
  prefix: string | null;
  command: NpmInvocation;
  dryRun: boolean;
  result: NpmResult | null;
  rollback: NpmResult | null;
  rollbackVersion: string | null;
}

export class PackageActionError extends Error {
  readonly code: string;
  readonly result: NpmResult | null;

  constructor(code: string, message: string, result: NpmResult | null = null) {
    super(message);
    this.name = "PackageActionError";
    this.code = code;
    this.result = result;
  }
}

const defaultRunner: NpmRunner = async (invocation, options) => {
  try {
    const result = await execFileAsync(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeout: options.timeoutMs ?? 300_000,
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? String(error),
    };
  }
};

function normalizePrefix(prefix: string | null | undefined): string | null {
  if (prefix === null || prefix === undefined) {
    return null;
  }
  if (!path.isAbsolute(prefix)) {
    throw new PackageActionError(
      "package.prefix_relative",
      "package prefix must be an absolute path",
    );
  }
  return path.normalize(prefix);
}

function globalArgs(prefix: string | null): string[] {
  return prefix === null ? ["--global"] : ["--global", "--prefix", prefix];
}

function invocation(
  verb: "install" | "upgrade" | "uninstall",
  prefix: string | null,
  version: string | null,
): NpmInvocation {
  if (verb === "uninstall") {
    return {
      command: "npm",
      args: ["uninstall", ...globalArgs(prefix), CLI_PACKAGE_NAME],
    };
  }
  return {
    command: "npm",
    args: [
      "install",
      ...globalArgs(prefix),
      "--no-audit",
      "--no-fund",
      `${CLI_PACKAGE_NAME}@${version ?? "latest"}`,
    ],
  };
}

function listInvocation(prefix: string | null): NpmInvocation {
  return {
    command: "npm",
    args: [
      "list",
      ...globalArgs(prefix),
      "--json",
      "--depth=0",
      CLI_PACKAGE_NAME,
    ],
  };
}

function installedVersion(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as {
      dependencies?: Record<string, { version?: unknown }>;
    };
    const entry = parsed.dependencies?.[CLI_PACKAGE_NAME];
    return typeof entry?.version === "string" ? entry.version : null;
  } catch {
    return null;
  }
}

function withCommand(
  base: PackageActionOptions,
  command: NpmInvocation,
): NpmInvocation {
  return {
    command: base.npmCommand ?? command.command,
    args: [...command.args],
  };
}

async function run(
  base: PackageActionOptions,
  command: NpmInvocation,
): Promise<NpmResult> {
  return (base.run ?? defaultRunner)(withCommand(base, command), {
    cwd: base.cwd ?? process.cwd(),
    ...(base.environment !== undefined ? { env: base.environment } : {}),
  });
}

function ensureSuccess(verb: string, result: NpmResult): void {
  if (result.code === 0) {
    return;
  }
  throw new PackageActionError(
    "package.command_failed",
    `npm ${verb} failed with exit code ${result.code}: ${
      result.stderr.trim() || result.stdout.trim() || "no output"
    }`,
    result,
  );
}

export async function installPackage(
  options: PackageActionOptions = {},
): Promise<PackageActionResult> {
  const prefix = normalizePrefix(options.prefix);
  const version = options.version ?? null;
  const command = withCommand(options, invocation("install", prefix, version));
  if (options.dryRun === true) {
    return {
      verb: "install",
      packageName: CLI_PACKAGE_NAME,
      version,
      previousVersion: null,
      prefix,
      command,
      dryRun: true,
      result: null,
      rollback: null,
      rollbackVersion: null,
    };
  }
  const result = await run(options, command);
  ensureSuccess("install", result);
  return {
    verb: "install",
    packageName: CLI_PACKAGE_NAME,
    version,
    previousVersion: null,
    prefix,
    command,
    dryRun: false,
    result,
    rollback: null,
    rollbackVersion: null,
  };
}

export async function upgradePackage(
  options: PackageActionOptions = {},
): Promise<PackageActionResult> {
  const prefix = normalizePrefix(options.prefix);
  const previousResult = await run(options, listInvocation(prefix));
  const previousVersion =
    previousResult.code === 0 ? installedVersion(previousResult.stdout) : null;
  const command = withCommand(options, invocation("upgrade", prefix, "latest"));
  if (options.dryRun === true) {
    return {
      verb: "upgrade",
      packageName: CLI_PACKAGE_NAME,
      version: "latest",
      previousVersion,
      prefix,
      command,
      dryRun: true,
      result: null,
      rollback: null,
      rollbackVersion: null,
    };
  }
  const result = await run(options, command);
  if (result.code === 0) {
    return {
      verb: "upgrade",
      packageName: CLI_PACKAGE_NAME,
      version: "latest",
      previousVersion,
      prefix,
      command,
      dryRun: false,
      result,
      rollback: null,
      rollbackVersion: null,
    };
  }
  if (previousVersion === null) {
    ensureSuccess("upgrade", result);
  }
  const rollbackCommand = withCommand(
    options,
    invocation("install", prefix, previousVersion),
  );
  const rollback = await run(options, rollbackCommand);
  if (rollback.code !== 0) {
    throw new PackageActionError(
      "package.rollback_failed",
      `npm upgrade failed and rollback to ${previousVersion} also failed`,
      result,
    );
  }
  throw new PackageActionError(
    "package.upgrade_rolled_back",
    `npm upgrade failed with exit code ${result.code}; restored ${previousVersion}`,
    result,
  );
}

export interface PackageUpdateCheckOptions {
  currentVersion: string;
  environment?: NodeJS.ProcessEnv;
  registryUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface PackageUpdateCheckResult {
  status: "ok" | "offline" | "error";
  packageName: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  message: string;
}

function parseSemverCore(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version.trim());
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewerSemver(current: string, latest: string): boolean {
  const a = parseSemverCore(current);
  const b = parseSemverCore(latest);
  if (a === null || b === null) {
    return false;
  }
  for (let i = 0; i < 3; i += 1) {
    if (b[i]! !== a[i]!) {
      return b[i]! > a[i]!;
    }
  }
  // If core tuple is identical, treat a non-prerelease latest as newer than prerelease current.
  return current.includes("-") && !latest.includes("-");
}

export async function checkPackageUpdate(
  options: PackageUpdateCheckOptions,
): Promise<PackageUpdateCheckResult> {
  const env = options.environment ?? process.env;
  if (env["PI_OFFLINE"] === "1" || env["CODEPUNK_OFFLINE"] === "1") {
    return {
      status: "offline",
      packageName: CLI_PACKAGE_NAME,
      currentVersion: options.currentVersion,
      latestVersion: null,
      updateAvailable: false,
      message: "offline mode is active; skipped registry update check",
    };
  }
  const baseUrl = (options.registryUrl ?? "https://registry.npmjs.org").replace(
    /\/+$/u,
    "",
  );
  const url = `${baseUrl}/${CLI_PACKAGE_NAME}/latest`;
  const fetchFn = options.fetchImpl ?? fetch;
  try {
    const response = await fetchFn(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (!response.ok) {
      return {
        status: "error",
        packageName: CLI_PACKAGE_NAME,
        currentVersion: options.currentVersion,
        latestVersion: null,
        updateAvailable: false,
        message: `registry check failed with HTTP ${response.status}`,
      };
    }
    const payload = (await response.json()) as { version?: unknown };
    const latestVersion =
      typeof payload?.version === "string" ? payload.version.trim() : "";
    if (latestVersion.length === 0) {
      return {
        status: "error",
        packageName: CLI_PACKAGE_NAME,
        currentVersion: options.currentVersion,
        latestVersion: null,
        updateAvailable: false,
        message: "registry response did not include a package version",
      };
    }
    const updateAvailable = isNewerSemver(
      options.currentVersion,
      latestVersion,
    );
    return {
      status: "ok",
      packageName: CLI_PACKAGE_NAME,
      currentVersion: options.currentVersion,
      latestVersion,
      updateAvailable,
      message: updateAvailable
        ? `update available: ${options.currentVersion} -> ${latestVersion} (run \`codepunk upgrade\`)`
        : `${CLI_PACKAGE_NAME}@${options.currentVersion} is up to date (latest ${latestVersion})`,
    };
  } catch (error) {
    return {
      status: "error",
      packageName: CLI_PACKAGE_NAME,
      currentVersion: options.currentVersion,
      latestVersion: null,
      updateAvailable: false,
      message: `registry check failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function uninstallPackage(
  options: PackageActionOptions = {},
): Promise<PackageActionResult> {
  const prefix = normalizePrefix(options.prefix);
  const command = withCommand(options, invocation("uninstall", prefix, null));
  if (options.dryRun === true) {
    return {
      verb: "uninstall",
      packageName: CLI_PACKAGE_NAME,
      version: null,
      previousVersion: null,
      prefix,
      command,
      dryRun: true,
      result: null,
      rollback: null,
      rollbackVersion: null,
    };
  }
  const result = await run(options, command);
  ensureSuccess("uninstall", result);
  return {
    verb: "uninstall",
    packageName: CLI_PACKAGE_NAME,
    version: null,
    previousVersion: null,
    prefix,
    command,
    dryRun: false,
    result,
    rollback: null,
    rollbackVersion: null,
  };
}
