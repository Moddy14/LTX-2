import { createHash } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";

import { z } from "zod";

import type { StudioAsset } from "../shared/assets.js";
import type { GenerationRequest } from "../shared/pipelines.js";
import type { AssetStore } from "./assets.js";

export type IdentityEvidenceStatus = "captured" | "verified" | "not-applicable" | "unavailable";
export type IdentityEvidenceSource = "lipdub-reference-video" | "image-conditioning";

export type IdentityReferenceEvidence = {
  assetId: string;
  kind: "image" | "video";
  sizeBytes: number;
  modifiedAtMs: number;
  changedAtMs: number;
  fileId: string;
  sha256: string;
};

export type IdentityInputEvidence = {
  schemaVersion: "ltx-studio-identity-evidence.v1";
  status: IdentityEvidenceStatus;
  source: IdentityEvidenceSource | null;
  capturedAt: string | null;
  verifiedAt: string | null;
  reason: string | null;
  references: IdentityReferenceEvidence[];
};

export type ResolvedIdentityReference = {
  path: string;
  sha256: string;
};

const identityReferenceEvidenceSchema = z.object({
  assetId: z.string().uuid(),
  kind: z.enum(["image", "video"]),
  sizeBytes: z.number().int().positive(),
  modifiedAtMs: z.number().finite().nonnegative(),
  changedAtMs: z.number().finite().nonnegative(),
  fileId: z.string().regex(/^\d{1,64}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const identityInputEvidenceSchema = z.object({
  schemaVersion: z.literal("ltx-studio-identity-evidence.v1"),
  status: z.enum(["captured", "verified", "not-applicable", "unavailable"]),
  source: z.enum(["lipdub-reference-video", "image-conditioning"]).nullable(),
  capturedAt: z.string().datetime({ offset: true }).nullable(),
  verifiedAt: z.string().datetime({ offset: true }).nullable(),
  reason: z.string().min(1).max(500).nullable(),
  references: z.array(identityReferenceEvidenceSchema).max(32),
}).strict();

export function normalizeIdentityInputEvidence(value: unknown): IdentityInputEvidence | null {
  const parsed = identityInputEvidenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type IdentityReferenceRequest = {
  kind: "image" | "video";
  path: string;
};

function unavailable(reason: string, source: IdentityEvidenceSource | null): IdentityInputEvidence {
  return {
    schemaVersion: "ltx-studio-identity-evidence.v1",
    status: "unavailable",
    source,
    capturedAt: null,
    verifiedAt: null,
    reason,
    references: [],
  };
}

export function notApplicableIdentityEvidence(): IdentityInputEvidence {
  return {
    schemaVersion: "ltx-studio-identity-evidence.v1",
    status: "not-applicable",
    source: null,
    capturedAt: null,
    verifiedAt: null,
    reason: "Dieser Auftrag verwendet keine visuelle Identitätsreferenz.",
    references: [],
  };
}

function referenceRequests(request: GenerationRequest): {
  source: IdentityEvidenceSource | null;
  references: IdentityReferenceRequest[];
} {
  if (request.mode === "lipdub") {
    return {
      source: "lipdub-reference-video",
      references: request.lipDub.referenceVideo.path
        ? [{ kind: "video", path: request.lipDub.referenceVideo.path }]
        : [],
    };
  }
  if (request.mode === "audio-to-video") {
    const seen = new Set<string>();
    const longCatReference = request.postprocess.longcatLipsync.enabled
      ? request.images.slice(0, 1)
      : [];
    const references = [...longCatReference, ...request.images.filter((image) => image.strength > 0)]
      .sort((left, right) => left.frameIndex - right.frameIndex)
      .flatMap((image) => {
        if (seen.has(image.path)) return [];
        seen.add(image.path);
        return [{ kind: "image" as const, path: image.path }];
      });
    return { source: "image-conditioning", references };
  }
  return { source: null, references: [] };
}

function currentRevision(asset: StudioAsset): Omit<IdentityReferenceEvidence, "sha256"> {
  const stats = lstatSync(asset.path);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size <= 0) {
    throw new Error(`Referenzdatei ist nicht lesbar: ${asset.name}`);
  }
  if (stats.size !== asset.size) throw new Error(`Referenzdatei wurde seit dem Upload verändert: ${asset.name}`);
  return {
    assetId: asset.id,
    kind: asset.kind as "image" | "video",
    sizeBytes: stats.size,
    modifiedAtMs: stats.mtimeMs,
    changedAtMs: stats.ctimeMs,
    fileId: String(stats.ino),
  };
}

function revisionsEqual(
  left: Omit<IdentityReferenceEvidence, "sha256">,
  right: Omit<IdentityReferenceEvidence, "sha256">,
): boolean {
  return left.assetId === right.assetId
    && left.kind === right.kind
    && left.sizeBytes === right.sizeBytes
    && Math.abs(left.modifiedAtMs - right.modifiedAtMs) < 1
    && Math.abs(left.changedAtMs - right.changedAtMs) < 1
    && left.fileId === right.fileId;
}

async function sha256(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

export async function captureIdentityEvidence(
  request: GenerationRequest,
  assets: AssetStore | null,
): Promise<IdentityInputEvidence> {
  const requested = referenceRequests(request);
  if (!requested.source || requested.references.length === 0) return notApplicableIdentityEvidence();
  if (!assets) return unavailable("Die Referenz stammt nicht nachweisbar aus der Studio-Mediathek.", requested.source);

  const evidence: IdentityReferenceEvidence[] = [];
  try {
    for (const reference of requested.references) {
      const asset = assets.findByPath(reference.kind, reference.path);
      if (!asset) {
        return unavailable(
          "Mindestens eine visuelle Referenz stammt nicht aus der Studio-Mediathek.",
          requested.source,
        );
      }
      const before = currentRevision(asset);
      const digest = await sha256(asset.path);
      const after = currentRevision(asset);
      if (!revisionsEqual(before, after)) {
        return unavailable("Eine visuelle Referenz wurde während der Beweissicherung verändert.", requested.source);
      }
      evidence.push({ ...after, sha256: digest });
    }
  } catch (error) {
    return unavailable(
      error instanceof Error ? error.message : "Die visuelle Referenz konnte nicht beweissicher erfasst werden.",
      requested.source,
    );
  }

  return {
    schemaVersion: "ltx-studio-identity-evidence.v1",
    status: "captured",
    source: requested.source,
    capturedAt: new Date().toISOString(),
    verifiedAt: null,
    reason: null,
    references: evidence,
  };
}

export async function verifyIdentityEvidence(
  evidence: IdentityInputEvidence,
  assets: AssetStore | null,
): Promise<{ evidence: IdentityInputEvidence; error: string | null }> {
  if (evidence.status === "not-applicable" || evidence.status === "unavailable") {
    return { evidence, error: null };
  }
  if (!assets || evidence.references.length === 0) {
    return { evidence, error: "Die gebundene Identitätsreferenz ist nicht mehr in der Studio-Mediathek verfügbar." };
  }
  try {
    for (const expected of evidence.references) {
      const asset = assets.findById(expected.kind, expected.assetId);
      if (!asset) throw new Error("Eine gebundene Identitätsreferenz fehlt in der Studio-Mediathek.");
      const before = currentRevision(asset);
      if (!revisionsEqual(before, expected)) {
        throw new Error(`Gebundene Identitätsreferenz wurde verändert: ${asset.name}`);
      }
      const digest = await sha256(asset.path);
      const after = currentRevision(asset);
      if (!revisionsEqual(before, after) || digest !== expected.sha256) {
        throw new Error(`Inhalt der gebundenen Identitätsreferenz wurde verändert: ${asset.name}`);
      }
    }
  } catch (error) {
    return {
      evidence,
      error: error instanceof Error ? error.message : "Die Identitätsreferenz konnte nicht erneut verifiziert werden.",
    };
  }
  return {
    evidence: {
      ...evidence,
      status: "verified",
      verifiedAt: new Date().toISOString(),
    },
    error: null,
  };
}

export function resolveIdentityEvidenceReferences(
  evidence: IdentityInputEvidence | null,
  assets: AssetStore | null,
): ResolvedIdentityReference[] {
  if (evidence?.status !== "verified" || !assets) return [];
  const resolved: ResolvedIdentityReference[] = [];
  for (const expected of evidence.references) {
    const asset = assets.findById(expected.kind, expected.assetId);
    if (!asset) return [];
    try {
      if (!revisionsEqual(currentRevision(asset), expected)) return [];
    } catch {
      return [];
    }
    resolved.push({ path: asset.path, sha256: expected.sha256 });
  }
  return resolved;
}
