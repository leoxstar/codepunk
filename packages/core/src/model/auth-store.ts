import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  CLAIM_LOCK_STALE_MS,
  CLAIM_LOCK_TIMEOUT_MS,
  withClaimFileLock,
} from "../platform/file-lock.ts";
import { atomicWriteFile } from "../platform/fs.ts";
import type { ProjectPaths } from "../platform/paths.ts";

export type ModelErrorCode =
  | "not_selected"
  | "not_found"
  | "not_enabled"
  | "no_auth"
  | "auth_failed"
  | "config"
  | "network";

export class ModelError extends Error {
  readonly code: ModelErrorCode;

  constructor(code: ModelErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelError";
    this.code = code;
  }
}

/**
 * Claim-lock-backed `auth.json` store. It implements Pi's credential-store
 * contract, including OAuth refresh, so every mutation is a serialized
 * cross-process read-modify-write and fails closed on lock timeout.
 */
export class LockedAuthStore implements CredentialStore {
  readonly authPath: string;

  constructor(authPath: string) {
    this.authPath = authPath;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    return withClaimFileLock(
      {
        lockDir: `${this.authPath}.lock.d`,
        timeoutMs: CLAIM_LOCK_TIMEOUT_MS,
        staleMs: CLAIM_LOCK_STALE_MS,
        busyError: () =>
          new ModelError(
            "auth_failed",
            "model auth store is locked by another process",
          ),
      },
      operation,
    );
  }

  private async readDocument(): Promise<Record<string, Credential>> {
    let content: string | null;
    try {
      content = await fs.readFile(this.authPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.replace(/^\uFEFF/u, ""));
    } catch (error) {
      throw new ModelError(
        "auth_failed",
        `cannot parse ${this.authPath}: ${(error as Error).message}`,
        { cause: error },
      );
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new ModelError(
        "auth_failed",
        `${this.authPath} must contain a JSON object keyed by provider`,
      );
    }
    return parsed as Record<string, Credential>;
  }

  private async writeDocument(
    credentials: Record<string, Credential>,
  ): Promise<void> {
    await atomicWriteFile(
      this.authPath,
      `${JSON.stringify(credentials, null, 2)}\n`,
      0o600,
    );
  }

  async read(
    providerId: string,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const credentials = await this.readDocument();
    return structuredClone(credentials[providerId]);
  }

  async list(_options?: AuthOperationOptions): Promise<CredentialInfo[]> {
    const credentials = await this.readDocument();
    return Object.entries(credentials).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    operation: (
      current: Credential | undefined,
    ) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return this.withLock(async () => {
      const credentials = await this.readDocument();
      const current = credentials[providerId];
      const next = await operation(structuredClone(current));
      options?.signal?.throwIfAborted();
      if (next !== undefined) {
        credentials[providerId] = next;
        await this.writeDocument(credentials);
      }
      return structuredClone(next ?? current);
    });
  }

  async delete(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    await this.withLock(async () => {
      const credentials = await this.readDocument();
      delete credentials[providerId];
      await this.writeDocument(credentials);
    });
  }
}

export async function openModelRuntime(
  paths: ProjectPaths,
): Promise<ModelRuntime> {
  const authPath = path.join(paths.home, "auth.json");
  return ModelRuntime.create({
    credentials: new LockedAuthStore(authPath),
    modelsPath: path.join(paths.home, "models.json"),
    allowModelNetwork: false,
  });
}

export async function setProviderAuthCredential(
  paths: ProjectPaths,
  providerId: string,
  credential: Credential,
): Promise<void> {
  const store = new LockedAuthStore(path.join(paths.home, "auth.json"));
  await store.modify(providerId, async () => credential);
}
