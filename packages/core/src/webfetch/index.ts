import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { canonicalNetworkHost, domainListDenies } from "../network/index.ts";

const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const USER_AGENT = "codepunk-web-fetch/0.1";

export interface WebFetchToolOptions {
  deniedDomains?: readonly string[];
}

interface FetchTarget {
  url: string;
  host: string;
  port: number;
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

function fetchTarget(raw: string): FetchTarget | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  const host = canonicalNetworkHost(url.hostname);
  if (host === null) {
    return null;
  }
  return {
    url: url.toString(),
    host,
    port:
      url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
  };
}

function refused(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
    structuredContent: { fetched: false, reason: text },
    isError: true as const,
  };
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
      bytes,
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
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString(
    "utf8",
  );
  return { text, bytes: total, truncated };
}

export function createWebFetchTool(
  options: WebFetchToolOptions = {},
): ToolDefinition<any, any, any> {
  const deniedDomains = options.deniedDomains ?? [];
  return {
    name: "web_fetch",
    label: "web_fetch",
    description:
      "Fetch one http(s) URL and return bounded text (JSON, plain text, or raw HTML). " +
      "Each call needs human approval; the domain deny list and private-host guard always apply.",
    promptSnippet:
      "Fetch a URL with web_fetch when a live web resource is needed; every call is approved by the operator",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http(s) URL to fetch",
        },
        max_bytes: {
          type: "integer",
          minimum: 256,
          maximum: 262144,
          default: 65536,
          description: "Response byte cap for this call",
        },
      },
      required: ["url"],
      additionalProperties: false,
    } as never,
    async execute(_toolCallId: string, rawParams: unknown) {
      const params =
        rawParams !== null &&
        typeof rawParams === "object" &&
        !Array.isArray(rawParams)
          ? (rawParams as Record<string, unknown>)
          : {};
      if (typeof params["url"] !== "string") {
        return refused("web_fetch requires a url string");
      }
      const requestedBytes =
        typeof params["max_bytes"] === "number"
          ? Math.trunc(params["max_bytes"])
          : 65_536;
      const maxBytes = Math.max(256, Math.min(MAX_BYTES, requestedBytes));
      const requestedUrl = params["url"];

      let current = fetchTarget(requestedUrl);
      if (current === null) {
        return refused("url must be an absolute http(s) URL");
      }
      let redirects = 0;
      let response: Response | null = null;
      while (current !== null) {
        if (privateHost(current.host)) {
          return refused(
            `web_fetch refuses private, loopback, and link-local hosts (${current.host})`,
          );
        }
        if (domainListDenies(current.host, current.port, deniedDomains)) {
          return refused(
            `web_fetch refuses ${current.host}: it is on the sandbox.network_deny list`,
          );
        }
        try {
          const egressUrl = current.url;
          const next = await fetch(egressUrl, {
            method: "GET",
            redirect: "manual",
            headers: { "user-agent": USER_AGENT },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          const location = next.headers.get("location");
          if (next.status >= 300 && next.status < 400 && location !== null) {
            await next.body?.cancel().catch(() => undefined);
            if (redirects >= MAX_REDIRECTS) {
              return refused(
                `web_fetch stopped after ${MAX_REDIRECTS} redirects`,
              );
            }
            const target = fetchTarget(
              new URL(location, current.url).toString(),
            );
            if (target === null) {
              return refused("redirect target is not an absolute http(s) URL");
            }
            redirects += 1;
            current = target;
            continue;
          }
          response = next;
          current = null;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "fetch failed";
          return refused(`web_fetch request failed: ${message}`);
        }
      }
      if (response === null) {
        return refused("web_fetch produced no response");
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => undefined);
        return refused(
          `web_fetch refuses non-2xx responses (HTTP ${response.status})`,
        );
      }
      const contentType = response.headers.get("content-type") ?? "unknown";
      const bounded = await readBounded(response, maxBytes);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `fetched ${bounded.bytes} bytes from ${requestedUrl} (content-type ${contentType})\n\n` +
              bounded.text,
          },
        ],
        details: {},
        structuredContent: {
          fetched: true,
          url: requestedUrl,
          content_type: contentType,
          bytes: bounded.bytes,
          truncated: bounded.truncated,
        },
        isError: false,
      };
    },
  };
}
