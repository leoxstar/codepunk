import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createUlid } from "codepunk-core";

const execFileAsync = promisify(execFile);

/**
 * Capture an image from the OS clipboard into the session's workspace-safe
 * clipboard directory so it can go through the normal /image validation,
 * confirmation, and evidence pipeline.
 */
export async function captureClipboardImage(
  workspaceRoot: string,
): Promise<string> {
  const dir = path.join(workspaceRoot, ".codepunk", "clipboard");
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `clipboard-${createUlid()}.png`);

  if (process.platform === "darwin") {
    const script = [
      `set targetFile to POSIX file ${JSON.stringify(target)}`,
      "try",
      "  set imgData to the clipboard as «class PNGf»",
      "on error",
      '  error "no PNG image found on clipboard"',
      "end try",
      "set f to open for access targetFile with write permission",
      "write imgData to f",
      "close access f",
    ].join("\n");
    await execFileAsync("osascript", ["-e", script], { timeout: 5_000 });
    const stat = await fs.stat(target);
    if (stat.size === 0) {
      await fs.rm(target, { force: true });
      throw new Error("clipboard image was empty");
    }
    return target;
  }

  if (process.platform === "linux") {
    const commands: readonly [string, readonly string[]][] = [
      ["wl-paste", ["--type", "image/png"]],
      ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
    ];
    for (const [cmd, args] of commands) {
      try {
        const { stdout } = await execFileAsync(cmd, [...args], {
          encoding: "buffer",
          maxBuffer: 16 * 1024 * 1024,
          timeout: 5_000,
        });
        if (stdout.byteLength > 0) {
          await fs.writeFile(target, stdout);
          return target;
        }
      } catch {
        continue;
      }
    }
    throw new Error(
      "no PNG image found on clipboard (tried wl-paste and xclip)",
    );
  }

  throw new Error(
    `clipboard image capture is not supported on ${process.platform}; pass a file path with /image <path>`,
  );
}
