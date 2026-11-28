import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { sha256Bytes } from "../platform/hash.ts";
import { ensurePrivateDir } from "../platform/fs.ts";
import {
  isInsidePath,
  normalizeAbsolute,
  resolveRealPath,
} from "../platform/path.ts";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_GENERATED_BYTES = 20 * 1024 * 1024;
const MAX_PROMPT = 32_000;
const NOFOLLOW = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;

export class ImageCapabilityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ImageCapabilityError";
    this.code = code;
  }
}

export interface ConfirmedImage {
  path: string;
  display_path: string;
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  bytes: number;
  sha256: string;
  data: Buffer;
  redactions: string[];
}

function imageMime(data: Buffer): ConfirmedImage["mime"] | null {
  if (
    data.length >= 8 &&
    data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    data.length >= 6 &&
    (data.subarray(0, 6).toString("ascii") === "GIF87a" ||
      data.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function extension(mime: ConfirmedImage["mime"]): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
  }
}

const SENSITIVE_IMAGE_TEXT = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
] as const;

function assertNoSensitiveImageText(data: Buffer): void {
  const text = data.toString("latin1");
  if (SENSITIVE_IMAGE_TEXT.some((pattern) => pattern.test(text))) {
    throw new ImageCapabilityError(
      "image.sensitive_content",
      "image contains data that looks like a credential or private key",
    );
  }
}

export async function confirmImageInput(options: {
  path: string;
  allowedRoot: string;
  confirmed: boolean;
  maxBytes?: number;
  assertAllowed: () => Promise<void> | void;
}): Promise<ConfirmedImage> {
  if (options.confirmed !== true) {
    throw new ImageCapabilityError(
      "image.confirmation_required",
      "image input requires explicit user confirmation",
    );
  }
  if (typeof options.assertAllowed !== "function") {
    throw new ImageCapabilityError(
      "image.policy_required",
      "image input requires a policy decision callback",
    );
  }
  await options.assertAllowed();
  const root = resolveRealPath(options.allowedRoot);
  const requested = normalizeAbsolute(options.path);
  let requestedStat;
  try {
    requestedStat = await fs.lstat(requested);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ImageCapabilityError("image.file", "image input was not found");
    }
    throw error;
  }
  if (!requestedStat.isFile() || requestedStat.isSymbolicLink()) {
    throw new ImageCapabilityError(
      "image.file",
      "image input must be a regular file",
    );
  }
  const real = resolveRealPath(requested);
  if (!isInsidePath(root, real)) {
    throw new ImageCapabilityError(
      "image.outside_root",
      "image path must stay inside the allowed workspace",
    );
  }
  let data: Buffer;
  try {
    const handle = await fs.open(real, fsConstants.O_RDONLY | NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new ImageCapabilityError(
          "image.file",
          "image input must be a regular file",
        );
      }
      const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
      if (stat.size > maxBytes) {
        throw new ImageCapabilityError(
          "image.too_large",
          `image exceeds ${maxBytes} bytes`,
        );
      }
      data = await handle.readFile();
      if (data.byteLength > maxBytes) {
        throw new ImageCapabilityError(
          "image.too_large",
          `image exceeds ${maxBytes} bytes`,
        );
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ImageCapabilityError(
        "image.file",
        "image input must not be a symbolic link",
      );
    }
    throw error;
  }
  const mime = imageMime(data);
  if (mime === null) {
    throw new ImageCapabilityError(
      "image.unknown_format",
      "image must be PNG, JPEG, GIF, or WebP",
    );
  }
  assertNoSensitiveImageText(data);
  const relative = path.relative(root, real);
  const displayPath =
    relative.length > 0 && !relative.startsWith("..")
      ? relative.split(path.sep).join("/")
      : path.basename(real);
  return {
    path: real,
    display_path: displayPath,
    mime,
    bytes: data.byteLength,
    sha256: sha256Bytes(data),
    data,
    redactions: ["path"],
  };
}

export interface ImageGenerationAdapter {
  id: string;
  generate(request: { prompt: string }): Promise<Uint8Array>;
}

export interface GeneratedImage {
  id: string;
  adapter: string;
  policy_decision: "allow";
  prompt_sha256: string;
  path: string;
  mime: ConfirmedImage["mime"];
  bytes: number;
  sha256: string;
}

export async function generateImage(options: {
  prompt: string;
  adapter: ImageGenerationAdapter | null;
  artifactDir: string;
  assertAllowed: () => Promise<void> | void;
  appendEvidence: (record: GeneratedImage) => Promise<void>;
}): Promise<GeneratedImage> {
  const prompt = options.prompt.trim();
  if (prompt.length === 0 || prompt.length > MAX_PROMPT) {
    throw new ImageCapabilityError(
      "image.prompt",
      `image generation prompt must be 1-${MAX_PROMPT} characters`,
    );
  }
  if (options.adapter === null) {
    throw new ImageCapabilityError(
      "image.adapter_missing",
      "no image generation adapter is configured",
    );
  }
  if (typeof options.assertAllowed !== "function") {
    throw new ImageCapabilityError(
      "image.policy_required",
      "image generation requires a policy decision callback",
    );
  }
  if (typeof options.appendEvidence !== "function") {
    throw new ImageCapabilityError(
      "image.evidence_required",
      "image generation requires an evidence writer",
    );
  }
  await options.assertAllowed();
  const output = await options.adapter.generate({ prompt });
  const data = Buffer.from(output);
  if (data.byteLength === 0 || data.byteLength > MAX_GENERATED_BYTES) {
    throw new ImageCapabilityError(
      "image.output_size",
      `generated image must be 1-${MAX_GENERATED_BYTES} bytes`,
    );
  }
  const mime = imageMime(data);
  if (mime === null) {
    throw new ImageCapabilityError(
      "image.output_format",
      "image adapter returned an unsupported format",
    );
  }
  assertNoSensitiveImageText(data);
  const sha256 = sha256Bytes(data);
  const id = sha256.slice("sha256:".length, "sha256:".length + 24);
  const artifactDir = normalizeAbsolute(options.artifactDir);
  await ensurePrivateDir(artifactDir);
  const target = path.join(artifactDir, `${id}.${extension(mime)}`);
  try {
    await fs.writeFile(target, data, { mode: 0o600, flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new ImageCapabilityError(
        "image.artifact_conflict",
        "the generated image path is a symbolic link",
      );
    }
    if (code !== "EEXIST") {
      throw error;
    }
    const existingStat = await fs.lstat(target);
    if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
      throw new ImageCapabilityError(
        "image.artifact_conflict",
        "the generated image path is not a regular file",
      );
    }
    const existing = await fs.readFile(target);
    if (sha256Bytes(existing) !== sha256) {
      throw new ImageCapabilityError(
        "image.artifact_conflict",
        "the generated image path already has different content",
      );
    }
  }
  const record: GeneratedImage = {
    id,
    adapter: options.adapter.id,
    policy_decision: "allow",
    prompt_sha256: sha256Bytes(Buffer.from(prompt, "utf8")),
    path: target,
    mime,
    bytes: data.byteLength,
    sha256,
  };
  // The artifact is content-addressed and may already be referenced by a
  // concurrent writer. Keep it on evidence failure rather than deleting a
  // path this call does not exclusively own.
  await options.appendEvidence(record);
  return record;
}
