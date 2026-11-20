import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WINDOWS_PRIVATE_SIDS = new Set(["S-1-5-18", "S-1-5-32-544"]);

interface WindowsPrivateAclOptions {
  directory: boolean;
}

function windowsAce(sid: string, options: WindowsPrivateAclOptions): string {
  return options.directory ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
}

async function currentWindowsSid(): Promise<string> {
  const { stdout } = await execFileAsync(
    "whoami",
    ["/user", "/fo", "csv", "/nh"],
    { windowsHide: true },
  );
  const line = stdout.trim().split(/\r?\n/u)[0] ?? "";
  const match = /^"([^"]*)","([^"]+)"/u.exec(line);
  if (match === null) {
    throw new Error("cannot resolve the current Windows user SID");
  }
  return match[2]!.toUpperCase();
}

async function icacls(
  target: string,
  args: readonly string[],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("icacls", [target, ...args], {
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`icacls failed for ${target}: ${detail}`, {
      cause: error,
    });
  }
}

function aclEntries(output: string, target: string): string[] {
  const entries: string[] = [];
  for (const rawLine of output.split(/\r?\n/u)) {
    let line = rawLine.trim();
    if (/^(?:Successfully processed|Mandatory Label)/iu.test(line)) {
      continue;
    }
    if (line.toLowerCase().startsWith(target.toLowerCase())) {
      line = line.slice(target.length).trim();
    }
    const match = /^(.*?):(\([^)]*\))*\(([^)]*)\)$/u.exec(line);
    if (match === null) {
      continue;
    }
    entries.push(match[1]!.trim());
  }
  return entries;
}

function trustedWindowsPrincipal(
  identity: string,
  currentSid: string,
  currentName: string,
): boolean {
  const normalized = identity.replace(/^\*/u, "").toUpperCase();
  if (normalized === currentSid || WINDOWS_PRIVATE_SIDS.has(normalized)) {
    return true;
  }
  const lower = identity.toLowerCase();
  const current = currentName.toLowerCase();
  return (
    lower === "nt authority\\system" ||
    lower === "builtin\\administrators" ||
    (current.length > 0 && lower === current)
  );
}

async function currentWindowsName(): Promise<string> {
  const { stdout } = await execFileAsync("whoami", [], {
    windowsHide: true,
  });
  return stdout.trim();
}

/**
 * Replace the DACL with exactly the current user, SYSTEM, and
 * Administrators. `icacls /inheritance:r` cuts the parent's inheritable
 * ACEs; the explicit foreign ACEs are removed one by one before the
 * grants are replaced.
 */
async function ensureWindowsPrivateAcl(
  target: string,
  options: WindowsPrivateAclOptions,
): Promise<void> {
  const sid = await currentWindowsSid();
  let name = "";
  try {
    name = await currentWindowsName();
  } catch {
    // The SID is enough for the whitelist check.
  }
  await icacls(target, ["/inheritance:r"]);
  const current = await icacls(target, []);
  for (const identity of new Set(aclEntries(current, target))) {
    if (!trustedWindowsPrincipal(identity, sid, name)) {
      try {
        await icacls(target, ["/remove:g", identity]);
      } catch {
        // Verification below fails if the ACE is still present.
      }
      try {
        await icacls(target, ["/remove:d", identity]);
      } catch {
        // A missing deny ACE is not an error.
      }
    }
  }
  await icacls(target, [
    "/grant:r",
    windowsAce(sid, options),
    "/grant:r",
    windowsAce("S-1-5-18", options),
    "/grant:r",
    windowsAce("S-1-5-32-544", options),
  ]);
  const verified = await icacls(target, []);
  const foreign = aclEntries(verified, target).filter(
    (identity) => !trustedWindowsPrincipal(identity, sid, name),
  );
  if (foreign.length > 0) {
    throw new Error(
      `private ACL still grants ${[...new Set(foreign)].join(", ")} on ${target}`,
    );
  }
}

export async function ensurePrivateDir(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    await ensureWindowsPrivateAcl(directory, { directory: true });
    return;
  }
  try {
    await fs.chmod(directory, 0o700);
  } catch {
    // The directory may live on a filesystem without POSIX mode support.
  }
  stampedPrivateDirs.add(directory);
}

export async function ensurePrivateFile(
  filePath: string,
  mode = 0o600,
): Promise<void> {
  const key = `${filePath}\0${mode}`;
  if (process.platform !== "win32") {
    if (stampedPrivateFiles.has(key)) {
      return;
    }
    try {
      await fs.chmod(filePath, mode);
    } catch {
      // The file may live on a filesystem without POSIX mode support.
    }
    stampedPrivateFiles.add(key);
    return;
  }
  if (stampedPrivateFiles.has(key)) {
    return;
  }
  await ensureWindowsPrivateAcl(filePath, { directory: false });
  stampedPrivateFiles.add(key);
}

const V9FS_SUPER_MAGIC = 0x01021997;
const FUSE_SUPER_MAGIC = 0x65735546;

/**
 * Windows and WSL's synthetic mounts report owner and mode bits that do not
 * describe the real access policy. Only enforce POSIX owner/mode checks when
 * the filesystem can supply those bits.
 */
export async function posixMetadataIsReliable(
  target: string,
): Promise<boolean> {
  if (process.platform === "win32") {
    return false;
  }
  try {
    const stats = await fs.statfs(target);
    if (stats.type === V9FS_SUPER_MAGIC) {
      return false;
    }
    if (
      stats.type === FUSE_SUPER_MAGIC &&
      process.env["WSL_DISTRO_NAME"] !== undefined
    ) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

async function removeTemp(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // The temp file may already have been renamed or never created.
  }
}

export async function atomicWriteFile(
  filePath: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  await atomicWriteBytes(filePath, Buffer.from(content, "utf8"), mode);
}

export async function atomicWriteBytes(
  filePath: string,
  content: Uint8Array,
  mode = 0o600,
): Promise<void> {
  const directory = path.dirname(filePath);
  await ensurePrivateDir(directory);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let lastError: unknown;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        handle = await fs.open(tempPath, "wx", mode);
        await handle.writeFile(content);
        await handle.sync();
        await handle.close();
        handle = undefined;
        const privateFile = (mode & 0o077) === 0;
        if (privateFile) {
          await ensurePrivateFile(tempPath, mode);
        }
        await fs.rename(tempPath, filePath);
        if (privateFile) {
          await ensurePrivateFile(filePath, mode);
        }
        return;
      } catch (error) {
        lastError = error;
        if (handle !== undefined) {
          await handle.close();
          handle = undefined;
        }
        await removeTemp(tempPath);
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EBUSY" && code !== "EAGAIN") {
          throw error;
        }
        if (attempt === 3) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
  }
  throw lastError ?? new Error(`failed to atomically write ${filePath}`);
}

export async function appendFileSynced(
  filePath: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  await ensurePrivateDir(path.dirname(filePath));
  const created = await fs.open(filePath, "a", mode);
  await created.close();
  await ensurePrivateFile(filePath);
  const handle = await fs.open(filePath, "a", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value)}\n`);
}
