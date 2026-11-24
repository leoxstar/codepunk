import type { WorkspaceTrust } from "codepunk-core";

export function trustDisplay(trust: WorkspaceTrust): string {
  const allowed = trust.available.filter((kind) => trust.grants[kind]);
  const value =
    trust.mode === "all"
      ? "trusted"
      : trust.mode === "none"
        ? "untrusted"
        : allowed.length === 0
          ? "custom"
          : `custom (${allowed.join(", ")})`;
  if (trust.mode === "custom") {
    const scope =
      trust.source === "prompt" && trust.savedPath === null
        ? "session only"
        : trust.source === "flag"
          ? "one run"
          : trust.source === "saved" || trust.savedPath !== null
            ? "saved"
            : null;
    return scope === null ? value : `${value} · ${scope}`;
  }
  if (trust.source === "prompt" && trust.savedPath === null) {
    return `${value} (session only)`;
  }
  if (trust.source === "flag") {
    return `${value} (one run)`;
  }
  if (trust.source === "saved" || trust.savedPath !== null) {
    return `${value} (saved)`;
  }
  return value;
}
