import { createHash, randomBytes } from "node:crypto";

export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();

  function normalize(input: unknown): unknown {
    if (input === null || typeof input !== "object") {
      return input;
    }
    if (seen.has(input)) {
      throw new TypeError("cannot canonicalize a cyclic value");
    }
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        return input.map((item) => normalize(item));
      }
      const record = input as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        const item = record[key];
        if (item !== undefined) {
          output[key] = normalize(item);
        }
      }
      return output;
    } finally {
      seen.delete(input);
    }
  }

  return JSON.stringify(normalize(value));
}

export function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function sha256Bytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sha256Value(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

export function recordHash(value: unknown): string {
  return sha256Value(value);
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function createUlid(now: Date = new Date()): string {
  let time = now.getTime();
  let timePart = "";
  for (let index = 0; index < 10; index += 1) {
    timePart = ULID_ALPHABET[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  const random = randomBytes(16);
  let randomPart = "";
  for (let index = 0; index < 16; index += 1) {
    randomPart += ULID_ALPHABET[random[index]! % 32];
  }
  return `${timePart}${randomPart}`;
}
