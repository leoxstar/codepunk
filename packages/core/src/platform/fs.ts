import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function ensurePrivateDir(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(directory, 0o700);
  } catch {
    // Windows ACL handling is outside the POSIX mode surface.
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
        await handle.writeFile(content, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(tempPath, filePath);
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
