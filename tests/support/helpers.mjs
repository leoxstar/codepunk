import assert from "node:assert/strict";
import { execFile, execFileSync, execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  projectPaths,
  resolveCodepunkHome,
} from "../../packages/core/src/platform/paths.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

const execFileAsync = promisify(execFile);

/**
 * Resolve a Windows system tool without searching `PATH`. Git for Windows and
 * MSYS2 ship a `whoami` that rejects the Windows `/user` argument.
 */
function windowsSystemExecutable(name) {
  const systemRoot =
    process.env["SystemRoot"] ?? process.env["windir"] ?? "C:\\Windows";
  return path.win32.join(systemRoot, "System32", name);
}

/**
 * Windows principals that always mean "other local users". A named local
 * group is an environment fact that the product does not create, so it is
 * reported as detail instead of failing the check.
 */
const OTHER_USERS_PRINCIPALS = [
  /^everyone$/iu,
  /^authenticated users$/iu,
  /^nt authority\\authenticated users$/iu,
  /\\users$/iu,
  /\\guests$/iu,
];

/**
 * Windows principals that may hold access without widening the file to
 * other users. Anything outside this set must be an inherited entry: an
 * explicit entry would mean the product widened the access itself.
 */
const TRUSTED_WINDOWS_PRINCIPALS = [
  /^nt authority\\system$/iu,
  /^builtin\\administrators$/iu,
];

/**
 * Principals injected by the test harness itself. They are not another
 * interactive user, even though their names end in "Users".
 */
const ENVIRONMENT_WINDOWS_PRINCIPALS = [];

let currentWindowsIdentityCache;

/**
 * Return the name and SIDs carried by the current Windows process token.
 *
 * `icacls` prints a security identifier instead of a name when it cannot
 * resolve the principal. The invoking user and its groups are not "other
 * users" even when they appear in that form, so the privacy check must
 * resolve them before deciding that an explicit entry is foreign.
 */
async function currentWindowsIdentity() {
  if (currentWindowsIdentityCache !== undefined) {
    return currentWindowsIdentityCache;
  }
  const sids = new Set();
  let name = process.env["USERNAME"] ?? "";
  let sid = null;
  for (const args of [
    ["/user", "/fo", "csv", "/nh"],
    ["/groups", "/fo", "csv", "/nh"],
  ]) {
    try {
      const { stdout } = await execFileAsync(
        windowsSystemExecutable("whoami.exe"),
        args,
        { windowsHide: true },
      );
      for (const line of stdout.split(/\r?\n/u)) {
        const match = /^"([^"]*)","([^"]+)"/u.exec(line.trim());
        if (match !== null) {
          if (args[0] === "/user") {
            name = match[1];
            sid = match[2].toUpperCase();
          }
          sids.add(match[2].toUpperCase());
        }
      }
    } catch {
      // A host without whoami keeps the named-principal check only.
    }
  }
  currentWindowsIdentityCache = { name, sid, sids };
  return currentWindowsIdentityCache;
}

/**
 * Report whether a file is private to its owner.
 *
 * POSIX records owner-only access in the file mode, so the mode bits are
 * the whole answer. Windows has no POSIX modes: the product writes with
 * `mode: 0o600`, which the platform ignores, and the file keeps the DACL it
 * inherited from its directory. The checkable property there is that no
 * well-known other-users principal holds any right on the file.
 */
export async function privateFileStatus(filePath) {
  if (process.platform !== "win32") {
    const stat = await fs.stat(filePath);
    const mode = stat.mode & 0o777;
    return {
      ok: mode === 0o600,
      detail: `mode ${mode.toString(8)}`,
      otherUsers: [],
      explicitForeign: [],
    };
  }
  const { stdout } = await execFileAsync(
    windowsSystemExecutable("icacls.exe"),
    [filePath],
    {
      windowsHide: true,
    },
  );
  const entries = [];
  const lines = stdout.split(/\r?\n/u);
  for (const [index, rawLine] of lines.entries()) {
    let line = rawLine.trim();
    if (/^Mandatory Label/iu.test(line)) {
      continue;
    }
    if (index === 0 && line.startsWith(filePath)) {
      line = line.slice(filePath.length).trim();
    }
    const match = /^(.*?):(\([^)]*\))*\(([^)]*)\)\s*$/u.exec(line);
    if (match === null) {
      continue;
    }
    const flags = match[2] ?? "";
    entries.push({
      identity: match[1].trim(),
      rights: match[3].trim(),
      inherited: flags.includes("(I)"),
      deny: flags.includes("(DENY)"),
    });
  }
  const otherUsers = entries.filter(
    (entry) =>
      !entry.deny &&
      !ENVIRONMENT_WINDOWS_PRINCIPALS.some((pattern) =>
        pattern.test(entry.identity),
      ) &&
      OTHER_USERS_PRINCIPALS.some((pattern) => pattern.test(entry.identity)),
  );
  const identity = await currentWindowsIdentity();
  const owner = identity.name.toLowerCase();
  if (identity.sid !== null) {
    identity.sids.add(identity.sid);
  }
  const foreign = entries.filter(
    (entry) =>
      !entry.deny &&
      !/^(?:S-1-5-18|S-1-5-32-544)$/iu.test(entry.identity) &&
      entry.identity.toLowerCase() !== owner &&
      entry.identity.toUpperCase() !== identity.sid &&
      !TRUSTED_WINDOWS_PRINCIPALS.some((pattern) =>
        pattern.test(entry.identity),
      ),
  );
  return {
    ok: foreign.length === 0,
    detail: entries
      .map(
        (entry) =>
          `${entry.identity}:${entry.rights}${entry.inherited ? " (inherited)" : ""}`,
      )
      .join(", "),
    otherUsers,
    foreign,
  };
}

/**
 * Assert that a file is private to its owner, using the platform's own
 * mechanism. The failure detail lists every ACL entry so a Windows run
 * shows which principals can still reach the file.
 */
export async function assertPrivateFile(filePath, expectedMode = 0o600) {
  if (process.platform !== "win32") {
    const stat = await fs.stat(filePath);
    assert.equal(
      stat.mode & 0o777,
      expectedMode,
      `${filePath} mode ${(stat.mode & 0o777).toString(8)} is not ${expectedMode
        .toString(8)
        .padStart(3, "0")}`,
    );
    return;
  }
  const status = await privateFileStatus(filePath);
  assert.equal(
    status.ok,
    true,
    `${filePath} is not private to its owner (${status.detail})`,
  );
}

/**
 * Run an external command the way the host shell would. Windows package
 * managers are `.cmd` shims; `execFile` cannot launch those without a shell.
 * The caller passes fixed test arguments, never model output.
 */
export function execFilePortable(command, args, options = {}) {
  if (process.platform === "win32") {
    return execFileAsync(command, args, { ...options, shell: true });
  }
  return execFileAsync(command, args, options);
}

/**
 * Create the directory link a containment test needs.
 *
 * POSIX creates a symlink. Windows without the symlink privilege cannot
 * create one, but a directory junction needs no elevation and Node reports
 * it the same way: `lstat` says `isSymbolicLink()` and `realpath` resolves
 * it. The containment checks under test therefore still run.
 */
export async function createDirectoryLink(target, linkPath) {
  await fs.symlink(
    target,
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
}

/**
 * Create a linked entry that the product must refuse.
 *
 * POSIX links the target directly. Windows without the symlink privilege
 * cannot link a file, so the entry becomes a directory junction to
 * `junctionTarget`, a directory outside the workspace. Node reports a
 * junction exactly like a symlink: `lstat` says `isSymbolicLink()` and
 * `realpath` resolves it, so the refusal under test still runs.
 */
export async function createLinkedEntry(target, linkPath, junctionTarget) {
  if (process.platform === "win32") {
    await fs.symlink(junctionTarget, linkPath, "junction");
    return;
  }
  await fs.symlink(target, linkPath);
}

export const FILE_SYMLINK_SKIP_REASON =
  "needs the Windows symlink privilege (Developer Mode or an elevated shell)";

let fileSymlinkSupport;

/**
 * Report whether this machine can create a file symlink. Windows allows it
 * only with Developer Mode or an elevated shell, and the product's
 * file-level symlink refusals cannot be exercised without one.
 */
export async function canCreateFileSymlink() {
  if (fileSymlinkSupport !== undefined) {
    return fileSymlinkSupport;
  }
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "codepunk-symlink-probe-"),
  );
  try {
    const file = path.join(root, "file.txt");
    await fs.writeFile(file, "x");
    await fs.symlink(file, path.join(root, "link.txt"), "file");
    fileSymlinkSupport = true;
  } catch {
    fileSymlinkSupport = false;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  return fileSymlinkSupport;
}

/**
 * The version the built CLI must report. Reading the manifest keeps the
 * release bump to one edit instead of one edit per assertion.
 */
export const PRODUCT_VERSION = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "packages", "cli", "package.json"), "utf8"),
).version;

/** `0.1.0` becomes `0\.1\.0` so it can be dropped into a RegExp. */
export function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Ambient provider credentials make Pi resolve a model before any config
 * exists, so a suite that asserts the "no model configured" screens would
 * depend on whoever happens to run it. Children that must start from an empty
 * model catalog build their env from this instead of `process.env`.
 */
const AMBIENT_PROVIDER_KEY =
  /(?:_API_KEY|_AUTH_TOKEN|_BASE_URL|_CREDENTIALS)$|^ANTHROPIC_(?:DEFAULT_[A-Z]+_MODEL|SMALL_FAST_MODEL)$/u;

export function withoutAmbientProviderEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !AMBIENT_PROVIDER_KEY.test(key)),
  );
}

/**
 * The suite shells out to pnpm and npm. Both timeouts are configurable because a
 * cold runner or a slow registry mirror legitimately needs longer than a warm
 * laptop, and a hard-coded value turns "slower than my machine" into "broken".
 */
export const DEFAULT_INSTALL_TIMEOUT_MS =
  process.platform === "win32" ? 600_000 : 120_000;
export const DEFAULT_BUILD_TIMEOUT_MS = 600_000;

const NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ERR_SOCKET_TIMEOUT",
]);

const NETWORK_PATTERN =
  /(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ERR_SOCKET_TIMEOUT|socket hang up|fetch failed|getaddrinfo|npm ERR! code E(?:40[13]|429|5\d\d))/iu;

export function resolveTimeoutMs(envName, fallback, env = process.env) {
  const raw = env[envName];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${envName} must be a positive integer number of milliseconds, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

export function resolveInstallTimeoutMs(env = process.env) {
  return resolveTimeoutMs(
    "CODEPUNK_TEST_INSTALL_TIMEOUT_MS",
    DEFAULT_INSTALL_TIMEOUT_MS,
    env,
  );
}

export function resolveBuildTimeoutMs(env = process.env) {
  return resolveTimeoutMs(
    "CODEPUNK_TEST_BUILD_TIMEOUT_MS",
    DEFAULT_BUILD_TIMEOUT_MS,
    env,
  );
}

/**
 * A killed child means we ran out of time. A name-resolution or socket failure
 * means we never reached the other side, so the run says nothing about the code
 * under test. Anything else is a real failure of the thing being checked.
 */
export function classifyCommandFailure(error) {
  if (error === null || typeof error !== "object") {
    return "assertion";
  }
  if (error.killed === true) {
    return "timeout";
  }
  if (error.signal === "SIGTERM" || error.signal === "SIGKILL") {
    return "timeout";
  }
  if (typeof error.code === "string" && NETWORK_ERROR_CODES.has(error.code)) {
    return "network";
  }
  const message = typeof error.message === "string" ? error.message : "";
  const stderr = typeof error.stderr === "string" ? error.stderr : "";
  if (NETWORK_PATTERN.test(`${message}\n${stderr}`)) {
    return "network";
  }
  return "assertion";
}

function failureDetail(error) {
  if (error === null || typeof error !== "object") {
    return String(error);
  }
  const message = typeof error.message === "string" ? error.message : "";
  const stderr = typeof error.stderr === "string" ? error.stderr : "";
  const text = stderr.trim() === "" ? message : `${message}\n${stderr}`;
  const bounded = text.split("\n").slice(0, 12).join("\n").trim();
  return bounded === "" ? "no error detail" : bounded;
}

export function describeInstallFailure(error, timeoutMs) {
  const kind = classifyCommandFailure(error);
  const advice = {
    timeout: `npm install produced no result within ${timeoutMs}ms. Treat a repeated timeout as a distribution problem rather than a test problem; raise CODEPUNK_TEST_INSTALL_TIMEOUT_MS only when the machine or the registry is genuinely slow.`,
    network: `npm install could not reach a package host, so this run says nothing about whether the packed tarballs are correct. Re-run with network access before reporting a distribution regression.`,
    assertion: `npm install reached the registry and still failed, so the packed tarballs, their manifest, or the installed layout are wrong.`,
  }[kind];
  return `distribution install failed (${kind}): ${failureDetail(error)}\n${advice}`;
}

export function describeBuildFailure(error, timeoutMs) {
  const kind = classifyCommandFailure(error);
  const advice = {
    timeout: `pnpm run build produced no result within ${timeoutMs}ms. Raise CODEPUNK_TEST_BUILD_TIMEOUT_MS on a slow machine; a repeated timeout means the build is stuck rather than slow.`,
    network: `pnpm run build could not reach a package host, so this run says nothing about whether the sources compile.`,
    assertion: `pnpm run build ran and failed, so the compiler or the packager rejected the sources.`,
  }[kind];
  return `test setup failed (${kind}): ${failureDetail(error)}\n${advice}`;
}

export async function withTempDirectory(prefix, callback) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  try {
    return await callback(directory);
  } finally {
    await removeTempDirectory(directory);
  }
}

/**
 * On Windows the system temp directory can be a per-user drive mapping that
 * the srt sandbox account cannot see. srt refuses such a working directory
 * with `mapped_drive_cwd`. Keep srt-backed test roots on the same local drive
 * as the checkout unless the caller names one explicitly.
 */
export function sandboxTempBase(environment = process.env) {
  const configured = environment["CODEPUNK_TEST_TMPDIR"];
  if (configured !== undefined && configured.trim().length > 0) {
    return path.resolve(configured);
  }
  if (process.platform !== "win32") {
    return os.tmpdir();
  }
  return path.join(path.dirname(REPO_ROOT), ".verify", "tmp");
}

export async function withSandboxTempDirectory(prefix, callback) {
  const base = sandboxTempBase();
  await fs.mkdir(base, { recursive: true });
  return withTempDirectoryIn(base, prefix, callback);
}

async function withTempDirectoryIn(base, prefix, callback) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(base, prefix)),
  );
  try {
    return await callback(directory);
  } finally {
    await removeTempDirectory(directory);
  }
}

/**
 * Remove a test root after the process that used it has exited.
 *
 * Windows can briefly keep a directory busy after a ConPTY child and its
 * sandbox helper exit. A single `rm` turns that timing into a test failure
 * even though no product state is wrong, so retry the recursive removal on
 * the platform where the race exists.
 */
async function removeTempDirectory(directory) {
  await fs.rm(directory, {
    recursive: true,
    force: true,
    ...(process.platform === "win32"
      ? { maxRetries: 10, retryDelay: 100 }
      : {}),
  });
}

/**
 * Return a skip reason when the Windows srt runtime cannot run. The probe is
 * stateless: it must not initialize a session or stamp ACLs just to decide
 * whether a test should run.
 */
export async function windowsSrtSkipReason(core) {
  if (process.platform !== "win32") {
    return "Windows-only srt integration path";
  }
  const base = sandboxTempBase();
  const issue = await core.probeSrtSandbox({
    cwd: base,
    workspaceRoot: base,
    deliveryRoot: base,
    codepunkHome: path.join(base, "home"),
    writeSet: [],
  });
  return issue === null ? false : `srt is unavailable: ${issue}`;
}

export async function makeProject(root, name = "project") {
  const projectRoot = path.join(root, name);
  await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, ".codepunk"), { recursive: true });
  const paths = projectPaths(
    {
      cwd: projectRoot,
      deliveryRoot: projectRoot,
      projectId: "0123456789abcdef",
    },
    path.join(root, "home"),
  );
  await fs.mkdir(paths.projectDir, { recursive: true });
  for (const directory of [
    paths.sessionsDir,
    paths.evidenceDir,
    paths.verdictsDir,
    paths.artifactsDir,
    paths.memoryDir,
  ]) {
    await fs.mkdir(directory, { recursive: true });
  }
  await trustWorkspace(paths.home, projectRoot);
  return { projectRoot, paths };
}

/**
 * Record a saved workspace-trust decision next to a Codepunk home so tests
 * exercise the trusted path. Real users get the same store from
 * `codepunk trust grant` or the first-run prompt.
 */
export async function trustWorkspace(home, projectRoot) {
  const realHome = resolveCodepunkHome({ CODEPUNK_HOME: home });
  const real = await fs.realpath(projectRoot);
  await fs.mkdir(realHome, { recursive: true });
  const trustPath = path.join(realHome, "trust.json");
  let data = {};
  try {
    data = JSON.parse(await fs.readFile(trustPath, "utf8"));
  } catch {
    data = {};
  }
  data[real] = true;
  await fs.writeFile(trustPath, `${JSON.stringify(data, null, 2)}\n`);
  return trustPath;
}

export async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

export function fixedClock(start = "2026-11-12T00:00:00.000Z", stepMs = 1000) {
  let current = new Date(start);
  return () => {
    const value = new Date(current);
    current = new Date(current.getTime() + stepMs);
    return value;
  };
}

async function newestSourceMtime() {
  let newest = 0;
  for (const packageName of ["protocol", "core", "cli"]) {
    const root = path.join(REPO_ROOT, "packages", packageName, "src");
    const entries = await fs.readdir(root, { recursive: true });
    for (const entry of entries) {
      const candidate = path.join(root, entry);
      const stat = await fs.stat(candidate).catch(() => null);
      if (stat?.isFile() === true) {
        newest = Math.max(newest, stat.mtimeMs);
      }
    }
  }
  return newest;
}

export async function ensureBuilt() {
  const cliEntry = path.join(REPO_ROOT, "packages", "cli", "dist", "index.js");
  const sourceTime = await newestSourceMtime();
  const builtTime = await fs
    .stat(cliEntry)
    .then((stat) => stat.mtimeMs)
    .catch(() => 0);
  if (builtTime >= sourceTime && builtTime > 0) {
    return cliEntry;
  }
  const lock = path.join(os.tmpdir(), "codepunk-build.lock");
  let acquired = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await fs.mkdir(lock);
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try {
    if (acquired) {
      const current = await fs.stat(cliEntry).catch(() => null);
      if (current === null || current.mtimeMs < sourceTime) {
        const buildTimeoutMs = resolveBuildTimeoutMs();
        try {
          const buildOptions = {
            cwd: REPO_ROOT,
            stdio: "pipe",
            timeout: buildTimeoutMs,
          };
          if (process.platform === "win32") {
            // pnpm is a .cmd shim on Windows and cannot be launched by
            // execFileSync without a shell.
            execSync("pnpm run build", buildOptions);
          } else {
            execFileSync("pnpm", ["run", "build"], buildOptions);
          }
        } catch (error) {
          throw new Error(describeBuildFailure(error, buildTimeoutMs));
        }
      }
    }
  } finally {
    if (acquired) {
      await fs.rm(lock, { recursive: true, force: true });
    }
  }
  return cliEntry;
}
