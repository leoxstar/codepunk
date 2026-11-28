import { SCHEMA_VERSIONS } from "./constants.ts";

export const PROTOCOL_VERSION = SCHEMA_VERSIONS.protocol;
export const EVIDENCE_SCHEMA_VERSION = SCHEMA_VERSIONS.evidence;
export const SESSION_EVENT_SCHEMA_VERSION = SCHEMA_VERSIONS.sessionEvent;
export const AGENT_STATE_SCHEMA_VERSION = SCHEMA_VERSIONS.agentState;
export const VERDICT_SCHEMA_VERSION = SCHEMA_VERSIONS.verdict;

export type ProtocolKind =
  "evidence" | "session-event" | "agent-state" | "verdict";

export class ProtocolError extends Error {
  readonly kind: ProtocolKind;
  readonly version: number;

  constructor(kind: ProtocolKind, version: number, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.kind = kind;
    this.version = version;
  }
}

const CURRENT_BY_KIND: Record<ProtocolKind, number> = {
  evidence: EVIDENCE_SCHEMA_VERSION,
  "session-event": SESSION_EVENT_SCHEMA_VERSION,
  "agent-state": AGENT_STATE_SCHEMA_VERSION,
  verdict: VERDICT_SCHEMA_VERSION,
};

export function currentVersionFor(kind: ProtocolKind): number {
  return CURRENT_BY_KIND[kind];
}

export function assertSupportedVersion(
  kind: ProtocolKind,
  version: unknown,
): asserts version is number {
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new ProtocolError(kind, -1, `${kind} version is missing or invalid`);
  }
  if (version < 1) {
    throw new ProtocolError(
      kind,
      version,
      `${kind} version ${version} is not a positive schema version`,
    );
  }
  const current = currentVersionFor(kind);
  if (version > current) {
    throw new ProtocolError(
      kind,
      version,
      `${kind} version ${version} is newer than supported version ${current}`,
    );
  }
}
