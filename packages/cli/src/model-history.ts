import { promises as fs } from "node:fs";
import path from "node:path";

export const MODEL_HISTORY_VERSION = 1;
export const RECENT_MODEL_LIMIT = 10;
export const FAVORITE_MODEL_LIMIT = 20;

export interface ModelHistory {
  recent: string[];
  favorites: string[];
  warning: string | null;
}

interface StoredModelHistory {
  version: 1;
  recent: string[];
  favorites: string[];
}

const MODEL_REFERENCE = /^[A-Za-z0-9._@-]+\/[^\s\u0000-\u001f\u007f]+$/u;
const MODEL_REFERENCE_MAX = 300;

export function modelHistoryPath(home: string): string {
  return path.join(home, "model-history.json");
}

export function isModelReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MODEL_REFERENCE_MAX &&
    value === value.trim() &&
    MODEL_REFERENCE.test(value)
  );
}

function emptyHistory(warning: string | null = null): ModelHistory {
  return { recent: [], favorites: [], warning };
}

function uniqueReferences(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (!isModelReference(entry) || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    result.push(entry);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

export async function readModelHistory(home: string): Promise<ModelHistory> {
  const filePath = modelHistoryPath(home);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyHistory();
    }
    return emptyHistory(
      `model history could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyHistory(
      "model history is not valid JSON; recent and favorite models were ignored",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>)["version"] !== MODEL_HISTORY_VERSION
  ) {
    return emptyHistory(
      "model history has an unsupported shape; recent and favorite models were ignored",
    );
  }
  const record = parsed as Record<string, unknown>;
  return {
    recent: uniqueReferences(record["recent"], RECENT_MODEL_LIMIT),
    favorites: uniqueReferences(record["favorites"], FAVORITE_MODEL_LIMIT),
    warning: null,
  };
}

async function writeModelHistory(
  home: string,
  history: Pick<ModelHistory, "recent" | "favorites">,
): Promise<void> {
  const filePath = modelHistoryPath(home);
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const value: StoredModelHistory = {
    version: MODEL_HISTORY_VERSION,
    recent: history.recent,
    favorites: history.favorites,
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, {
      mode: 0o600,
    });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function recordRecentModel(
  home: string,
  reference: string,
): Promise<ModelHistory> {
  if (!isModelReference(reference)) {
    throw new Error("invalid model reference");
  }
  const current = await readModelHistory(home);
  const recent = [
    reference,
    ...current.recent.filter((entry) => entry !== reference),
  ].slice(0, RECENT_MODEL_LIMIT);
  if (
    current.warning === null &&
    current.recent.length === recent.length &&
    current.recent.every((entry, index) => entry === recent[index])
  ) {
    return current;
  }
  await writeModelHistory(home, { recent, favorites: current.favorites });
  return { recent, favorites: current.favorites, warning: null };
}

export async function toggleFavoriteModel(
  home: string,
  reference: string,
): Promise<{ history: ModelHistory; favorite: boolean }> {
  if (!isModelReference(reference)) {
    throw new Error("invalid model reference");
  }
  const current = await readModelHistory(home);
  const favorite = !current.favorites.includes(reference);
  const favorites = favorite
    ? [
        reference,
        ...current.favorites.filter((entry) => entry !== reference),
      ].slice(0, FAVORITE_MODEL_LIMIT)
    : current.favorites.filter((entry) => entry !== reference);
  await writeModelHistory(home, { recent: current.recent, favorites });
  return {
    history: { recent: current.recent, favorites, warning: null },
    favorite,
  };
}

export function nextRecentModel(
  recent: readonly string[],
  current: string | null,
  available: ReadonlySet<string>,
): string | null {
  const candidates = recent.filter((entry) => available.has(entry));
  if (candidates.length === 0) {
    return null;
  }
  if (current === null || !candidates.includes(current)) {
    return candidates[0] ?? null;
  }
  return (
    candidates[(candidates.indexOf(current) + 1) % candidates.length] ?? null
  );
}
