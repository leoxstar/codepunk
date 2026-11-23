/**
 * Format-version compatibility helpers (spec 0016, decision D81).
 *
 * Compatibility is decided by each object's own format version, never by the
 * codepunk, Pi, or srt package version. The helpers here only compare a saved
 * format version against the highest version this build understands.
 */

export class FormatVersionError extends Error {
  readonly objectLabel: string;
  readonly field: string;
  readonly saved: unknown;
  readonly current: number;

  constructor(
    objectLabel: string,
    field: string,
    saved: unknown,
    current: number,
  ) {
    super(
      typeof saved === "number" &&
        Number.isInteger(saved) &&
        saved >= 1 &&
        saved > current
        ? `${objectLabel} ${field} ${saved} is newer than supported ${current}; upgrade codepunk to read this object`
        : `${objectLabel} ${field} is missing or not a positive integer (found ${JSON.stringify(saved)}); refusing to read this object`,
    );
    this.name = "FormatVersionError";
    this.objectLabel = objectLabel;
    this.field = field;
    this.saved = saved;
    this.current = current;
  }
}

/**
 * Asserts that `saved` is a positive integer no greater than `current`.
 * Throws a {@link FormatVersionError} naming the object, field, saved value,
 * and current value so callers can re-wrap it in their domain error type.
 */
export function checkFormatVersion(
  objectLabel: string,
  field: string,
  saved: unknown,
  current: number,
): number {
  if (
    typeof saved !== "number" ||
    !Number.isInteger(saved) ||
    saved < 1 ||
    saved > current
  ) {
    throw new FormatVersionError(objectLabel, field, saved, current);
  }
  return saved;
}

/** Convenience for persisted stores whose compatibility field is `version`. */
export function checkStoreVersion(
  store: string,
  saved: unknown,
  current: number,
): number {
  return checkFormatVersion(store, "version", saved, current);
}
