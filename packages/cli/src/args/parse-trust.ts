import { WORKSPACE_TRUST_RESOURCE_KINDS } from "codepunk-core";

export function parseTrustConflicts(values: {
  trust?: boolean | undefined;
  "no-trust"?: boolean | undefined;
  "trust-resources"?: string | undefined;
}): void {
  if (values.trust === true && values["no-trust"] === true) {
    throw new Error("--trust and --no-trust are mutually exclusive");
  }
  if (
    values["trust-resources"] !== undefined &&
    (values.trust === true || values["no-trust"] === true)
  ) {
    throw new Error(
      "--trust-resources cannot be combined with --trust or --no-trust",
    );
  }
}

export function parseTrustFlags(values: {
  trust?: boolean | undefined;
  "no-trust"?: boolean | undefined;
  "trust-resources"?: string | undefined;
  resources?: string | undefined;
}): {
  trust: "trusted" | "untrusted" | undefined;
  trustResources: string[] | undefined;
  resources: string[] | undefined;
} {
  const trust =
    values.trust === true
      ? ("trusted" as const)
      : values["no-trust"] === true
        ? ("untrusted" as const)
        : undefined;
  const trustResources =
    values["trust-resources"] === undefined
      ? undefined
      : [
          ...new Set(
            values["trust-resources"]
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
          ),
        ];
  if (trustResources !== undefined) {
    if (trustResources.length === 0) {
      throw new Error("--trust-resources must contain at least one kind");
    }
    for (const kind of trustResources) {
      if (
        !(WORKSPACE_TRUST_RESOURCE_KINDS as readonly string[]).includes(kind)
      ) {
        throw new Error(
          `--trust-resources has unknown kind ${kind}; use ${WORKSPACE_TRUST_RESOURCE_KINDS.join(
            ",",
          )}`,
        );
      }
    }
  }
  const resources =
    values.resources === undefined
      ? undefined
      : [
          ...new Set(
            values.resources
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
          ),
        ];
  if (resources !== undefined) {
    if (resources.length === 0) {
      throw new Error("--resources must contain at least one kind");
    }
    for (const kind of resources) {
      if (
        !(WORKSPACE_TRUST_RESOURCE_KINDS as readonly string[]).includes(kind)
      ) {
        throw new Error(
          `--resources has unknown kind ${kind}; use ${WORKSPACE_TRUST_RESOURCE_KINDS.join(
            ",",
          )}`,
        );
      }
    }
  }
  return { trust, trustResources, resources };
}
