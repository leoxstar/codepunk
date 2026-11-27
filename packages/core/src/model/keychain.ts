import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export const KEYCHAIN_SERVICE_NAME = "codepunk.model.auth" as const;
const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const KEYCHAIN_TIMEOUT_MS = 10_000;

export interface KeychainDriver {
  readonly backendName: string;
  isAvailable(): Promise<boolean>;
  getSecret(account: string): Promise<string | null>;
  setSecret(account: string, payload: string): Promise<void>;
  deleteSecret(account: string): Promise<void>;
}

export function validateKeychainAccount(account: string): string {
  if (!ACCOUNT_NAME_PATTERN.test(account)) {
    throw new Error(
      `invalid keychain account identifier: ${JSON.stringify(account)}`,
    );
  }
  return account;
}

interface CommandOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runKeychainCommand(
  executable: string,
  args: readonly string[],
  stdinText?: string,
): Promise<CommandOutcome> {
  return await new Promise<CommandOutcome>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`${executable} timed out after ${KEYCHAIN_TIMEOUT_MS}ms`),
      );
    }, KEYCHAIN_TIMEOUT_MS);
    timer.unref();
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    if (stdinText !== undefined) {
      child.stdin.write(stdinText, "utf8");
    }
    child.stdin.end();
  });
}

function createMacOsKeychainDriver(): KeychainDriver {
  const securityBin = "/usr/bin/security";
  return {
    backendName: "macos-keychain",
    async isAvailable(): Promise<boolean> {
      if (!existsSync(securityBin)) {
        return false;
      }
      try {
        const res = await runKeychainCommand(securityBin, ["default-keychain"]);
        return res.code === 0 && res.stdout.trim().length > 0;
      } catch {
        return false;
      }
    },
    async getSecret(rawAccount: string): Promise<string | null> {
      const account = validateKeychainAccount(rawAccount);
      const res = await runKeychainCommand(securityBin, [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE_NAME,
        "-a",
        account,
        "-w",
      ]);
      if (res.code === 44) {
        return null;
      }
      if (res.code !== 0) {
        throw new Error(
          `macOS keychain read failed (exit ${res.code}): ${res.stderr.trim()}`,
        );
      }
      const hexOrText = res.stdout.replace(/\r?\n$/u, "");
      return hexOrText;
    },
    async setSecret(rawAccount: string, payload: string): Promise<void> {
      const account = validateKeychainAccount(rawAccount);
      const hexPayload = Buffer.from(payload, "utf8").toString("hex");
      // Pass secret via `security -i` stdin in hex form so secrets never appear
      // in process argv (`ps`).
      const command = `add-generic-password -U -s ${KEYCHAIN_SERVICE_NAME} -a ${account} -X ${hexPayload}\n`;
      const res = await runKeychainCommand(securityBin, ["-i"], command);
      if (res.code !== 0) {
        throw new Error(
          `macOS keychain write failed (exit ${res.code}): ${res.stderr.trim()}`,
        );
      }
    },
    async deleteSecret(rawAccount: string): Promise<void> {
      const account = validateKeychainAccount(rawAccount);
      const res = await runKeychainCommand(securityBin, [
        "delete-generic-password",
        "-s",
        KEYCHAIN_SERVICE_NAME,
        "-a",
        account,
      ]);
      if (res.code !== 0 && res.code !== 44) {
        throw new Error(
          `macOS keychain delete failed (exit ${res.code}): ${res.stderr.trim()}`,
        );
      }
    },
  };
}

function createLinuxSecretServiceDriver(): KeychainDriver {
  return {
    backendName: "linux-secret-service",
    async isAvailable(): Promise<boolean> {
      if (!process.env["DBUS_SESSION_BUS_ADDRESS"]) {
        return false;
      }
      try {
        const res = await runKeychainCommand("secret-tool", ["--version"]);
        return res.code === 0;
      } catch {
        return false;
      }
    },
    async getSecret(rawAccount: string): Promise<string | null> {
      const account = validateKeychainAccount(rawAccount);
      const res = await runKeychainCommand("secret-tool", [
        "lookup",
        "service",
        KEYCHAIN_SERVICE_NAME,
        "account",
        account,
      ]);
      if (res.code === 1 && res.stderr.trim().length === 0) {
        return null;
      }
      if (res.code !== 0) {
        throw new Error(
          `secret-tool lookup failed (exit ${res.code}): ${res.stderr.trim()}`,
        );
      }
      return res.stdout.length === 0 ? null : res.stdout;
    },
    async setSecret(rawAccount: string, payload: string): Promise<void> {
      const account = validateKeychainAccount(rawAccount);
      const res = await runKeychainCommand(
        "secret-tool",
        [
          "store",
          "--label=Codepunk Model Credential",
          "service",
          KEYCHAIN_SERVICE_NAME,
          "account",
          account,
        ],
        payload,
      );
      if (res.code !== 0) {
        throw new Error(
          `secret-tool store failed (exit ${res.code}): ${res.stderr.trim()}`,
        );
      }
    },
    async deleteSecret(rawAccount: string): Promise<void> {
      const account = validateKeychainAccount(rawAccount);
      await runKeychainCommand("secret-tool", [
        "clear",
        "service",
        KEYCHAIN_SERVICE_NAME,
        "account",
        account,
      ]).catch(() => undefined);
    },
  };
}

function createWindowsVaultDriver(): KeychainDriver {
  const psScript = (action: "get" | "set" | "delete"): string => {
    const prelude =
      "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];" +
      "$vault = New-Object Windows.Security.Credentials.PasswordVault;" +
      "$svc = $env:CODEPUNK_KC_SERVICE; $acct = $env:CODEPUNK_KC_ACCOUNT;";
    if (action === "get") {
      return `${prelude} try { $c = $vault.Retrieve($svc, $acct); $c.RetrievePassword(); [Console]::Out.Write($c.Password) } catch { exit 44 }`;
    }
    if (action === "set") {
      return `${prelude} $secret = [Console]::In.ReadToEnd(); try { $old = $vault.Retrieve($svc, $acct); $vault.Remove($old) } catch {}; $vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($svc, $acct, $secret)))`;
    }
    return `${prelude} try { $old = $vault.Retrieve($svc, $acct); $vault.Remove($old) } catch {}`;
  };

  async function runPs(
    script: string,
    account: string,
    stdinText?: string,
  ): Promise<CommandOutcome> {
    return await new Promise<CommandOutcome>((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: {
            ...process.env,
            CODEPUNK_KC_SERVICE: KEYCHAIN_SERVICE_NAME,
            CODEPUNK_KC_ACCOUNT: account,
          },
        },
      );
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({
          code,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        }),
      );
      if (stdinText !== undefined) {
        child.stdin.write(stdinText, "utf8");
      }
      child.stdin.end();
    });
  }

  return {
    backendName: "windows-password-vault",
    async isAvailable(): Promise<boolean> {
      try {
        const res = await runPs("$PSVersionTable.PSVersion.Major", "probe");
        return res.code === 0;
      } catch {
        return false;
      }
    },
    async getSecret(rawAccount: string): Promise<string | null> {
      const account = validateKeychainAccount(rawAccount);
      const res = await runPs(psScript("get"), account);
      if (res.code === 44) {
        return null;
      }
      if (res.code !== 0) {
        throw new Error(
          `Windows PasswordVault read failed (exit ${res.code}): ${res.stderr.trim()}`,
        );
      }
      return res.stdout;
    },
    async setSecret(rawAccount: string, payload: string): Promise<void> {
      const account = validateKeychainAccount(rawAccount);
      const res = await runPs(psScript("set"), account, payload);
      if (res.code !== 0) {
        throw new Error(
          `Windows PasswordVault write failed (exit ${res.code}): ${res.stderr.trim()}`,
        );
      }
    },
    async deleteSecret(rawAccount: string): Promise<void> {
      const account = validateKeychainAccount(rawAccount);
      await runPs(psScript("delete"), account).catch(() => undefined);
    },
  };
}

export class InMemoryKeychainDriver implements KeychainDriver {
  readonly backendName = "in-memory-keychain";
  private readonly entries = new Map<string, string>();
  private available: boolean;

  constructor(available = true) {
    this.available = available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }

  hasAccount(account: string): boolean {
    return this.entries.has(account);
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async getSecret(rawAccount: string): Promise<string | null> {
    const account = validateKeychainAccount(rawAccount);
    if (!this.available) {
      throw new Error("keychain backend is unavailable");
    }
    return this.entries.get(account) ?? null;
  }

  async setSecret(rawAccount: string, payload: string): Promise<void> {
    const account = validateKeychainAccount(rawAccount);
    if (!this.available) {
      throw new Error("keychain backend is unavailable");
    }
    this.entries.set(account, payload);
  }

  async deleteSecret(rawAccount: string): Promise<void> {
    const account = validateKeychainAccount(rawAccount);
    if (!this.available) {
      throw new Error("keychain backend is unavailable");
    }
    this.entries.delete(account);
  }
}

export function createNativeKeychainDriver(
  platform: NodeJS.Platform = process.platform,
): KeychainDriver {
  if (platform === "darwin") {
    return createMacOsKeychainDriver();
  }
  if (platform === "linux") {
    return createLinuxSecretServiceDriver();
  }
  if (platform === "win32") {
    return createWindowsVaultDriver();
  }
  return new InMemoryKeychainDriver(false);
}
