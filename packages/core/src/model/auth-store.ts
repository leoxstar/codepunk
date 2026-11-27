import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseToml } from "../config/toml.ts";
import type { CredentialStoreMode } from "../config/types.ts";
import {
  CLAIM_LOCK_STALE_MS,
  CLAIM_LOCK_TIMEOUT_MS,
  withClaimFileLock,
} from "../platform/file-lock.ts";
import { atomicWriteFile } from "../platform/fs.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import { createNativeKeychainDriver, type KeychainDriver } from "./keychain.ts";

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

export interface KeychainPointerRecord {
  readonly type: Credential["type"];
  readonly storage: "keychain";
}

type StoredCredentialEntry = Credential | KeychainPointerRecord;

function isKeychainPointer(
  entry: StoredCredentialEntry | undefined,
): entry is KeychainPointerRecord {
  return (
    entry !== undefined &&
    typeof entry === "object" &&
    entry !== null &&
    (entry as { storage?: unknown }).storage === "keychain"
  );
}

export interface LockedAuthStoreOptions {
  readonly mode?: CredentialStoreMode;
  readonly keychainDriver?: KeychainDriver;
}

export interface CredentialStorageProviderStatus {
  readonly providerId: string;
  readonly type: Credential["type"];
  readonly storage: "file" | "keychain";
}

export interface CredentialStorageStatus {
  readonly authPath: string;
  readonly configuredMode: CredentialStoreMode;
  readonly keychainBackend: string;
  readonly keychainAvailable: boolean;
  readonly providers: readonly CredentialStorageProviderStatus[];
}

export interface CredentialKeychainMigrationResult {
  readonly migratedProviders: readonly string[];
  readonly alreadyKeychainProviders: readonly string[];
  readonly authPath: string;
  readonly keychainBackend: string;
}

async function readUserCredentialStoreMode(
  home: string,
): Promise<CredentialStoreMode> {
  try {
    const raw = await fs.readFile(path.join(home, "config.toml"), "utf8");
    const parsed = parseToml(raw);
    const modelTable = parsed["model"];
    if (
      modelTable !== null &&
      typeof modelTable === "object" &&
      !Array.isArray(modelTable)
    ) {
      const mode = (modelTable as Record<string, unknown>)["credential_store"];
      if (mode === "file" || mode === "keychain" || mode === "auto") {
        return mode;
      }
    }
  } catch {
    // Fall back to default "file" mode when config.toml is absent or unreadable here.
  }
  return "file";
}

/**
 * Claim-lock-backed `auth.json` store with optional OS Keychain secret offload.
 * It implements Pi's credential-store contract, including OAuth refresh, so
 * every mutation is a serialized cross-process read-modify-write and fails
 * closed on lock timeout or unavailable keychain reads.
 */
export class LockedAuthStore implements CredentialStore {
  readonly authPath: string;
  private readonly mode: CredentialStoreMode;
  private readonly keychain: KeychainDriver;

  constructor(authPath: string, options: LockedAuthStoreOptions = {}) {
    this.authPath = authPath;
    this.mode = options.mode ?? "file";
    this.keychain = options.keychainDriver ?? createNativeKeychainDriver();
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

  private async readDocument(): Promise<Record<string, StoredCredentialEntry>> {
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
    return parsed as Record<string, StoredCredentialEntry>;
  }

  private async writeDocument(
    credentials: Record<string, StoredCredentialEntry>,
  ): Promise<void> {
    await atomicWriteFile(
      this.authPath,
      `${JSON.stringify(credentials, null, 2)}\n`,
      0o600,
    );
  }

  private async hydrateEntry(
    providerId: string,
    entry: StoredCredentialEntry | undefined,
  ): Promise<Credential | undefined> {
    if (entry === undefined) {
      return undefined;
    }
    if (!isKeychainPointer(entry)) {
      return structuredClone(entry);
    }
    let rawSecret: string | null;
    try {
      rawSecret = await this.keychain.getSecret(providerId);
    } catch (error) {
      throw new ModelError(
        "auth_failed",
        `cannot read keychain credential for ${providerId}: ${(error as Error).message}`,
        { cause: error },
      );
    }
    if (rawSecret === null || rawSecret.trim().length === 0) {
      throw new ModelError(
        "auth_failed",
        `credential for ${providerId} is marked as keychain-backed in ${this.authPath}, but no secret was found in ${this.keychain.backendName}`,
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawSecret);
    } catch (error) {
      throw new ModelError(
        "auth_failed",
        `corrupt keychain credential payload for ${providerId}`,
        { cause: error },
      );
    }
    if (
      decoded === null ||
      typeof decoded !== "object" ||
      Array.isArray(decoded) ||
      typeof (decoded as { type?: unknown }).type !== "string"
    ) {
      throw new ModelError(
        "auth_failed",
        `invalid keychain credential object for ${providerId}`,
      );
    }
    return structuredClone(decoded as Credential);
  }

  private async shouldStoreInKeychain(): Promise<boolean> {
    if (this.mode === "file") {
      return false;
    }
    if (this.mode === "keychain") {
      const available = await this.keychain.isAvailable();
      if (!available) {
        throw new ModelError(
          "auth_failed",
          `model.credential_store is set to "keychain", but ${this.keychain.backendName} is unavailable`,
        );
      }
      return true;
    }
    return await this.keychain.isAvailable();
  }

  async read(
    providerId: string,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const credentials = await this.readDocument();
    return await this.hydrateEntry(providerId, credentials[providerId]);
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
      const current = await this.hydrateEntry(
        providerId,
        credentials[providerId],
      );
      const next = await operation(structuredClone(current));
      options?.signal?.throwIfAborted();
      if (next !== undefined) {
        const useKeychain =
          (await this.shouldStoreInKeychain()) ||
          isKeychainPointer(credentials[providerId]);
        if (useKeychain) {
          try {
            await this.keychain.setSecret(providerId, JSON.stringify(next));
          } catch (error) {
            throw new ModelError(
              "auth_failed",
              `cannot store credential for ${providerId} in ${this.keychain.backendName}: ${(error as Error).message}`,
              { cause: error },
            );
          }
          credentials[providerId] = {
            type: next.type,
            storage: "keychain",
          };
        } else {
          credentials[providerId] = next;
        }
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
      const existing = credentials[providerId];
      delete credentials[providerId];
      await this.writeDocument(credentials);
      if (isKeychainPointer(existing) || this.mode !== "file") {
        await this.keychain.deleteSecret(providerId).catch(() => undefined);
      }
    });
  }

  async inspectStorage(
    configuredMode: CredentialStoreMode = this.mode,
  ): Promise<CredentialStorageStatus> {
    const credentials = await this.readDocument();
    const keychainAvailable = await this.keychain.isAvailable();
    const providers: CredentialStorageProviderStatus[] = Object.entries(
      credentials,
    )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([providerId, entry]) => ({
        providerId,
        type: entry.type,
        storage: isKeychainPointer(entry) ? "keychain" : "file",
      }));
    return {
      authPath: this.authPath,
      configuredMode,
      keychainBackend: this.keychain.backendName,
      keychainAvailable,
      providers,
    };
  }

  async migrateToKeychain(): Promise<CredentialKeychainMigrationResult> {
    const available = await this.keychain.isAvailable();
    if (!available) {
      throw new ModelError(
        "auth_failed",
        `cannot migrate credentials: ${this.keychain.backendName} is unavailable`,
      );
    }
    return this.withLock(async () => {
      const credentials = await this.readDocument();
      const migratedProviders: string[] = [];
      const alreadyKeychainProviders: string[] = [];
      for (const [providerId, entry] of Object.entries(credentials)) {
        if (isKeychainPointer(entry)) {
          alreadyKeychainProviders.push(providerId);
          continue;
        }
        try {
          await this.keychain.setSecret(providerId, JSON.stringify(entry));
        } catch (error) {
          throw new ModelError(
            "auth_failed",
            `failed migrating ${providerId} to ${this.keychain.backendName}: ${(error as Error).message}`,
            { cause: error },
          );
        }
        credentials[providerId] = {
          type: entry.type,
          storage: "keychain",
        };
        migratedProviders.push(providerId);
      }
      if (migratedProviders.length > 0) {
        await this.writeDocument(credentials);
      }
      return {
        migratedProviders: migratedProviders.sort(),
        alreadyKeychainProviders: alreadyKeychainProviders.sort(),
        authPath: this.authPath,
        keychainBackend: this.keychain.backendName,
      };
    });
  }
}

export async function openModelRuntime(
  paths: ProjectPaths,
  options?: {
    credentialStore?: CredentialStoreMode;
    keychainDriver?: KeychainDriver;
  },
): Promise<ModelRuntime> {
  const authPath = path.join(paths.home, "auth.json");
  const mode =
    options?.credentialStore ?? (await readUserCredentialStoreMode(paths.home));
  return ModelRuntime.create({
    credentials: new LockedAuthStore(authPath, {
      mode,
      ...(options?.keychainDriver === undefined
        ? {}
        : { keychainDriver: options.keychainDriver }),
    }),
    modelsPath: path.join(paths.home, "models.json"),
    allowModelNetwork: false,
  });
}

export async function setProviderAuthCredential(
  paths: ProjectPaths,
  providerId: string,
  credential: Credential,
  options?: {
    credentialStore?: CredentialStoreMode;
    keychainDriver?: KeychainDriver;
  },
): Promise<void> {
  const mode =
    options?.credentialStore ?? (await readUserCredentialStoreMode(paths.home));
  const store = new LockedAuthStore(path.join(paths.home, "auth.json"), {
    mode,
    ...(options?.keychainDriver === undefined
      ? {}
      : { keychainDriver: options.keychainDriver }),
  });
  await store.modify(providerId, async () => credential);
}

export async function inspectCredentialStorage(
  paths: ProjectPaths,
  options?: {
    credentialStore?: CredentialStoreMode;
    keychainDriver?: KeychainDriver;
  },
): Promise<CredentialStorageStatus> {
  const mode =
    options?.credentialStore ?? (await readUserCredentialStoreMode(paths.home));
  const store = new LockedAuthStore(path.join(paths.home, "auth.json"), {
    mode,
    ...(options?.keychainDriver === undefined
      ? {}
      : { keychainDriver: options.keychainDriver }),
  });
  return await store.inspectStorage(mode);
}

export async function migrateCredentialsToKeychain(
  paths: ProjectPaths,
  options?: { keychainDriver?: KeychainDriver },
): Promise<CredentialKeychainMigrationResult> {
  const store = new LockedAuthStore(path.join(paths.home, "auth.json"), {
    mode: "keychain",
    ...(options?.keychainDriver === undefined
      ? {}
      : { keychainDriver: options.keychainDriver }),
  });
  return await store.migrateToKeychain();
}
