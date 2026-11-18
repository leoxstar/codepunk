import { isIP } from "node:net";
import type {
  FilterRequestCallback,
  RequestDecision,
  RequestInfo,
} from "@anthropic-ai/sandbox-runtime";

/**
 * Per-domain egress accounting for the sandbox proxy.
 *
 * The sandbox runtime owns the allow and deny lists and refuses a host it
 * does not admit. This guard repeats the same decision for every request the
 * proxy parses so codepunk can count requests and bytes per domain, refuse a
 * request before it is forwarded when a budget would be exceeded, and treat
 * every redirect hop as a fresh domain decision instead of inheriting the
 * first hop's answer.
 *
 * Scope limit, stated here because the events must not overstate what was
 * observed: the proxy only calls the hook for requests it parses. Plain HTTP
 * goes through the hook. HTTPS that is not TLS-terminated is tunnelled
 * through CONNECT and never reaches the hook, so those requests are governed
 * by the runtime's allowlist alone: they are neither counted nor budgeted
 * here, and their response bytes are never seen.
 */

export const NETWORK_EVENT_KINDS = [
  "network/request",
  "network/redirect",
  "network/rejected",
] as const;

export type NetworkEventKind = (typeof NETWORK_EVENT_KINDS)[number];

export type NetworkDecision = "allow" | "deny";

export type NetworkRejectionReason =
  "domain_not_allowed" | "domain_denied" | "max_requests" | "max_bytes";

export interface NetworkLimit {
  max_requests: number | null;
  max_bytes: number | null;
}

export interface NetworkRequestEventData {
  run_id: string;
  domain: string;
  requests: number;
  bytes: number;
  limit: NetworkLimit;
  decision: NetworkDecision;
}

export interface NetworkRedirectEventData {
  run_id: string;
  from: string;
  to: string;
  status: number;
  decision: NetworkDecision;
}

export interface NetworkRejectedEventData {
  run_id: string;
  domain: string;
  reason: NetworkRejectionReason;
  limit: NetworkLimit;
}

export type NetworkEventData =
  NetworkRequestEventData | NetworkRedirectEventData | NetworkRejectedEventData;

export type NetworkEventSink = (
  kind: NetworkEventKind,
  data: NetworkEventData,
) => void | Promise<void>;

export interface NetworkGuardOptions {
  /**
   * Run id stamped on every event. It is resolved per event because the
   * sandbox starts before the run that uses it exists.
   */
  runId: string | (() => string);
  /** Domains the sandboxed process may reach. Empty means no egress. */
  allow?: readonly string[] | undefined;
  /** Domains the sandbox must never reach, even when a wildcard allows them. */
  deny?: readonly string[] | undefined;
  /** Per-domain request budget. `null` means unlimited. */
  maxRequests?: number | null | undefined;
  /** Per-domain byte budget. `null` means unlimited. */
  maxBytes?: number | null | undefined;
  /**
   * Sink for the emitted events. A sink failure never changes a network
   * decision: the request is judged by the policy, not by the log.
   */
  onEvent?: NetworkEventSink | undefined;
}

interface DomainEntry {
  host: string;
  port: number | null;
}

interface DomainUsage {
  requests: number;
  bytes: number;
}

interface RequestTarget {
  host: string;
  port: number;
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * The IPv4 address an IPv4-mapped IPv6 literal connects to. The sandbox
 * runtime compares the mapped spelling, so an allowlist entry for
 * `127.0.0.1` must also admit `::ffff:127.0.0.1`.
 */
function mappedIPv4(address: string): string | null {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
  if (match === null) {
    return null;
  }
  const high = Number.parseInt(match[1]!, 16);
  const low = Number.parseInt(match[2]!, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * Canonical host spelling, matching the runtime's: lower case, no trailing
 * dot, IPv4 shorthand expanded, and an IPv4-mapped IPv6 literal spelled as the
 * IPv4 address it connects to. `null` means the host is not a valid name.
 */
export function canonicalNetworkHost(host: string): string | null {
  const bare = stripBrackets(host.trim());
  if (bare.length === 0 || bare.includes("%")) {
    return null;
  }
  const bracketed = isIP(bare) === 6 ? `[${bare}]` : bare;
  let hostname: string;
  try {
    hostname = stripBrackets(new URL(`http://${bracketed}/`).hostname);
  } catch {
    return null;
  }
  if (isIP(hostname) === 6) {
    return mappedIPv4(hostname) ?? hostname;
  }
  return hostname.replace(/\.$/u, "");
}

/**
 * An allow or deny entry: a host pattern with an optional `:port` suffix.
 * The port restricts the entry to that destination port; an entry without a
 * port matches every port.
 */
function parseDomainEntry(entry: string): DomainEntry | null {
  const trimmed = entry.trim().toLowerCase();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end < 0) {
      return null;
    }
    const host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    if (rest === "") {
      return { host, port: null };
    }
    if (!rest.startsWith(":")) {
      return null;
    }
    const port = Number.parseInt(rest.slice(1), 10);
    return Number.isInteger(port) ? { host, port } : null;
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0) {
    const host = trimmed.slice(0, colon);
    const portText = trimmed.slice(colon + 1);
    if (/^\d+$/u.test(portText)) {
      const port = Number.parseInt(portText, 10);
      return { host, port };
    }
  }
  return { host: trimmed, port: null };
}

/**
 * Host matching, matching the runtime's rules: `*` matches everything, a
 * `*.` prefix matches the strict subdomains of its base and never the base
 * itself, and anything else matches the host exactly. A wildcard never
 * matches an IP literal.
 */
function matchesDomainEntry(
  host: string,
  port: number,
  entry: DomainEntry,
): boolean {
  if (entry.port !== null && entry.port !== port) {
    return false;
  }
  if (entry.host === "*") {
    return true;
  }
  if (entry.host.startsWith("*.")) {
    if (isIP(host) !== 0) {
      return false;
    }
    return host.endsWith(`.${entry.host.slice(2)}`);
  }
  return host === entry.host;
}

function headerText(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const value = headers[name];
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return null;
}

function headerLength(
  headers: Record<string, string | string[] | undefined>,
): number | null {
  const raw = headerText(headers, "content-length");
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

/**
 * The request body size when the client declared it. A chunked body has no
 * declared length; those bytes are not counted rather than guessed.
 */
function requestBodyBytes(request: Request): number {
  const raw = request.headers.get("content-length");
  if (raw === null) {
    return 0;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    return 0;
  }
  return value;
}

/**
 * The host and port a redirect points at. A relative target stays on the
 * current host and port; an absolute target is parsed, and a target with a
 * scheme the proxy does not carry (for example `file:`) is ignored.
 */
function redirectTarget(
  from: string,
  port: number,
  location: string,
): RequestTarget | null {
  const trimmed = location.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith("//")) {
    return absoluteRedirectTarget(`http:${trimmed}`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(trimmed)) {
    return absoluteRedirectTarget(trimmed);
  }
  return { host: from, port };
}

function absoluteRedirectTarget(target: string): RequestTarget | null {
  let url: URL;
  try {
    url = new URL(target);
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
  const targetPort =
    url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { host, port: targetPort };
}

/**
 * The egress guard installed on the sandbox proxy.
 *
 * Counters are per domain and live for the session the guard belongs to. A
 * request that would exceed a budget is refused before it is forwarded; a
 * refused request is not counted, because it never left the process.
 */
export class NetworkGuard {
  readonly filterRequest: FilterRequestCallback;
  private readonly allowEntries: readonly DomainEntry[];
  private readonly denyEntries: readonly DomainEntry[];
  private readonly maxRequests: number | null;
  private readonly maxBytes: number | null;
  private readonly runId: string | (() => string);
  private readonly onEvent: NetworkEventSink | undefined;
  private readonly usage = new Map<string, DomainUsage>();
  private tail: Promise<void> = Promise.resolve();

  constructor(options: NetworkGuardOptions) {
    this.allowEntries = (options.allow ?? [])
      .map((entry) => parseDomainEntry(entry))
      .filter((entry): entry is DomainEntry => entry !== null);
    this.denyEntries = (options.deny ?? [])
      .map((entry) => parseDomainEntry(entry))
      .filter((entry): entry is DomainEntry => entry !== null);
    this.maxRequests = options.maxRequests ?? null;
    this.maxBytes = options.maxBytes ?? null;
    this.runId = options.runId;
    this.onEvent = options.onEvent;
    this.filterRequest = async (request, info) =>
      await this.decide(request, info);
  }

  /** The configured budgets, in the shape the session events carry. */
  limit(): NetworkLimit {
    return {
      max_requests: this.maxRequests,
      max_bytes: this.maxBytes,
    };
  }

  /** The counters of one domain, for a caller that reports the state. */
  usageFor(domain: string): DomainUsage {
    const usage = this.usage.get(domain);
    if (usage !== undefined) {
      return { ...usage };
    }
    return { requests: 0, bytes: 0 };
  }

  private currentRunId(): string {
    const runId = typeof this.runId === "function" ? this.runId() : this.runId;
    return runId.length === 0 ? "sandbox" : runId;
  }

  private usageEntry(domain: string): DomainUsage {
    const existing = this.usage.get(domain);
    if (existing !== undefined) {
      return existing;
    }
    const created: DomainUsage = { requests: 0, bytes: 0 };
    this.usage.set(domain, created);
    return created;
  }

  private emit(kind: NetworkEventKind, data: NetworkEventData): Promise<void> {
    const sink = this.onEvent;
    if (sink === undefined) {
      return Promise.resolve();
    }
    const operation = this.tail.then(async () => {
      await sink(kind, data);
    });
    // A failing sink must not change a network decision, and it must not
    // break the chain for the events that follow it.
    this.tail = operation.catch(() => undefined);
    return operation.catch(() => undefined);
  }

  /**
   * The domain decision for a host and port. The deny list is checked before
   * the allow list, and a host that matches neither is refused: the sandbox
   * runs without an ask callback, so an unmatched host has no other way in.
   */
  private domainDenial(
    host: string,
    port: number,
  ): NetworkRejectionReason | null {
    if (
      this.denyEntries.some((entry) => matchesDomainEntry(host, port, entry))
    ) {
      return "domain_denied";
    }
    if (
      this.allowEntries.some((entry) => matchesDomainEntry(host, port, entry))
    ) {
      return null;
    }
    return "domain_not_allowed";
  }

  private evaluate(
    host: string,
    port: number,
    requestBytes: number,
  ): { decision: NetworkDecision; reason: NetworkRejectionReason | null } {
    const denial = this.domainDenial(host, port);
    if (denial !== null) {
      return { decision: "deny", reason: denial };
    }
    const usage = this.usageEntry(host);
    if (this.maxRequests !== null && usage.requests + 1 > this.maxRequests) {
      return { decision: "deny", reason: "max_requests" };
    }
    if (this.maxBytes !== null && usage.bytes + requestBytes > this.maxBytes) {
      return { decision: "deny", reason: "max_bytes" };
    }
    return { decision: "allow", reason: null };
  }

  private requestTarget(
    request: Request,
    info: RequestInfo | undefined,
  ): RequestTarget | null {
    if (info?.target !== undefined) {
      const host = canonicalNetworkHost(info.target.host);
      if (host === null) {
        return null;
      }
      return { host, port: info.target.port };
    }
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return null;
    }
    const host = canonicalNetworkHost(url.hostname);
    if (host === null) {
      return null;
    }
    const port =
      url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    return { host, port };
  }

  private async decide(
    request: Request,
    info: RequestInfo | undefined,
  ): Promise<RequestDecision> {
    const target = this.requestTarget(request, info);
    if (target === null) {
      return {
        action: "deny",
        reason: "the request target could not be parsed",
        status: 400,
        mark: "network_policy",
      };
    }
    const requestBytes = requestBodyBytes(request);
    const verdict = this.evaluate(target.host, target.port, requestBytes);
    const usage = this.usageEntry(target.host);
    if (verdict.decision === "deny") {
      await this.emit("network/request", {
        run_id: this.currentRunId(),
        domain: target.host,
        requests: usage.requests,
        bytes: usage.bytes,
        limit: this.limit(),
        decision: "deny",
      });
      await this.emit("network/rejected", {
        run_id: this.currentRunId(),
        domain: target.host,
        reason: verdict.reason ?? "domain_not_allowed",
        limit: this.limit(),
      });
      return {
        action: "deny",
        reason: this.denialReason(target.host, verdict.reason),
        status: 403,
        mark: "network_policy",
      };
    }
    usage.requests += 1;
    usage.bytes += requestBytes;
    await this.emit("network/request", {
      run_id: this.currentRunId(),
      domain: target.host,
      requests: usage.requests,
      bytes: usage.bytes,
      limit: this.limit(),
      decision: "allow",
    });
    return {
      action: "allow",
      onResponse: (status, headers) => {
        this.observeResponse(target.host, target.port, status, headers);
      },
    };
  }

  private denialReason(
    host: string,
    reason: NetworkRejectionReason | null,
  ): string {
    if (reason === "domain_denied") {
      return `${host} is on the sandbox deny list`;
    }
    if (reason === "domain_not_allowed") {
      return `${host} is not on the sandbox allow list`;
    }
    if (reason === "max_requests") {
      return `the request budget for ${host} is exhausted`;
    }
    if (reason === "max_bytes") {
      return `the byte budget for ${host} is exhausted`;
    }
    return `${host} is not allowed by the sandbox network policy`;
  }

  /**
   * A response arrived. Its declared length is added to the domain's byte
   * counter, and a redirect is recorded as a fresh domain decision for the
   * target instead of inheriting the answer the first hop was given.
   */
  private observeResponse(
    host: string,
    port: number,
    status: number,
    headers: Record<string, string | string[] | undefined>,
  ): void {
    const usage = this.usageEntry(host);
    const length = headerLength(headers);
    if (length !== null) {
      usage.bytes += length;
    }
    if (status < 300 || status > 399) {
      return;
    }
    const location = headerText(headers, "location");
    if (location === null) {
      return;
    }
    void this.recordRedirect(host, port, status, location);
  }

  private async recordRedirect(
    from: string,
    port: number,
    status: number,
    location: string,
  ): Promise<void> {
    const target = redirectTarget(from, port, location);
    if (target === null) {
      return;
    }
    const denial = this.domainDenial(target.host, target.port);
    await this.emit("network/redirect", {
      run_id: this.currentRunId(),
      from,
      to: target.host,
      status,
      decision: denial === null ? "allow" : "deny",
    });
    if (denial === null) {
      return;
    }
    // The target is refused by the same policy the first hop was judged by.
    // The hop never reaches the proxy hook, so the refusal is recorded here.
    await this.emit("network/rejected", {
      run_id: this.currentRunId(),
      domain: target.host,
      reason: denial,
      limit: this.limit(),
    });
  }
}
