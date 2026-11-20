import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CodepunkConfig } from "../config/index.ts";
import { parseToml, TomlError, type TomlTable } from "../config/toml.ts";
import type { SubagentToolMask } from "../workers/subagent.ts";
import type { ProjectPaths } from "../platform/paths.ts";
import { modelMatchesEnabledScope, parseModelReference } from "./index.ts";

export const MODEL_ROLE_NAMES = ["plan", "smol", "slow"] as const;
export type ModelRoleName = (typeof MODEL_ROLE_NAMES)[number];

const MAX_ROLES_BYTES = 64 * 1024;
const MODEL_REFERENCE = /^[A-Za-z0-9._@-]+\/[^\s\u0000-\u001f\u007f]+$/u;
const MODEL_REFERENCE_MAX = 300;
const POOL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export class ModelRoleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ModelRoleError";
    this.code = code;
  }
}

export interface ModelRoleSelection {
  role: ModelRoleName;
  model: string;
  source: "user" | "fallback";
}

export interface SubagentModelPool {
  name: string;
  models: string[];
  max: number;
}

export interface ModelRoleBundle {
  roles: Partial<Record<ModelRoleName, string>>;
  pools: Record<string, SubagentModelPool>;
  warnings: string[];
}

export interface SubagentModelLease {
  lease_id: string;
  pool: string;
  models: string[];
  acquired_at: string;
  released_at: string | null;
}

function modelReference(value: unknown, where: string): string {
  if (
    typeof value !== "string" ||
    value.length > MODEL_REFERENCE_MAX ||
    !MODEL_REFERENCE.test(value.trim())
  ) {
    throw new ModelRoleError(
      "roles.model",
      `${where} must be a provider/model reference`,
    );
  }
  return value.trim();
}

export async function loadModelRoles(
  paths: ProjectPaths,
): Promise<ModelRoleBundle> {
  const warnings: string[] = [];
  const projectPath = path.join(paths.projectConfigDir, "roles.toml");
  try {
    await fs.access(projectPath);
    warnings.push(
      `project roles at ${projectPath} are inert; model roles load only from the user home`,
    );
  } catch {
    // No project roles is the normal case.
  }
  const filePath = path.join(paths.home, "roles.toml");
  let raw: string;
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ModelRoleError(
        "roles.file",
        "roles.toml must be a regular file",
      );
    }
    if (stat.size > MAX_ROLES_BYTES) {
      throw new ModelRoleError(
        "roles.too_large",
        `roles.toml exceeds ${MAX_ROLES_BYTES} bytes`,
      );
    }
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { roles: {}, pools: {}, warnings };
    }
    throw error;
  }
  let parsed: TomlTable;
  try {
    parsed = parseToml(raw);
  } catch (error) {
    throw new ModelRoleError(
      "roles.toml",
      error instanceof TomlError ? error.message : String(error),
    );
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "version" && key !== "roles" && key !== "pool") {
      throw new ModelRoleError(
        "roles.unknown_key",
        `roles.toml has unsupported key ${key}`,
      );
    }
  }
  if (parsed["version"] !== 1) {
    throw new ModelRoleError("roles.version", "roles.toml version must be 1");
  }
  const roles: Partial<Record<ModelRoleName, string>> = {};
  const roleTable = parsed["roles"];
  if (roleTable !== undefined) {
    if (
      roleTable === null ||
      typeof roleTable !== "object" ||
      Array.isArray(roleTable)
    ) {
      throw new ModelRoleError("roles.schema", "roles must be a table");
    }
    for (const [name, value] of Object.entries(roleTable)) {
      if (!(MODEL_ROLE_NAMES as readonly string[]).includes(name)) {
        throw new ModelRoleError(
          "roles.unknown_role",
          `roles.${name} is not a supported role`,
        );
      }
      roles[name as ModelRoleName] = modelReference(value, `roles.${name}`);
    }
  }
  const pools: Record<string, SubagentModelPool> = {};
  const poolRows = parsed["pool"];
  if (poolRows !== undefined) {
    if (!Array.isArray(poolRows)) {
      throw new ModelRoleError(
        "roles.pool_schema",
        "subagent pools must use [[pool]] tables",
      );
    }
    for (const [index, row] of poolRows.entries()) {
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        throw new ModelRoleError(
          "roles.pool_schema",
          `pool[${index + 1}] must be a table`,
        );
      }
      const table = row as TomlTable;
      for (const key of Object.keys(table)) {
        if (key !== "name" && key !== "models" && key !== "max") {
          throw new ModelRoleError(
            "roles.pool_unknown_key",
            `pool[${index + 1}].${key} is not supported`,
          );
        }
      }
      const name = table["name"];
      if (typeof name !== "string" || !POOL_NAME.test(name)) {
        throw new ModelRoleError(
          "roles.pool_name",
          `pool[${index + 1}].name must be a lowercase pool name`,
        );
      }
      if (pools[name] !== undefined) {
        throw new ModelRoleError(
          "roles.pool_duplicate",
          `pool ${name} is duplicated`,
        );
      }
      if (
        !Array.isArray(table["models"]) ||
        table["models"].length === 0 ||
        table["models"].some((entry) => typeof entry !== "string")
      ) {
        throw new ModelRoleError(
          "roles.pool_models",
          `pool ${name}.models must be a non-empty string array`,
        );
      }
      const models = table["models"].map((entry) =>
        modelReference(entry, `pool ${name}.models`),
      );
      if (new Set(models).size !== models.length) {
        throw new ModelRoleError(
          "roles.pool_duplicate_model",
          `pool ${name} has duplicate models`,
        );
      }
      const max = table["max"];
      if (
        !Number.isSafeInteger(max) ||
        (max as number) < 1 ||
        (max as number) > 8 ||
        (max as number) > models.length
      ) {
        throw new ModelRoleError(
          "roles.pool_max",
          `pool ${name}.max must be 1-8 and no larger than models.length`,
        );
      }
      pools[name] = { name, models, max: max as number };
    }
  }
  return { roles, pools, warnings };
}

export function resolveModelRole(
  bundle: ModelRoleBundle,
  config: CodepunkConfig,
  role: ModelRoleName,
  fallbackModel: string,
): ModelRoleSelection {
  if (!(MODEL_ROLE_NAMES as readonly string[]).includes(role)) {
    throw new ModelRoleError(
      "roles.unknown_role",
      `${role} is not a supported model role`,
    );
  }
  const selected = bundle.roles[role];
  const model = selected ?? fallbackModel;
  const parsed = MODEL_REFERENCE.test(model)
    ? parseModelReference(model)
    : null;
  if (parsed === null) {
    throw new ModelRoleError(
      "roles.fallback",
      `no model is configured for role ${role}`,
    );
  }
  if (!modelMatchesEnabledScope(parsed, config.model.enabled)) {
    throw new ModelRoleError(
      "roles.model_scope",
      `model ${model} for role ${role} is outside model.enabled`,
    );
  }
  return {
    role,
    model,
    source: selected === undefined ? "fallback" : "user",
  };
}

export function selectSubagentModels(
  bundle: ModelRoleBundle,
  config: CodepunkConfig,
  poolName: string,
  requested: readonly string[],
): string[] {
  const pool = bundle.pools[poolName];
  if (pool === undefined) {
    throw new ModelRoleError(
      "roles.pool_not_found",
      `subagent model pool ${poolName} is not configured`,
    );
  }
  if (requested.length === 0 || requested.length > pool.max) {
    throw new ModelRoleError(
      "roles.pool_limit",
      `pool ${poolName} accepts 1-${pool.max} requested models`,
    );
  }
  if (new Set(requested).size !== requested.length) {
    throw new ModelRoleError(
      "roles.pool_duplicate_request",
      `pool ${poolName} cannot select the same model twice`,
    );
  }
  for (const model of requested) {
    if (!pool.models.includes(model)) {
      throw new ModelRoleError(
        "roles.pool_scope",
        `model ${model} is outside pool ${poolName}`,
      );
    }
    const parsed = MODEL_REFERENCE.test(model)
      ? parseModelReference(model)
      : null;
    if (
      parsed === null ||
      !modelMatchesEnabledScope(parsed, config.model.enabled)
    ) {
      throw new ModelRoleError(
        "roles.model_scope",
        `model ${model} is outside model.enabled`,
      );
    }
  }
  return [...requested];
}

export function assertSubagentToolCeiling(
  parent: SubagentToolMask,
  child: SubagentToolMask,
): void {
  const keys = new Set([...Object.keys(parent), ...Object.keys(child)]) as Set<
    keyof SubagentToolMask
  >;
  for (const key of keys) {
    if (child[key] && !parent[key]) {
      throw new ModelRoleError(
        "roles.tool_ceiling",
        `subagent tool ${key} exceeds the parent tool mask`,
      );
    }
  }
}

export class SubagentModelPoolManager {
  private readonly active = new Map<string, SubagentModelLease>();
  private readonly history: SubagentModelLease[] = [];
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  activeCount(poolName: string): number {
    let count = 0;
    for (const lease of this.active.values()) {
      if (lease.pool === poolName) {
        count += 1;
      }
    }
    return count;
  }

  records(): readonly SubagentModelLease[] {
    return this.history.map((lease) => ({
      ...lease,
      models: [...lease.models],
    }));
  }

  acquire(
    bundle: ModelRoleBundle,
    config: CodepunkConfig,
    poolName: string,
    requested: readonly string[],
  ): SubagentModelLease {
    const models = selectSubagentModels(bundle, config, poolName, requested);
    const pool = bundle.pools[poolName]!;
    if (this.activeCount(poolName) >= pool.max) {
      throw new ModelRoleError(
        "roles.pool_exhausted",
        `subagent model pool ${poolName} is at its ${pool.max}-lease limit`,
      );
    }
    const lease: SubagentModelLease = {
      lease_id: randomUUID(),
      pool: poolName,
      models,
      acquired_at: this.now().toISOString(),
      released_at: null,
    };
    this.active.set(lease.lease_id, lease);
    this.history.push(lease);
    return { ...lease, models: [...lease.models] };
  }

  release(leaseId: string): SubagentModelLease | null {
    const lease = this.active.get(leaseId);
    if (lease === undefined) {
      return null;
    }
    this.active.delete(leaseId);
    const released: SubagentModelLease = {
      ...lease,
      models: [...lease.models],
      released_at: this.now().toISOString(),
    };
    const index = this.history.findIndex(
      (record) => record.lease_id === leaseId,
    );
    if (index !== -1) {
      this.history[index] = released;
    }
    return { ...released, models: [...released.models] };
  }
}
