import { promises as fs } from "node:fs";
import path from "node:path";

export class JsonSchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonSchemaValidationError";
  }
}

export interface JsonSchemaIssue {
  path: string;
  message: string;
}

export interface JsonSchemaValidationResult {
  ok: boolean;
  issues: JsonSchemaIssue[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function loadJsonOutputSchema(
  spec: string,
  cwd: string,
): Promise<Record<string, unknown>> {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    throw new JsonSchemaValidationError(
      "--json-schema requires an inline JSON object or a path to a .json schema file",
    );
  }
  let rawText = trimmed;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    const filePath = path.resolve(cwd, trimmed);
    try {
      rawText = await fs.readFile(filePath, "utf8");
    } catch (error) {
      throw new JsonSchemaValidationError(
        `cannot read --json-schema file ${filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new JsonSchemaValidationError(
      `invalid JSON in --json-schema: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new JsonSchemaValidationError(
      "--json-schema root must be a JSON object",
    );
  }
  return parsed;
}

export function buildJsonSchemaPromptSuffix(
  schema: Record<string, unknown>,
): string {
  return [
    "",
    "[Output Contract]",
    "Respond with ONLY valid JSON conforming strictly to this JSON Schema (do not wrap in markdown code fences or add commentary):",
    JSON.stringify(schema),
  ].join("\n");
}

export function extractJsonPayload(
  rawText: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "assistant output is empty" };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // Try single fenced markdown block fallback.
  }
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/iu.exec(trimmed);
  if (fenced !== null && fenced[1] !== undefined) {
    try {
      return { ok: true, value: JSON.parse(fenced[1].trim()) };
    } catch (error) {
      return {
        ok: false,
        error: `assistant fenced JSON could not be parsed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
  return { ok: false, error: "assistant output is not valid JSON" };
}

function matchesJsonType(expected: string, value: unknown): boolean {
  switch (expected) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    default:
      return true;
  }
}

export function validateJsonOutputSchema(
  schema: Record<string, unknown>,
  value: unknown,
  currentPath = "$",
): JsonSchemaValidationResult {
  const issues: JsonSchemaIssue[] = [];

  if ("const" in schema && !Object.is(value, schema["const"])) {
    issues.push({
      path: currentPath,
      message: `expected constant ${JSON.stringify(schema["const"])}`,
    });
    return { ok: false, issues };
  }

  if (Array.isArray(schema["enum"])) {
    const matched = schema["enum"].some(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(value),
    );
    if (!matched) {
      issues.push({
        path: currentPath,
        message: `expected one of ${JSON.stringify(schema["enum"])}`,
      });
    }
  }

  const rawType = schema["type"];
  if (typeof rawType === "string") {
    if (!matchesJsonType(rawType, value)) {
      issues.push({
        path: currentPath,
        message: `expected type ${rawType}`,
      });
      return { ok: false, issues };
    }
  } else if (Array.isArray(rawType)) {
    const types = rawType.filter((t): t is string => typeof t === "string");
    if (types.length > 0 && !types.some((t) => matchesJsonType(t, value))) {
      issues.push({
        path: currentPath,
        message: `expected type ${types.join("|")}`,
      });
      return { ok: false, issues };
    }
  }

  if (typeof value === "string") {
    if (
      typeof schema["minLength"] === "number" &&
      value.length < schema["minLength"]
    ) {
      issues.push({
        path: currentPath,
        message: `string length ${value.length} is less than minLength ${schema["minLength"]}`,
      });
    }
    if (
      typeof schema["maxLength"] === "number" &&
      value.length > schema["maxLength"]
    ) {
      issues.push({
        path: currentPath,
        message: `string length ${value.length} exceeds maxLength ${schema["maxLength"]}`,
      });
    }
    if (typeof schema["pattern"] === "string") {
      try {
        const regex = new RegExp(schema["pattern"], "u");
        if (!regex.test(value)) {
          issues.push({
            path: currentPath,
            message: `string does not match pattern ${schema["pattern"]}`,
          });
        }
      } catch {
        issues.push({
          path: currentPath,
          message: `invalid schema regex pattern ${schema["pattern"]}`,
        });
      }
    }
  }

  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) {
      issues.push({
        path: currentPath,
        message: `number ${value} is less than minimum ${schema["minimum"]}`,
      });
    }
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) {
      issues.push({
        path: currentPath,
        message: `number ${value} exceeds maximum ${schema["maximum"]}`,
      });
    }
  }

  if (Array.isArray(value)) {
    if (
      typeof schema["minItems"] === "number" &&
      value.length < schema["minItems"]
    ) {
      issues.push({
        path: currentPath,
        message: `array length ${value.length} is less than minItems ${schema["minItems"]}`,
      });
    }
    if (
      typeof schema["maxItems"] === "number" &&
      value.length > schema["maxItems"]
    ) {
      issues.push({
        path: currentPath,
        message: `array length ${value.length} exceeds maxItems ${schema["maxItems"]}`,
      });
    }
    if (isPlainObject(schema["items"])) {
      const itemSchema = schema["items"];
      for (let i = 0; i < value.length; i += 1) {
        const sub = validateJsonOutputSchema(
          itemSchema,
          value[i],
          `${currentPath}[${i}]`,
        );
        issues.push(...sub.issues);
      }
    }
  }

  if (isPlainObject(value)) {
    const required = Array.isArray(schema["required"])
      ? schema["required"].filter((k): k is string => typeof k === "string")
      : [];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) {
        issues.push({
          path: `${currentPath}.${key}`,
          message: "missing required property",
        });
      }
    }
    const properties = isPlainObject(schema["properties"])
      ? schema["properties"]
      : {};
    for (const [key, propValue] of Object.entries(value)) {
      const propSchema = properties[key];
      if (isPlainObject(propSchema)) {
        const sub = validateJsonOutputSchema(
          propSchema,
          propValue,
          `${currentPath}.${key}`,
        );
        issues.push(...sub.issues);
      } else if (schema["additionalProperties"] === false) {
        issues.push({
          path: `${currentPath}.${key}`,
          message: "unexpected additional property",
        });
      } else if (isPlainObject(schema["additionalProperties"])) {
        const sub = validateJsonOutputSchema(
          schema["additionalProperties"],
          propValue,
          `${currentPath}.${key}`,
        );
        issues.push(...sub.issues);
      }
    }
  }

  if (Array.isArray(schema["allOf"])) {
    for (const subSchema of schema["allOf"]) {
      if (isPlainObject(subSchema)) {
        issues.push(
          ...validateJsonOutputSchema(subSchema, value, currentPath).issues,
        );
      }
    }
  }

  if (Array.isArray(schema["anyOf"])) {
    const branches = schema["anyOf"].filter(isPlainObject);
    if (
      branches.length > 0 &&
      !branches.some(
        (branch) => validateJsonOutputSchema(branch, value, currentPath).ok,
      )
    ) {
      issues.push({
        path: currentPath,
        message: "value did not match any schema in anyOf",
      });
    }
  }

  if (Array.isArray(schema["oneOf"])) {
    const branches = schema["oneOf"].filter(isPlainObject);
    if (branches.length > 0) {
      const matches = branches.filter(
        (branch) => validateJsonOutputSchema(branch, value, currentPath).ok,
      ).length;
      if (matches !== 1) {
        issues.push({
          path: currentPath,
          message: `expected value to match exactly 1 schema in oneOf (matched ${matches})`,
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export function validateAssistantTextAgainstSchema(
  rawText: string,
  schema: Record<string, unknown>,
):
  | { ok: true; value: unknown; canonicalJson: string }
  | { ok: false; issues: JsonSchemaIssue[] } {
  const extracted = extractJsonPayload(rawText);
  if (!extracted.ok) {
    return {
      ok: false,
      issues: [{ path: "$", message: extracted.error }],
    };
  }
  const checked = validateJsonOutputSchema(schema, extracted.value);
  if (!checked.ok) {
    return { ok: false, issues: checked.issues };
  }
  return {
    ok: true,
    value: extracted.value,
    canonicalJson: JSON.stringify(extracted.value),
  };
}
