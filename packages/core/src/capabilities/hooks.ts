import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  HookEvidenceSchema,
  HookLifecycleEventSchema,
  HooksConfigSchema,
  validateSchema,
  type HookDefinition,
  type HookEvidence,
  type HookLifecycleEvent,
  type HookScope,
  type HooksConfig,
} from "codepunk-protocol";
import { redactOutputPreview } from "../artifacts/index.ts";
import { parseToml } from "../config/toml.ts";
import { sha256Bytes } from "../platform/hash.ts";
import { assertProjectConfigFileSafe } from "../platform/paths.ts";

export const HOOK_CONFIG_FILE = "hooks.toml";
export const MAX_HOOK_CONFIG_BYTES = 64 * 1024;
const MAX_HOOK_PREVIEW_CHARS = 400;

export class HookBlockedError extends Error {
  readonly preview: string | null;

  constructor(message: string, preview: string | null = null) {
    super(message);
    this.name = "HookBlockedError";
    this.preview = preview;
  }
}

export interface HookRunnerOptions {
  deliveryRoot: string;
  userHome: string;
  cwd: string;
  projectTrusted?: boolean;
  projectEnabled?: boolean;
  now?: () => Date;
}

export type HookEvidenceAppend = (evidence: HookEvidence) => Promise<void>;

interface HookSpawnResult {
  exitCode: number | null;
  stdout: Uint8Array | null;
  stderr: Uint8Array | null;
  timedOut: boolean;
  durationMs: number;
  errorMessage: string | null;
}

interface ScopedHook {
  definition: HookDefinition;
  scope: HookScope;
}

function formatIssues(
  issues: readonly { path: string; message: string }[],
): string {
  return issues.map((issue) => `${issue.path} ${issue.message}`).join("; ");
}

function hookEvidence(
  input: { name: string },
  event: HookLifecycleEvent,
  scope: HookScope,
  outcome: HookEvidence["outcome"],
  exitCode: number | null,
  durationMs: number,
  stdout: Uint8Array | null,
  stderr: Uint8Array | null,
  reason: string | null,
  now: () => Date,
): HookEvidence {
  const record: HookEvidence = {
    version: 1,
    hook_name: input.name,
    event,
    scope,
    outcome,
    exit_code: exitCode,
    duration_ms: durationMs,
    stdout_sha256: stdout === null ? null : sha256Bytes(stdout),
    stderr_sha256: stderr === null ? null : sha256Bytes(stderr),
    reason: reason === null ? null : reason.slice(0, 2_000),
    recorded_at: now().toISOString(),
  };
  const validation = validateSchema(HookEvidenceSchema, record);
  if (!validation.ok) {
    throw new HookBlockedError(
      `hook evidence does not match the frozen protocol: ${formatIssues(
        validation.issues,
      )}`,
    );
  }
  return record;
}

async function appendEvidenceOrBlock(
  appendEvidence: HookEvidenceAppend,
  record: HookEvidence,
): Promise<void> {
  try {
    await appendEvidence(record);
  } catch (error) {
    if (error instanceof HookBlockedError) {
      throw error;
    }
    throw new HookBlockedError(
      `hook evidence write failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function parseHooksConfig(content: string): HooksConfig {
  let raw: unknown;
  try {
    raw = parseToml(content);
  } catch (error) {
    throw new HookBlockedError(
      `hooks configuration is malformed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const validation = validateSchema(HooksConfigSchema, raw);
  if (!validation.ok) {
    throw new HookBlockedError(
      `hooks configuration is invalid: ${formatIssues(validation.issues)}`,
    );
  }
  return raw as HooksConfig;
}

/**
 * Run user-scope lifecycle hooks and, only for a trusted workspace with an
 * explicit opt-in, project-scope hooks. Every hook fails closed: a nonzero
 * exit, a timeout, a spawn failure, or a failed evidence write blocks the
 * caller with `HookBlockedError`.
 */
export class HookRunner {
  private readonly projectConfigPath: string;
  private readonly userConfigPath: string;
  private readonly cwd: string;
  private readonly projectTrusted: boolean;
  private readonly projectEnabled: boolean | undefined;
  private readonly now: () => Date;

  constructor(options: HookRunnerOptions) {
    this.projectConfigPath = path.join(
      options.deliveryRoot,
      ".codepunk",
      HOOK_CONFIG_FILE,
    );
    this.userConfigPath = path.join(options.userHome, HOOK_CONFIG_FILE);
    this.cwd = options.cwd;
    this.projectTrusted = options.projectTrusted === true;
    this.projectEnabled = options.projectEnabled;
    this.now = options.now ?? (() => new Date());
  }

  private async readConfig(
    filePath: string,
    scope: HookScope,
  ): Promise<HooksConfig | null> {
    let stat;
    try {
      stat = await fs.lstat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new HookBlockedError(
        `${scope} hook configuration cannot be inspected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new HookBlockedError(
        `${scope} hook configuration must be a real file`,
      );
    }
    if (stat.size > MAX_HOOK_CONFIG_BYTES) {
      throw new HookBlockedError(
        `${scope} hook configuration exceeds ${MAX_HOOK_CONFIG_BYTES} bytes`,
      );
    }
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      throw new HookBlockedError(
        `${scope} hook configuration cannot be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return parseHooksConfig(content);
  }

  private skipReason(projectEnabled: boolean): string {
    if (!this.projectTrusted && !projectEnabled) {
      return "project hooks require project trust and explicit project enablement";
    }
    if (!this.projectTrusted) {
      return "project hooks require project trust";
    }
    return "project hooks require explicit project enablement";
  }

  private async projectConfig(
    appendEvidence: HookEvidenceAppend,
    event: HookLifecycleEvent,
    projectEnabled: boolean,
  ): Promise<HooksConfig | null> {
    try {
      await fs.lstat(this.projectConfigPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      const reason = `project hook configuration cannot be inspected: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await appendEvidenceOrBlock(
        appendEvidence,
        hookEvidence(
          { name: HOOK_CONFIG_FILE },
          event,
          "project",
          "rejected",
          null,
          0,
          null,
          null,
          reason,
          this.now,
        ),
      );
      throw new HookBlockedError(reason);
    }
    if (!this.projectTrusted || !projectEnabled) {
      const record = hookEvidence(
        { name: HOOK_CONFIG_FILE },
        event,
        "project",
        "skipped",
        null,
        0,
        null,
        null,
        this.skipReason(projectEnabled),
        this.now,
      );
      await appendEvidenceOrBlock(appendEvidence, record);
      return null;
    }
    let safety: string | null;
    try {
      safety = await assertProjectConfigFileSafe(this.projectConfigPath);
    } catch (error) {
      const reason = `project hook configuration cannot be inspected: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await appendEvidenceOrBlock(
        appendEvidence,
        hookEvidence(
          { name: HOOK_CONFIG_FILE },
          event,
          "project",
          "rejected",
          null,
          0,
          null,
          null,
          reason,
          this.now,
        ),
      );
      throw new HookBlockedError(reason);
    }
    if (safety !== null) {
      const record = hookEvidence(
        { name: HOOK_CONFIG_FILE },
        event,
        "project",
        "rejected",
        null,
        0,
        null,
        null,
        safety,
        this.now,
      );
      await appendEvidenceOrBlock(appendEvidence, record);
      throw new HookBlockedError(
        `project hook configuration was rejected: ${safety}`,
      );
    }
    let config: HooksConfig | null;
    try {
      config = await this.readConfig(this.projectConfigPath, "project");
    } catch (error) {
      const record = hookEvidence(
        { name: HOOK_CONFIG_FILE },
        event,
        "project",
        "rejected",
        null,
        0,
        null,
        null,
        error instanceof Error ? error.message : String(error),
        this.now,
      );
      await appendEvidenceOrBlock(appendEvidence, record);
      if (error instanceof HookBlockedError) {
        throw error;
      }
      throw new HookBlockedError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (config === null) {
      return null;
    }
    if (config.project_enabled !== undefined) {
      const reason =
        "project_enabled is allowed only in the user hooks configuration";
      const record = hookEvidence(
        { name: HOOK_CONFIG_FILE },
        event,
        "project",
        "rejected",
        null,
        0,
        null,
        null,
        reason,
        this.now,
      );
      await appendEvidenceOrBlock(appendEvidence, record);
      throw new HookBlockedError(reason);
    }
    return config;
  }

  private async definitions(
    event: HookLifecycleEvent,
    appendEvidence: HookEvidenceAppend,
  ): Promise<ScopedHook[]> {
    const validation = validateSchema(HookLifecycleEventSchema, event);
    if (!validation.ok) {
      throw new HookBlockedError(
        `unknown hook event: ${formatIssues(validation.issues)}`,
      );
    }
    const user = await this.loadScope(
      this.userConfigPath,
      "user",
      event,
      appendEvidence,
    );
    const projectEnabled =
      this.projectEnabled === undefined
        ? user?.project_enabled === true
        : this.projectEnabled === true;
    const project = await this.loadScope(
      this.projectConfigPath,
      "project",
      event,
      appendEvidence,
      projectEnabled,
    );
    const scoped: ScopedHook[] = [];
    const names = new Set<string>();
    for (const [config, scope] of [
      [user, "user"],
      [project, "project"],
    ] as const) {
      if (config === null) {
        continue;
      }
      for (const definition of config.hooks) {
        if (definition.event !== event) {
          continue;
        }
        if (names.has(definition.name)) {
          throw new HookBlockedError(
            `duplicate hook name ${definition.name} in ${scope} hook configuration`,
          );
        }
        names.add(definition.name);
        scoped.push({ definition, scope });
      }
    }
    return scoped;
  }

  private async loadScope(
    filePath: string,
    scope: HookScope,
    event: HookLifecycleEvent,
    appendEvidence: HookEvidenceAppend,
    projectEnabled = false,
  ): Promise<HooksConfig | null> {
    if (scope === "project") {
      return this.projectConfig(appendEvidence, event, projectEnabled);
    }
    try {
      return await this.readConfig(filePath, scope);
    } catch (error) {
      const record = hookEvidence(
        { name: HOOK_CONFIG_FILE },
        event,
        scope,
        "rejected",
        null,
        0,
        null,
        null,
        error instanceof Error ? error.message : String(error),
        this.now,
      );
      await appendEvidenceOrBlock(appendEvidence, record);
      throw error;
    }
  }

  private spawnHook(
    definition: HookDefinition,
    payload: unknown,
  ): Promise<HookSpawnResult> {
    return new Promise((resolve) => {
      const startedAt = performance.now();
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let timedOut = false;
      let settled = false;
      const child = spawn(definition.argv[0]!, definition.argv.slice(1), {
        cwd: this.cwd,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const finish = (result: Omit<HookSpawnResult, "durationMs">) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ ...result, durationMs: performance.now() - startedAt });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform !== "win32" && child.pid !== undefined) {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          child.kill("SIGKILL");
        }
      }, definition.timeout_ms);
      timer.unref();
      const collect = (
        current: Buffer<ArrayBufferLike>,
        chunk: Buffer<ArrayBufferLike>,
      ): Buffer<ArrayBufferLike> => {
        const remaining = definition.max_output_bytes - current.length;
        return remaining <= 0
          ? current
          : Buffer.concat([current, chunk.subarray(0, remaining)]);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = collect(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = collect(stderr, chunk);
      });
      child.once("error", (error) => {
        finish({
          exitCode: null,
          stdout: null,
          stderr: null,
          timedOut: false,
          errorMessage: error.message,
        });
      });
      child.once("close", (code) => {
        finish({
          exitCode: code,
          stdout,
          stderr,
          timedOut,
          errorMessage: null,
        });
      });
      child.stdin.once("error", () => undefined);
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    });
  }

  private async runHook(
    scoped: ScopedHook,
    event: HookLifecycleEvent,
    payload: unknown,
    appendEvidence: HookEvidenceAppend,
  ): Promise<{ record: HookEvidence; preview: string | null }> {
    const definition = scoped.definition;
    const result = await this.spawnHook(definition, payload);
    if (result.errorMessage !== null) {
      const record = hookEvidence(
        definition,
        event,
        scoped.scope,
        "rejected",
        null,
        result.durationMs,
        null,
        null,
        result.errorMessage,
        this.now,
      );
      await appendEvidenceOrBlock(appendEvidence, record);
      return { record, preview: null };
    }
    const outcome: HookEvidence["outcome"] = result.timedOut
      ? "timed_out"
      : result.exitCode === 0
        ? "passed"
        : "failed";
    const record = hookEvidence(
      definition,
      event,
      scoped.scope,
      outcome,
      result.exitCode,
      result.durationMs,
      result.stdout,
      result.stderr,
      result.timedOut
        ? `hook exceeded timeout_ms=${definition.timeout_ms}`
        : `hook exited with status ${result.exitCode}`,
      this.now,
    );
    await appendEvidenceOrBlock(appendEvidence, record);
    let preview: string | null = null;
    if (outcome !== "passed") {
      const rawStderr =
        result.stderr !== null && result.stderr.byteLength > 0
          ? Buffer.from(result.stderr).toString("utf8").trim()
          : "";
      const rawStdout =
        result.stdout !== null && result.stdout.byteLength > 0
          ? Buffer.from(result.stdout).toString("utf8").trim()
          : "";
      const combined = rawStderr.length > 0 ? rawStderr : rawStdout;
      if (combined.length > 0) {
        preview = redactOutputPreview(
          combined,
          path.dirname(this.userConfigPath),
        ).slice(0, MAX_HOOK_PREVIEW_CHARS);
      }
    }
    return { record, preview };
  }

  async run(
    event: HookLifecycleEvent,
    payload: unknown,
    appendEvidence: HookEvidenceAppend,
  ): Promise<readonly HookEvidence[]> {
    const records: HookEvidence[] = [];
    const append = async (record: HookEvidence) => {
      await appendEvidence(record);
      records.push(record);
    };
    const scoped = await this.definitions(event, append);
    for (const hook of scoped) {
      const { record, preview } = await this.runHook(
        hook,
        event,
        payload,
        append,
      );
      if (record.outcome !== "passed") {
        throw new HookBlockedError(
          `hook ${record.hook_name} failed closed (${record.outcome}): ${
            record.reason ?? "no reason"
          }`,
          preview,
        );
      }
    }
    return records;
  }
}

export function formatHookStatus(record: HookEvidence): string {
  return `${record.scope} hook ${record.hook_name} ${record.outcome}: ${
    record.reason ?? "no reason"
  }`;
}
