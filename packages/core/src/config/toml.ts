export type TomlPrimitive = string | number | boolean;
export type TomlValue =
  TomlPrimitive | TomlPrimitive[] | TomlTable | TomlTable[];

export interface TomlTable {
  [key: string]: TomlValue;
}

function isTomlTable(value: TomlValue): value is TomlTable {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class TomlError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.name = "TomlError";
    this.line = line;
  }
}

function stripComment(line: string): string {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseKey(raw: string, line: number): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new TomlError("empty key", line);
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(trimmed)) {
    throw new TomlError(`invalid key ${trimmed}`, line);
  }
  return trimmed;
}

function parseString(raw: string, line: number): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) {
      throw new TomlError("unterminated literal string", line);
    }
    return trimmed.slice(1, -1);
  }
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    throw new TomlError("invalid string", line);
  }
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    throw new TomlError("invalid quoted string", line);
  }
}

function splitArray(body: string, line: number): string[] {
  const values: string[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let current = "";
  for (const character of body) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote === '"') {
      current += character;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      current += character;
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === ",") {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (quote !== null) {
    throw new TomlError("unterminated array string", line);
  }
  if (current.trim().length > 0) {
    values.push(current.trim());
  }
  return values;
}

function parseValue(raw: string, line: number): TomlValue {
  const trimmed = raw.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^[+-]?\d+$/u.test(trimmed)) {
    const value = Number(trimmed);
    if (!Number.isSafeInteger(value)) {
      throw new TomlError("integer is outside the safe range", line);
    }
    return value;
  }
  if (/^[+-]?(?:\d+\.\d*|\d*\.\d+)$/u.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return splitArray(trimmed.slice(1, -1), line).map((value) =>
      parseValue(value, line),
    ) as TomlPrimitive[];
  }
  return parseString(trimmed, line);
}

function tableAt(root: TomlTable, segments: string[], line: number): TomlTable {
  let current = root;
  for (const segment of segments) {
    const existing = current[segment];
    if (existing === undefined) {
      const next: TomlTable = {};
      current[segment] = next;
      current = next;
      continue;
    }
    if (
      existing === null ||
      typeof existing !== "object" ||
      (Array.isArray(existing) && existing.length === 0)
    ) {
      throw new TomlError(`key ${segment} is already a value`, line);
    }
    if (Array.isArray(existing)) {
      const last = existing.at(-1);
      if (last === undefined) {
        throw new TomlError(`table array ${segment} is empty`, line);
      }
      if (!isTomlTable(last)) {
        throw new TomlError(`table array ${segment} contains a value`, line);
      }
      current = last;
      continue;
    }
    current = existing;
  }
  return current;
}

function tableArrayAt(
  root: TomlTable,
  segments: string[],
  line: number,
): TomlTable {
  if (segments.length === 0) {
    throw new TomlError("empty table array name", line);
  }
  const parent = tableAt(root, segments.slice(0, -1), line);
  const name = segments.at(-1)!;
  const existing = parent[name];
  if (existing === undefined) {
    const entry: TomlTable = {};
    parent[name] = [entry];
    return entry;
  }
  if (!Array.isArray(existing)) {
    throw new TomlError(`key ${name} is not a table array`, line);
  }
  const entry: TomlTable = {};
  (existing as TomlTable[]).push(entry);
  return entry;
}

export function parseToml(content: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index]!).trim();
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith("[[") && line.endsWith("]]")) {
      const segments = line
        .slice(2, -2)
        .split(".")
        .map((segment) => parseKey(segment, lineNumber));
      current = tableArrayAt(root, segments, lineNumber);
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      const segments = line
        .slice(1, -1)
        .split(".")
        .map((segment) => parseKey(segment, lineNumber));
      current = tableAt(root, segments, lineNumber);
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new TomlError("expected key = value", lineNumber);
    }
    const key = parseKey(line.slice(0, separator), lineNumber);
    if (current[key] !== undefined) {
      throw new TomlError(`duplicate key ${key}`, lineNumber);
    }
    current[key] = parseValue(line.slice(separator + 1), lineNumber);
  }
  return root;
}

export function flattenToml(
  table: TomlTable,
  prefix = "",
): Map<string, TomlValue> {
  const output = new Map<string, TomlValue>();
  for (const [key, value] of Object.entries(table)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (isTomlTable(value)) {
      for (const [nested, nestedValue] of flattenToml(value, path)) {
        output.set(nested, nestedValue);
      }
    } else {
      output.set(path, value);
    }
  }
  return output;
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}
