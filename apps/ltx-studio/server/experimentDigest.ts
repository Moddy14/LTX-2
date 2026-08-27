import { createHash } from "node:crypto";

/**
 * Canonical JSON used by the frozen experiment.v1 protocol. This compact
 * encoding is intentionally distinct from the pretty, newline-terminated job
 * authority encoding in shared/canonicalJson.ts. Changing it would invalidate
 * already frozen experiment protocols.
 */
export function experimentCanonicalJsonV1(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(experimentCanonicalJsonV1).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${experimentCanonicalJsonV1(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function experimentJsonSha256V1(value: unknown): string {
  return createHash("sha256").update(experimentCanonicalJsonV1(value)).digest("hex");
}

export const experimentRequestSha256V1 = experimentJsonSha256V1;
