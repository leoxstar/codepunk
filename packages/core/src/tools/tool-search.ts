import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const TOOL_SEARCH_TOOL_NAME = "tool_search" as const;
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;
export const LAZY_MCP_TOOL_THRESHOLD = 8;

export interface ToolSearchNamespace {
  readonly name?: string;
  readonly description?: string;
  readonly instructions?: string;
}

export interface ToolSearchCandidate {
  readonly name: string;
  readonly description: string;
  readonly parameters?: unknown;
  readonly exposure?: string;
  readonly namespace?: ToolSearchNamespace;
}

export interface ToolSearchRegistry {
  getActiveToolNames(): string[];
  getAllTools(): readonly ToolSearchCandidate[];
  setActiveToolsByName(toolNames: string[]): void;
}

export interface RankedDeferredTool {
  readonly name: string;
  readonly score: number;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

const NAME_WEIGHT = 3;
const NAMESPACE_WEIGHT = 0.5;
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) {
    return `${term.slice(0, -3)}y`;
  }
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/u.test(term)) {
    return term.slice(0, -2);
  }
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) {
    return term.slice(0, -1);
  }
  return term;
}

function tokenize(text: string): string[] {
  const normalized = text
    .normalize("NFC")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ");
  const words = /^[a-z0-9 ]*$/u.test(normalized)
    ? normalized.split(" ")
    : Array.from(wordSegmenter.segment(normalized), (segment) =>
        segment.isWordLike ? segment.segment : "",
      );
  return words
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word))
    .map((word) => (/^[a-z0-9]+$/u.test(word) ? stem(word) : word));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectSchemaText(
  schema: unknown,
  parts: string[],
  seen: Set<object>,
): void {
  if (!isRecord(schema) || seen.has(schema)) {
    return;
  }
  seen.add(schema);
  if (typeof schema["description"] === "string") {
    parts.push(schema["description"]);
  }
  if (isRecord(schema["properties"])) {
    for (const [key, prop] of Object.entries(schema["properties"])) {
      parts.push(key);
      collectSchemaText(prop, parts, seen);
    }
  }
  collectSchemaText(schema["items"], parts, seen);
  for (const variantKey of ["anyOf", "oneOf", "allOf"] as const) {
    const variants = schema[variantKey];
    if (Array.isArray(variants)) {
      for (const variant of variants) {
        collectSchemaText(variant, parts, seen);
      }
    }
  }
}

function normalizeToolName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_$]/gu, "_");
}

function isExactNameQuery(normalizedQuery: string, toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return (
    normalized === normalizedQuery ||
    normalized.endsWith(`__${normalizedQuery}`)
  );
}

interface IndexedTool {
  readonly name: string;
  readonly nameTerms: Set<string>;
  readonly localNameTerms: string[];
  readonly textCounts: Map<string, number>;
  readonly textLength: number;
  readonly namespaceTerms: Set<string>;
}

function indexCandidate(candidate: ToolSearchCandidate): IndexedTool {
  const parts = [candidate.description];
  collectSchemaText(candidate.parameters, parts, new Set());
  const textCounts = new Map<string, number>();
  for (const term of tokenize(parts.filter((part) => part.trim()).join(" "))) {
    textCounts.set(term, (textCounts.get(term) ?? 0) + 1);
  }
  const segments = candidate.name.split("__");
  const serverSegment =
    candidate.name.startsWith("mcp__") && segments.length >= 3
      ? (segments[1] ?? "")
      : "";
  const namespaceRaw = [
    serverSegment,
    candidate.namespace?.name ?? "",
    candidate.namespace?.description ?? "",
    candidate.namespace?.instructions ?? "",
  ].join(" ");
  return {
    name: candidate.name,
    nameTerms: new Set(tokenize(candidate.name)),
    localNameTerms: [
      ...new Set(tokenize(segments[segments.length - 1] ?? candidate.name)),
    ],
    textCounts,
    textLength: [...textCounts.values()].reduce((sum, value) => sum + value, 0),
    namespaceTerms: new Set(tokenize(namespaceRaw)),
  };
}

export function rankDeferredTools(
  query: string,
  candidates: readonly ToolSearchCandidate[],
  limit = DEFAULT_TOOL_SEARCH_LIMIT,
): RankedDeferredTool[] {
  const queryTerms = new Set(tokenize(query));
  if (queryTerms.size === 0 || candidates.length === 0 || limit <= 0) {
    return [];
  }
  const indexed = candidates.map(indexCandidate);
  const averageLength =
    indexed.reduce((sum, doc) => sum + doc.textLength, 0) / indexed.length || 1;
  const k1 = 1.2;
  const b = 0.75;
  const idf = new Map<string, number>(
    [...queryTerms].map((term) => {
      const freq = indexed.filter(
        (doc) =>
          doc.nameTerms.has(term) ||
          doc.textCounts.has(term) ||
          doc.namespaceTerms.has(term),
      ).length;
      return [term, Math.log(1 + (indexed.length - freq + 0.5) / (freq + 0.5))];
    }),
  );
  const fullNameBonus = [...idf.values()].reduce((sum, v) => sum + v, 0);
  const exactQuery = normalizeToolName(query);
  const matches: {
    name: string;
    score: number;
    covered: number;
    exact: boolean;
  }[] = [];
  for (const doc of indexed) {
    const norm = k1 * (1 - b + (b * doc.textLength) / averageLength);
    let score = 0;
    let covered = 0;
    for (const term of queryTerms) {
      const count = doc.textCounts.get(term) ?? 0;
      const weight =
        (doc.nameTerms.has(term) ? NAME_WEIGHT : 0) +
        (doc.namespaceTerms.has(term) ? NAMESPACE_WEIGHT : 0) +
        (count * (k1 + 1)) / (count + norm);
      if (weight > 0) {
        covered += 1;
      }
      score += (idf.get(term) ?? 0) * weight;
    }
    if (score === 0) {
      continue;
    }
    if (
      doc.localNameTerms.length > 0 &&
      doc.localNameTerms.every((term) => queryTerms.has(term))
    ) {
      score += fullNameBonus;
    }
    matches.push({
      name: doc.name,
      score,
      covered,
      exact: isExactNameQuery(exactQuery, doc.name),
    });
  }
  return matches
    .sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        b.covered - a.covered ||
        b.score - a.score,
    )
    .slice(0, limit)
    .map(({ name, score }) => ({ name, score }));
}

export function shouldDeferMcpTools(
  extraTools: readonly { readonly name: string }[],
  explicitLazyMcp?: boolean,
): boolean {
  const mcpCount = extraTools.filter((tool) =>
    tool.name.startsWith("mcp__"),
  ).length;
  if (mcpCount === 0) {
    return false;
  }
  if (explicitLazyMcp !== undefined) {
    return explicitLazyMcp;
  }
  return mcpCount > LAZY_MCP_TOOL_THRESHOLD;
}

export const TOOL_SEARCH_DESCRIPTION = [
  "# Tool discovery",
  "",
  "Searches deferred MCP tool metadata with BM25 and loads matching tools for the next model turn.",
  `When many MCP tools are registered, their schemas are deferred out of the initial prompt; call \`${TOOL_SEARCH_TOOL_NAME}\` with keywords or a tool name to activate the relevant MCP tools on demand.`,
].join("\n");

export function createToolSearchTool(
  getRegistry: () => ToolSearchRegistry | null,
): ToolDefinition<any, any, any> {
  return {
    name: TOOL_SEARCH_TOOL_NAME,
    label: TOOL_SEARCH_TOOL_NAME,
    description: TOOL_SEARCH_DESCRIPTION,
    promptSnippet:
      "Search deferred MCP tools by keyword or name and activate matches",
    exposure: "model-only",
    reachesTools: () => "all",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "Keywords or tool name to search in deferred MCP tools.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 32,
          description: `Maximum number of tools to activate (default ${DEFAULT_TOOL_SEARCH_LIMIT}).`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    } as never,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<{ loaded: string[] }>> {
      const rawQuery =
        typeof params["query"] === "string" ? params["query"] : "";
      const query = rawQuery.trim();
      if (query.length === 0) {
        return {
          content: [{ type: "text", text: "query must not be empty" }],
          details: { loaded: [] },
          isError: true,
        };
      }
      const rawLimit = params["limit"];
      const limit =
        rawLimit === undefined ? DEFAULT_TOOL_SEARCH_LIMIT : Number(rawLimit);
      if (!Number.isInteger(limit) || limit <= 0) {
        return {
          content: [{ type: "text", text: "limit must be a positive integer" }],
          details: { loaded: [] },
          isError: true,
        };
      }
      const registry = getRegistry();
      if (registry === null) {
        return {
          content: [{ type: "text", text: "No matching tools found." }],
          details: { loaded: [] },
          structuredContent: { query, loaded: [], count: 0 },
        };
      }
      const active = registry.getActiveToolNames();
      const activeSet = new Set(active);
      const candidates = registry
        .getAllTools()
        .filter(
          (tool) =>
            (tool.exposure === "deferred" || tool.exposure === "codemode") &&
            !activeSet.has(tool.name),
        );
      const ranked = rankDeferredTools(query, candidates, limit);
      const loadedNames = ranked.map((match) => match.name);
      if (loadedNames.length > 0) {
        registry.setActiveToolsByName([...active, ...loadedNames]);
      }
      const text =
        loadedNames.length === 0
          ? "No matching tools found."
          : [
              `Loaded ${loadedNames.length} tool${loadedNames.length === 1 ? "" : "s"}. They are available from your next call:`,
              ...loadedNames.map((name) => {
                const desc =
                  candidates
                    .find((candidate) => candidate.name === name)
                    ?.description.trim()
                    .split(/\r?\n/u)[0] ?? "";
                return desc.length > 0 ? `- ${name}: ${desc}` : `- ${name}`;
              }),
            ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { loaded: loadedNames },
        structuredContent: {
          query,
          loaded: loadedNames,
          count: loadedNames.length,
        },
      };
    },
  };
}
