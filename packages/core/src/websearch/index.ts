import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { canonicalNetworkHost, domainListDenies } from "../network/index.ts";

export const WEB_SEARCH_TOOL_NAME = "web_search" as const;

const DEFAULT_ENDPOINT = "https://html.duckduckgo.com/html/";
const DEFAULT_MAX_RESULTS = 5;
const MAX_ALLOWED_RESULTS = 10;
const MAX_RESPONSE_BYTES = 256 * 1024;
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
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(current.url);
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      continue;
    }
    const host = canonicalNetworkHost(parsedUrl.hostname);
    if (host === null) {
      continue;
    }
    if (
      deniedDomains.length > 0 &&
      domainListDenies(
        host,
        parsedUrl.port
          ? Number(parsedUrl.port)
          : parsedUrl.protocol === "https:"
            ? 443
            : 80,
        deniedDomains,
      )
    ) {
      continue;
    }
    const matchingSnippet = snippets.find(
      (entry) => entry.index > current.index && entry.index < nextIndex,
    );
    results.push({
      title: current.title,
      url: parsedUrl.toString(),
      snippet: matchingSnippet?.text ?? "",
    });
  }
  return results;
}

function refused(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
    structuredContent: { searched: false, reason: text },
    isError: true as const,
  };
}

export function createWebSearchTool(
  options: WebSearchToolOptions = {},
): ToolDefinition<any, any, any> {
  const deniedDomains = options.deniedDomains ?? [];
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchFn = options.fetchImpl ?? fetch;

  return {
    name: WEB_SEARCH_TOOL_NAME,
    label: WEB_SEARCH_TOOL_NAME,
    description:
      "Search the public web for up-to-date documentation, release notes, or error messages. " +
      "Respects sandbox.network_deny and returns bounded titles, URLs, and snippets.",
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

      let targetUrl: URL;
      try {
        targetUrl = new URL(endpoint);
        targetUrl.searchParams.set("q", query);
      } catch {
        return refused("web_search endpoint URL is invalid");
      }
      const host = canonicalNetworkHost(targetUrl.hostname);
      if (host === null) {
        return refused("web_search endpoint host is invalid");
      }
      const port = targetUrl.port
        ? Number(targetUrl.port)
        : targetUrl.protocol === "https:"
          ? 443
          : 80;
      if (
        deniedDomains.length > 0 &&
        domainListDenies(host, port, deniedDomains)
      ) {
        return refused(
          `web_search refuses ${host}: it is on the sandbox.network_deny list`,
        );
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await fetchFn(targetUrl.toString(), {
          method: "GET",
          headers: {
            "user-agent": USER_AGENT,
            accept: "text/html,application/json;q=0.9,*/*;q=0.5",
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          return refused(
            `web_search failed with HTTP ${response.status} ${response.statusText}`.trim(),
          );
        }
        const raw = await response.text();
        const bounded =
          Buffer.byteLength(raw) > MAX_RESPONSE_BYTES
            ? raw.slice(0, MAX_RESPONSE_BYTES)
            : raw;
        const results = parseDuckDuckGoHtml(bounded, maxResults, deniedDomains);
        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: `No web results found for "${query}".` },
            ],
            details: { query, count: 0 },
            structuredContent: {
              searched: true,
              query,
              count: 0,
              results: [],
            },
          };
        }
        const formatted = [
          `Web search results for "${query}" (${results.length}):`,
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
          details: { query, count: results.length },
          structuredContent: {
            searched: true,
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
