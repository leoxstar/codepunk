import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { canonicalNetworkHost, domainListDenies } from "../network/index.ts";

export const WEB_SEARCH_TOOL_NAME = "web_search" as const;

const DEFAULT_ENDPOINT = "https://html.duckduckgo.com/html/";
const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_MAX_RESULTS = 5;
const MAX_ALLOWED_RESULTS = 10;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const USER_AGENT = "codepunk-web-search/0.1";

export interface WebSearchResultItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface WebSearchToolOptions {
  readonly deniedDomains?: readonly string[];
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly environment?: NodeJS.ProcessEnv;
}

interface SearchTarget {
  readonly url: string;
  readonly host: string;
  readonly port: number;
}

function privateHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal")
  ) {
    return true;
  }
  const v4 =
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(lower) ?? null;
  if (v4 !== null) {
    const octets = v4.slice(1).map(Number);
    if (octets.length < 4 || octets.some((octet) => octet > 255)) {
      return false;
    }
    const first = octets[0] ?? 0;
    const second = octets[1] ?? 0;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first >= 224
    );
  }
  if (
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80") ||
    lower.startsWith("::ffff:")
  ) {
    return true;
  }
  return false;
}

function parseSearchTarget(raw: string): SearchTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const host = canonicalNetworkHost(parsed.hostname);
  if (host === null) {
    return null;
  }
  return {
    url: parsed.toString(),
    host,
    port:
      parsed.port !== ""
        ? Number(parsed.port)
        : parsed.protocol === "https:"
          ? 443
          : 80,
  };
}

function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&nbsp;", " ")
    .replace(/&#(\d+);/gu, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-fA-F]+);/gu, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
}

function stripTags(input: string): string {
  return decodeHtmlEntities(input.replace(/<[^>]+>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
}

function unwrapRedirectUrl(raw: string): string {
  const cleaned = decodeHtmlEntities(raw.trim());
  try {
    const parsed = new URL(
      cleaned.startsWith("//") ? `https:${cleaned}` : cleaned,
      DEFAULT_ENDPOINT,
    );
    const uddg = parsed.searchParams.get("uddg");
    if (uddg !== null && uddg.length > 0) {
      return uddg;
    }
    return parsed.toString();
  } catch {
    return cleaned;
  }
}

function filterAllowedResult(
  rawUrl: string,
  title: string,
  snippet: string,
  deniedDomains: readonly string[],
): WebSearchResultItem | null {
  const target = parseSearchTarget(rawUrl);
  if (target === null || privateHost(target.host)) {
    return null;
  }
  if (
    deniedDomains.length > 0 &&
    domainListDenies(target.host, target.port, deniedDomains)
  ) {
    return null;
  }
  const cleanTitle = title.trim();
  if (cleanTitle.length === 0) {
    return null;
  }
  return {
    title: cleanTitle,
    url: target.url,
    snippet: snippet.trim(),
  };
}

export function parseDuckDuckGoHtml(
  html: string,
  maxResults: number,
  deniedDomains: readonly string[] = [],
): WebSearchResultItem[] {
  const results: WebSearchResultItem[] = [];
  const linkPattern =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu;
  const snippetPattern =
    /<(?:a|div|span)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/giu;

  const links: { url: string; title: string; index: number }[] = [];
  for (const match of html.matchAll(linkPattern)) {
    const rawHref = match[1] ?? "";
    const rawTitle = match[2] ?? "";
    const url = unwrapRedirectUrl(rawHref);
    const title = stripTags(rawTitle);
    if (url.length === 0 || title.length === 0) {
      continue;
    }
    links.push({ url, title, index: match.index ?? 0 });
  }

  const snippets: { text: string; index: number }[] = [];
  for (const match of html.matchAll(snippetPattern)) {
    snippets.push({
      text: stripTags(match[1] ?? ""),
      index: match.index ?? 0,
    });
  }

  for (let i = 0; i < links.length && results.length < maxResults; i++) {
    const current = links[i]!;
    const nextIndex = links[i + 1]?.index ?? Number.POSITIVE_INFINITY;
    const matchingSnippet = snippets.find(
      (entry) => entry.index > current.index && entry.index < nextIndex,
    );
    const filtered = filterAllowedResult(
      current.url,
      current.title,
      matchingSnippet?.text ?? "",
      deniedDomains,
    );
    if (filtered !== null) {
      results.push(filtered);
    }
  }
  return results;
}

export function parseSearchJson(
  payload: unknown,
  maxResults: number,
  deniedDomains: readonly string[] = [],
): WebSearchResultItem[] {
  if (payload === null || typeof payload !== "object") {
    return [];
  }
  const record = payload as Record<string, unknown>;
  const webSection =
    record["web"] !== null && typeof record["web"] === "object"
      ? (record["web"] as Record<string, unknown>)
      : null;
  const rawList = Array.isArray(record["results"])
    ? record["results"]
    : Array.isArray(webSection?.["results"])
      ? webSection["results"]
      : [];
  const results: WebSearchResultItem[] = [];
  for (const entry of rawList) {
    if (results.length >= maxResults) {
      break;
    }
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const url = typeof item["url"] === "string" ? item["url"] : "";
    const title = typeof item["title"] === "string" ? item["title"] : "";
    const snippet =
      typeof item["content"] === "string"
        ? item["content"]
        : typeof item["description"] === "string"
          ? item["description"]
          : typeof item["snippet"] === "string"
            ? item["snippet"]
            : "";
    const filtered = filterAllowedResult(url, title, snippet, deniedDomains);
    if (filtered !== null) {
      results.push(filtered);
    }
  }
  return results;
}

function isBotChallenge(status: number, body: string): boolean {
  if (status === 202 || status === 429) {
    return true;
  }
  return /anomaly-modal|unfortunately,\s+bots|captcha|verify you are human/iu.test(
    body,
  );
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text);
    return {
      text: bytes > maxBytes ? text.slice(0, maxBytes) : text,
      bytes: Math.min(bytes, maxBytes),
      truncated: bytes > maxBytes,
    };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done === true) {
      break;
    }
    const size = chunk.value.byteLength;
    if (total + size > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) {
        chunks.push(chunk.value.subarray(0, remaining));
      }
      total = maxBytes;
      truncated = true;
      break;
    }
    total += size;
    chunks.push(chunk.value);
  }
  if (truncated) {
    await reader.cancel().catch(() => undefined);
  }
  return {
    text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
      "utf8",
    ),
    bytes: total,
    truncated,
  };
}

function refused(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
    structuredContent: { searched: false, reason: text },
    isError: true as const,
  };
}

interface SearchBackendSpec {
  readonly name: "tavily" | "brave" | "custom" | "duckduckgo";
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Record<string, string>;
  readonly body?: string;
}

function resolveSearchBackend(
  query: string,
  maxResults: number,
  options: WebSearchToolOptions,
): SearchBackendSpec | { error: string } {
  const env = options.environment ?? process.env;
  if (options.endpoint !== undefined) {
    try {
      const targetUrl = new URL(options.endpoint);
      targetUrl.searchParams.set("q", query);
      return {
        name: "custom",
        url: targetUrl.toString(),
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json,text/html;q=0.9,*/*;q=0.5",
        },
      };
    } catch {
      return { error: "web_search endpoint URL is invalid" };
    }
  }
  const tavilyKey = env["TAVILY_API_KEY"]?.trim() ?? "";
  if (tavilyKey.length > 0) {
    return {
      name: "tavily",
      url: TAVILY_ENDPOINT,
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        api_key: tavilyKey,
        query,
        max_results: maxResults,
      }),
    };
  }
  const braveKey = env["BRAVE_API_KEY"]?.trim() ?? "";
  if (braveKey.length > 0) {
    const targetUrl = new URL(BRAVE_ENDPOINT);
    targetUrl.searchParams.set("q", query);
    targetUrl.searchParams.set("count", String(maxResults));
    return {
      name: "brave",
      url: targetUrl.toString(),
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
        "x-subscription-token": braveKey,
      },
    };
  }
  const customEndpoint = env["CODEPUNK_SEARCH_ENDPOINT"]?.trim() ?? "";
  if (customEndpoint.length > 0) {
    try {
      const targetUrl = new URL(customEndpoint);
      targetUrl.searchParams.set("q", query);
      return {
        name: "custom",
        url: targetUrl.toString(),
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json,text/html;q=0.9,*/*;q=0.5",
        },
      };
    } catch {
      return { error: "CODEPUNK_SEARCH_ENDPOINT is not a valid URL" };
    }
  }
  const ddgUrl = new URL(DEFAULT_ENDPOINT);
  ddgUrl.searchParams.set("q", query);
  return {
    name: "duckduckgo",
    url: ddgUrl.toString(),
    method: "GET",
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/json;q=0.9,*/*;q=0.5",
    },
  };
}

export function createWebSearchTool(
  options: WebSearchToolOptions = {},
): ToolDefinition<any, any, any> {
  const deniedDomains = options.deniedDomains ?? [];
  const fetchFn = options.fetchImpl ?? fetch;

  return {
    name: WEB_SEARCH_TOOL_NAME,
    label: WEB_SEARCH_TOOL_NAME,
    description:
      "Search the public web for up-to-date documentation, release notes, or error messages. " +
      "Respects sandbox.network_deny, refuses private hosts, and returns bounded titles, URLs, and snippets.",
    promptSnippet:
      "Use web_search to find public documentation or references when local files are insufficient",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query string",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: MAX_ALLOWED_RESULTS,
          default: DEFAULT_MAX_RESULTS,
          description: "Maximum number of search results to return",
        },
      },
      required: ["query"],
      additionalProperties: false,
    } as never,
    async execute(
      _toolCallId,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
    ) {
      const query =
        typeof params["query"] === "string" ? params["query"].trim() : "";
      if (query.length === 0) {
        return refused("web_search requires a non-empty query string");
      }
      const rawMax = params["max_results"];
      const maxResults =
        typeof rawMax === "number" && Number.isFinite(rawMax)
          ? Math.max(1, Math.min(MAX_ALLOWED_RESULTS, Math.floor(rawMax)))
          : DEFAULT_MAX_RESULTS;

      const backend = resolveSearchBackend(query, maxResults, options);
      if ("error" in backend) {
        return refused(backend.error);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        let current = parseSearchTarget(backend.url);
        if (current === null) {
          return refused("web_search endpoint URL must be http(s)");
        }
        let redirects = 0;
        let response: Response | null = null;
        while (current !== null) {
          if (privateHost(current.host)) {
            return refused(
              `web_search refuses private, loopback, and link-local hosts (${current.host})`,
            );
          }
          if (
            deniedDomains.length > 0 &&
            domainListDenies(current.host, current.port, deniedDomains)
          ) {
            return refused(
              `web_search refuses ${current.host}: it is on the sandbox.network_deny list`,
            );
          }
          const next = await fetchFn(current.url, {
            method: redirects === 0 ? backend.method : "GET",
            redirect: "manual",
            headers: backend.headers,
            ...(redirects === 0 && backend.body !== undefined
              ? { body: backend.body }
              : {}),
            signal: controller.signal,
          });
          const location = next.headers.get("location");
          if (next.status >= 300 && next.status < 400 && location !== null) {
            await next.body?.cancel().catch(() => undefined);
            if (redirects >= MAX_REDIRECTS) {
              return refused(
                `web_search stopped after ${MAX_REDIRECTS} redirects`,
              );
            }
            const nextTarget = parseSearchTarget(
              new URL(location, current.url).toString(),
            );
            if (nextTarget === null) {
              return refused(
                "web_search redirect target is not an absolute http(s) URL",
              );
            }
            redirects += 1;
            current = nextTarget;
            continue;
          }
          response = next;
          current = null;
        }
        if (response === null) {
          return refused("web_search produced no response");
        }
        const contentType = response.headers.get("content-type") ?? "";
        const bounded = await readBounded(response, MAX_RESPONSE_BYTES);
        if (isBotChallenge(response.status, bounded.text)) {
          return refused(
            `web_search backend (${backend.name}) returned a rate-limit or bot challenge (HTTP ${response.status}). ` +
              "Set TAVILY_API_KEY, BRAVE_API_KEY, or CODEPUNK_SEARCH_ENDPOINT for reliable search.",
          );
        }
        if (response.status < 200 || response.status >= 300) {
          return refused(
            `web_search failed with HTTP ${response.status} ${response.statusText}`.trim(),
          );
        }
        const looksJson =
          contentType.toLowerCase().includes("json") ||
          bounded.text.trimStart().startsWith("{");
        let results: WebSearchResultItem[] = [];
        if (looksJson) {
          try {
            results = parseSearchJson(
              JSON.parse(bounded.text),
              maxResults,
              deniedDomains,
            );
          } catch {
            results = [];
          }
        }
        if (results.length === 0 && !looksJson) {
          results = parseDuckDuckGoHtml(
            bounded.text,
            maxResults,
            deniedDomains,
          );
        }
        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: `No web results found for "${query}".` },
            ],
            details: { query, count: 0, backend: backend.name },
            structuredContent: {
              searched: true,
              backend: backend.name,
              query,
              count: 0,
              results: [],
            },
          };
        }
        const formatted = [
          `Web search results for "${query}" (${results.length}, backend ${backend.name}):`,
          ...results.map((item, idx) =>
            [
              `${idx + 1}. ${item.title}`,
              `   ${item.url}`,
              ...(item.snippet.length > 0 ? [`   ${item.snippet}`] : []),
            ].join("\n"),
          ),
        ].join("\n");
        return {
          content: [{ type: "text", text: formatted }],
          details: { query, count: results.length, backend: backend.name },
          structuredContent: {
            searched: true,
            backend: backend.name,
            query,
            count: results.length,
            results: results.map((item) => ({
              title: item.title,
              url: item.url,
              snippet: item.snippet,
            })),
          },
        };
      } catch (error) {
        const message =
          error instanceof Error && error.name === "AbortError"
            ? "request timed out or was cancelled"
            : error instanceof Error
              ? error.message
              : String(error);
        return refused(`web_search request failed: ${message}`);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
